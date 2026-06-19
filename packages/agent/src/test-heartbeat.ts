import type { ResolvedConfig } from './config-loader.js'
import type { AgentStatus } from '@waydock/pulse-core'

// ---------------------------------------------------------------------------
// Send a single heartbeat on demand — used to close the onboarding loop ("✓
// Waydock received your first heartbeat") and reusable as a building block.
// Fully dependency-injected for testing.
// ---------------------------------------------------------------------------

export interface TestHeartbeatResult {
  authenticated: boolean
  ok: boolean
  status?: number
}

export interface TestHeartbeatDeps {
  loadConfig?: (p: string) => Promise<ResolvedConfig>
  evaluateAgent?: (checks: ResolvedConfig['agents'][number]['checks']) => Promise<boolean>
  sendHeartbeat?: (url: string, key: string, payload: any) => Promise<{ ok: boolean; status?: number }>
  buildHeartbeat?: (opts: any) => Promise<any>
  metrics?: (flags: any) => Promise<any>
}

export async function sendTestHeartbeat(configPath: string, deps: TestHeartbeatDeps = {}): Promise<TestHeartbeatResult> {
  const loadConfig = deps.loadConfig ?? (async (p: string) => (await import('./config-loader.js')).loadConfig(p))
  const evaluate = deps.evaluateAgent ?? (async (c: any) => (await import('./checks.js')).evaluateAgent(c))
  const hb = await import('./heartbeat.js')
  const sendHeartbeat = deps.sendHeartbeat ?? hb.sendHeartbeat
  const buildHeartbeat = deps.buildHeartbeat ?? hb.buildHeartbeat
  const metrics = deps.metrics ?? hb.defaultMetrics

  const config = await loadConfig(configPath)
  if (!config.heartbeat.key) return { authenticated: false, ok: false }

  const statuses: AgentStatus[] = []
  for (const agent of config.agents) {
    const up = await evaluate(agent.checks)
    statuses.push({ name: agent.name, status: up ? 'up' : 'down', restarts: 0 })
  }

  const payload = await buildHeartbeat({
    node: config.node,
    interval: config.heartbeat.interval,
    agents: () => statuses,
    metrics: () => metrics(config.metrics),
  })

  const result = await sendHeartbeat(config.heartbeat.url, config.heartbeat.key, payload)
  return { authenticated: true, ok: result.ok, status: result.status }
}
