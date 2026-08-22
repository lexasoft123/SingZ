/*
 * Melody-framing E2E (macOS): the stored line's hop must come from the STEM
 * FILE's sample rate, never from the machine's audio output. Permanent harness
 * used by the e2e-verifier agent.
 *
 * This guards a bug that shipped for a year under a green parity gate. The
 * tracker's framing is derived from the rate it is handed — `hop = round(sr /
 * DECIM * HOP_SEC)`, `hopSec = hop / (sr / DECIM)`, identically in
 * pitch-core.ts and melody.cpp — and the two sides were handed different
 * rates. The C++ core reads the stem file (44.1 kHz -> 14700 -> a 368-sample
 * hop, 0.0250340136 s). The desktop tracked the PLAYING AudioBuffer, which
 * `decodeAudioData` had already resampled to the playback AudioContext's rate,
 * i.e. the output device's — 48 kHz on most Macs (-> 16000 -> exactly 400,
 * 0.025 s). Measured on Wild World: 8009 frames against 7998, 5% of the shared
 * voiced frames more than a quarter-tone apart, the key readout riding on the
 * same line. Both were stamped current and BOTH GUARDS PASSED — `melodyFitsSong`
 * compares coverage against the song's LENGTH, and one song's two coverages
 * differ by three milliseconds — so a project round-tripping between a phone
 * and a desktop kept whichever line it last got, forever.
 *
 * No unit test can see this: it is a property of what the app hands the worker,
 * and eval/melody-parity.mjs reads one rate off the file and gives it to both
 * implementations, which is why it stayed green throughout.
 *
 * The run asks the app what rate it plays at and then re-encodes the scratch
 * vocals to the OTHER rate of the pair, so the two are never equal and the
 * check can never go quietly vacuous — a driver that passes on a 44.1 kHz rig
 * because the wrong answer and the right one coincide there is worth nothing.
 * `settings.melody` is stripped too, so the run tracks fresh whatever
 * PITCH_DETECT_VERSION is today. Everything happens to a copy; the singer's own
 * project is only ever read.
 *
 * Prereqs: `npm run build` done; no other app instance running (same userData
 * identity); ffmpeg and ffprobe on PATH.
 *
 * Env: E2E_SONG (default "Wild World"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (scratch dir for the copy, default os.tmpdir()).
 */
const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { readFileSync, writeFileSync, cpSync, rmSync, existsSync, renameSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const NAME = process.env.E2E_SONG ?? 'Wild World'
const SCRATCH = join(process.env.E2E_OUT ?? tmpdir(), 'singz-e2e-melody-stem-rate')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
/** pitch-core.ts's own constants — the rule this driver states, not a number. */
const DECIM = 3
const HOP_SEC = 0.025
const hopFor = (rate) => {
  const sr = rate / DECIM
  return Math.round(sr * HOP_SEC) / sr
}

/** Frames a stored line holds, gaps expanded. */
function frames(melody) {
  let n = 0
  for (const tok of melody.f0.split(/\s+/)) {
    if (!tok) continue
    n += tok[0] === 'x' ? (tok.length === 1 ? 1 : Number(tok.slice(1))) : 1
  }
  return n
}

const stemPath = (dir) =>
  ['stems/vocals.flac', 'stems/vocals.wav'].map((f) => join(dir, f)).find(existsSync)

const rateOf = (file) =>
  Number(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=sample_rate',
      '-of', 'default=nw=1:nk=1', file
    ]).toString().trim()
  )

/** Rewrite a stem at `rate`, keeping the format the project stores it in. */
function resampleStem(file, rate) {
  const tmp = `${file}.${rate}.tmp${file.slice(file.lastIndexOf('.'))}`
  const codec = file.endsWith('.flac') ? ['-c:a', 'flac'] : ['-c:a', 'pcm_s16le']
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-ar', String(rate), ...codec, tmp])
  renameSync(tmp, file)
}

;(async () => {
  let app = null
  const fail = []
  try {
    if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true })
    cpSync(join(ROOT, NAME), SCRATCH, { recursive: true })
    const doc = JSON.parse(readFileSync(join(SCRATCH, 'project.json'), 'utf8'))
    delete doc.settings.melody // always a fresh run, whatever the stamp is today
    writeFileSync(join(SCRATCH, 'project.json'), JSON.stringify(doc, null, 2))
    const vocals = stemPath(SCRATCH)
    if (!vocals) throw new Error(`${NAME} has no vocals stem to track`)
    console.log(`${NAME}: copied to scratch, vocals at ${rateOf(vocals)} Hz`)

    app = await _electron.launch({
      executablePath: require('electron'),
      args: [APP],
      env: { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1' } // silent, and never touch the real Drive
    })
    await quietLaunch(app) // measurement runs must not steal the singer's focus
    app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })

    // Ask the app what it plays at, then put the stem on the other rate. The
    // wrong answer (the device's hop) and the right one (the file's) are then
    // always different numbers, on any rig — which is the only way this check
    // means the same thing everywhere it runs.
    const deviceRate = await win.evaluate(() => new AudioContext().sampleRate)
    const stemRate = deviceRate === 44100 ? 48000 : 44100
    resampleStem(vocals, stemRate)
    if (rateOf(vocals) !== stemRate) throw new Error(`could not put the vocals stem on ${stemRate} Hz`)
    const want = hopFor(stemRate)
    const wrong = hopFor(deviceRate)
    // The precondition, asserted rather than reasoned about: two rates that
    // decimate to the same hop would make the check below vacuous while still
    // printing PASS. No Mac plays at 22.05 kHz, but that is the sort of thing a
    // rig is discovered to do years later, in silence.
    if (want === wrong) throw new Error(`${stemRate} Hz and ${deviceRate} Hz both frame at hop ${want} — nothing here can discriminate`)
    console.log(`plays at ${deviceRate} Hz, vocals re-encoded to ${stemRate} Hz`)
    console.log(`so the line must be framed at hop ${want}; tracking the playback buffer would give ${wrong}`)

    const song = ['song.flac', 'song.mp3', 'song.wav', 'song.m4a', 'song.ogg']
      .map((f) => join(SCRATCH, f))
      .find(existsSync)
    if (!song) throw new Error(`${NAME} has no source file to open`)

    // Opened through the hidden input — the same code path as drag-drop.
    for (const pass of [1, 2]) {
      await win.evaluate(() => { delete window.__melody })
      await win.setInputFiles('input[type=file]', song)
      await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
      await win.waitForFunction(() => window.__melody && window.__melody.f0, null, { timeout: 240000 })
      const got = await win.evaluate(() => ({
        hopSec: window.__melody.hopSec,
        frames: window.__melody.f0.length,
        stored: !!window.__melody.stored,
        src: window.__melody.src ?? '(untagged)'
      }))
      console.log(`open #${pass}: hop ${got.hopSec}, ${got.frames} frames, adopted from disk: ${got.stored}, src: ${got.src}`)
      // Which implementation tracked is part of what this driver certifies:
      // a dev/packaged build carries singz-analyze, so the fresh line must be
      // the CORE's — a 'worker' here means the loud-fallback fired, i.e. the
      // binary is missing or stale, and that must fail the run rather than
      // pass on the lookalike TS answer (the parity gates make them
      // indistinguishable in the line, which is exactly why the tag exists).
      if (pass === 1 && got.src !== 'core')
        fail.push(`open #1 tracked via '${got.src}' — expected the core binary (missing or stale singz-analyze?)`)

      if (pass === 1) {
        if (got.stored) fail.push('open #1 adopted a line instead of tracking — settings.melody was not stripped')
        if (got.hopSec !== want) {
          fail.push(
            `open #1 framed at ${got.hopSec}` +
              (got.hopSec === wrong ? " — that is the OUTPUT DEVICE's rate, not the stem's" : '')
          )
        }
        // and the same framing has to be what reaches project.json, since that
        // is the copy the phones read and the copy nothing re-derives.
        let saved = null
        for (let i = 0; i < 60 && !saved; i++) {
          await new Promise((r) => setTimeout(r, 1000))
          saved = JSON.parse(readFileSync(join(SCRATCH, 'project.json'), 'utf8')).settings.melody ?? null
        }
        if (!saved) {
          fail.push('the fresh line was never saved into project.json')
        } else {
          const cov = frames(saved) * saved.hopSec
          console.log(`saved: v${saved.detVersion} hop ${saved.hopSec}, ${frames(saved)} frames, covering ${cov.toFixed(2)}s`)
          // encodeMelody rounds hopSec to 1e-7 on the way in — 0.1 ms of drift
          // over a whole song, and the same rounding the phones store.
          if (saved.hopSec !== Math.round(want * 1e7) / 1e7) fail.push(`saved hop ${saved.hopSec}, wanted ${Math.round(want * 1e7) / 1e7}`)
          if (frames(saved) !== got.frames) fail.push(`saved ${frames(saved)} frames, tracked ${got.frames}`)
        }
      } else if (!got.stored) {
        // The other half of the bump: a current line must be ADOPTED. Re-tracking
        // one would re-dirty the library for Drive on every single open.
        fail.push('open #2 re-tracked a line it had just written at the current stamp')
      }
    }
  } finally {
    await app?.close().catch(() => {})
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  if (fail.length) {
    console.log('FAIL:', fail.join('; '))
    process.exit(1)
  }
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
