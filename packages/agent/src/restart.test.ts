import { describe, it, expect, vi } from 'vitest'
import { attemptRestart } from './restart.js'

const deps = (overrides = {}) => ({
  exec: vi.fn(async () => {}),
  recheck: vi.fn(async () => false),
  sleep: vi.fn(async (_ms: number) => {}),
  baseBackoffMs: 10_000,
  ...overrides,
})

describe('attemptRestart', () => {
  it('alert-only (restart=false): never execs, returns alertOnly', async () => {
    const d = deps()
    const r = await attemptRestart({ name: 'a', restart: false, retries: 3 }, d)
    expect(d.exec).not.toHaveBeenCalled()
    expect(r).toEqual({ outcome: 'alert-only', attempts: 0 })
  })
  it('recovers on the first attempt (recheck passes) — stops early', async () => {
    const d = deps({ recheck: vi.fn(async () => true) })
    const r = await attemptRestart({ name: 'a', restart: 'kick', retries: 3 }, d)
    expect(d.exec).toHaveBeenCalledTimes(1)
    expect(d.sleep).toHaveBeenCalledWith(10_000)   // attempt 1 waits 1×base
    expect(r).toEqual({ outcome: 'recovered', attempts: 1 })
  })
  it('uses linear backoff and stops when a later attempt recovers', async () => {
    let n = 0
    const d = deps({ recheck: vi.fn(async () => (++n >= 3)) }) // passes on 3rd recheck
    const r = await attemptRestart({ name: 'a', restart: 'kick', retries: 5 }, d)
    expect(d.exec).toHaveBeenCalledTimes(3)
    expect(d.sleep.mock.calls.map((c: any[]) => c[0])).toEqual([10_000, 20_000, 30_000])
    expect(r).toEqual({ outcome: 'recovered', attempts: 3 })
  })
  it('exhausts retries and reports failed exactly once', async () => {
    const d = deps() // recheck always false
    const r = await attemptRestart({ name: 'a', restart: 'kick', retries: 3 }, d)
    expect(d.exec).toHaveBeenCalledTimes(3)
    expect(r).toEqual({ outcome: 'failed', attempts: 3 })
  })
  it('a thrown exec is swallowed and counts as a failed attempt', async () => {
    const d = deps({ exec: vi.fn(async () => { throw new Error('boom') }) })
    const r = await attemptRestart({ name: 'a', restart: 'kick', retries: 2 }, d)
    expect(r.outcome).toBe('failed'); expect(r.attempts).toBe(2)
  })
})
