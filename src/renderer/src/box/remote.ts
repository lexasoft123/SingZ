export const REMOTE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'Enter', ' ', 'Escape', 'Backspace',
  'MediaPlayPause', 'MediaTrackPrevious', 'MediaTrackNext', 'Tab'
])

export interface RemoteKeyResult {
  consumed: boolean
  wake: boolean
  allowAction: boolean
}

export class RemoteKeyGate {
  private held = new Set<string>()
  private blocked = new Set<string>()

  get heldCount(): number {
    return new Set([...this.held, ...this.blocked]).size
  }

  get blocking(): boolean {
    return this.blocked.size > 0
  }

  keyDown(key: string, repeat: boolean, wakeRequired: boolean): RemoteKeyResult {
    if (!REMOTE_KEYS.has(key)) return { consumed: false, wake: false, allowAction: false }
    const wasHeld = this.held.has(key)
    const staleRepeat = repeat && !wasHeld
    this.held.add(key)
    if (wakeRequired || this.blocked.size > 0 || staleRepeat) {
      this.blocked.add(key)
      return { consumed: true, wake: wakeRequired, allowAction: false }
    }
    if (repeat && key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') {
      return { consumed: true, wake: false, allowAction: false }
    }
    return { consumed: true, wake: false, allowAction: true }
  }

  keyUp(key: string): boolean {
    if (!REMOTE_KEYS.has(key)) return false
    this.held.delete(key)
    this.blocked.delete(key)
    return true
  }

  recover(): void {
    for (const key of this.held) this.blocked.add(key)
    this.held.clear()
  }

  recoverFromFocusLoss(): void {
    this.reset()
  }

  reset(): void {
    this.held.clear()
    this.blocked.clear()
  }
}

export interface IdleState {
  playing: boolean
  visible: boolean
  playerActive: boolean
  overlayOpen: boolean
  hasLyrics: boolean
  documentVisible: boolean
}

export function shouldHideControls(state: IdleState, held: number, now: number, lastInput: number): boolean {
  return state.playing && state.visible && state.playerActive && !state.overlayOpen &&
    state.hasLyrics && state.documentVisible && held === 0 && now - lastInput >= 5000
}

export function lyricLineAt(lines: { start: number; end: number }[], position: number): number {
  const anticipated = position + 0.15
  for (let i = 0; i < lines.length; i++) {
    if (anticipated >= lines[i].start && (anticipated < lines[i].end || i === lines.length - 1)) return i
    if (anticipated < lines[i].start) return Math.max(0, i - 1)
  }
  return lines.length - 1
}

/** A fractional/early browser timer must not lose the idle deadline. */
export function scheduleControlsHide(
  read: () => { state: IdleState; held: number; lastInput: number },
  hide: () => void,
  now: () => number = () => performance.now()
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout>
  const schedule = (): void => {
    timer = setTimeout(check, Math.max(1, Math.ceil(5000 - (now() - read().lastInput))))
  }
  const check = (): void => {
    if (cancelled) return
    const current = read(), time = now()
    if (shouldHideControls(current.state, current.held, time, current.lastInput)) hide()
    else if (time - current.lastInput < 5000) schedule()
  }
  schedule()
  return () => { cancelled = true; clearTimeout(timer) }
}
