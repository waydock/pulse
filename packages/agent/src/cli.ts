#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { commands } from './commands.js'

export type CommandOpts = {
  config: string
  // start only: suppress the per-heartbeat status line (`-q`/`--quiet`).
  quiet: boolean
  // check only: emit machine-readable JSON instead of a table (`--json`).
  json?: boolean
  // init only: force guided setup (`-i`/`--interactive`) or force the static
  // template (`-y`/`--yes`). Unset => decide from whether stdin/stdout is a TTY.
  interactive?: boolean
  yes?: boolean
}

export type Command =
  | 'init'
  | 'check'
  | 'start'
  | 'login'
  | 'logout'
  | 'whoami'
  | 'doctor'
  | 'install'
  | 'uninstall'
  | 'upgrade'
  | 'version'
  | 'help'

export type Handlers = Record<Command, (opts: CommandOpts) => Promise<void>>

const COMMANDS: readonly Command[] = [
  'init', 'check', 'start', 'login', 'logout', 'whoami',
  'doctor', 'install', 'uninstall', 'upgrade', 'version', 'help',
]

// Map the first token (which may be a meta-flag) to a command.
function resolveCommand(first: string | undefined): Command | undefined {
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') return 'help'
  if (first === '--version' || first === '-v' || first === 'version') return 'version'
  return (COMMANDS as readonly string[]).includes(first) ? (first as Command) : undefined
}

export async function run(argv: string[], handlers: Handlers): Promise<void> {
  const cmd = resolveCommand(argv[0])

  // Parse flags: --config <path>, --quiet/-q, --json, --interactive/-i, --yes/-y
  let config = './pulse.config.yaml'
  let quiet = false
  let json: boolean | undefined
  let interactive: boolean | undefined
  let yes: boolean | undefined
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config' && argv[i + 1] !== undefined) {
      config = argv[i + 1]
      i++
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--interactive' || arg === '-i' || arg === '--guided') {
      interactive = true
    } else if (arg === '--yes' || arg === '-y' || arg === '--non-interactive') {
      yes = true
    }
  }

  const opts: CommandOpts = { config, quiet, json, interactive, yes }

  if (!cmd) {
    throw new Error(`unknown command: ${argv[0]}`)
  }

  await handlers[cmd](opts)
}

export const defaultHandlers: Handlers = commands

export async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  await run(argv, defaultHandlers)

  // After a one-shot command finishes, surface an upgrade notice (best-effort,
  // cached, stderr-only). Skipped for `start` (which blocks above and never
  // returns) and for the meta commands where it would just be noise.
  const cmd = resolveCommand(argv[0])
  if (cmd && cmd !== 'version' && cmd !== 'help' && cmd !== 'upgrade') {
    const { getVersion, notifyIfUpdate } = await import('./version.js')
    await notifyIfUpdate(await getVersion()).catch(() => {})
  }
}

// True when this module is the process entry point. npm installs the CLI as a
// symlink (.bin/pulse -> dist/cli.js), so process.argv[1] is the symlink path
// while import.meta.url is the realpath; resolve the link before comparing, or
// main() never runs when invoked as the installed `pulse` binary.
export function isMainEntry(importMetaUrl: string, entry: string | undefined): boolean {
  if (!entry) return false
  try {
    return importMetaUrl === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isMainEntry(import.meta.url, process.argv[1])) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
