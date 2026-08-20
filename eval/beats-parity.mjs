#!/usr/bin/env node
/**
 * The beat detector's parity gate — STAGED. detectBeats is one pipeline with
 * no exported seams, so unlike melody and key a wrong answer cannot be
 * bisected from its output: the harness therefore compares the TS's own
 * `debug` object field by field against the same fields from the C++ port
 * (`singz-analyze beats`), in pipeline order, and reports the FIRST stage
 * that diverges. That is the difference between "Panzerkampf disagrees" and
 * "the tempo family disagrees on Panzerkampf, everything before it matches".
 *
 *   node eval/beats-parity.mjs --library     # the app's own library
 *   node eval/beats-parity.mjs [--bin <singz-analyze>] <project-dir> ...
 *   node eval/beats-parity.mjs                # the bundled sample
 *
 * Stages land as they are ported; a field the C++ does not emit yet is
 * skipped rather than failed, and the summary says how far the comparison
 * reached, so partial progress is visible instead of looking like a pass.
 *
 * The aux passed to the TS is deliberately the fill stems ONLY. The stages
 * ported so far read nothing else, and handing over bass/vocals/lyrics would
 * engage the downbeat votes and the courts — un-ported machinery whose
 * output would show up as a port divergence. That widens as the port does.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
let bin = null
let FIXTURE_PRECONDITIONS = {}
const dirs = []
/**
 * `--library` resolves the desktop's OWN projects root from settings.json,
 * because guessing it was a real and expensive mistake: every measurement in
 * one section of docs/PHONE-STANDALONE.md was taken against a stale
 * four-project copy under ~/Documents while the app's library — seventeen
 * projects, with ALIGNED lyrics where the stale copy had LRC estimates — sat
 * in iCloud where settings.json says it does. Parity survived (it compares
 * two implementations on whatever it is handed) but a documented claim about
 * which code paths the corpus reaches did not. A corpus is an input; this is
 * how you name it without typing a path you might get wrong.
 */
const libraryRoot = () => {
  for (const id of ['SingZ', 'singz', 'Electron']) {
    const f = join(process.env.HOME ?? '', 'Library', 'Application Support', id, 'settings.json')
    if (!existsSync(f)) continue
    try {
      const root = JSON.parse(readFileSync(f, 'utf8')).projectsRoot
      if (root && existsSync(root)) return root
    } catch {
      /* a settings.json we cannot read is not an error here — try the next */
    }
  }
  return null
}
/**
 * `--ml <raw.jsonl>` — Beat This! grids keyed by project directory name, as
 * eval/beats/make-ml-grids.mjs writes them. Without it every ML stage below
 * is UNREACHED and the harness says so by name; with it the two sides get the
 * same lattice and the adoption, the splice family and the bar-phase votes
 * are all under comparison.
 */
let mlById = new Map()
/** Was a --ml FILE given? Not `mlById.size` — the ML fixtures put their own
 *  lattices in that map, so it is never empty and the hint below never fired. */
let mlFileGiven = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
  else if (args[i] === '--ml') {
    const f = args[++i]
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.startsWith('{')) continue
      const r = JSON.parse(line)
      // A prob array PRESENT BUT EMPTY is the one shape the C++ MlGrid cannot
      // express (empty vector = the TS's `undefined`), and the difference is
      // not cosmetic: `[]` is truthy, so the TS would add the `mld` cue at
      // zero mass and divide every segment confidence by a larger weight sum.
      // Refuse the fixture rather than let that hide inside a passing run.
      for (const k of ['beat_prob', 'downbeat_prob']) {
        if (Array.isArray(r[k]) && r[k].length === 0) {
          console.error(`${f}: ${r.id} has an empty ${k} — present-but-empty is not representable, drop the key instead`)
          process.exit(2)
        }
      }
      mlById.set(r.id, {
        beats: r.beats,
        downbeats: r.downbeats,
        beatProb: r.beat_prob,
        downbeatProb: r.downbeat_prob,
        fps: r.fps
      })
    }
    mlFileGiven = true
    console.log(`ML       ${mlById.size} grid(s) from ${f}`)
  }
  else if (args[i] === '--library') {
    const root = libraryRoot()
    if (!root) {
      console.error('--library: no settings.json names a projectsRoot that exists')
      process.exit(2)
    }
    console.log(`LIBRARY  ${root}`)
    for (const d of readdirSync(root).sort()) {
      const p = join(root, d)
      if (existsSync(join(p, 'stems'))) dirs.push(p)
    }
  } else dirs.push(args[i])
}
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()
const lib = join(root, 'mobile', 'src', 'gen', 'analysis-lib.js')
if (!existsSync(lib)) {
  console.error('mobile/src/gen/analysis-lib.js is missing — run `npm ci` in mobile/')
  process.exit(2)
}
const { detectBeats, BEAT_DETECT_VERSION } = await import(pathToFileURL(lib).href)
if (dirs.length === 0) dirs.push(join(root, 'mobile', 'assets', 'sample'))
// The synthetic fixtures run EVERY time, alongside whatever was named. They
// are the only inputs that reach some of these stages at all: all four eval
// projects report `head ok`, so without them the head backcast's parity would
// be a statement about code that never executed. Cheap to build (a few seconds
// of synthesis) and they need no library.
if (!process.env.SINGZ_NO_FIXTURES) {
  const mod = await import(pathToFileURL(join(root, 'eval', 'beats', 'fixtures.mjs')).href)
  FIXTURE_PRECONDITIONS = mod.FIXTURE_PRECONDITIONS
  // The ML fixtures declare their own lattice, so the ML fork is covered even
  // on a run with no --ml grids at all. Merged AFTER the file so a fixture
  // name can never be shadowed by a library project of the same name.
  for (const [id, g] of Object.entries(mod.FIXTURE_ML)) {
    mlById.set(id, {
      beats: g.beats, downbeats: g.downbeats,
      beatProb: g.beat_prob, downbeatProb: g.downbeat_prob, fps: g.fps
    })
  }
  const made = mod.writeFixtures(mkdtempSync(join(tmpdir(), 'singz-beats-fixtures-')))
  // A fixture with no precondition entry would run UNGUARDED and print PASS —
  // which is the vacuity the preconditions exist to prevent, arriving by the
  // back door. Refuse to start instead.
  const unguarded = made.map((d) => basename(d)).filter((n) => !FIXTURE_PRECONDITIONS[n])
  if (unguarded.length > 0) {
    console.error(`fixtures without a FIXTURE_PRECONDITIONS entry: ${unguarded.join(', ')}`)
    console.error('every fixture must state the path it exists to reach — see eval/beats/fixtures.mjs')
    process.exit(2)
  }
  dirs.unshift(...made)
} else {
  // Suppressing them is legitimate (a quick run against one library project)
  // but it must never be invisible: without the fixtures nothing in this
  // harness reaches the head backcast at all.
  console.log('NOTE  synthetic fixtures suppressed (SINGZ_NO_FIXTURES) — the head backcast is NOT covered by this run')
}

const INST = ['guitar', 'piano', 'other']

function readWavMonoJs(path) {
  const b = readFileSync(path)
  let off = 12, fmt = null
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      let format = b.readUInt16LE(off + 8)
      const channels = b.readUInt16LE(off + 10)
      const rate = b.readUInt32LE(off + 12)
      const bits = b.readUInt16LE(off + 22)
      if (format === 0xfffe && size >= 26) format = b.readUInt16LE(off + 32)
      fmt = { format, channels, rate, bits }
    } else if (id === 'data') {
      const bytesPer = fmt.bits / 8
      const frameBytes = bytesPer * fmt.channels
      const frames = Math.floor(Math.min(size, b.length - off - 8) / frameBytes)
      const mono = new Float32Array(frames)
      for (let i = 0; i < frames; i++) {
        let acc = 0
        for (let c = 0; c < fmt.channels; c++) {
          const p = off + 8 + i * frameBytes + c * bytesPer
          let v
          if (fmt.format === 3) v = b.readFloatLE(p)
          else if (fmt.bits === 16) v = b.readInt16LE(p) / 32768
          else if (fmt.bits === 24) v = (((b[p] << 8) | (b[p + 1] << 16) | (b[p + 2] << 24)) >> 8) / 8388608
          else v = b.readInt32LE(p) / 2147483648
          acc = Math.fround(acc + v / fmt.channels)
        }
        mono[i] = acc
      }
      return { mono, rate: fmt.rate }
    }
    off += 8 + size + (size & 1)
  }
  throw new Error(`${path}: no data chunk`)
}
const duck = ({ mono, rate }) => ({
  sampleRate: rate, length: mono.length, duration: mono.length / rate,
  numberOfChannels: 1, getChannelData: () => mono
})

/**
 * The C++ reject strings that have no `debug.reject` counterpart in the TS —
 * the TS returns null at those points without writing a reason. Mapped to
 * null so "both refused, for the same cause" compares equal instead of
 * looking like a divergence.
 */
/** The TS's `cues` object is keyed by name and the C++'s is positional, so the
 *  comparison needs the insertion order written down once. `mld` — the neural
 *  downbeat head — is CONDITIONAL: without a model it is omitted rather than
 *  made uniform (conf divides by the summed weights), so a segment carries six
 *  entries or seven and the getter below filters this list to what is actually
 *  there. A name missing from this list would be silently dropped from the
 *  comparison, which is how `mld` went uncompared the first time, so an
 *  unrecognised key is reported instead of skipped. */
const CUE_ORDER = ['kick', 'ent', 'slam', 'bass', 'voc', 'line', 'mld']

/** The median inter-beat interval of a grid, derived the same way on both
 *  sides so neither can be reading a different array than the other. */
const medianGap = (beats) => {
  if (!beats || beats.length < 2) return 0
  const ivs = beats.slice(1).map((b, i) => b - beats[i]).sort((a, b) => a - b)
  return ivs[Math.floor(ivs.length / 2)]
}

const UNWRITTEN_REJECTS = new Set(['too short', 'no flux', 'no tempo family', 'no octave candidate'])
const cReject = (c) => (c.reject && !UNWRITTEN_REJECTS.has(c.reject) ? c.reject : null)

/**
 * The stages, in pipeline order. `get` pulls the value out of each side;
 * `undefined` from the C++ side means "not ported yet" and is REPORTED, never
 * silently dropped — a stage that stops being compared has to be as loud as
 * one that fails, or a whole branch can go missing behind a PASS (measured:
 * a run where the TS applied the instrument fill and the C++ did not printed
 * "all identical" with three fill stages quietly skipped).
 */
const STAGES = [
  ['reject', (ts) => ts.reject ?? null, cReject],
  // WHICH fill branch each side took, before any of its numbers — the branch
  // itself is the thing that can differ, and comparing only the numbers
  // inside it cannot see that.
  ['fill.branch', (ts) => (ts.fill ? (ts.fill.skipped ? 'skipped' : 'applied') : 'none'),
    (c) => (c.fill ? (c.fill.skipped ? 'skipped' : 'applied') : 'none')],
  // ---- the neural lattice's fork, which runs BEFORE the tracker ----------
  // Each of these keys is written CONDITIONALLY by the TS, so each getter
  // yields a sentinel string rather than undefined when the key is absent:
  // `undefined` on both sides means "neither side reached it" and is silently
  // skipped, which would hide a real disagreement about whether the stage ran
  // at all. 'none' is a value; absence is not.
  ['mlDouble', (ts) => (ts.mlDouble
    ? `${ts.mlDouble.bpm0}:${ts.mlDouble.gain}:${ts.mlDouble.multiLevel}:${ts.mlDouble.doubled}` : 'none'),
    (c) => (c.mlDouble
      ? `${c.mlDouble.bpm0}:${c.mlDouble.gain}:${c.mlDouble.multiLevel}:${c.mlDouble.doubled}` : 'none')],
  ['mlLattice', (ts) => (ts.mlLattice
    ? `${ts.mlLattice.bpm0}:${ts.mlLattice.doubled}:${ts.mlLattice.steadyFrac}:${ts.mlLattice.wins}` : 'none'),
    (c) => (c.mlLattice
      ? `${c.mlLattice.bpm0}:${c.mlLattice.doubled}:${c.mlLattice.steadyFrac}:${c.mlLattice.wins}` : 'none')],
  ['mlReject', (ts) => ts.mlReject ?? 'none', (c) => c.mlReject ?? 'none'],
  ['tau', (ts) => ts.tau, (c) => c.tau],
  ['consistency', (ts) => ts.consistency, (c) => c.consistency],
  ['fill.alpha', (ts) => ts.fill?.alpha, (c) => c.fill?.alpha],
  ['fill.gSum', (ts) => ts.fill?.gSum, (c) => c.fill?.gSum],
  ['fill.instMaxima', (ts) => ts.fill?.instMaxima, (c) => c.fill?.instMaxima],
  ['octaves.length', (ts) => ts.octaves?.length, (c) => c.octaves?.length],
  ['octaves[0].bpm', (ts) => ts.octaves?.[0]?.bpm, (c) => c.octaves?.[0]?.bpm],
  ['octaves[0].support', (ts) => ts.octaves?.[0]?.support, (c) => c.octaves?.[0]?.support],
  ['octaves[0].steadiness', (ts) => ts.octaves?.[0]?.steadiness, (c) => c.octaves?.[0]?.steadiness],
  ['octaves[0].alternation', (ts) => ts.octaves?.[0]?.alternation, (c) => c.octaves?.[0]?.alternation],
  ['octaves[0].score', (ts) => ts.octaves?.[0]?.score, (c) => c.octaves?.[0]?.score],
  // The CHOSEN candidate. `octaves` stays in the TS's mult order (1, 2, 0.5),
  // so without these a port that picked a DIFFERENT octave would move nothing
  // the harness looks at.
  // The octave near-tie window, and the model's own ambivalence that widens
  // it. This is the ONE aux.ml read inside trackFromDrums — it decides a
  // whole-song halve or double and leaves no other trace — and it went
  // uncompared through a 23-input run because nothing here asked for it.
  // 'none' on both sides is a real value, not a skip: the TS writes this key
  // on every drums-path song, so an absent one is itself a divergence.
  ['octaveTie', (ts) => (ts.octaveTie ? `${ts.octaveTie.win}:${ts.octaveTie.mlBimodal}` : 'none'),
    (c) => (c.octaveTie ? `${c.octaveTie.win}:${c.octaveTie.mlBimodal}` : 'none')],
  ['support', (ts) => ts.support, (c) => c.support],
  ['activeFrac', (ts) => ts.activeFrac, (c) => c.activeFrac],
  ['steadiness', (ts) => ts.steadiness, (c) => c.steadiness],
  ['rough', (ts) => ts.rough, (c) => c.rough],
  // The per-span verdicts of the fill's quality gate, then the lattice
  // itself — the beat TIMES are what everything downstream is built on, so
  // they are compared exactly, as a joined string of full-precision values.
  // `?.length`, not `?` — an EMPTY array is truthy, so the plain check
  // compared the TS's `undefined` (it writes the field only when there is at
  // least one span) against the C++'s '', and every project without a fill
  // span became a false divergence. The bundled sample is exactly that case.
  ['spanOk', (ts) => (ts.spanOk?.length ? ts.spanOk.map((s) => `${s.a}:${s.b}:${s.ok}`).join('|') : undefined),
    (c) => (c.spanOk?.length ? c.spanOk.map((s) => `${s.a}:${s.b}:${s.ok}`).join('|') : undefined)],
  // Both sides off the FINISHED grid, not the tracker's lattice — the head
  // backcast can add beats in front of it, and `debug.beats`/`debug.medSec`
  // are recorded before that happens. (The fixture that fires the backcast
  // caught this the moment it was added: 144 against the lattice's 120.)
  // ---- adoption and the splice family, between the tracker and the grid ---
  ['mlNormalized', (ts) => (ts.mlNormalized
    ? `${ts.mlNormalized.from}:${ts.mlNormalized.to}:${ts.mlNormalized.medSec}` : 'none'),
    (c) => (c.mlNormalized ? `${c.mlNormalized.from}:${c.mlNormalized.to}:${c.mlNormalized.medSec}` : 'none')],
  ['mlView', (ts) => (ts.mlView
    ? `${ts.mlView.ratio}:${ts.mlView.scoreA}:${ts.mlView.scoreB}:${ts.mlView.picked}` : 'none'),
    (c) => (c.mlView ? `${c.mlView.ratio}:${c.mlView.scoreA}:${c.mlView.scoreB}:${c.mlView.picked}` : 'none')],
  // Every field of every row, `ca`/`cb` included: those two are the per-span
  // parity vote, and the TS carries them forward across a REFUSED splice (it
  // clears `lastCarry` only on a successful one), so a port that tidied that
  // up would move them one row and change nothing else.
  ['mlSplice', (ts) => (ts.mlSplice?.length
    ? ts.mlSplice.map((r) => `${r.aSec}:${r.bSec}:${r.removed}:${r.added}:${r.why}:${r.ca ?? '-'}:${r.cb ?? '-'}`).join('|')
    : 'none'),
    (c) => (c.mlSplice?.length
      ? c.mlSplice.map((r) => `${r.aSec}:${r.bSec}:${r.removed}:${r.added}:${r.why}:${r.ca ?? '-'}:${r.cb ?? '-'}`).join('|')
      : 'none')],
  // Which front end actually produced the grid: 'drums', 'ml', or the
  // bare-mix 'ml-verbatim' early return.
  ['lattice', (ts) => ts.lattice ?? 'none', (c) => c.lattice ?? 'none'],
  ['beats.length', (ts) => ts.__beats?.length, (c) => c.gridBeats],
  ['medSec', (ts) => ts.__medSec, (c) => medianGap(c.beatsSec)],
  ['beatsSec', (ts) => ts.__beats?.join(','), (c) => c.beatsSec?.join(',')],
  // debug.voids is the tracker's own void list, ROUNDED TO 0.1 s by the TS
  // before it is recorded — so the comparison rounds the C++ the same way
  // rather than pretending the debug channel carries full precision. (The
  // TS omits the field entirely when there are no voids; `none` on both
  // sides is the agreement there.)
  // The meter, from detectBeats' RETURN — same gate as the lattice stages,
  // since a court halve can change it too.
  ['beatsPerBar', (ts) => ts.__bpb, (c) => c.beatsPerBar],
  ['voids', (ts) => (ts.voids ? ts.voids.map((v) =>
    `${v.aSec}:${v.bSec}:${v.leading}:${v.trailing}:${v.filled}`).join('|') : 'none'),
    (c) => (c.voids?.length ? c.voids.map((v) =>
      `${Math.round(v.aSec * 10) / 10}:${Math.round(v.bSec * 10) / 10}:${v.leading}:${v.trailing}:${v.filled}`)
      .join('|') : 'none')],
  // The stamp, from both sides — a bump the stored-analysis rule demands
  // would otherwise leave the C++ copy silently behind.
  // The vote, stage by stage. segCues is the whole per-segment verdict table
  // (span, chosen rotation, confidence to the TS's own 3 decimals) — it is
  // written before the courts, so unlike the bars below it needs no gate.
  ['mlSeams', (ts) => (ts.mlSeams?.length ? ts.mlSeams.join(',') : 'none'),
    (c) => (c.mlSeams?.length ? c.mlSeams.join(',') : 'none')],
  ['segCues', (ts) => (ts.segCues?.length
    ? ts.segCues.map((s) => `${s.a}:${s.b}:${s.rot}:${s.conf}`).join('|') : 'none'),
    (c) => (c.segCues?.length ? c.segCues.map((s) => `${s.a}:${s.b}:${s.rot}:${s.conf}`).join('|') : 'none')],
  // The six distributions INSIDE each verdict, in the TS's own order and at
  // its own 2dp. The line above compares only what the vote concluded — one
  // cue could diverge while the argmax and the margin both survived it, and
  // the first sign would be a wrong bar line much further down.
  ['segCues.cues', (ts) => (ts.segCues?.length
    ? ts.segCues.map((s) => {
      const unknown = Object.keys(s.cues ?? {}).filter((n) => !CUE_ORDER.includes(n))
      if (unknown.length > 0) return `UNKNOWN CUE ${unknown.join(',')} — add it to CUE_ORDER`
      return CUE_ORDER.filter((n) => n in (s.cues ?? {})).map((n) => s.cues[n].join(' ')).join(';')
    }).join('|') : 'none'),
    (c) => (c.segCues?.length
      ? c.segCues.map((s) => (s.cues ?? []).map((d) => d.join(' ')).join(';')).join('|') : 'none')],
  // Cuts that were PROPOSED (harmGain is written whenever any was) and cuts
  // that survived the +0.3 global harmonic gain. `none` on both sides is the
  // agreement, which is the common case — a re-phase is rare and drastic.
  ['harmGain', (ts) => (ts.harmGain ? `${ts.harmGain.plain}:${ts.harmGain.cut}` : 'none'),
    (c) => (c.harmGain ? `${c.harmGain.plain}:${c.harmGain.cut}` : 'none')],
  ['phaseCuts', (ts) => (ts.phaseCuts?.length ? ts.phaseCuts.join(',') : 'none'),
    (c) => (c.phaseCuts?.length ? c.phaseCuts.join(',') : 'none')],
  // Gated, and NOT because of the courts: `backcastHead` (analysis.ts:1526)
  // runs BEFORE the sanitize that writes this field (:1543), and a rebuilt
  // head changes both the bar list and the beat count it is computed from —
  // it can even leave `downbeats` undefined, so the field is never written.
  // A refused drum-free intro is all it takes.
  ['sanitized', (ts) => ('__sanitized' in ts
    ? (ts.__sanitized ? `${ts.__sanitized.before}:${ts.__sanitized.after}` : 'none') : undefined),
    (c) => (c.sanitized ? `${c.sanitized.before}:${c.sanitized.after}` : 'none')],
  // The bars themselves, from detectBeats' RETURN. A song may legitimately
  // have none (no anchor was confident enough) — 'none' on both sides is
  // agreement, and the rotation index still carries its bar structure.
  ['downbeat', (ts) => ts.__downbeat, (c) => c.downbeat],
  // `in`, not `?.` — a getter that folds "this stage was never reached" into
  // the same 'none' it uses for "this song legitimately has no bars" cannot be
  // skipped, because the skip is keyed on `undefined`. The gate those skips
  // served is gone (every stage is ported), but the shape is worth keeping:
  // this file has read an absent field as evidence three times.
  ['downbeats', (ts) => ('__downbeats' in ts
    ? (ts.__downbeats?.length ? ts.__downbeats.join(',') : 'none') : undefined),
    (c) => (c.downbeats?.length ? c.downbeats.join(',') : 'none')],
  // The head backcast. `headWhy` is the verdict — the TS writes a string on
  // one path and an object on two others, so both sides are normalised to the
  // shape's NAME first and its contents second.
  ['spanPhase', (ts) => (ts.spanPhase?.length
    ? ts.spanPhase.map((r) => `${r.aSec}:${r.bSec}:${r.rot}:${r.margin}`).join('|') : 'none'),
    (c) => (c.spanPhase?.length ? c.spanPhase.map((r) => `${r.aSec}:${r.bSec}:${r.rot}:${r.margin}`).join('|') : 'none')],
  ['headWhy', (ts) => (ts.headWhy === undefined ? ''
    : typeof ts.headWhy === 'string' ? ts.headWhy
    : ts.headWhy.verdict === 'head ok' ? 'head ok' : 'judged'), (c) => c.headWhy],
  ['headWhy.headOk', (ts) => (ts.headWhy?.verdict === 'head ok'
    ? `${ts.headWhy.anchor}:${ts.headWhy.at}:${ts.headWhy.first}` : 'n/a'),
    (c) => (c.headOk ? `${c.headOk.anchor}:${c.headOk.at}:${c.headOk.first}` : 'n/a')],
  ['headWhy.judged', (ts) => {
    const w = ts.headWhy
    if (!w || typeof w === 'string' || w.verdict === 'head ok') return 'n/a'
    const tail = 'headTracked' in w ? `:${w.headTracked}:${w.replace}` : ''
    return `${w.anchor}:${w.at}:${w.unsteady}:${w.missing}:${w.onsets}:${w.onsetsTrusted}${tail}` +
      (w.walk ? `:walk=${w.walk}` : '')
  }, (c) => {
    const w = c.headJudged
    if (!w) return 'n/a'
    const tail = 'headTracked' in w ? `:${w.headTracked}:${w.replace}` : ''
    return `${w.anchor}:${w.at}:${w.unsteady}:${w.missing}:${w.onsets}:${w.onsetsTrusted}${tail}` +
      (w.walk ? `:walk=${w.walk}` : '')
  }],
  ['headOnsets', (ts) => (ts.headOnsets
    ? `${ts.headOnsets.per}:${ts.headOnsets.periodic}/${ts.headOnsets.of}:${ts.headOnsets.t.join(' ')}` : 'none'),
    (c) => (c.headOnsets
      ? `${c.headOnsets.per}:${c.headOnsets.periodic}/${c.headOnsets.of}:${c.headOnsets.t.join(' ')}` : 'none')],
  ['headBackcast', (ts) => (ts.headBackcast
    ? `${ts.headBackcast.replaced}:${ts.headBackcast.added}:${ts.headBackcast.snapped}:${ts.headBackcast.phase}`
    : 'none'),
    (c) => (c.headBackcast
      ? `${c.headBackcast.replaced}:${c.headBackcast.added}:${c.headBackcast.snapped}:${c.headBackcast.phase}`
      : 'none')],
  // The reported tempo and the suspect marks — both come off the finished
  // grid, so both ride the same gate as the bars.
  // The courts, COARSELY: whether they were asked, whether they abstained, and
  // how much they did. Their internals have two gates of their own
  // (eval/courts-parity.mjs for the extractors, eval/courts-decide-parity.mjs
  // for the verdicts) and duplicating those here would report one divergence
  // twice. What this stage adds is that detectBeats hands them the same grid
  // and adopts the same answer — which neither of those gates can see.
  ['v20', (ts) => (ts.v20
    ? `${ts.v20.abstained === true}:${ts.v20.cands ?? 0}:${ts.v20.halfBar === true}:${ts.v20.applied?.length ?? 0}`
    : 'none'),
    (c) => (c.v20 ? `${c.v20.abstained}:${c.v20.cands}:${c.v20.halfBar}:${c.v20.applied}` : 'none')],
  // The head backcast's SECOND chance, run only on a grid the octave court
  // halved. Its presence is the evidence that the halve happened and the head
  // was re-judged at the notation's octave.
  ['headAfterHalve', (ts) => {
    const h = ts.headAfterHalve
    if (!h) return 'none'
    const why = h.headWhy === undefined ? '' : typeof h.headWhy === 'string' ? h.headWhy
      : h.headWhy.verdict === 'head ok' ? 'head ok' : 'judged'
    return `${why}:${h.headBackcast
      ? `${h.headBackcast.replaced}:${h.headBackcast.added}:${h.headBackcast.snapped}:${h.headBackcast.phase}`
      : 'none'}`
  }, (c) => (c.headAfterHalve
    ? `${c.headAfterHalve.headWhy}:${c.headAfterHalve.backcast
      ? `${c.headAfterHalve.backcast.replaced}:${c.headAfterHalve.backcast.added}:${c.headAfterHalve.backcast.snapped}:${c.headAfterHalve.backcast.phase}`
      : 'none'}`
    : 'none')],
  ['bpm', (ts) => ts.__bpm, (c) => c.bpm],
  ['suspectAt', (ts) => ('__suspectAt' in ts
    ? (ts.__suspectAt?.length ? ts.__suspectAt.join(',') : 'none') : undefined),
    (c) => (c.suspectAt?.length ? c.suspectAt.join(',') : 'none')],
  ['detVersion', () => BEAT_DETECT_VERSION, (c) => c.detVersion]
]

let failed = 0
/**
 * Which branches of the ML fork this run actually EXECUTED, counted off the
 * TS's own debug. A parity report that says IDENTICAL without saying what it
 * ran is the failure this file's fixtures exist to prevent, one level up: the
 * gate can be green because both sides agree, or green because neither side
 * did anything. The courts learned this the expensive way — a summary line
 * counted an octave court's SCOPE REFUSALS as appearances, and the gate was
 * judging an empty room for as long as it existed. So the branches are named
 * and the ones nothing reached are printed as a NOTE, not omitted.
 */
const REACHED = {
  'ml offered': (d) => d.mlLattice !== undefined,
  'ml refused (unsteady)': (d) => d.mlReject !== undefined,
  // The tracker's own aux.ml read — a widened window is the model saying the
  // octave race is real. Listed apart from the branches of the ML FORK
  // because it is not one: it lives inside trackFromDrums.
  'octave tie widened': (d) => d.octaveTie?.win === 0.12,
  'octave test reached': (d) => d.mlDouble !== undefined,
  'octave test fired': (d) => d.mlDouble?.doubled === true,
  'lattice adopted': (d) => d.lattice === 'ml',
  'bare-mix verbatim': (d) => d.lattice === 'ml-verbatim',
  'level normalized': (d) => d.mlNormalized !== undefined,
  'halved view picked': (d) => d.mlView !== undefined,
  'splice: leading': (d) => d.mlSplice?.some((r) => r.why === 'leading'),
  'splice: void': (d) => d.mlSplice?.some((r) => r.why === 'void'),
  'splice: void-filled': (d) => d.mlSplice?.some((r) => r.why === 'void-filled'),
  'splice: defect': (d) => d.mlSplice?.some((r) => r.why === 'defect'),
  'splice: defect-2x': (d) => d.mlSplice?.some((r) => r.why === 'defect-2x'),
  'per-span parity vote': (d) => d.mlSplice?.some((r) => r.ca !== undefined),
  'bar seams cut segments': (d) => d.mlSeams?.length > 0,
  'span rotation re-voted': (d) => d.spanPhase?.length > 0,
  'waltz meter (3)': (d, g) => d.lattice === 'ml' && g?.beatsPerBar === 3,
  'drumless meter histogram': (d, g) => d.lattice === 'ml' && d.segCues?.length === 0 && g?.beatsPerBar !== undefined,
  'courts engaged': (d) => d.v20 !== undefined && d.v20.abstained !== true,
  'courts abstained': (d) => d.v20?.abstained === true,
  'head re-judged after halve': (d) => d.headAfterHalve !== undefined
}
const reachedBy = new Map(Object.keys(REACHED).map((k) => [k, []]))
for (const dir of dirs) {
  const stemDir = join(dir, 'stems')
  if (!existsSync(stemDir)) { console.log(`SKIP  ${dir} (no stems/)`); continue }
  const files = readdirSync(stemDir)
  const tmp = mkdtempSync(join(tmpdir(), 'singz-beats-parity-'))
  const wavFor = (id) => {
    const exact = files.find((f) => f === `${id}.wav`)
    if (exact) return join(stemDir, exact)
    const any = files.find((f) => f.startsWith(`${id}.`))
    if (!any) return null
    const out = join(tmp, `${id}.wav`)
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(stemDir, any), '-c:a', 'pcm_s16le', out])
    return out
  }
  const drumsPath = wavFor('drums')
  if (!drumsPath) { console.log(`SKIP  ${dir} (no drums stem — no grid, by rule)`); continue }
  const instPaths = INST.map(wavFor).filter(Boolean)

  // Aux: the WIDEST the app ever builds — the fill stems, the bass, the
  // vocals, the lyric line starts, the aligned words and (with --ml) the
  // neural lattice. Every stage is ported now, so nothing is withheld; the
  // paragraph below the CLI call records what each of these switches on.
  const vocalsPath = wavFor('vocals')
  const bassPath = wavFor('bass')
  const lyricsFile = join(dir, 'lyrics.json')
  const lyricLines = existsSync(lyricsFile) ? (JSON.parse(readFileSync(lyricsFile, 'utf8')).lines ?? []) : []
  const lineStarts = lyricLines.map((l) => l.start).filter((t) => Number.isFinite(t))
  // Aligned words, exactly as App.tsx flattens them. detectBeats never reads
  // them itself — they are the v20 meter court's witness — but the courts run
  // here now, so withholding them would leave that court testifying blind on
  // both sides and prove nothing about it.
  const words = lyricLines
    .flatMap((l) => (l.words ?? []).map((w) => ({ s: w.s, e: w.e })))
    .filter((w) => Number.isFinite(w.s) && Number.isFinite(w.e))
  const ml = mlById.get(basename(dir)) ?? null
  // The C++ takes the lattice as whitespace tokens rather than JSON: `String(x)`
  // is JS's shortest round-trip repr and strtod is correctly rounded, so every
  // value is the SAME double on both sides. A %.17g hop would not be — see the
  // Foundation note in beat_this.h.
  let mlFile = null
  if (ml) {
    const section = (name, arr) => (Array.isArray(arr) ? `${name} ${arr.length} ${arr.map(String).join(' ')}\n` : '')
    mlFile = join(tmp, 'ml.txt')
    writeFileSync(mlFile, `fps ${ml.fps}\n${section('beats', ml.beats)}${section('downbeats', ml.downbeats)}` +
      `${section('beatProb', ml.beatProb)}${section('downbeatProb', ml.downbeatProb)}`)
  }
  const tsDbg = {}
  // The RETURN value matters as well as the debug: four of the C++'s reject
  // strings name points where the TS returns null WITHOUT writing a reason,
  // so `debug.reject` alone cannot tell "both refused" from "only one did".
  const tsGrid = detectBeats(
    duck(readWavMonoJs(drumsPath)),
    {
      inst: instPaths.map((p) => duck(readWavMonoJs(p))),
      ...(vocalsPath ? { vocals: duck(readWavMonoJs(vocalsPath)) } : {}),
      ...(bassPath ? { bass: duck(readWavMonoJs(bassPath)) } : {}),
      ...(words.length > 0 ? { words } : {}),
      ...(ml ? { ml } : {}),
      lineStarts
    },
    tsDbg
  )

  // A fixture must reach the path it was built for, before its parity counts.
  const pre = FIXTURE_PRECONDITIONS[basename(dir)]
  if (pre && !pre.check(tsDbg, tsGrid ?? { beats: [] })) {
    console.log(`FAIL  ${dir}`)
    console.log(`      fixture no longer reaches its own path — it must ${pre.what}`)
    console.log(`      headWhy=${JSON.stringify(tsDbg.headWhy)} beats=${tsGrid?.beats?.length} first=${tsGrid?.beats?.[0]}`)
    failed++
    continue
  }

  const cliArgs = ['beats', '--drums', drumsPath, ...instPaths.flatMap((p) => ['--inst', p]),
    ...(vocalsPath ? ['--vocals', vocalsPath] : []),
    ...(bassPath ? ['--bass', bassPath] : []),
    ...(mlFile ? ['--ml', mlFile] : []),
    ...words.flatMap((w) => ['--word', `${w.s}:${w.e}`]),
    // Full precision, not the JSON's 2 decimals: `--line 0.94` and the TS's
    // 0.94 must be the same double or a beat-snap can land one beat apart.
    ...lineStarts.flatMap((t) => ['--line', String(t)])]
  const c = JSON.parse(execFileSync(bin, cliArgs, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString())

  // Every stage of detectBeats is ported now — the ML fork, the splice family,
  // the head backcast and the v20 courts — so the grid the TS returns and the
  // grid the C++ returns are answers to the same question, and there is
  // nothing left to gate out. The three lattice stages used to be withheld
  // whenever the courts engaged or an ML lattice produced the grid, because
  // comparing a post-mutation TS grid against a pre-mutation C++ one reports a
  // divergence that is really an un-ported stage. Both conditions are now the
  // POINT of the run rather than a reason to look away: with `--ml` and a bass
  // stem this harness drives the widest aux the app ever builds.
  //
  // What remains worth remembering from that era: the courts' abstention is
  // STRUCTURAL, not a property of these songs. buildCourtEvidence fills `runs`
  // only inside `if (bass22)` (courts.ts:561 — the bass names the roots), so
  // dropping `--bass` puts every court back to sleep, and `--ml` alone also
  // wakes them (doubleCourt's only witness IS the model, and applyCourts
  // abstains on `runs.length < 8 && !ev.ml`). A run that passes neither flag
  // is a narrower test than it looks; the summary line says which it was.
  if (tsGrid) {
    tsDbg.__beats = tsGrid.beats
    tsDbg.__medSec = medianGap(tsGrid.beats)
    tsDbg.__bpb = tsGrid.beatsPerBar
    tsDbg.__downbeat = tsGrid.downbeat
    tsDbg.__downbeats = tsGrid.downbeats
    // Not from the grid, but written after backcastHead, so it belongs with
    // it. `?? null` keeps the property present-but-empty, which is how "the TS
    // sanitized nothing" stays distinguishable from "not compared".
    tsDbg.__sanitized = tsDbg.sanitized ?? null
    tsDbg.__bpm = tsGrid.bpm
    tsDbg.__suspectAt = tsGrid.suspectAt ?? null
  }

  let firstBad = null
  let compared = 0
  const skipped = []
  let bothRefused = false
  for (const [name, getTs, getC] of STAGES) {
    const a = getTs(tsDbg)
    const b = getC(c)
    const same = typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) : a === b
    if (name === 'reject') {
      compared++
      if (!same) { firstBad = { name, ts: a, c: b }; break }
      // Both refused: everything downstream is unreached on BOTH sides, and
      // comparing it would report the TS's `undefined` against the C++'s
      // printed zeros. Agreeing to refuse IS the pass — refusals are what the
      // reject strings exist for.
      //
      // The test is the RETURN VALUE on both sides, never the reject string.
      // It used to break out as soon as the TS had written one, which was
      // sound while `debug.reject` could only be written on a path that
      // returned null — and stopped being sound the moment the ML lattice
      // could rescue a song the tracker had already refused. Father and Son is
      // exactly that song: the tracker writes "windows disagree on a tempo",
      // the model's lattice is adopted, a grid comes back, and the old test
      // read the leftover string as a refusal and compared ONE stage of
      // forty-nine. It reported PASS for as long as it did that. Found by
      // mutating the octave gate and watching a mutant that should have
      // rewritten the whole grid survive.
      if (tsGrid === null && c.ok === false) { bothRefused = true; break }
      continue
    }
    if (a === undefined && b === undefined) continue      // neither side reached it
    if (b === undefined) { skipped.push(name); continue } // not ported yet — REPORTED
    compared++
    if (!same) { firstBad = { name, ts: a, c: b }; break }
  }
  for (const [name, hit] of Object.entries(REACHED)) {
    try {
      if (hit(tsDbg, tsGrid)) reachedBy.get(name).push(basename(dir))
    } catch {
      /* a debug shape this probe does not understand is not a reach */
    }
  }
  const ok = firstBad === null && compared > 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${dir}`)
  console.log(`      ${compared}/${STAGES.length} stage(s) compared` +
    (bothRefused
      ? tsDbg.reject
        ? ` · both refused: "${tsDbg.reject}"`
        : ` · both refused: "${c.reject}" — the TS returns null here without naming a reason`
      : '') +
    (firstBad ? ` · FIRST DIVERGENCE at ${firstBad.name}: ts=${firstBad.ts} c++=${firstBad.c}` : '') +
    (!firstBad && !bothRefused ? ' · all identical' : '') +
    (skipped.length ? ` · NOT PORTED: ${skipped.join(', ')}` : '') +
    ` · tau=${tsDbg.tau?.toFixed?.(3) ?? '-'}`)
}
console.log('\nML FORK COVERAGE — what this run actually executed:')
const unreached = []
for (const [name, songs] of reachedBy) {
  if (songs.length === 0) unreached.push(name)
  else console.log(`  ${String(songs.length).padStart(3)}x  ${name.padEnd(28)} ${songs.slice(0, 3).join(', ')}${songs.length > 3 ? ', …' : ''}`)
}
/**
 * Gates this corpus is known NOT to exercise, with the evidence. Every entry
 * was found by mutating the constant and watching the run stay green — the
 * only way to tell "covered" from "reached but inert", and the difference the
 * courts' own gate spent its whole life on the wrong side of. Printed rather
 * than filed away, because a green run that does not say what it left out
 * reads as a green run that left out nothing.
 */
const UNEXERCISED = [
  ["splice's v16 level gate (0.6 < m/med < 1.6)",
    'removing it entirely changes no grid here — no span the model repaired sits at the wrong level in these lattices'],
  ["levelNormalize's barAt tolerance (0.25 * med)",
    'tightening it to 0.15 changes nothing: Beat This! snaps every downbeat ONTO a beat, so the distance is always 0'],
  ['the splice debug\'s carry-over across a REFUSED splice',
    'clearing it early changes no row here; it is a debug field only — no grid depends on it']
]
console.log('KNOWN UNEXERCISED — reached but inert, proved by mutation:')
for (const [what, why] of UNEXERCISED) console.log(`  - ${what}\n      ${why}`)
if (unreached.length > 0) {
  console.log(`NOTE  ${unreached.length} branch(es) UNREACHED by this run — their parity is a statement`)
  console.log('      about code that did not execute:')
  for (const n of unreached) console.log(`        - ${n}`)
  if (!mlFileGiven) console.log('      (pass --ml <grids.jsonl> — see eval/beats/make-ml-grids.mjs)')
}
console.log(failed === 0 ? '\nBEATS PARITY (staged): IDENTICAL so far' : `\n${failed} PROJECT(S) DIVERGE`)
process.exit(failed === 0 ? 0 : 1)
