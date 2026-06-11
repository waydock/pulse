import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { login } from './login.js'

let dir: string, creds: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pulse-login-')); creds = join(dir, 'credentials.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function fakeFetch(seq: any[]) {
  let i = 0
  return vi.fn(async (_url: string, _opts: any) => ({ ok: true, json: async () => seq[Math.min(i++, seq.length - 1)] })) as any
}

const deviceCodeResp = { device_code: 'dc_123', user_code: 'WXYZ-PQRS', verification_uri: 'https://waydock.ai/pulse/device', verification_uri_complete: 'https://waydock.ai/pulse/device?code=WXYZ-PQRS', expires_in: 900, interval: 1 }

describe('login', () => {
  it('requests a code, polls past authorization_pending, then stores the key (0600)', async () => {
    const fetch = fakeFetch([deviceCodeResp, { error: 'authorization_pending' }, { token: 'pk_live_xyz' }])
    const openBrowser = vi.fn(async () => {})
    const log = vi.fn()
    await login({ base: 'https://ingest.waydock.ai/api/pulse', hostname: 'mac-mini', credentialsPath: creds,
                  deps: { fetch, openBrowser, sleep: vi.fn(async () => {}), log } })
    expect(JSON.parse(readFileSync(creds, 'utf8'))).toEqual({ key: 'pk_live_xyz' })
    expect(log.mock.calls.flat().join(' ')).toContain('WXYZ-PQRS')   // showed the user code
    expect(openBrowser).toHaveBeenCalledWith(deviceCodeResp.verification_uri_complete)
    if (process.platform !== 'win32') expect(statSync(creds).mode & 0o777).toBe(0o600)
  })
  it('honors slow_down by increasing the interval', async () => {
    const sleep = vi.fn(async () => {})
    const fetch = fakeFetch([deviceCodeResp, { error: 'slow_down' }, { token: 'pk' }])
    await login({ base: 'b', hostname: 'h', credentialsPath: creds, deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep, log: vi.fn() } })
    // first poll wait = interval (1s = 1000ms); after slow_down, +5s -> 6000ms
    const waits = sleep.mock.calls.map((c: any[]) => c[0])
    expect(waits).toContain(6000)
  })
  it('throws on access_denied', async () => {
    const fetch = fakeFetch([deviceCodeResp, { error: 'access_denied' }])
    await expect(login({ base: 'b', hostname: 'h', credentialsPath: creds, deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep: vi.fn(async()=>{}), log: vi.fn() } }))
      .rejects.toThrow(/denied/i)
  })
})
