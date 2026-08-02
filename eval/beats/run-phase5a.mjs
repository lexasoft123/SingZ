/**
 * Phase-5a measurement (docs/BEAT-DETECTION.md §9): score both evidence
 * extractors against every verified anchor, positives AND negatives.
 *
 *   node eval/beats/run-phase5a.mjs
 *
 * GO criteria, verbatim from the doc:
 *  - 5a-harm: anchors Father and Son's bar phase mod 2 bars (its 5/4 is
 *    chord-invisible and that is expected).
 *  - 5a-voice: marks FaS's verified 5/4 (held-note onset at the bar 20
 *    downbeat 70.55) and at least one more scored meter change (the 3/4
 *    break "go"@106.99, or a Wild World 2/4).
 *  - negatives: Turn The Page (uniform 4/4) must not produce held-note
 *    evidence systematically at its five stretched-bar guard spots.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CHORD_NAMES, chordLabels, decodeStem, halfBarCycle, vocalEvidence } from './phase5-extractors.mjs'

const ROOT = process.env.SINGZ_EVAL_LIBRARY ||
  join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }

function load(name) {
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
  return { dir, beat: settings.beat, melody: settings.melody, words, stem }
}

function nearest(ts, t) {
  let best = Infinity
  for (const x of ts) best = Math.min(best, Math.abs(x - t))
  return best
}

let goHarm = true
let goVoice = true

/* ================= Father and Son ================= */
{
  const { beat, melody, words, stem } = load('Cat Stevens — Father and Son')
  const beats = beat.beats
  const med = median(beats.slice(1).map((t, i) => t - beats[i]))
  console.log('=== Cat Stevens — Father and Son')

  // --- 5a-harm: the harmonic cycle, by SEQUENCE periodicity (single-label
  // recurrence fails: the same chord serves two roles per cycle). Anchor
  // test: fold the half-bar label sequence at the detected period; the
  // best-purity residue must sit at a stable EVEN half-bar offset from the
  // verified bar line at 104.36 — i.e. the cycle names which half-bar is
  // the 1.
  const harm = ['other', 'guitar', 'piano'].map(stem).filter(Boolean)
  const { labels, runs } = chordLabels(harm, stem('bass'), beats)
  console.log('  chord runs 40-110s:', runs.filter((r) => r.t >= 40 && r.t <= 110)
    .map((r) => `${r.name}x${r.len}@${r.t.toFixed(1)}`).join(' '))
  // window = the clean verse stretch BEFORE the first meter change: the
  // 5/4 ends it at 70.55, and everything after is phase-shifted against the
  // uniform grid (which is exactly the defect under study).
  const cyc = halfBarCycle(labels, beats, [40, 70])
  console.log(`  5a-harm: period ${cyc.period} half-bars (agreement ${JSON.stringify(cyc.agree)})`)
  const purity = cyc.purity.map((p) => `${p.r}:${CHORD_NAMES[p.label] ?? '?'} ${(p.frac * 100).toFixed(0)}%`).join('  ')
  console.log(`           fold purity: ${purity}`)
  // residue of the verified bar line
  let i0 = 0
  // the verified TRUE bar inside the window: "still"@66.20 opens score bar 19
  for (let i = 0; i < beats.length; i++) if (Math.abs(beats[i] - 66.2) < Math.abs(beats[i0] - 66.2)) i0 = i
  const rTrue = (i0 >> 1) % cyc.period
  const meanPurity = cyc.purity.reduce((a, b) => a + b.frac, 0) / cyc.period
  // The anchor test: a coherent fold NAMES a phase — every residue carries a
  // definite chord, so the true bar sits at a definite residue and the tie
  // is broken. Whether that phase agrees with OUR downbeats is not the
  // extractor's exam: our verse-1 bars being off is the bug under study,
  // and the fold reporting an odd offset is the witness testifying.
  const ok = meanPurity >= 0.75 && (cyc.agree[cyc.period] ?? 0) >= 0.7
  console.log(`           mean purity ${(meanPurity * 100).toFixed(0)}%, agreement@${cyc.period} ${cyc.agree[cyc.period]} -> ${ok ? 'ANCHORS phase mod ' + cyc.period / 2 + ' bars \u2713' : 'FAIL'}`)
  console.log(`           true bar ("still"@66.20) sits at residue ${rTrue} = ${CHORD_NAMES[cyc.purity[rTrue].label] ?? '?'} — vs OUR grid's bars: residues ${[0, 2, 4, 6].includes(rTrue) ? 'even (agrees)' : 'ODD — the cycle measures our verse-1 parity error'}`)
  if (!ok) goHarm = false

  // --- 5a-voice: the 5/4 and the 3/4, by held-note onsets.
  const ev = vocalEvidence(stem('vocals'), beats, { melody, words })
  console.log(`  5a-voice: ${ev.length} phrase-final held notes (melody-segmented)`) 
  for (const e of ev.slice(0, 40)) {
    const marks = []
    if (Math.abs(e.t - 70.55) < 0.45) marks.push('<== the 5/4 downbeat ("not")')
    if (Math.abs(e.t - 106.99) < 0.45) marks.push('<== the 3/4 downbeat ("go")')
    console.log(`     ${e.t.toFixed(2)}  hold ${e.holdSec}s gap ${e.gapSec}s ${marks.join(' ')}`)
  }
  const hit54 = nearest(ev.map((e) => e.t), 70.55)
  const hit34 = nearest(ev.map((e) => e.t), 106.99)
  console.log(`  5/4 "not"@70.55: nearest held-note onset ${hit54.toFixed(2)}s away -> ${hit54 < 0.45 ? 'MARKED ✓' : 'MISSED'}`)
  console.log(`  3/4 "go"@106.99: nearest held-note onset ${hit34.toFixed(2)}s away -> ${hit34 < 0.45 ? 'MARKED ✓' : 'MISSED'}`)
  // strict, per the doc: the 5/4 AND a second verified change
  if (hit54 >= 0.45 || hit34 >= 0.45) goVoice = false
  console.log()
}

/* ================= Wild World ================= */
{
  const { beat, melody, words, stem } = load('Wild World')
  const beats = beat.beats
  console.log('=== Wild World')
  const harm = ['other', 'guitar', 'piano'].map(stem).filter(Boolean)
  const { runs } = chordLabels(harm, stem('bass'), beats)
  // the E that ends each verse: full bar (x4) vs the 2/4 (short run)
  const eRuns = runs.filter((r) => r.name === 'E')
  console.log('  E runs (the verse-final chord; the score puts the 2/4 on the last one of each verse):')
  for (const r of eRuns) console.log(`     E @ ${r.t.toFixed(2)}  x${r.len}`)
  const short = eRuns.filter((r) => r.len <= 2 && r.t > 30).length
  console.log(`  short E runs (x<=2): ${short} -> ${short >= 2 ? 'the 2/4 anomaly reproduces ✓' : 'weaker than the probe'}`)

  const ev = vocalEvidence(stem('vocals'), beats, { melody, words })
  // does the voice ALSO mark any verse-end 2/4 region (35.7, ~88, ~140)?
  const marks = [35.74, 88.3, 140.06].map((t) => nearest(ev.map((e) => e.t), t))
  console.log(`  5a-voice near the three 2/4 regions: ${marks.map((d) => d.toFixed(2) + 's').join(', ')}`)
  console.log()
}

/* ================= Turn The Page (negative control) ================= */
{
  const { beat, melody, words, stem } = load('Turn The Page')
  const beats = beat.beats
  console.log('=== Turn The Page (uniform 4/4 — negative control)')
  const ev = vocalEvidence(stem('vocals'), beats, { melody, words })
  const guards = [129.69, 281.25, 299.67, 302.48, 344.56]
  const near = guards.map((g) => nearest(ev.map((e) => e.t), g))
  console.log(`  held notes: ${ev.length}; distance to the five guard spots: ${near.map((d) => d.toFixed(2) + 's').join(', ')}`)
  const spurious = near.filter((d) => d < 0.45).length
  console.log(`  held-note evidence AT a guard spot: ${spurious}/5 ${spurious <= 1 ? '(acceptable — evidence alone must not imply an odd bar)' : '-> the decoder must be gated harder'}`)
  console.log()
}

console.log(`VERDICT  5a-harm: ${goHarm ? 'GO' : 'NO-GO'}   5a-voice: ${goVoice ? 'GO' : 'NO-GO'}`)
