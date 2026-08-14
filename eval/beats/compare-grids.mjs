#!/usr/bin/env node
/**
 * Compare two beat-grid dumps — the phone-parity half of the Phase-0/Phase-4
 * eval (docs/PHONE-STANDALONE.md): the same stems analyzed by the Node
 * baseline (run-current.mjs) and by an on-device host must produce the same
 * grid, and this tool says exactly how far apart two answers are.
 *
 *   node eval/beats/compare-grids.mjs a.json b.json [--tol-ms 0]
 *
 * Accepts either a bare grid object or one nested under `beat`/`det`/`grid`.
 * A grid is {beats[], bpm, beatsPerBar, downbeat?, downbeats?[], suspectAt?[]}.
 * Exit 0 = identical within tolerance (default 0 ms — byte parity is the
 * Phase-0 bar); exit 1 = differences (printed); exit 2 = unusable input.
 */
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
let tolMs = 0
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tol-ms') {
    tolMs = Number(args[++i] ?? NaN)
  } else if (!args[i].startsWith('--')) {
    files.push(args[i])
  }
}
if (files.length !== 2 || Number.isNaN(tolMs)) {
  console.error('usage: compare-grids.mjs <a.json> <b.json> [--tol-ms N]')
  process.exit(2)
}

function loadGrid(path) {
  let raw
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`${path}: ${e.message}`)
    process.exit(2)
  }
  const g = raw?.beats ? raw : (raw?.beat ?? raw?.det ?? raw?.grid)
  if (!g?.beats || !Array.isArray(g.beats)) {
    console.error(`${path}: no beats[] found (bare grid or under beat/det/grid)`)
    process.exit(2)
  }
  return g
}

const [a, b] = files.map(loadGrid)
const problems = []

if (a.beats.length !== b.beats.length) {
  problems.push(`beat count ${a.beats.length} vs ${b.beats.length}`)
}
const n = Math.min(a.beats.length, b.beats.length)
let worst = 0
let worstAt = -1
const shifts = []
for (let i = 0; i < n; i++) {
  const d = Math.abs(a.beats[i] - b.beats[i]) * 1000
  shifts.push(d)
  if (d > worst) {
    worst = d
    worstAt = i
  }
}
shifts.sort((x, y) => x - y)
const med = shifts[Math.floor(shifts.length / 2)] ?? 0
if (worst > tolMs) {
  problems.push(
    `beat times differ: max ${worst.toFixed(1)} ms at #${worstAt} ` +
      `(${a.beats[worstAt]?.toFixed(3)}s vs ${b.beats[worstAt]?.toFixed(3)}s), median ${med.toFixed(1)} ms`
  )
}

for (const k of ['bpm', 'beatsPerBar', 'downbeat']) {
  if ((a[k] ?? null) !== null && (b[k] ?? null) !== null && a[k] !== b[k]) {
    problems.push(`${k}: ${a[k]} vs ${b[k]}`)
  }
}

const da = JSON.stringify(a.downbeats ?? null)
const db = JSON.stringify(b.downbeats ?? null)
if (da !== db) {
  const la = a.downbeats?.length ?? 'none'
  const lb = b.downbeats?.length ?? 'none'
  problems.push(`downbeats differ (${la} vs ${lb} indices)`)
}

const sa = JSON.stringify(a.suspectAt ?? null)
const sb = JSON.stringify(b.suspectAt ?? null)
if (sa !== sb) problems.push('suspectAt differs')

if (problems.length === 0) {
  console.log(
    `identical${tolMs ? ` within ${tolMs} ms` : ''}: ${n} beats, ` +
      `${a.bpm?.toFixed?.(2) ?? a.bpm} bpm, bpb ${a.beatsPerBar}` +
      (worst > 0 ? ` (max shift ${worst.toFixed(3)} ms)` : '')
  )
  process.exit(0)
}
console.log(`GRIDS DIFFER (${files[0]} vs ${files[1]}):`)
for (const p of problems) console.log(`  - ${p}`)
process.exit(1)
