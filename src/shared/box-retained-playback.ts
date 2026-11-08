import type { BoxRetainedPlaybackSnapshot } from './box-contract'

/** Project only the fields the retained-session TV controls actually use. */
export function retainedPlaybackSnapshot(value: unknown): BoxRetainedPlaybackSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid retained audio snapshot.')
  const row = value as Record<string, unknown>
  if (typeof row.epoch !== 'string' || !row.epoch || row.epoch.length > 128) throw new Error('Invalid retained audio epoch.')
  if (row.playback === null) return { epoch: row.epoch, playback: null }
  if (!row.playback || typeof row.playback !== 'object' || Array.isArray(row.playback)) throw new Error('Invalid retained playback status.')
  const playback = row.playback as Record<string, unknown>
  if (typeof playback.generation !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(playback.generation) ||
      !['unloaded', 'preparing', 'prepared', 'output-open', 'running', 'stopped', 'terminal', 'quarantined'].includes(playback.state as string) ||
      !['stopped', 'pre-roll', 'playing', 'paused', 'completed'].includes(playback.transportState as string))
    throw new Error('Invalid retained playback status.')
  return { epoch: row.epoch, playback: { generation: playback.generation, state: playback.state, transportState: playback.transportState } as BoxRetainedPlaybackSnapshot['playback'] }
}
