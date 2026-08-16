/**
 * The core's own detectors, reached through the SingzSplit native module —
 * Phase 4c of docs/PHONE-STANDALONE.md: one C++ implementation
 * (mobile/native/core/melody.cpp, bit-identical to the desktop's pyin) that
 * reads the stem file itself on a native thread and answers in about a
 * second where the worklet-hosted TS took a minute and a half. Nothing
 * crosses a JS runtime for these; the file path is the whole request.
 */
import { NativeModules } from 'react-native'

interface SplitNative {
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
