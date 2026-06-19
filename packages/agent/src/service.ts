import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

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
  return `[Unit]
Description=Pulse watcher (waydock-pulse)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${exec}
Restart=always
RestartSec=5
WorkingDirectory=${spec.workingDir}

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
