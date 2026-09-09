/**
 * The seek bar's envelope, in the ONE shape the phones draw.
 *
 * This is deliberately not `computePeaks`. That one is the desktop's own lane
 * waveform: 2400 buckets of per-bucket MAXIMUM, normalized so the loudest
 * bucket reaches 1 — right for a tall lane drawn on its own, and wrong as a
 * shared statistic, because a maximum sits near the ceiling everywhere and
 * favours the drums' transients over the voice (which is exactly what the
 * phones' native bar used to show before it moved to RMS), and because a
 * per-lane normalization cannot be combined: the phone sums the squares of
 * every lane and normalizes ONCE at the end.
 *
 * So: 96 buckets of RMS over every channel, unnormalized. It must stay
 * identical to `summarizeLanePeaks` in native/playback/native_playback_session.cpp
 * — that is the definition, this is the port, and a divergence means a song's
 * bar changes shape when it travels from this machine to a phone.
 *
 * Why compute it here at all: the phone can measure it itself, but only by
 * decoding every sample of every stem — the one cost streamed playback exists
 * to avoid. The desktop has already decoded them to play them, so it is nearly
 * free here and saves the phone a background pass per song.
 */

/** Matches kNativePlaybackLaneSummaryBuckets. */
export const LANE_ENVELOPE_BUCKETS = 96

export function laneEnvelope(
  buffer: { length: number; numberOfChannels: number; getChannelData(c: number): Float32Array },
  buckets = LANE_ENVELOPE_BUCKETS
): number[] {
  const out = new Array<number>(buckets).fill(0)
  const frames = buffer.length
  const channels = buffer.numberOfChannels
  if (frames === 0 || channels === 0) return out

  // Doubles across channels, one square root per bucket — the same
  // accumulation order the core uses, so the two agree to rounding.
  const energy = new Float64Array(buckets)
  const counted = new Float64Array(buckets)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let b = 0; b < buckets; b++) {
      // The core's partition, expressed the same way: bucket b is
      // [b*frames/buckets, (b+1)*frames/buckets), with an end that is always
      // past its begin. Deriving the bucket from the frame instead is the same
      // partition only in real arithmetic — integer division moves a frame or
      // two at each edge.
      const begin = Math.floor((b * frames) / buckets)
      let end = Math.floor(((b + 1) * frames) / buckets)
      if (end <= begin) end = begin + 1
      if (end > frames) end = frames
      let sum = 0
      let count = 0
      for (let i = begin; i < end; i++) {
        const v = data[i]
        // Non-finite PCM cannot reach a drawing surface as a height.
        if (!Number.isFinite(v)) continue
        sum += v * v
        count++
      }
      energy[b] += sum
      counted[b] += count
    }
  }
  for (let b = 0; b < buckets; b++)
    out[b] = counted[b] === 0 ? 0 : Math.sqrt(energy[b] / counted[b])
  return out
}
