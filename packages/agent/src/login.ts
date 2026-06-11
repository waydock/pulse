import { writeFile, mkdir, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'

export interface LoginDeps {
  fetch?: typeof globalThis.fetch
  openBrowser?: (url: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
  log?: (...a: any[]) => void
}

function defaultOpenBrowser(url: string): Promise<void> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'darwin' ? 'open'
              : process.platform === 'win32'  ? 'start'
              : 'xdg-open'
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true })
    child.unref()
    child.on('error', () => {}) // best-effort
    resolve()
  })
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms))

export async function login(opts: {
  base: string
  hostname: string
  credentialsPath?: string
  deps?: LoginDeps
}): Promise<void> {
  const { base, hostname } = opts
  const credentialsPath = opts.credentialsPath ?? join(homedir(), '.pulse', 'credentials.json')
  const {
    fetch: fetchFn = globalThis.fetch,
    openBrowser = defaultOpenBrowser,
    sleep = defaultSleep,
    log = console.log,
  } = opts.deps ?? {}

  // Step 1: request device code
  const deviceResp = await fetchFn(`${base}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'pulse-cli', hostname }),
  })
  const deviceData = await deviceResp.json() as {
    device_code: string
    user_code: string
    verification_uri: string
    verification_uri_complete: string
    expires_in: number
    interval: number
  }

  const { device_code, user_code, verification_uri, verification_uri_complete, interval } = deviceData

  // Step 2: display user code and open browser
  log(`\nTo authorize this machine, visit ${verification_uri} and enter:\n\n    ${user_code}\n`)
  try {
    await openBrowser(verification_uri_complete)
  } catch {
    // best-effort: swallow browser open errors
  }

  // Step 3: poll for token
  let intervalMs = interval * 1000
  let token: string | undefined

  while (true) {
    const pollResp = await fetchFn(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
        client_id: 'pulse-cli',
      }),
    })
    const pollData = await pollResp.json() as { token?: string; error?: string }

    if (pollData.token) {
      token = pollData.token
      break
    }

    const error = pollData.error ?? 'unknown'

    if (error === 'authorization_pending') {
      await sleep(intervalMs)
    } else if (error === 'slow_down') {
      intervalMs += 5000
      await sleep(intervalMs)
    } else {
      throw new Error(`device authorization failed: ${error}`)
    }
  }

  // Step 4: write credentials with mode 0600
  const json = JSON.stringify({ key: token }, null, 2)
  await mkdir(dirname(credentialsPath), { recursive: true })
  await writeFile(credentialsPath, json, { mode: 0o600 })
  // chmod explicitly in case umask masked the mode on create
  await chmod(credentialsPath, 0o600)
}
