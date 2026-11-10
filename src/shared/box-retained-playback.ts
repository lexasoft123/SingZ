import type { BoxRetainedPlaybackSnapshot, BoxRetainedProjectDescriptor } from './box-contract'
import type { DesktopPlaybackLaneConfig, DesktopPlaybackStatus } from './types'

const DESCRIPTOR_BYTES = 1024 * 1024
const STATUS_BYTES = 8 * 1024 * 1024
const states = new Set(['unloaded', 'preparing', 'prepared', 'output-open', 'running', 'stopped', 'terminal', 'quarantined'])
const transports = new Set(['stopped', 'pre-roll', 'playing', 'paused', 'completed'])
const generation = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = (value: unknown, maximum = 4096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !value.includes('\0')
const hash = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function jsonClone(value: unknown, maximum: number): unknown {
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol' ||
        ArrayBuffer.isView(item) || item instanceof ArrayBuffer) throw new Error('Invalid retained control value.')
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Invalid retained number.')
    return item
  })
  if (json === undefined || new TextEncoder().encode(json).length > maximum) throw new Error('Retained control value is too large.')
  return JSON.parse(json)
}

function playbackStatus(value: unknown): BoxRetainedPlaybackSnapshot['playback'] {
  if (!object(value) || !generation(value.generation) || !states.has(value.state as string) || !transports.has(value.transportState as string))
    throw new Error('Invalid retained playback status.')
  return { generation: value.generation, state: value.state, transportState: value.transportState } as BoxRetainedPlaybackSnapshot['playback']
}

function lane(value: unknown): DesktopPlaybackLaneConfig {
  if (!exact(value, ['id', 'path', 'gain', 'muted', 'solo']) || !text(value.id, 96) || !text(value.path) ||
      !finite(value.gain) || value.gain < 0 || value.gain > 1 || typeof value.muted !== 'boolean' || typeof value.solo !== 'boolean')
    throw new Error('Invalid retained lane.')
  return { id: value.id, path: value.path, gain: value.gain, muted: value.muted, solo: value.solo }
}

export function retainedProjectDescriptor(value: unknown): BoxRetainedProjectDescriptor {
  const cloned = jsonClone(value, DESCRIPTOR_BYTES)
  if (!exact(cloned, ['version', 'project', 'config', 'lanes']) || cloned.version !== 1 ||
      !exact(cloned.project, ['dir', 'songPath', 'name', 'metadataHash', 'lyricsHash', 'graphHash', 'media']))
    throw new Error('Invalid retained project descriptor.')
  const project = cloned.project
  if (!text(project.dir) || !text(project.songPath) || !text(project.name, 512) || !hash(project.metadataHash) ||
      !(project.lyricsHash === null || hash(project.lyricsHash)) || !(project.graphHash === null || hash(project.graphHash)) ||
      !Array.isArray(project.media) || project.media.length < 1 || project.media.length > 16 ||
      !Array.isArray(cloned.lanes) || cloned.lanes.length !== project.media.length ||
      !object(cloned.config) || Object.hasOwn(cloned.config, 'retainedProject'))
    throw new Error('Invalid retained project identity.')
  const media = project.media.map(row => {
    if (!exact(row, ['id', 'path', 'size', 'mtimeMs']) || !text(row.id, 96) || !text(row.path) ||
        !generation(row.size) || !finite(row.mtimeMs) || row.mtimeMs < 0) throw new Error('Invalid retained media binding.')
    return { id: row.id, path: row.path, size: row.size, mtimeMs: row.mtimeMs }
  })
  const lanes = cloned.lanes.map(lane)
  const expected = media.map(row => row.id).sort()
  const actual = lanes.map(row => row.id).sort()
  if (new Set(actual).size !== actual.length || new Set(expected).size !== expected.length ||
      JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('Retained media and prepared lanes differ.')
  return cloned as BoxRetainedProjectDescriptor
}

function recovery(value: unknown): NonNullable<BoxRetainedPlaybackSnapshot['recovery']> {
  if (!exact(value, ['generation', 'descriptor', 'status']) || !generation(value.generation) || value.generation === '0' || !object(value.status))
    throw new Error('Invalid retained recovery.')
  const playback = playbackStatus(value.status)
  if (playback?.generation !== value.generation || playback.state === 'unloaded') throw new Error('Retained recovery generation mismatch.')
  const descriptor = retainedProjectDescriptor(value.descriptor)
  const status = jsonClone(value.status, STATUS_BYTES) as DesktopPlaybackStatus
  return { generation: value.generation, descriptor, status }
}

/** Project only the fields the retained-session TV controls actually use. */
export function retainedPlaybackSnapshot(value: unknown): BoxRetainedPlaybackSnapshot {
  if (!object(value)) throw new Error('Invalid retained audio snapshot.')
  if (!text(value.epoch, 128)) throw new Error('Invalid retained audio epoch.')
  const playback = value.playback === null ? null : playbackStatus(value.playback)
  if (!Object.hasOwn(value, 'recovery') || value.recovery === null || value.recovery === undefined) return { epoch: value.epoch, playback }
  if (!playback) throw new Error('Retained recovery has no playback.')
  const restored = recovery(value.recovery)
  if (restored.generation !== playback.generation) throw new Error('Retained recovery generation mismatch.')
  return { epoch: value.epoch, playback, recovery: restored }
}
