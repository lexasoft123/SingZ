/**
 * The desktop's envelope against the core's definition.
 *
 * This statistic exists to travel: the desktop measures it, writes it into
 * project.json, and a phone draws its seek bar from it without decoding a
 * single stem. So it is not enough that it looks reasonable — it has to be the
 * SAME number `summarizeLanePeaks` produces in
 * native/playback/native_playback_session.cpp, or a song's bar changes shape
 * the moment it moves from this machine to a phone, and nothing about the
 * result would look wrong.
 *
 * The reference below is that C++ transcribed literally, bucket boundaries and
 * accumulation order included. A divergence fails here rather than on a phone.
 */
import { describe, expect, it } from 'vitest'
import { LANE_ENVELOPE_BUCKETS, laneEnvelope } from '../../src/renderer/src/audio/lane-envelope'

/** A stand-in for AudioBuffer: laneEnvelope only asks for these three. */
const buffer = (channels: Float32Array[]) => ({
  length: channels[0]?.length ?? 0,
  numberOfChannels: channels.length,
  getChannelData: (c: number) => channels[c]
})

/** summarizeLanePeaks, transcribed from the core. */
function reference(channels: Float32Array[], buckets = LANE_ENVELOPE_BUCKETS): number[] {
  const out = new Array<number>(buckets).fill(0)
  const frames = channels[0]?.length ?? 0
  if (frames === 0 || channels.length === 0) return out
  const energy = new Float64Array(buckets)
  const counted = new Float64Array(buckets)
  for (const samples of channels) {
    for (let bucket = 0; bucket < buckets; bucket++) {
      const begin = Math.floor((bucket * frames) / buckets)
      let end = Math.floor(((bucket + 1) * frames) / buckets)
      if (end <= begin) end = begin + 1
      if (end > frames) end = frames
      let sum = 0
      let count = 0
      for (let frame = begin; frame < end; frame++) {
        const sample = samples[frame]
        if (!Number.isFinite(sample)) continue
        sum += sample * sample
        count++
      }
      energy[bucket] += sum
      counted[bucket] += count
    }
  }
  for (let bucket = 0; bucket < buckets; bucket++)
    out[bucket] = counted[bucket] === 0 ? 0 : Math.sqrt(energy[bucket] / counted[bucket])
  return out
}

const tone = (frames: number, k: number, amp = 0.5) =>
  Float32Array.from({ length: frames }, (_, i) => amp * Math.sin(i * k))

describe('the lane envelope the phones draw', () => {
  it('is 96 buckets, matching the core', () => {
    expect(LANE_ENVELOPE_BUCKETS).toBe(96)
    expect(laneEnvelope(buffer([tone(50000, 0.01)]))).toHaveLength(96)
  })

  it('matches the core bucket for bucket on stereo audio', () => {
    // Two channels that differ, so a version that read one channel or averaged
    // them the wrong way cannot pass by luck.
    const left = tone(120000, 0.013, 0.6)
    const right = tone(120000, 0.0031, 0.25)
    const mine = laneEnvelope(buffer([left, right]))
    const theirs = reference([left, right])
    let worst = 0
    for (let i = 0; i < mine.length; i++) worst = Math.max(worst, Math.abs(mine[i] - theirs[i]))
    expect(worst).toBeLessThan(1e-12)
    // …and the fixture really has a waveform, or "identical" would be two
    // silences agreeing.
    expect(Math.max(...mine)).toBeGreaterThan(0.1)
  })

  it('is RMS and NOT a peak, which is the whole reason it differs from computePeaks', () => {
    // A full-scale sine has RMS 1/sqrt(2); its peak is 1. A bar drawn from
    // peaks sits near the ceiling everywhere, which is what the phones' native
    // bar used to show.
    const full = tone(96 * 400, 0.05, 1)
    const value = laneEnvelope(buffer([full]))
    const middle = value[48]
    expect(middle).toBeGreaterThan(0.6)
    expect(middle).toBeLessThan(0.75)
  })

  it('is NOT normalized, because the phone combines lanes before normalizing', () => {
    // Halving the audio must halve the envelope. A per-lane normalization
    // would return the same numbers for both and the quiet lane would arrive
    // as loud as the loud one.
    const loud = laneEnvelope(buffer([tone(48000, 0.02, 0.8)]))
    const quiet = laneEnvelope(buffer([tone(48000, 0.02, 0.4)]))
    expect(quiet[40]).toBeGreaterThan(0)
    expect(loud[40] / quiet[40]).toBeGreaterThan(1.9)
    expect(loud[40] / quiet[40]).toBeLessThan(2.1)
  })

  it('answers for a lane far shorter than its bucket count', () => {
    // 10 frames over 96 buckets: every bucket must still be a real number, and
    // the core's "end is always past begin" clamp is what makes that true.
    const short = laneEnvelope(buffer([Float32Array.from([0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5, 0.5, -0.5])]))
    expect(short).toHaveLength(96)
    expect(short.every((v) => Number.isFinite(v))).toBe(true)
    expect(Math.max(...short)).toBeCloseTo(0.5, 6)
  })

  it('is all zeroes for an empty lane rather than NaN', () => {
    const empty = laneEnvelope(buffer([new Float32Array(0)]))
    expect(empty).toHaveLength(96)
    expect(empty.every((v) => v === 0)).toBe(true)
  })

  it('ignores non-finite samples instead of poisoning a whole bucket', () => {
    const dirty = Float32Array.from({ length: 9600 }, (_, i) => (i === 5 ? NaN : 0.5))
    const value = laneEnvelope(buffer([dirty]))
    expect(value.every((v) => Number.isFinite(v))).toBe(true)
    expect(value[0]).toBeCloseTo(0.5, 6)
  })
})
