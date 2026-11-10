'use strict'
const watchdog = require('../shared/watchdog.cjs').arm('box-retained-recovery', {
  totalMinutes: 7, idleMinutes: 3, onTimeout: () => cleanup()
})
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createProject, mutateLyrics } = require('../shared/box-retained-fixture.cjs')
const { startHost, connectHost, assertNoPhysical, delay, eventually } = require('../shared/box-host-client.cjs')
const { startBoxHostRecorder } = require('../shared/box-host-recorder.cjs')
const { launchUi, closeUi, openInitial, waitRestored, adjustVocals, waitStopFallback } = require('../shared/box-retained-ui.cjs')

const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-box-retained-'))
fs.chmodSync(scratch, 0o700)
const socketPath = path.join(scratch, 'audio.sock')
const recorderSocketPath = path.join(scratch, 'ui-audio.sock')
const names = ['home', 'config', 'data', 'cache', 'profile', 'library', 'models', 'pack', 'host-profile']
for (const name of names) { fs.mkdirSync(path.join(scratch, name), { recursive: true }); fs.chmodSync(path.join(scratch, name), 0o700) }
const userData = path.join(scratch, 'profile'), library = path.join(scratch, 'library')
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsRoot: library, language: 'en' }), { mode: 0o600 })
fs.writeFileSync(path.join(userData, 'box-state.json'), JSON.stringify({ version: 1,
  preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' }, queue: [] }), { mode: 0o600 })
const env = {
  ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
  XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'),
  SINGZ_USERDATA_DIR: userData, SINGZ_MODELS_DIR: path.join(scratch, 'models'), SINGZ_PACK_DIR: path.join(scratch, 'pack'),
  SINGZ_BOX_AUDIO_SOCKET: recorderSocketPath,
  SINGZ_NO_SYNC: '1', SINGZ_NO_SYSTEM_ENGINES: '1', SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1',
  SINGZ_BOX_CEC: '0', SINGZ_LANG: 'en'
}
for (const key of ['SINGZ_SURFACE', 'SINGZ_GDRIVE_CONFIG', 'SINGZ_BOX_PLATFORM_SOCKET', 'SINGZ_CAPTURE_ADDON', 'ELECTRON_RUN_AS_NODE']) delete env[key]
let host, client, ui, recorder, closing
const launches = []
async function launch() { ui = await launchUi({ root, env }); launches.push(ui); return ui.page }
async function close() { if (ui) { await closeUi(ui.app); ui = null } }
async function cleanup() {
  if (closing) return closing
  closing = (async () => {
    if (ui) {
      const child = ui.app.process()
      await Promise.race([ui.app.close().catch(() => undefined), delay(2500)])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM'); await delay(500)
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }
    }
    if (client) await client.close().catch(() => undefined)
    if (recorder) await recorder.close().catch(() => undefined)
    if (host) await host.close().catch(() => undefined)
    fs.rmSync(scratch, { recursive: true, force: true })
  })()
  return closing
}
const status = () => client.call('owner', 'playbackStatus')
const snapshot = () => client.call('service', 'reconcile')
async function routing() {
  const value = JSON.parse(await client.call('routing', 'request', ['{"version":1,"operation":"state"}']))
  assertNoPhysical(value)
  return value
}
function continuity(before, after) {
  assert.equal(after.generation, before.generation)
  // ClockReanchored telemetry also counts ordinary >2 ms driverless scheduler jitter.
  for (const key of ['seekCount', 'streamGeneration', 'routeGeneration']) assert.equal(after[key], before[key], key)
  assert.ok(BigInt(after.continuousFrame) > BigInt(before.continuousFrame), 'continuous native frames advance')
  assert.ok(BigInt(after.renderedProjectFrame) > BigInt(before.renderedProjectFrame), 'project frames advance')
}
async function recovered(generation, fixture) {
  return eventually('recovery metadata binds the actual song and graph', snapshot, value =>
    value.epoch === client.epoch && value.recovery?.generation === generation &&
    value.recovery.descriptor.project.graphHash === fixture.graphSha &&
    value.recovery.descriptor.config.graphDocument?.nodes.length === fixture.graph.nodes.length, 20000)
}

async function run() {
  assert.equal(process.platform, 'linux', 'retained recovery qualification requires Linux')
  const fixture = await createProject(path.join(library, 'retained-song'))
  assert.equal(fixture.graph.nodes.length, 28)
  host = await startHost({ root, scratch, socketPath, env })
  recorder = await startBoxHostRecorder({ socketPath: recorderSocketPath, realSocketPath: socketPath })
  client = await connectHost(host, socketPath)
  await watchdog.run('initialize one logical native-source bus and no physical routes', 15, async () => {
    const initial = await routing()
    const commands = [
      { type: 'createDevice', id: 'music', name: 'music', channels: 2, sampleRate: 48000, passThrough: false },
      { type: 'addSource', device: 'music', id: 'song', kind: 'application', selector: 'native:singz', channels: 2, muteOriginal: false, connectByDefault: true }
    ]
    const initialized = JSON.parse(await client.call('routing', 'request', [JSON.stringify({ version: 1, operation: 'initialize', request: { version: 1, expected: initial.snapshot.revision, commands } })]))
    assert.equal(initialized.ok, true, JSON.stringify(initialized))
    await routing()
  })
  let baseline
  await watchdog.run('real UI opens the stems-only project and associates its graph', 75, async () => {
    const page = await launch()
    await openInitial(page, fixture)
    const running = await eventually('real native generation advances', status, value =>
      value.state === 'running' && value.transportState === 'playing' && BigInt(value.renderedProjectFrame) > 0n && value.masterGain === 0, 20000)
    const bound = await recovered(running.generation, fixture)
    assert.equal(bound.recovery.descriptor.lanes.find(lane => lane.id === 'vocals').gain, 1)
    await adjustVocals(page)
    const controlled = await eventually('remote ArrowLeft changes the accepted native stem gain', status, value =>
      value.generation === running.generation && value.lanes.find(lane => lane.id === 'vocals').gain < 1)
    const desiredVocalsGain = controlled.lanes.find(lane => lane.id === 'vocals').gain
    const saved = await eventually('accepted vocals gain is persisted', () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(fixture.dir, 'project.json'), 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
        throw error
      }
    }, saved => {
      const volume = saved?.settings?.tracks?.vocals?.volume
      return Number.isFinite(volume) && Math.abs(volume - desiredVocalsGain) < 0.0001
    }, 10000)
    assert.ok(Number.isFinite(saved.settings.tracks.vocals.volume))
    assert.ok(Math.abs(saved.settings.tracks.vocals.volume - desiredVocalsGain) < 0.0001)
    baseline = (await recovered(running.generation, fixture)).recovery
    assert.equal(baseline.descriptor.lanes.find(lane => lane.id === 'vocals').gain, controlled.lanes.find(lane => lane.id === 'vocals').gain)
    baseline.status = controlled
    await routing()
    recorder.reset()
    recorder.start()
    await close()
  })
  await watchdog.run('host preserves the same native song across actual BrowserWindow.close', 20, async () => {
    const after = await eventually('native frames continue after UI process exit', status, value =>
      BigInt(value.renderedProjectFrame) > BigInt(baseline.status.renderedProjectFrame))
    continuity(baseline.status, after)
    baseline.status = after
  })
  await watchdog.run('fresh renderer restores actual project, lyrics, graph and current mix without replay', 60, async () => {
    const page = await launch()
    await waitRestored(page, fixture, status)
    const after = await status()
    continuity(baseline.status, after)
    const restored = await recovered(after.generation, fixture)
    assert.equal(restored.recovery.descriptor.lanes.find(lane => lane.id === 'vocals').gain,
      baseline.descriptor.lanes.find(lane => lane.id === 'vocals').gain)
    const beforeControl = after.lanes.find(lane => lane.id === 'vocals').gain
    recorder.assertNoMutations()
    assert.ok(recorder.observedRequests > 0, 'protected phase must observe requests through the recorder')
    recorder.stop()
    await adjustVocals(page)
    await eventually('accepted stem control works after adoption', status, value =>
      value.generation === after.generation && value.lanes.find(lane => lane.id === 'vocals').gain < beforeControl)
    await routing()
    recorder.reset()
    recorder.start()
    await close()
  })
  await watchdog.run('changed valid lyrics select explicit Stop while native playback continues', 60, async () => {
    mutateLyrics(fixture.dir)
    const before = await status()
    const page = await launch()
    await waitStopFallback(page)
    const continuing = await eventually('same host generation continues during fallback', status, value =>
      BigInt(value.renderedProjectFrame) > BigInt(before.renderedProjectFrame))
    continuity(before, continuing)
    recorder.assertNoMutations()
    assert.ok(recorder.observedRequests > 0, 'protected phase must observe requests through the recorder')
    recorder.stop()
    await page.locator('[data-retained-stop]').click()
    await eventually('explicit Stop unloads the exact retained generation', status, value => value === null || value.state === 'unloaded')
    await routing()
    await close()
  })
  await watchdog.run('host exits cleanly and no unexpected application errors occurred', 15, async () => {
    await client.close(); client = null
    recorder.assertNoMutations()
    await recorder.close(); recorder = null
    await host.close()
    const result = await host.exited
    assert.equal(result.code, 0); assert.equal(result.signal, null)
    assert.deepEqual(host.errors, [])
    for (const entry of launches) assert.deepEqual(entry.errors, [])
  })
  console.log('PASS Box retained recovery: real graph, lyrics, accepted mix, same native generation, and changed-file Stop fallback')
}

run().catch(error => { console.error('BOX RETAINED RECOVERY DRIVER ERROR', error); process.exitCode = 1 })
  .finally(async () => { await cleanup(); watchdog.disarm() })
