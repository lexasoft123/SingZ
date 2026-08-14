import { trackMelodyCore } from './pitch-core'

export interface MelodyRequest {
  mono: Float32Array
  sampleRate: number
}

export interface MelodyProgress {
  type: 'progress'
  p: number
}

export interface MelodyDone {
  type: 'done'
  f0: Float32Array
  /** Unfiltered tracker output — kept for diagnostics/tuning. */
  raw: Float32Array
  /** Per-frame RMS of the decimated vocals — kept for diagnostics/tuning. */
  rms: Float32Array
  hopSec: number
}

// The math lives in pitch-core.ts (shared with the phone's analysis bundle);
// this file is only the Web Worker envelope around it.
self.onmessage = (e: MessageEvent<MelodyRequest>): void => {
  const { mono, sampleRate } = e.data
  const { f0, raw, rms, hopSec } = trackMelodyCore(mono, sampleRate, (p) => {
    self.postMessage({ type: 'progress', p } satisfies MelodyProgress)
  })
  const done: MelodyDone = { type: 'done', f0, raw, rms, hopSec }
  self.postMessage(done, { transfer: [f0.buffer, raw.buffer, rms.buffer] })
}
