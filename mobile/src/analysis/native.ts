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

export async function trackMelodyNative(
  project: string,
  relPath: string
): Promise<{ f0: Float32Array; hopSec: number; durationSec: number; detVersion: number }> {
  const path = await folder().localFile(project, relPath)
  const r = await split().analyzeMelody(path)
  return { f0: Float32Array.from(r.f0), hopSec: r.hopSec, durationSec: r.durationSec, detVersion: r.detVersion }
}

export async function audioDurationNative(project: string, relPath: string): Promise<number> {
  const path = await folder().localFile(project, relPath)
  return (await split().wavInfo(path)).durationSec
}
