/* Native tempo/transpose range E2E (macOS and Windows): the widened native bounds, tempo 0.25..4 and transpose
 * +-24, including the corner pairs. vitest only covers admission; this proves the core actually PLAYS them.
 *
 * Native owns the output (a generated silent-stem project, synthesized time-pitch bus). For each (tempo, transpose)
 * pair: set it, seek, Play, and over ~1.2 s read the native status twice from inside the renderer: the played speed
 * is the rendered project frames advanced per wall second and must equal the requested tempo within 5%. Also asserts
 * the core echoes the requested rate/transpose, native is active, no playbackError, no render failure. SINGZ_MUTE=1
 * always (peaks are not part of this check), so it is silent on any device.
 *
 * npm run build
 * node tests/e2e/mac/native-range-e2e.cjs            (E2E_OUTPUT_UID=<native uid> to pick a non-default output)
 */
'use strict'
require('../../shared/watchdog.cjs').arm('native-range-e2e', { totalMinutes: 8 })
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright-core')
const { createProject } = require('../../shared/box-retained-fixture.cjs')
const { quietLaunch } = require('./quiet-launch.cjs')
const { scratchProfileEnv } = require('../../shared/scratch-profile.cjs')
const { selectNativeOutputBeforeOpen } = require('./native-output.cjs')
const root = path.resolve(__dirname, '../../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-native-range-'))
const profile = path.join(scratch, 'profile'), library = path.join(scratch, 'library'), songDir = path.join(library, 'Native range fixture')
const PAIRS = [[1, 0], [0.25, 0], [4, 0], [0.25, 24], [4, -24], [0.25, -24], [4, 24], [1, 24], [1, -24], [0.5, 12], [2, -12]]
const TOLERANCE = 0.05
/** The one speed predicate: played speed within TOLERANCE of the requested tempo. */
const speedOk = (played, tempo) => Math.abs(played / tempo - 1) <= TOLERANCE
const rows = []
let app
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  try {
    fs.mkdirSync(profile, { recursive: true })
    await createProject(songDir)
    const pj = path.join(songDir, 'project.json'), doc = JSON.parse(fs.readFileSync(pj))
    delete doc.graphHash // the ordinary synthesized song bus, with its time-pitch node
    doc.name = 'Native range fixture'; doc.settings.masterVolume = .2
    fs.writeFileSync(pj, JSON.stringify(doc)); fs.rmSync(path.join(songDir, 'graph.json'))
    app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'out/main/index.js')], env: { ...process.env,
      ...scratchProfileEnv({ dir: profile, projectsRoot: library, settings: { language: 'en' } }), SINGZ_MODELS_DIR: path.join(scratch, 'models'), SINGZ_PACK_DIR: path.join(scratch, 'pack'), SINGZ_NO_SYNC: '1', SINGZ_MUTE: '1',
      SINGZ_E2E_HIDDEN: '1', SINGZ_E2E_HOOKS: '1', SINGZ_LANG: 'en' } })
    await quietLaunch(app) // seeds the first-run quick-start flag
    const win = await app.firstWindow()
    if (process.env.E2E_OUTPUT_UID) await selectNativeOutputBeforeOpen(win, process.env.E2E_OUTPUT_UID)
    // A profile without the models shows the 'Setting up SingZ' wizard; skip it as a singer would.
    for (const deadline = Date.now() + 60000; Date.now() < deadline; await delay(200)) {
      const skip = win.getByRole('button', { name: 'Skip for now' })
      if (await skip.count()) { await skip.first().click().catch(() => {}); continue }
      if (await win.locator('.lib-card').count() && !(await win.locator('.wizard, .quick-start-overlay').count())) break
    }
    await win.locator('.lib-card').filter({ hasText: 'Native range fixture' }).first().click()
    await win.waitForFunction(() => window.__test?.phase === 'ready' && __test.engine.duration > 0, null, { timeout: 60000 })
    // Native must own the output before the first Play, or the first rows measure a fallback/startup race.
    await win.waitForFunction(() => __test.engine.nativeActive === true || __test.engine.nativePlayback?.preparedAhead === true, null, { timeout: 60000 })
    const duration = await win.evaluate(() => __test.engine.duration)
    assert.ok(duration >= 7, `fixture is long enough for 4x (duration ${duration} s)`)
    await win.evaluate(async () => { const e = __test.engine; await e.setMetronome({ ...e.metronome, click: false, countInBars: 0, volume: 0 }) })
    for (const [tempo, transpose] of PAIRS) {
      const label = `tempo ${tempo} / transpose ${transpose > 0 ? '+' : ''}${transpose}`
      const row = { pair: label, requested: tempo, played: '-', error: '-', core: '-', result: 'FAIL', note: '' }
      rows.push(row)
      try {
        const m = await win.evaluate(async ({ tempo, transpose }) => {
          const e = __test.engine, status = () => window.singz.desktopPlaybackStatus(), wait = ms => new Promise(r => setTimeout(r, ms))
          e.pause(); await e.setTempo(tempo); await e.setTranspose(transpose); e.seek(.5); await e.play()
          const until = async (ok, ms) => { const end = performance.now() + ms; let s; do { s = await status(); if (ok(s)) return s; await wait(20) } while (performance.now() < end); return s }
          const a0 = await until(s => s && s.transportState === 'playing', 15000)
          await wait(300) // settle: the first blocks of a stretched stream
          const s1 = await status(), t1 = performance.now()
          await wait(1200)
          const s2 = await status(), t2 = performance.now()
          const out = { state: s2 && s2.transportState, started: !!a0 && a0.transportState === 'playing', native: e.nativeActive, err: e.playbackError ? JSON.stringify(e.playbackError) : null,
            rate: s2 && s2.playbackRate, st: s2 && s2.transposeSemitones, rf: s2 && s2.renderFailures, rate_sr: s2 && s2.format.sampleRate,
            speed: s1 && s2 ? (Number(s2.renderedProjectFrame) - Number(s1.renderedProjectFrame)) / s2.format.sampleRate / ((t2 - t1) / 1000) : NaN }
          e.pause()
          return out
        }, { tempo, transpose })
        row.played = m.speed.toFixed(3)
        row.error = `${((m.speed / tempo - 1) * 100).toFixed(1)}%`
        row.core = `${m.state} rate ${m.rate} st ${m.st}`
        const problems = []
        if (!m.started) problems.push('never reached playing')
        if (!m.native) problems.push('native is not active')
        if (m.err) problems.push(`playbackError ${m.err}`)
        if (m.state !== 'playing') problems.push(`state ${m.state}`)
        if (!speedOk(m.speed, tempo)) problems.push(`speed off by more than ${TOLERANCE * 100}%`)
        if (Math.abs(m.rate - tempo) > 1e-3) problems.push(`core rate ${m.rate} != ${tempo}`)
        if (m.st !== transpose) problems.push(`core transpose ${m.st} != ${transpose}`)
        if (String(m.rf) !== '0') problems.push(`renderFailures ${m.rf}`)
        row.result = problems.length ? 'FAIL' : 'PASS'; row.note = problems.join('; ')
      } catch (error) {
        row.note = String(error.message || error).slice(0, 200)
      }
    }
    if (rows.some(r => r.result !== 'PASS')) {
      // Name the reason rather than leave a wall of FAIL: the engine's own error and the app log's tail.
      const diag = await win.evaluate(async () => ({ err: __test.engine.playbackError ? JSON.stringify(__test.engine.playbackError) : null, native: __test.engine.nativeActive,
        log: (await window.singz.getLog()).slice(-12).map(x => `${x.source}: ${String(x.line).slice(0, 160)}`) })).catch(e => ({ diag: String(e) }))
      console.error('-- engine/log at the first failure --', JSON.stringify(diag, null, 1))
    }
    // Controls on the real predicate: a half-speed sample must fail it, an on-speed sample must pass it.
    rows.push({ pair: 'negative control: half-speed sample (0.5 for 1) is rejected', requested: 1, played: '0.500', error: '-50.0%', core: '-', result: speedOk(0.5, 1) ? 'FAIL' : 'PASS', note: '' })
    rows.push({ pair: 'positive control: on-speed sample (1.01 for 1) is accepted', requested: 1, played: '1.010', error: '1.0%', core: '-', result: speedOk(1.01, 1) ? 'PASS' : 'FAIL', note: '' })
    if (rows.some(r => r.result !== 'PASS')) process.exitCode = 1
  } catch (error) {
    rows.push({ pair: 'driver completion', result: 'FAIL', note: String(error.stack || error) })
    process.exitCode = 1
  } finally {
    console.table(rows)
    if (app) await app.close().catch(() => {})
    if (!process.exitCode) fs.rmSync(scratch, { recursive: true, force: true })
    else console.error(`Private diagnostic fixture retained at ${scratch}`)
  }
})()
