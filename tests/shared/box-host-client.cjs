'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(label, read, accept, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds
  let value
  do {
    value = await read()
    if (accept(value)) return value
    await delay(25)
  } while (Date.now() < deadline)
  assert.fail(`${label}: ${JSON.stringify(value)}`)
}

async function startHost({ root, scratch, socketPath, env }) {
  const packaged = process.env.SINGZ_BOX_AUDIO_HOST_EXECUTABLE || process.env.E2E_PACKAGED || process.env.SINGZ_E2E_PACKAGED
  if (packaged) assert.ok(path.isAbsolute(packaged), 'installed Box host executable must be absolute')
  const executable = packaged || require('electron')
  const childEnv = {
    ...env, SINGZ_BOX_AUDIO_SOCKET: socketPath, SINGZ_BOX_AUDIO_DATA_DIR: path.join(scratch, 'host-profile'),
    SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1', SINGZ_BOX_CEC: '0', SINGZ_E2E_HIDDEN: '1'
  }
  delete childEnv.ELECTRON_RUN_AS_NODE
  delete childEnv.SINGZ_CAPTURE_ADDON
  const child = spawn(executable, [...(packaged ? [] : [path.join(root, 'out/main/index.js')]),
    '--box-audio-host', '--ozone-platform=headless', '--disable-gpu'], {
    cwd: root, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  const errors = []
  child.stdout.pipe(process.stdout)
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk)
    for (const line of String(chunk).split('\n')) if (/Native playback.*(failed|stopped)|graph .*failed|InvalidState|Unhandled/i.test(line)) errors.push(line)
  })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const clients = new Set()
  let closing
  const close = async () => {
    if (closing) return closing
    closing = (async () => {
      for (const client of clients) client.destroy()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await Promise.race([exited, delay(3000)])
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        }
      }
      await Promise.race([exited, delay(3000)])
    })()
    return closing
  }
  try {
    await eventually('retained host socket appears', () => {
      assert.equal(child.exitCode, null, 'host exited before creating its socket')
      return fs.existsSync(socketPath)
    }, Boolean, 15000)
    await eventually('retained host socket mode', () => fs.statSync(socketPath).mode & 0o777, mode => mode === 0o600, 5000)
  } catch (error) { await close(); throw error }
  return { child, exited, errors, clients, close }
}

async function connectHost(handle, socketPath) {
  const socket = net.createConnection(socketPath)
  handle.clients.add(socket)
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
  socket.on('close', () => { handle.clients.delete(socket); fail(new Error('retained host socket closed')) })
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
        if (!epoch) {
          assert.equal(frame.type, 'ready'); assert.equal(typeof frame.epoch, 'string')
          epoch = frame.epoch; readyResolve()
        } else {
          assert.equal(frame.epoch, epoch)
          const request = requests.get(frame.id)
          assert.ok(request, 'reply belongs to an outstanding command')
          requests.delete(frame.id); clearTimeout(request.timer)
          if (frame.ok) request.resolve(frame.value)
          else request.reject(new Error(frame.error || 'host rejected command'))
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

function assertNoPhysical(routing) {
  assert.deepEqual(routing.snapshot.runtime.outputs, [])
  assert.deepEqual(routing.snapshot.runtime.inputs, [])
  assert.deepEqual(routing.snapshot.runtime.monitors, [])
  if (routing.snapshot.document !== null) {
    assert.ok(routing.snapshot.document.devices.every(device => device.monitors.length === 0))
  }
}

module.exports = { startHost, connectHost, assertNoPhysical, delay, eventually }
