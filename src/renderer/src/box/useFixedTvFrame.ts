import { useLayoutEffect, useState, type RefObject } from 'react'

export function useFixedTvFrame(ref: RefObject<HTMLElement | null>): { scale: number; left: number; top: number } {
  const [frame, setFrame] = useState({ scale: 1, left: 0, top: 0 })
  // Layout effect: measure before first paint so a 4K TV never flashes scale 1 at 0,0.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const update = (): void => {
      const scale = Math.max(0.01, Math.min(element.clientWidth / 1600, element.clientHeight / 900))
      setFrame({
        scale,
        left: (element.clientWidth - 1600 * scale) / 2,
        top: (element.clientHeight - 900 * scale) / 2
      })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return frame
}
