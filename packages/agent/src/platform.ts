// ---------------------------------------------------------------------------
// Platform support gate. Pulse's checks/restarts rely on POSIX tooling (`ps`,
// `/bin/sh`), so the commands that exercise them only work on macOS and Linux.
// Rather than let those silently report everything as down on Windows, the
// affected commands fail loudly with this message. (Windows support is a
// separate, larger port — tracked for later.)
// ---------------------------------------------------------------------------

export const SUPPORTED_PLATFORMS: NodeJS.Platform[] = ['darwin', 'linux']

export const UNSUPPORTED_MESSAGE =
  'Pulse currently supports macOS and Linux only. Windows is not supported yet ' +
  '(checks and restarts rely on `ps` / `/bin/sh`).'

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_PLATFORMS.includes(platform)
}

/** Exit with a clear message on unsupported platforms; no-op otherwise. */
export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (!isSupportedPlatform(platform)) {
    process.stderr.write(UNSUPPORTED_MESSAGE + '\n')
    process.exit(1)
  }
}
