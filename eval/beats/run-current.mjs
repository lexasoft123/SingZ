/**
 * Evaluate the CURRENT homegrown detector (src/renderer/src/audio/analysis.ts)
 * against annotated datasets.
 *
 *   node run-current.mjs --dataset ballroom [--limit N] [--json out.json]
 *   node run-current.mjs --dataset library  [--json out.json]
 *
 * ballroom: full-mix audio from data/ballroom/ (fetch-ballroom.sh) scored
 *   against CPJKU/beat_this_annotations (fetch-annotations.sh). NOTE this
 *   flatters nothing — in the app the detector gets a demucs drums stem plus
 *   bass/vocals/lyric aux; here it gets the raw 30 s mix and no aux.
 *
 * library: the user's own split projects (read-only!) listed in
 *   library-gt.json. Root: $SINGZ_EVAL_LIBRARY, default
 *   ~/Library/Mobile Documents/com~apple~CloudDocs/SingZ. Decodes
 *   stems/drums.flac (+bass, vocals, lyric line starts as aux — mirroring the
 *   app) and checks beatsPerBar + downbeat rotation against the committed
 *   ground truth. Never writes inside project folders; temp files go to
 *   out/tmp/.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { detectorBarLenAt, evaluateTrack } from './metrics.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = dirname(dirname(HERE))
const TMP = join(HERE, 'out', 'tmp')
mkdirSync(TMP, { recursive: true })

/* ---- CLI ---------------------------------------------------------------- */

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null
}
const dataset = opt('--dataset')
const limit = opt('--limit') ? Number.parseInt(opt('--limit'), 10) : Infinity
const jsonOut = opt('--json')
// --grids-out <file.json>: dump the detector's actual grids, not just its
// verdicts. Anchor checks look at a handful of times per song and cannot see
// a bar of 1 beat or 20 — a whole-grid dump is the only way to catch that.
const gridsOut = opt('--grids-out')
const grids = {}
// Reproduce the pre-monoOf app bug (aux read as left channel only).
const CH0 = args.includes('--channel0')
// --ml <raw.jsonl>: feed Beat This! grids (runner-beat-this.py output) as
// aux.ml — the hybrid path the app takes when a splitter pack is installed.
const mlPath = opt('--ml')
const mlById = new Map()
if (mlPath) {
  for (const line of readFileSync(mlPath, 'utf8').trim().split('\n')) {
    if (!line.startsWith('{')) continue
    const r = JSON.parse(line)
    mlById.set(r.id, {
      beats: r.beats,
      downbeats: r.downbeats,
      beatProb: r.beat_prob,
      downbeatProb: r.downbeat_prob,
      fps: r.fps
    })
  }
  console.log(`ml grids: ${mlById.size} from ${mlPath}`)
}
if (dataset !== 'ballroom' && dataset !== 'library') {
  console.error('usage: node run-current.mjs --dataset ballroom|library [--limit N] [--json out.json]')
  process.exit(2)
}

/* ---- Bundle + load the detector ----------------------------------------- */

async function loadDetector() {
  const src = join(REPO, 'src', 'renderer', 'src', 'audio', 'analysis.ts')
  const bundle = join(TMP, 'analysis.bundle.mjs')
  const esbuild = join(REPO, 'node_modules', '.bin', 'esbuild')
  const cmd = existsSync(esbuild) ? esbuild : 'npx'
  const cmdArgs = existsSync(esbuild) ? [] : ['esbuild']
  const r = spawnSync(cmd, [...cmdArgs, src, '--bundle', '--format=esm', `--outfile=${bundle}`], {
    cwd: REPO,
    encoding: 'utf8'
  })
  if (r.status !== 0) {
    console.error('esbuild failed:', r.stderr || r.stdout)
    process.exit(1)
  }
  const mod = await import(pathToFileURL(bundle).href + `?t=${Date.now()}`)
  if (typeof mod.detectBeats !== 'function') {
    console.error('bundle exports no detectBeats')
    process.exit(1)
  }
  return { detectBeats: mod.detectBeats, version: mod.BEAT_DETECT_VERSION }
}

/* ---- Audio decode (ffmpeg → f32le mono 44.1k) ---------------------------- */

let tmpSeq = 0

/**
 * Decode any audio file to Float32Array mono 44.1 kHz.
 * channel0: take channel 0 only (matches the app's aux use of
 * getChannelData(0)); default downmixes L/R equally (matches detectBeats'
 * own stereo averaging).
 */
function decodeF32(file, { channel0 = false } = {}) {
  const tmp = join(TMP, `dec-${process.pid}-${tmpSeq++}.f32`)
  const filterArgs = channel0 ? ['-af', 'pan=mono|c0=c0'] : ['-ac', '1']
  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-i', file, ...filterArgs, '-ar', '44100', '-f', 'f32le', tmp],
    { encoding: 'utf8' }
  )
  if (r.status !== 0) {
    rmSync(tmp, { force: true })
    throw new Error(`ffmpeg failed on ${file}: ${r.stderr}`)
  }
  const buf = readFileSync(tmp)
  rmSync(tmp, { force: true })
  if (buf.byteOffset % 4 === 0) {
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength >> 2)
  }
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** Minimal AudioBuffer stand-in — everything detectBeats touches. */
function audioBuffer(samples, sampleRate = 44100) {
  return {
    sampleRate,
    length: samples.length,
    duration: samples.length / sampleRate,
    numberOfChannels: 1,
    getChannelData: () => samples
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

async function runLibrary(detect) {
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

  const rows = []
  let pass = 0
  let fail = 0
  let checkable = 0
  for (const name of Object.keys(gt.songs).sort()) {
    const spec = gt.songs[name]
    const dir = join(root, name)
    const drums = stemPath(dir, 'drums')
    if (!drums) {
      rows.push({ name, status: 'missing', error: 'no drums stem' })
      console.log(`${name.padEnd(24)} MISSING (no drums stem under ${dir})`)
      continue
    }
    const t0 = Date.now()
    const drumsBuf = audioBuffer(decodeF32(drums))
    const bassP = stemPath(dir, 'bass')
    const vocalsP = stemPath(dir, 'vocals')
    // detectBeats downmixes internally since monoOf landed — faithful aux is
    // a true downmix now (pass --channel0 to reproduce the pre-fix left-only bug).
    const bass = bassP ? audioBuffer(decodeF32(bassP, { channel0: CH0 })) : null
    const vocals = vocalsP ? audioBuffer(decodeF32(vocalsP, { channel0: CH0 })) : null
    // Instrument fill (v7): every remaining stem, mirroring the app.
    const inst = ['other', 'guitar', 'piano']
      .map((n) => stemPath(dir, n))
      .filter(Boolean)
      .map((p) => audioBuffer(decodeF32(p, { channel0: CH0 })))
    let lineStarts = null
    let words = null
    const lyricsP = join(dir, 'lyrics.json')
    if (existsSync(lyricsP)) {
      try {
        const ly = JSON.parse(readFileSync(lyricsP, 'utf8'))
        lineStarts = ly.lines?.map((l) => l.words?.[0]?.s ?? l.start) ?? null
        // aligned words, exactly as the app passes them (v20 meter court)
        words = []
        for (const L of ly.lines ?? []) {
          for (const w of L.words ?? []) {
            if (w.s != null && w.e != null) words.push({ s: w.s, e: w.e })
          }
        }
      } catch {
        lineStarts = null
        words = null
      }
    }
    const dbg = {}
    const ml = mlById.get(name.replace(/[^\w-]+/g, '_')) ?? null
    const det = detect(drumsBuf, { bass, vocals, inst, lineStarts, words, ml }, dbg)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    const got = det
      ? { bpm: Math.round(det.bpm * 10) / 10, bpb: det.beatsPerBar, rot: ((det.downbeat % det.beatsPerBar) + det.beatsPerBar) % det.beatsPerBar }
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
      // Time-anchored check: a bar start must land on the ear-verified bar
      // time (index-based rotations shift whenever newly-tracked intro beats
      // prepend — bar TIMES are the invariant that matters). A song may pin
      // several times (Zeit: one in the rebuilt piano intro, one in the
      // body) — every one must hit.
      checkable++
      const anchors = Array.isArray(spec.barAt) ? spec.barAt : [spec.barAt]
      expected = `bar @ ${anchors.join('+')}s / ${spec.bpb}`
      if (!det || !got || got.bpb !== spec.bpb) {
        status = 'FAIL'
      } else {
        const med = 60 / det.bpm
        const bars = (det.downbeats ?? det.beats.map((_, i) => i).filter((i) => (((i - det.downbeat) % det.beatsPerBar) + det.beatsPerBar) % det.beatsPerBar === 0)).map((i) => det.beats[i])
        const worst = Math.max(
          ...anchors.map((a) => bars.reduce((m, t) => Math.min(m, Math.abs(t - a)), Infinity))
        )
        // 0.3s floor = run-v20's, deliberately: the meter court snaps bar
        // edges to chord onsets, which sit up to ~0.26s from the (slightly
        // early) ear anchor — FaS's 5/4 at 66.46 vs the anchor's 66.2. An
        // ear-verified bar time is not ±220ms sharp at 68 bpm.
        status = worst < Math.max(0.25 * med, 0.3) ? 'pass' : 'FAIL'
      }
    } else if (Array.isArray(spec.rot)) {
      checkable++
      expected = `rot ${JSON.stringify(spec.rot)} / ${spec.bpb}`
      status = got && got.bpb === spec.bpb && spec.rot.includes(got.rot) ? 'pass' : 'FAIL'
    } else {
      // An entry may carry only a note plus secondary anchors (barLenAt) —
      // a song whose score we have but whose bar TIMES are not ear-verified
      // yet. Report it, do not gate on it.
      status = 'report-only'
      expected = 'no stable GT'
    }
    if (status === 'pass') pass++
    if (status === 'FAIL') fail++
    // beatAtMl: ear-approved BEAT times (fused mode only) inside stretches
    // the drums-only path cannot track — the WDOA drift regression. Checked
    // at the beat level, not the bar level: two model runs on near-identical
    // mixes legitimately differ by a beat in loose material, which shifts
    // the bar extension across a void, while beat times agree within ~20 ms.
    let mlStatus = null
    // gridSane: every emitted bar must be a length music actually uses.
    // Unlike every other check here this one needs no ground truth and looks
    // at the WHOLE grid, not a handful of anchor times — which is the only
    // way to see this class. Anchor checks were green on Zeit while it
    // carried a 20-beat bar (~10 s with no downbeat) and on Mr Crowley while
    // it carried four 1-beat bars. Notated meters run 2/4..7/4 (6/8 counted
    // in 6), so anything outside 2..7 is a defect, not a rare time signature.
    if (det && !(det.downbeats && det.downbeats.length > 2)) {
      // Say so rather than passing over it: a uniform grid carries no
      // downbeats[] and so cannot be grid-checked at all. Four of sixteen
      // songs land here, and a bare "30/33" that quietly excluded them
      // would read as coverage it does not have.
      console.log(`${''.padEnd(24)} skipped      gridSane: uniform ${det.beatsPerBar}/4, no downbeats[] to check`)
    }
    // bpmNear: the tempo LEVEL, gated. Anchors cannot see an octave error —
    // halving keeps every bar time, so barAt stays green while the click
    // runs at twice the singer's pulse. Two kinds of entry share the check:
    // targets a level court must reach (Zeit, WYWH at the notation's 61.5)
    // and protection for the ten songs whose level is already ear-approved.
    if (spec?.bpmNear && det) {
      checkable++
      const want = spec.bpmNear.want
      const tol = (spec.bpmNear.tolPct ?? 5) / 100
      const ok = Math.abs(det.bpm - want) <= tol * want
      if (ok) pass++
      else fail++
      console.log(
        `${''.padEnd(24)} ${(ok ? 'pass' : 'FAIL').padEnd(12)} bpmNear: got ${det.bpm.toFixed(1)}, want ${want} ±${Math.round(tol * 100)}%`
      )
    }
    if (det?.downbeats && det.downbeats.length > 2) {
      checkable++
      const lens = det.downbeats.slice(1).map((b, k) => b - det.downbeats[k])
      const bad = lens
        .map((L, k) => ({ L, t: det.beats[det.downbeats[k]] }))
        .filter((x) => x.L < 2 || x.L > 7)
      if (bad.length === 0) pass++
      else fail++
      console.log(
        `${''.padEnd(24)} ${(bad.length === 0 ? 'pass' : 'FAIL').padEnd(12)} gridSane: ` +
        (bad.length === 0
          ? `${lens.length} bars, all 2..7 beats`
          : `${bad.length} impossible bars — ` +
            bad.slice(0, 4).map((x) => `${x.L} beats @ ${x.t.toFixed(1)}s`).join(', ') +
            (bad.length > 4 ? ', …' : ''))
      )
    }
    // barAtMl: ear-approved BAR times inside spliced spans (fused only) —
    // the span-phase vote's regression net (TTP's bass solo). Bar times are
    // chord-anchored by the vote, so they hold across model runs even where
    // the lattice itself can shift a beat.
    // barLenAt: the bar covering time t must be N beats long — the ONLY
    // anchor that can catch an un-modelled meter change, which a uniform-4
    // grid hides completely (it reports a 4-beat bar and simply stretches
    // it). Notated in the published score and verified against the audio.
    if (Array.isArray(spec?.barLenAt) && spec.barLenAt.length > 0) {
      checkable++
      const got2 = spec.barLenAt.map((a) => ({ ...a, saw: det ? detectorBarLenAt(det, a.t) : null }))
      const ok = got2.every((a) => a.saw === a.n)
      if (ok) pass++
      else fail++
      console.log(
        `${''.padEnd(24)} ${(ok ? 'pass' : 'FAIL').padEnd(12)} barLenAt: ` +
        got2.map((a) => `${a.t}s want ${a.n} got ${a.saw ?? 'none'}`).join(', ')
      )
    }
    if (Array.isArray(spec?.barAtMl) && spec.barAtMl.length > 0) {
      if (ml && det) {
        checkable++
        const med = 60 / det.bpm
        const bars = (det.downbeats ?? []).map((i) => det.beats[i])
        const deltas = spec.barAtMl.map((a) =>
          bars.reduce((m, t) => Math.min(m, Math.abs(t - a)), Infinity)
        )
        const ok = deltas.every((d) => d < 0.25 * med)
        if (ok) pass++
        else fail++
        console.log(
          `${''.padEnd(24)} ${(ok ? 'pass' : 'FAIL').padEnd(12)} barAtMl deltas: ${deltas.map((d) => `${Math.round(d * 1000)}ms`).join(' ')} (tol ${Math.round(250 * med)}ms)`
        )
      } else if (ml) {
        checkable++
        fail++
        console.log(`${''.padEnd(24)} FAIL         barAtMl: detector returned null`)
      } else {
        console.log(`${''.padEnd(24)} skipped      barAtMl needs --ml (fused-only anchors)`)
      }
    }
    if (Array.isArray(spec?.beatAtMl) && spec.beatAtMl.length > 0) {
      if (ml && det) {
        checkable++
        const med = 60 / det.bpm
        const deltas = spec.beatAtMl.map((a) =>
          det.beats.reduce((m, t) => Math.min(m, Math.abs(t - a)), Infinity)
        )
        mlStatus = deltas.every((d) => d < 0.25 * med) ? 'pass' : 'FAIL'
        if (mlStatus === 'pass') pass++
        else fail++
        console.log(
          `${''.padEnd(24)} ${mlStatus.padEnd(12)} beatAtMl deltas: ${deltas.map((d) => `${Math.round(d * 1000)}ms`).join(' ')} (tol ${Math.round(250 * med)}ms)`
        )
      } else if (ml) {
        checkable++
        mlStatus = 'FAIL'
        fail++
        console.log(`${''.padEnd(24)} FAIL         beatAtMl: detector returned null`)
      } else {
        console.log(`${''.padEnd(24)} skipped      beatAtMl needs --ml (fused-only anchors)`)
      }
    }
    if (dbg.headWhy || dbg.headBackcast) console.log(`${''.padEnd(24)} head: ${JSON.stringify(dbg.headBackcast ?? dbg.headWhy)}`)
    if (dbg.headOnsets) console.log(`${''.padEnd(24)} headOnsets: ${JSON.stringify(dbg.headOnsets)}`)
    rows.push({ name, status, mlStatus, expected, detected: got, reject: det ? undefined : (dbg.reject ?? 'no tempo family') })
    if (gridsOut && det) {
      grids[name] = {
        bpm: det.bpm,
        beatsPerBar: det.beatsPerBar,
        downbeat: det.downbeat,
        beats: det.beats.map((t) => Math.round(t * 1000) / 1000),
        downbeats: det.downbeats,
        suspectAt: det.suspectAt
      }
    }
    const gotStr = got ? `rot ${got.rot} / ${got.bpb}  ${got.bpm} bpm` : `null (${dbg.reject ?? 'no tempo family'})`
    console.log(`${name.padEnd(24)} ${status.padEnd(12)} got: ${gotStr.padEnd(28)} want: ${expected}  (${secs}s)`)
  }

  console.log(`\nlibrary: ${pass}/${checkable} checks pass${fail ? ` — ${fail} FAILING` : ''}`)
  if (gridsOut) {
    writeFileSync(gridsOut, JSON.stringify(grids, null, 1))
    console.log(`wrote ${Object.keys(grids).length} grids to ${gridsOut}`)
  }
  writeResults({
    dataset: 'library',
    date: new Date().toISOString(),
    gitSha: gitSha(),
    detectorVersion: detectVersion,
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

async function runBallroom(detect) {
  const audioRoot = join(HERE, 'data', 'ballroom')
  const annRoot = join(HERE, 'data', 'beat_this_annotations', 'ballroom', 'annotations', 'beats')
  if (!existsSync(annRoot)) {
    console.error('annotations missing — run ./fetch-annotations.sh first')
    process.exit(1)
  }
  if (!existsSync(audioRoot)) {
    console.error('ballroom audio missing — run ./fetch-ballroom.sh first')
    process.exit(1)
  }
  const { parseBeatsFile } = await import('./metrics.mjs')
  const wavs = findWavs(audioRoot)
  if (wavs.length === 0) {
    console.error(`no .wav files under ${audioRoot} — run ./fetch-ballroom.sh`)
    process.exit(1)
  }

  const tracks = []
  let skippedNoAnn = 0
  let done = 0
  for (const wav of wavs) {
    if (done >= limit) break
    const base = basename(wav, '.wav')
    const annPath = join(annRoot, `ballroom_${base}.beats`)
    if (!existsSync(annPath)) {
      skippedNoAnn++
      continue
    }
    const ann = parseBeatsFile(readFileSync(annPath, 'utf8'))
    if (ann.length === 0) {
      skippedNoAnn++
      continue
    }
    const genre = basename(dirname(wav))
    const dbg = {}
    const ml = mlById.get(base) ?? null
    const det = detect(audioBuffer(decodeF32(wav)), ml ? { ml } : undefined, dbg)
    const r = evaluateTrack(ann, det)
    tracks.push({
      name: base,
      genre,
      meter: WALTZ_GENRES.has(genre) ? '3/4' : '4/4',
      detected: r.detected,
      reject: det ? undefined : (dbg.reject ?? 'no tempo family'),
      bpm: det ? Math.round(det.bpm * 10) / 10 : null,
      bpb: det ? det.beatsPerBar : null,
      beatF: r.beat.f,
      downbeatF: r.downbeat ? r.downbeat.f : null,
      signature: r.signature
    })
    done++
    if (done % 50 === 0) console.log(`  …${done}/${Math.min(limit, wavs.length)} tracks`)
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
      `${label.padEnd(16)} n=${String(a.n).padStart(3)}  det ${fmt(a.detectionRate, 2)}  beatF ${fmt(a.beatF)}  downbeatF ${fmt(a.downbeatF)}  sig ${fmt(a.signature)}   (detected-only: beatF ${fmt(a.beatFDetected)}  downbeatF ${fmt(a.downbeatFDetected)}  sig ${fmt(a.signatureDetected)})`
    )
  console.log(`\nballroom results (${tracks.length} tracks, ${skippedNoAnn} skipped without annotations):`)
  line('overall', overall)
  for (const meter of ['3/4', '4/4']) line(`meter ${meter}`, byMeter[meter])
  for (const g of genres) line(g, byGenre[g])
  const rejects = {}
  for (const t of tracks) if (t.reject) rejects[t.reject] = (rejects[t.reject] ?? 0) + 1
  if (Object.keys(rejects).length) {
    console.log('reject reasons:')
    for (const [why, n] of Object.entries(rejects).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${why}`)
    }
  }

  writeResults({
    dataset: 'ballroom',
    date: new Date().toISOString(),
    gitSha: gitSha(),
    detectorVersion: detectVersion,
    tolerance: 0.07,
    tracks,
    aggregate: { overall, byMeter, byGenre, rejectReasons: rejects }
  })
}

/* ---- main ---------------------------------------------------------------- */

const { detectBeats, version: detectVersion } = await loadDetector()
console.log(`detector: current (BEAT_DETECT_VERSION ${detectVersion}), repo ${gitSha()}`)
if (dataset === 'library') await runLibrary(detectBeats)
else await runBallroom(detectBeats)
