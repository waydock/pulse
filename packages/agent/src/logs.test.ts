import { describe, it, expect, vi } from 'vitest'
import { tailLines, pulseLogPath, runLogs } from './logs.js'

describe('tailLines', () => {
  it('returns the last n lines, ignoring a trailing newline', () => {
    expect(tailLines('a\nb\nc\nd\n', 2)).toEqual(['c', 'd'])
    expect(tailLines('only', 5)).toEqual(['only'])
    expect(tailLines('', 5)).toEqual([])
  })
})

describe('pulseLogPath', () => {
  it('points at ~/.pulse/pulse.log', () => {
    expect(pulseLogPath('/home/u')).toBe('/home/u/.pulse/pulse.log')
  })
})

describe('runLogs', () => {
  it('prints the last n lines of an existing log', async () => {
    const written: string[] = []
    await runLogs({ lines: 2 }, {
      logPath: '/l',
      exists: async () => true,
      readFileFn: async () => 'one\ntwo\nthree\n',
      write: s => { written.push(s) },
    })
    expect(written.join('')).toBe('two\nthree\n')
  })

  it('reports an empty log clearly', async () => {
    const written: string[] = []
    await runLogs({}, { logPath: '/l', exists: async () => true, readFileFn: async () => '', write: s => { written.push(s) } })
    expect(written.join('')).toMatch(/empty/)
  })

  it('follows via `tail -f` when --follow is set', async () => {
    const spawnFn = vi.fn(() => {
      const listeners: Record<string, (...a: any[]) => void> = {}
      const child: any = { on: (ev: string, cb: any) => { listeners[ev] = cb; return child } }
      queueMicrotask(() => listeners.close?.(0))
      return child
    }) as any
    await runLogs({ follow: true, lines: 10 }, { logPath: '/l', exists: async () => true, spawnFn })
    expect(spawnFn).toHaveBeenCalledWith('tail', ['-n', '10', '-f', '/l'], { stdio: 'inherit' })
  })
})
