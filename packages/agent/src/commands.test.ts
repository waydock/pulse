import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { DEFAULT_INGEST_BASE, DEFAULT_HEARTBEAT_URL, STARTER_CONFIG, loadConfigOrExit } from './commands.js'

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

describe('loadConfigOrExit', () => {
  afterEach(() => vi.restoreAllMocks())

  it('on a missing config, points the user at `pulse init` and exits 1', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`)
    }) as never)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    await expect(loadConfigOrExit('/no/such/dir/pulse.config.yaml')).rejects.toThrow('exit:1')

    const out = err.mock.calls.flat().join(' ')
    expect(out).toMatch(/pulse init/)        // friendly hint, not a raw ENOENT
    expect(out).not.toMatch(/ENOENT/)
  })

  it('loads a real config when the file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-cfg-'))
    try {
      const p = join(dir, 'pulse.config.yaml')
      writeFileSync(p, 'node: n1\nheartbeat:\n  url: https://x/api/pulse/heartbeat\n  key: k\n  interval: 60\nagents:\n  - name: a1\n    checks:\n      - process: foo\n')
      const cfg = await loadConfigOrExit(p)
      expect(cfg.node).toBe('n1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
