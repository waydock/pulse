import type { AgentAnswer, CheckAnswer } from './setup.js'

// ---------------------------------------------------------------------------
// Service autodetection for `pulse init`. We scan the platform's service
// manager (launchd / systemd) and pm2 for running services and offer them as
// pre-filled agents — like the way `vercel`/`sentry` wizards detect your setup.
// Parsers are pure so they're testable against captured output.
// ---------------------------------------------------------------------------

export interface DetectedService {
  name: string
  source: 'launchd' | 'systemd' | 'pm2'
  check: CheckAnswer
  restart: string | false
}

// `launchctl list` => "PID\tStatus\tLabel". Skip Apple/system labels and the
// header; keep third-party agents the user might actually want to watch.
export function parseLaunchctlList(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const cols = line.split('\t')
    if (cols.length < 3) continue
    const label = cols[2].trim()
    if (!label || label === 'Label') continue
    if (label.startsWith('com.apple.') || label.startsWith('application.')) continue
    out.push(label)
  }
  return out
}

// `systemctl --user list-units --type=service --state=running --no-legend --plain`
// => "name.service loaded active running Description". Take the unit, drop .service.
export function parseSystemctlUnits(stdout: string): string[] {
  const out: string[] = []
  for (const line of stdout.split('\n')) {
    const first = line.trim().split(/\s+/)[0]
    if (!first || !first.endsWith('.service')) continue
    out.push(first.replace(/\.service$/, ''))
  }
  return out
}

// `pm2 jlist` => JSON array of process objects with a `name`.
export function parsePm2Jlist(stdout: string): string[] {
  try {
    const arr = JSON.parse(stdout) as Array<{ name?: string }>
    return [...new Set(arr.map(p => p.name).filter((n): n is string => Boolean(n)))]
  } catch {
    return []
  }
}

export function launchdToService(label: string): DetectedService {
  return {
    name: label.split('.').pop() || label,
    source: 'launchd',
    check: { kind: 'command', value: `launchctl list ${label}` },
    restart: `launchctl kickstart -k gui/$(id -u)/${label}`,
  }
}

export function systemdToService(unit: string): DetectedService {
  return {
    name: unit,
    source: 'systemd',
    check: { kind: 'command', value: `systemctl --user is-active ${unit}` },
    restart: `systemctl --user restart ${unit}`,
  }
}

export function pm2ToService(name: string): DetectedService {
  return {
    name,
    source: 'pm2',
    check: { kind: 'process', value: name },
    restart: `pm2 restart ${name}`,
  }
}

export interface DetectDeps {
  platform?: NodeJS.Platform
  /** Run a command, returning stdout; throw/return null when unavailable. */
  exec?: (cmd: string) => Promise<string | null>
}

async function defaultExec(cmd: string): Promise<string | null> {
  const { exec } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    const { stdout } = await promisify(exec)(cmd, { shell: '/bin/sh', timeout: 4000 })
    return stdout
  } catch {
    return null
  }
}

/** Detect running services on this machine (best-effort; [] when nothing found). */
export async function detectServices(deps: DetectDeps = {}): Promise<DetectedService[]> {
  const platform = deps.platform ?? process.platform
  const exec = deps.exec ?? defaultExec
  const found: DetectedService[] = []

  if (platform === 'darwin') {
    const out = await exec('launchctl list')
    if (out) found.push(...parseLaunchctlList(out).map(launchdToService))
  } else if (platform === 'linux') {
    const out = await exec('systemctl --user list-units --type=service --state=running --no-legend --plain')
    if (out) found.push(...parseSystemctlUnits(out).map(systemdToService))
  }

  // pm2 is cross-platform and common for Node apps — fold it in if present.
  const pm2 = await exec('pm2 jlist')
  if (pm2) found.push(...parsePm2Jlist(pm2).map(pm2ToService))

  // De-dupe by name, keeping the first (platform-native) source.
  const seen = new Set<string>()
  return found.filter(s => (seen.has(s.name) ? false : (seen.add(s.name), true)))
}

export function toAgentAnswer(s: DetectedService): AgentAnswer {
  return { name: s.name, check: s.check, restart: s.restart }
}
