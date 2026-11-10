import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/fake/box-profile' }, utilityProcess: { fork: mock.fork } }))
vi.mock('../../src/main/log', () => ({ log: vi.fn(), logChunk: vi.fn() }))
let child: EventEmitter & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stdout: null; stderr: null }
beforeEach(() => {
  vi.resetModules()
  mock.fork.mockClear()
  child = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn(() => true), stdout: null, stderr: null })
  mock.fork.mockImplementation((_entry: unknown, _args: unknown, options: { env: Record<string, string> }) => {
    queueMicrotask(() => child.emit('message', { type: 'ready', epoch: options.env.SINGZ_AUDIO_EPOCH, pid: 12345 }))
    return child
  })
})
afterEach(() => { child.emit('exit', 1); vi.unstubAllEnvs() })

it('never acknowledges relay stop when a saturated helper did not receive it', async () => {
  const { createRemoteCaptureOwner, desktopAudioProcess } = await import('../../src/main/audio-process')
  const { AUDIO_RPC_LIMIT } = await import('../../src/main/audio-process-rpc')
  const owner = createRemoteCaptureOwner()
  const pending = Array.from({ length: AUDIO_RPC_LIMIT }, () => desktopAudioProcess.call('owner', 'playbackStatus', []).catch(() => null))
  await new Promise(resolve => setImmediate(resolve))
  const stopped = await owner.stopMicrophoneMix(7)
  expect(stopped.ok).toBe(false)
  child.emit('exit', 1)
  await Promise.all(pending)
})

it('does not spawn a new helper when polling after a helper crash', async () => {
  const { createRemoteCaptureOwner } = await import('../../src/main/audio-process')
  const owner = createRemoteCaptureOwner()
  const first = owner.playbackStatus()
  await new Promise(resolve => setImmediate(resolve))
  child.emit('exit', 1)
  expect(await first).toBeNull()
  expect(await owner.playbackStatus()).toBeNull()
  expect(mock.fork).toHaveBeenCalledTimes(1)
})

it('terminates audio when a full queue would otherwise drop renderer cleanup', async () => {
  const { createRemoteCaptureOwner, desktopAudioProcess } = await import('../../src/main/audio-process')
  const { AUDIO_RPC_LIMIT } = await import('../../src/main/audio-process-rpc')
  const owner = createRemoteCaptureOwner()
  const pending = Array.from({ length: AUDIO_RPC_LIMIT }, () => desktopAudioProcess.call('owner', 'playbackStatus', []).catch(() => null))
  await new Promise(resolve => setImmediate(resolve))
  owner.rendererGone(7)
  await new Promise(resolve => setImmediate(resolve))
  expect(child.kill).toHaveBeenCalledOnce()
  await Promise.all(pending)
  expect(await owner.playbackStatus()).toBeNull()
  expect(mock.fork).toHaveBeenCalledOnce()
})

it('keeps local Box renderer ids disjoint from the reserved analysis owner and leaves Desktop ids intact', async () => {
  vi.stubEnv('SINGZ_SURFACE', 'box'); vi.stubEnv('SINGZ_BOX_AUDIO_SOCKET', '')
  const { createRemoteCaptureOwner } = await import('../../src/main/audio-process')
  const owner = createRemoteCaptureOwner()
  const requests: any[] = []
  child.postMessage.mockImplementation(message => {
    if (message.type !== 'request') return
    requests.push(message)
    queueMicrotask(() => child.emit('message', { type: 'reply', epoch: message.epoch, id: message.id,
      ok: true, value: { ok: true, cancelled: true } }))
  })
  await owner.begin(2, { deviceUid: 'mic', inputChannel: 0, enabledChannels: [0] }, '1', () => {})
  await owner.beginMonitor(2, {} as never)
  owner.rendererDetached(2)
  owner.rendererGone(2)
  await owner.stats()
  // A destroyed renderer still stops what it owned; only its id is offset so
  // it can never name the reserved analysis owner.
  expect(requests.filter(r => r.method === 'rendererDetached').map(r => r.args[0])).toEqual([1002])
  expect(requests.filter(r => r.method === 'rendererGone').map(r => r.args[0])).toEqual([1002])
  expect(requests.find(r => r.method === 'begin').args[0]).toBe(2)
  expect(requests.find(r => r.method === 'beginMonitor').args[0]).toBe(1002)
  expect(requests.find(r => r.method === 'rendererDetached').args[0]).toBe(1002)
  expect(mock.fork.mock.calls[0][2].env.SINGZ_AUDIO_BOX_DATA_DIR).toBe('/fake/box-profile')
})

it('keeps Desktop renderer cleanup ids unchanged', async () => {
  vi.stubEnv('SINGZ_SURFACE', 'desktop')
  const { createRemoteCaptureOwner } = await import('../../src/main/audio-process')
  const owner = createRemoteCaptureOwner()
  const requests: any[] = []
  child.postMessage.mockImplementation(message => {
    if (message.type !== 'request') return
    requests.push(message)
    queueMicrotask(() => child.emit('message', { type: 'reply', epoch: message.epoch, id: message.id, ok: true, value: {} }))
  })
  owner.rendererDetached(2)
  await owner.stats()
  expect(requests.find(r => r.method === 'rendererDetached').args[0]).toBe(2)
  expect(mock.fork.mock.calls[0][2].env.SINGZ_AUDIO_BOX_DATA_DIR).toBeUndefined()
})
