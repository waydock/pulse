export type RestartOutcome = 'alert-only' | 'recovered' | 'failed'

export interface RestartDeps {
  exec: (cmd: string) => Promise<void>
  recheck: () => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  baseBackoffMs: number
}

export interface RestartAgent {
  name: string
  restart: string | false
  retries: number
}

export async function attemptRestart(
  agent: RestartAgent,
  deps: RestartDeps,
): Promise<{ outcome: RestartOutcome; attempts: number }> {
  if (agent.restart === false) {
    return { outcome: 'alert-only', attempts: 0 }
  }

  for (let n = 1; n <= agent.retries; n++) {
    try {
      await deps.exec(agent.restart)
    } catch {
      // swallow — a failing restart command is just a failed attempt
    }
    await deps.sleep(n * deps.baseBackoffMs)
    if (await deps.recheck()) {
      return { outcome: 'recovered', attempts: n }
    }
  }

  return { outcome: 'failed', attempts: agent.retries }
}
