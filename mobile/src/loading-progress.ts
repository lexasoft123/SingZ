import type { FileProgress } from './file-download'

export type OpeningActivity = Exclude<FileProgress['phase'], 'checking'>

/** Card copy describes the opening stage, never an individual local stem. */
export function openingStatusKey(activity?: OpeningActivity) {
  switch (activity) {
    case 'connecting': return 'phone.library.openingConnect'
    case 'downloading': return 'phone.library.openingDownload'
    case 'verifying': return 'phone.library.openingVerify'
    case 'retrying': return 'phone.library.openingRetry'
    default: return 'phone.library.opening'
  }
}

/** Retried transfers may restart their byte counter; overall opening never goes backwards. */
export function openingFraction(previous: number, next: number): number {
  return Number.isFinite(next) ? Math.max(previous, Math.min(0.99, Math.max(0, next))) : previous
}

/** Two frames give React a paint opportunity. Background apps cannot depend on rAF. */
export function waitForProgressPaint(): Promise<void> {
  return new Promise(resolve => {
    let frame: ReturnType<typeof requestAnimationFrame>
    const done = () => {
      clearTimeout(timer)
      cancelAnimationFrame(frame)
      resolve()
    }
    const timer = setTimeout(done, 100)
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(done) })
  })
}

/** Keep fast load steps out of the render loop. Diagnostic steps and durable
 * breadcrumbs remain immediate; only the visual progress state is coalesced. */
export function createLoadingProgress<T>(
  publish: (value: T) => void,
  isCurrent: () => boolean,
  intervalMs = 100,
): { update(value: T): void; finish(value: T): void; stop(): void } {
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
    finish(value) {
      if (stopped || !isCurrent()) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = undefined
      stopped = true
      publish(value)
    },
    stop() {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      pending = undefined
    },
  }
}
