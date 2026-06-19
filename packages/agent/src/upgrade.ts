import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// `pulse upgrade` — reinstall the latest published CLI globally. We shell out
// to npm rather than self-modifying so it works the same way the user
// originally installed it.
// ---------------------------------------------------------------------------

const PKG = '@waydock/pulse'

/** The argv we run. Pure + exported so it's assertable without spawning. */
export function upgradeCommand(): { cmd: string; args: string[] } {
  return { cmd: 'npm', args: ['install', '-g', `${PKG}@latest`] }
}

export interface UpgradeDeps {
  spawnFn?: typeof spawn
  log?: (msg: string) => void
}

/** Runs the global install, streaming npm's output. Resolves with its exit code. */
export async function upgrade(deps: UpgradeDeps = {}): Promise<number> {
  const spawnFn = deps.spawnFn ?? spawn
  const log = deps.log ?? ((m: string) => process.stdout.write(m))
  const { cmd, args } = upgradeCommand()

  log(`Upgrading: ${cmd} ${args.join(' ')}\n`)
  return new Promise<number>(resolve => {
    const child = spawnFn(cmd, args, { stdio: 'inherit' })
    child.on('error', err => {
      process.stderr.write(`Upgrade failed to start: ${(err as Error).message}\n`)
      resolve(1)
    })
    child.on('close', code => resolve(code ?? 0))
  })
}
