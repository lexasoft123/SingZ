import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), folder: '',
  native: vi.fn(async (_paths: string[], _staging: string, _format: string, _job: string) => ({ ok: true })), cancel: vi.fn(), copied: [] as string[]
}))
vi.mock('electron', async importOriginal => ({
  ...await importOriginal<typeof import('electron')>(),
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [mock.folder] }) }
}))
vi.mock('../../src/main/audio-process', () => ({ desktopAudioProcess: {
  call: async (target: string, method: string, args: unknown[]) => {
    if (target === 'export' && method === 'paths') return mock.native(...args as [string[], string, string, string])
    if (target === 'binding' && method === 'cancelAudioExport') return mock.cancel(args[0])
    throw new Error(`Unexpected audio RPC ${target}.${method}`)
  }
} }))
vi.mock('../../src/main/log', () => ({ log: vi.fn() }))
import { registerStemExport } from '../../src/main/stem-export'
import { allowFile, allowRoot } from '../../src/main/media'
const sender = { sender: Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false }) }
const invoke = (name: string, ...args: any[]): any => mock.handlers.get(`stems:export-${name}`)!(sender, ...args)
let source: string
beforeEach(async () => {
  mock.folder = await mkdtemp(join(tmpdir(), 'singz-export-ipc-'))
  source = join(mock.folder, 'source.wav')
  await writeFile(source, 'fixture: PCM belongs to native code')
  allowFile(source)
  mock.copied = []
  mock.native.mockReset().mockImplementation(async (paths, staging) => {
    mock.copied = await Promise.all(paths.map(path => readFile(path, 'utf8')))
    await writeFile(staging, mock.copied.join(''))
    return { ok: true }
  })
  mock.cancel.mockReset()
  registerStemExport()
})
afterEach(async () => { sender.sender.emit('destroyed'); sender.sender.removeAllListeners(); await rm(mock.folder, { recursive: true, force: true }) })
it('snapshots authorized descriptors for the helper, rejects foreign sessions and preserves existing output', async () => {
  const { token } = await invoke('begin')
  expect((await invoke('write', 'foreign', 'a', 'wav', source)).ok).toBe(false)
  expect((await invoke('write', token, 'a', 'wav', '/unregistered.wav')).ok).toBe(false)
  expect(mock.native).not.toHaveBeenCalled()
  expect((await invoke('write', token, '../a', 'wav', source)).ok).toBe(true)
  const [input, output, format, job] = mock.native.mock.calls[0] as unknown as [string[], string, string, string]
  expect(input).toHaveLength(1)
  expect(input[0]).not.toBe(source)
  expect(output).toContain('singz-export-')
  expect(mock.copied).toEqual(['fixture: PCM belongs to native code'])
  await expect(readFile(input[0])).rejects.toMatchObject({ code: 'ENOENT' })
  expect(format).toBe('wav'); expect(job).toMatch(/^[\da-f-]+$/)
  await writeFile(join(mock.folder, '.._a.wav'), 'keep me')
  expect((await invoke('write', token, '../a', 'wav', source)).ok).toBe(false)
  expect((await readFile(join(mock.folder, '.._a.wav'))).toString()).toBe('keep me')
})
it('cancels the native job and never publishes cancelled output', async () => {
  let finish: ((result: { ok: boolean }) => void) | undefined
  mock.native.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { token } = await invoke('begin')
  const writing = invoke('write', token, 'a', 'mp3', source)
  await vi.waitFor(() => expect(finish).toBeDefined())
  await invoke('end', token)
  expect(mock.cancel).toHaveBeenCalledOnce()
  finish!({ ok: true })
  expect((await writing).ok).toBe(false)
  expect(await readdir(mock.folder)).toEqual(['source.wav'])
})

it('finds the compacted stem after an autosave replaces its WAV', async () => {
  const stems = join(mock.folder, 'stems')
  await mkdir(stems)
  await writeFile(join(stems, 'vocals.flac'), 'native decoder owns this content')
  allowRoot(stems)
  const { token } = await invoke('begin')
  expect((await invoke('write', token, 'vocals', 'wav', join(stems, 'vocals.wav'))).ok).toBe(true)
  expect(mock.native).toHaveBeenCalledOnce()
})

it('authorizes every source in a mix and transfers only private snapshot paths', async () => {
  const second = join(mock.folder, 'backing.wav')
  await writeFile(second, 'native backing audio')
  allowFile(second)
  const { token } = await invoke('begin')
  expect((await invoke('write', token, 'karaoke', 'wav', [source, '/unregistered.wav'])).ok).toBe(false)
  expect((await invoke('write', token, 'karaoke', 'wav', [])).ok).toBe(false)
  expect(mock.native).not.toHaveBeenCalled()
  expect((await invoke('write', token, 'karaoke', 'wav', [source, second])).ok).toBe(true)
  expect(mock.native.mock.calls[0][0]).toEqual([expect.any(String), expect.any(String)])
  expect(mock.native.mock.calls[0][0]).not.toContain(source)
  expect(mock.native.mock.calls[0][0]).not.toContain(second)
  expect(mock.copied).toEqual(['fixture: PCM belongs to native code', 'native backing audio'])
})
