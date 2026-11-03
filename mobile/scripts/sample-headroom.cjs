/** Preserve the stem balance, with room for every mute/solo combination. */
function sampleGains(buffers, target = 10 ** (-1 / 20)) {
  const gains = buffers.map(buffer => {
    let peak = 0
    for (const sample of buffer) peak = Math.max(peak, Math.abs(sample))
    return peak > 0 ? 0.85 / peak : 1
  })
  let peakBound = 0
  for (let i = 0; i < buffers[0].length; i++) {
    let bound = 0
    for (let stem = 0; stem < buffers.length; stem++) bound += Math.abs(buffers[stem][i] * gains[stem])
    peakBound = Math.max(peakBound, bound)
  }
  // Six rounded 16-bit samples can add at most 3 LSB of quantization error.
  const headroom = peakBound > 0 ? Math.min(1, (target - buffers.length / 65534) / peakBound) : 1
  return gains.map(gain => gain * headroom)
}
module.exports = { sampleGains }
