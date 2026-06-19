import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Account commands: `whoami` (auth status) and `logout` (drop credentials).
// The access token is opaque to the CLI — there's no local identity to show —
// so whoami reports what we can prove locally: that a key is present, a masked
// fingerprint of it, and where this node reports to (from the config).
// ---------------------------------------------------------------------------

export function defaultCredentialsPath(): string {
  return join(homedir(), '.pulse', 'credentials.json')
}

/** Show enough of a key to recognise it without leaking it. */
export function maskKey(key: string): string {
  if (key.length <= 12) return '*'.repeat(key.length)
  return `${key.slice(0, 6)}…${key.slice(-4)}`
}

export interface WhoamiInfo {
  authenticated: boolean
  keyFingerprint?: string
  node?: string
  ingestHost?: string
  credentialsPath: string
}

export function formatWhoami(info: WhoamiInfo): string {
  if (!info.authenticated) {
    return 'Not logged in. Run `pulse login` to authenticate this machine.'
  }
  const lines = [
    `Logged in (key ${info.keyFingerprint}).`,
    `Credentials: ${info.credentialsPath}`,
  ]
  if (info.node) lines.push(`Node: ${info.node}`)
  if (info.ingestHost) lines.push(`Reporting to: ${info.ingestHost}`)
  return lines.join('\n')
}

export interface AccountDeps {
  credentialsPath?: string
  configPath?: string
  /** Resolve node name + ingest host from config; best-effort, may return {}. */
  readConfigMeta?: (configPath: string) => Promise<{ node?: string; ingestHost?: string }>
}

async function defaultReadConfigMeta(configPath: string): Promise<{ node?: string; ingestHost?: string }> {
  try {
    const { loadConfig } = await import('./config-loader.js')
    const cfg = await loadConfig(configPath)
    let ingestHost: string | undefined
    try { ingestHost = new URL(cfg.heartbeat.url).host } catch { ingestHost = cfg.heartbeat.url }
    return { node: cfg.node, ingestHost }
  } catch {
    return {}
  }
}

export async function readWhoami(deps: AccountDeps = {}): Promise<WhoamiInfo> {
  const credentialsPath = deps.credentialsPath ?? defaultCredentialsPath()
  let key: string | undefined
  try {
    const creds = JSON.parse(await readFile(credentialsPath, 'utf8')) as { key?: string }
    key = creds.key
  } catch {
    // no credentials file
  }

  if (!key) return { authenticated: false, credentialsPath }

  const meta = await (deps.readConfigMeta ?? defaultReadConfigMeta)(deps.configPath ?? './pulse.config.yaml')
  return {
    authenticated: true,
    keyFingerprint: maskKey(key),
    credentialsPath,
    node: meta.node,
    ingestHost: meta.ingestHost,
  }
}

export async function logout(deps: Pick<AccountDeps, 'credentialsPath'> = {}): Promise<{ removed: boolean; path: string }> {
  const path = deps.credentialsPath ?? defaultCredentialsPath()
  let existed = false
  try {
    await readFile(path)
    existed = true
  } catch {
    // already absent
  }
  if (existed) await rm(path, { force: true })
  return { removed: existed, path }
}
