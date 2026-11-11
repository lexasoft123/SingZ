/** A native poll failure must not become an uncaught exception in the headless
 *  host. Keep polling (native code throttles its own retries) and log at most
 *  one report per interval, counting suppressed repeats. */
export function boxRoutingPollTick(poll: () => void, warn: (message: string) => void = console.warn,
  now: () => number = Date.now, intervalMs = 10_000): () => void {
  let lastReport = -Infinity
  let suppressed = 0
  return () => {
    try { poll() } catch (error) {
      const time = now()
      if (time - lastReport < intervalMs) { ++suppressed; return }
      warn(`Box routing poll failed: ${String(error).slice(0, 500)}${suppressed ? ` (${suppressed} similar failures suppressed)` : ''}`)
      lastReport = time
      suppressed = 0
    }
  }
}
