/**
 * Phase-5b measurement (docs/BEAT-DETECTION.md §9): the repetition map,
 * scored against the GO criteria verbatim:
 *
 *  - GO A: Wild World's three verse-end 2/4 regions land in ONE repetition
 *    class — querying the first must return the other two.
 *  - GO B: Turn The Page gains no false seams at its five stretched-bar
 *    guard spots (the wobbles are mid-section and must not read as form).
 *
 * Plus report-only sanity: detected seams vs lyric-known section starts.
 *
 *   node eval/beats/run-phase5b.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { beatFeatures, decodeStem, formMap } from './phase5-extractors.mjs'

const ROOT = process.env.SINGZ_EVAL_LIBRARY ||
  join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')

function load(name) {
  const dir = join(ROOT, name)
  const settings = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).settings
  const stem = (n) => {
    const p = join(dir, 'stems', `${n}.flac`)
    return existsSync(p) ? decodeStem(p) : null
  }
  let lines = []
  const lp = join(dir, 'lyrics.json')
  if (existsSync(lp)) {
    const ly = JSON.parse(readFileSync(lp, 'utf8'))
    lines = (ly.lines ?? [])
      .map((L) => ({ s: L.words?.[0]?.s ?? L.start, text: L.text }))
      .filter((L) => L.s != null)
  }
  return { beat: settings.beat, lines, stem }
}

function mapOf(name) {
  const { beat, lines, stem } = load(name)
  const harm = ['other', 'guitar', 'piano'].map(stem).filter(Boolean)
  const feat = beatFeatures(harm, stem('vocals'), beat.beats)
  const fm = formMap(feat, beat.beats)
  return { fm, lines, beats: beat.beats }
}

const nearLine = (lines, t) => {
  let best = null
  for (const L of lines) {
    if (best === null || Math.abs(L.s - t) < Math.abs(best.s - t)) best = L
  }
  return best && Math.abs(best.s - t) < 4 ? `"${(best.text ?? '').slice(0, 34)}"@${best.s.toFixed(1)}` : '(no lyric near)'
}

let goA = false
let goB = true

/* ================= Wild World — GO A ================= */
{
  const { fm, lines } = mapOf('Wild World')
  console.log('=== Wild World')
  console.log('  seams:', fm.seams.map((s) => `${s.t.toFixed(1)}(${s.nov})`).join(' '))
  for (const s of fm.seams) console.log(`     ${s.t.toFixed(1).padStart(6)}  ${nearLine(lines, s.t)}`)
  // the three verse-end 2/4 regions
  const targets = [35.74, 88.3, 140.06]
  const mates = fm.classmates(targets[0], { ctx: 4 })
  console.log(`  classmates of ${targets[0]}s:`, mates.map((m) => `${m.t.toFixed(1)}(${m.score})`).join(' ') || '(none)')
  // One-loop harmony makes the raw list promiscuous (everything matches
  // everything above threshold on this song) — mere PRESENCE proves little.
  // The strict test is RANK: the other two verse ends must be the BEST
  // matches, because only the vocal dims distinguish a verse end from any
  // other bar of the same loop.
  const ranked = [...mates].sort((a, b) => b.score - a.score)
  const rankOf = (t) => 1 + ranked.findIndex((m) => Math.abs(m.t - t) < 3)
  const r2 = rankOf(targets[1])
  const r3 = rankOf(targets[2])
  console.log(`  verse-2 end (~${targets[1]}): rank ${r2 || 'none'}/${ranked.length}   verse-3 end (~${targets[2]}): rank ${r3 || 'none'}/${ranked.length}   (must both be top-3)`)
  goA = r2 >= 1 && r2 <= 3 && r3 >= 1 && r3 <= 3
  console.log()
}

/* ================= Turn The Page — GO B ================= */
{
  const { fm, lines } = mapOf('Turn The Page')
  console.log('=== Turn The Page (negative control)')
  console.log('  seams:', fm.seams.map((s) => `${s.t.toFixed(1)}(${s.nov})`).join(' '))
  for (const s of fm.seams) console.log(`     ${s.t.toFixed(1).padStart(6)}  ${nearLine(lines, s.t)}`)
  const guards = [129.69, 281.25, 299.67, 302.48, 344.56]
  const bad = guards.filter((g) => fm.seams.some((s) => Math.abs(s.t - g) < 1.5))
  console.log(`  false seams at guard spots: ${bad.length}/5 ${bad.length ? '(' + bad.map((b) => b.toFixed(1)).join(' ') + ')' : ''} -> ${bad.length === 0 ? 'CLEAN ✓' : 'FAIL'}`)
  goB = bad.length === 0
  console.log()
}

/* ================= Father and Son — report only ================= */
{
  const { fm, lines } = mapOf('Cat Stevens — Father and Son')
  console.log('=== Father and Son (report only)')
  console.log('  seams:')
  for (const s of fm.seams) console.log(`     ${s.t.toFixed(1).padStart(6)}  ${nearLine(lines, s.t)}`)
  // known breaks: after the 5/4 (~70.8) and after "go" (~107) — do seams land near?
  for (const t of [70.8, 107.0]) {
    const d = Math.min(...fm.seams.map((s) => Math.abs(s.t - t)))
    console.log(`  nearest seam to the ${t}s break: ${d.toFixed(1)}s away`)
  }
  // verse repetition: verse 1 "I was once"@43.8 vs verse 3's counterpart
  const mates = fm.classmates(43.81, { ctx: 4 })
  console.log('  classmates of "I was once"@43.8:', mates.map((m) => `${m.t.toFixed(1)}(${m.score})`).join(' ') || '(none)')
  console.log()
}

console.log(`VERDICT  GO-A (WW verse ends in one class): ${goA ? 'GO' : 'NO-GO'}   GO-B (TTP no false seams): ${goB ? 'GO' : 'NO-GO'}`)
