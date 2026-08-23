/*
 * Beat-input E2E (macOS): the beat grid must come from the stem FILES at the
 * rate they state, never from the playing buffers at the output device's.
 * Permanent harness used by the e2e-verifier agent.
 *
 * This guards a measured field bug, not a hypothetical: with the playing
 * buffers as input (Chromium decodes to the device's rate; monoAt44k linearly
 * interpolates back down), a 48 kHz output device flipped the octave decision
 * on 2 of 4 library songs — Wild World detected at 156.6 bpm, the precise
 * figure eval/beats/library-gt.json records as "the pre-v16 wrong answer",
 * and Zeit at half its rate. eval/beats/run-current.mjs, which minted every
 * ground truth, has only ever decoded at the file's rate, so no harness run
 * could see it; run it with --rate 48000 to reproduce the broken path.
 *
 * The driver stubs the beat model off in main (beats:mlAvailable -> false),
 * because the neural lattice anchors the tempo and can mask the flip — the
 * homegrown path alone is where the octave decision is naked. It then opens a
 * scratch copy whose settings.beat is stripped, waits for the fresh grid, and
 * asserts the OCTAVE: the detected bpm must sit within 5% of the bpm the
 * committed ground truth wants, not at its double or half. On a 44.1 kHz
 * output device the two input paths coincide and the run cannot discriminate
 * — it says so and still asserts the GT octave, which any regression to
 * buffer-feeding would fail on the fleet's 48 kHz machines.
 *
 * Prereqs: `npm run build`; no other app instance (same userData identity).
 *
 * Env: E2E_SONG (default "Wild World" — GT bpmNear 77.1, the strongest known
 *      flip), E2E_PROJECTS_ROOT, E2E_OUT.
 *
 * E2E_SONG must be a song whose NAKED detector already lands on the GT octave
 * from correct input: several GT entries (Zeit, Wish You Were Here, Puppe,
 * Primo Victoria, Going To The Run) deliberately record a `want` at the level
 * the model-off detector does not choose — their notes read "from-scratch det
 * says 123/58.7/62.3" — so they false-FAIL here with the fix in place. And it
 * must carry a bpmNear at all (Sixteen Tons does not — the driver refuses it
 * cleanly at startup). Known good: Wild World, Nothing Else Matters.
 */
const { _electron } = require('playwright-core')
const { readFileSync, writeFileSync, cpSync, rmSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')
const { quietLaunch } = require('./quiet-launch.cjs')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const NAME = process.env.E2E_SONG ?? 'Wild World'
const SCRATCH = join(process.env.E2E_OUT ?? tmpdir(), 'singz-e2e-beat-stem-rate')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
const GT = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'eval', 'beats', 'library-gt.json'), 'utf8')
).songs

;(async () => {
  let app = null
  const fail = []
  try {
    const gt = GT[NAME]?.bpmNear
    if (!gt) throw new Error(`${NAME} has no bpmNear ground truth — pick a song that does`)

    if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true })
    cpSync(join(ROOT, NAME), SCRATCH, { recursive: true })
    const doc = JSON.parse(readFileSync(join(SCRATCH, 'project.json'), 'utf8'))
    delete doc.settings.beat // always a fresh detection, whatever the stamp is today
    writeFileSync(join(SCRATCH, 'project.json'), JSON.stringify(doc, null, 2))

    app = await _electron.launch({
      executablePath: require('electron'),
      args: [APP],
      env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1' } // silent, never the real Drive
    })
    await quietLaunch(app)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })

    // No neural safety net: the octave decision stands alone.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('beats:mlAvailable')
      ipcMain.handle('beats:mlAvailable', () => ({ ok: true, available: false }))
    })

    const deviceRate = await win.evaluate(() => new AudioContext().sampleRate)
    const src = ['song.flac', 'song.mp3', 'song.wav', 'song.m4a', 'song.ogg']
      .map((f) => join(SCRATCH, f))
      .find(existsSync)
    if (!src) throw new Error(`${NAME} has no source file to open`)
    await win.setInputFiles('input[type=file]', src)
    await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    await win.waitForFunction(() => window.__beatDbg && window.__beatDbg.det, null, { timeout: 300000 })

    const got = await win.evaluate(() => ({
      bpm: window.__beatDbg.det.bpm,
      beats: window.__beatDbg.det.beats.length,
      inputRate: window.__beatDbg.drums.sr,
      ml: window.__beatDbg.ml,
      src: window.__beatDbg.src ?? '(untagged)'
    }))
    console.log(`${NAME}: GT wants ~${gt.want} bpm (±${gt.tolPct}%) · device plays at ${deviceRate} Hz`)
    console.log(`detected: ${got.bpm.toFixed(4)} bpm, ${got.beats} beats · detectBeats was fed ${got.inputRate} Hz · ml=${got.ml ? 'PRESENT (stub failed!)' : 'off'} · src=${got.src}`)
    // Which implementation built the grid is certified here too (Phase 4):
    // a 'ts' on a build that carries singz-analyze means the loud fallback
    // fired, and that must fail rather than pass on the lookalike answer.
    if (got.src !== 'core') fail.push(`beat grid built via '${got.src}' — expected the core binary`)
    if (deviceRate === 44100)
      console.log('NOTE: this machine plays at 44.1 kHz, so buffer- and file-feeding coincide here — the input check below is the discriminating one')

    if (got.ml) fail.push('the beat-model stub did not take — this run proves nothing about the naked path')
    // The input assertion: the samples must be the file's. 44100 is what every
    // splitter stem states; a device-rate number here IS the old path.
    if (got.inputRate !== 44100)
      fail.push(`detectBeats was fed ${got.inputRate} Hz — the playing buffer, not the stem file`)
    // The outcome assertion: the OCTAVE the ground truth established by ear
    // and score. Half or double lands far outside ±tolPct.
    const off = Math.abs(got.bpm - gt.want) / gt.want
    if (off > gt.tolPct / 100)
      fail.push(
        `bpm ${got.bpm.toFixed(1)} is ${(100 * off).toFixed(0)}% from the GT's ${gt.want}` +
          (Math.abs(got.bpm / gt.want - 2) < 0.1 ? ' — the DOUBLED octave, the exact pre-v16 wrong answer' : '')
      )
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
