/** UIKit modal occlusion does not change intersection or audio playback. */
export function lyricPaintAllowed(): boolean {
  return !document.hidden && !document.body.classList.contains('modal-open')
}

export function watchLyricPaint(root: HTMLElement | null, playing: boolean, paint: (time: number) => void, refresh: () => void): () => void {
  let frame = 0, visible = true, disposed = false
  const stop = (): void => { cancelAnimationFrame(frame); frame = 0 }
  const tick = (time: number): void => {
    frame = 0
    if (disposed || !visible || !lyricPaintAllowed()) return
    paint(time)
    frame = requestAnimationFrame(tick)
  }
  const resume = (): void => {
    stop()
    if (disposed || !visible || !lyricPaintAllowed()) return
    refresh()
    if (playing) frame = requestAnimationFrame(tick)
  }
  const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting); resume()
  })
  if (root) intersection?.observe(root)
  const modal = new MutationObserver(resume)
  modal.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  document.addEventListener('visibilitychange', resume)
  resume()
  return () => {
    disposed = true; stop(); intersection?.disconnect(); modal.disconnect()
    document.removeEventListener('visibilitychange', resume)
  }
}

/** The outer 4K transform commits after the window resize handler. */
export function watchLyricTransform(root: HTMLElement | null, measure: () => void): () => void {
  const tv = root?.closest('.box-tv')
  if (!tv) return () => {}
  let disposed = false
  const observer = new MutationObserver(() => { if (!disposed && lyricPaintAllowed()) measure() })
  observer.observe(tv, { attributes: true, attributeFilter: ['style'] })
  return () => { disposed = true; observer.disconnect() }
}
