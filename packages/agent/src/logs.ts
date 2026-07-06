import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// `pulse logs` — tail the service log written by `pulse install` (launchd /
// systemd both point StandardOut/Err here). POSIX-only, which matches Pulse's
// supported platforms, so `--follow` just delegates to `tail -f`.
// ---------------------------------------------------------------------------

export function pulseLogPath(home: string = homedir()): string {
  return join(home, '.pulse', 'pulse.log')
}

/** Last `n` lines of a blob (trailing newline ignored). Pure + testable. */
export function tailLines(content: string, n: number): string[] {
  const lines = content.replace(/\n$/, '').split('\n')
  if (content === '') return []
  return lines.slice(-n)
}

export interface LogsOpts {
  lines?: number
  follow?: boolean
}

export interface LogsDeps {
  logPath?: string
  readFileFn?: (p: string) => Promise<string>
  exists?: (p: string) => Promise<boolean>
  spawnFn?: typeof spawn
  write?: (s: string) => void
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await readFile(p)
    return true
  } catch {
    return false
  }
}

export async function runLogs(opts: LogsOpts = {}, deps: LogsDeps = {}): Promise<void> {
  const path = deps.logPath ?? pulseLogPath()
  const n = opts.lines ?? 50
  const write = deps.write ?? ((s: string) => process.stdout.write(s))
  const exists = deps.exists ?? defaultExists

  if (!(await exists(path))) {
    process.stderr.write(
      `No log file at ${path}.\n` +
        'Logs appear once Pulse runs as a service (`pulse install`) or in the foreground (`pulse start`).\n',
    )
    process.exit(1)
    return
  }

  if (opts.follow) {
    // Delegate to `tail -f` so we don't reimplement file-follow semantics.
    const spawnFn = deps.spawnFn ?? spawn
    await new Promise<void>(resolve => {
      const child = spawnFn('tail', ['-n', String(n), '-f', path], { stdio: 'inherit' })
      child.on('error', err => {
        process.stderr.write(`Could not follow logs: ${(err as Error).message}\n`)
        resolve()
      })
      child.on('close', () => resolve())
    })
    return
  }

  const readFileFn = deps.readFileFn ?? ((p: string) => readFile(p, 'utf8'))
  const content = await readFileFn(path)
  const out = tailLines(content, n)
  write(out.length ? out.join('\n') + '\n' : '(log is empty)\n')
}
