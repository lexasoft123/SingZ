import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { BoxRetainedPlaybackRestore } from '../../src/shared/box-contract'

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string): void => { handlers.delete(channel) }
  }
})
vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, ipcMain: { handle: ipc.handle, removeHandler: ipc.removeHandler } }
})

import { registerBoxIpc } from '../../src/main/box/ipc'

class Sender extends EventEmitter {
  mainFrame: { url: string }
  destroyed = false
  send = vi.fn()
  constructor(url: string) {
    super()
    this.mainFrame = { url }
  }
  isDestroyed(): boolean { return this.destroyed }
}
const dirs: string[] = []
const backends: Array<NonNullable<ReturnType<typeof registerBoxIpc>>> = []
const originalSurface = process.env.SINGZ_SURFACE
async function register(
  rendererURL: string,
  surface = 'box',
  audio: Partial<Pick<Parameters<typeof registerBoxIpc>[0], 'microphones' | 'audioInputs' | 'audioHost' | 'cecStatus' | 'retainedPlaybackSnapshot' | 'stopRetainedPlayback' | 'restoreRetainedPlayback'>> = {}
) {
  process.env.SINGZ_SURFACE = surface
  const userDataDir = await mkdtemp(join(tmpdir(), 'box-ipc-'))
  dirs.push(userDataDir)
  const backend = registerBoxIpc({
    userDataDir,
    appVersion: 'test',
    rendererURL,
    audioInputs: () => ({ ok: true, devices: [] }),
    audioHost: () => ({ ok: true, devices: [] }),
    ...audio
  })
  if (backend) backends.push(backend)
  return backend
}
function invoke(sender: Sender, channel: string, frame: { url: string } | null = sender.mainFrame, ...args: unknown[]): Promise<Record<string, unknown>> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender, senderFrame: frame } as unknown as IpcMainInvokeEvent, ...args)) as Promise<Record<string, unknown>>
}
const attached = (backend: NonNullable<ReturnType<typeof registerBoxIpc>>, sender: Sender): void => {
  backend.attachRenderer(sender as unknown as WebContents)
}

afterEach(async () => {
  for (const backend of backends.splice(0).reverse()) await backend.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  ipc.handlers.clear()
  if (originalSurface === undefined) delete process.env.SINGZ_SURFACE
  else process.env.SINGZ_SURFACE = originalSurface
})

describe('Box IPC renderer trust', () => {
  it('resolves remote audio inventories before returning diagnostics over IPC', async () => {
    const url = 'file:///tmp/SingZ/out/renderer/box/box.html'
    const inputs = { ok: true, devices: [{ uid: 'mic', name: 'Microphone' }] }
    const host = { ok: true, devices: [{ uid: 'output', label: 'USB interface' }] }
    const backend = await register(url, 'box', {
      audioInputs: async () => inputs,
      audioHost: async () => host
    })
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender(url)
    attached(backend, owner)
    const result = await invoke(owner, 'box:diagnostics')
    expect(result).toMatchObject({ ok: true, value: { audio: { inputs, host } } })
    expect(() => structuredClone(result)).not.toThrow()
  })

  it('reports CEC independently when the audio service is unavailable', async () => {
    const url = 'file:///tmp/renderer/box/box.html'
    const cec = { state: 'unavailable' as const, detail: 'No HDMI output CEC adapter.', lastInputAt: null }
    const backend = await register(url, 'box', {
      audioInputs: () => { throw new Error('private native failure') },
      audioHost: async () => { throw new Error('private audio socket path') },
      cecStatus: () => cec
    })
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender(url); attached(backend, owner)
    const result = await invoke(owner, 'box:diagnostics')
    expect(result).toMatchObject({ ok: true, value: { cec, audio: {
      inputs: { ok: false }, host: { ok: false }
    } } })
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('restricts retained-song recovery/Stop to the trusted TV and preserves stale-epoch errors', async () => {
    const url = 'file:///tmp/renderer/box/box.html'
    const snapshot = vi.fn(async () => ({ epoch: 'service-e', playback: null }))
    const stop = vi.fn(async () => { throw new Error('Audio service changed. Refresh before stopping the song.') })
    const backend = await register(url, 'box', { retainedPlaybackSnapshot: snapshot, stopRetainedPlayback: stop })
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender(url)
    const outsider = new Sender(url)
    attached(backend, owner)
    expect((await invoke(outsider, 'box:retained-playback-snapshot')).code).toBe('unauthorized')
    expect((await invoke(outsider, 'box:retained-playback-stop', outsider.mainFrame, { epoch: 'old-e', generation: '1' })).code).toBe('unauthorized')
    expect(snapshot).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    expect(await invoke(owner, 'box:retained-playback-snapshot')).toEqual({ ok: true, value: { epoch: 'service-e', playback: null } })
    expect((await invoke(owner, 'box:retained-playback-stop', owner.mainFrame, { epoch: 'old-e', generation: '01' })).code).toBe('invalid-command')
    expect(await invoke(owner, 'box:retained-playback-stop', owner.mainFrame, { epoch: 'old-e', generation: '1' })).toMatchObject({ ok: false, error: 'Audio service changed. Refresh before stopping the song.' })
    expect(stop).toHaveBeenCalledWith({ epoch: 'old-e', generation: '1' })
  })

  it('restores retained playback only for the trusted TV with exact epoch/generation input', async () => {
    const url = 'file:///tmp/renderer/box/box.html'
    const dto = { epoch: 'service-e', cached: { project: true } } as unknown as BoxRetainedPlaybackRestore
    const restore = vi.fn(async () => dto)
    const backend = await register(url, 'box', { restoreRetainedPlayback: restore })
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender(url)
    const outsider = new Sender(url)
    attached(backend, owner)
    const expected = { epoch: 'service-e', generation: '7' }
    expect((await invoke(outsider, 'box:retained-playback-restore', outsider.mainFrame, expected)).code).toBe('unauthorized')
    expect((await invoke(owner, 'box:retained-playback-restore', { url }, expected)).code).toBe('unauthorized')
    owner.mainFrame.url = `${url}.evil`
    expect((await invoke(owner, 'box:retained-playback-restore', owner.mainFrame, expected)).code).toBe('unauthorized')
    owner.mainFrame.url = url
    expect(restore).not.toHaveBeenCalled()
    for (const malformed of [
      null,
      [],
      {},
      { epoch: '', generation: '7' },
      { epoch: 'service-e', generation: '01' },
      { ...expected, libraryRoot: '/renderer', driveProjectsRoot: '/renderer', dir: '/renderer/song' }
    ]) {
      expect((await invoke(owner, 'box:retained-playback-restore', owner.mainFrame, malformed)).code).toBe('invalid-command')
    }
    expect(restore).not.toHaveBeenCalled()
    expect(await invoke(owner, 'box:retained-playback-restore', owner.mainFrame, expected)).toEqual({ ok: true, value: dto })
    expect(restore).toHaveBeenCalledExactlyOnceWith(expected)
    restore.mockRejectedValueOnce(new Error(`Audio service changed. Refresh before restoring. ${'x'.repeat(2500)}`))
    const stale = await invoke(owner, 'box:retained-playback-restore', owner.mainFrame, expected)
    expect(stale).toMatchObject({ ok: false, code: 'audio-state' })
    expect(stale.error).toMatch(/^Audio service changed/)
    expect(String(stale.error)).toHaveLength(2000)
  })

  it('reports retained restore as unavailable when persistent audio is not configured', async () => {
    const url = 'file:///tmp/renderer/box/box.html'
    const backend = await register(url)
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender(url)
    attached(backend, owner)
    expect(await invoke(owner, 'box:retained-playback-restore', owner.mainFrame, { epoch: 'service-e', generation: '7' }))
      .toMatchObject({ ok: false, code: 'unavailable', error: 'Independent audio is not configured.' })
  })

  it('registers no Box handlers for Desktop', async () => {
    expect(await register('file:///tmp/renderer/box/box.html', 'desktop')).toBeNull()
    expect(ipc.handlers.size).toBe(0)
  })

  it('requires the explicitly attached WebContents and exact development URL', async () => {
    const backend = await register('http://127.0.0.1:5173/box.html?lang=en#root')
    expect(backend).not.toBeNull()
    if (!backend) return
    const exact = 'http://127.0.0.1:5173/box.html?lang=en'
    const owner = new Sender(`${exact}#different-hash`)
    expect((await invoke(owner, 'box:state-get')).code).toBe('unauthorized')
    attached(backend, owner)
    expect((await invoke(owner, 'box:state-get')).ok).toBe(true)
    const wrongWindow = new Sender(exact)
    expect((await invoke(wrongWindow, 'box:state-get')).code).toBe('unauthorized')
    expect((await invoke(owner, 'box:state-get', { url: exact })).code).toBe('unauthorized')
    expect((await invoke(owner, 'box:state-get', null)).code).toBe('unauthorized')
    owner.mainFrame.url = 'http://127.0.0.1:5174/box.html?lang=en'
    expect((await invoke(owner, 'box:state-get')).code).toBe('unauthorized')
    owner.mainFrame.url = 'http://localhost:5173/box.html?lang=en'
    expect((await invoke(owner, 'box:state-get')).code).toBe('unauthorized')
    owner.mainFrame.url = 'http://127.0.0.1:5173/box.html.evil?lang=en'
    expect((await invoke(owner, 'box:state-get')).code).toBe('unauthorized')
    owner.mainFrame.url = `${exact}#reload`
    expect((await invoke(owner, 'box:state-get')).ok).toBe(true)
  })

  it('accepts only the exact packaged file, never a suffix clone', async () => {
    const backend = await register('file:///tmp/SingZ/out/renderer/box/box.html')
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender('file:///tmp/SingZ/out/renderer/box/box.html')
    attached(backend, owner)
    expect((await invoke(owner, 'box:state-get')).ok).toBe(true)
    owner.mainFrame.url = 'file:///tmp/SingZ/out/renderer/box/box.html.evil'
    expect((await invoke(owner, 'box:state-get')).code).toBe('unauthorized')
    owner.mainFrame.url = 'file:///tmp/other/out/renderer/box/box.html'
    expect((await invoke(owner, 'box:state-get')).code).toBe('unauthorized')
  })

  it('does not let another window claim ownership after destruction', async () => {
    const backend = await register('file:///tmp/SingZ/out/renderer/box/box.html')
    if (!backend) throw new Error('Box backend was not registered')
    const owner = new Sender('file:///tmp/SingZ/out/renderer/box/box.html')
    attached(backend, owner)
    expect((await invoke(owner, 'box:state-get')).ok).toBe(true)
    owner.destroyed = true
    owner.emit('destroyed')
    const other = new Sender('file:///tmp/SingZ/out/renderer/box/box.html')
    expect((await invoke(other, 'box:state-get')).code).toBe('unauthorized')
  })

  it('ignores late lifecycle events from a replaced window', async () => {
    const url = 'file:///tmp/SingZ/out/renderer/box/box.html'
    const backend = await register(url)
    if (!backend) throw new Error('Box backend was not registered')
    const oldOwner = new Sender(url)
    const currentOwner = new Sender(url)
    attached(backend, oldOwner)
    attached(backend, currentOwner)
    expect((await invoke(currentOwner, 'box:controller-publish', currentOwner.mainFrame, {
      activeProjectId: null,
      transport: { playing: false, position: 0, duration: 0, masterVolume: 1 },
      songs: [], queue: [], stems: [], activeLocalProjectDir: null
    })).ok).toBe(true)
    oldOwner.emit('render-process-gone')
    oldOwner.emit('did-start-navigation', {}, 'about:blank', false, true)
    oldOwner.emit('destroyed')
    expect(backend.controller.snapshot()).not.toBeNull()
    expect((await invoke(currentOwner, 'box:state-get')).ok).toBe(true)
  })
})

describe('host microphone IPC', () => {
  it('wraps snapshots and CAS receipts, checks renderer trust and contains service failures', async () => {
    const url = 'file:///tmp/SingZ/out/renderer/box/box.html'
    const snapshot = { epoch: 'host', revision: '7', phase: 'running', generation: '9' } as any
    const levels = { epoch: 'host', generation: '9', levels: { channelIndices: [0], peak: [0.5], rms: [0.1] } }
    const microphones = { snapshot: vi.fn(async () => snapshot), levels: vi.fn(async () => levels),
      setSelection: vi.fn(async (_edit: unknown) => ({ ok: false as const, code: 'stale' as const, error: 'Changed', snapshot })) }
    const backend = await register(url, 'box', { microphones })
    const owner = new Sender(url), outsider = new Sender(url)
    attached(backend!, owner)
    expect((await invoke(outsider, 'box:microphones')).code).toBe('unauthorized')
    expect(await invoke(owner, 'box:microphones')).toEqual({ ok: true, value: snapshot })
    expect((await invoke(outsider, 'box:microphone-levels')).code).toBe('unauthorized')
    expect(await invoke(owner, 'box:microphone-levels')).toEqual({ ok: true, value: levels })
    microphones.levels.mockRejectedValueOnce(new Error('Host disconnected'))
    expect(await invoke(owner, 'box:microphone-levels')).toMatchObject({ ok: false, code: 'audio-state' })
    const edit = { expectedRevision: '6', device: null, channels: {} }
    expect(await invoke(owner, 'box:microphone-selection-set', owner.mainFrame, edit)).toEqual({ ok: true, value: { ok: false, code: 'stale', error: 'Changed', snapshot } })
    expect(microphones.setSelection).toHaveBeenCalledWith(edit)
    microphones.snapshot.mockRejectedValueOnce(new Error('Host disconnected'))
    expect(await invoke(owner, 'box:microphones')).toMatchObject({ ok: false, code: 'audio-state' })
    microphones.setSelection.mockRejectedValueOnce(new Error('Host disconnected'))
    expect(await invoke(owner, 'box:microphone-selection-set', owner.mainFrame, edit)).toMatchObject({ ok: false, code: 'audio-state' })
  })
})
