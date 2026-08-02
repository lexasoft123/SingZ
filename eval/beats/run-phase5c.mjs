/**
 * Phase-5c measurement: the fused bar decoder over the saved v17 grids,
 * against EVERY bar-level ground truth at once.
 *
 * Gates (all must hold before this ports into analysis.ts as v18):
 *  - Father and Son: barLenAt 68s→5 and 105.5s→3 turn GREEN
 *  - Soldier Of Fortune: barLenAt 150.5s→2 turns GREEN
 *  - TTP / Crowley / Dreamer: bar lengths stay as shipped (uniform + TTP's
 *    fermata 2) — the negative controls take NO new odd bars
 *  - every ear-verified barAt anchor still hit by a decoded bar line
 *
 *   node eval/beats/run-phase5c.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  beatFeatures, chordLabels, decodeBarsFused, decodeStem, formMap, vocalEvidence
} from './phase5-extractors.mjs'

const ROOT = process.env.SINGZ_EVAL_LIBRARY ||
  join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')
const GT = JSON.parse(readFileSync(new URL('./library-gt.json', import.meta.url), 'utf8')).songs

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

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
  const bass = stem('bass')
  const vocals = stem('vocals')
  const { runs } = chordLabels(harm, bass, beats)
  const voice = vocalEvidence(vocals, beats, { melody: settings.melody, words })
  const fm = formMap(beatFeatures(harm, vocals, beats), beats)
  return {
    beat: settings.beat,
    evidence: { voice, chordStarts: runs.map((r) => r.t), seams: fm.seams }
  }
}

function barLenAtIdx(beats, idx, t) {
  for (let k = 0; k + 1 < idx.length; k++) {
    if (beats[idx[k]] <= t && t < beats[idx[k + 1]]) return idx[k + 1] - idx[k]
  }
  return null
}

const SONGS = [
  'Cat Stevens — Father and Son', 'Soldier Of Fortune', 'Turn The Page',
  'Mr Crowley', 'Dreamer', 'Wild World', 'Wanted Dead Or Alive'
]

let pass = 0
let fail = 0
for (const name of SONGS) {
  const spec = GT[name] ?? {}
  const { beat, evidence } = evidenceFor(name)
  const beats = beat.beats
  const dom = beat.beatsPerBar === 6 ? 6 : 4
  const idx = decodeBarsFused(beats, dom, evidence)
  const lens = idx.slice(1).map((x, k) => x - idx[k])
  const counts = {}
  for (const L of lens) counts[L] = (counts[L] ?? 0) + 1
  const odd = lens.map((L, k) => ({ L, t: beats[idx[k]] })).filter((x) => x.L !== dom)
  console.log(`=== ${name}`)
  console.log(`  decoded: ${JSON.stringify(counts)}  odd: ${odd.length ? odd.map((o) => `${o.L}@${o.t.toFixed(1)}`).join(' ') : 'none'}`)

  // barLenAt anchors (the reds this decoder exists to turn green)
  for (const a of spec.barLenAt ?? []) {
    const got = barLenAtIdx(beats, idx, a.t)
    const ok = got === a.n
    console.log(`  barLenAt ${a.t}s want ${a.n} got ${got ?? 'none'} -> ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  // ear-verified bar times must still be hit
  if (spec.barAt != null) {
    const med = median(beats.slice(1).map((t, i) => t - beats[i]))
    const near = idx.map((i) => beats[i]).reduce((m, t) => Math.min(m, Math.abs(t - spec.barAt)), Infinity)
    const ok = near < Math.max(0.25 * med, 0.3)
    console.log(`  barAt ${spec.barAt}s: nearest decoded bar ${near.toFixed(2)}s away -> ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  // negative controls: no NEW odd bars vs the shipped grid
  if (['Turn The Page', 'Mr Crowley', 'Dreamer'].includes(name)) {
    const shippedIdx = beat.downbeats ?? []
    const shippedLens = shippedIdx.slice(1).map((x, k) => x - shippedIdx[k])
    const shippedOdd = shippedLens.filter((L) => L !== dom).length
    const ok = odd.length <= shippedOdd
    console.log(`  negative control: shipped ${shippedOdd} odd bars, decoded ${odd.length} -> ${ok ? 'PASS' : 'FAIL'}`)
    ok ? pass++ : fail++
  }
  console.log()
}
console.log(`5c gate: ${pass}/${pass + fail} checks pass${fail ? ` — ${fail} FAILING` : ''}`)
