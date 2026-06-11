import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Read persisted agent state from disk.
 * Returns {} on missing file, corrupt JSON, or any other error — never throws.
 */
export async function readState(path: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * Write agent state to disk atomically:
 * write to a temp file (path.<pid>.tmp), then rename into place.
 * Creates parent directories if missing.
 */
export async function writeState(path: string, state: Record<string, string>): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, path)
}
