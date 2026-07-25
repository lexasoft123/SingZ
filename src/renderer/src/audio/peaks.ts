/**
 * Peak envelope for waveform drawing: `buckets` max-amplitude values across the
 * whole buffer, lightly normalized so quiet stems still read visually.
 */
export function computePeaks(buffer: AudioBuffer, buckets = 2400): Float32Array {
  const peaks = new Float32Array(buckets)
  const length = buffer.length
  if (length === 0) return peaks

  const channels: Float32Array[] = []
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c))
  }

  const step = length / buckets
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * step)
    const end = Math.min(length, Math.max(start + 1, Math.floor((b + 1) * step)))
    // Sample within the bucket instead of scanning every frame — plenty for pixels.
    const inc = Math.max(1, Math.floor((end - start) / 64))
    let max = 0
    for (const data of channels) {
      for (let i = start; i < end; i += inc) {
        const v = Math.abs(data[i])
        if (v > max) max = v
      }
    }
    peaks[b] = max
  }

  let overall = 0
  for (let b = 0; b < buckets; b++) if (peaks[b] > overall) overall = peaks[b]
  if (overall > 0) {
    const scale = 1 / Math.max(0.35, overall)
    for (let b = 0; b < buckets; b++) peaks[b] = Math.min(1, peaks[b] * scale)
  }
  return peaks
}
