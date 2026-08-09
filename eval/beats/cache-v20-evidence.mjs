/**
 * Compute and cache the v20 evidence pack per song: chord runs, vocal
 * events, form seams — everything the octave and meter courts read.
 * Expensive (five stem decodes per song), so it runs once into
 * out/v20-ev/<name>.json and the court iterations stay fast.
 *
 *   node eval/beats/cache-v20-evidence.mjs [--only <name>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beatFeatures, chordLabels, decodeStem, formMap, vocalEvidence } from './phase5-extractors.mjs'

const ROOT = process.env.SINGZ_EVAL_LIBRARY ||
  join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')
const OUT = join(new URL('.', import.meta.url).pathname, 'out', 'v20-ev')
mkdirSync(OUT, { recursive: true })
const GT = JSON.parse(readFileSync(new URL('./library-gt.json', import.meta.url), 'utf8')).songs
const only = process.argv.indexOf('--only') > 0 ? process.argv[process.argv.indexOf('--only') + 1] : null
const gi = process.argv.indexOf('--grids')
const BASE = gi > 0 ? JSON.parse(readFileSync(process.argv[gi + 1], 'utf8')) : null

for (const name of Object.keys(GT)) {
  if (only && name !== only) continue
  const dir = join(ROOT, name)
  if (!existsSync(join(dir, 'stems'))) continue
  const dst = join(OUT, name.replace(/[/\\]/g, '_') + '.json')
  if (existsSync(dst) && !only) { console.log(`cached: ${name}`); continue }
  const t0 = Date.now()
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
    for (const L of ly.lines ?? []) for (const w of L.words ?? []) {
      if (w.s != null && w.e != null) words.push({ w: w.w, s: w.s, e: w.e })
    }
  }
  // Evidence rides the BASE DETECTOR's beat lattice. An 8 Hz "neutral"
  // lattice was tried first and starved the courts blind exactly where they
  // were needed: beat-synced chroma pools frames over musically coherent
  // spans, and the fine lattice's chord decode went silent through Zeit's
  // loud choruses (zero runs, 195-232s) and FaS's fingerpicked verse 3.
  // The lattice's TIMES bias nothing the courts measure — phases are
  // always judged relative to the same lattice.
  const dur = (stem('drums') ?? stem('vocals')).length / 44100
  const base = BASE?.[name]
  const lattice = base ? base.beats : (() => {
    const out = []
    for (let t = 0.125; t < dur - 0.1; t += 0.125) out.push(Math.round(t * 1000) / 1000)
    return out
  })()
  const latPer = base ? 60 / base.bpm : 0.125
  const harm = ['other', 'guitar', 'piano'].map(stem).filter(Boolean)
  const bass = stem('bass')
  const vocals = stem('vocals')
  const { runs } = chordLabels(harm, bass, lattice)
  const voice = vocals ? vocalEvidence(vocals, lattice, { melody: settings.melody, words }) : []
  const fm = formMap(beatFeatures(harm, vocals, lattice), lattice)
  const doc = {
    name,
    dur: Math.round(dur * 10) / 10,
    // chord runs on the neutral lattice: start time + length in SECONDS
    runs: runs.map((r) => ({ t: Math.round(r.t * 1000) / 1000, sec: Math.round(r.len * latPer * 1000) / 1000, c: r.name })),
    voice: voice.map((v) => ({ t: Math.round(v.t * 1000) / 1000, gapSec: Math.round((v.gapSec ?? 0) * 100) / 100 })),
    seams: (fm.seams ?? []).map((s) => ({ t: Math.round(s.t * 1000) / 1000 })),
    words: (words ?? []).map((w) => ({ s: Math.round(w.s * 100) / 100, e: Math.round(w.e * 100) / 100 }))
  }
  writeFileSync(dst, JSON.stringify(doc))
  console.log(`${name}: ${doc.runs.length} runs, ${doc.voice.length} voice, ${doc.seams.length} seams (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
console.log('evidence cache complete')
