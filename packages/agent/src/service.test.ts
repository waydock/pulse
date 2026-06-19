import { describe, it, expect } from 'vitest'
import { launchdPlist, systemdUnit, planService, performInstall, performUninstall, LAUNCHD_LABEL, SYSTEMD_UNIT, type ServiceSpec, type PerformDeps } from './service.js'

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

describe('performInstall', () => {
  const baseDeps = (over: Partial<PerformDeps> = {}): PerformDeps => {
    const ran: string[] = []
    const written: string[] = []
    return {
      platform: 'linux', home: '/home/u', execPath: '/n', scriptPath: '/s/cli.js', user: 'u',
      isAuthenticated: async () => true,
      mkdir: async () => {},
      writeFile: async (p: string) => { written.push(p) },
      runCmd: async (cmd: string) => { ran.push(cmd); return { ok: true } },
      // expose captured state for assertions
      ...({ _ran: ran, _written: written } as any),
      ...over,
    }
  }

  it('refuses to install when not authenticated', async () => {
    const r = await performInstall('./c.yaml', baseDeps({ isAuthenticated: async () => false }))
    expect(r.installed).toBe(false)
    expect(r.messages.join(' ')).toMatch(/pulse login/)
  })

  it('refuses on unsupported platforms', async () => {
    const r = await performInstall('./c.yaml', baseDeps({ platform: 'win32' }))
    expect(r.installed).toBe(false)
  })

  it('writes the unit, runs install commands, and auto-enables linger on linux', async () => {
    const ran: string[] = []
    const r = await performInstall('./c.yaml', {
      platform: 'linux', home: '/home/u', execPath: '/n', scriptPath: '/s/cli.js', user: 'u',
      isAuthenticated: async () => true,
      mkdir: async () => {},
      writeFile: async () => {},
      runCmd: async (cmd: string) => { ran.push(cmd); return { ok: true } },
    })
    expect(r.installed).toBe(true)
    expect(ran).toContain('systemctl --user daemon-reload')
    expect(ran.some(c => c.includes('enable --now'))).toBe(true)
    expect(ran).toContain('loginctl enable-linger u') // auto-linger, no manual step
    expect(r.messages.some(m => /start-on-boot/i.test(m))).toBe(true)
  })

  it('surfaces a sudo hint when linger cannot be enabled automatically', async () => {
    const r = await performInstall('./c.yaml', {
      platform: 'linux', home: '/home/u', execPath: '/n', scriptPath: '/s/cli.js', user: 'u',
      isAuthenticated: async () => true,
      mkdir: async () => {}, writeFile: async () => {},
      runCmd: async (cmd: string) => (cmd.startsWith('loginctl') ? { ok: false, error: 'denied' } : { ok: true }),
    })
    expect(r.installed).toBe(true)
    expect(r.messages.some(m => /sudo loginctl enable-linger u/.test(m))).toBe(true)
  })

  it('does not enable linger on macOS (launchd RunAtLoad handles it)', async () => {
    const ran: string[] = []
    await performInstall('./c.yaml', {
      platform: 'darwin', home: '/home/u', execPath: '/n', scriptPath: '/s/cli.js',
      isAuthenticated: async () => true,
      mkdir: async () => {}, writeFile: async () => {},
      runCmd: async (cmd: string) => { ran.push(cmd); return { ok: true } },
    })
    expect(ran.some(c => c.includes('loginctl'))).toBe(false)
    expect(ran.some(c => c.includes('launchctl load'))).toBe(true)
  })
})

describe('performUninstall', () => {
  it('runs uninstall commands and removes the unit file', async () => {
    const ran: string[] = []
    let removed = ''
    const r = await performUninstall('./c.yaml', {
      platform: 'linux', home: '/home/u', execPath: '/n', scriptPath: '/s/cli.js',
      runCmd: async (cmd: string) => { ran.push(cmd); return { ok: true } },
      rm: async (p: string) => { removed = p },
    })
    expect(r.removed).toBe(true)
    expect(ran.some(c => c.includes('disable --now'))).toBe(true)
    expect(removed).toBe(`/home/u/.config/systemd/user/${SYSTEMD_UNIT}`)
  })
})
