import { describe, it, expect, vi } from 'vitest'
import { sendTestHeartbeat } from './test-heartbeat.js'

const cfg = (key?: string): any => ({
  node: 'n1',
  heartbeat: { url: 'https://ingest/api/pulse/heartbeat', key, interval: 60 },
  agents: [{ name: 'web', checks: [{ process: 'web' }] }],
  metrics: { cpu: true, mem: true, disk: true },
})

describe('sendTestHeartbeat', () => {
  it('reports unauthenticated and does not send when no key is present', async () => {
    const sendHeartbeat = vi.fn()
    const res = await sendTestHeartbeat('/c', {
      loadConfig: async () => cfg(undefined),
      sendHeartbeat: sendHeartbeat as any,
    })
    expect(res).toEqual({ authenticated: false, ok: false })
    expect(sendHeartbeat).not.toHaveBeenCalled()
  })

  it('builds a payload from live agent statuses and sends it', async () => {
    const sendHeartbeat = vi.fn(async () => ({ ok: true, status: 200 }))
    const res = await sendTestHeartbeat('/c', {
      loadConfig: async () => cfg('thekey'),
      evaluateAgent: async () => false, // web is down
      metrics: async () => ({ cpu: 0, mem: 0, disk: 0, load1: 0, uptime: 0 }),
      sendHeartbeat: sendHeartbeat as any,
    })
    expect(res).toEqual({ authenticated: true, ok: true, status: 200 })
    const [url, key, payload] = sendHeartbeat.mock.calls[0]
    expect(url).toBe('https://ingest/api/pulse/heartbeat')
    expect(key).toBe('thekey')
    expect(payload.node).toBe('n1')
    expect(payload.agents[0]).toMatchObject({ name: 'web', status: 'down' })
  })

  it('surfaces a failed delivery', async () => {
    const res = await sendTestHeartbeat('/c', {
      loadConfig: async () => cfg('k'),
      evaluateAgent: async () => true,
      metrics: async () => ({ cpu: 0, mem: 0, disk: 0, load1: 0, uptime: 0 }),
      sendHeartbeat: async () => ({ ok: false }),
    })
    expect(res).toEqual({ authenticated: true, ok: false, status: undefined })
  })
})
