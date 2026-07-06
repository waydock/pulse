import { describe, it, expect, vi, afterEach } from 'vitest'
import { pulseLogPath, runLogs } from './logs.js'

// A fake `tail` child that fires `close` with the given code on the next tick.
function fakeTail(closeCode: number | null = 0, errorFirst?: Error) {
  return vi.fn(() => {
    const listeners: Record<string, (...a: any[]) => void> = {}
    const child: any = { on: (ev: string, cb: any) => { listeners[ev] = cb; return child } }
    queueMicrotask(() => {
      if (errorFirst) listeners.error?.(errorFirst)
      else listeners.close?.(closeCode)
    })
    return child
  }) as any
}

describe('pulseLogPath', () => {
  it('points at ~/.pulse/pulse.log', () => {
    expect(pulseLogPath('/home/u')).toBe('/home/u/.pulse/pulse.log')
  })
})

describe('runLogs', () => {
  afterEach(() => { process.exitCode = undefined })

  it('checks existence without reading the file, then tails via `tail -n`', async () => {
    const statOnly = vi.fn(async () => true)
    const spawnFn = fakeTail(0)
    await runLogs({ lines: 20 }, { logPath: '/l', exists: statOnly, spawnFn })
    expect(spawnFn).toHaveBeenCalledWith('tail', ['-n', '20', '/l'], { stdio: 'inherit' })
  })

  it('adds -f when following', async () => {
    const spawnFn = fakeTail(0)
    await runLogs({ follow: true, lines: 10 }, { logPath: '/l', exists: async () => true, spawnFn })
    expect(spawnFn).toHaveBeenCalledWith('tail', ['-n', '10', '-f', '/l'], { stdio: 'inherit' })
  })

  it('exits non-zero with guidance when the log is absent', async () => {
    const spawnFn = fakeTail(0)
    await runLogs({}, { logPath: '/l', exists: async () => false, spawnFn })
    expect(spawnFn).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('propagates a non-zero tail exit code (so scripts detect failures)', async () => {
    await runLogs({}, { logPath: '/l', exists: async () => true, spawnFn: fakeTail(2) })
    expect(process.exitCode).toBe(2)
  })

  it('treats a signal termination (code null, e.g. Ctrl-C on --follow) as success', async () => {
    await runLogs({ follow: true }, { logPath: '/l', exists: async () => true, spawnFn: fakeTail(null) })
    expect(process.exitCode).toBeUndefined()
  })

  it('exits non-zero when tail cannot be spawned', async () => {
    await runLogs({}, { logPath: '/l', exists: async () => true, spawnFn: fakeTail(0, new Error('ENOENT')) })
    expect(process.exitCode).toBe(1)
  })
})
