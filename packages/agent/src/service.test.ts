import { describe, it, expect } from 'vitest'
import { launchdPlist, systemdUnit, planService, LAUNCHD_LABEL, SYSTEMD_UNIT, type ServiceSpec } from './service.js'

const spec: ServiceSpec = {
  execPath: '/usr/local/bin/node',
  scriptPath: '/opt/pulse/dist/cli.js',
  configPath: '/etc/pulse.config.yaml',
  logPath: '/home/u/.pulse/pulse.log',
  workingDir: '/etc',
}

describe('launchdPlist', () => {
  it('embeds the start command, config, keepalive and log paths', () => {
    const plist = launchdPlist(spec)
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`)
    expect(plist).toContain('<string>start</string>')
    expect(plist).toContain('<string>--quiet</string>')
    expect(plist).toContain('<string>/etc/pulse.config.yaml</string>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('/home/u/.pulse/pulse.log')
  })
})

describe('systemdUnit', () => {
  it('builds an ExecStart with Restart=always and user target', () => {
    const unit = systemdUnit(spec)
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/pulse/dist/cli.js start --quiet --config /etc/pulse.config.yaml')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('WantedBy=default.target')
  })
})

describe('planService', () => {
  const common = { home: '/home/u', execPath: '/n', scriptPath: '/s/cli.js' }

  it('plans a launchd agent on macOS', () => {
    const plan = planService('./pulse.config.yaml', { platform: 'darwin', ...common })
    expect(plan.platform).toBe('darwin')
    if (plan.platform !== 'darwin') throw new Error('wrong platform')
    expect(plan.path).toBe('/home/u/Library/LaunchAgents/ai.waydock.pulse.plist')
    expect(plan.install.some(c => c.includes('launchctl load -w'))).toBe(true)
    expect(plan.uninstall.some(c => c.includes('launchctl unload'))).toBe(true)
  })

  it('plans a systemd user unit on Linux with a linger note', () => {
    const plan = planService('./pulse.config.yaml', { platform: 'linux', ...common })
    expect(plan.platform).toBe('linux')
    if (plan.platform !== 'linux') throw new Error('wrong platform')
    expect(plan.path).toBe(`/home/u/.config/systemd/user/${SYSTEMD_UNIT}`)
    expect(plan.install).toContain('systemctl --user daemon-reload')
    expect(plan.install.some(c => c.includes('enable --now'))).toBe(true)
    expect(plan.note).toMatch(/enable-linger/)
  })

  it('reports unsupported platforms instead of guessing', () => {
    const plan = planService('./pulse.config.yaml', { platform: 'win32', ...common })
    expect(plan.platform).toBe('unsupported')
  })

  it('resolves the config path to absolute in the plan content', () => {
    const plan = planService('./pulse.config.yaml', { platform: 'linux', ...common })
    if (plan.platform !== 'linux') throw new Error('wrong platform')
    expect(plan.content).toMatch(/--config \/.*pulse\.config\.yaml/)
  })
})
