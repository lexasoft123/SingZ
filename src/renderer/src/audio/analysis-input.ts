/**
 * The analysis inputs: stems read off their FILES at the rate the files
 * state, and the combined core pass that normally makes reading them
 * unnecessary.
 *
 * MEMORY RULE (docs/PROJECT-RULES.md — media is streamed, never decoded whole):
 * while the native analyzer (`singz-analyze`, file-path based) answers a part,
 * NOTHING here decodes a stem. `analysisStems` runs only for a part whose
 * native result is missing or failed, only for the stems that part reads
 * (`fallbackNeed`), and its buffers are handed back through `withFallbackStems`
 * so no closure, stash or pending-promise keeps them past the fallback.
 * Every decode is booked in the decode guard (decode-guard.ts) and logged when
 * it happens on a healthy native song.
 */
import { BEAT_DETECT_VERSION, KEY_DETECT_VERSION, type DetectedBeats } from './analysis-contract'
import type { MlGrid } from './analysis'
import { PITCH_DETECT_VERSION } from './melody'
import { stemSampleRate } from './stem-rate'
import { recordRendererDecode, recordRendererRelease } from './decode-guard'

/**
 * The mono signal the melody tracker runs on, and the rate it must be told.
 *
 * Read from the stem FILE at the rate the file states, not from the playing
 * buffer: the engine's AudioContext resamples everything to the output
 * device's rate, and the tracker derives its hop from whatever rate it is
 * handed, so tracking the playback buffer makes a project's stored line — hop
 * and frame count both — a property of the machine that happened to open it
 * rather than of the song (audio/stem-rate.ts spells the numbers out). The C++
 * core reads the file, so reading the file is what agrees with it.
 *
 * Falls back to the playback buffer when there is no readable stem to go to:
 * an unsaved split whose path never landed, a header in neither format, a
 * stem that has gone missing. A line tracked that way is still this song's
 * line and still saves — it is just framed by whatever rate the device runs
 * at, which is the state every project was in before this.
 */
/**
 * One stem, decoded at the rate its FILE states — the shared primitive under
 * every analysis input. `decodeAudioData` resamples to its context's rate, so
 * the context is built at the file's own and the decode is a pass-through:
 * the analysis sees the samples the C++ core reads. Null when the file cannot
 * say (unreadable, foreign format) — the caller decides what to fall back to,
 * and says so out loud, because a silent fallback IS the bug this exists to
 * fix, wearing the current stamp.
 */
/** The two touchpoints a decode needs — injectable so a test can count them. */
export interface StemDecodeHost {
  readAudio: (path: string) => Promise<ArrayBuffer>
  decode: (bytes: ArrayBuffer, sampleRate: number) => Promise<AudioBuffer>
}

const liveDecodeHost: StemDecodeHost = {
  readAudio: (p) => window.singz.readAudio(p),
  decode: (bytes, sr) => new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes)
}

export async function decodeStemAtFileRate(
  path: string,
  host: StemDecodeHost = liveDecodeHost
): Promise<AudioBuffer | null> {
  const one = async (p: string): Promise<AudioBuffer | null> => {
    try {
      const bytes = await host.readAudio(p)
      const sr = stemSampleRate(bytes)
      if (sr === null) return null
      const buf = await host.decode(bytes, sr)
      try {
        recordRendererDecode(buf, p)
      } catch {
        // a tripwire must never turn a good decode into "unreadable"
      }
      return buf
    } catch {
      return null
    }
  }
  const direct = await one(path)
  if (direct) return direct
  // A .wav that no longer exists is usually the v1->v2 upgrade running
  // beside this analysis: convertStemsToFlac writes the verified .flac and
  // THEN unlinks the .wav, per stem, while stemPathsRef keeps naming .wav
  // until the whole upgrade lands. One of the two files always exists — so
  // try the sibling before falling back to the device-rate buffer, which
  // would be the old bug auto-saved under the new stamp.
  if (/\.wav$/i.test(path)) return one(path.replace(/\.wav$/i, '.flac'))
  return null
}

/**
 * The beat/key analyses' stems, decoded from their FILES at the rate the
 * files state — never the playing buffers, which Chromium resampled to the
 * output device's rate. The beat detector's whole octave decision rides on
 * this: monoAt44k resamples a device-rate buffer BACK down through linear
 * interpolation, and on that doubly-resampled audio the ground-truth harness
 * (eval/beats/run-current.mjs, which has only ever scored the file-rate path)
 * measured Wild World at 156.6 bpm — the exact number its GT entry records as
 * "the pre-v16 wrong answer". detVersion 22 is the stamp of file-fed grids.
 *
 * Composes exactly the aux the playback refs did: `ids` is the AUDIBLE lane
 * order, so silent guitar/piano stems stay out of the vote here too. Per-stem
 * fallback to the playback decode, loudly — a missing file should degrade one
 * lane, not the song.
 *
 * That fallback is asked for by LANE ID rather than handed in as buffers,
 * because the renderer no longer keeps the lanes resident: the samples are
 * the native graph's once it is playing, and `LaneSamples` decodes the file
 * again for whoever still needs them. It is called only on the path where a
 * stem could not be read at its own rate, so the ordinary run costs nothing.
 */
export type LaneSamples = (id: string) => Promise<AudioBuffer | null>

export type AnalysisStems = {
  drums: AudioBuffer | null
  bass: AudioBuffer | null
  vocals: AudioBuffer | null
  inst: AudioBuffer[]
}

/** Which stems a fallback reads. A part's detector names its own; anything
 *  not asked for is neither decoded nor returned (null / empty). */
export interface StemNeed {
  drums: boolean
  bass: boolean
  vocals: boolean
  inst: boolean
}

/** The beat detector reads every stem; the key detector reads the harmonic
 *  ones only (`estimateKeyFromStems(inst, bass)`). */
export const BEATS_STEM_NEED: StemNeed = { drums: true, bass: true, vocals: true, inst: true }
export const KEY_STEM_NEED: StemNeed = { drums: false, bass: true, vocals: false, inst: true }

export async function analysisStems(
  paths: Record<string, string> | null,
  ids: string[],
  fallback: LaneSamples,
  need: StemNeed = BEATS_STEM_NEED,
  host: StemDecodeHost = liveDecodeHost
): Promise<AnalysisStems> {
  const one = async (id: string): Promise<AnalysisStems['drums']> => {
    const path = paths?.[id]
    if (path) {
      const decoded = await decodeStemAtFileRate(path, host)
      if (decoded) return decoded
      // E2E drivers read these, the same way they read the beat-model warnings
      console.warn(`analysis: ${path} could not be read at its own rate — falling back to the playback decode`)
    }
    return fallback(id)
  }
  const instIds = ids.filter((id) => id !== 'vocals' && id !== 'drums' && id !== 'bass')
  const inst = need.inst
    ? (await Promise.all(instIds.map((id) => one(id)))).filter((b): b is AudioBuffer => b !== null)
    : []
  return {
    drums: need.drums ? await one('drums') : null,
    bass: need.bass ? await one('bass') : null,
    vocals: need.vocals ? await one('vocals') : null,
    inst
  }
}

/**
 * Which stems the in-app detectors need, given what the core already
 * answered. Null — decode NOTHING — when every requested part has its native
 * result. Each part falls back independently: a missing beats result asks for
 * the beat detector's stems, a missing key result only for the harmonic ones,
 * both for the union. `keyStillNeeded` is the caller's own gate (a stored
 * current key wants no work at all).
 */
export function fallbackNeed(
  want: { beats: boolean; key: boolean },
  core: { beats?: DetectedBeats | null; key?: { pc: number; minor: boolean } },
  keyStillNeeded: boolean
): StemNeed | null {
  const beats = want.beats && core.beats === undefined
  const key = want.key && core.key === undefined && keyStillNeeded
  if (beats) return BEATS_STEM_NEED
  if (key) return KEY_STEM_NEED
  return null
}

/**
 * Decode the fallback stems, hand them to `use`, and let go of them. Nothing
 * is retained: the buffers exist only for the duration of `use`, and the
 * decode ledger is told when they are dropped. This is the only door the beat
 * and key fallbacks go through.
 */
export async function withFallbackStems<T>(
  need: StemNeed | null,
  load: (need: StemNeed) => Promise<AnalysisStems>,
  use: (stems: AnalysisStems | null) => Promise<T> | T
): Promise<T> {
  if (!need) return use(null)
  let stems: AnalysisStems | null = await load(need)
  try {
    return await use(stems)
  } finally {
    recordRendererRelease(stems.drums, stems.bass, stems.vocals, ...stems.inst)
    stems = null
  }
}

/**
 * The vocals, ready for pYIN — the file at its own rate, or the playback
 * decode when the file cannot be read that way. Null when neither can be had:
 * the caller must then leave the melody UNSTARTED rather than track silence.
 */
export async function melodyInput(
  path: string | null,
  fallback: () => Promise<AudioBuffer | null>,
  host: StemDecodeHost = liveDecodeHost
): Promise<{ mono: Float32Array; sampleRate: number } | null> {
  const fold = (b: AudioBuffer): Float32Array => {
    const chans = Math.min(2, b.numberOfChannels)
    const mono = new Float32Array(b.length)
    for (let c = 0; c < chans; c++) {
      const data = b.getChannelData(c)
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / chans
    }
    return mono
  }
  if (path) {
    const decoded = await decodeStemAtFileRate(path, host)
    if (decoded) {
      const out = { mono: fold(decoded), sampleRate: decoded.sampleRate }
      recordRendererRelease(decoded) // only the mono fold goes on to the worker
      return out
    }
    // E2E drivers read these, the same way they read the beat-model warnings
    console.warn(`melody: ${path} could not be read at its own rate — tracking the playback decode instead`)
  }
  const buf = await fallback()
  if (!buf) return null
  return { mono: fold(buf), sampleRate: buf.sampleRate }
}

/**
 * The beat grid through the core, when the binary is here — Phase 4 of the
 * cutover. The renderer still decodes the stems (the neural mix is rendered
 * HERE, from Chromium's decode — the model's canonical input, docs/BEAT-
 * DETECTION.md) and still produces the ML grid; what moves out is the
 * 1.7-second synchronous detectBeats call. The parity gate held every branch
 * of the ML fork IDENTICAL over the whole library with real grids before this
 * swap (eval/beats-parity.mjs --library --ml), which is what licensed it.
 * Returns null when the core cannot answer — wrong stamp, missing binary,
 * failed run — after saying WHY out loud; the caller then runs the TS.
 */
/**
 * One combined core pass — Phase 5 of the cutover, the shape the user set:
 * "the core can do melody/key/beats in one pass, configurable via cli args;
 * the TS asks for all simultaneously." One child, every stem file read once
 * BY THE CORE (file paths, never streamed buffers: analysisStems' per-lane
 * fallback can hand back a device-rate playback buffer, and streaming would
 * carry that into the core silently — the rate-bug class this session
 * closed twice). The lattice arrives late over the child's stdin, so melody
 * and key run while the renderer's own model is still busy.
 *
 * Returns the per-part results; every refusal (missing binary, wrong stamp,
 * malformed part) is a per-part `undefined` AFTER a loud warn, and the
 * caller runs that part's TS fallback.
 */
let analyzeRunSeq = 0

export async function runCombinedCore(
  want: { melody: boolean; key: boolean; beats: boolean },
  paths: Record<string, string> | null,
  ids: string[],
  provideMl: () => Promise<{
    ml: MlGrid | null
    lineStarts: number[] | null
    words: { s: number; e: number }[] | null
  }>
): Promise<{
  melody?: { f0: Float32Array; raw?: Float32Array; rms?: Float32Array; hopSec: number }
  key?: { pc: number; minor: boolean }
  beats?: DetectedBeats | null
}> {
  const out: Awaited<ReturnType<typeof runCombinedCore>> = {}
  if (!paths) return out
  const avail = await window.singz.melodyNativeAvailable().catch(() => ({ ok: false, available: false }))
  if (!avail.available) return out
  const instPaths = ids
    .filter((id) => id !== 'vocals' && id !== 'drums' && id !== 'bass')
    .map((id) => paths[id])
    .filter((p): p is string => typeof p === 'string')
  const token = `run-${++analyzeRunSeq}`
  const resP = window.singz
    .analyzeNative({
      token,
      want,
      vocals: ids.includes('vocals') ? (paths.vocals ?? null) : null,
      drums: want.beats ? (paths.drums ?? null) : null,
      bass: ids.includes('bass') ? (paths.bass ?? null) : null,
      inst: instPaths,
      // the lyric aux is only KNOWN late (lyrics load while the child is
      // already tracking melody) — it travels with the lattice over stdin
      lineStarts: null,
      words: null
    })
    .catch((e) => ({ ok: false as const, error: String(e) }))
  if (want.beats) {
    // the model's own render happens renderer-side while the child already
    // tracks melody and key; the child's beats stage blocks on stdin for the
    // lattice AND the lyric aux, gathered at this late moment
    const late = await provideMl().catch(() => ({ ml: null, lineStarts: null, words: null }))
    await window.singz
      .analyzeProvideMl(
        late.ml
          ? {
              beats: Array.from(late.ml.beats),
              downbeats: Array.from(late.ml.downbeats),
              ...(late.ml.beatProb ? { beatProb: Array.from(late.ml.beatProb) } : {}),
              ...(late.ml.downbeatProb ? { downbeatProb: Array.from(late.ml.downbeatProb) } : {}),
              ...(late.ml.fps ? { fps: late.ml.fps } : {})
            }
          : null,
        { lineStarts: late.lineStarts, words: late.words },
        token
      )
      .catch(() => undefined)
  }
  const res = await resP
  if (!res.ok) {
    // E2E drivers read these, like the beat-model warnings
    console.warn(`analysis: singz-analyze failed (${res.error}) — falling back to the in-app detectors`)
    return out
  }
  const combined = res
  if (want.melody) {
    const m = combined.melody
    if (m?.ok && m.f0 && m.hopSec && m.detVersion === PITCH_DETECT_VERSION) {
      out.melody = { f0: m.f0, raw: m.raw, rms: m.rms, hopSec: m.hopSec }
    } else if (m) {
      console.warn(
        m.ok
          ? `melody: singz-analyze is stamped v${m.detVersion} but the app is v${PITCH_DETECT_VERSION} — a stale binary; falling back to the in-app tracker`
          : `melody: singz-analyze failed (${m.error}) — falling back to the in-app tracker`
      )
    }
  }
  if (want.key) {
    const k = combined.key
    if (k?.ok && k.pc !== undefined && k.minor !== undefined && k.detVersion === KEY_DETECT_VERSION) {
      out.key = { pc: k.pc, minor: k.minor }
    } else if (k) {
      console.warn(
        k.ok
          ? `key: singz-analyze is stamped v${k.detVersion} but the app is v${KEY_DETECT_VERSION} — a stale binary; falling back to the in-app detector`
          : `key: singz-analyze failed (${k.error}) — falling back to the in-app detector`
      )
    }
  }
  if (want.beats) {
    const b = combined.beats
    if (b?.ok && b.detVersion === BEAT_DETECT_VERSION) {
      out.beats =
        !b.beats || b.beats.length === 0
          ? null // the detector's own "no steady beat"
          : {
              beats: b.beats,
              bpm: b.bpm ?? 0,
              beatsPerBar: b.beatsPerBar ?? 4,
              downbeat: b.downbeat ?? 0,
              ...(b.hasDownbeats && b.downbeats ? { downbeats: b.downbeats } : {}),
              ...(b.suspectAt && b.suspectAt.length > 0 ? { suspectAt: b.suspectAt } : {})
            }
    } else if (b) {
      console.warn(
        b.ok
          ? `beats: singz-analyze is stamped v${b.detVersion} but the app is v${BEAT_DETECT_VERSION} — a stale binary; falling back to the in-app detector`
          : `beats: singz-analyze failed (${b.error}) — falling back to the in-app detector`
      )
    }
  }
  return out
}
