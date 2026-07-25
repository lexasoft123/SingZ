import { yinPitch } from './pitch'

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
  hopSec: number
}

const DECIM = 3
const WIN = 1024

self.onmessage = (e: MessageEvent<MelodyRequest>): void => {
  const { mono, sampleRate } = e.data
  const sr = sampleRate / DECIM

  // average-pooling decimation — plenty for pitch, 3x less work
  const dn = Math.floor(mono.length / DECIM)
  const dec = new Float32Array(dn)
  for (let i = 0; i < dn; i++) {
    const j = i * DECIM
    dec[i] = (mono[j] + mono[j + 1] + mono[j + 2]) / 3
  }

  const hop = Math.round(sr * 0.025)
  const frames = Math.max(0, Math.floor((dn - WIN) / hop))
  const f0 = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    f0[i] = yinPitch(dec.subarray(i * hop, i * hop + WIN), sr)
    if (i % 500 === 0) {
      self.postMessage({ type: 'progress', p: frames === 0 ? 1 : i / frames } satisfies MelodyProgress)
    }
  }
  const done: MelodyDone = { type: 'done', f0, hopSec: hop / sr }
  self.postMessage(done, { transfer: [f0.buffer] })
}
