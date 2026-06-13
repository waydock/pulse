import { describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { runCheckTick } from './watch.js'
import { attemptRestart } from './restart.js'

async function fakeReceiver(): Promise<{ url: string; beats: any[]; close: () => void }> {
  const beats: any[] = []
  const srv: Server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => { if (body) beats.push(JSON.parse(body)); res.writeHead(200); res.end('{}') })
  })
  await new Promise<void>(r => srv.listen(0, r))
  const port = (srv.address() as any).port
  return { url: `http://127.0.0.1:${port}/`, beats, close: () => srv.close() }
}

describe('runCheckTick — state rehydration', () => {
  it('a still-failing agent that was already down does NOT produce a new down webhook', async () => {
    // Simulate: persisted state says 'down-one' was 'down' before restart.
    // Seed the state machine so the agent starts in 'down' status.
    const webhookCalls: any[] = []
    const config: any = {
      node: 'n1', heartbeat: { url: 'x', key: 'k', interval: 60 },
      defaults: { retries: 1, confirm: 1, interval: 60 },
      agents: [{ name: 'down-one', checks: [{ command: 'false' }], restart: false, retries: 1, confirm: 1 }],
      metrics: {},
    }

    const { AgentState } = await import('./state-machine.js')
    const seededState = new AgentState(1)
    seededState.seed('down')

    const ctx = {
      states: new Map([['down-one', seededState]]),
      statuses: new Map([['down-one', { status: 'down' as const, restarts: 0 }]]),
    }

    await runCheckTick(config, ctx, {
      sendLocalAlert: async (_url: string, ev: any) => { webhookCalls.push(ev) },
      attemptRestart: vi.fn(async () => ({ outcome: 'failed' as const, attempts: 0 })),
      writeState: vi.fn(async () => {}),
      statePath: '/tmp/pulse-test-state.json',
      now: () => 1000,
    })

    // Agent is still failing but was already known-down — no new 'down' webhook
    expect(webhookCalls.some(c => c.kind === 'down')).toBe(false)
  })
})

describe('runCheckTick (integration)', () => {
  it('a confirmed-down agent triggers a restart attempt + a local webhook', async () => {
    const webhookCalls: any[] = []
    const exec = vi.fn(async () => {})            // restart command
    const config: any = {
      node: 'n1', heartbeat: { url: 'x', key: 'k', interval: 60 },
      defaults: { retries: 1, confirm: 1, interval: 60 },
      agents: [{ name: 'down-one', checks: [{ command: 'false' }], restart: 'kick', retries: 1, confirm: 1 }],
      metrics: {},
    }
    const ctx = { states: new Map(), statuses: new Map() }
    await runCheckTick(config, ctx, {
      sendLocalAlert: async (_url: string, ev: any) => { webhookCalls.push(ev) },
      attemptRestart: vi.fn(async () => ({ outcome: 'failed', attempts: 1 })),
      writeState: vi.fn(async () => {}),
      now: () => 1000,
    })
    // the agent is down (command:false) and confirm=1, so first tick -> up->down -> restart attempt + alerts
    expect(webhookCalls.some(c => c.kind === 'down')).toBe(true)
    expect(webhookCalls.some(c => c.kind === 'restart-failed')).toBe(true)
    expect(ctx.statuses.get('down-one')?.restarts).toBe(1)
  })

  it('heartbeats reach a fake receiver (the heartbeat path works end to end)', async () => {
    const recv = await fakeReceiver()
    try {
      const { sendHeartbeat, buildHeartbeat } = await import('./heartbeat.js')
      const p = await buildHeartbeat({ node: 'n1', interval: 60, agents: () => [{ name: 'a', status: 'up', restarts: 0 }], metrics: async () => ({ cpu: 1, mem: 1, disk: 1, load1: 0, uptime: 1 }), now: () => 1000 })
      await sendHeartbeat(recv.url, 'KEY', p)
      // give the server a tick to record
      await new Promise(r => setTimeout(r, 50))
      expect(recv.beats).toHaveLength(1)
      expect(recv.beats[0]).toMatchObject({ node: 'n1', interval: 60 })
    } finally { recv.close() }
  })

  it('real attemptRestart wired with fake exec+recheck recovers on attempt 2 and fires restart-recovered', async () => {
    const webhookCalls: any[] = []
    let recheckCall = 0
    // recheck fails on attempt 1, passes on attempt 2
    const recheck = vi.fn(async () => ++recheckCall >= 2)
    const exec = vi.fn(async () => {})
    const sleep = vi.fn(async (_ms: number) => {})

    const config: any = {
      node: 'n1', heartbeat: { url: 'x', key: 'k', interval: 60 },
      defaults: { retries: 2, confirm: 1, interval: 60 },
      agents: [{ name: 'recover-me', checks: [{ command: 'false' }], restart: 'kick', retries: 2, confirm: 1 }],
      metrics: {},
    }
    const ctx = { states: new Map(), statuses: new Map() }

    await runCheckTick(config, ctx, {
      sendLocalAlert: async (_url: string, ev: any) => { webhookCalls.push(ev) },
      // Pass the REAL attemptRestart bound with fake deps
      attemptRestart: (agent) =>
        attemptRestart(
          { name: agent.name, restart: agent.restart as string, retries: agent.retries },
          { exec, recheck, sleep, baseBackoffMs: 0 },
        ),
      writeState: vi.fn(async () => {}),
      statePath: '/tmp/pulse-test-state2.json',
      now: () => 2000,
    })

    expect(webhookCalls.some(c => c.kind === 'down')).toBe(true)
    expect(webhookCalls.some(c => c.kind === 'restart-recovered')).toBe(true)
    expect(exec).toHaveBeenCalledTimes(2)  // two exec calls before successful recheck
    expect(ctx.statuses.get('recover-me')?.restarts).toBe(2)
  })
})
