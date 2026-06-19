import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

// ---------------------------------------------------------------------------
// Version lookup + a best-effort "update available" notifier, modelled on what
// gh / vercel / fly do: check the registry at most once a day, cache the
// result, and print an unobtrusive note to stderr (never stdout, so `--json`
// output stays clean).
// ---------------------------------------------------------------------------

// dist/version.js and src/version.ts both sit one level under packages/agent,
// so ../package.json resolves correctly whether running compiled or under vitest.
export async function getVersion(): Promise<string> {
  const url = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(await readFile(url, 'utf8')) as { version: string }
  return pkg.version
}

/** numeric major.minor.patch compare — returns true when `latest` > `current`. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

const PKG = '@waydock/pulse'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface UpdateCheckDeps {
  fetch?: typeof globalThis.fetch
  now?: () => number
  cachePath?: string
  readCache?: (p: string) => Promise<string>
  writeCache?: (p: string, data: string) => Promise<void>
}

type Cache = { checkedAt: number; latest: string }

/**
 * Returns the latest version string if a newer one is available, else null.
 * Uses a 24h on-disk cache so only one network call happens per day; all
 * failures (offline, registry down, malformed cache) resolve to null.
 */
export async function checkForUpdate(current: string, deps: UpdateCheckDeps = {}): Promise<string | null> {
  const now = deps.now ?? Date.now
  const cachePath = deps.cachePath ?? join(homedir(), '.pulse', 'update-check.json')
  const fetchFn = deps.fetch ?? globalThis.fetch
  const readCacheFn = deps.readCache ?? ((p: string) => readFile(p, 'utf8'))
  const writeCacheFn =
    deps.writeCache ??
    (async (p: string, data: string) => {
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, data, 'utf8')
    })

  let latest: string | undefined

  // 1. Fresh cache short-circuits the network call.
  try {
    const cache = JSON.parse(await readCacheFn(cachePath)) as Cache
    if (now() - cache.checkedAt < ONE_DAY_MS) latest = cache.latest
  } catch {
    // no/!valid cache — fall through to a network check
  }

  // 2. Otherwise ask the registry (best-effort, short timeout) and refresh cache.
  if (latest === undefined) {
    try {
      const res = await fetchFn(`https://registry.npmjs.org/${PKG}/latest`, {
        signal: AbortSignal.timeout(2000),
      })
      const data = (await res.json()) as { version?: string }
      if (!data.version) return null
      latest = data.version
      await writeCacheFn(cachePath, JSON.stringify({ checkedAt: now(), latest } satisfies Cache)).catch(() => {})
    } catch {
      return null
    }
  }

  return isNewer(latest, current) ? latest : null
}

/** Print an unobtrusive upgrade note to stderr. Never throws. */
export async function notifyIfUpdate(current: string, deps: UpdateCheckDeps = {}): Promise<void> {
  try {
    const latest = await checkForUpdate(current, deps)
    if (latest) {
      process.stderr.write(
        `\nUpdate available: ${current} → ${latest}. Run \`pulse upgrade\` (or \`npm i -g ${PKG}@latest\`).\n`,
      )
    }
  } catch {
    // never let the notifier affect the command
  }
}
