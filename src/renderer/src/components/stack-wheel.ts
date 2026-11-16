export type WheelAction = 'zoom' | 'pan' | 'scroll' | 'ignore'

/**
 * What a wheel gesture over the scrub overlay does. A mostly-vertical gesture over a stack that
 * scrolls (many lanes) is left to the browser; a zoom key zooms; otherwise it pans when zoomed.
 */
export function wheelAction(g: {
  zoomKey: boolean
  zoomed: boolean
  deltaX: number
  deltaY: number
  stackScrollable: boolean
}): WheelAction {
  if (g.zoomKey) return 'zoom'
  if (g.stackScrollable && Math.abs(g.deltaY) >= Math.abs(g.deltaX)) return 'scroll'
  return g.zoomed ? 'pan' : 'ignore'
}
