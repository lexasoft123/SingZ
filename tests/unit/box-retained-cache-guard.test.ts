import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { BoxControllerPublish, BoxResult, BoxRetainedPlaybackSnapshot } from '../../src/shared/box-contract'
import type { DesktopPlaybackStatus } from '../../src/shared/types'
import { retainedRecovery, retainedStatus } from '../shared/box-retained-native-fixture'

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

type Register = typeof registerBoxIpc
type Backend = NonNullable<ReturnType<Register>>
type SnapshotReader = NonNullable<Parameters<Register>[0]['retainedPlaybackSnapshot']>
type CacheProject = {
  cacheRoot: string
  dir: string
  marker: string
  stem: string
  markerBytes: Buffer
  stemBytes: Buffer
}

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
const backends: Backend[] = []
const originalSurface = process.env.SINGZ_SURFACE
const rendererURL = 'file:///tmp/SingZ/out/renderer/box/box.html'

function invoke<T>(sender: Sender, channel: string, ...args: unknown[]): Promise<BoxResult<T>> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, ...args)) as Promise<BoxResult<T>>
}

function publication(paths: Partial<Pick<BoxControllerPublish, 'activeLocalProjectDir' | 'openingLocalProjectDir'>> = {}): BoxControllerPublish {
  return {
    activeProjectId: null,
    transport: { playing: false, position: 0, duration: 0, masterVolume: 1 },
    songs: [], queue: [], stems: [],
    activeLocalProjectDir: null,
    openingLocalProjectDir: null,
    ...paths
  }
}

function retainedSnapshot(
  dir: string | null,
  state: DesktopPlaybackStatus['state'] = 'running',
  transportState: DesktopPlaybackStatus['transportState'] = 'playing'
): BoxRetainedPlaybackSnapshot {
  const generation = state === 'unloaded' ? '0' : '7'
  const status = retainedStatus(generation, transportState, { state })
  const playback = { generation, state, transportState }
  if (!dir) return { epoch: 'service-e', playback }
  const stem = join(dir, 'stems', 'vocals.flac')
  const recovery = retainedRecovery(status)
  recovery.descriptor.project = {
    ...recovery.descriptor.project,
    dir,
    songPath: join(dir, 'original.wav'),
    media: [{ ...recovery.descriptor.project.media[0], path: stem }]
  }
  recovery.descriptor.lanes = [{ ...recovery.descriptor.lanes[0], path: stem }]
  return { epoch: 'service-e', playback, recovery }
}

async function cacheProject(cacheRoot: string, id = 'drive-song'): Promise<CacheProject> {
  const dir = join(cacheRoot, id)
  const marker = join(dir, 'project.json')
  const stem = join(dir, 'stems', 'vocals.flac')
  const markerBytes = Buffer.from(JSON.stringify({ version: 2, name: 'Retained song' }))
  const stemBytes = Buffer.from([0x66, 0x4c, 0x61, 0x43, 0, 1, 2, 3, 4, 5, 255, 128, 64, 32])
  await mkdir(dirname(stem), { recursive: true })
  await writeFile(marker, markerBytes)
  await writeFile(stem, stemBytes)
  return { cacheRoot, dir, marker, stem, markerBytes, stemBytes }
}

async function quarantineEntries(project: CacheProject): Promise<string[]> {
  return (await readdir(project.cacheRoot)).filter(name => name.startsWith('.singz-removing-'))
}

async function expectProjectPreserved(project: CacheProject): Promise<void> {
  const [marker, stem] = await Promise.all([
    readFile(project.marker).catch(error => error),
    readFile(project.stem).catch(error => error)
  ])
  expect(marker).toEqual(project.markerBytes)
  expect(stem).toEqual(project.stemBytes)
  expect(await quarantineEntries(project)).toEqual([])
}

async function fixture({ reader, register = registerBoxIpc }: { reader?: SnapshotReader; register?: Register } = {}) {
  process.env.SINGZ_SURFACE = 'box'
  const userDataDir = await mkdtemp(join(tmpdir(), 'box-retained-cache-guard-'))
  dirs.push(userDataDir)
  const backend = register({
    userDataDir,
    appVersion: 'test',
    rendererURL,
    audioInputs: () => ({ ok: true, devices: [] }),
    audioHost: () => ({ ok: true, devices: [] }),
    ...(reader ? { retainedPlaybackSnapshot: reader } : {})
  })
  if (!backend) throw new Error('Box backend was not registered')
  backends.push(backend)
  const owner = new Sender(rendererURL)
  backend.attachRenderer(owner as unknown as WebContents)
  const project = await cacheProject(backend.storage.cacheRoot)
  expect(await invoke<null>(owner, 'box:controller-publish', publication())).toMatchObject({ ok: true })
  return {
    backend,
    owner,
    project,
    remove: () => invoke<null>(owner, 'box:cache-remove', project.dir),
    publish: (paths: Parameters<typeof publication>[0]) => invoke<null>(owner, 'box:controller-publish', publication(paths))
  }
}

async function registerWithStorageSource(storageSource: string): Promise<Register> {
  const ipcPath = fileURLToPath(new URL('../../src/main/box/ipc.ts', import.meta.url))
  const storagePath = fileURLToPath(new URL('../../src/main/box/storage.ts', import.meta.url))
  const result = await build({
    entryPoints: [ipcPath],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
    plugins: [{
      name: 'retained-cache-guard-negative-control',
      setup(compilation) {
        compilation.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'box-test-electron' }))
        compilation.onLoad({ filter: /.*/, namespace: 'box-test-electron' }, () => ({ contents: `
          export const ipcMain = {
            handle(channel, handler) { globalThis.__boxCacheGuardTestIpc.handle(channel, handler) },
            removeHandler(channel) { globalThis.__boxCacheGuardTestIpc.removeHandler(channel) }
          }
        ` }))
        compilation.onResolve({ filter: /^\.\/storage$/ }, args => args.importer === ipcPath
          ? { path: 'storage', namespace: 'box-test-storage' }
          : undefined)
        compilation.onLoad({ filter: /.*/, namespace: 'box-test-storage' }, () => ({
          contents: storageSource,
          loader: 'ts',
          resolveDir: dirname(storagePath)
        }))
      }
    }]
  })
  const output = result.outputFiles[0]?.text
  if (!output) throw new Error('Negative-control IPC bundle was empty')
  ;(globalThis as { __boxCacheGuardTestIpc?: typeof ipc }).__boxCacheGuardTestIpc = ipc
  const module = await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`) as { registerBoxIpc: Register }
  return module.registerBoxIpc
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(async () => {
  for (const backend of backends.splice(0).reverse()) await backend.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  ipc.handlers.clear()
  delete (globalThis as { __boxCacheGuardTestIpc?: typeof ipc }).__boxCacheGuardTestIpc
  if (originalSurface === undefined) delete process.env.SINGZ_SURFACE
  else process.env.SINGZ_SURFACE = originalSurface
})

describe('Box retained cache removal guard', () => {
  it.each([
    ['playing', 'running', 'playing'],
    ['paused', 'output-open', 'paused'],
    ['prepared', 'prepared', 'stopped']
  ] as const)('blocks the canonically same %s retained project before quarantine with active:null published', async (_label, state, transportState) => {
    const reader = vi.fn(async () => retainedSnapshot(''))
    const f = await fixture({ reader })
    const alias = join(dirname(f.backend.storage.cacheRoot), 'retained-alias')
    await symlink(f.project.dir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    reader.mockImplementation(async () => retainedSnapshot(alias, state, transportState))

    expect(await f.remove()).toMatchObject({ ok: false, code: 'project-active' })
    expect(reader).toHaveBeenCalledTimes(1)
    await expectProjectPreserved(f.project)
    expect(await readdir(f.project.cacheRoot)).toEqual(['drive-song'])
  })

  it.each(['no-recovery', 'null-recovery', 'mismatched-recovery', 'missing-identity', 'malformed', 'error'] as const)('denies removal as unavailable for %s', async kind => {
    let projectDir = ''
    const reader = vi.fn(async () => {
      if (kind === 'error') throw new Error('host unavailable')
      if (kind === 'no-recovery') return retainedSnapshot(null)
      const snapshot = retainedSnapshot(projectDir)
      if (kind === 'null-recovery') return { ...snapshot, recovery: null }
      if (kind === 'mismatched-recovery' && snapshot.recovery) return {
        ...snapshot,
        recovery: { ...snapshot.recovery, generation: '8' }
      }
      if (kind === 'missing-identity' && snapshot.recovery) {
        snapshot.recovery.descriptor.project.dir = ''
      }
      if (kind === 'malformed') return { epoch: 'service-e', playback: { generation: '7', state: 'unknown' } }
      return snapshot
    }) as unknown as SnapshotReader
    const f = await fixture({ reader })
    projectDir = f.project.dir

    expect(await f.remove()).toMatchObject({ ok: false, code: 'unavailable' })
    await expectProjectPreserved(f.project)
  })

  it.each(['idle', 'unloaded', 'other-project'] as const)('allows %s when authoritative host state proves the target is not retained', async kind => {
    let other: CacheProject | undefined
    const reader = vi.fn(async () => {
      if (kind === 'idle') return { epoch: 'service-e', playback: null }
      if (kind === 'unloaded') return retainedSnapshot(null, 'unloaded', 'stopped')
      return retainedSnapshot(other!.dir)
    })
    const f = await fixture({ reader })
    if (kind === 'other-project') other = await cacheProject(f.project.cacheRoot, 'drive-other')

    expect(await f.remove()).toMatchObject({ ok: true, value: null })
    await expect(readFile(f.project.stem)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await quarantineEntries(f.project)).toEqual([])
    if (other) await expectProjectPreserved(other)
  })

  it('holds the controller reservation during an async guard and releases it after denial', async () => {
    const admitted = deferred<void>()
    const first = deferred<BoxRetainedPlaybackSnapshot>()
    let other: CacheProject | undefined
    let calls = 0
    const reader = vi.fn(() => {
      calls++
      if (calls === 1) {
        admitted.resolve()
        return first.promise
      }
      return Promise.resolve(retainedSnapshot(other!.dir))
    })
    const f = await fixture({ reader })
    other = await cacheProject(f.project.cacheRoot, 'drive-other')
    const removing = f.remove()
    await admitted.promise

    expect(await f.publish({ openingLocalProjectDir: f.project.dir })).toMatchObject({ ok: false, code: 'project-busy' })
    await expectProjectPreserved(f.project)
    first.resolve(retainedSnapshot(f.project.dir))
    expect(await removing).toMatchObject({ ok: false, code: 'project-active' })
    await expectProjectPreserved(f.project)

    expect(await f.remove()).toMatchObject({ ok: true, value: null })
    expect(reader).toHaveBeenCalledTimes(2)
    await expectProjectPreserved(other)
  })

  it('keeps legacy no-option cache removal working', async () => {
    const f = await fixture()
    expect(await f.remove()).toMatchObject({ ok: true, value: null })
    await expect(readFile(f.project.stem)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await quarantineEntries(f.project)).toEqual([])
  })

  it('negative control: disabling the actual storage pre-remove hook fails same-project preservation', async () => {
    const sourceURL = new URL('../../src/main/box/storage.ts', import.meta.url)
    const source = await readFile(sourceURL, 'utf8')
    expect(source.match(/if \(this\.preRemoveGuard\)/g)).toHaveLength(1)
    const unsafeSource = source.replace('if (this.preRemoveGuard) {', 'if (false) {')
    expect(unsafeSource).not.toBe(source)
    const unsafeRegister = await registerWithStorageSource(unsafeSource)
    let projectDir = ''
    const reader = vi.fn(async () => retainedSnapshot(projectDir))
    const f = await fixture({ reader, register: unsafeRegister })
    projectDir = f.project.dir

    expect(await f.remove()).toMatchObject({ ok: true, value: null })
    expect(reader).not.toHaveBeenCalled()
    await expect(expectProjectPreserved(f.project)).rejects.toThrow()
  })
})
