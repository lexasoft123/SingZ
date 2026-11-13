'use strict'
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const REQUEST_FRAME_BYTES = 1024 * 1024
const forbiddenOwner = new Set([
  'preparePlayback', 'openPlayback', 'startPlayback', 'pausePlayback', 'resumePlayback',
  'stopPlayback', 'seekPlayback', 'unloadPlayback', 'reanchorPlayback', 'setPlaybackLane',
  'setPlaybackMasterGain', 'setPlaybackLoop', 'clearPlaybackLoop'
])
const allowedOwner = new Set([
  'devices', 'hostDevices', 'microphoneMixStatus', 'monitorStatus', 'playbackProviders',
  'playbackCapability', 'playbackStatus', 'state', 'stats', 'measurePlaybackLanes',
  'rendererDetached', 'rendererGone', 'endMonitor'
])
// Observation-only service calls. Keep in step with boxAudioReadOnly() in
// src/shared/box-audio.ts (a .cjs file cannot import that TypeScript module).
const allowedService = new Set([
  'reconcile', 'microphones', 'microphoneLevels', 'subscribeMicrophoneLevels',
  'unsubscribeMicrophoneLevels', 'ackMicrophoneLevels'
])

async function startBoxHostRecorder({ socketPath, realSocketPath, maxFrameBytes = REQUEST_FRAME_BYTES, maxRecords = 64 }) {
  if (!path.isAbsolute(socketPath) || !path.isAbsolute(realSocketPath) || socketPath === realSocketPath)
    throw new Error('Recorder requires distinct absolute socket paths')
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > REQUEST_FRAME_BYTES ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1024)
    throw new Error('Invalid recorder bounds')
  const parent = path.dirname(socketPath)
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077))
    throw new Error('Recorder parent must be private and owned by the current user')
  if (fs.existsSync(socketPath)) throw new Error('Recorder socket already exists')

  const pairs = new Set()
  const mutations = []
  let protectedPhase = false
  let observedRequests = 0
  let recorderError = null
  let closing = null
  let server
  const removeSocket = () => {
    try {
      const stat = fs.lstatSync(socketPath)
      if (stat.isSocket() && stat.uid === process.getuid?.()) fs.unlinkSync(socketPath)
    } catch (error) { if (error.code !== 'ENOENT') recorderError ||= new Error('Recorder socket cleanup failed') }
  }
  const onExit = () => {
    for (const pair of pairs) { pair.ui.destroy(); pair.host.destroy() }
    pairs.clear()
    if (server?.listening) server.close()
    removeSocket()
  }
  const close = () => {
    if (closing) return closing
    protectedPhase = false
    process.off('exit', onExit)
    for (const pair of pairs) { pair.ui.destroy(); pair.host.destroy() }
    pairs.clear()
    closing = new Promise(resolve => {
      if (!server?.listening) { removeSocket(); resolve(); return }
      server.close(() => { removeSocket(); resolve() })
    })
    return closing
  }
  const fail = error => {
    recorderError ||= error
    void close()
  }
  const record = request => {
    if (!protectedPhase) return
    let operation
    if (request.target === 'routing' && request.method === 'request') {
      try {
        if (!Array.isArray(request.args) || typeof request.args[0] !== 'string') throw new Error()
        operation = JSON.parse(request.args[0]).operation
      } catch { throw new Error('Recorder rejected malformed routing request') }
      if (typeof operation !== 'string' || operation.length > 64) throw new Error('Recorder rejected routing operation')
    }
    const allowed = request.target === 'owner' ? allowedOwner.has(request.method) && !forbiddenOwner.has(request.method)
      : request.target === 'service' ? allowedService.has(request.method)
        : request.target === 'routing' ? request.method === 'capabilities' || (request.method === 'request' && operation === 'state')
          : request.target === 'binding' ? request.method === 'inputDevices' || request.method === 'initializeSharedAudio' : false
    const forbidden = forbiddenOwner.has(request.method) ||
      (request.target === 'service' && request.method === 'stopRetained') ||
      (request.target === 'routing' && request.method === 'request' && operation !== 'state') || !allowed
    if (!forbidden) return
    if (mutations.length >= maxRecords) throw new Error('Recorder mutation capacity exceeded')
    mutations.push(Object.freeze({ target: request.target, method: request.method, ...(operation === undefined ? {} : { operation }) }))
  }
  const parser = pair => {
    let pending = Buffer.alloc(0)
    return chunk => {
      try {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
        for (;;) {
          const end = pending.indexOf(10)
          if (end < 0) {
            if (pending.length > maxFrameBytes) throw new Error('Recorder request frame exceeded its bound')
            break
          }
          if (end > maxFrameBytes) throw new Error('Recorder request frame exceeded its bound')
          let request
          try { request = JSON.parse(pending.subarray(0, end).toString('utf8')) } catch { throw new Error('Recorder rejected malformed request') }
          pending = pending.subarray(end + 1)
          if (!request || request.version !== 1 || request.type !== 'request' ||
              typeof request.target !== 'string' || request.target.length > 32 ||
              typeof request.method !== 'string' || request.method.length > 96)
            throw new Error('Recorder rejected malformed request')
          if (protectedPhase) observedRequests++
          record(request)
        }
      } catch (error) { fail(error); pair.ui.destroy(); pair.host.destroy() }
    }
  }

  server = net.createServer(ui => {
    const host = net.createConnection(realSocketPath)
    const pair = { ui, host }
    pairs.add(pair)
    ui.on('data', parser(pair))
    ui.pipe(host).pipe(ui)
    const closed = () => { pairs.delete(pair); ui.destroy(); host.destroy() }
    ui.once('close', closed)
    host.once('close', closed)
    // A departing renderer can reset a socket with an unread reply. Only its
    // pair ends; protocol failures above still invalidate the whole recorder.
    ui.once('error', closed)
    host.once('error', closed)
  })
  server.on('error', () => fail(new Error('Recorder listener failed')))
  process.once('exit', onExit)
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    fs.chmodSync(socketPath, 0o600)
  } catch (error) { await close(); throw error }

  return {
    socketPath,
    mutations,
    get error() { return recorderError },
    get observedRequests() { return observedRequests },
    reset() { mutations.length = 0; observedRequests = 0 },
    start() { protectedPhase = true },
    stop() { protectedPhase = false },
    assertNoMutations() {
      if (recorderError) throw recorderError
      if (mutations.length) throw new Error(`Protected host mutations: ${JSON.stringify(mutations)}`)
    },
    close
  }
}

module.exports = { startBoxHostRecorder }
