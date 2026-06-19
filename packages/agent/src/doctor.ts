import { readFile } from 'node:fs/promises'
import type { ResolvedConfig } from './config-loader.js'
import { defaultCredentialsPath } from './account.js'

// ---------------------------------------------------------------------------
// `pulse doctor` — preflight diagnostics, in the spirit of `brew doctor` /
// `fly doctor`. Each check is independent and reports pass / warn / fail with a
// remediation hint. The orchestrator is fully dependency-injected so the whole
// thing is testable without touching the real system.
// ---------------------------------------------------------------------------

export type CheckStatus = 'pass' | 'warn' | 'fail'

export interface DoctorCheck {
  name: string
  status: CheckStatus
  detail?: string
  hint?: string
}

export interface DoctorReport {
  checks: DoctorCheck[]
  ok: boolean // false if any check failed (warns don't fail the report)
}

const MIN_NODE_MAJOR = 20

/** Pure: validate the running Node major against our engines floor. */
export function checkNodeVersion(version: string, min = MIN_NODE_MAJOR): DoctorCheck {
  const major = parseInt(version.replace(/^v/, '').split('.')[0], 10) || 0
  return major >= min
    ? { name: 'Node.js', status: 'pass', detail: `${version} (>= ${min})` }
    : { name: 'Node.js', status: 'fail', detail: `${version}`, hint: `Pulse requires Node >= ${min}.` }
}

/** First whitespace-separated token of a restart command — the binary to probe. */
export function restartBinary(cmd: string): string {
  return cmd.trim().split(/\s+/)[0]
}

export interface DoctorDeps {
  configPath?: string
  credentialsPath?: string
  nodeVersion?: string
  loadConfig?: (p: string) => Promise<ResolvedConfig>
  readKey?: (p: string) => Promise<string | undefined>
  reach?: (url: string) => Promise<boolean>
  evaluateAgent?: (checks: ResolvedConfig['agents'][number]['checks']) => Promise<boolean>
  hasBinary?: (name: string) => Promise<boolean>
}

async function defaultReadKey(p: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(p, 'utf8')) as { key?: string }).key
  } catch {
    return undefined
  }
}

async function defaultReach(url: string): Promise<boolean> {
  try {
    // Any HTTP response (even 401/404) proves the host is reachable.
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
    return true
  } catch {
    return false
  }
}

async function defaultHasBinary(name: string): Promise<boolean> {
  const { exec } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    await promisify(exec)(`command -v ${name}`, { shell: '/bin/sh' })
    return true
  } catch {
    return false
  }
}

export async function runDoctor(deps: DoctorDeps = {}): Promise<DoctorReport> {
  const configPath = deps.configPath ?? './pulse.config.yaml'
  const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath()
  const loadConfigFn = deps.loadConfig ?? (async (p: string) => (await import('./config-loader.js')).loadConfig(p))
  const readKey = deps.readKey ?? defaultReadKey
  const reach = deps.reach ?? defaultReach
  const evaluate = deps.evaluateAgent ?? (async (c: any) => (await import('./checks.js')).evaluateAgent(c))
  const hasBinary = deps.hasBinary ?? defaultHasBinary

  const checks: DoctorCheck[] = []
  checks.push(checkNodeVersion(deps.nodeVersion ?? process.version))

  // Config — if it won't load we can't run the config-dependent checks.
  let config: ResolvedConfig | undefined
  try {
    config = await loadConfigFn(configPath)
    checks.push({ name: 'Config', status: 'pass', detail: `${configPath} (${config.agents.length} agent${config.agents.length === 1 ? '' : 's'})` })
  } catch (err: any) {
    const missing = err?.code === 'ENOENT'
    checks.push({
      name: 'Config',
      status: 'fail',
      detail: missing ? `not found at ${configPath}` : err.message,
      hint: missing ? 'Run `pulse init` to create one.' : 'Fix the errors above and re-run.',
    })
    return { checks, ok: false }
  }

  // Authentication — needed for `pulse start`, optional for `pulse check`.
  const key = await readKey(credentialsPath)
  checks.push(
    key
      ? { name: 'Authentication', status: 'pass', detail: 'credentials present' }
      : { name: 'Authentication', status: 'warn', detail: 'not logged in', hint: 'Run `pulse login` before `pulse start`.' },
  )

  // Ingest reachability.
  const reachable = await reach(config.heartbeat.url)
  let host = config.heartbeat.url
  try { host = new URL(config.heartbeat.url).host } catch { /* keep raw */ }
  checks.push(
    reachable
      ? { name: 'Ingest reachable', status: 'pass', detail: host }
      : { name: 'Ingest reachable', status: 'warn', detail: `cannot reach ${host}`, hint: 'Heartbeats are best-effort; check connectivity/firewall.' },
  )

  // Per-agent: does it currently pass, and is its restart binary installed?
  for (const agent of config.agents) {
    const up = await evaluate(agent.checks)
    checks.push({
      name: `Agent "${agent.name}"`,
      status: up ? 'pass' : 'warn',
      detail: up ? 'up' : 'down',
      hint: up ? undefined : 'Down now — confirm this is expected.',
    })
    if (typeof agent.restart === 'string') {
      const bin = restartBinary(agent.restart)
      const present = await hasBinary(bin)
      checks.push({
        name: `  restart for "${agent.name}"`,
        status: present ? 'pass' : 'fail',
        detail: present ? `${bin} on PATH` : `${bin} not found`,
        hint: present ? undefined : `Restart would fail — install ${bin} or fix the command.`,
      })
    }
  }

  return { checks, ok: checks.every(c => c.status !== 'fail') }
}

const SYMBOL: Record<CheckStatus, string> = { pass: '✓', warn: '⚠', fail: '✗' }

export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map(c => {
    const head = `${SYMBOL[c.status]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`
    return c.hint ? `${head}\n    ${c.hint}` : head
  })
  lines.push('')
  lines.push(report.ok ? 'All clear.' : 'Some checks failed — see hints above.')
  return lines.join('\n') + '\n'
}
