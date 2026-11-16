/** Native lane measurements provide duration and waveforms without a playback decode.
 * Offline analysis and editor decodes remain separate callers. */
import type { DesktopPlaybackLaneMeasureRequest, SingzApi } from '../../../shared/types'
import { LANE_ENVELOPE_BUCKETS, laneEnvelope } from './lane-envelope'
import { detectedDesktopPlatform } from './native-playback-preference'
import {
  PEAKS_MAXIMUM,
  PEAKS_MINIMUM,
  PEAKS_PER_SECOND,
  computePeaks,
  normalizePeaks
} from './peaks'

/** A lane's drawing statistics and length, however they were obtained. */
export interface LaneRead {
  duration: number
  /** Normalized for drawing, `scale` beside it — see normalizePeaks. */
  peaks: Float32Array
  scale: number
  /** The phones' seek-bar envelope, saved into project.json. */
  envelope: number[]
  /** Whole-lane RMS: the silent guitar/piano test. */
  rms: number
  /** Chromium's decode when this lane was decoded; null when the core
   *  measured it and nothing in the renderer holds its samples. */
  buffer: AudioBuffer | null
}

/** A lane whose RMS is under this is hidden when it is a guitar or piano lane. */
export const SILENT_LANE_RMS = 0.004

/**
 * The silent-lane test as the decode path has always taken it: channel 0,
 * every `step`th sample. The measured path reads every sample of every
 * channel; both are "is there anything here at all", and a lane that is
 * silent is silent either way.
 */
export function sampledRms(buffer: AudioBuffer): number {
  if (buffer.length === 0 || buffer.numberOfChannels === 0) return 0
  const data = buffer.getChannelData(0)
  let energy = 0
  const step = Math.max(1, Math.floor(data.length / 200000))
  let n = 0
  for (let j = 0; j < data.length; j += step) {
    energy += data[j] * data[j]
    n++
  }
  return Math.sqrt(energy / Math.max(1, n))
}

export function laneReadFromBuffer(buffer: AudioBuffer): LaneRead {
  const { peaks, scale } = computePeaks(buffer)
  return {
    duration: buffer.duration,
    peaks,
    scale,
    envelope: laneEnvelope(buffer),
    rms: sampledRms(buffer),
    buffer
  }
}

export interface LaneEntry {
  id: string
  path: string
}

/** What the measure talks to: the preload API, and the platform the
 *  decision is made for — detected, unless a test says otherwise. */
export interface LaneMeasureHost {
  api: Pick<SingzApi, 'desktopPlaybackCapability' | 'measureDesktopPlaybackLanes'>
  platform?: ReturnType<typeof detectedDesktopPlatform>
  /** Admission over the complete song, shared by each partial lane read. */
  applies?: boolean
}

const liveHost = (): LaneMeasureHost => ({ api: window.singz })

/** Load one capability snapshot for admission of required or optional lanes. */
async function laneAdmissionSelector(host: LaneMeasureHost): Promise<
  (lanes: LaneEntry[]) => import('./desktop-native-playback').DesktopPlaybackBackendDecision
> {
  const platform = host.platform ?? detectedDesktopPlatform()
  const { DesktopNativePlaybackError, selectDesktopPlaybackBackend } = await import('./desktop-native-playback')
  let runtime
  try { runtime = await host.api.desktopPlaybackCapability() }
  catch (error) { throw new DesktopNativePlaybackError('addon-unavailable', String(error)) }
  return lanes => selectDesktopPlaybackBackend(platform, {
    playbackRate: 1,
    transpose: 0,
    training: null,
    lanes,
    runtime,
    requestedProvider: platform === 'win32' ? undefined : platform === 'linux' ? 'alsa' : 'coreaudio'
  })
}

/** Required song lanes must be admitted; an unsupported stem blocks opening. */
export async function desktopLaneMeasureApplies(
  lanes: LaneEntry[],
  host: LaneMeasureHost = liveHost()
): Promise<boolean> {
  const decision = (await laneAdmissionSelector(host))(lanes)
  if (decision.backend !== 'native') throw Object.assign(new Error(decision.reason), { failure: decision.failure })
  return true
}

/** The measure's request for these lanes, at the renderer's own peak policy. */
export function laneMeasureRequest(lanes: LaneEntry[]): DesktopPlaybackLaneMeasureRequest {
  return {
    lanes: lanes.map(({ id, path }) => ({ id, path })),
    peaksPerSecond: PEAKS_PER_SECOND,
    minimumPeaks: PEAKS_MINIMUM,
    maximumPeaks: PEAKS_MAXIMUM
  }
}

export interface LaneMeasureOutcome {
  /** The lanes the core could measure, by id. */
  lanes: Map<string, LaneRead>
  /**
   * True when a later measure superseded this one — the singer opened
   * another song while it ran, and the addon answered every lane
   * `cancelled`. Nothing about this song is wanted any more, least of all a
   * decode of it: the caller drops the song on its own load guard instead.
   */
  superseded: boolean
  errors?: Map<string, unknown>
}

/** Measure native lanes, preserving per-lane failures for a named error. */
export async function measureLanes(
  lanes: LaneEntry[],
  host: LaneMeasureHost = liveHost()
): Promise<LaneMeasureOutcome> {
  const out = new Map<string, LaneRead>()
  if (lanes.length === 0) return { lanes: out, superseded: false }
  const applies = host.applies ?? (await desktopLaneMeasureApplies(lanes, host))
  if (!applies) return { lanes: out, superseded: false }
  let result
  try { result = await host.api.measureDesktopPlaybackLanes(laneMeasureRequest(lanes)) }
  catch (error) { throw Object.assign(new Error(String(error)), { failure: { code: 'prepare-failed', detail: String(error) } }) }
  if (!result.ok) throw Object.assign(new Error(result.error), { failure: { code: 'prepare-failed', detail: result.error } })
  if (result.lanes.length > 0 && result.lanes.every((lane) => !lane.ok && lane.error === 'cancelled')) {
    return { lanes: out, superseded: true }
  }
  const errors = new Map<string, unknown>()
  for (const lane of result.lanes) {
    // Never draw malformed metadata or turn a failed native lane into a browser decode.
    if (
      !lane.ok ||
      !Number.isFinite(lane.durationSeconds) || lane.durationSeconds <= 0 ||
      !(lane.peaks instanceof Float32Array) || lane.peaks.length === 0 ||
      !(lane.envelope instanceof Float32Array) || lane.envelope.length !== LANE_ENVELOPE_BUCKETS ||
      !Number.isFinite(lane.rms)
    ) {
      const detail = `${lane.id}: ${lane.error || 'invalid lane measurement'}`
      errors.set(lane.id, Object.assign(new Error(detail), { failure: { code: ['invalid-argument', 'cancelled', 'io-error', 'unsupported-format', 'malformed-data', 'limit-exceeded', 'resource-exhausted'].includes(lane.error) ? lane.error : 'format-unreadable', laneId: lane.id,
        detail, format: lanes.find(entry => entry.id === lane.id)?.path.split('.').pop() } }))
      continue
    }
    const { peaks, scale } = normalizePeaks(lane.peaks)
    out.set(lane.id, {
      duration: lane.durationSeconds,
      peaks,
      scale,
      envelope: Array.from(lane.envelope),
      rms: lane.rms,
      buffer: null
    })
  }
  return { lanes: out, superseded: false, errors }
}

/** Read drawing metadata without decoding an unreadable lane in Chromium. */
export async function readLanes(
  lanes: LaneEntry[],
  _decode: (path: string) => Promise<AudioBuffer>,
  host: LaneMeasureHost = liveHost()
): Promise<{ reads: Map<string, LaneRead>; errors: Map<string, unknown>; superseded: boolean }> {
  const measured = await measureLanes(lanes, host)
  const reads = measured.lanes
  const errors = new Map<string, unknown>()
  if (measured.superseded) return { reads, errors, superseded: true }
  for (const lane of lanes) {
    if (reads.has(lane.id)) continue
    const detail = `${lane.id}: native lane measurement is unavailable`
    errors.set(lane.id, measured.errors?.get(lane.id) ?? Object.assign(new Error(detail), {
      failure: { code: 'format-unreadable', laneId: lane.id, detail, format: lane.path.split('.').pop() }
    }))
  }
  return { reads, errors, superseded: false }
}


/** Custom tracks are optional: reject only the offending track, never its song.
 * Admission includes the required stems and already-admitted tracks so the
 * complete playable set still respects the native lane limit. */
export async function readOptionalLanes(
  lanes: LaneEntry[],
  decode: (path: string) => Promise<AudioBuffer>,
  host: LaneMeasureHost = liveHost(),
  requiredLanes: LaneEntry[] = []
): Promise<{ reads: Map<string, LaneRead>; errors: Map<string, unknown>; superseded: boolean }> {
  const errors = new Map<string, unknown>()
  if (lanes.length === 0) return { reads: new Map(), errors, superseded: false }
  try {
    const decide = await laneAdmissionSelector(host)
    const admitted: LaneEntry[] = []
    for (const lane of lanes) {
      const decision = decide([...requiredLanes, ...admitted, lane])
      if (decision.backend === 'native') admitted.push(lane)
      else errors.set(lane.id, Object.assign(new Error(decision.reason), { failure: decision.failure }))
    }
    const read = await readLanes(admitted, decode, { ...host, applies: true })
    for (const [id, error] of read.errors) errors.set(id, error)
    return { ...read, errors }
  } catch (error) {
    for (const lane of lanes) if (!errors.has(lane.id)) errors.set(lane.id, error)
    return { reads: new Map(), errors, superseded: false }
  }
}
