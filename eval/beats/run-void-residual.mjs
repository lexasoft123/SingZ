/**
 * Does the pulse, carried through a gap, land where the music resumes?
 *
 * A singer keeps counting through a break. The count does not stop because
 * the drums did — it runs on, and when the band comes back it either lands
 * where the count said it would or it does not. That MISMATCH is information
 * the detector currently throws away: it extends the phase across a void
 * from the surrounding anchors ("blind extension", analysis.ts) and then
 * re-votes inside the span, but it never asks whether the far side agrees
 * with what the pulse predicted.
 *
 * If a bar of 5 sits inside or at the edge of the gap, the music resumes one
 * beat later than the carried pulse expects, forever after. So:
 *
 *   residual = (beats between the last confident bar line before the void
 *              and the first real musical event after it) mod bpb
 *
 * ~0 everywhere  -> voids are not where the meter errors live, and the
 *                   carried pulse is already right.
 * consistent !=0 -> that is a missing odd bar, localised to a gap, which is
 *                   a far smaller place to look than a whole song.
 *
 *   node eval/beats/run-void-residual.mjs [--grids <dump>]
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chordLabels, decodeStem, vocalEvidence } from './phase5-extractors.mjs'

const gi = process.argv.indexOf('--grids')
const GRIDS = gi > 0 ? JSON.parse(readFileSync(process.argv[gi + 1], 'utf8')) : null
const ROOT = process.env.SINGZ_EVAL_LIBRARY ||
  join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')
const GT = JSON.parse(readFileSync(new URL('./library-gt.json', import.meta.url), 'utf8')).songs

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const mod = (a, m) => ((a % m) + m) % m

/** RMS envelope at ~46 ms, the resolution a gap is audible at. */
function envelope(buf, sr = 44100, hop = 2048) {
  const n = Math.floor(buf.length / hop)
  const e = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = i * hop; k < (i + 1) * hop; k++) s += buf[k] * buf[k]
    e[i] = Math.sqrt(s / hop)
  }
  return { e, dt: hop / sr }
}

/** Stretches where the drums drop out for at least `minBars` bars. */
function voids(drums, med, bpb, minBars = 2) {
  const { e, dt } = envelope(drums)
  const loud = [...e].filter((x) => x > 0).sort((a, b) => a - b)
  if (loud.length === 0) return []
  const p90 = loud[Math.floor(loud.length * 0.9)]
  const gate = 0.08 * p90
  const out = []
  let s = -1
  for (let i = 0; i < e.length; i++) {
    if (e[i] < gate) { if (s < 0) s = i }
    else if (s >= 0) {
      const a = s * dt
      const b = i * dt
      if (b - a >= minBars * bpb * med) out.push({ a, b })
      s = -1
    }
  }
  return out
}

const SONGS = Object.keys(GT).filter((n) => existsSync(join(ROOT, n, 'stems')))
console.log(`${'song'.padEnd(30)} ${'void'.padEnd(17)} carried -> resumed   residual`)
console.log('-'.repeat(86))
const tally = new Map()
for (const name of SONGS) {
  const dir = join(ROOT, name)
  const settings = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).settings
  // MotN is a verified REJECT — no grid at all, which is the right answer
  // for it and simply not this question.
  const g = GRIDS?.[name] ?? settings.beat
  if (!g?.beats?.length) { console.log(`${name.slice(0, 30).padEnd(30)} (no grid — skipped)`); continue }
  const beats = g.beats
  const bpb = g.beatsPerBar
  const med = median(beats.slice(1).map((t, i) => t - beats[i]))
  const bars = g.downbeats ?? (() => {
    const o = []
    for (let i = (g.downbeat ?? 0); i < beats.length; i += bpb) o.push(i)
    return o
  })()
  const stem = (n) => {
    const p = join(dir, 'stems', `${n}.flac`)
    return existsSync(p) ? decodeStem(p) : null
  }
  const drums = stem('drums')
  if (!drums) continue
  const harm = ['other', 'guitar', 'piano'].map(stem).filter(Boolean)
  const { runs } = chordLabels(harm, stem('bass'), beats)
  const vocals = stem('vocals')
  let words = null
  const lp = join(dir, 'lyrics.json')
  if (existsSync(lp)) {
    const ly = JSON.parse(readFileSync(lp, 'utf8'))
    words = []
    for (const L of ly.lines ?? []) for (const w of L.words ?? []) words.push({ w: w.w, s: w.s })
  }
  const voice = vocals ? vocalEvidence(vocals, beats, { melody: settings.melody, words }) : []
  // Musical events that mean "the bar starts HERE": a chord change that holds,
  // or a vocal phrase beginning.
  const events = [
    ...runs.filter((r) => r.len >= 3).map((r) => r.t),
    ...voice.map((v) => v.t)
  ].sort((a, b) => a - b)

  const vs = voids(drums, med, bpb)
  for (const v of vs) {
    // last bar line comfortably before the gap, first event comfortably after
    const before = bars.filter((i) => beats[i] < v.a - 0.5 * med)
    if (before.length < 4) continue
    const anchor = before[before.length - 1]
    const after = events.find((t) => t > v.b + 0.25 * med)
    if (after == null) continue
    if (after - beats[anchor] > 40) continue // too far to carry honestly
    // carry the pulse: how many beats of the ESTABLISHED period fit
    const carried = (after - beats[anchor]) / med
    const residual = mod(Math.round(carried), bpb)
    const frac = Math.abs(carried - Math.round(carried))
    if (frac > 0.28) continue // resumption is not on our pulse at all — different question
    const key = `${name}|${residual}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
    if (residual !== 0) {
      console.log(
        `${name.slice(0, 30).padEnd(30)} ${`${v.a.toFixed(1)}-${v.b.toFixed(1)}s`.padEnd(17)} ` +
        `bar@${beats[anchor].toFixed(1)} -> ${after.toFixed(1)}   ${Math.round(carried)} beats, off by ${residual}`
      )
    }
  }
}
console.log('-'.repeat(86))
const per = new Map()
for (const [k, n] of tally) {
  const [song, r] = k.split('|')
  const cur = per.get(song) ?? { ok: 0, off: 0 }
  if (r === '0') cur.ok += n
  else cur.off += n
  per.set(song, cur)
}
console.log(`\n${'song'.padEnd(30)} voids on-pulse   off-pulse`)
for (const [song, v] of [...per].sort()) {
  console.log(`${song.slice(0, 30).padEnd(30)} ${String(v.ok).padStart(10)} ${String(v.off).padStart(11)}`)
}
const okAll = [...per.values()].reduce((a, b) => a + b.ok, 0)
const offAll = [...per.values()].reduce((a, b) => a + b.off, 0)
console.log(`\ntotal: ${okAll} voids resume ON the carried pulse, ${offAll} resume off it`)
