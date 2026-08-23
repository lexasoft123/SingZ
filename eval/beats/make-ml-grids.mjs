/**
 * Produce Beat This! grids for a library of projects, as the raw JSONL the
 * beat harnesses take with `--ml`.
 *
 * These are an INPUT, not a result. eval/beats-parity.mjs compares the
 * TypeScript detector against the C++ port given the SAME aux.ml, so what
 * matters here is that the grid is a real one — the branches a synthetic
 * lattice reaches are the branches someone thought to write, not the ones
 * real songs take (the doubling test, the waltz adoption, the level-mixed
 * splice views). The mixer IS the desktop's now: singz-analyze mlmix — the
 * core's sumStemsTo22k, the same render the app ships and the phones run
 * (docs/BEAT-DETECTION.md records the study that unified them; the ffmpeg
 * mixes this replaced carried the same -3 dB pan-law level, so the research
 * record's provenance is continuous).
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
let cachedBin = null
const analyzeBin = () => {
  if (!cachedBin)
    cachedBin = spawnSync('bash', [join(HERE, '..', '..', 'scripts', 'build-analyze-host.sh')], { encoding: 'utf8' }).stdout.trim()
  return cachedBin
}

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
  // The id is SLUGGED — run-current.mjs looks lattices up by
  // name.replace(/[^\w-]+/g,'_'), and raw names left every multi-word song
  // silently lattice-less in --ml runs (found 2026-08-24; the historical
  // "45/51 with the model" was a partial-lattice run).
  const id = basename(dir).replace(/[^\w-]+/g, '_')
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
  const r = spawnSync(analyzeBin(), ['mlmix', f32, ...stems], { encoding: 'utf8' })
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
