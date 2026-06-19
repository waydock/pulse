import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getVersion, isNewer, checkForUpdate } from './version.js'

describe('getVersion', () => {
  it('matches the version in package.json', async () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))
    expect(await getVersion()).toBe(pkg.version)
  })
})

describe('isNewer', () => {
  it('compares semver numerically', () => {
    expect(isNewer('0.2.0', '0.1.8')).toBe(true)
    expect(isNewer('0.1.9', '0.1.8')).toBe(true)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
    expect(isNewer('0.1.8', '0.1.8')).toBe(false)
    expect(isNewer('0.1.7', '0.1.8')).toBe(false)
  })
  it('tolerates a leading v and pre-release suffix', () => {
    expect(isNewer('v0.2.0', '0.1.8')).toBe(true)
    expect(isNewer('0.2.0-beta.1', '0.1.8')).toBe(true)
  })
})

describe('checkForUpdate', () => {
  const fakeCache = () => {
    let store: string | undefined
    return {
      readCache: async () => {
        if (store === undefined) throw new Error('ENOENT')
        return store
      },
      writeCache: async (_p: string, data: string) => {
        store = data
      },
      get: () => store,
    }
  }

  it('returns the latest version when the registry has a newer one', async () => {
    const cache = fakeCache()
    const fetch = vi.fn(async () => ({ json: async () => ({ version: '0.2.0' }) })) as any
    const latest = await checkForUpdate('0.1.8', { fetch, now: () => 1000, ...cache })
    expect(latest).toBe('0.2.0')
    expect(fetch).toHaveBeenCalledOnce()
    expect(cache.get()).toContain('0.2.0') // cached for next time
  })

  it('returns null when already on the latest', async () => {
    const fetch = vi.fn(async () => ({ json: async () => ({ version: '0.1.8' }) })) as any
    expect(await checkForUpdate('0.1.8', { fetch, now: () => 1, ...fakeCache() })).toBeNull()
  })

  it('uses a fresh cache instead of hitting the network', async () => {
    const fetch = vi.fn() as any
    const readCache = async () => JSON.stringify({ checkedAt: 5000, latest: '0.3.0' })
    const latest = await checkForUpdate('0.1.8', { fetch, now: () => 5000 + 1000, readCache })
    expect(latest).toBe('0.3.0')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('re-checks when the cache is stale (>24h)', async () => {
    const fetch = vi.fn(async () => ({ json: async () => ({ version: '0.4.0' }) })) as any
    const dayMs = 24 * 60 * 60 * 1000
    const readCache = async () => JSON.stringify({ checkedAt: 0, latest: '0.3.0' })
    const latest = await checkForUpdate('0.1.8', { fetch, now: () => dayMs + 1, readCache, writeCache: async () => {} })
    expect(fetch).toHaveBeenCalledOnce()
    expect(latest).toBe('0.4.0')
  })

  it('returns null (never throws) when the registry is unreachable', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline') }) as any
    expect(await checkForUpdate('0.1.8', { fetch, now: () => 1, ...fakeCache() })).toBeNull()
  })
})
