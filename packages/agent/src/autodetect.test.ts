import { describe, it, expect } from 'vitest'
import {
  parseLaunchctlList,
  parseSystemctlUnits,
  parsePm2Jlist,
  launchdToService,
  systemdToService,
  pm2ToService,
  detectServices,
} from './autodetect.js'

describe('parseLaunchctlList', () => {
  it('keeps third-party labels and drops Apple/system + header', () => {
    const out = [
      'PID\tStatus\tLabel',
      '123\t0\tcom.apple.Safari',
      '456\t0\thomebrew.mxcl.postgresql',
      '-\t0\tapplication.com.foo',
      '789\t0\tcom.mycompany.api',
    ].join('\n')
    expect(parseLaunchctlList(out)).toEqual(['homebrew.mxcl.postgresql', 'com.mycompany.api'])
  })
})

describe('parseSystemctlUnits', () => {
  it('extracts unit names without the .service suffix', () => {
    const out = [
      'nginx.service        loaded active running A high performance web server',
      'postgresql.service   loaded active running PostgreSQL database server',
      'not-a-unit line',
    ].join('\n')
    expect(parseSystemctlUnits(out)).toEqual(['nginx', 'postgresql'])
  })
})

describe('parsePm2Jlist', () => {
  it('returns unique process names', () => {
    expect(parsePm2Jlist(JSON.stringify([{ name: 'api' }, { name: 'worker' }, { name: 'api' }]))).toEqual(['api', 'worker'])
  })
  it('returns [] on malformed json', () => {
    expect(parsePm2Jlist('not json')).toEqual([])
  })
})

describe('service mappers', () => {
  it('launchd uses a launchctl check + kickstart restart', () => {
    const s = launchdToService('com.mycompany.api')
    expect(s.name).toBe('api')
    expect(s.check).toEqual({ kind: 'command', value: 'launchctl list com.mycompany.api' })
    expect(s.restart).toContain('kickstart -k gui/$(id -u)/com.mycompany.api')
  })
  it('systemd uses is-active + restart', () => {
    const s = systemdToService('nginx')
    expect(s.check).toEqual({ kind: 'command', value: 'systemctl --user is-active nginx' })
    expect(s.restart).toBe('systemctl --user restart nginx')
  })
  it('pm2 uses a process check', () => {
    const s = pm2ToService('worker')
    expect(s.check).toEqual({ kind: 'process', value: 'worker' })
    expect(s.restart).toBe('pm2 restart worker')
  })
})

describe('detectServices', () => {
  it('combines systemd + pm2 on linux and de-dupes by name', async () => {
    const exec = async (cmd: string) => {
      if (cmd.startsWith('systemctl')) return 'nginx.service loaded active running web\nworker.service loaded active running w'
      if (cmd.startsWith('pm2')) return JSON.stringify([{ name: 'worker' }, { name: 'api' }])
      return null
    }
    const found = await detectServices({ platform: 'linux', exec })
    expect(found.map(s => s.name)).toEqual(['nginx', 'worker', 'api']) // worker not duplicated
    expect(found.find(s => s.name === 'worker')?.source).toBe('systemd') // native source wins
  })

  it('returns [] when nothing is detectable', async () => {
    expect(await detectServices({ platform: 'linux', exec: async () => null })).toEqual([])
  })
})
