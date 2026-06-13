import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config-loader.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pulse-cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PULSE_INGEST_KEY })

const yaml = `
node: mac-mini-newport
heartbeat:
  url: https://ingest.waydock.ai/api/pulse/heartbeat
  key: \${PULSE_INGEST_KEY}
  interval: 60
defaults:
  retries: 4
  confirm: 3
agents:
  - name: hermes
    checks: [{ process: ai.hermes.gateway }]
    restart: "kick"
  - name: openclaw
    checks: [{ process: openclaw }]
    restart: false
    retries: 1
metrics: { cpu: true, mem: true, disk: true }
`

function write(name: string, content: string) { const p = join(dir, name); writeFileSync(p, content); return p }

describe('loadConfig', () => {
  it('interpolates ${ENV} into string values', async () => {
    process.env.PULSE_INGEST_KEY = 'pk_live_abc'
    const cfg = await loadConfig(write('c.yaml', yaml), { credentialsPath: join(dir, 'creds.json') })
    expect(cfg.heartbeat.key).toBe('pk_live_abc')
  })
  it('throws a clear error when a referenced env var is missing', async () => {
    await expect(loadConfig(write('c.yaml', yaml), { credentialsPath: join(dir, 'creds.json') }))
      .rejects.toThrow(/PULSE_INGEST_KEY/)
  })
  it('loads the key from credentials.json when heartbeat.key is absent', async () => {
    const noKey = yaml.replace('key: \${PULSE_INGEST_KEY}\n  ', '')
    writeFileSync(join(dir, 'creds.json'), JSON.stringify({ key: 'pk_from_creds' }))
    const cfg = await loadConfig(write('c.yaml', noKey), { credentialsPath: join(dir, 'creds.json') })
    expect(cfg.heartbeat.key).toBe('pk_from_creds')
  })
  it('merges defaults into each agent (per-agent overrides win)', async () => {
    process.env.PULSE_INGEST_KEY = 'k'
    const cfg = await loadConfig(write('c.yaml', yaml), { credentialsPath: join(dir, 'creds.json') })
    const hermes = cfg.agents.find(a => a.name === 'hermes')!
    const openclaw = cfg.agents.find(a => a.name === 'openclaw')!
    expect(hermes.retries).toBe(4); expect(hermes.confirm).toBe(3)   // from defaults
    expect(openclaw.retries).toBe(1); expect(openclaw.confirm).toBe(3) // override + default
  })
})
