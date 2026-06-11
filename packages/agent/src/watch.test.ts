import { describe, it, expect, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { runCheckTick } from './watch.js'

async function fakeReceiver(): Promise<{ url: string; beats: any[]; close: () => void }> {
  const beats: any[] = []
  const srv: Server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => { if (body) beats.push(JSON.parse(body)); res.writeHead(200); res.end('{}') })
  })
  await new Promise<void>(r => srv.listen(0, r))
  const port = (srv.address() as any).port
  return { url: `http://127.0.0.1:${port}/`, beats, close: () => srv.close() }
}

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
})
