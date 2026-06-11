import { describe, it, expect, vi } from 'vitest'
import { buildHeartbeat, sendHeartbeat, startHeartbeatLoop } from './heartbeat.js'
import { HeartbeatPayload } from '@waydock/pulse-core'

const metrics = async () => ({ cpu: 12, mem: 40, disk: 60, load1: 1, uptime: 100 })
const agents = () => [{ name: 'hermes', status: 'up' as const, restarts: 0 }]

describe('buildHeartbeat', () => {
  it('builds a payload that satisfies the core schema, with interval + ts', async () => {
    const p = await buildHeartbeat({ node: 'n1', interval: 60, agents, metrics, now: () => 1733300000 })
    expect(() => HeartbeatPayload.parse(p)).not.toThrow()
    expect(p).toMatchObject({ node: 'n1', interval: 60, ts: 1733300000 })
  })
})
describe('sendHeartbeat', () => {
  it('POSTs with bearer auth and JSON body', async () => {
    const fetch = vi.fn(async () => ({ ok: true })) as any
    const p = await buildHeartbeat({ node: 'n1', interval: 60, agents, metrics, now: () => 1 })
    await sendHeartbeat('https://ingest.example/h', 'KEY123', p, { fetch })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://ingest.example/h')
    expect(opts.headers['Authorization']).toBe('Bearer KEY123')
    expect(JSON.parse(opts.body).node).toBe('n1')
  })
  it('never throws on network failure', async () => {
    const fetch = vi.fn(async () => { throw new Error('x') }) as any
    const p = await buildHeartbeat({ node: 'n1', interval: 60, agents, metrics, now: () => 1 })
    await expect(sendHeartbeat('u', 'k', p, { fetch })).resolves.toBeUndefined()
  })
})
describe('startHeartbeatLoop', () => {
  it('fires on its own injected timer, independent of any other work', async () => {
    const sent: number[] = []
    const fakeTimer = { handlers: [] as Function[], set(fn: Function, _ms: number) { this.handlers.push(fn); return 1 as any }, clear() {} }
    const stop = startHeartbeatLoop({
      intervalMs: 1000,
      tick: async () => { sent.push(Date.now ? 0 : 0) },   // record a beat
      setIntervalFn: (fn, ms) => fakeTimer.set(fn, ms),
      clearIntervalFn: () => fakeTimer.clear(),
    })
    // simulate three timer fires
    await fakeTimer.handlers[0](); await fakeTimer.handlers[0](); await fakeTimer.handlers[0]()
    expect(sent).toHaveLength(3)
    stop()
  })
})
