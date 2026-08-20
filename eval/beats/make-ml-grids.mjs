/**
 * Produce Beat This! grids for a library of projects, as the raw JSONL the
 * beat harnesses take with `--ml`.
 *
 * These are an INPUT, not a result. eval/beats-parity.mjs compares the
 * TypeScript detector against the C++ port given the SAME aux.ml, so what
 * matters here is that the grid is a real one — the branches a synthetic
 * lattice reaches are the branches someone thought to write, not the ones
 * real songs take (the doubling test, the waltz adoption, the level-mixed
 * splice views). Which mixer produced the model's input does not matter to a
 * parity run and is not claimed to match the desktop's: this sums the stems
 * with ffmpeg, where the app renders them through Chromium, and the two give
 * different grids (docs/BEAT-DETECTION.md — the model is that sensitive).
 * Both are real answers; only one input reaches both sides of the gate.
 *
 *   node eval/beats/make-ml-grids.mjs --library [--out <file.jsonl>]
 *   node eval/beats/make-ml-grids.mjs <project-dir> ... --out <file.jsonl>
 *
 * $BEAT_THIS_PY overrides the interpreter; the default is the installed
 * splitter pack's python, which already carries beat_this and the checkpoint.
 * Each song is cached by its own id, so a re-run only mixes and infers the
 * projects the file does not already name — deleting the file forces all.
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SR = 22050
const PACK_PY = join(homedir(), 'Library', 'Application Support', 'SingZ', 'gpu-splitter', 'python', 'bin', 'python3')
const PY = process.env.BEAT_THIS_PY ?? PACK_PY

const args = process.argv.slice(2)
const dirs = []
let out = join(HERE, 'out', 'ml-library.jsonl')
const libraryRoot = () => {
  for (const id of ['SingZ', 'singz', 'Electron']) {
    const f = join(homedir(), 'Library', 'Application Support', id, 'settings.json')
    if (!existsSync(f)) continue
    try {
      const r = JSON.parse(readFileSync(f, 'utf8')).projectsRoot
      if (r && existsSync(r)) return r
    } catch {
      /* unreadable settings.json — try the next identity */
    }
  }
  return null
}
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i])
  else if (args[i] === '--library') {
    const root = libraryRoot()
    if (!root) {
      console.error('--library: no settings.json names a projectsRoot that exists')
      process.exit(2)
    }
    console.log(`LIBRARY  ${root}`)
    for (const d of readdirSync(root).sort()) if (existsSync(join(root, d, 'stems'))) dirs.push(join(root, d))
  } else dirs.push(resolve(args[i]))
}
if (dirs.length === 0) {
  console.error('usage: make-ml-grids.mjs --library | <project-dir> ... [--out <file.jsonl>]')
  process.exit(2)
}
if (!existsSync(PY)) {
  console.error(`no beat_this python at ${PY} — set $BEAT_THIS_PY (see runner-beat-this.py)`)
  process.exit(2)
}

mkdirSync(dirname(out), { recursive: true })
const have = new Set()
if (existsSync(out)) {
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue
    try {
      have.add(JSON.parse(line).id)
    } catch {
      /* a truncated last line from an interrupted run — it will be re-made */
    }
  }
  console.log(`cached: ${have.size} grid(s) already in ${out}`)
}

const tmp = join(tmpdir(), `singz-ml-mix-${process.pid}`)
mkdirSync(tmp, { recursive: true })
const jobs = []
for (const dir of dirs) {
  const id = basename(dir)
  if (have.has(id)) continue
  const stemDir = join(dir, 'stems')
  const stems = readdirSync(stemDir)
    .filter((f) => /\.(wav|flac|mp3|ogg|m4a)$/i.test(f))
    .sort()
    .map((f) => join(stemDir, f))
  if (stems.length === 0) {
    console.log(`SKIP  ${id} (no stems)`)
    continue
  }
  const f32 = join(tmp, `${id.replace(/[^\w-]+/g, '_')}.f32`)
  // normalize=0: amix scales its inputs by 1/n unless told otherwise, and a
  // sum quieter than the model was trained on is a different input.
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', ...stems.flatMap((f) => ['-i', f]),
      '-filter_complex', `amix=inputs=${stems.length}:duration=longest:normalize=0`,
      '-ac', '1', '-ar', String(SR), '-f', 'f32le', f32],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) {
    console.log(`SKIP  ${id} (ffmpeg: ${String(r.stderr).trim().split('\n').pop()})`)
    continue
  }
  jobs.push({ id, f32, sr: SR })
}
if (jobs.length === 0) {
  console.log('nothing to do — every project already has a grid')
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}
console.log(`mixed ${jobs.length} song(s) -> running beat_this on ${PY}`)

const jobsPath = join(tmp, 'jobs.json')
writeFileSync(jobsPath, JSON.stringify(jobs))
const p = spawn(PY, [join(HERE, 'runner-beat-this.py'), '--jobs', jobsPath, '--checkpoint', 'final0', '--device', 'mps'], {
  env: { ...process.env, PYTHONUNBUFFERED: '1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let buf = ''
let wrote = 0
p.stdout.on('data', (d) => {
  buf += d
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line.startsWith('{')) continue
    // Appended per song, so an interrupted run keeps what it finished.
    appendFileSync(out, `${line}\n`)
    wrote++
    console.log(`  ${wrote}/${jobs.length} ${JSON.parse(line).id}`)
  }
})
p.stderr.on('data', (d) => {
  for (const line of String(d).split('\n')) if (line.startsWith('model ')) console.log(`  ${line}`)
})
p.on('close', (code) => {
  rmSync(tmp, { recursive: true, force: true })
  if (code !== 0) {
    console.error(`runner exited ${code}`)
    process.exit(1)
  }
  console.log(`${wrote} grid(s) -> ${out}`)
})
