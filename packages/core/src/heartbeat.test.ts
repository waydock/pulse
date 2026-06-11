import { describe, it, expect } from 'vitest'
import { HeartbeatPayload, AgentStatus } from './heartbeat.js'

const valid = {
  node: 'mac-mini-newport',
  ts: 1733300000,
  interval: 60,
  agents: [{ name: 'hermes', status: 'up', restarts: 0 }],
  metrics: { cpu: 12.3, mem: 48.1, disk: 62, load1: 1.2, uptime: 86400 },
}

describe('HeartbeatPayload', () => {
  it('accepts a valid payload', () => {
    expect(HeartbeatPayload.parse(valid)).toEqual(valid)
  })
  it('rejects a non-integer ts (must be unix seconds)', () => {
    expect(() => HeartbeatPayload.parse({ ...valid, ts: 1733300000.5 })).toThrow()
  })
  it('rejects ts in milliseconds (> year 2300 in seconds)', () => {
    expect(() => HeartbeatPayload.parse({ ...valid, ts: 1733300000000 })).toThrow()
  })
  it('rejects an unknown agent status', () => {
    expect(() => AgentStatus.parse({ name: 'x', status: 'sleepy', restarts: 0 })).toThrow()
  })
  it('rejects a negative interval', () => {
    expect(() => HeartbeatPayload.parse({ ...valid, interval: -5 })).toThrow()
  })
  it('strips unknown top-level keys (forward-compat: agent newer than receiver)', () => {
    const out = HeartbeatPayload.parse({ ...valid, futureField: 'ignored' })
    expect('futureField' in out).toBe(false)
  })
})
