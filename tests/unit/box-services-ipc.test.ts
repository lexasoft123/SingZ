import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'

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
async function register(rendererURL: string, surface = 'box') {
  process.env.SINGZ_SURFACE = surface
  const userDataDir = await mkdtemp(join(tmpdir(), 'box-ipc-'))
  dirs.push(userDataDir)
  const backend = registerBoxIpc({
    userDataDir,
    appVersion: 'test',
    rendererURL,
    audioInputs: () => ({ ok: true, devices: [] }),
    audioHost: () => ({ ok: true, devices: [] })
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
