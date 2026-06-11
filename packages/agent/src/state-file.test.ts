import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeState, readState } from './state-file.js'

let dir: string, path: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pulse-')); path = join(dir, 'state.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('state-file', () => {
  it('writes then reads back', async () => {
    await writeState(path, { hermes: 'down' })
    expect(await readState(path)).toEqual({ hermes: 'down' })
  })
  it('missing file reads as empty object', async () => {
    expect(await readState(join(dir, 'nope.json'))).toEqual({})
  })
  it('corrupt file reads as empty object (no throw)', async () => {
    writeFileSync(path, '{ this is not json')
    expect(await readState(path)).toEqual({})
  })
  it('writes atomically: no leftover temp file remains', async () => {
    await writeState(path, { a: 'up' })
    expect(existsSync(path)).toBe(true)
    expect(readdirSync(dir).some(f => f !== 'state.json')).toBe(false)  // temp renamed away
  })
})
