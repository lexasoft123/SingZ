/**
 * Parity gate for the courts' evidence side, C++ against the TypeScript:
 * `buildCourtEvidence` itself, and beneath it `to22k`, `chromaFrames` (with the
 * FFT), `beatSyncChroma`, `rmsEnvelope`, `chordRuns`, `vocalEvidence` and
 * `formSeams`. The CLI calls the real assembly rather than a hand-built twin,
 * so the rounding, the `sec = len * latPer` conversion and the abstention
 * contract are gated too.
 *
 * This layer gets its own harness rather than riding on beats-parity because
 * of what it runs on. Everything ported before it was arithmetic the porting
 * rules can pin: same order, same widths, no FMA, and the answer follows. Here
 * `cos`/`sin` generate the FFT twiddles, `log2` assigns each bin its pitch
 * class, and `log1p`/`hypot` compress the magnitude a chord label is read off
 * — so bit-parity is a property of the platform's libm agreeing with V8, which
 * no rule of ours can enforce. It holds on macOS/arm64 today. This file is how
 * we would find out it had stopped, on a phone toolchain or anywhere else.
 *
 * Values are compared in full, never a checksum: a digest that happened to
 * collide would hide exactly the failure this exists to catch. Both sides
 * exchange exact doubles (%.17g), so "identical" means identical.
 *
 * Two different strengths live here, and conflating them would flatter the
 * weaker one. The chroma/rms/beat-sync comparisons are VALUE gates: exact
 * doubles, so a single-ulp difference fails them, which is what makes them
 * meaningful against libm drift. The chord-run comparison is a DECISION gate:
 * it sees names, times and lengths, so it only fails when the Viterbi picks
 * differently. Measured floor, not guessed — scaling the major emission
 * scores by 1.001 passes every stem, by 1.01 fails only the one with short
 * ambiguous runs, and by 1.05 three of six still pass. That is ~1e-2
 * relative, five to fourteen orders coarser than the float-store (~6e-8) and
 * reordered-dot-product (~1e-16) differences the porting rules exist to
 * police. It gates the decoder's structure and its decisions; the values it
 * decides from are gated one layer up, at full precision.
 *
 * The voice and seam comparisons are COARSER STILL — ~1e-1 relative, measured
 * the same way. Survivors on the sample: `++quiet` to `quiet++`, the 8-second
 * cap to 9, the 2.5-beat gap anywhere in [1.9, 3.1], `minHold` anywhere in
 * [1.1, 1.75] (1.0 and below FAIL — measured before the holdSec drop, and the
 * only figure on this line that drop could weaken; 1.1 and 1.8 have since been
 * re-measured against the current comparison, 1.1 identical and 1.8 failing on
 * voice count 4 to 3), `sectionFinal` up to 11 beats,
 * the RMS threshold by a thousandth, and removing the dedup entirely; for
 * seams, W by a hundredth,
 * the peak threshold by 10%, `nov` from float to double, and `>` to `>=`.
 * What they DO catch is structural — the kernel size, its counting, keeping
 * the zeros, an hbT off-by-one, W to zero. So they prove shape, not
 * arithmetic. Three gates, three strengths; saying so is cheaper than
 * rediscovering it.
 *
 * A RULE ABOUT THIS PARAGRAPH, learned by breaking it three times running.
 * Every survivor interval above measures a PARTICULAR harness. The `minHold`
 * figure was recorded as [0.5, 3.0], then [0.1, 1.75], then [1.1, 1.75] — and
 * each was a correct measurement of a tree that the very same commit then
 * edited out from under it (first the reshaped word list, then the per-input
 * envelope; each tightened the gate). So: measure these LAST, once the
 * harness has stopped changing, and RE-MEASURE WHENEVER A COMMIT CHANGES
 * ANYTHING THESE NUMBERS DESCRIBE — this harness, the code they mutate
 * (courts.ts and its C++ twin), or the audio they run on — whether or not it
 * touches this paragraph. A number describing a test is invalidated by
 * changing the test, and "the test" is all three of those.
 *
 * That trigger is deliberately the principle itself, because the narrower one
 * it replaces ("re-measure any interval whose comment the same commit
 * touches") failed on the very next commit: that one dropped `holdSec` from
 * the voice comparison and left this text alone, so nothing fired. A rule
 * whose trigger is narrower than its principle reads as a safeguard while
 * staying silent on the case in front of it, which is worse than no rule.
 *
 * FOURTH TIME, in the commit that gated buildCourtEvidence. The voice
 * comparison now reads the MAPPED voice — `{t, gapSec}` — so `holdSec` is no
 * longer compared directly, which can only widen the voice gate. Every voice
 * interval above EXCEPT the re-measured 1.1/1.8 endpoints was measured while
 * it WAS compared, so those figures are upper bounds on that gate's strength
 * rather than measurements of it: `end` in the words path and `b` in the
 * no-words path feed `holdSec` alone, so a mis-ported quiet-walk terminus or
 * segment end is now invisible unless it crosses `minHold`.
 *
 * Which figures the drop can actually invalidate is the opposite of the
 * obvious answer, and worth stating because I got it backwards first.
 * Removing a compared field can only make the comparison MORE permissive, so
 * every SURVIVOR figure here is still a survivor — it is merely no longer
 * known to be tight. The ones at risk are the FAIL figures: something once
 * caught might now slip through. So re-measure the fails first.
 * Re-measuring is the fix; recording it is the minimum, and is what this note
 * is. The rule above did not fire here — which is why it now reads as the
 * principle rather than a proxy for it.
 *
 * And one thing NONE of them police: compiling courts.cpp with
 * `-ffp-contract=fast` puts 64 fused multiply-adds into it where the default
 * build has none, and every comparison here still reports identical. The
 * no-FMA pragma is right and is still there — but nothing would notice if it
 * stopped working.
 *
 *   node eval/courts-parity.mjs [file.wav ...]
 *
 * With no arguments it runs the bundled sample's stems.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let bin = null
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
  else files.push(args[i])
}
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()

const lib = join(root, 'mobile', 'src', 'gen', 'analysis-lib.js')
if (!existsSync(lib)) {
  console.error('mobile/src/gen/analysis-lib.js is missing — run `npm ci` in mobile/')
  process.exit(2)
}
const { to22k, chromaFrames, beatSyncChroma, rmsEnvelope, chordRuns, vocalEvidence, formSeams, buildCourtEvidence } = await import(pathToFileURL(lib).href)
if (typeof chromaFrames !== 'function') {
  console.error('the analysis bundle does not export the courts extractors — rebuild it')
  process.exit(2)
}

const tmp = mkdtempSync(join(tmpdir(), 'singz-courts-parity-'))
if (files.length === 0) {
  const stems = join(root, 'mobile', 'assets', 'sample', 'stems')
  if (!existsSync(stems)) {
    console.error('no bundled sample — pass wav paths explicitly')
    process.exit(2)
  }
  for (const f of readdirSync(stems)) files.push(join(stems, f))
}

/** Mono float32 at the file's own rate, then the detectors' 44.1k, exactly as
 *  `monoAt44kPublic` does it — the C++ side runs the same two steps. */
function readWavMono(path) {
  const b = readFileSync(path)
  let o = 12
  let fmt = null
  let data = null
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const sz = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    if (id === 'data') data = { off: o + 8, sz: Math.min(sz, b.length - o - 8) }
    o += 8 + sz + (sz & 1)
  }
  if (!fmt || !data || fmt.bits !== 16) return null
  const n = Math.floor(data.sz / 2 / fmt.ch)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let c = 0; c < fmt.ch; c++) s += b.readInt16LE(data.off + (i * fmt.ch + c) * 2) / 32768
    x[i] = s / fmt.ch
  }
  return { x, sr: fmt.sr }
}

const monoAt44k = (w) => {
  if (w.sr === 44100) return w.x
  const ratio = w.sr / 44100
  const n = Math.floor(w.x.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * ratio
    const k = Math.floor(p)
    const f = p - k
    const a = w.x[k] ?? 0
    const b = k + 1 < w.x.length ? w.x[k + 1] : a
    out[i] = a * (1 - f) + b * f
  }
  return out
}

/**
 * Exact double equality, not a rendered comparison.
 *
 * The first version of this file compared `toPrecision(9)` strings, on the
 * reasoning that 9 significant digits round-trips a float32. It does — as a
 * VALUE. But the two sides disagree about the halfway case: JS `toPrecision`
 * rounds half away from zero and C's `%g` rounds half to even, so the exactly
 * representable 22.64453125 printed as 22.6445313 on one side and 22.6445312
 * on the other, and three of six identical stems reported FAIL. The C++ emits
 * %.17g now — the exact double — and JSON.parse returns exactly that, while a
 * Float32Array element widens to a double losslessly. So `!==` is the whole
 * test, and a comparison harness that can invent a divergence is worse than
 * none.
 */
const differs = (a, b) => (Number.isNaN(a) && Number.isNaN(b) ? false : a !== b)
const show = (v) => (Object.is(v, -0) ? '-0' : String(v))

/** Converted temp file -> the input it came from, so failures name a stem. */
const names = new Map()
/** Every label reported, so the self-check below can prove none collided. */
const seen = []
let failed = 0
let compared = 0
// The two bands, per file. buildCourtEvidence calls chromaFrames twice.
const BANDS = [[55, 2000], [41, 400]]

// Decode first, compare second. These were one loop until the band loop was
// added around the whole body, which put the ffmpeg branch inside it: every
// FLAC then converted once per band and was appended twice, so six stems
// reported twenty-four comparisons instead of twelve. Double work reported as
// double coverage is the same lie as a skipped stage reported as a pass.
const wavs = []
for (const path of files) {
  if (/\.wav$/i.test(path)) {
    wavs.push(path)
    continue
  }
  // Index-prefixed, because every project uses the same six stem basenames:
  // naming the temp file after the input alone made Zeit's vocals.flac and
  // Puppe's vocals.flac the SAME temp path, so the second overwrote the first
  // and the run compared Puppe twice while printing "IDENTICAL on every file".
  // The label fix that motivated the basename comes from `names`, not from the
  // filename, so uniqueness costs nothing here.
  const out = join(tmp, `${wavs.length}-${basename(path).replace(/\.[^.]+$/, '')}.wav`)
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path, '-c:a', 'pcm_s16le', out])
  } catch {
    console.log(`SKIP  ${path} (could not decode)`)
    continue
  }
  names.set(out, path)
  wavs.push(out)
}

// The chord layer needs two chroma layers at once, so it runs on whichever
// input IS the bass stem paired with each other input. `runs` is the single
// thing that decides whether the courts speak at all, so it gets a gate.
const bassWav = wavs.find((p) => /bass/i.test(names.get(p) ?? p)) ?? null
const vocalsWav = wavs.find((p) => /vocal/i.test(names.get(p) ?? p)) ?? null
if (!vocalsWav) {
  console.log('NOTE  no /vocal/ input — voice evidence and form seams were NOT compared by this run')
}
// A handful of synthetic words, so the WORDS path of vocalEvidence is
// exercised and not only its no-lyrics fallback. The app always has words;
// gating only the fallback would gate the path nothing takes.
// Holds that STRADDLE minHold, deliberately. The first version of this list
// left every word except one rescued by `sectionFinal` regardless, which is
// why a 6x perturbation of minHold survived it. These sit either side.
const WORDS = [[1, 1.4], [2.5, 2.9], [3.1, 3.4], [5.2, 5.6], [6.4, 6.8],
  [9, 9.5], [11.2, 11.6], [14.5, 14.9], [20, 20.4], [21, 21.6], [33, 33.5]]
let voiceComparisons = 0
let noWordComparisons = 0

/**
 * A synthetic phrase envelope, because the real stems cannot constrain the
 * lyric-less path. Their silences are all one length (six gaps, 1.90-1.95 s),
 * so `phraseSegments`' merge branch never executes at any plausible threshold
 * and `minGap` is equally unconstrained. This one straddles both.
 *
 * The soft edges are meant to be load-bearing: they should keep the last-rise
 * test from re-anchoring inside a phrase, so `lastRise` stays at the segment
 * start and `holdSec` follows whether the merge happened.
 *
 * It measures as designed: gaps of 0.372 s and 1.625 s, straddling the merge
 * thresholds (0.150 / 0.450) and minGap (0.750 / 0.250).
 *
 * It did NOTHING at first, and the reason is worth more than the fixture. The
 * no-words comparison read the shared `vocalsWav` rather than the input under
 * test, so this file sat in `wavs` being compared for chroma and rms while the
 * branch it exists for ran on someone else's audio. I diagnosed that wrongly
 * first — blamed the envelope shape, on a hypothesis I had not tested — and
 * measuring the gaps is what showed the envelope was right all along. An input
 * that is present in a harness is not thereby reaching the code it was written
 * for.
 *
 * Measured with the per-input envelope in place: merge 0.3 -> 0.9 CAUGHT
 * (t 4.78/hold 2.51 becomes t 0.19/hold 7.11), minGap 1.5 -> 0.5 CAUGHT
 * (4 files), rise gate 0.25 -> 0.02 CAUGHT. Still free: `holdSec >= minHold`
 * -> `>`, which needs a hold landing exactly on the threshold. See task #47.
 */
const phraseFixture = (dir) => {
  const SR = 44100
  const seg = []
  const push = (secs, fn) => {
    const n = Math.round(secs * SR)
    for (let i = 0; i < n; i++) seg.push(fn(i / n))
  }
  for (let rep = 0; rep < 3; rep++) {
    push(3.0, (u) => u)          // ramp up
    push(1.0, () => 1)           // hold
    push(0.5, (u) => 1 - u)      // fade down
    push(0.25, () => 0)          // the short silence the merge must span
    push(1.5, (u) => u)          // fade up
    push(1.0, () => 1)           // hold
    push(1.5, () => 0)           // the long silence that ends a phrase
  }
  const n = seg.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = seg[i] * 0.8 * Math.sin((2 * Math.PI * 220 * i) / SR)
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2)
  }
  const p = join(dir, 'phrase-fixture.wav')
  writeFileSync(p, buf)
  return p
}
const phraseWav = phraseFixture(tmp)
if (!bassWav) {
  console.log('NOTE  no /bass/ input — chord runs were NOT compared by this run')
}
let chordComparisons = 0

wavs.push(phraseWav)
names.set(phraseWav, 'eval/beats phrase fixture (synthetic)')

for (const path of wavs) {
 for (const band of BANDS) {
  const w = readWavMono(path)
  if (!w) {
    console.log(`SKIP  ${path} (not 16-bit PCM)`)
    break
  }
  // Both bands buildCourtEvidence actually calls chromaFrames with: the wide
  // harmonic one and the 41-400 Hz bass one that names chord roots. The second
  // was never exercised until it was asked for explicitly.
  const [lo, hi] = band
  const x22 = to22k(monoAt44k(w))
  const tsChroma = chromaFrames(x22, lo, hi)
  const tsRms = rmsEnvelope(x22)
  const tsBeats = []
  for (let t = 0; t < x22.length / 22050; t += 0.5) tsBeats.push(t)
  const tsSync = beatSyncChroma(tsChroma, tsBeats)

  // Only on the wide band — the chord layer fixes its own two bands (55-2000
  // for the harmonic chroma, 41-400 for the bass), so running it under the
  // narrow band too would compare the same thing twice and report it as
  // coverage.
  const wantChords = bassWav && band === BANDS[0]
  const wantVoice = vocalsWav && band === BANDS[0]
  const c = JSON.parse(
    execFileSync(bin, ['courts', '--wav', path, '--lo', String(lo), '--hi', String(hi),
      ...(wantChords ? ['--bass-wav', bassWav] : []),
      ...(wantVoice ? ['--vocals-wav', vocalsWav, ...WORDS.flatMap(([a, b]) => ['--word', `${a}:${b}`])] : [])],
      { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  )
  let tsVoice = null
  let tsVoiceNW = null
  let cNW = null
  let tsSeams = null
  if (wantVoice) {
    const vw = readWavMono(vocalsWav)
    const venv = rmsEnvelope(to22k(monoAt44k(vw)))
    tsVoice = vocalEvidence(venv, tsBeats, WORDS.map(([s2, e]) => ({ s: s2, e })))
      .map((v) => ({ t: Math.round(v.t * 1000) / 1000, gapSec: Math.round((v.gapSec ?? 0) * 100) / 100 }))
    // The NO-WORDS fallback too — phraseSegments and the last-rise loop, which
    // the words path never reaches. It ran ZERO times until this line existed.
    // Partially closed, and the measurement says which part. CAUGHT now: the
    // rise ratio (1.6 -> 3.0 and -> 1.1), phraseSegments' own threshold
    // (0.08*p95 -> 0.20 and -> 0.02), and the rise lag (2 -> 3).
    // On the REAL stems the merge branch never executes at all — 7 voiced
    // runs, 6 gaps all 1.90-1.95 s, against thresholds of 0.15 s and 0.45 s —
    // so the merge gap and `minGap` were uncovered rather than weakly
    // constrained. `phraseFixture` is what covers them, and only once the
    // envelope became per-input; see its comment.
    // The no-words run uses THIS input as its own envelope, not the shared
    // vocals stem. Two reasons, and the second is why the phrase fixture did
    // nothing at first: per-input envelopes make these six comparisons six
    // comparisons instead of one repeated six times, AND until this line the
    // fixture was in `wavs` but never reached vocalEvidence, because the voice
    // path always read `vocalsWav`. It was being compared for chroma and rms
    // while the branch it exists for ran on someone else's audio.
    // `tsRms` above is this same envelope — one value, one name.
    tsVoiceNW = vocalEvidence(tsRms, tsBeats, null)
      .map((v) => ({ t: Math.round(v.t * 1000) / 1000, gapSec: Math.round((v.gapSec ?? 0) * 100) / 100 }))
    cNW = JSON.parse(execFileSync(bin,
      ['courts', '--wav', path, '--lo', String(lo), '--hi', String(hi), '--vocals-wav', path],
      { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString())
    noWordComparisons++
    tsSeams = formSeams(beatSyncChroma(chromaFrames(x22, lo, hi), tsBeats), venv, tsBeats)
    voiceComparisons++
  }
  let tsEv = null
  if (wantChords || wantVoice) {
    // The CLI's `courts` run assembles harm = this input, bass, vocals and the
    // words — so the TS side builds the same CourtSources and calls the same
    // function. 0.5 s beats => 120 bpm, matching the tool.
    tsEv = buildCourtEvidence(
      { bpm: 120, beatsPerBar: 4, downbeat: 0, beats: tsBeats },
      // 44.1k mono — buildCourtEvidence calls to22k itself.
      // Mirrors the CLI's own conditionality: a missing bass or missing vocals
      // is the abstention contract, not a reason to skip the comparison. It
      // was `wantChords && wantVoice`, which meant a bass-but-no-vocals input
      // list compared ZERO chord runs while printing "IDENTICAL on every file".
      { harm: [monoAt44k(w)],
        bass: wantChords ? monoAt44k(readWavMono(bassWav)) : null,
        vocals: wantVoice ? monoAt44k(readWavMono(vocalsWav)) : null,
        words: wantVoice ? WORDS.map(([a, b2]) => ({ s: a, e: b2 })) : null }
    )
  }
  // The TS-side hand-built Ch/Cb/chordRuns twin lived here. It was the other
  // half of the duplicate assembly: the CLI's copy went when it started calling
  // buildCourtEvidence, and this one had no reason to outlive it. `tsEv.runs` is
  // the same chord runs from the same function, which is the point.

  const problems = []
  if (c.to22kLen !== x22.length) problems.push(`to22k length ts=${x22.length} c++=${c.to22kLen}`)
  if (c.chromaFrames !== tsChroma.length) problems.push(`chroma frames ts=${tsChroma.length} c++=${c.chromaFrames}`)
  if (c.rmsFrames !== tsRms.rms.length) problems.push(`rms frames ts=${tsRms.rms.length} c++=${c.rmsFrames}`)
  if (differs(c.rmsP95, tsRms.p95)) problems.push(`rms p95 ts=${show(tsRms.p95)} c++=${show(c.rmsP95)}`)
  const nF = Math.min(tsChroma.length, c.chromaFrames)
  let firstBad = -1
  let bad = 0
  for (let f = 0; f < nF && problems.length < 4; f++) {
    for (let k = 0; k < 12; k++) {
      if (differs(tsChroma[f][k], c.chroma[f][k])) {
        bad++
        if (firstBad < 0) {
          firstBad = f
          problems.push(`chroma[${f}][${k}] ts=${show(tsChroma[f][k])} c++=${show(c.chroma[f][k])}`)
        }
      }
    }
  }
  if (tsEv) {
    // buildCourtEvidence's OWN output now, not a hand-rebuilt copy of its
    // parts — the CLI calls the function, so this gates the rounding, the
    // `sec = len * latPer` conversion and the assembly order too.
    const cr = c.chordRuns ?? []
    // Counted where the COMPARISON happens. It used to increment beside the
    // TS-side computation, so when the comparison was skipped the guard that
    // exists to notice that stayed silent.
    if (wantChords) chordComparisons++
    if (cr.length !== tsEv.runs.length) problems.push(`ev.runs count ts=${tsEv.runs.length} c++=${cr.length}`)
    for (let i = 0; i < Math.min(tsEv.runs.length, cr.length); i++) {
      if (tsEv.runs[i].c !== cr[i].name || differs(tsEv.runs[i].t, cr[i].t) ||
          differs(tsEv.runs[i].sec, cr[i].sec)) {
        problems.push(`ev.runs[${i}] ts=${tsEv.runs[i].c}@${show(tsEv.runs[i].t)}/${show(tsEv.runs[i].sec)}` +
          ` c++=${cr[i].name}@${show(cr[i].t)}/${show(cr[i].sec)}`)
        break
      }
    }
    const cvv = c.voice ?? []
    if (cvv.length !== tsEv.voice.length) problems.push(`ev.voice count ts=${tsEv.voice.length} c++=${cvv.length}`)
    for (let i = 0; i < Math.min(tsEv.voice.length, cvv.length); i++) {
      if (differs(tsEv.voice[i].t, cvv[i].t) || differs(tsEv.voice[i].gapSec, cvv[i].gapSec)) {
        problems.push(`ev.voice[${i}] ts=${show(tsEv.voice[i].t)}/${show(tsEv.voice[i].gapSec)}` +
          ` c++=${show(cvv[i].t)}/${show(cvv[i].gapSec)}`)
        break
      }
    }
    const csm = c.seams ?? []
    const tsm = tsEv.seams.map((s2) => s2.t)
    if (csm.length !== tsm.length) problems.push(`ev.seams count ts=${tsm.length} c++=${csm.length}`)
    for (let i = 0; i < Math.min(tsm.length, csm.length); i++) {
      if (differs(tsm[i], csm[i])) {
        problems.push(`ev.seams[${i}] ts=${show(tsm[i])} c++=${show(csm[i])}`)
        break
      }
    }
  }
  if (tsVoice) {
    const cv = c.voice ?? []
    if (cv.length !== tsVoice.length) problems.push(`voice count ts=${tsVoice.length} c++=${cv.length}`)
    for (let i = 0; i < Math.min(tsVoice.length, cv.length); i++) {
      // t and gapSec only: the CLI emits buildCourtEvidence's MAPPED voice,
      // which drops holdSec by design (courts.ts maps to {t, gapSec}). holdSec
      // is still gated in effect — it decides WHICH entries survive and at
      // what t, which is what caught the merge-gap mutation.
      if (differs(tsVoice[i].t, cv[i].t) || differs(tsVoice[i].gapSec, cv[i].gapSec)) {
        problems.push(`voice[${i}] ts=${show(tsVoice[i].t)}/${show(tsVoice[i].gapSec)}` +
          ` c++=${show(cv[i].t)}/${show(cv[i].gapSec)}`)
        break
      }
    }
    const nw = cNW?.voice ?? []
    if (nw.length !== tsVoiceNW.length)
      problems.push(`voice(no-words) count ts=${tsVoiceNW.length} c++=${nw.length}`)
    for (let i = 0; i < Math.min(tsVoiceNW.length, nw.length); i++) {
      if (differs(tsVoiceNW[i].t, nw[i].t) || differs(tsVoiceNW[i].gapSec, nw[i].gapSec)) {
        problems.push(`voice(no-words)[${i}] ` +
          `ts=${show(tsVoiceNW[i].t)}/${show(tsVoiceNW[i].gapSec)} ` +
          `c++=${show(nw[i].t)}/${show(nw[i].gapSec)}`)
        break
      }
    }
    const cs = c.seams ?? []
    const ts2 = tsSeams.map((s2) => s2.t)
    if (cs.length !== ts2.length) problems.push(`seams count ts=${ts2.length} c++=${cs.length}`)
    for (let i = 0; i < Math.min(ts2.length, cs.length); i++) {
      if (differs(ts2[i], cs[i])) {
        problems.push(`seams[${i}] ts=${show(ts2[i])} c++=${show(cs[i])}`)
        break
      }
    }
  }
  if ((c.beatSync?.length ?? 0) !== tsSync.length)
    problems.push(`beatSync frames ts=${tsSync.length} c++=${c.beatSync?.length}`)
  for (let f = 0; f < Math.min(tsSync.length, c.beatSync?.length ?? 0); f++) {
    let done = false
    for (let k = 0; k < 12 && !done; k++) {
      if (differs(tsSync[f][k], c.beatSync[f][k])) {
        problems.push(`beatSync[${f}][${k}] ts=${show(tsSync[f][k])} c++=${show(c.beatSync[f][k])}`)
        done = true
      }
    }
    if (done) break
  }
  for (let f = 0; f < Math.min(tsRms.rms.length, c.rmsFrames); f++) {
    if (differs(tsRms.rms[f], c.rms[f])) {
      problems.push(`rms[${f}] ts=${show(tsRms.rms[f])} c++=${show(c.rms[f])}`)
      break
    }
  }

  const label = (names.get(path) ?? path).replace(`${root}/`, '')
  if (band === BANDS[0]) seen.push(label)
  if (problems.length > 0) {
    console.log(`FAIL  ${label}`)
    for (const p of problems.slice(0, 4)) console.log(`      ${p}`)
    if (bad > 1) console.log(`      (${bad} chroma values differ in total)`)
    failed++
  } else {
    console.log(`PASS  ${label}`)
    console.log(`      [${band[0]}-${band[1]} Hz] ${c.chromaFrames} chroma + ${c.beatSync?.length ?? 0} beat-sync` +
      ` + ${c.rmsFrames} rms + p95` +
      (tsEv && wantChords ? ` + ${tsEv.runs.length} chord runs` : '') +
      (tsVoice ? ` + ${tsVoice.length}/${tsVoiceNW.length} voice (words/none) + ${tsSeams.length} seams` : '') +
      ' — all identical')
    compared++
  }
 }
}

// The harness checks ITSELF before it reports. Both of this file's coverage
// bugs — converting each input twice (24 comparisons reported as coverage) and
// then colliding two inputs onto one temp path (a dropped file reported as a
// pass) — were invisible to a careful read and obvious to arithmetic. A
// dropped input is the worse of the two: it inflates a number nobody can
// sanity-check.
const expected = wavs.length * BANDS.length
if (compared + failed !== expected) {
  console.log(`\nHARNESS BUG: ${compared + failed} comparisons for ${wavs.length} inputs x ${BANDS.length} bands` +
    ` — expected ${expected}. Coverage is not what this run reported.`)
  process.exit(2)
}
if (new Set(seen).size !== wavs.length) {
  console.log(`\nHARNESS BUG: ${wavs.length} inputs produced ${new Set(seen).size} distinct labels` +
    ` — inputs are colliding and some were never compared.`)
  process.exit(2)
}

// Same discipline as the two checks above: if a bass input WAS present, every
// other input must have had its chord runs compared. Silence about skipped
// coverage is this file's recurring failure mode.
if (vocalsWav && noWordComparisons !== wavs.length) {
  console.log(`\nHARNESS BUG: ${noWordComparisons} no-words comparisons for ${wavs.length} inputs` +
    ' — the lyric-less fallback was skipped for some of them.')
  process.exit(2)
}
if (vocalsWav && voiceComparisons !== wavs.length) {
  console.log(`\nHARNESS BUG: ${voiceComparisons} voice comparisons for ${wavs.length} inputs` +
    ' — the voice/seam gate was skipped for some of them.')
  process.exit(2)
}
if (bassWav && chordComparisons !== wavs.length) {
  console.log(`\nHARNESS BUG: ${chordComparisons} chord comparisons for ${wavs.length} inputs` +
    ' — the chord gate was skipped for some of them.')
  process.exit(2)
}

if (compared === 0 && failed === 0) {
  console.log('\nCOURTS PARITY: nothing compared — no readable wav inputs')
  process.exit(2)
}
console.log(failed > 0 ? `\n${failed} FILE(S) DIVERGE` : '\nCOURTS PARITY: IDENTICAL on every file')
process.exit(failed > 0 ? 1 : 0)
