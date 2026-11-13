/* ADR 0016 engine-lane acceptance, generated microphone-only fixture with
 * exact anchors. Run on the current built app/addon with an operator-selected
 * SILENT loopback output (E2E_OUTPUT_UID). No personal projects are opened.
 *
 * npm run build
 * E2E_OUTPUT_UID='<native loopback UID>' node tests/e2e/mac/voice-take-lane-e2e.cjs
 *
 * Native status has no per-lane live peak: isolate voice with Solo and read
 * outputPeak, then compare lane cursorFrames with renderedProjectFrame. PCM
 * placement is measured separately at exact WAV samples, never inferred from
 * renderer polling time. This proves the common native source clock, not a
 * physical loopback or the audible time/pitch output waveform.
 */
'use strict'
require('../../shared/watchdog.cjs').arm('voice-take-lane-e2e', { totalMinutes: 8 })
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright-core')
const { createProject } = require('../../shared/box-retained-fixture.cjs')
const { quietLaunch } = require('./quiet-launch.cjs')
const root = path.resolve(__dirname, '../../..'), rate = 48000
const outputUid = process.env.E2E_OUTPUT_UID
assert.ok(outputUid, 'E2E_OUTPUT_UID must select the reserved silent loopback endpoint (native output bypasses Chromium mute)')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-voice-lane-'))
const profile = path.join(scratch, 'profile'), library = path.join(scratch, 'library'), songDir = path.join(library, 'Voice lane fixture')
const rows = []
let app
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(label, read, accept, timeout = 20000) {
  const deadline = Date.now() + timeout
  let value
  do { value = await read(); if (accept(value)) return value; await delay(10) } while (Date.now() < deadline)
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}
// Every row, the negative control included, lands in the printed table with PASS/FAIL before any assertion throws.
const row = (name, value, limit) => { const pass = value <= limit; rows.push({ test: name, value, limit: `<= ${limit}`, result: pass ? 'PASS' : 'FAIL' }); assert.ok(pass, name) }
const rowAtLeast = (name, value, limit) => { const pass = value > limit; rows.push({ test: name, value, limit: `> ${limit}`, result: pass ? 'PASS' : 'FAIL' }); assert.ok(pass, name) }
// First launch shows the quick-start welcome and the 'Setting up SingZ' model wizard (the scratch SINGZ_MODELS_DIR has
// no models); their scrims block .lib-card clicks. Seed the seen flag (the app's own key) and press the wizard's
// own Skip, as a singer would.
async function clearFirstRun(win) {
  await win.evaluate(() => localStorage.setItem('singz.quick-start.v1', 'seen'))
  await win.reload()
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const skip = win.getByRole('button', { name: 'Skip for now' })
    if (await skip.count()) await skip.first().click().catch(() => {})
    else if (await win.locator('.lib-card').count() && !(await win.locator('.wizard, .quick-start-overlay').count())) return
    await delay(200)
  }
  throw new Error('first-run quick-start/model wizard did not clear')
}
function writeTone(file) {
  const frames = rate * 8, b = Buffer.alloc(44 + frames * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i++) b.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + 2 * i)
  fs.writeFileSync(file, b)
  return b.length
}
;(async () => {
  try {
    fs.mkdirSync(profile, { recursive: true })
    const fixture = await createProject(songDir)
    const pj = path.join(songDir, 'project.json'), doc = JSON.parse(fs.readFileSync(pj))
    delete doc.graphHash // Exercise the ordinary synthesized song bus at every key/tempo.
    doc.name = 'Voice lane fixture'; doc.settings.masterVolume = .2
    fs.writeFileSync(pj, JSON.stringify(doc)); fs.rmSync(path.join(songDir, 'graph.json'))
    const shared = require('esbuild').transformSync(fs.readFileSync(path.join(root, 'src/renderer/src/audio/voice-song-id.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code
    const mod = { exports: {} }; new Function('module', 'exports', shared)(mod, mod.exports)
    const songId = mod.exports.stableVoiceSongId({ path: fixture.songPath, projectDir: songDir })
    const takeId = '11111111-2222-4333-8444-555555555555', dir = path.join(profile, 'voice-takes', songId)
    fs.mkdirSync(dir, { recursive: true })
    const bytes = writeTone(path.join(dir, `${takeId}.wav`)), start = 2.125, offset = .125, placed = start + offset
    fs.writeFileSync(path.join(dir, `${takeId}.json`), JSON.stringify({ version: 1, songId, takeId, songTitle: doc.name, songArtist: '',
      createdAt: new Date().toISOString(), sampleRate: rate, channels: 1, startPositionSec: start, userOffsetSec: offset, durationSec: 8,
      inputLatencyFrames: 0, outputLatencyFrames: 0, graphLatencyFrames: 0, latencySource: 'measured-trim', input: { deviceName: 'generated fixture', channelIndex: 0 },
      settings: [{ atSec: 0, tempo: 1, transposeSemitones: 0 }], anchors: [{ takeFrame: 0, projectFrame: start * rate }, { takeFrame: 8 * rate, projectFrame: (start + 8) * rate }],
      effects: [{ id: 'pitch-follow', enabled: true, params: { manualOffsetSemitones: 0, preserveFormants: false } }], timelineApproximate: false,
      status: 'complete', name: null, matchPercent: null, monitoring: false, audio: { fileName: `${takeId}.wav`, format: 'wav-pcm16', byteSize: bytes, checksum: null } }))
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ projectsRoot: library, language: 'en', outputDeviceId: `native:${outputUid}` }))
    app = await _electron.launch({ executablePath: require('electron'), args: [path.join(root, 'out/main/index.js')], env: { ...process.env,
      SINGZ_USERDATA_DIR: profile, SINGZ_MODELS_DIR: path.join(scratch, 'models'), SINGZ_PACK_DIR: path.join(scratch, 'pack'),
      SINGZ_NO_SYNC: '1', SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_E2E_HOOKS: '1', SINGZ_LANG: 'en' } })
    await quietLaunch(app)
    const win = await app.firstWindow()
    await clearFirstRun(win)
    await win.waitForSelector('.lib-card', { timeout: 60000 })
    await win.locator('.lib-card').filter({ hasText: 'Voice lane fixture' }).first().click()
    await win.waitForFunction(() => window.__test?.phase === 'ready' && __test.engine.duration > 0, null, { timeout: 60000 })
    const inventory = await win.evaluate(() => window.singz.audioHostDevices('coreaudio'))
    const output = inventory.ok && inventory.devices.find(d => d.uid === outputUid && d.outputChannels > 0)
    assert.ok(output && output.transport === 'virtual', 'select a virtual loopback output; this driver never renders on a physical speaker')
    await win.evaluate(uid => __test.engine.setOutput(`native:${uid}`), outputUid)
    await win.waitForFunction(() => __test.engine.voiceTakeLaneState.status === 'ready', null, { timeout: 110000 })
    const source = await win.evaluate(() => __test.engine.voiceTakeSource.path)
    const conformed = fs.readFileSync(source), conformedRate = conformed.readUInt32LE(24)
    let first = -1
    for (let i = 44; i < conformed.length; i += 2) if (Math.abs(conformed.readInt16LE(i)) > 100) { first = (i - 44) / 2; break }
    assert.ok(first >= 0, 'the conformed voice contains signal')
    row('PCM startPosition + userOffset placement (ms)', Math.abs(first / conformedRate - placed) * 1000, 5)
    rowAtLeast('negative control: a deliberate 30 ms offset is rejected (ms off)', Math.abs(first / conformedRate - (placed + .030)) * 1000, 5)
    const status = () => win.evaluate(() => window.singz.desktopPlaybackStatus())
    // The strip's VoiceTakeController owns the lane control and re-asserts its model (solo/mute/level) on every lane
    // or recording state change, so a direct engine.setVoiceTakeControl is overwritten by it. Drive the same chips a
    // singer presses, then wait for the native receipt, which exists only while a generation is open (after Play).
    async function controls(muted, solo) {
      for (const [selector, want] of [['.vs-chip:not(.solo)', muted], ['.vs-chip.solo', solo]]) {
        const chip = win.locator(selector).first()
        await chip.waitFor({ timeout: 20000 })
        if ((await chip.getAttribute('aria-pressed') === 'true') !== want) await chip.click()
      }
      return until('native M/S receipt', status, s => s.lanes.some(l => l.id === 'voice:take' && l.muted === muted && l.solo === solo))
    }
    async function alignment(label) {
      const s = await until('native voice rendering', status, s => s.transportState === 'playing' && s.lanes.some(l => l.id === 'voice:take' && Number(l.cursorFrames) > placed * s.format.sampleRate))
      const voice = s.lanes.find(l => l.id === 'voice:take')
      const song = s.lanes.find(l => l.id !== 'voice:take')
      assert.ok(song, 'a song lane is present alongside voice')
      const errorMs = Math.abs(Number(voice.cursorFrames) - Number(song.cursorFrames)) / s.format.sampleRate * 1000
      row(label, errorMs, 5)
      assert.equal(s.renderFailures, '0'); assert.equal(s.timePitchAnchorMisses, '0'); assert.equal(voice.starvedBlocks, '0')
      return s
    }
    for (const [tempo, transpose] of [[1, 0], [.5, 0], [.5, 3], [1.5, 3]]) {
      await win.evaluate(async ({ tempo, transpose, placed }) => { const e = __test.engine; e.pause(); await e.setTempo(tempo); await e.setTranspose(transpose); e.seek(placed + 1) }, { tempo, transpose, placed })
      await win.locator('body').click({ position: { x: 5, y: 5 } }); await win.keyboard.press('Space')
      await alignment(`native source anchor ${tempo}x / ${transpose}st (ms)`)
      await controls(false, true) // after Play: the receipt needs an open generation; a stopped control is replayed at Play
      const audible = await until('Solo voice has native signal', status, s => Number(s.outputPeak) > .005)
      row(`Solo voice signal ${tempo}x / ${transpose}st`, Number(audible.outputPeak) > .005 ? 0 : 1, 0)
      await controls(true, true)
      await until('Mute silences isolated voice', status, s => Number(s.outputPeak) < .001, 12000)
      row(`Mute voice ${tempo}x / ${transpose}st`, 0, 0)
      await controls(false, true)
    }
    await win.evaluate(async ({ placed }) => { const e = __test.engine; e.pause(); await e.setTempo(1); await e.setTranspose(0); await e.setRegion({ start: placed + 1, end: placed + 2 }, true); e.seek(placed + 1); await e.play() }, { placed })
    await until('A-B wrap', status, s => Number(s.loopCount) >= 2)
    await alignment('A-B loop source anchor (ms)')
    await win.evaluate(async () => { const e = __test.engine; e.pause(); await e.setRegion(null, false); await e.setBeats({ beats: [0,.5,1,1.5,2,2.5,3,3.5,4], bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats: [0], source: 'auto' }); await e.setMetronome({ ...e.metronome, click: false, countInBars: 1, volume: 0 }); e.seek(0); await e.play() })
    await until('native count-in', status, s => s.transportState === 'pre-roll')
    await alignment('count-in source anchor (ms)')
    await win.evaluate(() => __test.engine.pause())
    const saved = [path.join(songDir, 'project.json'), ...fs.readdirSync(songDir).filter(n => n.endsWith('.json')).map(n => path.join(songDir, n))]
    row('saved project excludes transient voice lane', saved.some(f => fs.readFileSync(f, 'utf8').includes('voice:take')) ? 1 : 0, 0)
  } catch (error) {
    rows.push({ test: 'driver completion', result: 'FAIL', detail: String(error.stack || error) })
    process.exitCode = 1
  } finally {
    console.table(rows)
    if (app) await app.close().catch(() => {})
    if (!process.exitCode) fs.rmSync(scratch, { recursive: true, force: true })
    else console.error(`Private diagnostic fixture retained at ${scratch}`)
  }
})()
