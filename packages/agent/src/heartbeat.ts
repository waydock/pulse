import { loadavg } from 'node:os'
import type { AgentStatus, HeartbeatPayload, Metrics } from '@waydock/pulse-core'

export type { AgentStatus, HeartbeatPayload, Metrics }

// ---------------------------------------------------------------------------
// buildHeartbeat
// ---------------------------------------------------------------------------

export interface BuildHeartbeatOpts {
  node: string
  interval: number
  agents: () => AgentStatus[]
  metrics: () => Promise<Metrics>
  now?: () => number
}

export async function buildHeartbeat(opts: BuildHeartbeatOpts): Promise<HeartbeatPayload> {
  const nowFn = opts.now ?? (() => Date.now() / 1000)
  const ts = Math.floor(nowFn())
  return {
    node: opts.node,
    ts,
    interval: opts.interval,
    agents: opts.agents(),
    metrics: await opts.metrics(),
  }
}

// ---------------------------------------------------------------------------
// sendHeartbeat
// ---------------------------------------------------------------------------

export interface SendHeartbeatDeps {
  fetch?: typeof globalThis.fetch
}

export async function sendHeartbeat(
  url: string,
  key: string,
  payload: HeartbeatPayload,
  deps: SendHeartbeatDeps = {},
): Promise<void> {
  const fetchFn = deps.fetch ?? globalThis.fetch
  try {
    await fetchFn(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    // best-effort: swallow all network / timeout errors
  }
}

// ---------------------------------------------------------------------------
// startHeartbeatLoop
// ---------------------------------------------------------------------------

export interface HeartbeatLoopOpts {
  intervalMs: number
  tick: () => Promise<void>
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
}

/**
 * Runs `tick` on its own independent timer — completely decoupled from any
 * check/restart loop so a slow restart can never delay a heartbeat.
 * Returns a `stop()` function that clears the interval.
 */
export function startHeartbeatLoop(opts: HeartbeatLoopOpts): () => void {
  const setFn = opts.setIntervalFn ?? setInterval
  const clearFn = opts.clearIntervalFn ?? clearInterval

  const id = setFn(() => {
    opts.tick().catch(() => { /* swallow — heartbeat must never crash the process */ })
  }, opts.intervalMs)

  return () => clearFn(id)
}

// ---------------------------------------------------------------------------
// defaultMetrics — thin systeminformation wrapper for production use
// ---------------------------------------------------------------------------

export async function defaultMetrics(): Promise<Metrics> {
  // Dynamic import keeps systeminformation out of test bundles that inject fakes.
  const si = await import('systeminformation')
  const [cpu, mem, fsSize, time] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.time(),
  ])

  const diskItem = Array.isArray(fsSize) ? fsSize[0] : undefined
  const diskPct = diskItem && diskItem.size > 0
    ? (diskItem.used / diskItem.size) * 100
    : 0

  return {
    cpu: Math.round(cpu.currentLoad * 10) / 10,
    mem: Math.round(((mem.total - mem.available) / mem.total) * 1000) / 10,
    disk: Math.round(diskPct * 10) / 10,
    load1: loadavg()[0],
    uptime: time.uptime ?? 0,
  }
}
