import { stat } from 'node:fs/promises'
import type { ResolvedConfig } from './config-loader.js'
import { DEFAULT_STATE_PATH } from './watch.js'
import { readState } from './state-file.js'

// ---------------------------------------------------------------------------
// `pulse status` — what the *running* watcher last saw, read from the persisted
// state file (no re-evaluation, unlike `check`). Answers "is my installed
// service healthy and reporting?" using the state file's contents + its mtime
// as a last-activity signal.
// ---------------------------------------------------------------------------

export interface StatusInfo {
  node?: string
  statePath: string
  lastUpdatedMs?: number
  ageSeconds?: number
  stale: boolean
  hasState: boolean
  agents: Array<{ name: string; status: string }>
}

/** Humanise a second count: 5s, 3m, 2h, 1d. */
export function humanizeAge(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

export interface StatusDeps {
  configPath?: string
  statePath?: string
  loadConfig?: (p: string) => Promise<ResolvedConfig>
  readState?: (p: string) => Promise<Record<string, string>>
  statMtimeMs?: (p: string) => Promise<number | undefined>
  now?: () => number
}

async function defaultStatMtime(p: string): Promise<number | undefined> {
  try {
    return (await stat(p)).mtimeMs
  } catch {
    return undefined
  }
}

export async function readStatus(deps: StatusDeps = {}): Promise<StatusInfo> {
  const statePath = deps.statePath ?? DEFAULT_STATE_PATH
  const now = deps.now ?? Date.now
  const readStateFn = deps.readState ?? readState
  const statMtime = deps.statMtimeMs ?? defaultStatMtime

  // Config is optional — it gives us the node name, agent order, and interval.
  let config: ResolvedConfig | undefined
  try {
    config = await (deps.loadConfig ?? (async (p: string) => (await import('./config-loader.js')).loadConfig(p)))(
      deps.configPath ?? './pulse.config.yaml',
    )
  } catch {
    config = undefined
  }

  const state = await readStateFn(statePath)
  const mtime = await statMtime(statePath)
  const hasState = mtime !== undefined

  const ageSeconds = mtime !== undefined ? Math.max(0, (now() - mtime) / 1000) : undefined

  // Stale when older than 3 intervals (or 5 min if the interval is unknown).
  const interval = config?.heartbeat.interval ?? 100
  const stale = ageSeconds === undefined ? true : ageSeconds > interval * 3

  // Prefer the config's agent order; fall back to whatever the state file holds.
  const names = config ? config.agents.map(a => a.name) : Object.keys(state)
  const agents = names.map(name => ({ name, status: state[name] ?? 'unknown' }))

  return {
    node: config?.node,
    statePath,
    lastUpdatedMs: mtime,
    ageSeconds,
    stale,
    hasState,
    agents,
  }
}

export function formatStatus(info: StatusInfo): string {
  const lines: string[] = []
  if (info.node) lines.push(`Node: ${info.node}`)

  if (!info.hasState) {
    lines.push(`No state yet at ${info.statePath}.`)
    lines.push('The watcher may not have run — start it with `pulse start` or `pulse install`.')
    return lines.join('\n') + '\n'
  }

  const age = info.ageSeconds !== undefined ? humanizeAge(info.ageSeconds) : '?'
  lines.push(
    info.stale
      ? `Last update: ${age} ago — ⚠ stale; the watcher may not be running.`
      : `Last update: ${age} ago.`,
  )
  lines.push('')

  const nameWidth = Math.max(4, ...info.agents.map(a => a.name.length))
  lines.push(`${'NAME'.padEnd(nameWidth)}  STATUS`)
  lines.push(`${'-'.repeat(nameWidth)}  ------`)
  for (const a of info.agents) lines.push(`${a.name.padEnd(nameWidth)}  ${a.status}`)

  return lines.join('\n') + '\n'
}
