import { describe, it, expect } from 'vitest'
import { humanizeAge, readStatus, formatStatus, type StatusDeps } from './status.js'

describe('humanizeAge', () => {
  it('scales seconds to a compact unit', () => {
    expect(humanizeAge(5)).toBe('5s')
    expect(humanizeAge(90)).toBe('2m')
    expect(humanizeAge(3600)).toBe('1h')
    expect(humanizeAge(172800)).toBe('2d')
  })
})

const config: any = {
  node: 'app-1',
  heartbeat: { url: 'https://x/api/pulse/heartbeat', interval: 60 },
  agents: [{ name: 'web' }, { name: 'db' }],
}

function deps(over: Partial<StatusDeps> = {}): StatusDeps {
  return {
    loadConfig: async () => config,
    readState: async () => ({ web: 'up', db: 'down' }),
    statMtimeMs: async () => 100_000,
    now: () => 100_000 + 30_000, // 30s later
    ...over,
  }
}

describe('readStatus', () => {
  it('merges config agent order with persisted status and computes a fresh age', async () => {
    const info = await readStatus(deps())
    expect(info.node).toBe('app-1')
    expect(info.agents).toEqual([{ name: 'web', status: 'up' }, { name: 'db', status: 'down' }])
    expect(info.ageSeconds).toBe(30)
    expect(info.stale).toBe(false) // 30s < 3*60s
    expect(info.hasState).toBe(true)
  })

  it('marks state stale when older than 3 intervals', async () => {
    const info = await readStatus(deps({ now: () => 100_000 + 200_000 })) // 200s > 180s
    expect(info.stale).toBe(true)
  })

  it('reports no state when the file is absent', async () => {
    const info = await readStatus(deps({ statMtimeMs: async () => undefined, readState: async () => ({}) }))
    expect(info.hasState).toBe(false)
    expect(info.stale).toBe(true)
  })

  it('falls back to state-file keys when config is unavailable', async () => {
    const info = await readStatus(deps({ loadConfig: async () => { throw new Error('no config') } }))
    expect(info.node).toBeUndefined()
    expect(info.agents.map(a => a.name).sort()).toEqual(['db', 'web'])
  })

  it('shows unknown for an agent missing from the state file', async () => {
    const info = await readStatus(deps({ readState: async () => ({ web: 'up' }) }))
    expect(info.agents.find(a => a.name === 'db')?.status).toBe('unknown')
  })
})

describe('formatStatus', () => {
  it('renders a table with a fresh timestamp', () => {
    const out = formatStatus({
      node: 'app-1', statePath: '/s', hasState: true, stale: false, ageSeconds: 12,
      agents: [{ name: 'web', status: 'up' }],
    })
    expect(out).toContain('Node: app-1')
    expect(out).toContain('Last update: 12s ago.')
    expect(out).toMatch(/web\s+up/)
  })

  it('warns when stale and guides when there is no state', () => {
    expect(formatStatus({ statePath: '/s', hasState: true, stale: true, ageSeconds: 600, agents: [] }))
      .toMatch(/stale/)
    expect(formatStatus({ statePath: '/s', hasState: false, stale: true, agents: [] }))
      .toMatch(/pulse start/)
  })
})
