import { describe, it, expect } from 'vitest'
import { load as parseYaml } from 'js-yaml'
import { DEFAULT_INGEST_BASE, DEFAULT_HEARTBEAT_URL, STARTER_CONFIG } from './commands.js'

// Regression guard: the live ingest server serves every Pulse route under
// /api/pulse. Earlier the CLI targeted /oauth/* and /v1/heartbeat, which 404'd,
// so `login` and `start` could never reach the server. Keep these in lock-step
// with the real routes.
describe('ingest endpoint constants', () => {
  it('login base targets /api/pulse so ${base}/oauth/* resolves on the server', () => {
    expect(DEFAULT_INGEST_BASE).toBe('https://ingest.waydock.ai/api/pulse')
    expect(`${DEFAULT_INGEST_BASE}/oauth/device/code`).toBe(
      'https://ingest.waydock.ai/api/pulse/oauth/device/code',
    )
  })

  it('starter config heartbeats to the real /api/pulse/heartbeat route', () => {
    expect(DEFAULT_HEARTBEAT_URL).toBe('https://ingest.waydock.ai/api/pulse/heartbeat')
    const cfg = parseYaml(STARTER_CONFIG) as { heartbeat: { url: string } }
    expect(cfg.heartbeat.url).toBe(DEFAULT_HEARTBEAT_URL)
  })

  it('never falls back to the old, 404-ing paths', () => {
    expect(STARTER_CONFIG).not.toContain('/v1/heartbeat')
    expect(DEFAULT_INGEST_BASE).not.toMatch(/waydock\.ai$/) // must not be the bare origin
  })
})
