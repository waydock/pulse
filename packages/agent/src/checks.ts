import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import type { Check } from '@waydock/pulse-core'

const execAsync = promisify(exec)

export async function runHttp({ http }: { http: string }): Promise<boolean> {
  try {
    const res = await fetch(http, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}

export async function runCommand({ command }: { command: string }): Promise<boolean> {
  try {
    await execAsync(command, { shell: '/bin/sh' })
    return true
  } catch {
    return false
  }
}

async function defaultProcessList(): Promise<string[]> {
  try {
    const { stdout } = await execAsync('ps -axo command=', { shell: '/bin/sh' })
    return stdout.split('\n').map(l => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function runProcess(
  { process: name }: { process: string },
  list: () => Promise<string[]> = defaultProcessList,
): Promise<boolean> {
  const procs = await list()
  return procs.some(p => p.includes(name))
}

export async function evaluateAgent(checks: Check[]): Promise<boolean> {
  const results = await Promise.all(
    checks.map(c =>
      'process' in c ? runProcess(c) :
      'http' in c    ? runHttp(c) :
                       runCommand(c),
    ),
  )
  return results.every(Boolean)
}
