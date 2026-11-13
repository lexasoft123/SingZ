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

/** One rule for the "start another song" actions (Sing, Next; a queue pick always asks): ask whenever a
 * different song is loaded and has not ended (playing or paused), so a paused place is never
 * lost silently. Nothing loaded, or a song that ended, switches without a question. */
export function switchNeedsConfirmation(hasLoadedSong: boolean, status: PlaybackStatus): boolean {
  return hasLoadedSong && status !== 'ended'
}

export type NextSlot = 'next' | 'disabled'

/** What the Next slot of the player bar offers. The button always exists: enabled
 * when there is a next song, disabled when there is none, in every playback status
 * (including after the song ended). */
export function nextSlot(_status: PlaybackStatus, hasNext: boolean): NextSlot {
  return hasNext ? 'next' : 'disabled'
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
