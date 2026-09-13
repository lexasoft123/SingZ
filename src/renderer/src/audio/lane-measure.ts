/**
 * How a song's lanes reach the screen: measured off their files by the core
 * when native playback is going to play them, decoded by Chromium otherwise.
 *
 * Until this existed the open decoded every lane through `decodeAudioData`
 * before a song was on screen — 1.6 s of decode and 0.9 s of JavaScript peak
 * passes for a five-minute six-lane song on a fast Mac, ten times that on the
 * Windows fleet — for three things: each lane's length, the picture of it,
 * and whether a guitar or piano lane was silent. Under native playback the
 * core then read the same files again for the graph, and the renderer let its
 * copy go a few seconds after Play (docs/DESKTOP-LANE-RESIDENCY.md). Seven
 * hundred megabytes of PCM decoded for a duration and a drawing.
 *
 * `readLanes` asks the addon for exactly those three things instead
 * (`measureDesktopPlaybackLanes`, native/playback/lane_measure.h): the header,
 * computePeaks' statistic at computePeaks' bucket count, laneEnvelope's
 * statistic, and the whole-lane RMS — read once, in blocks, on a thread per
 * lane, retaining nothing. The song opens with no `AudioBuffer` at all; the
 * engine's lanes carry `buffer: null` from the first frame, the waveforms draw
 * from peaks as they already do once the native graph has taken a song, and
 * anything that later needs samples (the lyrics editor, a Web Audio fallback,
 * an analysis whose stem cannot be read at its own rate) fetches them through
 * `ensureTrackBuffer` exactly as it does after a release.
 *
 * The decision is the facade's own backend decision with neutral controls:
 * native preferred on this platform, a runtime that can read every lane's
 * format. Anything else — and any lane the measure refuses (a WAV in a v1
 * project, a custom track in a format the streaming source does not read, a
 * file that will not open) — decodes exactly as before, one lane at a time,
 * so the measure can only ever make an open faster, never make one fail that
 * used to succeed.
 */
import type { DesktopPlaybackLaneMeasureRequest, SingzApi } from '../../../shared/types'
import { LANE_ENVELOPE_BUCKETS, laneEnvelope } from './lane-envelope'
import { desktopNativePlaybackPreferred, detectedDesktopPlatform } from './native-playback-preference'
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
  /**
   * The gate's answer for the WHOLE song, decided once by the caller over
   * every lane the song will have and handed to each read of a part of it.
   *
   * Without it the gate was decided per call, over whichever lanes that call
   * carried: six FLAC stems said "native", the mp3 custom track read after
   * them said "legacy", the stems were measured with no samples, and Play —
   * which asks the same gate over all seven lanes — refused native and put
   * six Chromium decodes in front of the first sound. A song the measure
   * takes must be a song native will play, and only the full lane set can
   * say so.
   */
  applies?: boolean
}

const liveHost = (): LaneMeasureHost => ({ api: window.singz })

/** Whether the core will be asked to measure these lanes rather than
 *  Chromium to decode them: native playback preferred here, and a runtime
 *  that reads every lane's format — the facade's own backend gate with
 *  neutral controls, so a song the measure takes is a song native will play. */
export async function desktopLaneMeasureApplies(
  lanes: LaneEntry[],
  host: LaneMeasureHost = liveHost()
): Promise<boolean> {
  const platform = host.platform ?? detectedDesktopPlatform()
  if (!desktopNativePlaybackPreferred(platform)) return false
  let runtime
  try {
    runtime = await host.api.desktopPlaybackCapability()
  } catch {
    return false
  }
  // Lazily, like the engine: the facade is its own chunk and the entry stays
  // the size scripts/check-renderer-split.mjs expects.
  const { selectDesktopPlaybackBackend } = await import('./desktop-native-playback')
  const decision = selectDesktopPlaybackBackend(platform, {
    enabled: true,
    playbackRate: 1,
    transpose: 0,
    training: null,
    lanes,
    runtime,
    requestedProvider: platform === 'win32' ? undefined : 'coreaudio'
  })
  return decision.backend === 'native'
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
}

/**
 * The lanes the core could measure, by id. Empty when the measure does not
 * apply, was refused, or failed — every one of which is logged by main and
 * answered here by decoding, never by an error the singer sees.
 */
export async function measureLanes(
  lanes: LaneEntry[],
  host: LaneMeasureHost = liveHost()
): Promise<LaneMeasureOutcome> {
  const out = new Map<string, LaneRead>()
  if (lanes.length === 0) return { lanes: out, superseded: false }
  const applies = host.applies ?? (await desktopLaneMeasureApplies(lanes, host))
  if (!applies) return { lanes: out, superseded: false }
  let result
  try {
    result = await host.api.measureDesktopPlaybackLanes(laneMeasureRequest(lanes))
  } catch (error) {
    console.warn('lane measure failed — decoding instead:', error)
    return { lanes: out, superseded: false }
  }
  if (!result.ok) {
    console.warn(`lane measure refused (${result.error}) — decoding instead`)
    return { lanes: out, superseded: false }
  }
  if (result.lanes.length > 0 && result.lanes.every((lane) => !lane.ok && lane.error === 'cancelled')) {
    return { lanes: out, superseded: true }
  }
  for (const lane of result.lanes) {
    // Anything the core could not read comes back with ok=false and stays
    // out of the map; anything shaped wrongly is treated the same way rather
    // than drawn — a lane decoded twice costs a second, a lane drawn from a
    // wrong array costs the singer a picture they cannot trust.
    if (
      !lane.ok ||
      !Number.isFinite(lane.durationSeconds) || lane.durationSeconds <= 0 ||
      !(lane.peaks instanceof Float32Array) || lane.peaks.length === 0 ||
      !(lane.envelope instanceof Float32Array) || lane.envelope.length !== LANE_ENVELOPE_BUCKETS ||
      !Number.isFinite(lane.rms)
    ) {
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
  return { lanes: out, superseded: false }
}

/**
 * Every lane of a song: measured by the core where it can be, decoded by
 * `decode` where it cannot. `errors` names the lanes that could be neither —
 * the caller decides whether that sinks the song (a stem) or one lane (a
 * track the singer added). A `superseded` read decoded nothing and carries
 * nothing: the song it was for has already been left.
 */
export async function readLanes(
  lanes: LaneEntry[],
  decode: (path: string) => Promise<AudioBuffer>,
  host: LaneMeasureHost = liveHost()
): Promise<{ reads: Map<string, LaneRead>; errors: Map<string, unknown>; superseded: boolean }> {
  const measured = await measureLanes(lanes, host)
  const reads = measured.lanes
  const errors = new Map<string, unknown>()
  if (measured.superseded) return { reads, errors, superseded: true }
  // All at once, deliberately, as the decode always was: the lanes finish
  // within milliseconds of each other after one long wait.
  await Promise.all(
    lanes
      .filter((lane) => !reads.has(lane.id))
      .map(async (lane) => {
        try {
          reads.set(lane.id, laneReadFromBuffer(await decode(lane.path)))
        } catch (error) {
          errors.set(lane.id, error)
        }
      })
  )
  return { reads, errors, superseded: false }
}
