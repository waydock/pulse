import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import { Config } from '@waydock/pulse-core'

export type ResolvedConfig = Omit<Config, 'agents'> & {
  agents: Array<
    Config['agents'][number] & {
      retries: number
      confirm: number
      interval: number
    }
  >
}

export function interpolateEnv(raw: string, env: NodeJS.ProcessEnv = process.env): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (env[name] === undefined) {
      throw new Error(`missing env var referenced in config: ${name}`)
    }
    return env[name] as string
  })
}

export async function loadConfig(
  path: string,
  opts?: { credentialsPath?: string; env?: NodeJS.ProcessEnv },
): Promise<ResolvedConfig> {
  const env = opts?.env ?? process.env

  // 1. Read, interpolate, parse, validate
  const raw = await readFile(path, 'utf8')
  const interpolated = interpolateEnv(raw, env)
  const parsed = parseYaml(interpolated)
  const cfg = Config.parse(parsed)

  // 2. If heartbeat.key is absent, try loading from credentials file
  if (!cfg.heartbeat.key) {
    const credsPath = opts?.credentialsPath ?? join(homedir(), '.pulse', 'credentials.json')
    try {
      const credsText = await readFile(credsPath, 'utf8')
      const creds = JSON.parse(credsText) as { key?: string }
      if (creds.key) {
        cfg.heartbeat.key = creds.key
      }
    } catch {
      // Credentials file absent or unreadable — leave key undefined
    }
  }

  // 3. Merge defaults into each agent
  const defaults = cfg.defaults
  const agents = cfg.agents.map(agent => ({
    ...agent,
    retries: agent.retries ?? defaults.retries,
    confirm: agent.confirm ?? defaults.confirm,
    interval: cfg.heartbeat.interval,
  }))

  return { ...cfg, agents } as ResolvedConfig
}
