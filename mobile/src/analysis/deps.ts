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
import {
  audioDurationNative,
  estimateKeyNative,
  mlGridFromStemsNative,
  nativeKeyAvailable,
  nativeMelodyAvailable,
  nativeMlGridAvailable,
  trackMelodyNative
} from './native'
import { beatModelsStatus } from './models'
import { splitVitals } from '../split/service'
import { log } from '../log'

/**
 * The lattice's measured transient: +660..+810 MB over idle on every host
 * (docs/PHONE-STANDALONE.md — sim, emulator, POCO; it is the ORT session,
 * not the song). This runs BEHIND THE PLAYER on an open — on top of the
 * song's decoded stems, in the same process — and a jetsam/LMK kill mid-run
 * writes no stamp, so the same song re-attempts on its next open, forever.
 * Ask the process how much it may still grow and skip the lattice when the
 * answer is under the transient: the homegrown grid is the packless-desktop
 * answer and the singer loses nothing they had. A native that cannot say
 * lets it through — the split's own floor gates those phones — and "cannot
 * say" has two shapes: null (no splitVitals on this platform/build —
 * Android today) and NEGATIVE (the iOS simulator, which SingzSplitRunner
 * reports as -1). ZERO is not unknown: Apple's os_proc_available_memory
 * returns 0 both for "not an app" (the sim) and for "already over the
 * limit" (a device about to be killed), so the native disambiguates at
 * compile time and a 0 that reaches here is the device saying it has
 * nothing left — the one reading this guard most exists for. (First cut
 * treated 0 as unknown; the sim measured "0 MB more", and review read the
 * doc.)
 */
export const ML_HEADROOM_MB = 900
import type { AnalysisDeps, AnalysisHost } from './pipeline'

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

/**
 * The host the pipeline drives: the beat and key detectors on the worklet
 * runtime (host.ts — the desktop TS, verbatim), the melody in the core
 * (native.ts — the desktop TS, ported). As the beat and key detectors move
 * into the core too, entries here move with them; the pipeline does not
 * change.
 *
 * The core reads WAV — the split's own output. The phone library also holds
 * FLAC: a desktop project copied in through Files ("This iPhone" is the
 * Documents folder), whose doc may lack a melody today and WILL the day
 * PITCH_DETECT_VERSION moves. Those go the way HEAD went — decoded by
 * audio-api and tracked by the same TS on the worklet host — so a stem the
 * core cannot read is slower, never a failed run. (The core will read FLAC
 * once the desktop CLI needs it; this branch then goes away.)
 */
const coreReads = (relPath: string): boolean => /\.wav$/i.test(relPath)

export function realAnalysisHost(): AnalysisHost {
  return {
    putStem: host.putStem,
    clearStems: host.clearStems,
    detectBeats: host.detectBeats,
    // The lattice has no worklet fallback, on purpose: no models or FLAC
    // stems is the packless-desktop condition, and the answer there is a
    // legitimate no-ml grid — not a slower path to the same one.
    mlAvailable: async () => nativeMlGridAvailable() && (await beatModelsStatus()).have,
    mlGrid: async (project, stemRels) => {
      if (!stemRels.every(coreReads)) return null
      const st = await beatModelsStatus()
      if (!st.have) return null
      const v = await splitVitals()
      if (v && v.freeMb >= 0 && v.freeMb < ML_HEADROOM_MB) {
        log('analysis', `ml grid skipped — this phone allows ${Math.round(v.freeMb)} MB more for SingZ, the lattice needs ~${ML_HEADROOM_MB}; grid from the drums alone`, 'warn')
        return null
      }
      return mlGridFromStemsNative(project, stemRels, st.dir)
    },
    estimateKeyFromStems: async (project, instRel, bassRel) => {
      if (instRel.every(coreReads) && (!bassRel || coreReads(bassRel)) && nativeKeyAvailable())
        return estimateKeyNative(project, instRel, bassRel)
      // FLAC (a copied desktop project) or an older native: the worklet TS,
      // the way HEAD did it — slower, never a failed run.
      const ids: string[] = []
      try {
        for (const relPath of instRel) {
          const id = `key-${ids.length}`
          await host.putStem(id, await loadMono44k(project, relPath))
          ids.push(id)
        }
        if (bassRel) await host.putStem('key-bass', await loadMono44k(project, bassRel))
        return await host.estimateKeyFromStems(ids, bassRel ? 'key-bass' : undefined)
      } finally {
        await host.clearStems()
      }
    },
    encodeMelody: host.encodeMelody,
    applyUserBars: host.applyUserBars,
    trackMelody: async (project, rel, onProgress) => {
      if (coreReads(rel) && nativeMelodyAvailable()) return trackMelodyNative(project, rel)
      const stem = await loadMono44k(project, rel)
      const durationSec = stem.data.length / stem.sampleRate
      await host.putStem('melody-src', stem)
      try {
        const t = await host.trackMelody('melody-src', onProgress)
        return { ...t, durationSec }
      } finally {
        await host.clearStems()
      }
    },
    audioDuration: async (project, rel) => {
      if (coreReads(rel) && nativeMelodyAvailable()) return audioDurationNative(project, rel)
      // The decode is the only way to a FLAC's length from here; released
      // on the spot inside loadMono44k.
      const stem = await loadMono44k(project, rel)
      return stem.data.length / stem.sampleRate
    }
  }
}

export function realAnalysisDeps(): AnalysisDeps {
  const f = NativeModules.FolderAccess as FolderNative
  return {
    readText: (p, file) => f.readText(p, file),
    writeText: (p, file, text) => f.writeText(p, file, text),
    loadMono: loadMono44k,
    host: realAnalysisHost(),
    now: () => new Date().toISOString()
  }
}
