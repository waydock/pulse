import { beforeEach, describe, it, expect, vi } from 'vitest'
const siMocks = vi.hoisted(() => ({
  currentLoad: vi.fn(async () => ({ currentLoad: 12.34 })),
  mem: vi.fn(async () => ({ total: 100, available: 60 })),
  fsSize: vi.fn(async () => [{ size: 100, used: 25 }]),
  time: vi.fn(async () => ({ uptime: 100 })),
}))
vi.mock('systeminformation', () => siMocks)

import { buildHeartbeat, defaultMetrics, sendHeartbeat, startHeartbeatLoop } from './heartbeat.js'
import { HeartbeatPayload } from '@waydock/pulse-core'

const metrics = async () => ({ cpu: 12, mem: 40, disk: 60, load1: 1, uptime: 100 })
const agents = () => [{ name: 'hermes', status: 'up' as const, restarts: 0 }]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildHeartbeat', () => {
  it('builds a payload that satisfies the core schema, with interval + ts', async () => {
    const p = await buildHeartbeat({ node: 'n1', interval: 60, agents, metrics, now: () => 1733300000 })
    expect(() => HeartbeatPayload.parse(p)).not.toThrow()
    expect(p).toMatchObject({ node: 'n1', interval: 60, ts: 1733300000 })
  })
})
describe('sendHeartbeat', () => {
  it('POSTs with bearer auth and JSON body, and reports delivery', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200 })) as any
    const p = await buildHeartbeat({ node: 'n1', interval: 60, agents, metrics, now: () => 1 })
    const res = await sendHeartbeat('https://ingest.example/h', 'KEY123', p, { fetch })
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://ingest.example/h')
    expect(opts.headers['Authorization']).toBe('Bearer KEY123')
    expect(JSON.parse(opts.body).node).toBe('n1')
    expect(res).toEqual({ ok: true, status: 200 })
  })
  it('never throws on network failure, and reports non-delivery', async () => {
    const fetch = vi.fn(async () => { throw new Error('x') }) as any
    const p = await buildHeartbeat({ node: 'n1', interval: 60, agents, metrics, now: () => 1 })
    await expect(sendHeartbeat('u', 'k', p, { fetch })).resolves.toEqual({ ok: false })
  })
})
describe('defaultMetrics', () => {
  it('skips disabled metric collectors and reports zero values for them', async () => {
    const result = await defaultMetrics({ cpu: false, mem: false, disk: false })

    expect(siMocks.currentLoad).not.toHaveBeenCalled()
    expect(siMocks.mem).not.toHaveBeenCalled()
    expect(siMocks.fsSize).not.toHaveBeenCalled()
    expect(siMocks.time).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ cpu: 0, mem: 0, disk: 0, uptime: 100 })
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
    // Simulate three timer fires. The settle between them is what a real
    // interval gives you for free: the loop guard drops a firing that lands
    // while the previous beat is still in flight, so back-to-back synchronous
    // fires would (correctly) be coalesced rather than counted.
    const settle = () => new Promise((r) => setTimeout(r, 0))
    for (let i = 0; i < 3; i++) {
      fakeTimer.handlers[0]()
      await settle()
    }
    expect(sent).toHaveLength(3)
    stop()
  })

  it('drops a firing that lands while the previous beat is still in flight', async () => {
    const sent: number[] = []
    const fakeTimer = { handlers: [] as Function[], set(fn: Function, _ms: number) { this.handlers.push(fn); return 1 as any }, clear() {} }
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const stop = startHeartbeatLoop({
      intervalMs: 1000,
      tick: async () => { sent.push(0); await blocked },
      setIntervalFn: (fn, ms) => fakeTimer.set(fn, ms),
      clearIntervalFn: () => fakeTimer.clear(),
    })

    fakeTimer.handlers[0]() // starts, then hangs on `blocked`
    fakeTimer.handlers[0]() // must be dropped, not queued behind it
    fakeTimer.handlers[0]()
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(1)

    release()
    await new Promise((r) => setTimeout(r, 0))
    fakeTimer.handlers[0]() // the loop resumes once the slow beat finishes
    await new Promise((r) => setTimeout(r, 0))
    expect(sent).toHaveLength(2)
    stop()
  })
})
