/** Keep fast load steps out of the render loop. Diagnostic steps and durable
 * breadcrumbs remain immediate; only the visual progress state is coalesced. */
export function createLoadingProgress<T>(
  publish: (value: T) => void,
  isCurrent: () => boolean,
  intervalMs = 100,
): { update(value: T): void; stop(): void } {
  let pending: { value: T } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  return {
    update(value) {
      if (stopped || !isCurrent()) return
      pending = { value }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        const latest = pending
        pending = undefined
        if (!stopped && isCurrent() && latest) publish(latest.value)
      }, intervalMs)
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = undefined
    },
  }
}
