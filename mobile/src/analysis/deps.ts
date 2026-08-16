/**
 * The pipeline's real dependencies: the folder natives for the doc, the
 * audio-api decoder for the stems, host.ts for the detectors. Kept apart from
 * pipeline.ts so that module imports nothing native and jest can drive it
 * with fakes (the adopt.ts pattern).
 */
import { NativeModules } from 'react-native'
import { decodeAudioData } from 'react-native-audio-api'
import { releaseStems } from '../projects'
import * as host from './host'
import type { MonoStem } from './host'
import type { AnalysisDeps } from './pipeline'

/** The detectors' own rate — decode straight to it and the far side copies nothing. */
export const ANALYSIS_SR = 44100

interface FolderNative {
  readText(project: string, file: string): Promise<string>
  writeText(project: string, file: string, text: string): Promise<boolean>
  localFile(project: string, file: string): Promise<string>
}

/**
 * One stem as mono float32 at 44.1 kHz. The decoded stereo buffer is folded
 * and released on the spot (the GC-is-too-late rule: it is ~85 MB for a
 * four-minute stem and Hermes sees a small wrapper), so what leaves here is
 * one mono array the caller hands to the host and then drops.
 */
export async function loadMono44k(project: string, relPath: string): Promise<MonoStem> {
  const path = await (NativeModules.FolderAccess as FolderNative).localFile(project, relPath)
  // file:// matters on Android release builds (see loadProject).
  const buf = await decodeAudioData(`file://${path}`, ANALYSIS_SR)
  try {
    const chans = Math.min(2, buf.numberOfChannels)
    const mono = new Float32Array(buf.length)
    for (let c = 0; c < chans; c++) {
      const data = buf.getChannelData(c)
      const n = Math.min(data.length, mono.length)
      if (chans === 1) mono.set(data.subarray(0, n))
      else for (let i = 0; i < n; i++) mono[i] += data[i] / chans
    }
    return { data: mono, sampleRate: buf.sampleRate }
  } finally {
    releaseStems([{ buffer: buf }])
  }
}

export function realAnalysisDeps(): AnalysisDeps {
  const f = NativeModules.FolderAccess as FolderNative
  return {
    readText: (p, file) => f.readText(p, file),
    writeText: (p, file, text) => f.writeText(p, file, text),
    loadMono: loadMono44k,
    host,
    now: () => new Date().toISOString()
  }
}
