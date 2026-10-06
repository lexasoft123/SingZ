/** Breakpoints use available window space, never device identity or orientation. */
export function mobileLayout(width: number, height: number, fontScale = 1) {
  const wide = width >= 700 * Math.max(1, fontScale)
  return {
    wide,
    compact: width >= 600 * Math.max(1, fontScale) || height < 600,
    contentWidth: Math.min(width, 1120),
    playerDockWidth: Math.min(Math.max(0, width - 20), 680)
  }
}

/** Height is measured inside the route, after safe areas, header and tabs. */
export function trainingBodyLayout(availableHeight: number, wide: boolean, fontScale = 1) {
  return { compact: !wide && availableHeight < 620 * Math.max(1, fontScale) }
}
