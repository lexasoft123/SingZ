import type { PlaybackStatus } from './playback-status'

/** The part of a queue row the next-song rules need. */
export interface QueueSong { dir: string }

/** "Next" is the first queue entry after the current song, or the first entry when
 * the current song is not queued. Duplicate rows of the current song never count as
 * "next" (a queue that lists it twice would otherwise replay it). */
export function nextQueued<T extends QueueSong>(items: readonly T[], currentDir: string | null): T | null {
  const at = currentDir === null ? -1 : items.findIndex(item => item.dir === currentDir)
  for (let index = at + 1; index < items.length; index++) {
    if (items[index].dir !== currentDir) return items[index]
  }
  return null
}

/** Nothing is lost once the song has ended, so Next starts directly; mid-song it goes
 * through the same switch confirmation as choosing a song from the queue. */
export function nextNeedsConfirmation(status: PlaybackStatus): boolean {
  return status !== 'ended'
}

export type NextSlot = 'hidden' | 'next' | 'choose'

/** What the Next slot of the player bar offers: the next song, a way to pick one
 * once the song ended with nothing queued, or nothing. */
export function nextSlot(status: PlaybackStatus, hasNext: boolean): NextSlot {
  if (hasNext) return 'next'
  return status === 'ended' ? 'choose' : 'hidden'
}

/** Which player control takes focus when the song ends: Next when there is one,
 * otherwise Replay (the Play button). Never auto-advances; it only moves focus. */
export function endedFocusControl(hasNext: boolean): 'next-song' | 'play' {
  return hasNext ? 'next-song' : 'play'
}

/** Queue refs after Next starts `toDir`: the song that just played leaves the queue
 * (when it was in it), everything else keeps its order. Null when nothing changes. */
export function queueAfterAdvance<R>(refs: readonly R[], playedRef: R | null): R[] | null {
  if (playedRef === null || !refs.includes(playedRef)) return null
  return refs.filter(ref => ref !== playedRef)
}

/** Secondary line for "Next: title" / "Up next: title", artist appended when known. */
export function songLine(title: string, artist: string | null | undefined): string {
  return artist ? `${title} — ${artist}` : title
}

/** Switch-dialog wording for Next: it starts the target, and the song that just played
 * only leaves the queue when it was queued. */
export function nextSwitchMode(currentDir: string | null, items: readonly QueueSong[]): 'start' | 'advance' {
  return currentDir !== null && items.some(item => item.dir === currentDir) ? 'advance' : 'start'
}
