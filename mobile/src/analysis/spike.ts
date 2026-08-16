/**
 * Phase-0 spike harness (docs/PHONE-STANDALONE.md): run the desktop analysis
 * bundle — the real detectBeats + trackMelodyCore at their real version
 * stamps — over a deterministic synthetic song, on whatever JS host is
 * executing this file. The node baseline (mobile/scripts/spike-baseline.mjs)
 * bundles THIS file, so device and baseline can never drift in their input:
 * the decision rule compares wall time and grid/f0 parity across hosts.
 *
 * The synthetic song: drums = 117 bpm click train with bar accents and ghost
 * subdivisions; vocals = phase-integrated tone phrases with rests. Not music,
 * but enough onsets and pitch for both detectors to do full-cost work.
 */
import {
  BEAT_DETECT_VERSION,
  PITCH_DETECT_VERSION,
  detectBeats,
  trackMelodyCore,
  type AudioBufferLike
} from '../gen/analysis-lib'

export interface SpikeResult {
  hermes: boolean
  minutes: number
  beatDetectVersion: number
  pitchDetectVersion: number
  synthMs: number
  melodyMs: number
  beatsMs: number
  grid: {
    bpm: number
    beatsPerBar: number
    beatCount: number
    downbeatCount: number
    /** Full beat times (3-decimal seconds) — compare-grids.mjs food. */
    beats: number[]
  } | null
  /** Voiced-frame count + rounded f0 for cross-host parity checks. */
  f0Voiced: number
  f0: number[]
}

const SR = 44100

function makeBuffer(data: Float32Array, sampleRate: number): AudioBufferLike {
  return {
    sampleRate,
    length: data.length,
    duration: data.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: () => data
  }
}

/** Deterministic LCG, identical on every engine (integer math + division). */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

export function synthSong(minutes: number): { drums: Float32Array; vocals: Float32Array } {
  const n = Math.floor(SR * 60 * minutes)
  const drums = new Float32Array(n)
  const vocals = new Float32Array(n)
  const rand = lcg(0xbeefcafe)

  // Drums: 117 bpm, accent on 1 of 4, ghost eighth before each backbeat.
  const period = (60 / 117) * SR
  for (let b = 0; b * period < n - 200; b++) {
    const start = Math.round(b * period)
    const accent = b % 4 === 0 ? 0.95 : 0.55
    for (let i = 0; i < 140; i++) {
      drums[start + i] += accent * Math.exp(-i / 22) * Math.sin(i * 0.55)
    }
    if (b % 2 === 1) {
      const ghost = Math.round(start - period / 2)
      if (ghost > 0) {
        for (let i = 0; i < 60; i++) {
          drums[ghost + i] += 0.18 * Math.exp(-i / 12) * Math.sin(i * 1.1)
        }
      }
    }
  }
  for (let i = 0; i < n; i++) drums[i] += (rand() - 0.5) * 0.0008

  // Vocals: four-bar phrases — eight notes a phrase, then a bar of rest.
  const scale = [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392, 440]
  const beatSec = 60 / 117
  let ph = 0
  const noteRand = lcg(0x5147)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const bar = Math.floor(t / (4 * beatSec))
    if (bar % 4 === 3) continue // rest bar
    const noteIdx = Math.floor(t / beatSec)
    const f = scale[(noteIdx * 5 + bar) % scale.length]
    ph += (2 * Math.PI * f) / SR
    // vibrato as a small phase offset — scaling the accumulated phase would
    // be a wild frequency sweep (the chirp trap), not a vibrato
    const vib = 0.06 * Math.sin(2 * Math.PI * 5 * t)
    vocals[i] = 0.25 * Math.sin(ph + vib) + 0.04 * Math.sin(2 * (ph + vib))
  }

  return { drums, vocals }
}

export function runAnalysisSpike(minutes = 3): SpikeResult {
  const t0 = Date.now()
  const { drums, vocals } = synthSong(minutes)
  const synthMs = Date.now() - t0

  const t1 = Date.now()
  const melody = trackMelodyCore(vocals, SR)
  const melodyMs = Date.now() - t1

  const t2 = Date.now()
  const det = detectBeats(makeBuffer(drums, SR), { vocals: makeBuffer(vocals, SR) })
  const beatsMs = Date.now() - t2

  const f0 = Array.from(melody.f0, (v) => Math.round(v * 1e6) / 1e6)
  return {
    hermes: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object',
    minutes,
    beatDetectVersion: BEAT_DETECT_VERSION,
    pitchDetectVersion: PITCH_DETECT_VERSION,
    synthMs,
    melodyMs,
    beatsMs,
    grid: det
      ? {
          bpm: det.bpm,
          beatsPerBar: det.beatsPerBar,
          beatCount: det.beats.length,
          downbeatCount: det.downbeats?.length ?? 0,
          beats: det.beats.map((b) => Math.round(b * 1000) / 1000)
        }
      : null,
    f0Voiced: f0.filter((v) => v > 0).length,
    f0
  }
}

/**
 * The same song through the analysis HOST (host.ts — the worklet runtime)
 * instead of this thread. Proves the mechanism end to end: the bundle
 * serializes and runs over there, song-sized Float32Arrays cross, and the
 * answer is the SAME grid and f0 as the in-thread run — three runtimes agreed
 * to the bit in Phase 0, and a fourth has to as well. `ticks` counts a 50 ms
 * heartbeat on THIS thread while the far side works: a blocked app thread
 * shows as a tick count far below elapsed/50.
 */
export async function runHostSpike(minutes = 3): Promise<
  SpikeResult & { hostMs: { put: number; melody: number; beats: number; total: number }; ticks: number; progressReports: number }
> {
  const host = await import('./host')
  const t0 = Date.now()
  const { drums, vocals } = synthSong(minutes)
  const synthMs = Date.now() - t0

  let ticks = 0
  const beat = setInterval(() => {
    ticks++
  }, 50)
  const tAll = Date.now()
  try {
    const tPut = Date.now()
    await host.putStem('drums', { data: drums, sampleRate: SR })
    await host.putStem('vocals', { data: vocals, sampleRate: SR })
    const put = Date.now() - tPut

    let progressReports = 0
    const tMel = Date.now()
    const melody = await host.trackMelody('vocals', () => {
      progressReports++
    })
    const melodyMs = Date.now() - tMel

    const tBeat = Date.now()
    const det = await host.detectBeats({ drums: 'drums', vocals: 'vocals' })
    const beatsMs = Date.now() - tBeat
    const versions = await host.analysisVersions()
    await host.clearStems()

    const f0 = Array.from(melody.f0, (v) => Math.round(v * 1e6) / 1e6)
    return {
      hermes: typeof (globalThis as { HermesInternal?: unknown }).HermesInternal === 'object',
      minutes,
      beatDetectVersion: versions.beat,
      pitchDetectVersion: versions.pitch,
      synthMs,
      melodyMs,
      beatsMs,
      grid: det
        ? {
            bpm: det.bpm,
            beatsPerBar: det.beatsPerBar,
            beatCount: det.beats.length,
            downbeatCount: det.downbeats?.length ?? 0,
            beats: det.beats.map((b) => Math.round(b * 1000) / 1000)
          }
        : null,
      f0Voiced: f0.filter((v) => v > 0).length,
      f0,
      hostMs: { put, melody: melodyMs, beats: beatsMs, total: Date.now() - tAll },
      ticks,
      progressReports
    }
  } finally {
    clearInterval(beat)
  }
}
