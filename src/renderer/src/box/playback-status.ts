import type { BoxTransportSnapshot } from './transport'

export type PlaybackStatus = 'playing' | 'paused' | 'ended' | 'error'

type StatusInput = Pick<BoxTransportSnapshot, 'playing' | 'position' | 'duration' | 'playbackError' | 'outputError' | 'saveError'>

/** The one place that decides what the song is doing. Player, queue and mixer all show this. */
export function playbackStatus(snapshot: StatusInput): PlaybackStatus {
  if (snapshot.playbackError || snapshot.outputError || snapshot.saveError) return 'error'
  if (snapshot.playing) return 'playing'
  if (snapshot.duration > 0 && snapshot.position >= snapshot.duration - 0.01) return 'ended'
  return 'paused'
}

export const playbackStatusKey = {
  playing: 'box.status.playing',
  paused: 'box.status.paused',
  ended: 'box.status.ended',
  error: 'box.status.error'
} as const satisfies Record<PlaybackStatus, string>
