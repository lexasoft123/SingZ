import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false }, utilityProcess: { fork: mock.fork } }))
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
afterEach(() => { child.emit('exit', 1) })

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
