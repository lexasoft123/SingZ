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
  analyzeMelody(wavPath: string): Promise<{
    f0: number[]
    hopSec: number
    frames: number
    detVersion: number
    sampleRate: number
    durationSec: number
  }>
  wavInfo(wavPath: string): Promise<{ sampleRate: number; channels: number; frames: number; durationSec: number }>
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
