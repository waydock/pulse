import { describe, it, expect } from 'vitest'
import { Config } from './config.js'

const base = {
  node: 'mac-mini-newport',
  heartbeat: { url: 'https://ingest.waydock.ai/api/pulse/heartbeat', key: '${PULSE_INGEST_KEY}', interval: 60 },
  agents: [
    { name: 'hermes', group: 'hermes',
      checks: [{ process: 'ai.hermes.gateway' }, { http: 'http://127.0.0.1:9119/' }],
      restart: 'launchctl kickstart -k gui/$(id -u)/ai.hermes.gateway', retries: 5 },
    { name: 'openclaw', checks: [{ process: 'openclaw' }], restart: false },
  ],
  metrics: { cpu: true, mem: true, disk: true },
}

describe('Config', () => {
  it('parses a full config', () => { expect(Config.parse(base).agents).toHaveLength(2) })
  it('defaults retries/confirm/interval when omitted', () => {
    const c = Config.parse({ ...base, defaults: undefined })
    expect(c.defaults.retries).toBe(3); expect(c.defaults.confirm).toBe(2)
  })
  it('accepts restart:false (alert-only)', () => {
    expect(Config.parse(base).agents[1].restart).toBe(false)
  })
  it('rejects an agent with zero checks', () => {
    expect(() => Config.parse({ ...base, agents: [{ name: 'x', checks: [] }] })).toThrow()
  })
  it('rejects a check with two kinds at once', () => {
    expect(() => Config.parse({ ...base, agents: [{ name: 'x', checks: [{ process: 'a', http: 'b' }] }] })).toThrow()
  })
})
