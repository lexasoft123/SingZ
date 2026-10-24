import { useEffect } from 'react'
import { AppState } from 'react-native'

/** Keep the visible Drive shelf current without replacing it with a loading
 * screen. Native-stack focus survives an app background/foreground cycle, so
 * focus alone misses songs published while the phone was away. */
export function useLibraryRefresh(
  visible: boolean,
  drive: boolean,
  refresh: (force?: boolean) => Promise<void>
): void {
  useEffect(() => {
    if (!visible) return
    let state = AppState.currentState
    let running = false
    const update = async (): Promise<void> => {
      if (running || (drive && (state === 'background' || state === 'inactive'))) return
      running = true
      try {
        await refresh(drive)
      } finally {
        running = false
      }
    }
    void update()
    if (!drive) return
    const sub = AppState.addEventListener('change', next => {
      const resumed = next === 'active' && state !== 'active'
      state = next
      if (resumed) void update()
    })
    // A desktop can publish while the singer is already looking at this list.
    // Unchanged catalogs cost two metadata requests, with no audio downloads.
    const timer = setInterval(() => { void update() }, 60_000)
    return () => {
      sub.remove()
      clearInterval(timer)
    }
  }, [visible, drive, refresh])
}
