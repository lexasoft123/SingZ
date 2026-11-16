import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, rename, symlink, open, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename, win32 } from 'node:path'
import { ConformTakeError, conformFilePath, TAKE_CONFORM_VERSION, isConformTakeError, prepareConformRequest, VoiceTakeConformer, type TakeConformNative, type TakeConformNativeRequest } from '../../src/main/voice-take-conform'
import { defaultVoiceTakeEffects, resolveVoiceTakeTimeline, type VoiceTakeSidecar } from '../../src/shared/voice-take'
const locked = vi.hoisted(() => new Set<string>())
const publication = vi.hoisted(() => ({ afterWavRename: undefined as ((path: string) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await actual.rename(...args)
    if (String(args[1]).endsWith('.wav')) await publication.afterWavRename?.(String(args[1]))
  }, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (locked.has(String(args[0]))) throw Object.assign(new Error('file in use'), { code: 'EPERM' })
    return actual.rm(...args)
  } }
})
const wav = (frames = 8000, rate = 8000): Buffer => {
  const b = Buffer.alloc(44 + frames * 2)
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2, 40)
  return b
}
const side = (takeId = 'take'): VoiceTakeSidecar => ({
  version: 1, takeId, songId: 'song', sampleRate: 8000, channels: 1, startPositionSec: 0,
  userOffsetSec: 0, settings: [{ atSec: 0, tempo: 1, transposeSemitones: 0 }],
  anchors: [{ takeFrame: 0, projectFrame: 0 }, { takeFrame: 8000, projectFrame: 8000 }],
  audio: { fileName: `${takeId}.wav`, format: 'wav-pcm16', byteSize: 16044, checksum: null }
} as VoiceTakeSidecar)
const options = { songDurationProjectFrames: 16000, outputRate: 8000 }
let root: string, calls: TakeConformNativeRequest[], cancel: string[]
let native: TakeConformNative
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'singz-conform-')); await mkdir(join(root, 'song'))
  calls = []; cancel = []; locked.clear(); publication.afterWavRename = undefined
  native = {
    async conformTake(_input, output, request) {
      calls.push(request)
      await writeFile(output, wav(8000, request.outputRate))
      return { ok: true, durationFrames: 8000 }
    }, cancelTakeConform(job) { cancel.push(job) }
  }
  await writeFile(join(root, 'song', 'take.wav'), wav())
  await writeFile(join(root, 'song', 'take.json'), JSON.stringify(side()))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

/** Whether this account can create a symlink at all (Windows needs admin or Developer Mode). */
const CAN_SYMLINK = await (async (): Promise<boolean> => {
  const dir = await mkdtemp(join(tmpdir(), 'singz-symlink-probe-'))
  try { await writeFile(join(dir, 'a'), 'x'); await symlink(join(dir, 'a'), join(dir, 'b')); return true } catch { return false }
  finally { await rm(dir, { recursive: true, force: true }) }
})()

describe('Windows conform paths (portable normalisation)', () => {
  it.each([
    ['C:/profile/one/../two.wav', 'C:\\unused', '\\\\?\\C:\\profile\\two.wav'],
    ['.\\one\\..\\two.wav', 'C:\\profile', '\\\\?\\C:\\profile\\two.wav'],
    ['\\\\server\\share\\one\\..\\two.wav', 'C:\\unused', '\\\\?\\UNC\\server\\share\\two.wav'],
    ['\\\\?\\UNC\\server\\share\\one\\..\\two.wav', 'C:\\unused', '\\\\?\\UNC\\server\\share\\two.wav'],
    ['\\\\?\\C:\\profile\\one\\..\\two.wav', 'C:\\unused', '\\\\?\\C:\\profile\\two.wav']
  ])('normalises %s before prefixing', (input, cwd, expected) => {
    expect(conformFilePath(input, 'win32', cwd)).toBe(expected)
    expect(conformFilePath(expected, 'win32', cwd)).toBe(expected)
  })
  it('preserves POSIX and rejects unsupported devices and real length limits with a typed code', () => {
    expect(conformFilePath('/tmp/a.wav', 'darwin')).toBe('/tmp/a.wav')
    const unicode = 'C:\\' + ('歌'.repeat(200) + '\\').repeat(100) + 'take.wav'
    expect(Buffer.byteLength(unicode)).toBeGreaterThan(32768)
    expect(conformFilePath(unicode, 'win32', 'C:\\').length).toBeLessThan(32767)
    expect(() => conformFilePath('\\\\.\\PhysicalDrive0', 'win32', 'C:\\')).toThrow('device')
    for (const input of ['C:\\' + 'p'.repeat(256), 'C:\\' + ('p'.repeat(200) + '\\').repeat(164)]) {
      expect(() => conformFilePath(input, 'win32', 'C:\\')).toThrowError(expect.objectContaining({ code: 'path-too-long' }))
    }
  })
  it('prefixes a long final lane path without the host long-path setting', () => {
    const input = win32.join('C:\\', 'p'.repeat(200), 's'.repeat(36), '.conform', 'a'.repeat(16) + '.wav')
    expect(input.length).toBeGreaterThan(260)
    expect(conformFilePath(input, 'win32', 'C:\\')).toBe('\\\\?\\' + input)
  })
})

describe('offline take conform cache', () => {
  it('uses bounded cache/temp names under a 200-character profile directory (old naming is a negative control)', async () => {
    const profile = conformFilePath(join(root, 'p'.repeat(Math.max(1, 200 - root.length - 1))))
    const songDir = join(profile, 'song'); await mkdir(songDir, { recursive: true })
    const takeId = '12345678-1234-4234-9234-123456789abc'
    await writeFile(join(songDir, `${takeId}.wav`), wav()); await writeFile(join(songDir, `${takeId}.json`), JSON.stringify(side(takeId)))
    let tempPath = ''
    native.conformTake = async (_in, out) => { tempPath = out; await writeFile(out, wav()); return { ok: true, durationFrames: 8000 } }
    const c = new VoiceTakeConformer(profile, native), first = await c.conformTake('song', takeId, options)
    expect(TAKE_CONFORM_VERSION).toBe('take-conform-3')
    expect(basename(first.path)).toMatch(/^[a-f0-9]{16}\.wav$/)
    expect(basename(tempPath)).toMatch(/^[a-f0-9]{32}\.tmp$/)
    const layout = win32.join('C:\\' + 'p'.repeat(197), 'song', '.conform')
    expect(win32.join(layout, basename(first.path)).length).toBeLessThan(260)
    expect(win32.join(layout, basename(tempPath)).length).toBeLessThan(260)
    const old = win32.join(layout, `${takeId}.conform-${first.key}.wav.12345678-1234-4234-9234-123456789abc.tmp`)
    expect(old.length).toBeGreaterThan(260)
    expect(JSON.parse(await readFile(first.path.slice(0, -4) + '.json', 'utf8'))).toEqual({ version: TAKE_CONFORM_VERSION, key: first.key, takeId })
    expect((await c.conformTake('song', takeId, options)).cached).toBe(true)
  })
  it('checks the full key and extends a colliding prefix without overwriting a pinned lane', async () => {
    const c = new VoiceTakeConformer(root, native)
    const first = await c.conformTake('song', 'take', { ...options, retain: true })
    const collision = first.key.slice(0, 16) + (first.key.endsWith('0'.repeat(48)) ? '1' : '0').repeat(48)
    await writeFile(first.path.slice(0, -4) + '.json', JSON.stringify({ version: TAKE_CONFORM_VERSION, key: collision, takeId: 'take' }))
    const second = await c.conformTake('song', 'take', { ...options, retain: true })
    expect(second.cached).toBe(false); expect(second.key).toBe(first.key)
    expect(basename(second.path)).toBe(second.key.slice(0, 32) + '.wav')
    expect(second.path).not.toBe(first.path); expect(await readFile(first.path)).toEqual(wav()); expect(calls).toHaveLength(2)
    expect((await c.conformTake('song', 'take', options)).path).toBe(second.path)
    c.release(first.path); c.release(second.path)
  })
  it('protects an unretained WAV during the WAV/metadata rename gap from a concurrent invalidate', async () => {
    const birth = Math.floor(Date.now() / 1000) * 1000
    let now = birth, release!: () => void, started!: () => void, published = ''
    const ready = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    publication.afterWavRename = async path => { published = path; await utimes(path, new Date(birth), new Date(birth)); started(); await held }
    const c = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 40000 }, () => now)
    const work = c.conformTake('song', 'take', options) // explicitly no retain pin
    try {
      await ready; now = birth + 4999
      await c.invalidate('song', 'take', { cancelActive: false })
      expect(await readFile(published)).toEqual(wav())
      await expect(readFile(published.slice(0, -4) + '.json')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); await work }
    expect((await c.conformTake('song', 'take', options)).cached).toBe(true)
  })
  it('reclaims a missing-record WAV when the injected-clock publication grace expires', async () => {
    const birth = Math.floor(Date.now() / 1000) * 1000
    let now = birth + 4999
    const cache = join(root, 'song', '.conform'); await mkdir(cache)
    const orphan = join(cache, 'a'.repeat(16) + '.wav')
    await writeFile(orphan, wav()); await utimes(orphan, new Date(birth), new Date(birth))
    const c = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 40000 }, () => now)
    await c.invalidate('song', 'take', { cancelActive: false })
    expect(await readFile(orphan)).toEqual(wav())
    now = birth + 5000
    await c.invalidate('song', 'take', { cancelActive: false })
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('charges a fresh publishing WAV against the cache quota without evicting it', async () => {
    const birth = Math.floor(Date.now() / 1000) * 1000
    const cache = join(root, 'song', '.conform'); await mkdir(cache)
    const orphan = join(cache, 'a'.repeat(16) + '.wav')
    await writeFile(orphan, wav()); await utimes(orphan, new Date(birth), new Date(birth))
    const c = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 16043 }, () => birth)
    await expect(c.invalidate('song', 'take', { cancelActive: false })).rejects.toMatchObject({ code: 'memory-budget' })
    expect(await readFile(orphan)).toEqual(wav())
  })
  it('ignores and evicts legacy long names, malformed/orphan metadata and old temporary files', async () => {
    const cache = join(root, 'song', '.conform'); await mkdir(cache)
    const legacy = join(cache, `take.conform-${'a'.repeat(64)}.wav`)
    await writeFile(legacy, wav())
    const partial = join(cache, 'b'.repeat(32) + '.tmp'); await writeFile(partial, 'partial'); await utimes(partial, new Date(0), new Date(0))
    await writeFile(join(cache, 'c'.repeat(16) + '.json'), '{}')
    const corrupt = join(cache, 'd'.repeat(16) + '.wav'); await writeFile(corrupt, wav()); await writeFile(corrupt.slice(0, -4) + '.json', 'null')
    const result = await new VoiceTakeConformer(root, native).conformTake('song', 'take', options)
    expect(result.cached).toBe(false)
    expect((await readdir(cache)).sort()).toEqual([basename(result.path), basename(result.path).replace('.wav', '.json')].sort())
  })
  it.skipIf(process.platform !== 'win32')('publishes and returns a namespaced lane beyond MAX_PATH using real Windows fs APIs', async () => {
    const profile = conformFilePath(join(root, 'p'.repeat(100), 'q'.repeat(100), 'r'.repeat(100)))
    await mkdir(join(profile, 'song'), { recursive: true })
    await writeFile(join(profile, 'song', 'take.wav'), wav()); await writeFile(join(profile, 'song', 'take.json'), JSON.stringify(side()))
    const c = new VoiceTakeConformer(profile, native), result = await c.conformTake('song', 'take', options)
    expect(result.path.startsWith('\\\\?\\')).toBe(true); expect(result.path.length).toBeGreaterThan(260)
    expect(await readFile(result.path)).toEqual(wav()); expect((await c.conformTake('song', 'take', options)).cached).toBe(true)
    await c.invalidate('song', 'take'); await expect(readFile(result.path)).rejects.toThrow()
  })
  it.each(['take-too-long', 'memory-budget', 'path-too-long', 'conform-error', 'cancelled'] as const)('preserves the native %s code and detail without message parsing', async code => {
    native.conformTake = async () => ({ ok: false, errorCode: code, detail: 'opaque producer diagnostic', durationFrames: 0 })
    const error = await new VoiceTakeConformer(root, native).conformTake('song', 'take', options).catch(error => error)
    expect(error).toBeInstanceOf(ConformTakeError)
    expect(isConformTakeError(error)).toBe(true)
    expect(error).toMatchObject({ code, detail: 'opaque producer diagnostic', message: 'opaque producer diagnostic' })
    expect((await readdir(join(root, 'song', '.conform'))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })
  it('gives unexpected producer exceptions the conform-error code', async () => {
    native.conformTake = async () => { throw new Error('decoder exploded') }
    await expect(new VoiceTakeConformer(root, native).conformTake('song', 'take', options)).rejects.toMatchObject({ code: 'conform-error', detail: 'decoder exploded' })
  })
  it('publishes a complete WAV atomically and hits the identical key', async () => {
    const c = new VoiceTakeConformer(root, native)
    const first = await c.conformTake('song', 'take', options)
    const second = await c.conformTake('song', 'take', options)
    expect(first.cached).toBe(false); expect(second).toEqual({ ...first, cached: true })
    expect(calls).toHaveLength(1)
    expect(await readFile(first.path)).toEqual(wav())
    expect((await readdir(join(root, 'song'))).filter(s => s.endsWith('.tmp'))).toEqual([])
  })
  it('admits a two-hour take using header/metadata only, and refuses over four hours', async () => {
    const rate = 48000, frames = rate * 7200
    const h = wav(0, rate); h.writeUInt32LE(frames * 2 + 36, 4); h.writeUInt32LE(frames * 2, 40)
    const handle = await open(join(root, 'song', 'take.wav'), 'r+')
    try { await handle.write(h, 0, 44, 0); await handle.truncate(frames * 2 + 44) } finally { await handle.close() }
    const s = side(); s.sampleRate = rate; s.durationSec = 7200; s.anchors = [{ takeFrame: 0, projectFrame: 0 }, { takeFrame: frames, projectFrame: frames }]
    s.settings.push({ atSec: 3600, tempo: 1, transposeSemitones: 0 })
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(s))
    const c = new VoiceTakeConformer(root, native)
    expect((await c.conformTake('song', 'take', { songDurationProjectFrames: frames, outputRate: rate })).cached).toBe(false)
    expect(calls[0].settings[1].takeFrame).toBe(rate * 3600)
    h.writeUInt32LE(rate * 14401 * 2, 40)
    await writeFile(join(root, 'song', 'take.wav'), h)
    await expect(c.conformTake('song', 'take', { songDurationProjectFrames: frames, outputRate: rate })).rejects.toMatchObject({ code: 'take-too-long', detail: 'Take exceeds four-hour conform limit' })
  })
  it('charges disk quota to the placed take rather than the whole song', async () => {
    const c = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 40000 })
    expect((await c.conformTake('song', 'take', { ...options, songDurationProjectFrames: 8000 * 7200 })).durationFrames).toBe(8000)
  })
  it('invalidates moves, effects, rate, duration, anchors, and re-recordings', async () => {
    const c = new VoiceTakeConformer(root, native)
    const original = await c.conformTake('song', 'take', options)
    const moved = side(); moved.userOffsetSec = 0.1
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(moved))
    const m = await c.conformTake('song', 'take', options)
    expect(m.key).not.toBe(original.key)
    expect(original.placementFrame).toBe(0)
    expect(m.placementFrame).toBe(800)
    expect((await c.conformTake('song', 'take', options)).placementFrame).toBe(800)
    await expect(readFile(original.path)).rejects.toThrow()
    const fx = await c.conformTake('song', 'take', { ...options, effects: [{ ...defaultVoiceTakeEffects()[0], enabled: false }] })
    expect(fx.key).not.toBe(m.key)
    const duration = await c.conformTake('song', 'take', { ...options, songDurationProjectFrames: 12000 })
    expect(duration.key).not.toBe(m.key)
    const rate = await c.conformTake('song', 'take', { ...options, outputRate: 16000 })
    expect(rate.key).not.toBe(duration.key)
    moved.anchors![1].projectFrame = 6000
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(moved))
    const anchored = await c.conformTake('song', 'take', options)
    expect(anchored.key).not.toBe(m.key)
    await writeFile(join(root, 'song', 'replacement.wav'), wav())
    await rename(join(root, 'song', 'replacement.wav'), join(root, 'song', 'take.wav'))
    expect((await c.conformTake('song', 'take', options)).key).not.toBe(anchored.key)
  })
  it('evicts by entry and byte bounds and removes caches for deleted takes', async () => {
    const c = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 40000 })
    const first = await c.conformTake('song', 'take', options)
    await writeFile(join(root, 'song', 'other.wav'), wav())
    await writeFile(join(root, 'song', 'other.json'), JSON.stringify(side('other')))
    const other = await c.conformTake('song', 'other', options)
    await expect(readFile(first.path)).rejects.toThrow(); expect(await readFile(other.path)).toEqual(wav())
    await rm(join(root, 'song', 'other.wav'))
    await c.invalidate('song', 'other')
    await expect(readFile(other.path)).rejects.toThrow()
    const byBytes = new VoiceTakeConformer(root, native, { maxEntries: 8, maxBytes: 24000 })
    const a = await byBytes.conformTake('song', 'take', { ...options, songDurationProjectFrames: 8000 })
    await writeFile(join(root, 'song', 'other.wav'), wav())
    const b = await byBytes.conformTake('song', 'other', { ...options, songDurationProjectFrames: 8000 })
    await expect(readFile(a.path)).rejects.toThrow(); expect(await readFile(b.path)).toEqual(wav())
  })
  it('retains a busy Windows lane until replacement and enforces the cache budget', async () => {
    const c = new VoiceTakeConformer(root, native)
    const first = await c.conformTake('song', 'take', options)
    locked.add(first.path)
    const moved = side(); moved.userOffsetSec = 0.25
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(moved))
    const second = await c.conformTake('song', 'take', options)
    expect(second.key).not.toBe(first.key)
    expect(await readFile(first.path)).toEqual(wav())
    locked.delete(first.path)
    await c.invalidate('song', 'take')
    await expect(readFile(first.path)).rejects.toThrow()
    const bounded = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 40000 })
    const only = await bounded.conformTake('song', 'take', options)
    locked.add(only.path)
    moved.userOffsetSec = 0.5
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(moved))
    const rendered = calls.length
    await expect(bounded.conformTake('song', 'take', options)).rejects.toThrow('cache is full')
    expect(calls).toHaveLength(rendered)
    locked.clear()
    expect((await bounded.conformTake('song', 'take', options)).cached).toBe(false)
  })
  it('pins POSIX lane files before async prepare and reclaims only the retired lease', async () => {
    const c = new VoiceTakeConformer(root, native)
    const old = await c.conformTake('song', 'take', { ...options, retain: true })
    const moved = side(); moved.userOffsetSec = .25
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(moved))
    const next = await c.conformTake('song', 'take', { ...options, retain: true })
    expect(await readFile(old.path)).toEqual(wav()) // POSIX permits unlink; our lease prevents it.
    c.release(old.path)
    await c.invalidate('song', 'take', { keepPath: next.path, cancelActive: false })
    await expect(readFile(old.path)).rejects.toThrow()
    expect(await readFile(next.path)).toEqual(wav())
    c.release(next.path)
    await c.invalidate('song', 'take')
    await expect(readFile(next.path)).rejects.toThrow()
  })
  it('counts pinned/busy files against the cache bound and releases failed publication pins', async () => {
    const c = new VoiceTakeConformer(root, native, { maxEntries: 1, maxBytes: 40000 })
    const first = await c.conformTake('song', 'take', { ...options, retain: true })
    const moved = side(); moved.userOffsetSec = .25
    await writeFile(join(root, 'song', 'take.json'), JSON.stringify(moved))
    await expect(c.conformTake('song', 'take', { ...options, retain: true })).rejects.toThrow('cache is full')
    expect(calls).toHaveLength(1)
    c.release(first.path)
    const next = await c.conformTake('song', 'take', { ...options, retain: true })
    c.release(next.path)
    await c.invalidate('song', 'take')
    await expect(readFile(next.path)).rejects.toThrow()
  })
  it('does not publish failures, stale work or partial files', async () => {
    native.conformTake = async (_in, output) => { await writeFile(output, 'partial'); return { ok: false, error: 'disk full', durationFrames: 0 } }
    await expect(new VoiceTakeConformer(root, native).conformTake('song', 'take', options)).rejects.toThrow('disk full')
    expect(await readdir(join(root, 'song', '.conform'))).toEqual([])
    native.conformTake = async (_in, output) => {
      await writeFile(output, wav()); await writeFile(join(root, 'song', 'take.wav'), wav(4000))
      return { ok: true, durationFrames: 8000 }
    }
    await expect(new VoiceTakeConformer(root, native).conformTake('song', 'take', options)).rejects.toThrow('changed')
    expect(await readdir(join(root, 'song', '.conform'))).toEqual([])
  })
  it('a newer request cancels and drains its predecessor before starting', async () => {
    let release!: () => void, started!: () => void
    const ready = new Promise<void>(r => { started = r })
    const held = new Promise<void>(r => { release = r })
    let jobs = 0
    native.conformTake = async (_in, out) => {
      if (++jobs === 1) { started(); await held }
      await writeFile(out, wav()); return { ok: true, durationFrames: 8000 }
    }
    native.cancelTakeConform = job => { cancel.push(job); release() }
    const c = new VoiceTakeConformer(root, native)
    const old = c.conformTake('song', 'take', options)
    const rejected = expect(old).rejects.toMatchObject({ name: 'AbortError' })
    await ready
    const latest = c.conformTake('song', 'take', options)
    await rejected
    expect((await latest).cached).toBe(false); expect(jobs).toBe(2); expect(cancel).toHaveLength(1)
  })
  it('rejects aborted requests, traversal, symlinks and malformed parameters', async () => {
    const c = new VoiceTakeConformer(root, native)
    for (const id of ['../x', '/tmp', '', 'x/y', 'x\\y']) await expect(c.conformTake('song', id, options)).rejects.toThrow('id')
    await expect(c.conformTake('song', 'take', { ...options, outputRate: NaN })).rejects.toThrow('rate')
    const controller = new AbortController(); controller.abort()
    await expect(c.conformTake('song', 'take', { ...options, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toHaveLength(0)
  })
  // Creating a symlink needs a privilege a non-admin Windows user lacks (EPERM). Probed once; only THIS assertion is
  // skipped, with the reason in the test's name — every other rejection above still runs there.
  it.skipIf(!CAN_SYMLINK)(`rejects a symlinked take file${CAN_SYMLINK ? '' : ' [SKIPPED: this account may not create symlinks (EPERM) — e.g. non-admin Windows]'}`, async () => {
    const c = new VoiceTakeConformer(root, native)
    await rename(join(root, 'song', 'take.wav'), join(root, 'song', 'real.wav'))
    await symlink(join(root, 'song', 'real.wav'), join(root, 'song', 'take.wav'))
    await expect(c.conformTake('song', 'take', options)).rejects.toThrow('file')
    expect(calls).toHaveLength(0)
  })
})

describe('conform timeline inputs', () => {
  it.each([1, 1.125, 1.4])('uses the shared legacy walk for a wall-clock change at %s past the WAV end', atSec => {
    const s = side(); delete s.anchors
    s.durationSec = 99 // Stale sidecar duration must not override the WAV extent.
    s.settings = [{ atSec: 0, tempo: .5, transposeSemitones: 2 },
      { atSec: .5, tempo: 1.5, transposeSemitones: -2 }, { atSec, tempo: 2, transposeSemitones: 7 }]
    const shared = resolveVoiceTakeTimeline({ ...s, durationSec: 1 })
    const request = prepareConformRequest(s, 8000, options)
    expect(request.anchors).toEqual(shared.anchors)
    expect(request.settings).toEqual(shared.settings.map(point => ({ takeFrame: Math.round(point.atSec * 8000), transposeSemitones: point.transposeSemitones })))
    expect(request.settings).toEqual([{ takeFrame: 0, transposeSemitones: 2 }, { takeFrame: 4000, transposeSemitones: -2 }])
    // Negative control: the duplicated validator rejected these valid legacy files.
    const oldValidator = () => { if (s.settings.some(point => point.atSec > 1)) throw new Error('Invalid take settings point') }
    if (atSec > 1) expect(oldValidator).toThrow('Invalid take settings point')
  })
  it('integrates legacy settings and extrapolates a missing terminal anchor', () => {
    const s = side(); delete s.anchors
    s.settings = [{ atSec: 0, tempo: 0.5, transposeSemitones: 2 }, { atSec: 0.5, tempo: 1.5, transposeSemitones: -2 }]
    expect(prepareConformRequest(s, 8000, options).anchors).toEqual([
      { takeFrame: 0, projectFrame: 0 }, { takeFrame: 4000, projectFrame: 2000 }, { takeFrame: 8000, projectFrame: 8000 }
    ])
    s.anchors = [{ takeFrame: 0, projectFrame: 800 }, { takeFrame: 4000, projectFrame: 2800 }]
    expect(prepareConformRequest(s, 8000, options).anchors.at(-1)).toEqual({ takeFrame: 8000, projectFrame: 4800 })
  })
  it('rejects nonfinite, unordered, out-of-bounds maps and unknown FX', () => {
    for (const anchors of [[{ takeFrame: 0, projectFrame: NaN }], [{ takeFrame: 1, projectFrame: 0 }],
      [{ takeFrame: 0, projectFrame: 0 }, { takeFrame: 8001, projectFrame: 8001 }],
      [{ takeFrame: 0, projectFrame: 0 }, { takeFrame: 4000, projectFrame: 2000 }, { takeFrame: 3000, projectFrame: 3000 }]]) {
      expect(() => prepareConformRequest({ ...side(), anchors }, 8000, options)).toThrow()
    }
    expect(() => prepareConformRequest(side(), 8000, { ...options, effects: [{ id: 'unknown' } as never] })).toThrow('effects')
    expect(() => prepareConformRequest({ ...side(), startPositionSec: Infinity }, 8000, options)).toThrow('placement')
  })
})
