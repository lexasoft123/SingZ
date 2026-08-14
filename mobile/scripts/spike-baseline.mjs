#!/usr/bin/env node
/**
 * Node/V8 baseline for the Phase-0 analysis-host spike: bundles
 * mobile/src/analysis/spike.ts (the same file the device hooks run) and
 * executes it here, printing the SpikeResult JSON. Usage:
 *
 *   node mobile/scripts/spike-baseline.mjs [minutes] [--out file.json]
 *
 * Compare a device run against this with eval/beats/compare-grids.mjs (the
 * grid) plus an f0 diff — byte parity is the bar (docs/PHONE-STANDALONE.md).
 */
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = resolve(here, '..')

const args = process.argv.slice(2)
let outFile = null
let minutes = 3
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outFile = args[++i]
  else if (!args[i].startsWith('--')) minutes = Number(args[i])
}
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error('usage: spike-baseline.mjs [minutes] [--out file.json]')
  process.exit(2)
}

let esbuild
try {
  esbuild = createRequire(join(mobileRoot, 'package.json'))('esbuild')
} catch {
  esbuild = createRequire(join(resolve(mobileRoot, '..'), 'package.json'))('esbuild')
}

const outDir = mkdtempSync(join(tmpdir(), 'singz-spike-'))
const bundle = join(outDir, 'spike.mjs')
await esbuild.build({
  entryPoints: [join(mobileRoot, 'src', 'analysis', 'spike.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2020',
  outfile: bundle,
  logLevel: 'warning'
})

const { runAnalysisSpike } = await import(pathToFileURL(bundle).href)
const res = runAnalysisSpike(minutes)
const json = JSON.stringify(res)
if (outFile) {
  writeFileSync(outFile, json)
  const { f0, grid, ...summary } = res
  console.log(JSON.stringify({ ...summary, beatCount: grid?.beatCount, bpm: grid?.bpm }))
} else {
  console.log(json)
}
