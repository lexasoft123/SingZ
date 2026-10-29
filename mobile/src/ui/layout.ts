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

/** Keep both the mixer faders and a readable lyric column when sharing space.
 * Short windows need that space for the transport instead. These are scene
 * dimensions, so split-screen windows follow the same rules as phones. */
export function playerWorkspaceLayout(width: number, height: number, fontScale = 1) {
  const scale = Math.max(1, fontScale)
  const workspaceWidth = Math.min(width, 1440)
  const sideBySide = workspaceWidth >= 900 * scale && height >= 500 * scale
  const mixerWidth = sideBySide ? Math.min(440, Math.max(360, workspaceWidth * 0.36)) : 0
  return {
    sideBySide,
    workspaceWidth,
    mixerWidth,
    lyricsWidth: sideBySide ? workspaceWidth - mixerWidth - 36 : Math.min(width, 780),
    dockWidth: Math.min(Math.max(0, workspaceWidth - 24), sideBySide ? 780 : 680)
  }
}

/** Height is measured inside the route, after safe areas, header and tabs. */
export function trainingBodyLayout(availableHeight: number, wide: boolean, fontScale = 1) {
  return { compact: !wide && availableHeight < 620 * Math.max(1, fontScale) }
}
