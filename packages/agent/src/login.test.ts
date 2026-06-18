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
    const fetch = fakeFetch([deviceCodeResp, { error: 'authorization_pending' }, { access_token: 'pk_live_xyz' }])
    const openBrowser = vi.fn(async () => {})
    const log = vi.fn()
    await login({ base: 'https://ingest.waydock.ai/api/pulse', hostname: 'mac-mini', credentialsPath: creds,
                  deps: { fetch, openBrowser, sleep: vi.fn(async () => {}), log } })
    expect(JSON.parse(readFileSync(creds, 'utf8'))).toEqual({ key: 'pk_live_xyz' })
    expect(log.mock.calls.flat().join(' ')).toContain('WXYZ-PQRS')   // showed the user code
    expect(openBrowser).toHaveBeenCalledWith(deviceCodeResp.verification_uri_complete)
    if (process.platform !== 'win32') expect(statSync(creds).mode & 0o777).toBe(0o600)
  })
  it('sends form-urlencoded requests per RFC 8628 (not JSON)', async () => {
    const fetch = fakeFetch([deviceCodeResp, { access_token: 'pk' }])
    await login({ base: 'b', hostname: 'mac-mini', credentialsPath: creds,
                  deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep: vi.fn(async()=>{}), log: vi.fn() } })
    // Both the device-code and token requests must be form-encoded.
    for (const [, opts] of fetch.mock.calls) {
      expect(opts.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
      expect(typeof opts.body).toBe('string')
      expect(opts.body).not.toContain('{')   // not JSON
    }
    // Device-code request carries client_id + hostname as form params.
    const deviceParams = new URLSearchParams(fetch.mock.calls[0][1].body)
    expect(deviceParams.get('client_id')).toBe('pulse-cli')
    expect(deviceParams.get('hostname')).toBe('mac-mini')
    // Token request carries the device_code grant.
    const tokenParams = new URLSearchParams(fetch.mock.calls[1][1].body)
    expect(tokenParams.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(tokenParams.get('device_code')).toBe('dc_123')
  })
  it('honors slow_down by increasing the interval', async () => {
    const sleep = vi.fn(async () => {})
    const fetch = fakeFetch([deviceCodeResp, { error: 'slow_down' }, { access_token: 'pk' }])
    await login({ base: 'b', hostname: 'h', credentialsPath: creds, deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep, log: vi.fn() } })
    // first poll wait = interval (1s = 1000ms); after slow_down, +5s -> 6000ms
    const waits = sleep.mock.calls.map((c: any[]) => c[0])
    expect(waits).toContain(6000)
  })
  it('does not honor a legacy `token`-only response (standard access_token required)', async () => {
    // The server speaks RFC 8628 `access_token`; the old `token` alias is gone.
    // A response carrying only `token` must NOT be treated as success — it looks
    // like neither a grant nor a known pending error, so login fails instead of
    // writing a credential from the wrong field.
    const fetch = fakeFetch([deviceCodeResp, { token: 'legacy-alias' }])
    await expect(
      login({ base: 'b', hostname: 'h', credentialsPath: creds, deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep: vi.fn(async()=>{}), log: vi.fn() } })
    ).rejects.toThrow(/device authorization failed/i)
  })
  it('throws on access_denied', async () => {
    const fetch = fakeFetch([deviceCodeResp, { error: 'access_denied' }])
    await expect(login({ base: 'b', hostname: 'h', credentialsPath: creds, deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep: vi.fn(async()=>{}), log: vi.fn() } }))
      .rejects.toThrow(/denied/i)
  })
  it('rejects with /expired/i when expires_in elapses with authorization_pending', async () => {
    // Device code expires in 1 second (1000 ms). The now() fn advances by
    // 600 ms each call so after two poll iterations the deadline is exceeded.
    let tick = 0
    const start = 1_000_000
    const nowFn = () => start + tick++ * 600
    // fetch always returns authorization_pending (never resolves)
    const pendingResp = { device_code: 'dc', user_code: 'AAAA-BBBB', verification_uri: 'https://x', verification_uri_complete: 'https://x?code=AAAA-BBBB', expires_in: 1, interval: 1 }
    const fetch = fakeFetch([pendingResp, { error: 'authorization_pending' }, { error: 'authorization_pending' }, { error: 'authorization_pending' }])
    await expect(
      login({ base: 'b', hostname: 'h', credentialsPath: creds, deps: { fetch, openBrowser: vi.fn(async()=>{}), sleep: vi.fn(async()=>{}), log: vi.fn(), now: nowFn } })
    ).rejects.toThrow(/expired/i)
  })
})
