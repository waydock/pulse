import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// `pulse logs` — tail the service log written by `pulse install` (launchd and
// the systemd unit both redirect StandardOut/Err here). POSIX-only, which
// matches Pulse's supported platforms, so we delegate to `tail` for both a
// one-shot tail and `--follow` — that avoids loading a large log into memory.
// ---------------------------------------------------------------------------

export function pulseLogPath(home: string = homedir()): string {
  return join(home, '.pulse', 'pulse.log')
}

export interface LogsOpts {
  lines?: number
  follow?: boolean
}

export interface LogsDeps {
  logPath?: string
  exists?: (p: string) => Promise<boolean>
  spawnFn?: typeof spawn
}

async function defaultExists(p: string): Promise<boolean> {
  try {
    await stat(p) // stat, not readFile — don't load the log just to check it exists
    return true
  } catch {
    return false
  }
}

export async function runLogs(opts: LogsOpts = {}, deps: LogsDeps = {}): Promise<void> {
  const path = deps.logPath ?? pulseLogPath()
  const n = opts.lines ?? 50
  const exists = deps.exists ?? defaultExists
  const spawnFn = deps.spawnFn ?? spawn

  if (!(await exists(path))) {
    process.stderr.write(
      `No log file at ${path}.\n` +
        'Logs are written when Pulse runs as a service — set that up with `pulse install`.\n',
    )
    process.exitCode = 1
    return
  }

  // `tail -n N [-f] <path>` streams straight to our stdio and only reads the
  // tail of the file, so even a multi-GB log is cheap.
  const args = ['-n', String(n), ...(opts.follow ? ['-f'] : []), path]
  await new Promise<void>(resolve => {
    const child = spawnFn('tail', args, { stdio: 'inherit' })
    child.on('error', err => {
      process.stderr.write(`Could not read logs (is \`tail\` available?): ${(err as Error).message}\n`)
      process.exitCode = 1
      resolve()
    })
    child.on('close', code => {
      // Propagate a genuine tail failure so scripts can detect it. A Ctrl-C
      // during --follow terminates tail via signal (code === null), which is
      // expected and left as success.
      if (code) process.exitCode = code
      resolve()
    })
  })
}
