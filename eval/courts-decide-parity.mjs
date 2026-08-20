/**
 * Parity gate for the courts' DECIDING side, C++ against the TypeScript:
 * `applyCourts` — and beneath it the octave, doubling and meter courts, the
 * grid rewrites (halveGrid/doubleGrid/withInsert/withEdgePair) and every
 * phase test they lean on.
 *
 * courts-parity.mjs gates the EVIDENCE side — what the courts are allowed to
 * weigh. This gates what they do with it. The split matters because the two
 * fail differently: an extractor that drifts one ulp shows up as a value
 * mismatch, while a court that drifts changes a DECISION, and a decision is
 * either the same or it is not.
 *
 * WHAT IS COMPARED, and why it is the grid rather than the numbers:
 * `applyCourts` returns a grid. Every internal disagreement that matters
 * reaches it — a court that fires when the other side abstains moves
 * `bpm`/`beats`, one that places an odd bar differently moves `downbeats`,
 * one that abstains differently returns the input unchanged. So beats and
 * downbeats are compared IN FULL as exact doubles (%.17g both sides, which
 * JSON.parse reads back exactly), and the `dbg` record beside them —
 * abstained, the two verdict objects, the candidate count, the half-bar
 * finding, the cadence census, the plan, and every applied step — is
 * compared too, so a failure says WHICH court moved rather than only that
 * the answer did.
 *
 * The grid is UNIFORM and built from --bpm/--bpb on both sides rather than
 * serialised across: what is under test is the courts, not a grid encoding.
 * The evidence is REAL — the same stems, through the same
 * `buildCourtEvidence` the other harness already gates — so the chord runs
 * these courts weigh are the ones the app will weigh.
 *
 *   node eval/courts-decide-parity.mjs [--bin <singz-analyze>] [wav ...]
 *
 * With no arguments it runs the bundled sample's stems. A stem is exercised
 * at several tempos: the courts' scope guards (bpm >= 100 for the octave
 * court, < 80 for the doubling one) mean one tempo would leave most of the
 * file unrun, and a gate that never enters a court cannot fail for it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join, resolve } from 'node:path'
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
const { buildCourtEvidence, applyCourts, changePoints, mlLevelStats } =
  await import(pathToFileURL(lib).href)
if (typeof applyCourts !== 'function') {
  console.error('the analysis bundle does not export applyCourts — rebuild it (mobile/scripts/build-analysis.mjs)')
  process.exit(2)
}

if (files.length === 0) {
  const stems = join(root, 'mobile', 'assets', 'sample', 'stems')
  if (!existsSync(stems)) {
    console.error('no bundled sample — pass wav paths explicitly')
    process.exit(2)
  }
  for (const f of readdirSync(stems)) files.push(join(stems, f))
}

// The bundled sample ships FLAC; the C++ reads WAV. Decode once into a temp
// dir so the default run works — the same hop courts-parity.mjs makes.
const tmp = mkdtempSync(join(tmpdir(), 'singz-courts-decide-'))
for (let i = 0; i < files.length; i++) {
  if (/\.wav$/i.test(files[i])) continue
  const out = join(tmp, basename(files[i]).replace(/\.[^.]+$/, '.wav'))
  try {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', files[i], '-c:a', 'pcm_s16le', out])
  } catch {
    console.error(`ffmpeg is needed to read ${basename(files[i])} — pass wav paths instead`)
    process.exit(2)
  }
  files[i] = out
}

/**
 * The octave court refuses anything under 24 bars, and the bundled sample is
 * 40.8 s — about 21 bars at 110 bpm — so a default run entered that court
 * four times per stem and was refused on scope every time. Its three
 * witnesses and its 2-of-3 threshold went untested while the summary said it
 * had "spoken". Proven rather than assumed: with the verdict forced to fire
 * the default run still reported IDENTICAL, and the same forced binary over
 * two 156 s stems produced 15 divergences.
 *
 * So a short stem is tiled past the guard. Repeating the audio is honest for
 * a parity gate — what is under test is whether two implementations agree on
 * one signal, not whether the music is interesting. It is tiled ON DISK, as
 * one file both sides read: tiling only the JS side's array left the C++
 * reading the original and the two disagreed about the audio itself (19
 * chord runs against 13), which is a harness bug wearing a parity failure's
 * clothes. Files already long enough pass through untouched.
 */
const MIN_SEC = 60
for (let i = 0; i < files.length; i++) {
  let dur = 0
  try {
    dur = Number(execFileSync('ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', files[i]],
      { encoding: 'utf8' }).trim())
  } catch {
    continue // no ffprobe: leave it alone rather than guess
  }
  if (!(dur > 0) || dur >= MIN_SEC) continue
  const out = join(tmp, `tiled-${basename(files[i])}`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-stream_loop', String(Math.ceil(MIN_SEC / dur)),
    '-i', files[i], '-t', String(MIN_SEC), '-c:a', 'pcm_s16le', out])
  files[i] = out
}

/** Mono float32 at the file's own rate — the same two steps the C++ takes. */
function readWavMono(path) {
  const b = readFileSync(path)
  let o = 12
  let fmt = null
  let data = null
  while (o + 8 <= b.length) {
    const id = b.toString('ascii', o, o + 4)
    const sz = b.readUInt32LE(o + 4)
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) }
    else if (id === 'data') data = b.subarray(o + 8, o + 8 + sz)
    o += 8 + sz + (sz & 1)
  }
  if (!fmt || !data) throw new Error(`not a PCM wav: ${path}`)
  if (fmt.bits !== 16) throw new Error(`${path}: expected 16-bit PCM, got ${fmt.bits}`)
  const frames = Math.floor(data.length / 2 / fmt.ch)
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let c = 0; c < fmt.ch; c++) s += data.readInt16LE((i * fmt.ch + c) * 2) / 32768
    out[i] = s / fmt.ch
  }
  return { data: out, sampleRate: fmt.sr }
}

/** 44.1 kHz mono, the rate the detectors carry — `monoAt44kPublic`'s job. */
function monoAt44k(w) {
  if (w.sampleRate === 44100) return w.data
  const ratio = w.sampleRate / 44100
  const n = Math.floor(w.data.length / ratio)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(i0 + 1, w.data.length - 1)
    const f = x - i0
    out[i] = w.data[i0] * (1 - f) + w.data[i1] * f
  }
  return out
}

const r17 = (x) => Number(x)
let comparisons = 0
let failures = 0
let courtsEntered = { oct: 0, octScope: 0, octFired: 0, dbl: 0, meterApplied: 0, abstained: 0 }

const fail = (label, detail) => {
  console.log(`FAIL  ${label}`)
  if (detail) console.log(`      ${detail}`)
  failures++
}

/** Deep-equal with a path, for the dbg records. Numbers compare exactly. */
function diff(a, b, path = '') {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return Object.is(a, b) ? null : `${path || '<root>'}: ts=${JSON.stringify(a)} c++=${JSON.stringify(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array-ness differs`
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ts=${a.length} c++=${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.join(',') !== kb.join(',')) return `${path}: keys ts=[${ka}] c++=[${kb}]`
  for (const k of ka) {
    const d = diff(a[k], b[k], path ? `${path}.${k}` : k)
    if (d) return d
  }
  return null
}

// The tempos. 125 and 110 enter the octave court (>= 100), 70 enters the
// doubling court (< 80) once an ml level is supplied, and 96 sits between
// them so the "out of scope" branch is exercised too.
const TEMPOS = [125, 110, 96, 70]

for (const path of files) {
  const w = readWavMono(path)
  const at44 = monoAt44k(w)
  const durSec = at44.length / 44100

  for (const bpm of TEMPOS) {
    // An ml level only at the doubling court's tempo, and shaped as a real
    // double would be: a rigid lattice at 2x, which is what convicts.
    let mlBeats = null
    if (bpm < 80) {
      mlBeats = []
      const per = 60 / (bpm * 2)
      for (let t = 0; t < durSec; t += per) mlBeats.push(Math.round(t * 1000) / 1000)
      if (mlBeats.length < 32) mlBeats = null
    }

    const per = 60 / bpm
    const beats = []
    for (let i = 0; ; i++) {
      const t = 0 + i * per
      if (t > durSec) break
      beats.push(t)
    }
    const det = { bpm, beatsPerBar: 4, downbeat: 0, beats }

    const ev = buildCourtEvidence(det, {
      harm: [at44],
      bass: at44,
      vocals: at44,
      words: [],
      ml: null
    })
    ev.ml = mlBeats ? mlLevelStats({ beats: mlBeats }) : null

    const dbg = {}
    const tsGrid = applyCourts(det, ev, dbg)

    const argv = ['courtsjudge', '--wav', path, '--bass-wav', path, '--vocals-wav', path,
      '--bpm', String(bpm), '--bpb', '4', '--dur', String(durSec)]
    if (mlBeats) argv.push('--ml-beats', mlBeats.join(','))
    const c = JSON.parse(execFileSync(bin, argv, { maxBuffer: 1 << 28 }).toString())

    const label = `${basename(path)} @ ${bpm} bpm`
    comparisons++

    // 1. The lattice both sides judged must be the same, or nothing below
    //    means anything.
    if (c.lattice !== det.beats.length) {
      fail(`${label}: lattice`, `ts ${det.beats.length} beats, c++ ${c.lattice}`)
      continue
    }
    if (c.runs !== ev.runs.length) {
      fail(`${label}: evidence`, `ts ${ev.runs.length} chord runs, c++ ${c.runs}`)
      continue
    }

    // 2. changePoints, which three courts read.
    const tsCps = changePoints(ev.runs).map((r) => ({ t: r.t, sec: r.sec, c: r.c }))
    const dCps = diff(tsCps, c.changePoints, 'changePoints')
    if (dCps) fail(`${label}: changePoints`, dCps)

    // 3. The ml level, where one was supplied.
    if (mlBeats) {
      const dMl = diff({ bpm: ev.ml.bpm, uni: ev.ml.uni }, c.ml, 'ml')
      if (dMl) fail(`${label}: mlLevelStats`, dMl)
    } else if (c.hasMl) {
      fail(`${label}: mlLevelStats`, 'c++ has an ml level where the TS has none')
    }

    // 4. The verdict record — which court spoke, and what it said.
    const abstained = dbg.abstained === true
    if (abstained) courtsEntered.abstained++
    if (abstained !== c.abstained) {
      fail(`${label}: abstained`, `ts ${abstained} c++ ${c.abstained}`)
    }
    if (!abstained) {
      // Counted apart, because they are not the same event: the octave
      // court REFUSES on a scope guard (bpb 6, bpm < 100, or fewer than 24
      // bars) before it weighs a single witness, and a refusal counted as a
      // hearing is how a gate reports coverage it does not have. Measured:
      // on the 40.8 s bundled sample every entry at every tempo was a
      // refusal (~21 bars, under the guard), so forcing the verdict either
      // way changed nothing and the run still said IDENTICAL.
      if (dbg.oct) {
        courtsEntered.oct++
        if (!String(dbg.oct.why ?? '').startsWith('out of scope')) courtsEntered.octScope++
        if (dbg.oct.action === 'halve') courtsEntered.octFired++
      }
      if (dbg.dbl) courtsEntered.dbl++
      const dOct = diff(dbg.oct ?? null, c.oct, 'oct')
      if (dOct) fail(`${label}: octave court`, dOct)
      const dDbl = diff(dbg.dbl ?? null, c.dbl, 'dbl')
      if (dDbl) fail(`${label}: doubling court`, dDbl)
      if ((dbg.cands ?? 0) !== c.cands) {
        fail(`${label}: seam candidates`, `ts ${dbg.cands} c++ ${c.cands}`)
      }
      // halfBar/cadenceCensus/plan only exist on the path that ran.
      if (dbg.plan) {
        const dPlan = diff(dbg.plan, c.plan, 'plan')
        if (dPlan) fail(`${label}: halved plan`, dPlan)
      } else {
        if ((dbg.halfBar ?? false) !== c.halfBar) {
          fail(`${label}: halfBar`, `ts ${dbg.halfBar} c++ ${c.halfBar}`)
        }
        const tsCensus = {}
        for (const [k, v] of Object.entries(dbg.cadenceCensus ?? {})) tsCensus[k] = v
        const dCen = diff(tsCensus, c.cadenceCensus ?? {}, 'cadenceCensus')
        if (dCen) fail(`${label}: cadence census`, dCen)
      }
      const tsApplied = (dbg.applied ?? []).map((a) => ({ t: a.t, L: a.L, why: a.why, gain: a.gain }))
      if (tsApplied.length > 0) courtsEntered.meterApplied += tsApplied.length
      const dApp = diff(tsApplied, c.applied, 'applied')
      if (dApp) fail(`${label}: applied steps`, dApp)
    }

    // 5. THE GRID — what ships.
    const tsOut = {
      bpm: r17(tsGrid.bpm),
      beatsPerBar: tsGrid.beatsPerBar,
      downbeat: tsGrid.downbeat,
      beats: Array.from(tsGrid.beats),
      downbeats: Array.from(tsGrid.downbeats ?? [])
    }
    const dGrid = diff(tsOut, c.ruled, 'grid')
    if (dGrid) fail(`${label}: ruled grid`, dGrid)
  }
}

/*
 * FIXTURES — the branches no stem in the corpus reaches.
 *
 * Measured before these existed: on four real stems at four tempos, 22 odd
 * bars were placed and 20 of them came from the break-pair branch, 2 from a
 * step placement, and NONE from the cadence or sibling courts. A gate that
 * never enters a court cannot fail for it, so those two are driven here from
 * synthetic evidence instead — the same three strings parsed by both sides,
 * with no audio at all (the extractors have their own gate).
 *
 * The shape is the one the cadence court exists for: a half-bar song (every
 * chord two beats, so `songIsHalfBar` holds and the residual court is blind),
 * with a 2-beat odd bar immediately before a long section hold, repeated at
 * three form repeats so the corroboration census reaches its threshold of 2.
 */
function cadenceFixture() {
  const per = 0.5 // 120 bpm
  const runs = []
  let t = 1.0
  const add = (sec, c) => {
    runs.push({ t: Math.round(t * 1000) / 1000, sec: Math.round(sec * 1000) / 1000, c })
    t = Math.round((t + sec) * 1000) / 1000
  }
  const seams = []
  for (let rep = 0; rep < 3; rep++) {
    for (const c of ['C', 'F', 'G', 'Am', 'C', 'F']) add(2 * per, c)
    seams.push(t) // the seam sits at the odd bar
    add(2 * per, 'Dm') // the odd bar itself
    add(6 * per, 'C') // the long section hold
    for (const c of ['G', 'Am']) add(2 * per, c)
  }
  return { name: 'cadence fixture', bpm: 120, dur: 40, runs, seams }
}

/**
 * The same shape at 100 bpm with 1.7-beat chords — a half-bar median that
 * sits OFF-CENTRE inside songIsHalfBar's 1.6-2.4 band. The first fixture's
 * median is exactly 2, so tightening that band to 1.9-2.1 left it passing;
 * this one stops being a half-bar song the moment the band narrows.
 * 100 bpm rather than 120 for a reason worth keeping: `changePoints`'
 * minHold is 0.9 SECONDS, and 1.7 beats at 120 bpm is 0.85 s — the whole
 * chord bed was being filtered out before it reached any court.
 */
function offCentreHalfBarFixture() {
  const per = 0.6
  const runs = []
  let t = 1.0
  const seams = []
  const add = (sec, c) => {
    runs.push({ t: Math.round(t * 1000) / 1000, sec: Math.round(sec * 1000) / 1000, c })
    t = Math.round((t + sec) * 1000) / 1000
  }
  for (let rep = 0; rep < 3; rep++) {
    for (const c of ['C', 'F', 'G', 'Am', 'C', 'F']) add(1.7 * per, c)
    seams.push(t)
    add(5 * per, 'Dm')
    add(6 * per, 'C')
    for (const c of ['G', 'Am']) add(1.7 * per, c)
  }
  return { name: 'off-centre half-bar fixture', bpm: 100, dur: Math.round((t + 2) * 10) / 10, runs, seams }
}

for (const fx of [cadenceFixture(), offCentreHalfBarFixture()]) {
  const per = 60 / fx.bpm
  const beats = []
  for (let i = 0; ; i++) {
    const t = i * per
    if (t > fx.dur) break
    beats.push(t)
  }
  const det = { bpm: fx.bpm, beatsPerBar: 4, downbeat: 0, beats }
  const ev = {
    runs: fx.runs,
    voice: [],
    seams: fx.seams.map((t) => ({ t })),
    words: [],
    notes: [],
    ml: null
  }
  const dbg = {}
  const tsGrid = applyCourts(det, ev, dbg)
  const c = JSON.parse(execFileSync(bin, [
    'courtsjudge', '--bpm', String(fx.bpm), '--dur', String(fx.dur),
    '--runs', fx.runs.map((r) => `${r.t}:${r.sec}:${r.c}`).join(','),
    '--seam', fx.seams.join(',')
  ], { maxBuffer: 1 << 28 }).toString())

  comparisons++
  const label = fx.name
  const tsApplied = (dbg.applied ?? []).map((a) => ({ t: a.t, L: a.L, why: a.why, gain: a.gain }))
  courtsEntered.meterApplied += tsApplied.length
  // The fixture exists to enter the cadence court — if it stops doing that,
  // it has stopped being a fixture and says so rather than passing quietly.
  if (!tsApplied.some((a) => a.why.includes('cadence'))) {
    fail(`${label}: no longer reaches the cadence court`, JSON.stringify(tsApplied))
  }
  const dCen = diff(dbg.cadenceCensus ?? {}, c.cadenceCensus ?? {}, 'cadenceCensus')
  if (dCen) fail(`${label}: cadence census`, dCen)
  if ((dbg.halfBar ?? false) !== c.halfBar) fail(`${label}: halfBar`, `ts ${dbg.halfBar} c++ ${c.halfBar}`)
  const dApp = diff(tsApplied, c.applied, 'applied')
  if (dApp) fail(`${label}: applied steps`, dApp)
  const dGrid = diff({
    bpm: tsGrid.bpm,
    beatsPerBar: tsGrid.beatsPerBar,
    downbeat: tsGrid.downbeat,
    beats: Array.from(tsGrid.beats),
    downbeats: Array.from(tsGrid.downbeats ?? [])
  }, c.ruled, 'grid')
  if (dGrid) fail(`${label}: ruled grid`, dGrid)
}

console.log(
  `\n${comparisons} grid(s) judged · octave court heard ${courtsEntered.octScope}x ` +
  `(+${courtsEntered.oct - courtsEntered.octScope} refused on scope, ${courtsEntered.octFired} convicted), ` +
  `doubling court ${courtsEntered.dbl}x, ${courtsEntered.meterApplied} odd bar(s) placed, ` +
  `${courtsEntered.abstained} abstention(s)`
)
if (courtsEntered.oct > 0 && courtsEntered.octScope === 0) {
  console.log(
    'NOTE  the octave court never reached a verdict — every entry was refused on scope.\n' +
    '      Its witnesses and its 2-of-3 threshold are UNTESTED by this run; pass longer\n' +
    '      stems (>= 24 bars at the tempo, i.e. ~53 s at 110 bpm) to exercise them.'
  )
}
if (courtsEntered.octScope > 0 && courtsEntered.octFired === 0) {
  // Measured on the tiled sample: every hearing returned 0 or 1 convicting
  // witness, so `votes >= 2` and `votes >= 3` decide alike and a threshold
  // change passes. Forcing the verdict IS caught (29 divergences), which is
  // what says the witnesses themselves are compared — but the boundary is
  // not, and the difference is worth printing rather than discovering later.
  console.log(
    `NOTE  the octave court heard ${courtsEntered.octScope} case(s) and convicted none, so its\n` +
    '      2-of-3 threshold is not exercised — no input reached two witnesses. A fixture\n' +
    '      that convicts (the FIXTURES pattern below) is what would close this.'
  )
}
if (courtsEntered.oct === 0 && courtsEntered.dbl === 0 && courtsEntered.abstained === comparisons) {
  console.log('NOTE  every input abstained — this run compared the abstention path and nothing else')
}
console.log(failures === 0 ? 'COURTS DECIDE PARITY: IDENTICAL' : `${failures} DIVERGENCE(S)`)
process.exit(failures === 0 ? 0 : 1)
