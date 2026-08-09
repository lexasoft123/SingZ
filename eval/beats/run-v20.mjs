/**
 * The v20 battery: from-scratch detector grids -> octave court -> meter
 * court -> every gate the library GT can express.
 *
 *   node eval/beats/run-v20.mjs --grids <run-current --grids-out dump> [--verbose] [--only <name>]
 *
 * The input grids MUST be a fresh harness dump (from-scratch detection),
 * never project.json — half the library carries hand repairs, and a court
 * that inherits them proves nothing.
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
  const dbg = {}
  const out = v20(base, ev, dbg)
  const bars = barTimes(out)
  const per = 60 / out.bpm
  console.log(`=== ${name}  ${base.bpm.toFixed(1)} -> ${out.bpm.toFixed(1)} bpm` +
    `${dbg.oct?.action === 'halve' ? '  [HALVED]' : ''}` +
    `${dbg.applied?.length ? `  inserts: ${dbg.applied.map((a) => `${a.L}@${a.t}s(+${a.gain})`).join(' ')}` : ''}`)
  if (VERBOSE && dbg.oct) console.log(`  oct: ${JSON.stringify(dbg.oct)}`)
  if (VERBOSE && dbg.steps?.length) console.log(`  steps: ${JSON.stringify(dbg.steps)}`)
  if (dbg.plan) console.log(`  plan: ${JSON.stringify(dbg.plan)}`)

  if (spec.bpmNear) {
    const w = spec.bpmNear.want
    const tol = (spec.bpmNear.tolPct ?? 5) / 100
    check(name, 'bpmNear', Math.abs(out.bpm - w) <= tol * w, `got ${out.bpm.toFixed(1)} want ${w}`)
  }
  if (spec.barAt != null) {
    const near = bars.reduce((m, t) => Math.min(m, Math.abs(t - spec.barAt)), Infinity)
    check(name, 'barAt', near < Math.max(0.25 * per, 0.3), `${spec.barAt}s -> nearest ${near.toFixed(2)}s`)
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
