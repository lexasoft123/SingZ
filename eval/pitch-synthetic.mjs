#!/usr/bin/env node
/** Known-truth comparison; no listening or access to the user's library.
 * node eval/pitch-synthetic.mjs [--baseline /path/to/baseline] [--out /tmp/report.json]
 * Baseline folder optionally contains ESM pitch.js + pitch-core.js bundles.
 * MPM NSDF/relative peak selection follows McLeod & Wyvill, A Smarter Way to
 * Find Pitch (2005), https://www.researchgate.net/publication/230554927_A_smarter_way_to_find_pitch
 * MPM cutoffs are compared here, not used as training-target corrections.
 */
import { build } from 'esbuild'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const args = process.argv.slice(2)
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
const temp = mkdtempSync(join(tmpdir(), 'singz-pitch-synthetic-'))
for (const name of ['pitch', 'pitch-core']) await build({ entryPoints: [resolve(`src/renderer/src/audio/${name}.ts`)], bundle: true, format: 'esm', outfile: join(temp, `${name}.mjs`) })
const current = { ...await import(pathToFileURL(join(temp, 'pitch.mjs'))), ...await import(pathToFileURL(join(temp, 'pitch-core.mjs'))) }
const base = option('--baseline')
const baseline = base ? { ...await import(pathToFileURL(resolve(base, 'pitch.js'))), ...await import(pathToFileURL(resolve(base, 'pitch-core.js'))) } : null
function mpm(x, sr, cutoff) {
  const nsdf = new Float64Array(Math.min(Math.ceil(sr / 55) + 2, x.length >> 1))
  nsdf[0] = 1
  for (let tau = 1; tau < nsdf.length; tau++) {
    let corr = 0, norm = 0
    for (let i = 0; i < x.length - tau; i++) {
      corr += x[i] * x[i + tau]
      norm += x[i] * x[i] + x[i + tau] * x[i + tau]
    }
    nsdf[tau] = norm ? 2 * corr / norm : 0
  }
  const peaks = []
  // MPM chooses one maximum per positive lobe, discarding the initial lobe
  // around zero lag before applying its relative peak threshold.
  let start = 1
  while (start < nsdf.length && nsdf[start] > 0) start++
  for (let t = start; t < nsdf.length - 1;) {
    while (t < nsdf.length - 1 && nsdf[t] <= 0) t++
    let best = t
    while (t < nsdf.length - 1 && nsdf[t] > 0) {
      if (nsdf[t] > nsdf[best]) best = t
      t++
    }
    if (best <= 1 || best >= nsdf.length - 1) continue
    const a = nsdf[best - 1], b = nsdf[best], c = nsdf[best + 1]
    const delta = (a - c) / (2 * (a - 2 * b + c))
    const hz = sr / (best + delta)
    if (hz >= 55 * .999 && hz <= 1050 * 1.001)
      peaks.push({ hz, strength: b - (a - c) * delta / 4 })
  }
  const max = Math.max(...peaks.map((p) => p.strength))
  return peaks.find((p) => p.strength >= Math.max(0.7, max * cutoff))?.hz ?? 0
}
const partials = { pure: [1], weakFundamental: [0.1, 1, 0.1], second: [0.2, 1, 0.2], third: [0.2, 0.2, 1], missingFundamental: [0, 1, 0.3] }
const cases = []
const elapsed = {}
function measure(name, fn) { const start = performance.now(); const value = fn(); elapsed[name] = (elapsed[name] ?? 0) + performance.now() - start; return value }
const median = (values) => { const v = Array.from(values).sort((a,b)=>a-b); return v[v.length >> 1] ?? 0 }
for (const sr of [44100, 48000, 96000]) for (const hz of [55, 65.406, 82.407, 110, 196, 220, 329.628, 440, 659.255, 880, 1000]) {
  for (const [name, harmonics] of Object.entries(partials)) {
    const x = Float32Array.from({ length: Math.round(sr * .5) }, (_, i) => harmonics.reduce((s,a,h)=>s+.3*a*Math.sin((h+1)*2*Math.PI*hz*(i+1)/sr),0))
    const window = x.subarray(0, sr > 48000 ? 4096 : 2048)
    const found = {
      live: measure('live', () => current.yinPitchInfo(window, sr).f0),
      offline: measure('offline', () => median(current.trackMelodyCore(x, sr).f0.slice(4,-4))),
      mpm93: measure('mpm93', () => mpm(window, sr, .93)),
      mpm99: measure('mpm99', () => mpm(window, sr, .99)),
    }
    if (baseline) {
      found.baselineLive = measure('baselineLive', () => baseline.yinPitchInfo(window, sr).f0)
      found.baselineOffline = measure('baselineOffline', () => median(baseline.trackMelodyCore(x,sr).f0.slice(4,-4)))
    }
    const errorsCents = Object.fromEntries(Object.entries(found).map(([k,v])=>[k,v>0?Math.abs(1200*Math.log2(v/hz)):null]))
    cases.push({ sr, hz, partials: name, found, errorsCents })
  }
}
const summary = Object.fromEntries(Object.keys(cases[0].found).map((key)=>[key,{within50Cents:cases.filter((c)=>c.errorsCents[key] !== null && c.errorsCents[key] <= 50).length,total:cases.length,elapsedMs:Math.round(elapsed[key])}]))
const report = { summary, cases }
if (option('--out')) writeFileSync(option('--out'), JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(summary,null,2))
