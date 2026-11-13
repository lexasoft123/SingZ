'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { startBoxHostRecorder } = require('../shared/box-host-recorder.cjs')
const unixOnly = {
  skip: process.platform === 'win32' ? 'Unix socket and POSIX permissions fixture requires Unix' : false,
  timeout: 10000
}

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(server.socketPath, resolve)
})
async function eventually(accept) {
  const deadline = Date.now() + 2000
  while (!accept()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for socket cleanup')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-host-recorder-'))
  fs.chmodSync(root, 0o700)
  const realSocketPath = path.join(root, 'real.sock')
  const socketPath = path.join(root, 'proxy.sock')
  const hostSockets = new Set()
  const clients = new Set()
  let replies = 0
  const host = net.createServer(socket => {
    let pending = Buffer.alloc(0)
    hostSockets.add(socket)
    socket.write(JSON.stringify({ version: 1, type: 'ready', epoch: 'test-epoch' }) + '\n')
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      for (;;) {
        const end = pending.indexOf(10)
        if (end < 0) break
        let request
        try { request = JSON.parse(pending.subarray(0, end).toString('utf8')) } catch { socket.destroy(); return }
        pending = pending.subarray(end + 1)
        replies++
        socket.write(JSON.stringify({ version: 1, type: 'reply', epoch: 'test-epoch', id: request.id,
          ok: true, value: { target: request.target, method: request.method, args: request.args } }) + '\n')
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => { hostSockets.delete(socket) })
  })
  host.socketPath = realSocketPath
  await listen(host)
  const recorder = await startBoxHostRecorder({ socketPath, realSocketPath, ...options })
  const connect = async () => {
    const socket = net.createConnection(socketPath)
    clients.add(socket)
    let input = Buffer.alloc(0), serial = 0
    const requests = new Map()
    let readyResolve, readyReject
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    const fail = error => {
      readyReject(error)
      for (const request of requests.values()) request.reject(error)
      requests.clear()
    }
    socket.on('error', fail)
    socket.on('close', () => { clients.delete(socket); fail(new Error('client closed')) })
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk])
      for (;;) {
        const end = input.indexOf(10)
        if (end < 0) break
        const frame = JSON.parse(input.subarray(0, end).toString('utf8'))
        input = input.subarray(end + 1)
        if (frame.type === 'ready') readyResolve(frame)
        else {
          const request = requests.get(frame.id)
          if (request) { requests.delete(frame.id); request.resolve(frame) }
        }
      }
    })
    await ready
    return {
      socket,
      async call(target, method, args = []) {
        const id = String(++serial)
        const reply = new Promise((resolve, reject) => requests.set(id, { resolve, reject }))
        socket.write(JSON.stringify({ version: 1, type: 'request', epoch: 'test-epoch', id, target, method, args }) + '\n')
        return reply
      },
      async close() {
        if (socket.destroyed) return
        await new Promise(resolve => { socket.once('close', resolve); socket.end() })
      }
    }
  }
  t.after(async () => {
    for (const client of clients) client.destroy()
    await recorder.close()
    for (const socket of hostSockets) socket.destroy()
    if (host.listening) await new Promise(resolve => host.close(resolve))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, socketPath, recorder, connect, hostSockets, get replies() { return replies } }
}

test('transparent ready, request and reply forwarding uses a private listener', unixOnly, async t => {
  const { root, socketPath, recorder, connect } = await fixture(t)
  assert.equal(fs.statSync(root).mode & 0o777, 0o700)
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600)
  const client = await connect()
  const payload = 'x'.repeat(256 * 1024)
  recorder.start()
  const reply = await client.call('service', 'reconcile', [payload])
  assert.equal(reply.value.target, 'service')
  assert.equal(reply.value.args[0], payload)
  assert.equal(recorder.error, null)
  recorder.assertNoMutations()
  assert.equal(recorder.observedRequests, 1)
  await client.close()
})

test('protected play and unload are forwarded negative controls that assertions reject', unixOnly, async t => {
  const { recorder, connect } = await fixture(t)
  const client = await connect()
  recorder.start()
  assert.equal((await client.call('owner', 'startPlayback', [1, '7'])).ok, true)
  assert.throws(() => recorder.assertNoMutations(), /startPlayback/)
  assert.equal(recorder.observedRequests, 1)
  recorder.reset()
  recorder.assertNoMutations()
  assert.equal(recorder.observedRequests, 0)
  assert.equal((await client.call('owner', 'unloadPlayback', [1, '7'])).ok, true)
  assert.throws(() => recorder.assertNoMutations(), /unloadPlayback/)
  assert.equal(recorder.observedRequests, 1)
  await client.close()
})

test('all actual public playback mutations and unknown owner methods are forbidden', unixOnly, async t => {
  const { recorder, connect } = await fixture(t)
  const client = await connect()
  const methods = ['preparePlayback', 'openPlayback', 'startPlayback', 'pausePlayback', 'resumePlayback',
    'stopPlayback', 'seekPlayback', 'unloadPlayback', 'reanchorPlayback', 'setPlaybackLane',
    'setPlaybackMasterGain', 'setPlaybackLoop', 'clearPlaybackLoop', 'begin', 'cancel', 'futurePlaybackMutation']
  recorder.start()
  for (const method of methods) {
    recorder.reset()
    await client.call('owner', method)
    assert.throws(() => recorder.assertNoMutations(), new RegExp(method))
    assert.deepEqual(recorder.mutations, [{ target: 'owner', method }])
  }
  await client.close()
})

test('service stop and routing edits are forbidden without retaining arguments', unixOnly, async t => {
  const { recorder, connect } = await fixture(t)
  const client = await connect()
  recorder.start()
  await client.call('service', 'stopRetained', [{ epoch: 'private-token', generation: '7' }])
  assert.throws(() => recorder.assertNoMutations(), /stopRetained/)
  assert.equal(JSON.stringify(recorder.mutations).includes('private-token'), false)
  for (const operation of ['edit', 'initialize']) {
    recorder.reset()
    await client.call('routing', 'request', [JSON.stringify({ version: 1, operation, request: { secret: '/project/path' } })])
    assert.throws(() => recorder.assertNoMutations(), new RegExp(operation))
    assert.deepEqual(recorder.mutations, [{ target: 'routing', method: 'request', operation }])
    assert.equal(JSON.stringify(recorder.mutations).includes('/project/path'), false)
  }
  await client.close()
})

test('an existing non-private parent is rejected without changing its mode', unixOnly, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'box-host-recorder-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.chmodSync(root, 0o755)
  await assert.rejects(startBoxHostRecorder({
    socketPath: path.join(root, 'proxy.sock'), realSocketPath: path.join(root, 'real.sock')
  }), /parent must be private/)
  assert.equal(fs.statSync(root).mode & 0o777, 0o755)
})

test('all read-only owner queries, routing state and private capture cleanup are allowed', unixOnly, async t => {
  const { recorder, connect } = await fixture(t)
  const client = await connect()
  const methods = ['devices', 'hostDevices', 'microphoneMixStatus', 'monitorStatus', 'playbackProviders',
    'playbackCapability', 'playbackStatus', 'state', 'stats', 'measurePlaybackLanes',
    'rendererDetached', 'rendererGone', 'endMonitor']
  recorder.start()
  for (const method of methods)
    await client.call('owner', method, [{ private: 'argument-is-not-retained' }])
  await client.call('service', 'reconcile')
  await client.call('service', 'microphones')
  await client.call('routing', 'capabilities')
  await client.call('routing', 'request', [JSON.stringify({ version: 1, operation: 'state' })])
  await client.call('binding', 'inputDevices')
  await client.call('binding', 'initializeSharedAudio')
  recorder.assertNoMutations()
  assert.equal(recorder.observedRequests, methods.length + 6)
  assert.deepEqual(recorder.mutations, [])
  await client.close()
})

test('microphone level meter calls are read-only while stopRetained stays a mutation', unixOnly, async t => {
  const { recorder, connect } = await fixture(t)
  const client = await connect()
  const methods = ['microphoneLevels', 'subscribeMicrophoneLevels', 'unsubscribeMicrophoneLevels', 'ackMicrophoneLevels']
  recorder.start()
  for (const method of methods) await client.call('service', method)
  recorder.assertNoMutations()
  assert.deepEqual(recorder.mutations, [])
  assert.equal(recorder.observedRequests, methods.length)
  await client.call('service', 'stopRetained')
  assert.throws(() => recorder.assertNoMutations(), /stopRetained/)
  assert.deepEqual(recorder.mutations, [{ target: 'service', method: 'stopRetained' }])
  await client.close()
})

test('protected phase covers connection close and reconnect until explicitly stopped', unixOnly, async t => {
  const { recorder, connect } = await fixture(t)
  recorder.start()
  const first = await connect()
  await first.call('owner', 'startPlayback')
  assert.throws(() => recorder.assertNoMutations(), /startPlayback/)
  recorder.reset()
  await first.close()
  const second = await connect()
  await second.call('owner', 'pausePlayback')
  assert.throws(() => recorder.assertNoMutations(), /pausePlayback/)
  recorder.reset()
  recorder.stop()
  await second.call('owner', 'unloadPlayback')
  recorder.assertNoMutations()
  await second.close()
})

test('an abortive client close preserves listener, protected phase and prior records', unixOnly, async t => {
  const f = await fixture(t)
  const first = await f.connect()
  f.recorder.start()
  await first.call('owner', 'startPlayback')
  const previous = f.recorder.mutations.slice()
  first.socket.pause()
  // Leave a large reply unread so disconnect exercises the real reset path.
  first.socket.write(JSON.stringify({ version: 1, type: 'request', epoch: 'test-epoch', id: 'burst',
    target: 'service', method: 'reconcile', args: ['x'.repeat(512 * 1024)] }) + '\n')
  await eventually(() => f.replies >= 2)
  first.socket.destroy()
  await eventually(() => f.hostSockets.size === 0)
  assert.equal(f.recorder.error, null, 'an ordinary client reset must not invalidate the recorder')
  assert.equal(fs.existsSync(f.socketPath), true, 'listener survives the old renderer')
  assert.deepEqual(f.recorder.mutations, previous, 'disconnect cannot erase protected evidence')
  assert.equal(f.recorder.observedRequests, 2)
  const next = await f.connect()
  assert.equal((await next.call('service', 'reconcile')).ok, true, 'new renderer can still query the host')
  await next.call('owner', 'unloadPlayback')
  assert.equal(f.recorder.observedRequests, 4)
  assert.deepEqual(f.recorder.mutations, [...previous, { target: 'owner', method: 'unloadPlayback' }])
  assert.throws(() => f.recorder.assertNoMutations(), /unloadPlayback/, 'phase remains protected across reset')
  await next.close()
})

test('malformed and oversized frames fail closed and clean up the listener', unixOnly, async t => {
  for (const oversized of [false, true]) {
    const { socketPath, recorder, connect } = await fixture(t, { maxFrameBytes: 64 })
    const client = await connect()
    recorder.start()
    const mutation = JSON.stringify({ version: 1, type: 'request', epoch: 'test-epoch', id: '1',
      target: 'owner', method: 'startPlayback', args: [] })
    client.socket.write(oversized ? mutation + ' '.repeat(65) + '\n' : '{bad json}\n')
    await eventually(() => recorder.error !== null && !fs.existsSync(socketPath))
    assert.throws(() => recorder.assertNoMutations(), oversized ? /bound/ : /malformed/)
    assert.equal(client.socket.destroyed, true)
    await recorder.close()
  }
})

test('bounded mutation records fail closed instead of dropping later mutations', unixOnly, async t => {
  const { socketPath, recorder, connect } = await fixture(t, { maxRecords: 1 })
  const client = await connect()
  recorder.start()
  await client.call('owner', 'startPlayback')
  client.socket.write(JSON.stringify({ version: 1, type: 'request', epoch: 'test-epoch', id: '2',
    target: 'owner', method: 'unloadPlayback', args: [] }) + '\n')
  await eventually(() => recorder.error !== null && !fs.existsSync(socketPath))
  assert.throws(() => recorder.assertNoMutations(), /capacity/)
  assert.equal(recorder.mutations.length, 1)
  await client.close()
})
