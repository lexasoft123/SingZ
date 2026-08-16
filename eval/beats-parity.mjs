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
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
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
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bin') bin = args[++i]
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
/** The stages that compare the tracker's lattice against detectBeats' RETURN
 *  — only meaningful while no un-ported downstream stage has rewritten it. */
const LATTICE_STAGES = new Set([
  'beats.length', 'medSec', 'beatsSec', 'beatsPerBar',
  // The bars come from the RETURN too, and a court can re-place them even
  // when the beat times hold. `sanitized` is here for a DIFFERENT un-ported
  // stage — see its entry: the head backcast runs before it, not after.
  'downbeat', 'downbeats', 'sanitized', 'bpm', 'suspectAt'
])

/** The TS's `cues` object is keyed by name and the C++'s is positional, so
 *  the comparison needs the insertion order written down once. */
const CUE_ORDER = ['kick', 'ent', 'slam', 'bass', 'voc', 'line']

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
  // The three LATTICE stages, and they are conditional — see `latticeUsable`.
  // Both sides off the FINISHED grid, not the tracker's lattice — the head
  // backcast can add beats in front of it, and `debug.beats`/`debug.medSec`
  // are recorded before that happens. (The fixture that fires the backcast
  // caught this the moment it was added: 144 against the lattice's 120.)
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
  ['segCues', (ts) => (ts.segCues?.length
    ? ts.segCues.map((s) => `${s.a}:${s.b}:${s.rot}:${s.conf}`).join('|') : 'none'),
    (c) => (c.segCues?.length ? c.segCues.map((s) => `${s.a}:${s.b}:${s.rot}:${s.conf}`).join('|') : 'none')],
  // The six distributions INSIDE each verdict, in the TS's own order and at
  // its own 2dp. The line above compares only what the vote concluded — one
  // cue could diverge while the argmax and the margin both survived it, and
  // the first sign would be a wrong bar line much further down.
  ['segCues.cues', (ts) => (ts.segCues?.length
    ? ts.segCues.map((s) => CUE_ORDER.map((n) => (s.cues?.[n] ?? []).join(' ')).join(';')).join('|') : 'none'),
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
  // `in`, not `?.` — a getter that folds "the stage was gated off" into the
  // same 'none' it uses for "this song legitimately has no bars" makes the
  // LATTICE_STAGES skip dead: the day bass lands and the courts stop
  // abstaining, this would compare the TS's ABSENCE against the C++'s real
  // bars. That is the same absent-field mistake this file has now made three
  // times, so the shape is worth naming: the skip is keyed on `undefined`,
  // therefore only a stage that can actually YIELD undefined can be skipped.
  ['downbeats', (ts) => ('__downbeats' in ts
    ? (ts.__downbeats?.length ? ts.__downbeats.join(',') : 'none') : undefined),
    (c) => (c.downbeats?.length ? c.downbeats.join(',') : 'none')],
  // The head backcast. `headWhy` is the verdict — the TS writes a string on
  // one path and an object on two others, so both sides are normalised to the
  // shape's NAME first and its contents second.
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
  ['bpm', (ts) => ts.__bpm, (c) => c.bpm],
  ['suspectAt', (ts) => ('__suspectAt' in ts
    ? (ts.__suspectAt?.length ? ts.__suspectAt.join(',') : 'none') : undefined),
    (c) => (c.suspectAt?.length ? c.suspectAt.join(',') : 'none')],
  ['detVersion', () => BEAT_DETECT_VERSION, (c) => c.detVersion]
]

let failed = 0
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

  // Aux: the fill stems, the vocals and the lyric line starts — every input
  // the ported stages read. BASS is deliberately still withheld: it is the one
  // that flips `applyCourts` from abstaining to active (buildCourtEvidence
  // fills its chord runs only inside `if (bass22)`), which would put an
  // un-ported 1500-line stage between the two sides. Vocals and lyrics engage
  // no court, so they belong here — and without them two of the six segment
  // cues would be uniform on both sides and their parity would prove nothing.
  const vocalsPath = wavFor('vocals')
  const lyricsFile = join(dir, 'lyrics.json')
  const lineStarts = existsSync(lyricsFile)
    ? (JSON.parse(readFileSync(lyricsFile, 'utf8')).lines ?? [])
        .map((l) => l.start).filter((t) => Number.isFinite(t))
    : []
  const tsDbg = {}
  // The RETURN value matters as well as the debug: four of the C++'s reject
  // strings name points where the TS returns null WITHOUT writing a reason,
  // so `debug.reject` alone cannot tell "both refused" from "only one did".
  const tsGrid = detectBeats(
    duck(readWavMonoJs(drumsPath)),
    {
      inst: instPaths.map((p) => duck(readWavMonoJs(p))),
      ...(vocalsPath ? { vocals: duck(readWavMonoJs(vocalsPath)) } : {}),
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
    // Full precision, not the JSON's 2 decimals: `--line 0.94` and the TS's
    // 0.94 must be the same double or a beat-snap can land one beat apart.
    ...lineStarts.flatMap((t) => ['--line', String(t)])]
  const c = JSON.parse(execFileSync(bin, cliArgs, { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }).toString())

  // detectBeats' returned `beats` are the tracker's `beatsSec` ONLY when
  // nothing downstream rewrote them — and two things can, on exactly the
  // inputs used here. `applyCourts` runs whenever there are harmonic stems
  // (aux.inst IS the chord layer), and its octave court needs no ML model:
  // a HALVE rewrites the lattice outright. `backcastHead` is called
  // unconditionally and rebuilds the head when the lead-in is unsteady or
  // missing. Neither is ported yet, so where either fired the TS grid is
  // post-mutation and the C++'s is not — comparing them would report a
  // divergence that is really an un-ported stage.
  //
  // So the three lattice stages are gated on the TS's OWN debug rather than
  // on an assumption, and when they are skipped the harness says so by name
  // through the same NOT PORTED channel as anything else unbuilt. The test
  // is POSITIVE — "nothing downstream ran" — not a list of the downstream
  // actions believed to move times: enumerating those means being right
  // about every branch of 1500 un-ported lines, and being wrong is silent.
  //
  // On the courts the abstention is STRUCTURAL, not a property of these
  // songs: buildCourtEvidence fills `runs` only inside `if (bass22)`
  // (courts.ts:561 — the bass names the roots), and this harness passes no
  // bass, so `runs` is [] for every song and applyCourts abstains at
  // courts.ts:1500. More inst stems change nothing; adding BASS flips it from
  // none to many in one step, which is the thing to remember when the aux
  // widens for the next slice.
  const courtsIdle = tsDbg.v20 === undefined || tsDbg.v20.abstained === true
  // The head backcast used to be gated out here alongside the courts, with a
  // default-closed probe over its three decline shapes. It is PORTED now, so
  // the C++ rebuilds the same head — and the gate would be hiding the one
  // stage that most wants comparing. What is left is the courts alone.
  // Positive, not "the courts did not object": `debug.lattice` records which
  // front end actually produced the grid, so this asks the TS to CONFIRM the
  // drums-first path rather than inferring it from the absence of an ml key in
  // an aux literal a few lines up. Same discipline as the courts probe, and
  // the reason is the same — this file has read an absent field as evidence
  // three times.
  // ONE field, and it proves the rest. Every non-null return from
  // `latticeFromMl` writes `debug.mlLattice` unconditionally, so its absence
  // proves the function bailed at its own `if (!ml || …)` guard — hence no
  // mlChoice, hence no adoption, no splice, no mlSpliceRanges, no mlSeams.
  // (The first version of this enumerated three OTHER fields, none of which
  // is the splice's own record: `debug.mlSplice` is, `lattice` reads 'drums'
  // *during* a splice because the splice only runs when the ML lattice was
  // NOT adopted, and both of the others are written behind extra gates. A
  // hedge that watches the wrong fields is worse than no hedge, because it
  // reads as covered.)
  const noMl = tsDbg.mlLattice === undefined
  const latticeUsable = courtsIdle && noMl
  if (tsGrid && latticeUsable) {
    tsDbg.__beats = tsGrid.beats
    tsDbg.__medSec = medianGap(tsGrid.beats)
    tsDbg.__bpb = tsGrid.beatsPerBar
    tsDbg.__downbeat = tsGrid.downbeat
    tsDbg.__downbeats = tsGrid.downbeats
    // Not from the grid, but written after backcastHead, so it belongs to the
    // same gate. `?? null` keeps the property present-but-empty, which is how
    // "the TS sanitized nothing" stays distinguishable from "not compared".
    tsDbg.__sanitized = tsDbg.sanitized ?? null
    tsDbg.__bpm = tsGrid.bpm
    tsDbg.__suspectAt = tsGrid.suspectAt ?? null
  }
  const latticeSkipReason = !courtsIdle
    ? 'the courts engaged'
    : !noMl
      ? 'an ML lattice produced or spliced the grid'
      : null

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
      // printed zeros. Agreeing to refuse IS the pass — refusals are what
      // the reject strings exist for. The second half covers the four points
      // where the TS returns null silently: it must still be a FAILURE when
      // the C++ refuses and the TS handed back a grid.
      if (a !== null || (c.ok === false && tsGrid === null)) { bothRefused = true; break }
      continue
    }
    if (a === undefined && b === undefined) continue      // neither side reached it
    if (a === undefined && latticeSkipReason && LATTICE_STAGES.has(name)) {
      skipped.push(`${name} (${latticeSkipReason} — not ported)`)
      continue
    }
    if (b === undefined) { skipped.push(name); continue } // not ported yet — REPORTED
    compared++
    if (!same) { firstBad = { name, ts: a, c: b }; break }
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
console.log(failed === 0 ? '\nBEATS PARITY (staged): IDENTICAL so far' : `\n${failed} PROJECT(S) DIVERGE`)
process.exit(failed === 0 ? 0 : 1)
