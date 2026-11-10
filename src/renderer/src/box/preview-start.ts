import type { LatestOpenIntent } from './open-intent'

/** Release the phone's opening guard synchronously before publishing cancellation. */
export function cancelPreviewStart(
  intent: LatestOpenIntent,
  pending: { current: number | null },
  openingDir: { current: string | null },
  clearBusy: () => void,
  publish: () => Promise<boolean>
): boolean {
  if (pending.current === null || !intent.isCurrent(pending.current)) return false
  intent.cancel()
  pending.current = null
  openingDir.current = null
  clearBusy()
  void publish()
  return true
}
