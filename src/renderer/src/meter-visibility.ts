import { useEffect, useState } from 'react'

/** Only visible meters animate. Modal coverage is opt-in for surfaces behind dialogs. */
export function useMeterVisibility(visible = true, behindModal = false): boolean {
  const read = (): boolean => typeof document === 'undefined' || (!document.hidden && (!behindModal || !document.body.classList.contains('modal-open')))
  const [showing, setShowing] = useState(read)
  useEffect(() => {
    const update = (): void => setShowing(read())
    document.addEventListener('visibilitychange', update)
    const observer = behindModal ? new MutationObserver(update) : null
    observer?.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    update()
    return () => { document.removeEventListener('visibilitychange', update); observer?.disconnect() }
  }, [behindModal])
  return visible && showing
}
