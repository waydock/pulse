import { describe, it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { runHttp, runCommand, runProcess, evaluateAgent } from './checks.js'

async function withServer(handler: (req: any, res: any) => void, fn: (url: string) => Promise<void>) {
  const srv = createServer(handler)
  await new Promise<void>(r => srv.listen(0, r))
  const port = (srv.address() as any).port
  try { await fn(`http://127.0.0.1:${port}/`) } finally { srv.close() }
}

describe('runHttp', () => {
  it('up on 2xx', async () => { await withServer((_q, s) => { s.writeHead(200); s.end('ok') }, async url => { expect(await runHttp({ http: url })).toBe(true) }) })
  it('down on 5xx', async () => { await withServer((_q, s) => { s.writeHead(503); s.end() }, async url => { expect(await runHttp({ http: url })).toBe(false) }) })
  it('down on connection refused', async () => { expect(await runHttp({ http: 'http://127.0.0.1:1/' })).toBe(false) })
})

describe('runCommand', () => {
  it('up on exit 0', async () => { expect(await runCommand({ command: 'true' })).toBe(true) })
  it('down on exit 1', async () => { expect(await runCommand({ command: 'false' })).toBe(false) })
  it('down on a nonexistent command', async () => { expect(await runCommand({ command: 'this-cmd-does-not-exist-xyz' })).toBe(false) })
})

describe('runProcess', () => {
  it('uses the injected lister: up when the name matches a running process', async () => {
    const list = vi.fn(async () => ['ai.hermes.gateway', 'node'])
    expect(await runProcess({ process: 'hermes' }, list)).toBe(true)   // substring match
    expect(await runProcess({ process: 'openclaw' }, list)).toBe(false)
  })
})

describe('evaluateAgent', () => {
  it('up iff ALL checks pass', async () => {
    const pass = { command: 'true' as const }
    const fail = { command: 'false' as const }
    expect(await evaluateAgent([pass, pass])).toBe(true)
    expect(await evaluateAgent([pass, fail])).toBe(false)
  })
})
