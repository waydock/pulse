#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

export type CommandOpts = { config: string }

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

  // Parse --config flag
  let config = './pulse.config.yaml'
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1] !== undefined) {
      config = argv[i + 1]
      i++
    }
  }

  const opts: CommandOpts = { config }

  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) {
    throw new Error(`unknown command: ${cmd ?? '(none)'}`)
  }

  await handlers[cmd](opts)
}

export const defaultHandlers: Handlers = {
  init: async () => { throw new Error('init not implemented yet') },
  check: async () => { throw new Error('check not implemented yet') },
  start: async () => { throw new Error('start not implemented yet') },
  login: async () => { throw new Error('login not implemented yet') },
}

export async function main(): Promise<void> {
  await run(process.argv.slice(2), defaultHandlers)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1) })
}
