#!/usr/bin/env node
/*
 * Generate the bundled sample project ("Sing with me") — an original
 * composition synthesized deterministically, so no copyrighted audio or
 * lyrics ever ship in the app or live in the repo. Writes into
 * assets/sample/: project.json, lyrics.json and six FLAC stems
 * (via afconvert on macOS, ffmpeg elsewhere — CI installs ffmpeg).
 *
 * Runs from postinstall with a skip-guard; delete assets/sample/ (or run
 * with --force) to regenerate. Everything is seeded — same output on
 * every machine, so Metro asset hashes stay stable too.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const OUT = path.join(__dirname, '..', 'assets', 'sample')
const STEMS_DIR = path.join(OUT, 'stems')
const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

if (!process.argv.includes('--force') && STEMS.every((s) => fs.existsSync(path.join(STEMS_DIR, `${s}.flac`))) && fs.existsSync(path.join(OUT, 'project.json'))) {
  console.log('sample: assets/sample/ already present — skipping (use --force to regenerate)')
  process.exit(0)
}

const SR = 44100
const BPM = 100
const BEAT = 60 / BPM // 0.6 s
const BAR = 4 * BEAT // 2.4 s
const BARS = 17
const DUR = BARS * BAR // 40.8 s
const N = Math.round(DUR * SR)

// ——— music ————————————————————————————————————————————————————————————
// Am | F | C | G, one chord per bar. Frequencies in Hz.
const A2 = 110, C3 = 130.81, E3 = 164.81, F2 = 87.31, A3 = 220, G2 = 98
const B3 = 246.94, C4 = 261.63, D4 = 293.66, E4 = 329.63, F3 = 174.61
const G3 = 196, G4 = 392, A4 = 440, F4 = 349.23
const CHORDS = [
  { root: A2, tones: [A3, C4, E4] }, // Am
  { root: F2, tones: [F3, A3, C4] }, // F
  { root: C3, tones: [G3, C4, E4] }, // C
  { root: G2, tones: [G3, B3, D4] } // G
]
const chordAt = (bar) => CHORDS[bar % 4]

// One lyric line per two bars, melody + words share one schedule: every
// entry is [word, ...notes] — multi-syllable words carry several notes.
const LINES = [
  [['Take', E4], ['a', E4], ['breath', D4], ['and', C4], ['find', D4], ['your', E4], ['sound', A3]],
  [['Come', C4], ['and', C4], ['sing', D4], ['along', E4, D4], ['with', C4], ['me', D4]],
  [['Every', E4, G4], ['voice', G4], ['can', E4], ['learn', D4], ['to', C4], ['fly', D4]],
  [['Sing', A4], ['it', G4], ['soft', E4], ['and', D4], ['sing', E4], ['it', G4], ['high', A4]],
  [['Feel', E4], ['the', D4], ['rhythm', C4, D4], ['in', E4], ['your', E4], ['chest', D4]],
  [['Let', C4], ['the', D4], ['chorus', E4, G4], ['do', E4], ['the', D4], ['rest', C4]],
  [['You', A3], ['were', C4], ['born', D4], ['to', E4], ['make', D4], ['this', C4], ['sound', A3]]
]
const VOX_START_BAR = 2 // >3 s of intro so the count-in dots show

// ——— tiny DSP toolbox ——————————————————————————————————————————————————
let seed = 20260728
const rnd = () => {
  // LCG — deterministic noise for drums/plucks
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 4294967296 - 0.5
}
const zeros = () => new Float64Array(N)

/** Additive tone: harmonic rolloff shaped by an optional formant curve. */
function tone(buf, f0, t0, dur, amp, opts = {}) {
  const { rolloff = 1.4, maxF = 6000, attack = 0.01, release = 0.08, formant = null, vibrato = 0, decay = 0 } = opts
  const s0 = Math.max(0, Math.round(t0 * SR))
  const s1 = Math.min(N, Math.round((t0 + dur + release) * SR))
  const nyq = Math.min(maxF, SR / 2 - 500)
  const K = Math.max(1, Math.floor(nyq / f0))
  const gains = []
  for (let k = 1; k <= K; k++) {
    let g = 1 / Math.pow(k, rolloff)
    if (formant) g *= formant(k * f0)
    gains.push(g)
  }
  const norm = amp / gains.reduce((a, b) => a + b, 0)
  let phase = 0
  for (let i = s0; i < s1; i++) {
    const t = i / SR - t0
    const vib = vibrato && t > 0.12 ? Math.sin(2 * Math.PI * 5.4 * t) * vibrato : 0
    phase += (2 * Math.PI * f0 * (1 + vib)) / SR
    const env =
      (t < attack ? t / attack : t > dur ? Math.max(0, 1 - (t - dur) / release) : 1) *
      (decay ? Math.exp(-decay * t) : 1)
    if (env <= 0) continue
    let v = 0
    for (let k = 1; k <= K; k++) v += gains[k - 1] * Math.sin(phase * k)
    buf[i] += v * norm * env
  }
}

/** Karplus-Strong pluck. */
function pluck(buf, f0, t0, dur, amp) {
  const period = Math.round(SR / f0)
  const line = new Float64Array(period)
  for (let i = 0; i < period; i++) line[i] = rnd() * 2
  const s0 = Math.round(t0 * SR)
  const s1 = Math.min(N, s0 + Math.round(dur * SR))
  let idx = 0
  for (let i = s0; i < s1; i++) {
    const cur = line[idx]
    const nxt = line[(idx + 1) % period]
    line[idx] = (cur + nxt) * 0.4985 // loss → decay
    buf[i] += cur * amp
    idx = (idx + 1) % period
  }
}

function kick(buf, t0, amp = 0.9) {
  const s0 = Math.round(t0 * SR)
  const s1 = Math.min(N, s0 + Math.round(0.28 * SR))
  let phase = 0
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR
    const f = 42 + 78 * Math.exp(-t * 26)
    phase += (2 * Math.PI * f) / SR
    buf[i] += Math.sin(phase) * amp * Math.exp(-t * 15) + rnd() * 0.12 * Math.exp(-t * 220)
  }
}

function snare(buf, t0, amp = 0.55) {
  const s0 = Math.round(t0 * SR)
  const s1 = Math.min(N, s0 + Math.round(0.22 * SR))
  let lp = 0
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR
    const n = rnd()
    lp += 0.25 * (n - lp) // crude band shaping
    buf[i] += ((n - lp) * 0.9 + Math.sin(2 * Math.PI * 186 * t) * 0.35 * Math.exp(-t * 40)) * amp * Math.exp(-t * 22)
  }
}

function hat(buf, t0, amp = 0.2, open = false) {
  const s0 = Math.round(t0 * SR)
  const s1 = Math.min(N, s0 + Math.round((open ? 0.24 : 0.05) * SR))
  let prev = 0
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR
    const n = rnd()
    buf[i] += (n - prev) * amp * Math.exp(-t * (open ? 22 : 90)) // differenced noise ≈ highpass
    prev = n
  }
}

function crash(buf, t0, amp = 0.4) {
  const s0 = Math.round(t0 * SR)
  const s1 = Math.min(N, s0 + Math.round(1.8 * SR))
  let prev = 0
  for (let i = s0; i < s1; i++) {
    const t = (i - s0) / SR
    const n = rnd()
    buf[i] += (n - prev) * amp * Math.exp(-t * 3.2)
    prev = n
  }
}

// ——— render stems ——————————————————————————————————————————————————————
console.log('sample: synthesizing six stems…')
const bufs = Object.fromEntries(STEMS.map((s) => [s, zeros()]))
const grooveEnd = 16 * BAR

for (let bar = 0; bar < 16; bar++) {
  const t = bar * BAR
  const ch = chordAt(bar)
  // drums
  kick(bufs.drums, t)
  kick(bufs.drums, t + 2 * BEAT)
  if (bar % 4 === 3) kick(bufs.drums, t + 3.5 * BEAT, 0.7)
  snare(bufs.drums, t + BEAT)
  snare(bufs.drums, t + 3 * BEAT)
  for (let e = 0; e < 8; e++) hat(bufs.drums, t + e * BEAT * 0.5, e % 2 ? 0.22 : 0.13, bar % 4 === 3 && e === 7)
  // bass — roots on 1 and 3, approach note on 4&
  tone(bufs.bass, ch.root, t, 1.3 * BEAT, 0.5, { rolloff: 2.2, maxF: 700, decay: 0.8 })
  tone(bufs.bass, ch.root, t + 2 * BEAT, 1.3 * BEAT, 0.45, { rolloff: 2.2, maxF: 700, decay: 0.8 })
  tone(bufs.bass, chordAt(bar + 1).root, t + 3.5 * BEAT, 0.4 * BEAT, 0.32, { rolloff: 2.2, maxF: 700 })
  // guitar — 8th-note arpeggio root/5th/oct/3rd
  const arp = [ch.tones[0], ch.tones[2], ch.tones[1], ch.tones[2], ch.tones[0] * 2, ch.tones[2], ch.tones[1], ch.tones[2]]
  arp.forEach((f, e) => pluck(bufs.guitar, f, t + e * BEAT * 0.5, 0.5, 0.4))
  // piano — chord stabs on 1 and 3, lighter on 2&
  for (const [bt, a] of [[0, 0.4], [1.5, 0.18], [2, 0.34]]) {
    for (const f of ch.tones) tone(bufs.piano, f, t + bt * BEAT, 0.9 * BEAT, a / 3, { rolloff: 1.8, maxF: 4200, attack: 0.004, decay: 2.2 })
  }
  // pad — sustained chord, slow attack, two detuned layers
  for (const f of ch.tones) {
    tone(bufs.other, f * 0.999, t, BAR * 0.98, 0.09, { rolloff: 2.0, maxF: 2800, attack: 0.3, release: 0.25 })
    tone(bufs.other, f * 1.001 * 0.5, t, BAR * 0.98, 0.07, { rolloff: 2.0, maxF: 1800, attack: 0.3, release: 0.25 })
  }
}
// outro bar: final Am hit rings out
const tEnd = grooveEnd
crash(bufs.drums, tEnd)
kick(bufs.drums, tEnd)
tone(bufs.bass, A2, tEnd, 2.0, 0.5, { rolloff: 2.2, maxF: 700, decay: 1.2 })
for (const f of [A3, C4, E4]) {
  tone(bufs.piano, f, tEnd, 2.2, 0.14, { rolloff: 1.8, maxF: 4200, attack: 0.004, decay: 1.1 })
  tone(bufs.other, f, tEnd, 2.1, 0.08, { rolloff: 2.0, maxF: 2800, attack: 0.2, release: 0.4 })
}
pluck(bufs.guitar, A3, tEnd, 1.6, 0.45)
crash(bufs.drums, tEnd, 0.25)

// vocals — "ah" formant lead following the lyric schedule; build lyrics.json
const formantAh = (f) => 1 + 1.3 * Math.exp(-(((f - 720) / 130) ** 2)) + 0.7 * Math.exp(-(((f - 1180) / 190) ** 2))
const lines = []
LINES.forEach((words, li) => {
  const lineT = (VOX_START_BAR + li * 2) * BAR
  const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3] // beats within the line, one per note
  let ni = 0
  const outWords = []
  for (const [word, ...notes] of words) {
    const s = lineT + grid[ni] * BEAT
    let e = s
    for (const f of notes) {
      const bt = grid[ni]
      const noteDur = (ni === grid.length - 1 ? 1.4 : 0.44) * BEAT
      tone(bufs.vocals, f, lineT + bt * BEAT, noteDur, 0.42, {
        rolloff: 1.15,
        maxF: 5200,
        attack: 0.035,
        release: 0.1,
        formant: formantAh,
        vibrato: 0.007
      })
      e = lineT + bt * BEAT + noteDur
      ni++
    }
    outWords.push({ w: word, s: Math.round(s * 100) / 100, e: Math.round(e * 100) / 100 })
  }
  lines.push({
    start: outWords[0].s,
    end: Math.round((outWords[outWords.length - 1].e + 0.25) * 100) / 100,
    text: words.map(([w]) => w).join(' '),
    words: outWords
  })
})

// ——— write files ———————————————————————————————————————————————————————
fs.mkdirSync(STEMS_DIR, { recursive: true })
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-sample-'))
const hasAfconvert = process.platform === 'darwin'
const enc = (wav, flac) => {
  if (hasAfconvert) execFileSync('afconvert', ['-f', 'flac', '-d', 'flac', wav, flac])
  else execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-sample_fmt', 's16', '-c:a', 'flac', flac])
}
try {
  if (!hasAfconvert) execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch {
  console.error('sample: ffmpeg is required to encode the sample stems (apt/brew install ffmpeg)')
  process.exit(1)
}

for (const s of STEMS) {
  const b = bufs[s]
  let peak = 0
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(b[i]))
  const g = peak > 0 ? 0.85 / peak : 1
  const pcm = Buffer.alloc(N * 2)
  for (let i = 0; i < N; i++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, b[i] * g)) * 32767), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(SR, 24)
  header.writeUInt32LE(SR * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  const wav = path.join(tmp, `${s}.wav`)
  fs.writeFileSync(wav, Buffer.concat([header, pcm]))
  enc(wav, path.join(STEMS_DIR, `${s}.flac`))
}
fs.rmSync(tmp, { recursive: true, force: true })

fs.writeFileSync(
  path.join(OUT, 'project.json'),
  JSON.stringify(
    {
      version: 2,
      name: 'Sing with me',
      songFile: 'song.mp3',
      savedAt: '2026-07-28T00:00:00.000Z',
      settings: {
        transpose: 0,
        tempo: 1,
        training: { on: false, mode: 'lines', periodSec: 10, hear: 1, sing: 1, stems: ['vocals'] },
        tracks: Object.fromEntries(STEMS.map((s) => [s, { muted: false, solo: false, volume: 1 }]))
      }
    },
    null,
    1
  )
)
fs.writeFileSync(
  path.join(OUT, 'lyrics.json'),
  JSON.stringify({ source: 'whisper', credit: 'Original demo song, written for SingZ', aligned: true, lines }, null, 1)
)
const mb = STEMS.reduce((a, s) => a + fs.statSync(path.join(STEMS_DIR, `${s}.flac`)).size, 0) / 1e6
console.log(`sample: wrote "Sing with me" — ${DUR.toFixed(1)}s, six stems, ${mb.toFixed(1)} MB`)
