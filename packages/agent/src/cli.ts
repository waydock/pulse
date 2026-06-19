#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { commands } from './commands.js'

export type CommandOpts = { config: string; quiet: boolean }

export type Handlers = {
  init: (opts: CommandOpts) => Promise<void>
  check: (opts: CommandOpts) => Promise<void>
  start: (opts: CommandOpts) => Promise<void>
  login: (opts: CommandOpts) => Promise<void>
}

const COMMANDS = ['init', 'check', 'start', 'login'] as const
type Command = (typeof COMMANDS)[number]

export async function run(argv: string[], handlers: Handlers): Promise<void> {
  const cmd = argv[0] as Command | undefined

  // Parse flags: --config <path>, --quiet/-q
  let config = './pulse.config.yaml'
  let quiet = false
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1] !== undefined) {
      config = argv[i + 1]
      i++
    } else if (argv[i] === '--quiet' || argv[i] === '-q') {
      quiet = true
    }
  }

  const opts: CommandOpts = { config, quiet }

  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error(`unknown command: ${cmd ?? '(none)'}`)
  }

  await handlers[cmd](opts)
}

export const defaultHandlers: Handlers = commands

export async function main(): Promise<void> {
  await run(process.argv.slice(2), defaultHandlers)
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
