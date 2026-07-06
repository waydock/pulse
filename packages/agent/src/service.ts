import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { defaultCredentialsPath } from './account.js'

// ---------------------------------------------------------------------------
// `pulse install` / `pulse uninstall` — register Pulse itself as a background
// service so the watcher survives logout/reboot (a watcher that doesn't persist
// itself is a sharp edge). launchd user-agent on macOS, systemd *user* unit on
// Linux — both avoid sudo. Generation is pure; the side effects live in the
// command handler, which writes `content` to `path` then runs `install`.
// ---------------------------------------------------------------------------

export const LAUNCHD_LABEL = 'ai.waydock.pulse'
export const SYSTEMD_UNIT = 'pulse.service'

export interface ServiceSpec {
  execPath: string // node binary
  scriptPath: string // absolute path to cli.js
  configPath: string // absolute config path
  logPath: string
  workingDir: string
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = [spec.execPath, spec.scriptPath, 'start', '--quiet', '--config', spec.configPath]
  const argXml = args.map(a => `    <string>${xmlEscape(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(spec.workingDir)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(spec.logPath)}</string>
</dict>
</plist>
`
}

export function systemdUnit(spec: ServiceSpec): string {
  const exec = [spec.execPath, spec.scriptPath, 'start', '--quiet', '--config', spec.configPath].join(' ')
  // Redirect stdout/stderr to the same log file launchd uses, so `pulse logs`
  // works uniformly. Without this, systemd sends output to the journal and
  // ~/.pulse/pulse.log is never created. `append:` needs systemd >= 240.
  return `[Unit]
Description=Pulse watcher (waydock-pulse)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=5
WorkingDirectory=${spec.workingDir}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`
}

export type ServicePlan =
  | {
      platform: 'darwin'
      manager: 'launchd'
      path: string
      content: string
      install: string[]
      uninstall: string[]
      note?: string
    }
  | {
      platform: 'linux'
      manager: 'systemd'
      path: string
      content: string
      install: string[]
      uninstall: string[]
      note?: string
    }
  | { platform: 'unsupported'; detail: string }

export interface PlanDeps {
  platform?: NodeJS.Platform
  home?: string
  execPath?: string
  scriptPath?: string
}

/** Build the per-platform service plan. Pure given its deps. */
export function planService(configPath: string, deps: PlanDeps = {}): ServicePlan {
  const platform = deps.platform ?? process.platform
  const home = deps.home ?? homedir()
  const execPath = deps.execPath ?? process.execPath
  // cli.js sits next to this module (dist/service.js -> dist/cli.js).
  const scriptPath = deps.scriptPath ?? fileURLToPath(new URL('./cli.js', import.meta.url))
  const absConfig = resolve(configPath)
  const logPath = join(home, '.pulse', 'pulse.log')
  const spec: ServiceSpec = {
    execPath,
    scriptPath,
    configPath: absConfig,
    logPath,
    workingDir: dirname(absConfig),
  }

  if (platform === 'darwin') {
    const path = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    return {
      platform,
      manager: 'launchd',
      path,
      content: launchdPlist(spec),
      install: [`launchctl unload "${path}" 2>/dev/null || true`, `launchctl load -w "${path}"`],
      uninstall: [`launchctl unload -w "${path}" 2>/dev/null || true`],
    }
  }

  if (platform === 'linux') {
    const path = join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
    return {
      platform,
      manager: 'systemd',
      path,
      content: systemdUnit(spec),
      install: ['systemctl --user daemon-reload', `systemctl --user enable --now ${SYSTEMD_UNIT}`],
      uninstall: [`systemctl --user disable --now ${SYSTEMD_UNIT} 2>/dev/null || true`, 'systemctl --user daemon-reload'],
      note: 'For Pulse to start at boot (before you log in), run: loginctl enable-linger $USER',
    }
  }

  return { platform: 'unsupported', detail: `${platform} is not supported by \`pulse install\` (use launchd or systemd manually).` }
}

// ---------------------------------------------------------------------------
// performInstall / performUninstall — the side-effecting wrappers used by both
// the `pulse install` command and the setup wizard. They refuse to install
// before login (a service running `start` without a key would crash-loop), and
// on Linux they auto-run `loginctl enable-linger` so "starts on boot" works
// without a manual step.
// ---------------------------------------------------------------------------

export interface InstallResult {
  installed: boolean
  manager?: 'launchd' | 'systemd'
  path?: string
  messages: string[]
}

export interface PerformDeps extends PlanDeps {
  writeFile?: (p: string, data: string) => Promise<void>
  mkdir?: (p: string) => Promise<void>
  rm?: (p: string) => Promise<void>
  runCmd?: (cmd: string) => Promise<{ ok: boolean; error?: string }>
  isAuthenticated?: () => Promise<boolean>
  user?: string
}

async function defaultRunCmd(cmd: string): Promise<{ ok: boolean; error?: string }> {
  const { exec } = await import('node:child_process')
  const { promisify } = await import('node:util')
  try {
    await promisify(exec)(cmd, { shell: '/bin/sh' })
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

async function defaultIsAuthenticated(): Promise<boolean> {
  const { readFile } = await import('node:fs/promises')
  try {
    const creds = JSON.parse(await readFile(defaultCredentialsPath(), 'utf8')) as { key?: string }
    return Boolean(creds.key)
  } catch {
    return false
  }
}

export async function performInstall(configPath: string, deps: PerformDeps = {}): Promise<InstallResult> {
  const plan = planService(configPath, deps)
  if (plan.platform === 'unsupported') return { installed: false, messages: [plan.detail] }

  const isAuthed = deps.isAuthenticated ?? defaultIsAuthenticated
  if (!(await isAuthed())) {
    return {
      installed: false,
      messages: ['Not logged in. Run `pulse login` first — a service started without credentials would fail to send heartbeats.'],
    }
  }

  const runCmd = deps.runCmd ?? defaultRunCmd
  const writeFileFn = deps.writeFile ?? (async (p: string, data: string) => (await import('node:fs/promises')).writeFile(p, data, 'utf8'))
  const mkdirFn = deps.mkdir ?? (async (p: string) => { await (await import('node:fs/promises')).mkdir(p, { recursive: true }) })

  await mkdirFn(dirname(plan.path))
  await writeFileFn(plan.path, plan.content)
  const messages = [`Wrote ${plan.manager} service to ${plan.path}`]

  for (const cmd of plan.install) {
    const r = await runCmd(cmd)
    if (!r.ok) messages.push(`  (warning) command failed: ${cmd}\n  ${r.error}`)
  }

  // Linux: enable lingering so the user service starts at boot (pre-login).
  if (plan.platform === 'linux') {
    const user = deps.user ?? process.env.USER ?? ''
    const linger = await runCmd(`loginctl enable-linger ${user}`.trim())
    messages.push(
      linger.ok
        ? 'Enabled start-on-boot (loginctl enable-linger).'
        : `Couldn't enable start-on-boot automatically. For boot persistence run: sudo loginctl enable-linger ${user}`,
    )
  }

  messages.push('Pulse is running as a service. Logs: ~/.pulse/pulse.log — stop it with `pulse uninstall`.')
  return { installed: true, manager: plan.manager, path: plan.path, messages }
}

export async function performUninstall(configPath: string, deps: PerformDeps = {}): Promise<{ removed: boolean; messages: string[] }> {
  const plan = planService(configPath, deps)
  if (plan.platform === 'unsupported') return { removed: false, messages: [plan.detail] }

  const runCmd = deps.runCmd ?? defaultRunCmd
  const rmFn = deps.rm ?? (async (p: string) => (await import('node:fs/promises')).rm(p, { force: true }))

  for (const cmd of plan.uninstall) await runCmd(cmd)
  await rmFn(plan.path)
  return { removed: true, messages: [`Removed ${plan.manager} service (${plan.path}).`] }
}
