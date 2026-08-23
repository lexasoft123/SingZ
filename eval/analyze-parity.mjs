#!/usr/bin/env node
/**
 * The combined pass against the individual subcommands: `analyze --melody
 * --key --beats` must produce VALUE-IDENTICAL results to `melody`, `key` and
 * `beats` run separately on the same files — every f0/raw/rms value, the key,
 * every beat time, every downbeat index, the stamps. The combined pass is
 * what the desktop actually spawns (one child, stems read once, the lattice
 * over --ml-stdin), while the per-detector gates and the harness drive the
 * individual subcommands — this file is what keeps those two worlds the same
 * world. Pure CLI-vs-CLI: no analysis-lib needed, so it runs anywhere the
 * binary builds.
 *
 *   node eval/analyze-parity.mjs [--bin <singz-analyze>]
 *
 * The bundled sample's stems by default (rendered with ffmpeg, like
 * melody-parity). The ml leg runs twice: without a lattice, and with a small
 * synthetic one delivered BOTH ways (--ml file to `beats`, --ml-stdin to
 * `analyze`) — the two delivery paths must agree too.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = process.argv.slice(2)
let bin = null
for (let i = 0; i < args.length; i++) if (args[i] === '--bin') bin = args[++i]
if (!bin) bin = execFileSync('bash', [join(root, 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).trim()

const tmp = mkdtempSync(join(tmpdir(), 'singz-analyze-parity-'))
const stems = {}
for (const s of ['vocals', 'drums', 'bass', 'other']) {
  const out = join(tmp, `${s}.wav`)
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(root, 'mobile', 'assets', 'sample', 'stems', `${s}.flac`), '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out])
  stems[s] = out
}

const run = (cliArgs, stdin) => {
  const r = spawnSync(bin, cliArgs, { input: stdin ?? '', maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`${cliArgs[0]} exited ${r.status}: ${r.stderr.toString().slice(-300)}`)
  // `analyze` emits one flushed JSON line PER PART (so the caller can adopt
  // the melody before the beats stage runs); merge them. The single-detector
  // subcommands still emit exactly one line, which merges to itself.
  const out = {}
  for (const line of r.stdout.toString().split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')))
    Object.assign(out, JSON.parse(line))
  return out
}

const same = (label, a, b) => {
  const ja = JSON.stringify(a)
  const jb = JSON.stringify(b)
  if (ja === jb) return true
  console.log(`  DIFF ${label}: ${ja.slice(0, 120)}… vs ${jb.slice(0, 120)}…`)
  return false
}

// a small real-shaped lattice for the ml leg — 120 bpm, fours
const mlBeats = Array.from({ length: 60 }, (_, i) => 0.5 + i * 0.5)
const mlDown = mlBeats.filter((_, i) => i % 4 === 0)
// the lyric aux rides stdin beside the lattice in the app — send it here too,
// and give the `beats` leg the same words via argv, so the section parser and
// the argv parser are held to one answer
const words = [[1.5, 2.0], [3.5, 4.0], [7.25, 7.5]]
const lineStarts = [1.5, 7.25]
const mlText =
  `fps 50\nbeats ${mlBeats.length} ${mlBeats.join(' ')}\ndownbeats ${mlDown.length} ${mlDown.join(' ')}\n` +
  `lineStarts ${lineStarts.length} ${lineStarts.join(' ')}\n` +
  `words ${words.length * 2} ${words.flat().join(' ')}\n`
const auxArgs = [...lineStarts.flatMap((t) => ['--line', String(t)]), ...words.flatMap(([a, b]) => ['--word', `${a}:${b}`])]
const mlFile = join(tmp, 'ml.txt')
writeFileSync(mlFile, `fps 50\nbeats ${mlBeats.length} ${mlBeats.join(' ')}\ndownbeats ${mlDown.length} ${mlDown.join(' ')}\n`)

let failed = 0
for (const withMl of [false, true]) {
  const tag = withMl ? 'with lattice' : 'no lattice'
  const melody = run(['melody', '--wav', stems.vocals, '--raw'])
  const key = run(['key', '--inst', stems.other, '--bass', stems.bass])
  const beats = run(
    withMl
      ? ['beats', '--drums', stems.drums, '--bass', stems.bass, '--vocals', stems.vocals, '--inst', stems.other, '--ml', mlFile, ...auxArgs]
      : ['beats', '--drums', stems.drums, '--bass', stems.bass, '--vocals', stems.vocals, '--inst', stems.other]
  )
  const combinedParts = run(
    ['analyze', '--melody', '--raw', '--key', '--beats', '--vocals', stems.vocals, '--drums', stems.drums, '--bass', stems.bass, '--inst', stems.other, '--ml-stdin'],
    withMl ? mlText : ''
  )
  const combined = { melody: combinedParts.melody, key: combinedParts.key, beats: combinedParts.beats }
  const checks = [
    same('melody.f0', melody.f0, combined.melody.f0),
    same('melody.raw', melody.raw, combined.melody.raw),
    same('melody.rms', melody.rms, combined.melody.rms),
    same('melody.hopSec+stamp', [melody.hopSec, melody.detVersion], [combined.melody.hopSec, combined.melody.detVersion]),
    same('key', { v: key.detVersion, k: key.key }, { v: combined.key.detVersion, k: combined.key.key }),
    same('beats.grid', [beats.ok, beats.bpm, beats.beatsPerBar, beats.downbeat, beats.hasDownbeats], [combined.beats.ok, combined.beats.bpm, combined.beats.beatsPerBar, combined.beats.downbeat, combined.beats.hasDownbeats]),
    same('beats.beatsSec', beats.beatsSec, combined.beats.beatsSec),
    same('beats.downbeats', beats.downbeats, combined.beats.downbeats),
    same('beats.stamp', beats.detVersion, combined.beats.detVersion)
  ]
  const ok = checks.every(Boolean)
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  combined vs individual, ${tag} (${combined.beats.beatsSec.length} beats, ${combined.melody.f0.length} melody frames)`)
}
try { execSync(`rm -rf ${JSON.stringify(tmp)}`) } catch { /* scratch */ }
console.log(failed === 0 ? '\nANALYZE PARITY: the combined pass IS the individual passes' : `\n${failed} LEG(S) DIFFER`)
process.exit(failed === 0 ? 0 : 1)
