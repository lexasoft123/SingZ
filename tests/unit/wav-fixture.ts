/** Build a canonical 16-bit PCM RIFF/WAVE buffer (what the splitter writes). */
export function makeWav(opts: {
  sampleRate?: number
  channels?: number
  frames: number
  sample?: (frame: number, channel: number) => number
}): { buffer: Buffer; samples: Int16Array } {
  const sampleRate = opts.sampleRate ?? 44100
  const channels = opts.channels ?? 2
  const gen =
    opts.sample ??
    ((f: number, c: number) =>
      Math.round(
        12000 * Math.sin((2 * Math.PI * (440 + 110 * c) * f) / sampleRate) +
          1500 * Math.sin((2 * Math.PI * 3.7 * f) / sampleRate)
      ))
  const samples = new Int16Array(opts.frames * channels)
  for (let f = 0; f < opts.frames; f++) {
    for (let c = 0; c < channels; c++) samples[f * channels + c] = gen(f, c) | 0
  }
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  Buffer.from(samples.buffer, samples.byteOffset, dataBytes).copy(buffer, 44)
  return { buffer, samples }
}
