'use strict'
// Real Electron → CaptureOwner → native producer → LoopZ history, without hardware.
const watchdog = require('../shared/watchdog.cjs').arm('box-audio-host-smoke', {
  onTimeout: () => cleanup()
})
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { wav } = require('./linux/fixtures.cjs')

const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sz-box-host-'))
fs.chmodSync(scratch, 0o700)
const socketPath = path.join(scratch, 'audio.sock')
let child, exited, closing
const clients = new Set()
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(label, read, accept, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds
  let value
  do {
    value = await read()
    if (accept(value)) return value
    await delay(25)
  } while (Date.now() < deadline)
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}
async function cleanup() {
  if (closing) return closing
  closing = (async () => {
    for (const client of clients) client.destroy()
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, delay(3000)])
      // The detached process group contains only this test's Electron children.
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await exited
    }
    fs.rmSync(scratch, { recursive: true, force: true })
  })()
  return closing
}
async function connect() {
  const socket = net.createConnection(socketPath)
  clients.add(socket)
  let pending = Buffer.alloc(0), epoch, serial = 0
  const requests = new Map()
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const fail = error => {
    readyReject(error)
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(error) }
    requests.clear()
  }
  socket.on('error', fail)
  socket.on('close', () => { clients.delete(socket); fail(new Error('Box host socket closed')) })
  socket.on('data', chunk => {
    try {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const end = pending.indexOf(10)
        if (end < 0) { assert.ok(pending.length <= 16 * 1024 * 1024); break }
        assert.ok(end <= 16 * 1024 * 1024)
        const frame = JSON.parse(pending.subarray(0, end).toString('utf8'))
        pending = pending.subarray(end + 1)
        assert.equal(frame.version, 1)
        if (!epoch) { assert.equal(frame.type, 'ready'); assert.equal(typeof frame.epoch, 'string'); epoch = frame.epoch; readyResolve() }
        else {
          assert.equal(frame.epoch, epoch)
          const request = requests.get(frame.id)
          assert.ok(request, 'reply belongs to an outstanding command')
          requests.delete(frame.id); clearTimeout(request.timer)
          if (frame.ok) request.resolve(frame.value)
          else request.reject(new Error(frame.error ?? 'Box host rejected command'))
        }
      }
    } catch (error) { fail(error); socket.destroy() }
  })
  await ready
  return {
    epoch,
    call(target, method, args = []) {
      const id = String(++serial)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${target}.${method} timed out`)); socket.destroy() }, 5000)
        requests.set(id, { resolve, reject, timer })
        socket.write(JSON.stringify({ version: 1, type: 'request', epoch, id, target, method, args }) + '\n')
      })
    },
    async close() { if (!socket.destroyed) await new Promise(resolve => { socket.once('close', resolve); socket.end() }) }
  }
}
const accepted = (value, operation) => { assert.equal(value?.ok, true, `${operation}: ${JSON.stringify(value)}`); return value }
async function run() {
  assert.equal(process.platform, 'linux', 'driverless Box routing qualification runs on Linux')
  const packaged = process.env.SINGZ_BOX_AUDIO_HOST_EXECUTABLE || process.env.SINGZ_E2E_PACKAGED
  if (packaged) assert.ok(path.isAbsolute(packaged), 'packaged executable must be absolute')
  const executable = packaged || require('electron')
  // Host analysis is on by default and would open the machine's first capture
  // device. Persist an absent input so this smoke stays device-free everywhere.
  fs.mkdirSync(path.join(scratch, 'profile'), { mode: 0o700 })
  fs.writeFileSync(path.join(scratch, 'profile', 'microphones.json'), JSON.stringify({ version: 1, revision: '1', origin: 'user',
    device: 'fixture:absent', channels: { 'fixture:absent': [0, 1] } }), { mode: 0o600 })
  const env = { ...process.env, SINGZ_BOX_AUDIO_SOCKET: socketPath, SINGZ_BOX_AUDIO_DATA_DIR: path.join(scratch, 'profile'), SINGZ_USERDATA_DIR: path.join(scratch, 'userdata'), SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.SINGZ_CAPTURE_ADDON
  child = spawn(executable, [...(packaged ? [] : [path.join(root, 'out/main/index.js')]), '--box-audio-host', '--ozone-platform=headless', '--disable-gpu'], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr)
  exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  await watchdog.run('sandboxed headless host starts', 20, async () => {
    await eventually('host socket appears', () => {
      assert.equal(child.exitCode, null, 'host did not exit before its socket was created')
      return fs.existsSync(socketPath)
    }, Boolean, 15000)
    assert.equal(fs.statSync(scratch).mode & 0o777, 0o700)
    // listen() creates the socket before the host's awaited chmod completes.
    // The private parent is already restricted; wait for final socket readiness
    // without accepting a permanently wrong mode.
    await eventually('host socket permissions prepared',
      () => fs.statSync(socketPath).mode & 0o777, mode => mode === 0o600)
  })
  let client = await connect()
  const epoch = client.epoch
  const state = async () => JSON.parse(await client.call('routing', 'request', ['{"version":1,"operation":"state"}']))
  const status = () => client.call('owner', 'playbackStatus')
  const assertNoPhysical = routing => {
    assert.deepEqual(routing.snapshot.runtime.outputs, [])
    assert.deepEqual(routing.snapshot.runtime.inputs, [])
    assert.deepEqual(routing.snapshot.runtime.monitors, [])
    assert.ok(routing.snapshot.document.devices.every(device => device.monitors.length === 0))
  }
  await watchdog.run('host microphone analysis waits without a device or audible route', 10, async () => {
    const microphones = await eventually('host analysis settles', () => client.call('service', 'microphones'), value => value.phase !== 'starting')
    assert.equal(microphones.phase, 'waiting')
    assert.equal(microphones.reason, 'no-device')
    assert.equal(microphones.levels, null)
    const inputs = await client.call('binding', 'inputDevices')
    assert.equal(inputs.ok, true)
    assert.ok(Array.isArray(inputs.devices))
    const idle = await state()
    assert.deepEqual(idle.snapshot.runtime.inputs, [])
    assert.deepEqual(idle.snapshot.runtime.outputs, [])
    assert.deepEqual(idle.snapshot.runtime.monitors, [])
    assert.equal(idle.snapshot.document, null)
    console.log('PASS host analysis waits for input with no audible route')
  })
  let document, generation, prepareSong
  await watchdog.run('create only logical native-source fanout', 10, async () => {
    const capabilities = await client.call('routing', 'capabilities')
    assert.equal(capabilities.supported, true); assert.equal(capabilities.initialized, true)
    const initial = await state()
    assert.equal(initial.snapshot.document, null)
    const commands = ['music', 'music-copy'].flatMap(id => [
      { type: 'createDevice', id, name: id, channels: 2, sampleRate: 48000, passThrough: false },
      { type: 'addSource', device: id, id: 'song', kind: 'application', selector: 'native:singz', channels: 2, muteOriginal: false, connectByDefault: true }
    ])
    accepted(JSON.parse(await client.call('routing', 'request', [JSON.stringify({ version: 1, operation: 'initialize', request: { version: 1, expected: initial.snapshot.revision, commands } })])), 'initialize logical routing')
    const routing = await state(); assertNoPhysical(routing); document = routing.snapshot.document
    assert.equal(document.devices.length, 2)
  })
  await watchdog.run('prepare and run the real native song producer', 15, async () => {
    const file = path.join(scratch, 'stereo.wav'); fs.writeFileSync(file, wav(12, 220, 330))
    // Follow the normal renderer's inventory contract before preparing. The
    // routing inventory lists hardware; song playback advertises only its
    // driverless source so it cannot accidentally open a second ALSA owner.
    const inventory = accepted(await client.call('owner', 'hostDevices', ['alsa']), 'song output inventory')
    assert.equal(inventory.provider, 'alsa')
    assert.equal(inventory.defaultOutputUid, 'native:singz')
    assert.equal(inventory.devices.length, 1)
    const output = inventory.devices[0]
    assert.equal(output.uid, inventory.defaultOutputUid)
    assert.equal(output.accessMode, 'exclusive')
    assert.equal(output.transport, 'virtual')
    assert.equal(output.outputChannels, 2)
    const config = {
      capability: 'singz.native.playback-session.anchored-preview.v4', provider: 'alsa', accessMode: 'exclusive',
      outputDeviceUid: output.uid, outputChannels: [0, 1], sampleRate: output.nominalSampleRate, bufferFrames: 256, maximumFrames: 256, masterGain: 0,
      playback: { version: 2, transport: { entrySeconds: 0, durationSeconds: 12, playbackRate: 1, transposeSemitones: 0 }, cues: { click: false, countInBars: 0, volume: 0, accent: false } }
    }
    prepareSong = () => client.call('owner', 'preparePlayback', [1, config, [{ id: 'fixture', path: file, gain: 1, muted: false, solo: false }]])
    const prepared = accepted(await prepareSong(), 'prepare')
    generation = prepared.generation; assert.match(generation, /^[1-9][0-9]*$/)
    accepted(await client.call('owner', 'openPlayback', [1, generation]), 'open logical producer')
    accepted(await client.call('owner', 'startPlayback', [1, generation]), 'start')
    const playing = await eventually('real native callbacks advance', status, value => value.state === 'running' && value.transportState === 'playing' && BigInt(value.callbacks) > 4n && BigInt(value.renderedProjectFrame) > 0n)
    assert.equal(playing.masterGain, 0)
    assert.equal(playing.audibleProjectionQuality, 'unavailable', 'no physical route must not claim an audible clock')
    assert.equal(playing.renderFailures, '0'); assert.equal(playing.nonFiniteSamples, 0)
    const later = await eventually('producer keeps advancing', status, value => BigInt(value.renderedProjectFrame) > BigInt(playing.renderedProjectFrame))
    assert.equal(later.generation, generation)
    const online = await eventually('LoopZ sees both native-source bindings online', state, value =>
      value.snapshot.runtime.sources.some(source => source.selector === 'native:singz' && source.connected && source.complete) &&
      ['music', 'music-copy'].every(id => value.snapshot.runtime.devices.find(bus => bus.id === id)?.sources.some(source => source.id === 'song' && source.online)))
    assertNoPhysical(online)
    console.log('PASS real native producer counters advance and both driverless LoopZ bindings are online; audible clock unavailable')
  })
  await watchdog.run('accepted controls and native state agree', 15, async () => {
    accepted(await client.call('owner', 'pausePlayback', [1, generation]), 'pause')
    const paused = await eventually('native transport pauses', status, value => value.transportState === 'paused')
    const parked = await eventually('producer services the paused graph', status, value => BigInt(value.callbacks) > BigInt(paused.callbacks))
    assert.equal(parked.renderedProjectFrame, paused.renderedProjectFrame)
    accepted(await client.call('owner', 'seekPlayback', [1, generation, 96000]), 'seek')
    await eventually('native seek lands', status, value => BigInt(value.seekCount) > BigInt(paused.seekCount) && BigInt(value.renderedProjectFrame) >= 96000n)
    accepted(await client.call('owner', 'setPlaybackMasterGain', [1, generation, 0]), 'master stays muted')
    accepted(await client.call('owner', 'setPlaybackLane', [1, generation, 'fixture', 0.5, true, false]), 'stem controls')
    await eventually('native stem controls applied', status, value => value.masterGain === 0 && value.lanes.some(lane => lane.id === 'fixture' && lane.gain === 0.5 && lane.muted))
    accepted(await client.call('owner', 'resumePlayback', [1, generation]), 'resume')
    await eventually('native playback resumes', status, value => value.transportState === 'playing' && BigInt(value.renderedProjectFrame) > 96000n)
    await client.close(); client = await connect(); assert.equal(client.epoch, epoch)
    const reattached = await status(); assert.equal(reattached.generation, generation); assert.equal(reattached.transportState, 'playing')
    accepted(await client.call('owner', 'stopPlayback', [1, generation]), 'stop')
    await eventually('native transport stops', status, value => value.transportState === 'stopped')
    const stopped = await state(); assertNoPhysical(stopped); assert.deepEqual(stopped.snapshot.document, document)
    const unloaded = accepted(await client.call('owner', 'unloadPlayback', [1, generation]), 'unload')
    assert.equal(unloaded.cleanupComplete, true)
    await eventually('native session unloads', status, value => value.state === 'unloaded')
    const persisted = await state(); assertNoPhysical(persisted); assert.deepEqual(persisted.snapshot.document, document)
    console.log('PASS accepted pause/seek/master/stem/resume/stop/unload; route document and host survive song stop and client reconnect')
  })
  await watchdog.run('retained stop fences epoch and generation on the real native owner', 15, async () => {
    const retained = accepted(await prepareSong(), 'prepare retained generation')
    accepted(await client.call('owner', 'openPlayback', [1, retained.generation]), 'open retained generation')
    accepted(await client.call('owner', 'startPlayback', [1, retained.generation]), 'start retained generation')
    await eventually('retained producer is running', status, value => value.generation === retained.generation && value.transportState === 'playing' && BigInt(value.callbacks) > 2n)
    await client.close(); client = await connect()
    const snapshot = await client.call('service', 'reconcile')
    assert.equal(snapshot.epoch, epoch)
    assert.equal(snapshot.playback.generation, retained.generation)
    await assert.rejects(client.call('service', 'stopRetained', [{ epoch: 'previous-host', generation: retained.generation }]), /service changed/i)
    await assert.rejects(client.call('service', 'stopRetained', [{ epoch, generation }]), /song changed/i)
    const unchanged = await status()
    assert.equal(unchanged.generation, retained.generation)
    assert.equal(unchanged.transportState, 'playing')
    const stopped = await client.call('service', 'stopRetained', [{ epoch, generation: retained.generation }])
    assert.equal(stopped.epoch, epoch)
    assert.equal(stopped.playback.state, 'unloaded')
    const routes = await state(); assertNoPhysical(routes); assert.deepEqual(routes.snapshot.document, document)
    console.log('PASS explicit retained Stop rejects stale epoch/generation, unloads the native song and preserves routing')
  })
  await watchdog.run('host shuts down with an active producer and removes socket', 15, async () => {
    const restarted = accepted(await prepareSong(), 'prepare shutdown generation')
    assert.notEqual(restarted.generation, generation)
    accepted(await client.call('owner', 'openPlayback', [1, restarted.generation]), 'open shutdown generation')
    accepted(await client.call('owner', 'startPlayback', [1, restarted.generation]), 'start shutdown generation')
    const active = await eventually('producer is really running before shutdown', status, value =>
      value.generation === restarted.generation && value.transportState === 'playing' && BigInt(value.callbacks) > 2n)
    assert.equal(active.masterGain, 0)
    assert.equal(active.audibleProjectionQuality, 'unavailable')
    assertNoPhysical(await state())
    await client.close(); child.kill('SIGTERM'); const result = await exited
    assert.equal(result.code, 0); assert.equal(result.signal, null)
    assert.equal(fs.existsSync(socketPath), false)
    console.log('PASS normal-sandbox headless host clean shutdown with active native producer; no physical audio device opened')
  })
}
run().catch(error => { console.error(error); process.exitCode = 1 }).finally(cleanup)
