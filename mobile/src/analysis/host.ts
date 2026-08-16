/**
 * The analysis host: the desktop's detectors, on a JS runtime of their own.
 *
 * Phase 0 measured Hermes at ~65 s of pYIN for a three-minute song — a
 * legitimate cost (bit-perfect against the desktop, under the 120 s bar), but
 * a straight-line one, and the app's own thread cannot be gone for a minute.
 * So the detectors run on a worklet runtime: a second Hermes on its own
 * thread, created once and kept. Its rules shape everything here —
 *
 *  - It sees none of the app's modules. The detectors reach it as CODE:
 *    `loadAnalysisLib` (mobile/src/gen/analysis-worklet.js) is one 'worklet'
 *    function with the whole desktop bundle in its body, compiled once per
 *    runtime and cached on that runtime's global.
 *  - It shares no memory. A Float32Array crossing over is copied — twice, in
 *    fact (a byte vector, then a fresh ArrayBuffer over there) — so stems
 *    cross ONE AT A TIME into a store the far side keeps between calls, and
 *    the near side lets go of each as it lands. Six mono stems of a four-
 *    minute song are ~250 MB resident on the far side; the crossing itself
 *    never holds more than one.
 *  - Nothing running there can be interrupted. Callers own a jobSeq and drop
 *    late answers; the CPU is spent regardless.
 *
 * Only what the detectors need is exposed. Everything else about a project
 * (what to detect, where results go, which song is open now) is the
 * pipeline's business.
 */
import { createWorkletRuntime, runOnRuntimeAsync, scheduleOnRN, type WorkletRuntime } from 'react-native-worklets'
import { loadAnalysisLib } from '../gen/analysis-worklet'
import type { DetectedBeats, KeyGuess, MlGrid, StoredBeatInfo } from '../gen/analysis-lib'

/** A mono stem, one channel of float32 at its own rate. */
export interface MonoStem {
  data: Float32Array
  sampleRate: number
}

let runtime: WorkletRuntime | null = null
const rt = (): WorkletRuntime => (runtime ??= createWorkletRuntime({ name: 'singz-analysis' }))

/** The detector stamps, as the bundle carries them — read once, cheaply. */
export function analysisVersions(): Promise<{ beat: number; pitch: number; key: number }> {
  return runOnRuntimeAsync(rt(), () => {
    'worklet'
    const lib = loadAnalysisLib()
    return { beat: lib.BEAT_DETECT_VERSION, pitch: lib.PITCH_DETECT_VERSION, key: lib.KEY_DETECT_VERSION }
  })
}

/**
 * Hand one stem to the far side, under a name detectBeats/estimateKey will
 * ask for later. Replaces a stem of the same name. The caller should drop its
 * own reference on return — the far side has its copy now.
 */
export function putStem(id: string, stem: MonoStem): Promise<void> {
  return runOnRuntimeAsync(
    rt(),
    (name: string, data: Float32Array, sampleRate: number) => {
      'worklet'
      const g = globalThis as unknown as { __singzStems?: Record<string, MonoStem> }
      ;(g.__singzStems ??= {})[name] = { data, sampleRate }
    },
    id,
    stem.data,
    stem.sampleRate
  )
}

/**
 * Forget every stem the far side holds — the end of a job, or its abandonment.
 * Dropping the references is not enough there either: the far runtime
 * allocates almost nothing on its own, so its collector has no reason to run
 * and six stems' worth of ArrayBuffers would sit until the next song's put
 * forces the issue. Hermes exposes `gc()` on that runtime; when it is there,
 * the memory goes back now.
 */
export function clearStems(): Promise<void> {
  return runOnRuntimeAsync(rt(), () => {
    'worklet'
    const g = globalThis as unknown as { __singzStems?: Record<string, MonoStem>; gc?: () => void }
    g.__singzStems = {}
    if (typeof g.gc === 'function') g.gc()
  })
}

/**
 * What the analysis runtime holds right now, in MB — the ArrayBuffers of the
 * stems put (external to the JS heap) and the heap itself. For the log and
 * for drivers; the numbers come from Hermes' own instrumented stats.
 */
export function runtimeStats(): Promise<{ externalMB: number; heapMB: number; gcs: number } | null> {
  return runOnRuntimeAsync(rt(), () => {
    'worklet'
    const hi = (globalThis as unknown as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } })
      .HermesInternal
    const st = hi?.getInstrumentedStats?.()
    if (!st) return null
    const mb = (b: number | undefined) => Math.round(((b ?? 0) / 1048576) * 10) / 10
    return { externalMB: mb(st.js_externalBytes), heapMB: mb(st.js_heapSize), gcs: st.js_numGCs ?? 0 }
  })
}

/**
 * The beat grid off the stems already put: `drums` is mandatory (as on the
 * desktop — no drums, no grid), the rest are the aux cues detectBeats fuses.
 * `inst` names the stems summed as the harmonic bed. Lyric timings and the
 * neural grid come from the caller — they are not audio.
 */
export function detectBeats(args: {
  drums: string
  bass?: string
  vocals?: string
  inst?: string[]
  lineStarts?: number[] | null
  words?: { s: number; e: number }[] | null
  ml?: MlGrid | null
}): Promise<DetectedBeats | null> {
  return runOnRuntimeAsync(
    rt(),
    (a: typeof args) => {
      'worklet'
      const g = globalThis as unknown as { __singzStems?: Record<string, MonoStem> }
      const stems = g.__singzStems ?? {}
      const buf = (id: string | undefined) => {
        const s = id ? stems[id] : undefined
        if (!s) return null
        return {
          sampleRate: s.sampleRate,
          length: s.data.length,
          duration: s.data.length / s.sampleRate,
          numberOfChannels: 1,
          getChannelData: () => s.data
        }
      }
      const drums = buf(a.drums)
      if (!drums) throw new Error(`no '${a.drums}' stem on the analysis runtime`)
      const inst = (a.inst ?? []).map(buf).filter((b) => b !== null)
      const lib = loadAnalysisLib()
      return lib.detectBeats(drums, {
        bass: buf(a.bass),
        vocals: buf(a.vocals),
        inst,
        lineStarts: a.lineStarts ?? null,
        words: a.words ?? null,
        ml: a.ml ?? null
      })
    },
    args
  )
}

/**
 * The song's key off the harmonic stems already put — null when they are
 * effectively silent (the caller may then fall back to the melody histogram
 * for display, but must not STORE that answer under the stems-detector stamp).
 */
export function estimateKeyFromStems(inst: string[], bass?: string): Promise<KeyGuess | null> {
  return runOnRuntimeAsync(
    rt(),
    (instIds: string[], bassId: string | undefined) => {
      'worklet'
      const g = globalThis as unknown as { __singzStems?: Record<string, MonoStem> }
      const stems = g.__singzStems ?? {}
      const buf = (id: string | undefined) => {
        const s = id ? stems[id] : undefined
        if (!s) return null
        return {
          sampleRate: s.sampleRate,
          length: s.data.length,
          duration: s.data.length / s.sampleRate,
          numberOfChannels: 1,
          getChannelData: () => s.data
        }
      }
      const inst = instIds.map(buf).filter((b) => b !== null)
      const lib = loadAnalysisLib()
      return lib.estimateKeyFromStems(inst, buf(bassId))
    },
    inst,
    bass
  )
}

/**
 * The melody line off a stem already put (the vocals). Progress arrives on
 * the app runtime, thinned to steps of a few percent — pYIN reports every
 * 250 frames, which would be thousands of hops back for one song.
 */
export function trackMelody(
  vocals: string,
  onProgress?: (p: number) => void
): Promise<{ f0: Float32Array; hopSec: number }> {
  const report = onProgress ?? null
  return runOnRuntimeAsync(
    rt(),
    (id: string, cb: ((p: number) => void) | null) => {
      'worklet'
      const g = globalThis as unknown as { __singzStems?: Record<string, MonoStem> }
      const s = g.__singzStems?.[id]
      if (!s) throw new Error(`no '${id}' stem on the analysis runtime`)
      const lib = loadAnalysisLib()
      let last = -1
      const t = lib.trackMelodyCore(
        s.data,
        s.sampleRate,
        cb
          ? (p: number) => {
              if (p - last < 0.03 && p < 1) return
              last = p
              scheduleOnRN(cb, p)
            }
          : undefined
      )
      return { f0: t.f0, hopSec: t.hopSec }
    },
    vocals,
    report
  )
}

/** encodeMelody, where the code is. */
export function encodeMelody(f0: Float32Array, hopSec: number): Promise<{ detVersion: number; hopSec: number; f0: string }> {
  return runOnRuntimeAsync(
    rt(),
    (line: Float32Array, hop: number) => {
      'worklet'
      return loadAnalysisLib().encodeMelody(line, hop)
    },
    f0,
    hopSec
  )
}

/** melodyFitsSong, where the code is — the stored-line disowning rule. */
export function melodyFitsSong(f0: Float32Array, hopSec: number, durationSec: number): Promise<boolean> {
  return runOnRuntimeAsync(
    rt(),
    (line: Float32Array, hop: number, dur: number) => {
      'worklet'
      return loadAnalysisLib().melodyFitsSong(line, hop, dur)
    },
    f0,
    hopSec,
    durationSec
  )
}

/** applyUserBars, where the code is — hand-placed bars re-folded onto a fresh grid. */
export function applyUserBars(info: StoredBeatInfo): Promise<StoredBeatInfo> {
  return runOnRuntimeAsync(
    rt(),
    (i: StoredBeatInfo) => {
      'worklet'
      return loadAnalysisLib().applyUserBars(i)
    },
    info
  )
}
