import { describe, it, expect, vi } from 'vitest'
import { run } from './cli.js'

function fakeHandlers() {
  return { init: vi.fn(async () => {}), check: vi.fn(async () => {}), start: vi.fn(async () => {}), login: vi.fn(async () => {}) }
}

describe('cli run()', () => {
  it('routes each command to its handler', async () => {
    for (const cmd of ['init', 'check', 'start', 'login'] as const) {
      const h = fakeHandlers()
      await run([cmd], h)
      expect(h[cmd]).toHaveBeenCalledOnce()
    }
  })
  it('passes --config (default ./pulse.config.yaml) to the handler opts', async () => {
    const h = fakeHandlers()
    await run(['check'], h)
    expect(h.check).toHaveBeenCalledWith(expect.objectContaining({ config: './pulse.config.yaml' }))
    const h2 = fakeHandlers()
    await run(['check', '--config', '/tmp/x.yaml'], h2)
    expect(h2.check).toHaveBeenCalledWith(expect.objectContaining({ config: '/tmp/x.yaml' }))
  })
  it('throws a clear error on an unknown command', async () => {
    await expect(run(['frobnicate'], fakeHandlers())).rejects.toThrow(/unknown command/i)
  })
})
