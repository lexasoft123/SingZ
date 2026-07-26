import { app, screen, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

const MIN_W = 940
const MIN_H = 600

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json')
}

/**
 * Last session's bounds, clamped into whichever display they best match —
 * a window saved on a disconnected monitor must not restore off-screen.
 */
export function loadWindowState(defaults: { width: number; height: number }): WindowState {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState
    if (!Number.isFinite(s.width) || !Number.isFinite(s.height)) return defaults
    const area = screen.getDisplayMatching({
      x: s.x ?? 0,
      y: s.y ?? 0,
      width: s.width,
      height: s.height
    }).workArea
    const width = Math.min(Math.max(MIN_W, Math.round(s.width)), area.width)
    const height = Math.min(Math.max(MIN_H, Math.round(s.height)), area.height)
    const out: WindowState = { width, height, maximized: Boolean(s.maximized) }
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      out.x = Math.min(Math.max(area.x, Math.round(s.x as number)), area.x + area.width - width)
      out.y = Math.min(Math.max(area.y, Math.round(s.y as number)), area.y + area.height - height)
    }
    return out
  } catch {
    return defaults
  }
}

/** Debounced persistence of bounds + maximized flag across the window's life. */
export function trackWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const save = (): void => {
    if (win.isDestroyed()) return
    const maximized = win.isMaximized()
    const b = maximized ? win.getNormalBounds() : win.getBounds()
    try {
      writeFileSync(stateFile(), JSON.stringify({ ...b, maximized }))
    } catch {
      /* a failed save must never break the window */
    }
  }
  const later = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  win.on('resize', later)
  win.on('move', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('close', save)
}
