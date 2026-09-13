export interface PeakData {
  peaks: Float32Array
  /** Normalization factor applied to the envelope — reuse for raw-sample drawing. */
  scale: number
}

/**
 * One bucket per millisecond of audio, which is finer than a pixel at every
 * zoom this app allows (the view never narrows past 2 s, so the deepest zoom
 * puts ~2000 buckets across a lane a good deal narrower than that in pixels).
 *
 * It used to be a flat 2400 for the whole song, on the reasoning that a view
 * zoomed in far enough to see the difference would be drawn from the raw
 * samples instead. That reasoning stopped holding the day the renderer began
 * releasing its `AudioBuffer`s to the native graph: with no samples to fall
 * back to, the deep-zoom branch is skipped and the drawing lands on these
 * buckets after all — 2400 of them across a five-minute song is one bucket per
 * 135 ms, which at a 22 s view is a bar every 7 pixels. That is the "waveform
 * has gone blocky" a singer sees, and it appears only under native playback,
 * which is the default on macOS.
 *
 * The cost of the fix is nothing much: `computePeaks` reads every sample
 * whatever the bucket count, so the time is unchanged, and a five-minute stem
 * goes from 9.6 kB of peaks to 1.3 MB — against the ~130 MB of samples the
 * release hands back per lane.
 */
const bucketsFor = (buffer: AudioBuffer): number =>
  Math.min(400_000, Math.max(2400, Math.round(buffer.duration * 1000)))

/**
 * Peak envelope for waveform drawing: `buckets` max-amplitude values across the
 * whole buffer, lightly normalized so quiet stems still read visually.
 */
export function computePeaks(buffer: AudioBuffer, buckets = 0): PeakData {
  if (buckets <= 0) buckets = bucketsFor(buffer)
  const peaks = new Float32Array(buckets)
  const length = buffer.length
  if (length === 0) return { peaks, scale: 1 }

  const channels: Float32Array[] = []
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c))
  }

  const step = length / buckets
  // Every sample, not a strided lattice: millisecond drum/consonant attacks
  // fall between stride points, which drew identical hits at wildly different
  // heights (measured 97% under on 1.5 ms hits). Sequential full scan is
  // ~25 ms per 4-min stereo stem, once per song load.
  for (const data of channels) {
    for (let b = 0; b < buckets; b++) {
      const start = Math.floor(b * step)
      const end = b + 1 < buckets ? Math.max(start + 1, Math.floor((b + 1) * step)) : length
      let max = peaks[b]
      for (let i = start; i < end; i++) {
        const v = data[i] < 0 ? -data[i] : data[i]
        if (v > max) max = v
      }
      peaks[b] = max
    }
  }

  let overall = 0
  for (let b = 0; b < buckets; b++) if (peaks[b] > overall) overall = peaks[b]
  let scale = 1
  if (overall > 0) {
    scale = 1 / Math.max(0.35, overall)
    for (let b = 0; b < buckets; b++) peaks[b] = Math.min(1, peaks[b] * scale)
  }
  return { peaks, scale }
}
