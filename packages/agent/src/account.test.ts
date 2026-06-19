import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maskKey, formatWhoami, readWhoami, logout } from './account.js'

describe('maskKey', () => {
  it('shows a recognisable fingerprint without leaking the key', () => {
    expect(maskKey('abcdef0123456789xyz')).toBe('abcdef…9xyz')
  })
  it('fully masks short keys', () => {
    expect(maskKey('short')).toBe('*****')
  })
})

describe('formatWhoami', () => {
  it('prompts to log in when unauthenticated', () => {
    expect(formatWhoami({ authenticated: false, credentialsPath: '/c' })).toMatch(/pulse login/)
  })
  it('summarises auth state with node + ingest host', () => {
    const out = formatWhoami({
      authenticated: true,
      keyFingerprint: 'abc123…wxyz',
      credentialsPath: '/c',
      node: 'app-1',
      ingestHost: 'ingest.waydock.ai',
    })
    expect(out).toMatch(/Logged in \(key abc123…wxyz\)/)
    expect(out).toMatch(/Node: app-1/)
    expect(out).toMatch(/Reporting to: ingest.waydock.ai/)
  })
})

describe('readWhoami / logout', () => {
  it('reports unauthenticated when no credentials file exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-acct-'))
    try {
      const info = await readWhoami({ credentialsPath: join(dir, 'credentials.json') })
      expect(info.authenticated).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads the key + config meta when authenticated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-acct-'))
    try {
      const credPath = join(dir, 'credentials.json')
      writeFileSync(credPath, JSON.stringify({ key: 'secrettoken-abcdef-1234' }))
      const info = await readWhoami({
        credentialsPath: credPath,
        readConfigMeta: async () => ({ node: 'n1', ingestHost: 'ingest.example.com' }),
      })
      expect(info.authenticated).toBe(true)
      expect(info.keyFingerprint).toBe('secret…1234')
      expect(info.node).toBe('n1')
      expect(info.ingestHost).toBe('ingest.example.com')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('logout removes the credentials file and reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pulse-acct-'))
    try {
      const credPath = join(dir, 'credentials.json')
      writeFileSync(credPath, JSON.stringify({ key: 'k' }))
      const r1 = await logout({ credentialsPath: credPath })
      expect(r1.removed).toBe(true)
      expect(existsSync(credPath)).toBe(false)
      const r2 = await logout({ credentialsPath: credPath })
      expect(r2.removed).toBe(false) // idempotent
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
