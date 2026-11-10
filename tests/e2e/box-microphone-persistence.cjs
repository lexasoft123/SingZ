'use strict'
// Driverless Linux qualification: persisted intent and actual UI lifetimes.
const watchdog = require('../shared/watchdog.cjs').arm('box-microphone-persistence', {
  totalMinutes: 5, idleMinutes: 2, onTimeout: () => cleanup()
})
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { startHost, connectHost, assertNoPhysical, delay, eventually } = require('../shared/box-host-client.cjs')
const { startBoxHostRecorder } = require('../shared/box-host-recorder.cjs')
const { launchUi, closeUi } = require('../shared/box-retained-ui.cjs')
const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'box-mic-persist-'))
fs.chmodSync(scratch, 0o700)
for (const name of ['home', 'config', 'data', 'cache', 'profile', 'library', 'models', 'pack', 'host-profile'])
  fs.mkdirSync(path.join(scratch, name), { recursive: true, mode: 0o700 })
const socketPath = path.join(scratch, 'audio.sock'), proxyPath = path.join(scratch, 'ui.sock')
const userData = path.join(scratch, 'profile')
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsRoot: path.join(scratch, 'library'), language: 'en' }), { mode: 0o600 })
fs.writeFileSync(path.join(userData, 'box-state.json'), JSON.stringify({ version: 1,
  preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' }, queue: [] }), { mode: 0o600 })
const env = { ...process.env, HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'config'),
  XDG_DATA_HOME: path.join(scratch, 'data'), XDG_CACHE_HOME: path.join(scratch, 'cache'), SINGZ_USERDATA_DIR: userData,
  SINGZ_MODELS_DIR: path.join(scratch, 'models'), SINGZ_PACK_DIR: path.join(scratch, 'pack'),
  SINGZ_NO_SYNC: '1', SINGZ_NO_SYSTEM_ENGINES: '1', SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_BOX_CEC: '0', SINGZ_LANG: 'en' }
for (const key of ['SINGZ_SURFACE', 'SINGZ_GDRIVE_CONFIG', 'SINGZ_BOX_PLATFORM_SOCKET', 'SINGZ_CAPTURE_ADDON', 'ELECTRON_RUN_AS_NODE']) delete env[key]
let host, client, ui, recorder, closing
const launches = []
const snapshot = () => client.call('service', 'microphones')
async function boot() {
  host = await startHost({ root, scratch, socketPath, env })
  client = await connectHost(host, socketPath)
  return eventually('supervisor initialized without a client edit', snapshot, value => value.phase !== 'starting')
}
async function shutdown() {
  await client.close(); client = null
  await host.close()
  const result = await host.exited
  assert.equal(result.code, 0, 'SIGTERM exits cleanly')
  assert.equal(result.signal, null)
  assert.deepEqual(host.errors, [])
  host = null
}
async function cleanup() {
  if (closing) return closing
  closing = (async () => {
    if (ui) {
      const child = ui.app.process()
      await Promise.race([ui.app.close().catch(() => {}), delay(2500)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await recorder?.close().catch(() => {})
    await client?.close().catch(() => {})
    await host?.close().catch(() => {})
    fs.rmSync(scratch, { recursive: true, force: true })
  })()
  return closing
}
async function uiRestartContinuity(expected) {
  recorder = await startBoxHostRecorder({ socketPath: proxyPath, realSocketPath: socketPath })
  recorder.start()
  for (let i = 0; i < 2; ++i) {
    ui = await launchUi({ root, env: { ...env, SINGZ_BOX_AUDIO_SOCKET: proxyPath } })
    launches.push(ui)
    const observed = await ui.page.evaluate(() => window.singz.box.microphones())
    assert.equal(observed.ok, true)
    for (const key of ['epoch', 'generation', 'revision', 'phase']) assert.equal(observed.value[key], expected[key], key)
    assert.deepEqual(observed.value.selection, expected.selection)
    await closeUi(ui.app); ui = null
    const after = await snapshot()
    assert.equal(after.epoch, expected.epoch); assert.equal(after.generation, expected.generation)
    recorder.assertNoMutations() // includes owner.begin, owner.cancel and selection edits
  }
  assert.ok(recorder.observedRequests > 0, 'recorder observes the actual UI command boundary')
  await recorder.close(); recorder = null
}
async function run() {
  assert.equal(process.platform, 'linux', 'driverless persistent Box qualification requires Linux')
  let desired
  await watchdog.run('fresh host defaults on and persists a device selection before application', 20, async () => {
    const initial = await boot()
    const inventory = await client.call('binding', 'inputDevices')
    assert.equal(inventory.ok, true)
    const first = inventory.devices.find(device => device.channels > 0)
    assert.equal(initial.origin, 'default')
    if (first) {
      // A machine with capture inputs: fresh intent is on for inputs 1-2 of the first one.
      assert.notEqual(initial.phase, 'off')
      assert.equal(initial.selection.device, first.uid)
      assert.deepEqual(initial.selection.channels[first.uid], [0, 1].filter(channel => channel < first.channels))
      const running = JSON.parse(await client.call('routing', 'request', ['{"version":1,"operation":"state"}']))
      assert.deepEqual(running.snapshot.runtime.outputs, []); assert.deepEqual(running.snapshot.runtime.monitors, [])
      assert.equal(running.snapshot.document, null)
      console.log(`PASS fresh host analysis defaulted on for the first input (${initial.phase}) with no audible route`)
    } else {
      assert.equal(initial.phase, 'waiting'); assert.equal(initial.reason, 'no-device')
    }
    const edit = await client.call('service', 'setMicrophoneSelection', [{ expectedRevision: initial.revision,
      device: 'fixture:absent', channels: { 'fixture:absent': [0, 1, 7] } }])
    assert.equal(edit.ok, true); desired = edit.snapshot
    assert.equal(desired.reason, 'no-device')
    const routing = JSON.parse(await client.call('routing', 'request', ['{"version":1,"operation":"state"}']))
    assertNoPhysical(routing); assert.equal(routing.snapshot.document, null)
    const stale = await client.call('service', 'setMicrophoneSelection', [{ expectedRevision: initial.revision, device: null, channels: {} }])
    assert.equal(stale.code, 'stale')
    await shutdown()
  })
  await watchdog.run('SIGTERM restart restores exact revision and intent without any edit', 20, async () => {
    const restored = await boot()
    assert.notEqual(restored.epoch, desired.epoch)
    assert.equal(restored.revision, desired.revision)
    assert.deepEqual(restored.selection, desired.selection)
    desired = restored
  })
  await watchdog.run('live analysis on a real input when this machine has one', 30, async () => {
    const inventory = await client.call('binding', 'inputDevices')
    const first = inventory.ok && inventory.devices.find(device => device.channels > 0)
    if (!first) { console.log('SKIP no capture input here; UI continuity is checked at generation 0'); return }
    const edit = await client.call('service', 'setMicrophoneSelection', [{ expectedRevision: desired.revision,
      device: first.uid, channels: { [first.uid]: [0, 1].filter(channel => channel < first.channels) } }])
    assert.equal(edit.ok, true)
    desired = await eventually('analysis running on the real input', snapshot, value => value.phase === 'running' && value.generation !== '0')
    const routing = JSON.parse(await client.call('routing', 'request', ['{"version":1,"operation":"state"}']))
    assert.deepEqual(routing.snapshot.runtime.outputs, []); assert.deepEqual(routing.snapshot.runtime.monitors, [])
    console.log('PASS host analysis running on a real input with no audible route')
  })
  await watchdog.run('real BrowserWindow close and relaunch send zero capture commands', 120, () => uiRestartContinuity(desired))
  await watchdog.run('explicit all-off survives host restart and both real UI lifetimes', 120, async () => {
    const off = await client.call('service', 'setMicrophoneSelection', [{ expectedRevision: desired.revision, device: null, channels: desired.selection.channels }])
    assert.equal(off.ok, true); assert.equal(off.snapshot.phase, 'off')
    await shutdown()
    const restored = await boot()
    assert.equal(restored.phase, 'off'); assert.equal(restored.revision, off.snapshot.revision)
    assert.deepEqual(restored.selection, off.snapshot.selection)
    await uiRestartContinuity(restored)
    for (const launch of launches) assert.deepEqual(launch.errors, [])
    await shutdown()
  })
  console.log('PASS microphone selection persistence, revision CAS, all-off and zero UI capture commands')
}
run().then(async () => { await cleanup(); watchdog.disarm() }, async error => {
  console.error(error); await cleanup(); watchdog.disarm(); process.exitCode = 1
})
