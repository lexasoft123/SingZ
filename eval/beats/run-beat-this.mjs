/**
 * Evaluate Beat This! (CPJKU, MIT) against the same datasets as run-current.
 *
 *   node run-beat-this.mjs --dataset ballroom [--limit N] [--json out.json]
 *   node run-beat-this.mjs --dataset library  [--json out.json]
 *   flags: --checkpoint final0|small0 (default final0), --device mps|cpu
 *
 * Needs $BEAT_THIS_PY = python with beat_this installed (see
 * runner-beat-this.py header). The model takes a FULL MIX — library mode sums
 * every stem of a project at 22.05 kHz mono (cached in out/tmp/mix-*.f32,
 * delete to refresh). Ballroom clips are fed as-is.
 *
 * Output mapping: Beat This! emits beat + downbeat TIMES with no meter prior;
 * we map downbeat times to indices into beats[] (the app's downbeats[] schema)
 * and derive the legacy beatsPerBar as the dominant bar length. Reject-class
 * songs (The Music Of The Night) are scored FAIL when a grid comes back —
 * Beat This! always answers; the accept/reject policy belongs to the verifier
 * (phase 2 wiring) and this report prints the stability numbers to design it.
 */

import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateTrack, parseBeatsFile } from './metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(dirname(HERE))
const TMP = join(HERE, 'out', 'tmp')
mkdirSync(TMP, { recursive: true })

/* ---- CLI ---------------------------------------------------------------- */

const args = process.argv.slice(2)
const opt = (name, dflt = null) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}
const dataset = opt('--dataset')
const limit = opt('--limit') ? Number.parseInt(opt('--limit'), 10) : Infinity
const jsonOut = opt('--json')
const checkpoint = opt('--checkpoint', 'final0')
const device = opt('--device', 'mps')
if (dataset !== 'ballroom' && dataset !== 'library') {
  console.error('usage: node run-beat-this.mjs --dataset ballroom|library [--limit N] [--json out.json] [--checkpoint final0] [--device mps]')
  process.exit(2)
}
const PY = process.env.BEAT_THIS_PY
if (!PY || !existsSync(PY)) {
  console.error('BEAT_THIS_PY must point at a python with beat_this installed (see runner-beat-this.py)')
  process.exit(2)
}

/* ---- Decode helpers (ffmpeg → f32le mono 22.05k) ------------------------- */

const SR = 22050

/** Decode one file to raw f32le mono 22.05k at dest. */
function decodeTo(dest, file) {
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', dest],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(`ffmpeg failed on ${file}: ${r.stderr}`)
}

/** Sum several stems into one f32le mono 22.05k mix at dest. */
function mixTo(dest, files) {
  const inputs = files.flatMap((f) => ['-i', f])
  const filter = `amix=inputs=${files.length}:duration=longest:normalize=0`
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, '-ac', '1', '-ar', String(SR), '-f', 'f32le', dest],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) throw new Error(`ffmpeg mix failed (${files.join(', ')}): ${r.stderr}`)
}

/* ---- Runner invocation --------------------------------------------------- */

/** Run the batch through runner-beat-this.py; returns Map id → result. */
function runBatch(jobs, label) {
  const jobsPath = join(TMP, `bt-jobs-${process.pid}.json`)
  writeFileSync(jobsPath, JSON.stringify(jobs))
  const out = new Map()
  return new Promise((resolve, reject) => {
    const p = spawn(PY, [join(HERE, 'runner-beat-this.py'), '--jobs', jobsPath, '--checkpoint', checkpoint, '--device', device], {
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let buf = ''
    p.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const r = JSON.parse(line)
        out.set(r.id, r)
      }
    })
    let done = 0
    p.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) {
        if (line.startsWith('model ')) console.log(`  ${line}`)
        if (line.startsWith('done ') && ++done % 50 === 0) console.log(`  …${done}/${jobs.length} ${label}`)
      }
    })
    p.on('close', (code) => {
      rmSync(jobsPath, { force: true })
      if (code !== 0) reject(new Error(`runner exited ${code}`))
      else resolve(out)
    })
  })
}

/* ---- Output mapping ------------------------------------------------------ */

/** Map runner output → the app/metrics detector shape (+ stability stats). */
function toDetector(r) {
  if (!r || !r.beats || r.beats.length < 8) return null
  const beats = r.beats
  // downbeat times → strictly-increasing indices into beats
  const dbIdx = []
  let from = 0
  for (const t of r.downbeats) {
    let best = -1
    let bd = Infinity
    for (let i = from; i < beats.length; i++) {
      const d = Math.abs(beats[i] - t)
      if (d < bd) {
        bd = d
        best = i
      } else if (beats[i] > t) break
    }
    if (best > (dbIdx.length ? dbIdx[dbIdx.length - 1] : -1)) {
      dbIdx.push(best)
      from = best + 1
    }
  }
  // dominant bar length + bar-length histogram
  const hist = {}
  for (let k = 0; k + 1 < dbIdx.length; k++) {
    const n = dbIdx[k + 1] - dbIdx[k]
    hist[n] = (hist[n] ?? 0) + 1
  }
  const barLens = Object.entries(hist).sort((a, b) => b[1] - a[1])
  const bpb = barLens.length ? Number(barLens[0][0]) : 4
  // tempo + stability
  const iv = []
  for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1])
  const sorted = [...iv].sort((a, b) => a - b)
  const med = sorted[sorted.length >> 1] ?? 0.5
  const devs = iv.map((x) => Math.abs(x - med) / med).sort((a, b) => a - b)
  const p90 = devs.length ? devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.9))] : 0
  return {
    beats,
    downbeats: dbIdx.length >= 2 ? dbIdx : undefined,
    beatsPerBar: bpb,
    downbeat: dbIdx[0] ?? 0,
    bpm: 60 / med,
    stats: { barHist: hist, ivP90: p90, nBeats: beats.length, nBars: dbIdx.length }
  }
}

const fmt = (x, d = 3) => (x == null ? '   —' : x.toFixed(d))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

function writeResults(payload) {
  if (!jsonOut) return
  writeFileSync(jsonOut, JSON.stringify(payload, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

/* ---- Library mode -------------------------------------------------------- */

const STEMS = ['drums', 'bass', 'vocals', 'other', 'guitar', 'piano']

async function runLibrary() {
  const gt = JSON.parse(readFileSync(join(HERE, 'library-gt.json'), 'utf8'))
  const root =
    process.env.SINGZ_EVAL_LIBRARY ||
    join(homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'SingZ')
  if (!existsSync(root)) {
    console.error(`library root not found: ${root} (set SINGZ_EVAL_LIBRARY)`)
    process.exit(1)
  }
  console.log(`library root: ${root}`)

  const stemPath = (dir, name) => {
    for (const ext of ['flac', 'wav']) {
      const p = join(dir, 'stems', `${name}.${ext}`)
      if (existsSync(p)) return p
    }
    return null
  }

  // Build (cached) full-mix decodes, then one batch through the model.
  const jobs = []
  const missing = []
  for (const name of Object.keys(gt.songs).sort()) {
    const dir = join(root, name)
    const stems = STEMS.map((s) => stemPath(dir, s)).filter(Boolean)
    if (stems.length === 0) {
      missing.push(name)
      continue
    }
    const mix = join(TMP, `mix-${name.replace(/[^\w-]+/g, '_')}.f32`)
    if (!existsSync(mix)) {
      console.log(`  mixing ${name} (${stems.length} stems)`)
      mixTo(mix, stems)
    }
    jobs.push({ id: name, f32: mix, sr: SR })
  }
  for (const name of missing) console.log(`${name.padEnd(24)} MISSING (no stems)`)

  const results = await runBatch(jobs, 'songs')

  const rows = []
  let pass = 0
  let fail = 0
  let checkable = 0
  for (const name of Object.keys(gt.songs).sort()) {
    const spec = gt.songs[name]
    const r = results.get(name)
    if (!r) continue
    const det = toDetector(r)
    const got = det
      ? { bpm: Math.round(det.bpm * 10) / 10, bpb: det.beatsPerBar }
      : null

    let status
    let expected
    if (spec === null) {
      status = 'report-only'
      expected = 'no stable GT'
    } else if (spec.reject) {
      checkable++
      status = det === null ? 'pass' : 'FAIL'
      expected = 'reject (null)'
    } else if (spec.barAt != null) {
      checkable++
      expected = `bar @ ${spec.barAt}s / ${spec.bpb}`
      if (!det || !got || got.bpb !== spec.bpb) {
        status = 'FAIL'
      } else {
        const med = 60 / det.bpm
        const bars = (det.downbeats ?? []).map((i) => det.beats[i])
        const near = bars.reduce((m, t) => Math.min(m, Math.abs(t - spec.barAt)), Infinity)
        status = near < 0.25 * med ? 'pass' : 'FAIL'
      }
    } else {
      // rot-only spec (none left in GT, kept for parity): cannot compare
      // detector-relative rotations across grids — report only.
      status = 'report-only'
      expected = `rot ${JSON.stringify(spec.rot)} / ${spec.bpb}`
    }
    if (status === 'pass') pass++
    if (status === 'FAIL') fail++
    const s = det?.stats
    const histStr = s
      ? Object.entries(s.barHist)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([n, c]) => `${n}×${c}`)
          .join(' ')
      : ''
    rows.push({ name, status, expected, detected: got, stats: s, infer_s: r.infer_s })
    const gotStr = got ? `bpb ${got.bpb}  ${got.bpm} bpm` : 'null'
    console.log(
      `${name.padEnd(24)} ${status.padEnd(12)} got: ${gotStr.padEnd(22)} want: ${String(expected).padEnd(22)} bars[${histStr}] ivP90 ${fmt(s?.ivP90, 2)} (${r.infer_s}s)`
    )
  }

  console.log(`\nlibrary (beat-this ${checkpoint}): ${pass}/${checkable} checks pass${fail ? ` — ${fail} FAILING` : ''}`)
  writeResults({
    dataset: 'library',
    backend: `beat-this:${checkpoint}`,
    device,
    date: new Date().toISOString(),
    gitSha: gitSha(),
    root,
    tracks: rows,
    aggregate: { pass, checkable, fail }
  })
  process.exit(fail > 0 ? 1 : 0)
}

/* ---- Ballroom mode ------------------------------------------------------- */

const WALTZ_GENRES = new Set(['Waltz', 'VienneseWaltz', 'SlowWaltz'])

function findWavs(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.wav$/i.test(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

async function runBallroom() {
  const audioRoot = join(HERE, 'data', 'ballroom')
  const annRoot = join(HERE, 'data', 'beat_this_annotations', 'ballroom', 'annotations', 'beats')
  if (!existsSync(annRoot) || !existsSync(audioRoot)) {
    console.error('data missing — run ./fetch-annotations.sh and ./fetch-ballroom.sh first')
    process.exit(1)
  }
  const wavs = findWavs(audioRoot)

  // decode + run in batches to cap temp disk (~130 MB per 100 clips)
  const BATCH = 200
  const pending = []
  for (const wav of wavs) {
    if (pending.length >= limit) break
    const base = basename(wav, '.wav')
    const annPath = join(annRoot, `ballroom_${base}.beats`)
    if (!existsSync(annPath)) continue
    pending.push({ wav, base, annPath })
  }

  const tracks = []
  for (let i = 0; i < pending.length; i += BATCH) {
    const slice = pending.slice(i, i + BATCH)
    const jobs = []
    for (const t of slice) {
      const f32 = join(TMP, `bt-${t.base}.f32`)
      decodeTo(f32, t.wav)
      jobs.push({ id: t.base, f32, sr: SR })
    }
    const results = await runBatch(jobs, 'clips')
    for (const t of slice) {
      rmSync(join(TMP, `bt-${t.base}.f32`), { force: true })
      const r = results.get(t.base)
      const det = toDetector(r)
      const ann = parseBeatsFile(readFileSync(t.annPath, 'utf8'))
      if (ann.length === 0) continue
      const ev = evaluateTrack(ann, det)
      const genre = basename(dirname(t.wav))
      tracks.push({
        name: t.base,
        genre,
        meter: WALTZ_GENRES.has(genre) ? '3/4' : '4/4',
        detected: ev.detected,
        bpm: det ? Math.round(det.bpm * 10) / 10 : null,
        bpb: det ? det.beatsPerBar : null,
        beatF: ev.beat.f,
        downbeatF: ev.downbeat ? ev.downbeat.f : null,
        signature: ev.signature,
        infer_s: r?.infer_s
      })
    }
    console.log(`  …${Math.min(i + BATCH, pending.length)}/${pending.length} clips`)
  }

  const agg = (subset) => {
    const det = subset.filter((t) => t.detected)
    const m = (sel, from) => mean(from.map(sel).filter((x) => x != null))
    return {
      n: subset.length,
      detected: det.length,
      detectionRate: subset.length ? det.length / subset.length : null,
      beatF: m((t) => t.beatF, subset),
      downbeatF: m((t) => t.downbeatF, subset),
      signature: m((t) => t.signature, subset),
      beatFDetected: m((t) => t.beatF, det),
      downbeatFDetected: m((t) => t.downbeatF, det),
      signatureDetected: m((t) => t.signature, det)
    }
  }
  const overall = agg(tracks)
  const byMeter = {}
  for (const meter of ['3/4', '4/4']) byMeter[meter] = agg(tracks.filter((t) => t.meter === meter))
  const genres = [...new Set(tracks.map((t) => t.genre))].sort()
  const byGenre = {}
  for (const g of genres) byGenre[g] = agg(tracks.filter((t) => t.genre === g))

  const line = (label, a) =>
    console.log(
      `${label.padEnd(16)} n=${String(a.n).padStart(3)}  det ${fmt(a.detectionRate, 2)}  beatF ${fmt(a.beatF)}  downbeatF ${fmt(a.downbeatF)}  sig ${fmt(a.signature)}`
    )
  console.log(`\nballroom results — beat-this ${checkpoint} on ${device} (${tracks.length} tracks):`)
  line('overall', overall)
  for (const meter of ['3/4', '4/4']) line(`meter ${meter}`, byMeter[meter])
  for (const g of genres) line(g, byGenre[g])
  const inferTotal = tracks.reduce((a, t) => a + (t.infer_s ?? 0), 0)
  console.log(`total inference ${inferTotal.toFixed(0)}s for ${tracks.length} clips (${(inferTotal / Math.max(1, tracks.length)).toFixed(2)}s/clip)`)

  writeResults({
    dataset: 'ballroom',
    backend: `beat-this:${checkpoint}`,
    device,
    date: new Date().toISOString(),
    gitSha: gitSha(),
    tolerance: 0.07,
    tracks,
    aggregate: { overall, byMeter, byGenre }
  })
}

/* ---- main ---------------------------------------------------------------- */

console.log(`detector: beat-this ${checkpoint} (${device}), repo ${gitSha()}`)
if (dataset === 'library') await runLibrary()
else await runBallroom()
