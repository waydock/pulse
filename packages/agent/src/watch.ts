import { homedir } from 'node:os'
import { join } from 'node:path'
import { AgentState } from './state-machine.js'
import { evaluateAgent } from './checks.js'
import { startHeartbeatLoop, buildHeartbeat, sendHeartbeat, defaultMetrics } from './heartbeat.js'
import type { AlertEvent } from './webhook.js'
import type { RestartOutcome } from './restart.js'
import type { ResolvedConfig } from './config-loader.js'
import type { AgentStatus } from '@waydock/pulse-core'

/** Default on-disk path for persisted agent state. */
export const DEFAULT_STATE_PATH = join(homedir(), '.pulse', 'state.json')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-tick shared mutable context; created once and passed into each tick. */
export interface WatchCtx {
  /** Per-agent state machines, keyed by agent name. */
  states: Map<string, AgentState>
  /** Latest reported status per agent (shared with the heartbeat loop). */
  statuses: Map<string, { status: 'up' | 'down'; restarts: number }>
}

export interface CheckTickDeps {
  /** Send a local webhook alert. */
  sendLocalAlert: (url: string | undefined, ev: AlertEvent) => Promise<void>
  /** Attempt to restart an agent, returns outcome. */
  attemptRestart: (agent: {
    name: string
    restart: string | false | undefined
    retries: number
  }) => Promise<{ outcome: RestartOutcome; attempts: number }>
  /** Persist agent statuses to disk. */
  writeState: (path: string, state: Record<string, string>) => Promise<void>
  /** Path to the state file on disk. */
  statePath: string
  /** Current time in seconds. */
  now: () => number
}

// ---------------------------------------------------------------------------
// runCheckTick
// ---------------------------------------------------------------------------

/**
 * One check + possible restart cycle for every agent.
 * Mutates ctx (states + statuses) and writes state to disk.
 */
export async function runCheckTick(
  config: ResolvedConfig,
  ctx: WatchCtx,
  deps: CheckTickDeps,
): Promise<void> {
  const webhookUrl = config.webhook?.url

  for (const agent of config.agents) {
    // Lazily create state machine for this agent
    if (!ctx.states.has(agent.name)) {
      ctx.states.set(agent.name, new AgentState(agent.confirm))
    }
    const state = ctx.states.get(agent.name)!

    // Run all checks for this agent
    const passed = await evaluateAgent(agent.checks)
    const transition = state.onCheck(passed)

    const ts = deps.now()
    const baseEvent = { node: config.node, agent: agent.name, ts }

    if (transition === 'up->down') {
      // Fire 'down' alert
      await deps.sendLocalAlert(webhookUrl, { ...baseEvent, kind: 'down' })

      // Attempt restart if configured
      const restartCmd = agent.restart
      if (restartCmd !== false && restartCmd !== undefined) {
        state.markRestarting()
        const { outcome } = await deps.attemptRestart({
          name: agent.name,
          restart: restartCmd,
          retries: agent.retries,
        })

        if (outcome === 'recovered') {
          // The recheck inside attemptRestart succeeded, so update state machine
          state.onCheck(true)
          await deps.sendLocalAlert(webhookUrl, { ...baseEvent, kind: 'restart-recovered' })
        } else if (outcome === 'failed') {
          await deps.sendLocalAlert(webhookUrl, { ...baseEvent, kind: 'restart-failed' })
        }
        // 'alert-only' means restart === false handled inside attemptRestart; shouldn't reach here
      }
    } else if (transition === 'down->up') {
      await deps.sendLocalAlert(webhookUrl, { ...baseEvent, kind: 'up' })
    }

    // Update shared status
    const currentRestarts = ctx.statuses.get(agent.name)?.restarts ?? 0
    ctx.statuses.set(agent.name, {
      status: state.status === 'restarting' ? 'down' : state.status,
      restarts: currentRestarts,
    })
  }

  // Persist statuses to state file
  const stateObj: Record<string, string> = {}
  for (const [name, info] of ctx.statuses) {
    stateObj[name] = info.status
  }
  await deps.writeState(deps.statePath, stateObj)
}

// ---------------------------------------------------------------------------
// startWatch
// ---------------------------------------------------------------------------

export interface StartWatchDeps {
  /** Override setInterval (for tests). */
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void
  /** Path to the on-disk state file; defaults to DEFAULT_STATE_PATH. */
  statePath?: string
  /** Override readState (for tests). */
  readState?: (path: string) => Promise<Record<string, string>>
}

/**
 * Start two independent loops:
 * 1. Check/restart loop on config.heartbeat.interval
 * 2. Heartbeat loop via startHeartbeatLoop (completely decoupled)
 *
 * Returns a stop() function that stops both loops.
 */
export async function startWatch(config: ResolvedConfig, deps: StartWatchDeps = {}): Promise<() => void> {
  const statePath = deps.statePath ?? DEFAULT_STATE_PATH

  // Read persisted state before starting loops so a restart does not re-fire
  // alerts for agents that were already known-down before the restart.
  const readStateFn = deps.readState ?? (async (p) => {
    const { readState } = await import('./state-file.js')
    return readState(p)
  })
  const persisted = await readStateFn(statePath)

  const ctx: WatchCtx = {
    states: new Map(),
    statuses: new Map(),
  }

  // Seed state machines and statuses from persisted data
  for (const agent of config.agents) {
    const persistedStatus = persisted[agent.name] as ('up' | 'down') | undefined
    if (persistedStatus === 'down') {
      const state = new AgentState(agent.confirm)
      state.seed('down')
      ctx.states.set(agent.name, state)
      ctx.statuses.set(agent.name, { status: 'down', restarts: 0 })
    }
  }

  // --- Check/restart loop ---
  const checkIntervalMs = config.heartbeat.interval * 1000

  const checkTickDeps: CheckTickDeps = {
    sendLocalAlert: async (url, ev) => {
      const { sendLocalAlert } = await import('./webhook.js')
      await sendLocalAlert(url, ev)
    },
    attemptRestart: async (agent) => {
      const { attemptRestart } = await import('./restart.js')
      return attemptRestart(
        { name: agent.name, restart: agent.restart ?? false, retries: agent.retries },
        {
          exec: async (cmd) => {
            const { exec } = await import('node:child_process')
            const { promisify } = await import('node:util')
            await promisify(exec)(cmd, { shell: '/bin/sh' })
          },
          recheck: async () => evaluateAgent(
            config.agents.find(a => a.name === agent.name)!.checks,
          ),
          sleep: (ms) => new Promise(r => setTimeout(r, ms)),
          baseBackoffMs: 2000,
        },
      )
    },
    writeState: async (path, state) => {
      const { writeState } = await import('./state-file.js')
      await writeState(path, state)
    },
    statePath,
    now: () => Date.now() / 1000,
  }

  const setFn = deps.setIntervalFn ?? setInterval
  const clearFn = deps.clearIntervalFn ?? clearInterval

  const checkId = setFn(() => {
    runCheckTick(config, ctx, checkTickDeps).catch(() => {
      /* swallow — check loop must never crash the process */
    })
  }, checkIntervalMs)

  // --- Heartbeat loop ---
  const stopHeartbeat = startHeartbeatLoop({
    intervalMs: checkIntervalMs,
    tick: async () => {
      const agentStatuses = (): AgentStatus[] =>
        config.agents.map(a => {
          const info = ctx.statuses.get(a.name)
          return {
            name: a.name,
            status: info?.status ?? 'up',
            restarts: info?.restarts ?? 0,
          }
        })

      const payload = await buildHeartbeat({
        node: config.node,
        interval: config.heartbeat.interval,
        agents: agentStatuses,
        metrics: defaultMetrics,
      })

      await sendHeartbeat(config.heartbeat.url, config.heartbeat.key ?? '', payload)
    },
    setIntervalFn: deps.setIntervalFn,
    clearIntervalFn: deps.clearIntervalFn,
  })

  return () => {
    clearFn(checkId)
    stopHeartbeat()
  }
}
