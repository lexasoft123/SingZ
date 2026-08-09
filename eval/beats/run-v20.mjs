/**
 * The v20 battery: from-scratch detector grids -> octave court -> meter
 * court -> every gate the library GT can express.
 *
 *   node eval/beats/run-v20.mjs --grids <run-current --grids-out dump> [--verbose] [--only <name>]
 *
 * The input grids MUST be a fresh harness dump (from-scratch detection),
 * never project.json — half the library carries hand repairs, and a court
 * that inherits them proves nothing.
 *
 * SUPERSEDED as the gate of record by run-current.mjs since the port: the
 * courts live in src/renderer/src/audio/courts.ts and run-current bundles
 * them along with the post-halve head backcast, which exists ONLY in
 * analysis.ts. GT anchors that depend on it (Zeit's intro barAt 10.18) are
 * expected red here — this runner checks the courts alone.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectorBarLenAt } from './metrics.mjs'
import { v20, barTimes } from './v20.mjs'

const argv = process.argv
const opt = (n) => (argv.indexOf(n) > 0 ? argv[argv.indexOf(n) + 1] : null)
const VERBOSE = argv.includes('--verbose')
const only = opt('--only')
const GRIDS = JSON.parse(readFileSync(opt('--grids'), 'utf8'))
// the neural model's raw level per song: the doubling court's key witness
const ML = {}
{
  const mlPath = opt('--ml')
  if (mlPath) {
    for (const line of readFileSync(mlPath, 'utf8').trim().split('\n')) {
      if (!line.startsWith('{')) continue
      const r = JSON.parse(line)
      const b = r.beats
      if (!b || b.length < 32) continue
      const iv = []
      for (let i = 1; i < b.length; i++) iv.push(b[i] - b[i - 1])
      iv.sort((x, y) => x - y)
      const med = iv[iv.length >> 1]
      const uni = iv.filter((x) => Math.abs(x - med) <= 0.1 * med).length / iv.length
      ML[r.id] = { bpm: 60 / med, uni: Math.round(uni * 100) / 100 }
    }
  }
}
const slug = (n) => n.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
const GT = JSON.parse(readFileSync(new URL('./library-gt.json', import.meta.url), 'utf8')).songs
const EV = join(new URL('.', import.meta.url).pathname, 'out', 'v20-ev')

let pass = 0
let fail = 0
const failures = []
const check = (name, label, ok, detail) => {
  if (ok) pass++
  else {
    fail++
    failures.push(`${name}: ${label} ${detail}`)
  }
  if (VERBOSE || !ok) console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}: ${detail}`)
}

for (const name of Object.keys(GT).sort()) {
  if (only && name !== only) continue
  const spec = GT[name]
  const base = GRIDS[name]
  const evPath = join(EV, name.replace(/[/\\]/g, '_') + '.json')
  if (!base || !existsSync(evPath)) {
    if (spec.bpmNear || spec.barAt || spec.barLenAt) console.log(`${name}: no base grid/evidence — skipped`)
    continue
  }
  const ev = JSON.parse(readFileSync(evPath, 'utf8'))
  const notesPath = evPath.replace(/\.json$/, '.notes.json')
  ev.notes = existsSync(notesPath) ? JSON.parse(readFileSync(notesPath, 'utf8')) : []
  ev.ml = ML[slug(name)] ?? null
  const dbg = {}
  const out = v20(base, ev, dbg)
  const bars = barTimes(out)
  const per = 60 / out.bpm
  console.log(`=== ${name}  ${base.bpm.toFixed(1)} -> ${out.bpm.toFixed(1)} bpm` +
    `${dbg.oct?.action === 'halve' ? '  [HALVED]' : ''}` +
    `${dbg.applied?.length ? `  inserts: ${dbg.applied.map((a) => `${a.L}@${a.t}s(+${a.gain})`).join(' ')}` : ''}`)
  if (VERBOSE && dbg.oct) console.log(`  oct: ${JSON.stringify(dbg.oct)}`)
  if (VERBOSE && dbg.candList) console.log(`  cands(${dbg.halfBar ? 'halfBar' : 'full'}): ${JSON.stringify(dbg.candList)}`)
  if (VERBOSE && dbg.steps?.length) console.log(`  steps: ${JSON.stringify(dbg.steps)}`)
  if (dbg.plan) console.log(`  plan: ${JSON.stringify(dbg.plan)}`)
  if (VERBOSE && dbg.combos) for (const c of dbg.combos) console.log(`    combo ${JSON.stringify(c.c)} after ${c.after} local ${c.local}`)

  if (spec.bpmNear) {
    const w = spec.bpmNear.want
    const tol = (spec.bpmNear.tolPct ?? 5) / 100
    check(name, 'bpmNear', Math.abs(out.bpm - w) <= tol * w, `got ${out.bpm.toFixed(1)} want ${w}`)
  }
  if (spec.barAt != null) {
    for (const a of Array.isArray(spec.barAt) ? spec.barAt : [spec.barAt]) {
      const near = bars.reduce((m, t) => Math.min(m, Math.abs(t - a)), Infinity)
      check(name, 'barAt', near < Math.max(0.25 * per, 0.3), `${a}s -> nearest ${near.toFixed(2)}s`)
    }
  }
  for (const a of spec.barLenAt ?? []) {
    const got = detectorBarLenAt(out, a.t)
    check(name, 'barLenAt', got === a.n, `${a.t}s want ${a.n} got ${got ?? 'none'}`)
  }
  {
    const db = out.downbeats ?? []
    const lens = db.slice(1).map((x, k) => x - db[k])
    const bad = lens.filter((L) => L < 2 || L > 7).length
    check(name, 'gridSane', bad === 0, bad === 0 ? `${lens.length} bars` : `${bad} impossible`)
  }
  // Ballroom abstention, verified per song rather than asserted: with NO
  // evidence — the exact shape of a stems-less full-mix track — every
  // court must keep its hands off the grid entirely.
  {
    const bare = v20(base, { runs: [], voice: [], seams: [], words: [], notes: [], ml: null }, {})
    const same = bare.bpm === base.bpm &&
      JSON.stringify(bare.downbeats ?? null) === JSON.stringify(base.downbeats ?? null) &&
      bare.beats.length === base.beats.length
    check(name, 'abstains', same, same ? 'no evidence -> untouched' : `CHANGED: ${base.bpm.toFixed(1)} -> ${bare.bpm.toFixed(1)}`)
  }
  // negative control: songs with NO odd-bar GT and an approved level must
  // take no inserts at all
  const isControl = ['Turn The Page', 'Mr Crowley', 'Dreamer', 'Panzerkampf', 'Stirb Nicht Vor Mir',
    'Wanted Dead Or Alive', 'Nothing Else Matters'].includes(name)
  if (isControl) {
    check(name, 'no-invention', (dbg.applied ?? []).length === 0, `${(dbg.applied ?? []).length} inserts`)
  }
}
console.log(`\nv20 battery: ${pass}/${pass + fail} checks pass${fail ? ` — ${fail} FAILING` : ''}`)
for (const f of failures) console.log('  RED ' + f)
process.exit(fail > 0 ? 1 : 0)
