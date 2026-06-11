import { z } from 'zod'

/** Unix SECONDS sanity bound: reject ms-scale values. 10_000_000_000 ≈ year 2286. */
const unixSeconds = z.number().int().nonnegative().max(10_000_000_000)

export const AgentStatus = z.object({
  name: z.string().min(1).max(64),
  status: z.enum(['up', 'down']),
  restarts: z.number().int().nonnegative(),
}).strip()
export type AgentStatus = z.infer<typeof AgentStatus>

export const Metrics = z.object({
  cpu: z.number().min(0).max(100),
  mem: z.number().min(0).max(100),
  disk: z.number().min(0).max(100),
  load1: z.number().nonnegative(),
  uptime: z.number().nonnegative(),
}).strip()
export type Metrics = z.infer<typeof Metrics>

export const HeartbeatPayload = z.object({
  node: z.string().min(1).max(128),
  ts: unixSeconds,
  interval: z.number().int().positive().max(86_400),
  agents: z.array(AgentStatus).max(100),
  metrics: Metrics,
}).strip()
export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>
