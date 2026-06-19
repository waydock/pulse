import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { run, isMainEntry } from './cli.js'

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
  it('parses init guided/static flags into opts', async () => {
    const h = fakeHandlers()
    await run(['init', '-i'], h)
    expect(h.init).toHaveBeenCalledWith(expect.objectContaining({ interactive: true }))
    const h2 = fakeHandlers()
    await run(['init', '--yes'], h2)
    expect(h2.init).toHaveBeenCalledWith(expect.objectContaining({ yes: true }))
    const h3 = fakeHandlers()
    await run(['init'], h3)
    expect(h3.init).toHaveBeenCalledWith(expect.objectContaining({ interactive: undefined, yes: undefined }))
  })
  it('parses --quiet / -q into opts.quiet (default false)', async () => {
    const h = fakeHandlers()
    await run(['start'], h)
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ quiet: false }))
    const h2 = fakeHandlers()
    await run(['start', '--quiet'], h2)
    expect(h2.start).toHaveBeenCalledWith(expect.objectContaining({ quiet: true }))
    const h3 = fakeHandlers()
    await run(['start', '-q'], h3)
    expect(h3.start).toHaveBeenCalledWith(expect.objectContaining({ quiet: true }))
  })

  it('throws a clear error on an unknown command', async () => {
    await expect(run(['frobnicate'], fakeHandlers())).rejects.toThrow(/unknown command/i)
  })
})

describe('isMainEntry()', () => {
  it('detects the entry point even when invoked through a symlink (npm bin shim)', () => {
    // npm installs the CLI as .bin/pulse -> dist/cli.js. When run, process.argv[1]
    // is the SYMLINK path while import.meta.url is the realpath. The guard must
    // resolve the symlink, or main() never runs and every command silently no-ops.
    const dir = mkdtempSync(join(tmpdir(), 'pulse-entry-'))
    try {
      const realFile = join(dir, 'cli.js')
      const link = join(dir, 'pulse') // simulates node_modules/.bin/pulse
      writeFileSync(realFile, '')
      symlinkSync(realFile, link)
      // Node always realpath-resolves import.meta.url; model that faithfully.
      const metaUrl = pathToFileURL(realpathSync(realFile)).href
      expect(isMainEntry(metaUrl, link)).toBe(true) // invoked via the shim
      expect(isMainEntry(metaUrl, realFile)).toBe(true) // invoked directly
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns false when a different script is the entry point', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-entry-'))
    try {
      const cli = join(dir, 'cli.js')
      const other = join(dir, 'other.js')
      writeFileSync(cli, '')
      writeFileSync(other, '')
      expect(isMainEntry(pathToFileURL(cli).href, other)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns false when there is no entry argument', () => {
    expect(isMainEntry('file:///x/cli.js', undefined)).toBe(false)
  })
})
