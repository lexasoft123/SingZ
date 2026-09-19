import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flacToWav } from './flac'

/**
 * Cutting the vocals stem into the pieces a recognizer is actually good at.
 *
 * Measured over the whole catalog (2026-09-17): handing whisper a whole stem
 * costs 55 hallucinated phrases across 23 songs — "Thank you." and subtitle
 * credits invented over instrumental stretches, because a recognizer asked
 * about silence answers anyway. It also decides the language once, from the
 * first 30 s, which on a song opening with an organ or a drum intro is a coin
 * flip: Mr Crowley came back as Russian «Продолжение следует…» (0% of the
 * lyrics heard), Radio and Zeit as English (50% and 67%).
 *
 * Feeding only the parts where somebody sings fixes both — the junk drops to
 * 8 and those three songs come back at 88-99% — and it is what makes
 * Qwen3-ASR usable at all: llama.cpp returns an EMPTY transcription past
 * roughly two minutes of audio in one call (ggml-org/llama.cpp#21847).
 *
 * The rules, all measured rather than guessed:
 *   - a stretch quieter than 5% of the song's p90 level for 2 s or more is
 *     not sung and is dropped;
 *   - what is left is cut into pieces of at most 30 s, preferring the
 *     quietest gap as the cut, so a cut rarely lands inside a word. 30 s
 *     beat 60 s (WER 0.167 vs 0.202 with no lyrics): a 60 s piece let Qwen
 *     skip a whole verse when the song switched language mid-piece;
 *   - a piece shorter than 1.5 s is dropped — too short to carry a phrase,
 *     and short blips are what both models answer with junk.
 *
 * 30 s is also whisper's own window: it pads every call to 30 s, so a piece
 * near that length wastes nothing (measured on the Windows field laptop: an
 * 11 s piece and a 25 s piece both cost ~47 s).
 */

/** 16 kHz mono, the rate every speech model here wants. */
export const ASR_RATE = 16000
/** Envelope frame, 50 ms. */
const FRAME = 800
const FRAMES_PER_S = ASR_RATE / FRAME

export interface ChunkPlan {
  /** Seconds into the stem. */
  start: number
  end: number
}

export interface ChunkOptions {
  /** Longest piece, seconds (default 30). */
  maxSeconds?: number
  /** Shortest piece worth sending, seconds (default 1.5). */
  minSeconds?: number
  /** Silence this long is dropped rather than sent, seconds (default 2). */
  dropSilenceSeconds?: number
  /** Kept either side of a voiced region so an onset is never clipped (default 0.3). */
  padSeconds?: number
}

/** RMS per 50 ms frame, and the p90 of those frames as the song's loud level. */
export function levelEnvelope(pcm: Float32Array): { env: Float32Array; p90: number } {
  const env = new Float32Array(Math.floor(pcm.length / FRAME))
  for (let k = 0; k < env.length; k++) {
    let acc = 0
    for (let i = k * FRAME; i < (k + 1) * FRAME; i++) acc += pcm[i] * pcm[i]
    env[k] = Math.sqrt(acc / FRAME)
  }
  const sorted = Float32Array.from(env).sort()
  return { env, p90: sorted[Math.floor(sorted.length * 0.9)] || 0 }
}

/**
 * The pieces worth transcribing. Pure over the envelope so the rules can be
 * tested without decoding anything.
 */
export function planChunks(
  env: Float32Array,
  p90: number,
  opts: ChunkOptions = {}
): ChunkPlan[] {
  const maxS = opts.maxSeconds ?? 30
  const minS = opts.minSeconds ?? 1.5
  const dropS = opts.dropSilenceSeconds ?? 2
  const padS = opts.padSeconds ?? 0.3
  if (env.length === 0 || p90 <= 0) return []

  const quiet = (k: number): boolean => env[k] < 0.05 * p90
  // every run of quiet frames, so a cut can be placed in the quietest one
  const runs: [number, number][] = []
  for (let k = 0; k < env.length; ) {
    if (!quiet(k)) {
      k++
      continue
    }
    let j = k
    while (j < env.length && quiet(j)) j++
    runs.push([k, j])
    k = j
  }

  // voiced regions = what is left once long silences are taken out
  const regions: [number, number][] = []
  let cur = 0
  for (const [a, b] of runs) {
    if (b - a >= dropS * FRAMES_PER_S) {
      if (a > cur) regions.push([cur, a])
      cur = b
    }
  }
  if (cur < env.length) regions.push([cur, env.length])

  const pad = Math.round(padS * FRAMES_PER_S)
  const out: ChunkPlan[] = []
  const push = (a: number, b: number): void => {
    if ((b - a) / FRAMES_PER_S < minS) return
    // a region with almost no loud frame is a bleed-through, not singing
    let loud = 0
    for (let k = a; k < b; k++) if (env[k] >= 0.1 * p90) loud++
    if (loud < 4) return
    out.push({ start: a / FRAMES_PER_S, end: b / FRAMES_PER_S })
  }
  for (let [a, b] of regions) {
    a = Math.max(0, a - pad)
    b = Math.min(env.length, b + pad)
    while ((b - a) / FRAMES_PER_S > maxS) {
      // cut in the longest quiet run in the second half of the window, so
      // the cut lands in a breath rather than mid-word
      const lo = a + maxS * FRAMES_PER_S * 0.6
      const hi = a + maxS * FRAMES_PER_S
      let best: [number, number] | null = null
      for (const r of runs) {
        if (r[0] > lo && r[1] < hi && (!best || r[1] - r[0] >= best[1] - best[0])) best = r
      }
      const cut = best ? Math.floor((best[0] + best[1]) / 2) : Math.floor(hi)
      push(a, cut)
      a = cut
    }
    push(a, b)
  }
  return out
}

/**
 * Samples between yields. This arithmetic runs on the MAIN process, where a
 * 5-minute stem is ~1.6 s of filtering on this Mac and several times that on
 * the field laptops — long enough to freeze the window and stall every IPC
 * reply right after the UI was told "preparing". Yielding keeps main
 * answering; the job is background work, so the wall-clock cost is noise.
 */
const YIELD_EVERY = 1 << 19
const breathe = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Nearest-integer-ratio FIR low-pass, then linear interpolation to the target rate. */
async function resampleMono(input: Float32Array, from: number, to: number): Promise<Float32Array> {
  if (from === to) return input
  const ratio = to / from
  const outLen = Math.max(1, Math.floor(input.length * ratio))
  const src = from > to ? await lowPass(input, to / 2 / from) : input
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const x = i / ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(src.length - 1, i0 + 1)
    const t = x - i0
    out[i] = src[i0] * (1 - t) + src[i1] * t
    if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await breathe()
  }
  return out
}

/**
 * Windowed-sinc low-pass at `cutoff` (in cycles per sample). The tap count
 * scales with how far down we are resampling: a filter sized for a gentle
 * ratio is a near-no-op at 3:1, which is how a resampler passes its own
 * quality gate and still aliases in production (docs/ARCHITECTURE and the
 * 44.1k→22.05k lesson in CLAUDE.md).
 */
async function lowPass(x: Float32Array, cutoff: number): Promise<Float32Array> {
  const decim = Math.max(1, 0.5 / cutoff)
  const half = Math.max(12, Math.round(12 * decim))
  const taps = new Float32Array(half * 2 + 1)
  let sum = 0
  for (let n = -half; n <= half; n++) {
    const t = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n)
    // Hamming window keeps the stopband ~-53 dB, plenty below a vocal stem's floor
    const w = 0.54 + 0.46 * Math.cos((Math.PI * n) / half)
    taps[n + half] = t * w
    sum += t * w
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    let acc = 0
    for (let k = -half; k <= half; k++) {
      const j = i + k
      if (j >= 0 && j < x.length) acc += x[j] * taps[k + half]
    }
    out[i] = acc
    if ((i & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await breathe()
  }
  return out
}

const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_IEEE_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

/**
 * Average a WAV's channels into mono floats — in [-1, 1] for 16-bit, and
 * possibly past it for the float stem, whose residuals can exceed 1
 * (chunkToWav clamps on the way to the engines).
 *
 * Two shapes reach this: the 16-bit PCM a split writes (and every FLAC stem
 * decodes to), and the 32-bit float WAV the lead/backing vocal split saves
 * over stems/vocals — that one is never converted to FLAC, so it stays float
 * for good. flac.ts's parseWav reads 16-bit only, on purpose (wavToFlac relies
 * on the refusal), and handing it the float stem threw "unsupported wav
 * (format 3, 32 bit)": both Qwen tiers then fell back to whisper on every
 * lead-separated song, the very input Qwen should do best on, and said
 * nothing. Anything else is still refused by name rather than guessed at.
 */
export async function wavToMono(buf: Buffer): Promise<{ sampleRate: number; mono: Float32Array }> {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null
  let data: Buffer | null = null
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(off + 8)
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format
      // GUID, whose first two bytes are the ordinary format code
      if (format === WAVE_FORMAT_EXTENSIBLE && size >= 26) format = buf.readUInt16LE(off + 8 + 24)
      fmt = {
        format,
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      }
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + Math.min(size, buf.length - off - 8))
    }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('missing fmt/data chunk')
  const { format, channels, sampleRate, bits } = fmt
  const float = format === WAVE_FORMAT_IEEE_FLOAT && bits === 32
  if (!(float || (format === WAVE_FORMAT_PCM && bits === 16)) || channels < 1) {
    throw new Error(`unsupported wav (format ${format}, ${bits} bit)`)
  }
  const bytes = bits / 8
  const count = Math.floor(data.length / bytes)
  // a typed view needs its offset aligned to the sample size; a chunk before
  // `data` of an odd size can leave it unaligned, and then it is copied
  const aligned = data.byteOffset % bytes === 0 ? data : Buffer.from(data)
  const samples = float
    ? new Float32Array(aligned.buffer, aligned.byteOffset, count)
    : new Int16Array(aligned.buffer, aligned.byteOffset, count)
  const scale = float ? 1 : 1 / 32768
  const frames = Math.floor(count / channels)
  const mono = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let acc = 0
    for (let c = 0; c < channels; c++) acc += samples[f * channels + c]
    mono[f] = (acc / channels) * scale
    if ((f & (YIELD_EVERY - 1)) === YIELD_EVERY - 1) await breathe()
  }
  return { sampleRate, mono }
}

/** Decode a stem (FLAC or WAV) to 16 kHz mono float samples. */
export async function decodeVocalsMono16k(path: string): Promise<Float32Array> {
  let wavPath = path
  let scratch: string | null = null
  try {
    if (/\.flac$/i.test(path)) {
      scratch = await mkdtemp(join(tmpdir(), 'singz-asr-'))
      wavPath = join(scratch, 'vocals.wav')
      const res = await flacToWav(path, wavPath)
      if (!res.ok) throw new Error(res.error)
    }
    const { sampleRate, mono } = await wavToMono(await readFile(wavPath))
    return await resampleMono(mono, sampleRate, ASR_RATE)
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

/** One chunk as a 16-bit mono WAV, ready to post to a model. */
export function chunkToWav(pcm: Float32Array, chunk: ChunkPlan): Buffer {
  const from = Math.max(0, Math.floor(chunk.start * ASR_RATE))
  const to = Math.min(pcm.length, Math.ceil(chunk.end * ASR_RATE))
  const n = Math.max(0, to - from)
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(ASR_RATE, 24)
  buf.writeUInt32LE(ASR_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[from + i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}
