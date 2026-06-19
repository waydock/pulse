import { describe, it, expect } from 'vitest'
import { checkNodeVersion, restartBinary, runDoctor, formatReport, type DoctorDeps } from './doctor.js'

describe('checkNodeVersion', () => {
  it('passes on supported Node, fails below the floor', () => {
    expect(checkNodeVersion('v20.0.0').status).toBe('pass')
    expect(checkNodeVersion('v22.3.1').status).toBe('pass')
    expect(checkNodeVersion('v18.19.0').status).toBe('fail')
  })
})

describe('restartBinary', () => {
  it('extracts the leading binary token', () => {
    expect(restartBinary('systemctl restart web')).toBe('systemctl')
    expect(restartBinary('  launchctl kickstart -k gui/x ')).toBe('launchctl')
  })
})

const baseConfig: any = {
  node: 'n1',
  heartbeat: { url: 'https://ingest.example.com/api/pulse/heartbeat', interval: 60 },
  agents: [{ name: 'web', checks: [{ process: 'web' }], restart: 'systemctl restart web' }],
}

function deps(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: 'v20.0.0',
    loadConfig: async () => baseConfig,
    readKey: async () => 'key',
    reach: async () => true,
    evaluateAgent: async () => true,
    hasBinary: async () => true,
    ...over,
  }
}

describe('runDoctor', () => {
  it('is all-clear when everything is healthy', async () => {
    const r = await runDoctor(deps())
    expect(r.ok).toBe(true)
    expect(r.checks.find(c => c.name === 'Authentication')?.status).toBe('pass')
  })

  it('short-circuits with a fail when the config is missing', async () => {
    const r = await runDoctor(deps({ loadConfig: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }) } }))
    expect(r.ok).toBe(false)
    const cfg = r.checks.find(c => c.name === 'Config')!
    expect(cfg.status).toBe('fail')
    expect(cfg.hint).toMatch(/pulse init/)
    // no agent/auth checks ran after the config failure
    expect(r.checks.some(c => c.name === 'Authentication')).toBe(false)
  })

  it('warns (not fails) when unauthenticated or ingest unreachable', async () => {
    const r = await runDoctor(deps({ readKey: async () => undefined, reach: async () => false }))
    expect(r.ok).toBe(true) // warns don't fail the report
    expect(r.checks.find(c => c.name === 'Authentication')?.status).toBe('warn')
    expect(r.checks.find(c => c.name === 'Ingest reachable')?.status).toBe('warn')
  })

  it('fails when a restart binary is missing', async () => {
    const r = await runDoctor(deps({ hasBinary: async () => false }))
    expect(r.ok).toBe(false)
    const restartCheck = r.checks.find(c => c.name.includes('restart for'))!
    expect(restartCheck.status).toBe('fail')
  })

  it('marks a down agent as a warning', async () => {
    const r = await runDoctor(deps({ evaluateAgent: async () => false }))
    expect(r.checks.find(c => c.name === 'Agent "web"')?.status).toBe('warn')
  })
})

describe('formatReport', () => {
  it('renders symbols and a summary line', () => {
    const out = formatReport({ ok: false, checks: [
      { name: 'Node.js', status: 'pass', detail: 'v20' },
      { name: 'Restart', status: 'fail', detail: 'x not found', hint: 'install x' },
    ] })
    expect(out).toContain('✓ Node.js — v20')
    expect(out).toContain('✗ Restart — x not found')
    expect(out).toContain('install x')
    expect(out).toContain('Some checks failed')
  })
})
