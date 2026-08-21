/**
 * The core's own detectors, reached through the SingzSplit native module —
 * Phase 4c of docs/PHONE-STANDALONE.md: one C++ implementation
 * (mobile/native/core/melody.cpp, bit-identical to the desktop's pyin) that
 * reads the stem file itself on a native thread and answers in about a
 * second where the worklet-hosted TS took a minute and a half. Nothing
 * crosses a JS runtime for these; the file path is the whole request.
 */
import { NativeModules } from 'react-native'
import type { MlGrid } from '../gen/analysis-lib'
import { log } from '../log'

interface SplitNative {
  mlGridFromStems(
    stemPaths: string[],
    modelsDir: string,
    dumpDir: string
  ): Promise<{
    beats: number[]
    downbeats: number[]
    beat_prob: number[]
    downbeat_prob: number[]
    fps: number
    elapsedMs: number
  }>
  analyzeKey(
    instPaths: string[],
    bassPath: string
  ): Promise<{ pc: number; minor: boolean; detVersion: number } | null>
  analyzeBeats(
    drumsPath: string,
    bassPath: string,
    vocalsPath: string,
    instPaths: string[],
    lineStarts: number[],
    words: number[],
    ml: { beats: number[]; downbeats: number[]; downbeatProb: number[]; fps: number } | null
  ): Promise<{
    beats: number[]
    bpm: number
    beatsPerBar: number
    downbeat: number
    downbeats?: number[]
    suspectAt?: number[]
    detVersion: number
    elapsedMs: number
  } | null>
  analyzeMelody(wavPath: string): Promise<{
    f0: number[]
    hopSec: number
    frames: number
    detVersion: number
    sampleRate: number
    durationSec: number
  }>
  wavInfo(wavPath: string): Promise<{ sampleRate: number; channels: number; frames: number; durationSec: number }>
  encodeFlac(wavPath: string, flacPath: string): Promise<{ bytes: number; skipped: boolean }>
}

interface FolderNative {
  localFile(project: string, file: string): Promise<string>
}

const split = (): SplitNative => NativeModules.SingzSplit as SplitNative
const folder = (): FolderNative => NativeModules.FolderAccess as FolderNative

/** Does this build carry the core's tracker? (An older native beside newer JS does not.) */
export const nativeMelodyAvailable = (): boolean =>
  typeof (NativeModules.SingzSplit as { analyzeMelody?: unknown } | undefined)?.analyzeMelody === 'function'

/** Does this build carry the core's key detector? */
export const nativeKeyAvailable = (): boolean =>
  typeof (NativeModules.SingzSplit as { analyzeKey?: unknown } | undefined)?.analyzeKey === 'function'

export async function trackMelodyNative(
  project: string,
  relPath: string
): Promise<{ f0: Float32Array; hopSec: number; durationSec: number; detVersion: number }> {
  const path = await folder().localFile(project, relPath)
  const r = await split().analyzeMelody(path)
  return { f0: Float32Array.from(r.f0), hopSec: r.hopSec, durationSec: r.durationSec, detVersion: r.detVersion }
}

/**
 * The key off the harmonic stems, in the core. Resolves null when the bed is
 * silent — an ANSWER (the TS returns null there too), not a failure, and the
 * pipeline records it as a verdict rather than storing a key.
 */
export async function estimateKeyNative(
  project: string,
  instRel: string[],
  bassRel?: string
): Promise<{ pc: number; minor: boolean } | null> {
  const f = folder()
  const instPaths = await Promise.all(instRel.map((rel) => f.localFile(project, rel)))
  const bassPath = bassRel ? await f.localFile(project, bassRel) : ''
  const r = await split().analyzeKey(instPaths, bassPath)
  return r ? { pc: r.pc, minor: r.minor } : null
}

/** Does this build carry the core's beat detector? */
export const nativeBeatsAvailable = (): boolean =>
  typeof (NativeModules.SingzSplit as { analyzeBeats?: unknown } | undefined)?.analyzeBeats ===
  'function'

/**
 * The beat grid off the project's stems, in the core — the desktop's whole
 * `detectBeats` (neural fork, tracker, splices, bar phase, head backcast, v20
 * courts), reading the wavs itself. Nothing crosses a JS runtime but the
 * lyrics and the lattice.
 *
 * Null is the DETECTOR's answer, not an error: no steady pulse deserves a
 * metronome, and the pipeline stores that verdict. A stem it cannot read
 * REJECTS instead, and the caller must let that through — swallowing it would
 * turn an unreadable file into "this song has no beat", stamped forever.
 *
 * Only the three lattice arrays the detector actually reads are sent.
 * `beatProb` is not one of them (nothing in detectBeats or the courts touches
 * it) and is ~12 000 numbers per four-minute song.
 */
export async function detectBeatsNative(
  project: string,
  args: {
    drums: string
    bass?: string
    vocals?: string
    inst?: string[]
    lineStarts?: number[] | null
    words?: { s: number; e: number }[] | null
    ml?: MlGrid | null
  }
): Promise<{
  beats: number[]
  bpm: number
  beatsPerBar: number
  downbeat: number
  downbeats?: number[]
  suspectAt?: number[]
} | null> {
  const f = folder()
  const at = (rel: string) => f.localFile(project, rel)
  const [drums, bass, vocals, inst] = await Promise.all([
    at(args.drums),
    args.bass ? at(args.bass) : Promise.resolve(''),
    args.vocals ? at(args.vocals) : Promise.resolve(''),
    Promise.all((args.inst ?? []).map(at))
  ])
  const r = await split().analyzeBeats(
    drums,
    bass,
    vocals,
    inst,
    args.lineStarts ?? [],
    // FLAT [s0,e0,s1,e1,…] — one shape both bridges marshal without nesting.
    (args.words ?? []).flatMap((w) => [w.s, w.e]),
    args.ml
      ? {
          beats: args.ml.beats,
          downbeats: args.ml.downbeats,
          downbeatProb: args.ml.downbeatProb ?? [],
          fps: args.ml.fps ?? 0
        }
      : null
  )
  if (!r) {
    log('analysis', 'no grid in these drums (the core\'s own verdict)')
    return null
  }
  log('analysis', `beat grid: ${r.beats.length} beats, ${r.downbeats?.length ?? 0} bars in ${(r.elapsedMs / 1000).toFixed(1)}s`)
  return {
    beats: r.beats,
    bpm: r.bpm,
    beatsPerBar: r.beatsPerBar,
    downbeat: r.downbeat,
    ...(r.downbeats ? { downbeats: r.downbeats } : {}),
    ...(r.suspectAt ? { suspectAt: r.suspectAt } : {})
  }
}

/**
 * Does this build's core read AND write FLAC? One probe for both: the FLAC
 * reader and `encodeFlac` shipped in the same native change, so the method's
 * presence is the marker — the same older-native-beside-newer-JS rule every
 * other probe here follows. deps.ts widens `coreReads` on it, which is why
 * it must be the INSTALLED binary that answers, never the JS bundle's idea
 * of itself.
 */
export const nativeFlacAvailable = (): boolean =>
  typeof (NativeModules.SingzSplit as { encodeFlac?: unknown } | undefined)?.encodeFlac ===
  'function'

/**
 * One stem of the v1->v2 upgrade: wav -> flac in the core (level 5, verify
 * on, .part rename, wav deleted on success; idempotent when the flac is
 * already there — the kill-between-rename-and-unlink state heals). Both
 * paths are project-relative like every other entry here.
 */
export async function encodeFlacNative(
  project: string,
  wavRel: string,
  flacRel: string
): Promise<{ bytes: number; skipped: boolean }> {
  const f = folder()
  // ONLY the wav goes through localFile: it verifies the file exists, which
  // is right for an input and wrong for an OUTPUT — the flac does not exist
  // yet, that being the point, and asking localFile about it failed every
  // stem with "stems/x.flac is missing" on the first real device run. The
  // output path is the input's sibling, so it is derived from the resolved
  // wav path plus the flac name.
  const wav = await f.localFile(project, wavRel)
  const flac = wav.replace(/[^/]+$/, flacRel.replace(/^.*\//, ''))
  return split().encodeFlac(wav, flac)
}

export async function audioDurationNative(project: string, relPath: string): Promise<number> {
  const path = await folder().localFile(project, relPath)
  return (await split().wavInfo(path)).durationSec
}

/** Does this build carry the from-stems Beat This! runner? */
export const nativeMlGridAvailable = (): boolean =>
  typeof (NativeModules.SingzSplit as { mlGridFromStems?: unknown } | undefined)?.mlGridFromStems ===
  'function'

/**
 * The neural beat lattice off the project's stems, in the core: the native
 * reads, sums and decimates the wavs itself (sumStemsTo22k — the desktop's
 * fetchMlGrid mix) and runs the two graphs, so ~250 MB of audio never
 * crosses a JS runtime. Resolves null on ANY failure, logged: the desktop
 * treats a failed model run exactly this way (fetchMlGrid's catch) — the
 * grid falls back to the homegrown path, which must never cost the singer
 * their analysis, but a silent quality downgrade must be diagnosable.
 */
export async function mlGridFromStemsNative(
  project: string,
  stemRels: string[],
  modelsDir: string
): Promise<MlGrid | null> {
  try {
    const f = folder()
    const paths = await Promise.all(stemRels.map((rel) => f.localFile(project, rel)))
    const g = await split().mlGridFromStems(paths, modelsDir, '')
    log(
      'analysis',
      `ml grid: ${g.beats.length} beats, ${g.downbeats.length} downbeats in ${(g.elapsedMs / 1000).toFixed(1)}s`
    )
    return {
      beats: g.beats,
      downbeats: g.downbeats,
      beatProb: g.beat_prob,
      downbeatProb: g.downbeat_prob,
      fps: g.fps
    }
  } catch (e) {
    log('analysis', `ml grid failed — ${String(e instanceof Error ? e.message : e)}`, 'warn')
    return null
  }
}
