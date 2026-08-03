/**
 * Phase-5d gate — the same 17 checks 5c faced, against the repair operator.
 *
 *   node eval/beats/run-phase5d.mjs --grids <dump from run-current --grids-out>
 *   MAXREP=0 node eval/beats/run-phase5d.mjs --grids …     # do-nothing baseline
 *
 * Ship condition: the three reds turn green AND the negative controls take
 * no new odd bars AND every ear-verified barAt is still hit.
 *
 * VERDICT AS MEASURED (2026-08-04) — DOES NOT SHIP:
 *
 *   do nothing (MAXREP=0)          11/17
 *   window 4, purity 1.0           11/17   (proposes almost nothing)
 *   window 5, purity 0.85          11/17
 *   window 6, purity 0.75          10/17
 *   window 4, purity 0.75           9/17
 *   5c, the re-decoder it replaced 10/17
 *
 * No configuration beats inaction. Every setting that proposes repairs
 * either misses the three target bars or breaks a check that was passing —
 * on Turn The Page a proposed 3-beat bar at 277.3 s turned a green barLenAt
 * red. Tuning the knobs further is the exact trap the project already paid
 * for once (seven detector versions in four days, each bought with one
 * singer complaint), so this stops at the measurement.
 *
 * What is real and worth keeping is in phase5d-slip.mjs: the phase-step
 * signal exists and is visible, and `bestPeriod` is the reason it is
 * visible at all. What is missing is a way to tell a meter change from
 * ordinary chord-rhythm movement, because Father and Son changes phase and
 * changes BACK within four anchors — purity plus seam proximity does not
 * separate those two cases.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beatFeatures, chordLabels, decodeStem, formMap, vocalEvidence } from './phase5-extractors.mjs'
import { medianOf, repairBars, uniformBars } from './phase5d-slip.mjs'

const VERBOSE = process.argv.includes('--verbose')
const gi = process.argv.indexOf('--grids')
const GRIDS = gi > 0 && gi + 1 < process.argv.length
  ? JSON.parse(readFileSync(process.argv[gi + 1], 'utf8'))
  : null
const ROOT = process.env.SINGZ_EVAL_LIBRARY ||
  join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')
const GT = JSON.parse(readFileSync(new URL('./library-gt.json', import.meta.url), 'utf8')).songs

function evidenceFor(name) {
  const dir = join(ROOT, name)
  const settings = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).settings
  const stem = (n) => {
    const p = join(dir, 'stems', `${n}.flac`)
    return existsSync(p) ? decodeStem(p) : null
  }
  let words = null
  const lp = join(dir, 'lyrics.json')
  if (existsSync(lp)) {
    const ly = JSON.parse(readFileSync(lp, 'utf8'))
    words = []
    for (const L of ly.lines ?? []) for (const w of L.words ?? []) words.push({ w: w.w, s: w.s })
  }
  const beats = settings.beat.beats
  const harm = ['other', 'guitar', 'piano'].map(stem).filter(Boolean)
  const { runs } = chordLabels(harm, stem('bass'), beats)
  const voice = vocalEvidence(stem('vocals'), beats, { melody: settings.melody, words })
  const fm = formMap(beatFeatures(harm, stem('vocals'), beats), beats)
  return { beat: settings.beat, evidence: { voice, chordStarts: runs.map((r) => r.t), seams: fm.seams } }
}

const barLenAtIdx = (beats, idx, t) => {
  for (let k = 0; k + 1 < idx.length; k++) if (beats[idx[k]] <= t && t < beats[idx[k + 1]]) return idx[k + 1] - idx[k]
  return null
}

const SONGS = [
  'Cat Stevens — Father and Son', 'Soldier Of Fortune', 'Turn The Page',
  'Mr Crowley', 'Dreamer', 'Wild World', 'Wanted Dead Or Alive'
]
const CONTROLS = ['Turn The Page', 'Mr Crowley', 'Dreamer']

let pass = 0
let fail = 0
for (const name of SONGS) {
  const spec = GT[name] ?? {}
  const { beat, evidence } = evidenceFor(name)
  const beats = beat.beats
  const bpb = beat.beatsPerBar
  const med = medianOf(beats.slice(1).map((t, i) => t - beats[i]))
  // Input is what the DETECTOR produces, taken from --grids (a --grids-out
  // dump of the current detector). Not project.json: several library songs
  // carry hand-applied odd bars, and feeding those back in would let the
  // operator score points for repairs a human already made. Not a
  // re-uniformed grid either — that discards the odd bars the detector
  // legitimately does emit (Turn The Page's fermata), which is not the
  // detector's behaviour and cost two false failures on the first run.
  const dumped = GRIDS?.[name]
  const input = dumped?.downbeats ??
    (dumped ? uniformBars(dumped.downbeat ?? 0, bpb, beats.length)
            : beat.downbeats ?? uniformBars(beat.downbeat ?? 0, bpb, beats.length))
  // MAXREP=0 is the do-nothing baseline — the number every configuration
  // has to beat, and so far none does.
  const { bars, repairs } = repairBars(beats, input, bpb, evidence, {
    maxRepairs: Number(process.env.MAXREP ?? 4),
    window: Number(process.env.WIN ?? 4),
    purity: Number(process.env.PUR ?? 0.75)
  })

  const lens = bars.slice(1).map((x, k) => x - bars[k])
  const counts = {}
  for (const L of lens) counts[L] = (counts[L] ?? 0) + 1
  console.log(`=== ${name}`)
  console.log(`  repairs: ${repairs.length ? repairs.map((r) => `${r.len}@${r.tSite.toFixed(1)}s(d${r.d},seam ${r.seamNear.toFixed(2)}s)`).join(' ') : 'none'}`)
  if (VERBOSE) console.log(`  lengths: ${JSON.stringify(counts)}`)

  for (const a of spec.barLenAt ?? []) {
    const got = barLenAtIdx(beats, bars, a.t)
    const ok = got === a.n
    console.log(`  barLenAt ${a.t}s want ${a.n} got ${got ?? 'none'} -> ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  if (spec.barAt != null) {
    const near = bars.map((i) => beats[i]).reduce((m, t) => Math.min(m, Math.abs(t - spec.barAt)), Infinity)
    const ok = near < Math.max(0.25 * med, 0.3)
    console.log(`  barAt ${spec.barAt}s: nearest bar ${near.toFixed(2)}s -> ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  if (CONTROLS.includes(name)) {
    const ok = repairs.length === 0
    console.log(`  negative control: ${repairs.length} repairs proposed -> ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  console.log()
}
console.log(`5d gate: ${pass}/${pass + fail} checks pass${fail ? ` — ${fail} FAILING` : ''}`)
process.exit(fail > 0 ? 1 : 0)
