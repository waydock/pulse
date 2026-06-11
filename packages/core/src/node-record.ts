import type { AgentStatus, Metrics } from './heartbeat.js'

export type NodeStatus = 'up' | 'degraded' | 'down' | 'pending'

export interface NodeRecord {
  // durable (Postgres pulse_nodes)
  organizationId: string
  id: string
  firstSeen: number
  paused: boolean
  visibility: 'org' | 'private'
  // hot (Redis; null/stale => render DOWN/pending)
  lastSeen: number | null     // receiver arrival time, NOT agent ts
  clientTs: number | null     // agent ts, display metadata only
  expectedPeriod: number
  deadline: number
  alerted: boolean
  agents: AgentStatus[]
  metrics: Metrics | null
}
