import { describe, it, expect, vi } from 'vitest'
import { sendLocalAlert, type AlertEvent } from './webhook.js'

const ev: AlertEvent = { node: 'mac-mini-newport', agent: 'hermes', kind: 'down', ts: 1733300000 }

describe('sendLocalAlert', () => {
  it('posts Discord-formatted JSON to a Discord webhook URL', async () => {
    const fetch = vi.fn(async () => ({ ok: true })) as any
    await sendLocalAlert('https://discord.com/api/webhooks/123/abc', ev, { fetch })
    expect(fetch).toHaveBeenCalledOnce()
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toContain('discord.com/api/webhooks')
    const body = JSON.parse(opts.body)
    expect(body.content ?? JSON.stringify(body.embeds)).toMatch(/hermes/)   // mentions the agent
    expect(opts.headers['Content-Type']).toBe('application/json')
  })
  it('posts a generic JSON body to a non-Discord URL', async () => {
    const fetch = vi.fn(async () => ({ ok: true })) as any
    await sendLocalAlert('https://example.com/hook', ev, { fetch })
    const body = JSON.parse(fetch.mock.calls[0][1].body)
    expect(body).toMatchObject({ node: 'mac-mini-newport', agent: 'hermes', kind: 'down', ts: 1733300000 })
  })
  it('never throws on network failure', async () => {
    const fetch = vi.fn(async () => { throw new Error('network down') }) as any
    await expect(sendLocalAlert('https://example.com/hook', ev, { fetch })).resolves.toBeUndefined()
  })
  it('is a no-op when url is undefined (webhook optional)', async () => {
    const fetch = vi.fn() as any
    await sendLocalAlert(undefined, ev, { fetch })
    expect(fetch).not.toHaveBeenCalled()
  })
})
