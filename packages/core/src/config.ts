import { z } from 'zod'

// Exactly one of process|http|command per check (a check is one signal).
const Check = z.union([
  z.object({ process: z.string().min(1) }).strict(),
  z.object({ http: z.string().url() }).strict(),
  z.object({ command: z.string().min(1) }).strict(),
])
export type Check = z.infer<typeof Check>

const Defaults = z.object({
  retries: z.number().int().min(0).max(20).default(3),
  confirm: z.number().int().min(1).max(10).default(2),
  interval: z.number().int().positive().max(86_400).default(60),
}).default({})

const AgentConfig = z.object({
  name: z.string().min(1).max(64),
  group: z.string().min(1).max(64).optional(),
  checks: z.array(Check).min(1).max(10),
  restart: z.union([z.string().min(1), z.literal(false)]).optional(),
  retries: z.number().int().min(0).max(20).optional(),
  confirm: z.number().int().min(1).max(10).optional(),
})

export const Config = z.object({
  node: z.string().min(1).max(128),
  heartbeat: z.object({
    url: z.string().url(),
    key: z.string().optional(),
    interval: z.number().int().positive().max(86_400).default(60),
  }),
  webhook: z.object({ url: z.string().url() }).optional(),
  defaults: Defaults,
  agents: z.array(AgentConfig).min(1),
  // per-key defaults so `metrics: { cpu: false }` still yields mem/disk = true (not undefined)
  metrics: z.object({ cpu: z.boolean().default(true), mem: z.boolean().default(true), disk: z.boolean().default(true) }).default({}),
})
export type Config = z.infer<typeof Config>
