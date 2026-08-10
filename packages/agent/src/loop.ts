/**
 * Interval scheduling for the watch and heartbeat loops.
 *
 * `setInterval` fires on a fixed schedule regardless of whether the previous
 * run has finished, and an async callback is not awaited by it. For a watchdog
 * that is a real hazard rather than a theoretical one: a restart cycle sleeps
 * `n * baseBackoff` per attempt, so a few agents failing to come back can push
 * one tick past the interval. The next tick then starts while the first is
 * still restarting, both observe the same agent down, and both run its restart
 * command. Duplicate processes are the exact failure this tool exists to
 * prevent, so the loop must not be able to cause them itself.
 */

/** A tick that is already running swallows the next firing instead of racing it. */
export interface NonOverlappingOpts {
  /** Called when a firing is dropped because the previous run is still going. */
  onSkip?: () => void
}

export function nonOverlapping(
  tick: () => Promise<void>,
  opts: NonOverlappingOpts = {},
): () => void {
  let inFlight = false
  return () => {
    if (inFlight) {
      opts.onSkip?.()
      return
    }
    inFlight = true
    void tick()
      .catch(() => {
        // Swallowed deliberately: a throwing tick must never crash the daemon or
        // leave the guard stuck, which would silently stop the loop forever.
      })
      .finally(() => {
        inFlight = false
      })
  }
}
