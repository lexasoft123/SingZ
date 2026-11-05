import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LANE_MEASURE_CACHE_VERSION,
  describeLaneMeasureBatch,
  LaneMeasureCache,
  type LaneMeasureCacheBatch
} from '../../src/main/lane-measure-cache'
import type {
  DesktopPlaybackLaneMeasure,
  DesktopPlaybackLaneMeasureRequest,
  DesktopPlaybackLaneMeasureResult
} from '../../src/shared/types'

const POLICY = { peaksPerSecond: 1000, minimumPeaks: 1, maximumPeaks: 1000 }
type Policy = typeof POLICY

function measurement(
  id: string,
  policy: Policy = POLICY,
  over: Partial<DesktopPlaybackLaneMeasure> = {}
): DesktopPlaybackLaneMeasure {
  const durationSeconds = 0.01
  const peakCount = Math.min(
    policy.maximumPeaks,
    Math.max(policy.minimumPeaks, Math.round(durationSeconds * policy.peaksPerSecond))
  )
  const peaks = Float32Array.from({ length: peakCount }, (_, index) => Math.fround(index / 17))
  peaks[0] = -0
  if (peaks.length > 1) peaks[1] = Math.fround(0.1)
  if (peaks.length > 2) new Uint32Array(peaks.buffer)[2] = 1
  const envelope = new Float32Array(96).fill(0.25)
  envelope[0] = -0
  return {
    id,
    ok: true,
    error: 'ok',
    sampleRate: 8000,
    channels: 2,
    frameCount: 80,
    durationSeconds,
    rms: Math.fround(0.2),
    peaks,
    envelope,
    ...over
  }
}

function success(request: DesktopPlaybackLaneMeasureRequest): DesktopPlaybackLaneMeasureResult {
  return {
    ok: true,
    error: '',
    lanes: request.lanes.map(lane => measurement(lane.id, request))
  }
}

function failure(id: string, error: string): DesktopPlaybackLaneMeasure {
  return {
    id,
    ok: false,
    error,
    sampleRate: 0,
    channels: 0,
    frameCount: 0,
    durationSeconds: 0,
    rms: 0,
    peaks: new Float32Array(0),
    envelope: new Float32Array(0)
  }
}

function nativeSuccess() {
  return vi.fn(async (request: DesktopPlaybackLaneMeasureRequest) => success(request))
}

function floatBits(values: Float32Array): Uint32Array {
  return new Uint32Array(values.buffer, values.byteOffset, values.length)
}

async function cacheFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(name => /^[0-9a-f]{64}$/.test(name))
  } catch {
    return []
  }
}

async function onlyCacheFile(dir: string): Promise<string> {
  const files = await cacheFiles(dir)
  expect(files).toHaveLength(1)
  return join(dir, files[0])
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('persistent lane measurement cache', () => {
  let dir = ''
  let cacheDir = ''
  let source = ''

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'singz-lane-measure-'))
    cacheDir = join(dir, 'cache')
    source = join(dir, 'a.flac')
    await writeFile(source, 'aaaa')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function request(
    lanes: { id: string; path: string }[] = [{ id: 'a', path: source }],
    policy: Policy = POLICY
  ): DesktopPlaybackLaneMeasureRequest {
    return { lanes, ...policy }
  }

  it('skips native on a repeated call and preserves every value and Float32 bit', async () => {
    const native = nativeSuccess()
    const batches: LaneMeasureCacheBatch[] = []
    const cache = new LaneMeasureCache({
      cacheDir,
      measure: native,
      onBatch: batch => batches.push(batch)
    })
    const first = await cache.measurePlaybackLanes(request())
    const second = await cache.measurePlaybackLanes(request())
    expect(native).toHaveBeenCalledTimes(1)
    expect(second.ok).toBe(true)
    expect(second.lanes[0]).toMatchObject({
      id: 'a',
      sampleRate: first.lanes[0].sampleRate,
      channels: first.lanes[0].channels,
      frameCount: first.lanes[0].frameCount,
      durationSeconds: first.lanes[0].durationSeconds,
      rms: first.lanes[0].rms
    })
    expect(floatBits(second.lanes[0].peaks)).toEqual(floatBits(first.lanes[0].peaks))
    expect(floatBits(second.lanes[0].envelope)).toEqual(floatBits(first.lanes[0].envelope))
    expect(Object.is(second.lanes[0].peaks[0], -0)).toBe(true)
    expect(batches.map(({ hits, misses }) => ({ hits, misses }))).toEqual([
      { hits: 0, misses: 1 },
      { hits: 1, misses: 0 }
    ])
    expect(batches.every(batch => Number.isFinite(batch.elapsedMs) && batch.elapsedMs >= 0)).toBe(true)
    // The second request reads statistics without a native measurement. Its
    // log must not describe that cache reuse as newly measured audio, and the
    // duration is the whole request (miss work and persistence included).
    expect(describeLaneMeasureBatch(batches[0])).toMatch(/^waveform request · disk cache 0 hits · 1 misses · \d+ ms total$/)
    expect(describeLaneMeasureBatch(batches[1])).toMatch(/^waveform request · disk cache 1 hits · 0 misses · \d+ ms total$/)
    expect(describeLaneMeasureBatch(batches[1])).not.toContain('measured')
  })

  it('a new cache instance reads the persisted result after a restart', async () => {
    const firstNative = nativeSuccess()
    await new LaneMeasureCache({ cacheDir, measure: firstNative }).measurePlaybackLanes(request())
    const restartedNative = nativeSuccess()
    const restarted = new LaneMeasureCache({ cacheDir, measure: restartedNative })
    const result = await restarted.measurePlaybackLanes(request([{ id: 'different-id', path: source }]))
    expect(restartedNative).not.toHaveBeenCalled()
    expect(result.lanes[0].id).toBe('different-id')
    expect(floatBits(result.lanes[0].peaks)).toEqual(floatBits(measurement('unused').peaks))
    expect(floatBits(result.lanes[0].envelope)).toEqual(floatBits(measurement('unused').envelope))
  })

  it('negative control: a no-cache passthrough measures the repeated call again', async () => {
    const native = nativeSuccess()
    const withoutCache = (value: DesktopPlaybackLaneMeasureRequest) => native(value)
    await withoutCache(request())
    await withoutCache(request())
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('rewrites and replacements miss even with the same size and restored mtime', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const before = await stat(source)
    await new Promise(resolve => setTimeout(resolve, 20))
    await writeFile(source, 'bbbb')
    await utimes(source, before.atime, before.mtime)
    await cache.measurePlaybackLanes(request())
    expect(native).toHaveBeenCalledTimes(2)

    const rewritten = await stat(source)
    const replacement = join(dir, 'replacement.flac')
    await writeFile(replacement, 'cccc')
    await utimes(replacement, rewritten.atime, rewritten.mtime)
    await rename(replacement, source)
    await cache.measurePlaybackLanes(request())
    expect(native).toHaveBeenCalledTimes(3)
  })

  it('different peak policies use different entries without invalidating the old policy', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const otherPolicy = { ...POLICY, peaksPerSecond: 2000 }
    const other = await cache.measurePlaybackLanes(request(undefined, otherPolicy))
    expect(other.lanes[0].peaks).toHaveLength(20)
    expect(native).toHaveBeenCalledTimes(2)
    await cache.measurePlaybackLanes(request())
    expect(native).toHaveBeenCalledTimes(2)
    expect(await cacheFiles(cacheDir)).toHaveLength(2)
  })

  it.each(['version', 'policy'])('a persisted %s mismatch is a miss, not a failure', async kind => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const file = await onlyCacheFile(cacheDir)
    const bytes = await readFile(file)
    const headerBytes = bytes.readUInt32LE(8)
    const header = JSON.parse(bytes.subarray(12, 12 + headerBytes).toString('utf8'))
    if (kind === 'version') header.version = LANE_MEASURE_CACHE_VERSION + 1
    else header.peaksPerSecond = POLICY.peaksPerSecond + 1
    const replacement = Buffer.from(JSON.stringify(header), 'utf8')
    replacement.copy(bytes, 12)
    await writeFile(file, bytes)
    const result = await cache.measurePlaybackLanes(request())
    expect(result.ok).toBe(true)
    expect(native).toHaveBeenCalledTimes(2)
  })

  it.each(['corrupt', 'truncated', 'oversized'])('%s cache data falls back to native', async kind => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const file = await onlyCacheFile(cacheDir)
    if (kind === 'corrupt') {
      const bytes = await readFile(file)
      bytes[bytes.length - 1] ^= 1
      await writeFile(file, bytes)
    } else if (kind === 'truncated') {
      await writeFile(file, (await readFile(file)).subarray(0, 19))
    } else {
      await truncate(file, 5 * 1024 * 1024)
    }
    const result = await cache.measurePlaybackLanes(request())
    expect(result.ok).toBe(true)
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('rejects non-finite samples even when the payload checksum was repaired', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const file = await onlyCacheFile(cacheDir)
    const bytes = await readFile(file)
    const headerBytes = bytes.readUInt32LE(8)
    const payload = bytes.subarray(12 + headerBytes)
    payload.writeUInt32LE(0x7fc00000, 32)
    const header = JSON.parse(bytes.subarray(12, 12 + headerBytes).toString('utf8'))
    header.sha256 = createHash('sha256').update(payload).digest('hex')
    Buffer.from(JSON.stringify(header), 'utf8').copy(bytes, 12)
    await writeFile(file, bytes)
    const result = await cache.measurePlaybackLanes(request())
    expect(result.ok).toBe(true)
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('measures only misses and restores request order and current lane IDs', async () => {
    const other = join(dir, 'b.flac')
    const added = join(dir, 'c.flac')
    await writeFile(other, 'bbbb')
    await writeFile(added, 'cccc')
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request([
      { id: 'old-a', path: source },
      { id: 'old-b', path: other }
    ]))
    const cachedPeaks = floatBits(measurement('old-a').peaks).slice()
    await writeFile(other, 'bbbb changed')

    const mixed = await cache.measurePlaybackLanes(request([
      { id: 'new-c', path: added },
      { id: 'new-a', path: source },
      { id: 'new-b', path: other }
    ]))
    expect(native).toHaveBeenCalledTimes(2)
    expect(native.mock.calls[1][0].lanes).toEqual([
      { id: 'new-c', path: added },
      { id: 'new-b', path: other }
    ])
    expect(mixed.lanes.map(lane => lane.id)).toEqual(['new-c', 'new-a', 'new-b'])
    expect(floatBits(mixed.lanes[1].peaks)).toEqual(cachedPeaks)
    await cache.measurePlaybackLanes(request([
      { id: 'again-b', path: other },
      { id: 'again-a', path: source },
      { id: 'again-c', path: added }
    ]))
    expect(native).toHaveBeenCalledTimes(2)
  })

  it.each(['missing', 'result-failure', 'lane-failure', 'cancelled', 'throw'])(
    '%s measurements are not cached',
    async kind => {
      const path = kind === 'missing' ? join(dir, 'missing.flac') : source
      const native = vi.fn(async (value: DesktopPlaybackLaneMeasureRequest): Promise<DesktopPlaybackLaneMeasureResult> => {
        if (kind === 'throw') throw new Error('native unavailable')
        if (kind === 'result-failure') return { ok: false, error: 'refused', lanes: [] }
        if (kind === 'lane-failure' || kind === 'cancelled' || kind === 'missing') {
          return {
            ok: true,
            error: '',
            lanes: [failure(value.lanes[0].id, kind === 'cancelled' ? 'cancelled' : 'io-error')]
          }
        }
        return success(value)
      })
      const cache = new LaneMeasureCache({ cacheDir, measure: native })
      const first = await cache.measurePlaybackLanes(request([{ id: 'a', path }]))
      const second = await cache.measurePlaybackLanes(request([{ id: 'a', path }]))
      expect(native).toHaveBeenCalledTimes(2)
      expect(first.ok).toBe(kind !== 'result-failure' && kind !== 'throw')
      expect(second.ok).toBe(first.ok)
      expect(await cacheFiles(cacheDir)).toHaveLength(0)
    }
  )

  it('a source changed during native measurement is refused and not persisted', async () => {
    const entered = deferred()
    const release = deferred()
    const native = vi.fn(async (value: DesktopPlaybackLaneMeasureRequest) => {
      entered.resolve()
      await release.promise
      return success(value)
    })
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    const pending = cache.measurePlaybackLanes(request())
    await entered.promise
    const before = await stat(source)
    await writeFile(source, 'bbbb')
    await utimes(source, before.atime, before.mtime)
    release.resolve()
    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.lanes).toHaveLength(1)
    expect(result.lanes[0]).toMatchObject({
      id: 'a',
      ok: false,
      error: 'source-changed',
      sampleRate: 0,
      channels: 0,
      frameCount: 0,
      durationSeconds: 0,
      rms: 0
    })
    expect(result.lanes[0].peaks).toHaveLength(0)
    expect(result.lanes[0].envelope).toHaveLength(0)
    expect(await cacheFiles(cacheDir)).toHaveLength(0)

    const nextNative = nativeSuccess()
    const next = new LaneMeasureCache({ cacheDir, measure: nextNative })
    const unchanged = await next.measurePlaybackLanes(request())
    expect(nextNative).toHaveBeenCalledTimes(1)
    expect(unchanged.lanes[0]).toMatchObject({ ok: true, error: 'ok' })
  })

  it('a changed miss does not suppress a healthy cache hit', async () => {
    const other = join(dir, 'b.flac')
    await writeFile(other, 'bbbb')
    const entered = deferred()
    const release = deferred()
    const native = vi.fn(async (value: DesktopPlaybackLaneMeasureRequest) => {
      if (value.lanes[0].id === 'changing') {
        entered.resolve()
        await release.promise
      }
      return success(value)
    })
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    const seeded = await cache.measurePlaybackLanes(request([{ id: 'healthy', path: source }]))
    const pending = cache.measurePlaybackLanes(request([
      { id: 'healthy', path: source },
      { id: 'changing', path: other }
    ]))
    await entered.promise
    await writeFile(other, 'bbbb changed')
    release.resolve()

    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.lanes.map(lane => lane.id)).toEqual(['healthy', 'changing'])
    expect(result.lanes[0]).toMatchObject({ ok: true, error: 'ok' })
    expect(floatBits(result.lanes[0].peaks)).toEqual(floatBits(seeded.lanes[0].peaks))
    expect(result.lanes[1]).toMatchObject({ ok: false, error: 'source-changed' })
    expect(result.lanes[1].peaks).toHaveLength(0)
    expect(result.lanes[1].envelope).toHaveLength(0)
    expect(native).toHaveBeenCalledTimes(2)
    expect(native.mock.calls[1][0].lanes).toEqual([{ id: 'changing', path: other }])
    expect(await cacheFiles(cacheDir)).toHaveLength(1)
  })

  it('a disk hit changed during another lane miss is refused while the miss survives', async () => {
    const other = join(dir, 'b.flac')
    await writeFile(other, 'bbbb')
    const entered = deferred()
    const release = deferred()
    const native = vi.fn(async (value: DesktopPlaybackLaneMeasureRequest) => {
      if (value.lanes.some(lane => lane.id === 'miss')) {
        entered.resolve()
        await release.promise
      }
      return success(value)
    })
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request([{ id: 'hit', path: source }]))
    const pending = cache.measurePlaybackLanes(request([
      { id: 'hit', path: source },
      { id: 'miss', path: other }
    ]))
    await entered.promise
    await writeFile(source, 'changed cached source while another lane measures')
    release.resolve()

    const result = await pending
    expect(result.ok).toBe(true)
    expect(result.lanes.map(lane => lane.id)).toEqual(['hit', 'miss'])
    expect(result.lanes[0]).toMatchObject({ ok: false, error: 'source-changed' })
    expect(result.lanes[0].peaks).toHaveLength(0)
    expect(result.lanes[0].envelope).toHaveLength(0)
    expect(result.lanes[1]).toMatchObject({ ok: true, error: 'ok' })
    expect(native).toHaveBeenCalledTimes(2)
    expect(native.mock.calls[1][0].lanes).toEqual([{ id: 'miss', path: other }])
  })

  it('a newer cache hit supersedes an older native call without publishing or caching it', async () => {
    const seedNative = nativeSuccess()
    await new LaneMeasureCache({ cacheDir, measure: seedNative }).measurePlaybackLanes(request())
    const other = join(dir, 'b.flac')
    await writeFile(other, 'bbbb')
    const entered = deferred()
    const release = deferred()
    const native = vi.fn(async (value: DesktopPlaybackLaneMeasureRequest) => {
      entered.resolve()
      await release.promise
      return success(value)
    })
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    const older = cache.measurePlaybackLanes(request([{ id: 'old-b', path: other }]))
    await entered.promise
    const newest = await cache.measurePlaybackLanes(request([{ id: 'new-a', path: source }]))
    expect(newest.ok).toBe(true)
    expect(newest.lanes.map(lane => lane.id)).toEqual(['new-a'])
    expect(native).toHaveBeenCalledTimes(1)
    release.resolve()
    const oldResult = await older
    expect(oldResult.ok).toBe(true)
    expect(oldResult.lanes).toHaveLength(1)
    expect(oldResult.lanes[0]).toMatchObject({ id: 'old-b', ok: false, error: 'cancelled' })
    expect(oldResult.lanes[0].peaks).toHaveLength(0)

    await cache.measurePlaybackLanes(request([{ id: 'next-b', path: other }]))
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('cache read and write failures still return real measurements', async () => {
    const blocked = join(dir, 'not-a-directory')
    await writeFile(blocked, 'file')
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir: blocked, measure: native })
    expect((await cache.measurePlaybackLanes(request())).ok).toBe(true)
    expect((await cache.measurePlaybackLanes(request())).ok).toBe(true)
    expect(native).toHaveBeenCalledTimes(2)
  })

  it('byte-budget pruning removes only owned cache names', async () => {
    await mkdir(cacheDir, { recursive: true })
    const oldest = join(cacheDir, '0'.repeat(64))
    const newer = join(cacheDir, '1'.repeat(64))
    const foreign = join(cacheDir, 'foreign.json')
    await writeFile(oldest, '')
    await writeFile(newer, '')
    await truncate(oldest, 140 * 1024 * 1024)
    await truncate(newer, 140 * 1024 * 1024)
    await writeFile(foreign, 'do not touch')
    const now = Date.now() / 1000
    await utimes(oldest, now - 7200, now - 7200)
    await utimes(newer, now - 3600, now - 3600)
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    expect((await cache.measurePlaybackLanes(request())).ok).toBe(true)
    await expect(stat(oldest)).rejects.toThrow()
    expect((await stat(newer)).size).toBe(140 * 1024 * 1024)
    expect(await readFile(foreign, 'utf8')).toBe('do not touch')
    const names = await cacheFiles(cacheDir)
    const sizes = await Promise.all(names.map(async name => (await stat(join(cacheDir, name))).size))
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(256 * 1024 * 1024)
  })

  it.each(['', 'a\0b', 'é'.repeat(49)])('refuses a native-invalid ID even on a cache hit: %j', async id => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    native.mockClear()
    const result = await cache.measurePlaybackLanes(request([{ id, path: source }]))
    expect(result.ok).toBe(false)
    expect(result.lanes).toEqual([])
    expect(native).not.toHaveBeenCalled()
  })

  it('accepts a Unicode lane ID at the native UTF-8 byte limit', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    native.mockClear()
    const id = 'é'.repeat(48)
    const result = await cache.measurePlaybackLanes(request([{ id, path: source }]))
    expect(result.ok).toBe(true)
    expect(result.lanes[0].id).toBe(id)
    expect(native).not.toHaveBeenCalled()
  })

  it.each(['', 'bad\0path', 'é'.repeat(16385)])('refuses native-invalid paths before measuring', async path => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    expect((await cache.measurePlaybackLanes(request([{ id: 'a', path }]))).ok).toBe(false)
    expect(native).not.toHaveBeenCalled()
  })

  it('duplicate IDs are refused even when both lanes could hit the cache', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request([{ id: 'duplicate', path: source }]))
    native.mockClear()
    const result = await cache.measurePlaybackLanes(request([
      { id: 'duplicate', path: source },
      { id: 'duplicate', path: source }
    ]))
    expect(result.ok).toBe(false)
    expect(result.lanes).toEqual([])
    expect(native).not.toHaveBeenCalled()
  })

  it('retains trusted seeds from final measurements and restart disk hits without payload reads', async () => {
    const firstNative = nativeSuccess()
    const first = new LaneMeasureCache({ cacheDir, measure: firstNative })
    await first.measurePlaybackLanes(request())
    const expected = await first.waveformSeedForPath(source)
    expect(expected).toMatchObject({
      version: 1,
      policy: 'singz.native.streaming-envelope.rms96-v1'
    })
    expect(expected?.contentKey).toMatch(/^measure:[0-9a-f]{64}$/)
    expect(expected?.peaks).toHaveLength(96)

    const restartedNative = nativeSuccess()
    const restarted = new LaneMeasureCache({ cacheDir, measure: restartedNative })
    await restarted.measurePlaybackLanes(request())
    expect(restartedNative).not.toHaveBeenCalled()
    await rm(await onlyCacheFile(cacheDir))
    expect(await restarted.waveformSeedForPath(source)).toEqual(expected)
    expect(restartedNative).not.toHaveBeenCalled()
  })

  it('read-only lookup returns no seed for missing or stale sources and never measures', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    expect(await cache.waveformSeedForPath(source)).toBeNull()
    expect(await cache.waveformSeedForPath(join(dir, 'missing.flac'))).toBeNull()
    expect(native).not.toHaveBeenCalled()
    expect(await cacheFiles(cacheDir)).toHaveLength(0)

    await cache.measurePlaybackLanes(request())
    const before = await stat(source)
    await writeFile(source, 'bbbb')
    await utimes(source, before.atime, before.mtime)
    expect(await cache.waveformSeedForPath(source)).toBeNull()
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('binds seed identity to measurement policy and returns defensive copies', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const initial = await cache.waveformSeedForPath(source)
    expect(initial).not.toBeNull()
    initial!.peaks[0] = 0.75
    expect((await cache.waveformSeedForPath(source))!.peaks[0]).not.toBe(0.75)

    const otherPolicy = { ...POLICY, peaksPerSecond: 2000 }
    await cache.measurePlaybackLanes(request(undefined, otherPolicy))
    const rebound = await cache.waveformSeedForPath(source)
    expect(rebound).toMatchObject({ version: 1, policy: 'singz.native.streaming-envelope.rms96-v1' })
    expect(rebound?.contentKey).not.toBe(initial?.contentKey)
  })

  it('excludes cancelled and invalid measurements but retains seeds when disk writes fail', async () => {
    const cancelled = new LaneMeasureCache({
      cacheDir,
      measure: async value => ({
        ok: true,
        error: '',
        lanes: value.lanes.map(lane => failure(lane.id, 'cancelled'))
      })
    })
    await cancelled.measurePlaybackLanes(request())
    expect(await cancelled.waveformSeedForPath(source)).toBeNull()

    const invalid = new LaneMeasureCache({
      cacheDir,
      measure: async value => ({
        ok: true,
        error: '',
        lanes: value.lanes.map(lane => measurement(lane.id, value, {
          envelope: new Float32Array(95)
        }))
      })
    })
    await invalid.measurePlaybackLanes(request())
    expect(await invalid.waveformSeedForPath(source)).toBeNull()

    const blocked = join(dir, 'not-a-directory')
    await writeFile(blocked, 'file')
    const native = nativeSuccess()
    const writableFailure = new LaneMeasureCache({ cacheDir: blocked, measure: native })
    await writableFailure.measurePlaybackLanes(request())
    expect(await writableFailure.waveformSeedForPath(source)).not.toBeNull()
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('bounds trusted seed memory to 64 recent source identities', async () => {
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    let first = ''
    let last = ''
    for (let index = 0; index < 65; ++index) {
      const path = join(dir, `${index}.flac`)
      if (index === 0) first = path
      last = path
      await writeFile(path, `lane-${index}`)
      await cache.measurePlaybackLanes(request([{ id: `lane-${index}`, path }]))
    }
    expect(await cache.waveformSeedForPath(first)).toBeNull()
    expect(await cache.waveformSeedForPath(last)).not.toBeNull()
    expect(native).toHaveBeenCalledTimes(65)
  })

  it('enriches only trusted seed hits and never measures a prepare miss', async () => {
    const other = join(dir, 'b.flac')
    await writeFile(other, 'bbbb')
    const native = nativeSuccess()
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    await cache.measurePlaybackLanes(request())
    const seed = await cache.waveformSeedForPath(source)
    const lanes = await cache.seedPlaybackLanes([
      { id: 'hit', path: source, gain: 1, muted: false, solo: false },
      { id: 'miss', path: other, gain: 0.5, muted: true, solo: false }
    ])
    expect(lanes[0]).toEqual({
      id: 'hit', path: source, gain: 1, muted: false, solo: false,
      sourceKey: seed?.contentKey,
      waveform: seed
    })
    expect(lanes[1]).toEqual({ id: 'miss', path: other, gain: 0.5, muted: true, solo: false })
    expect(native).toHaveBeenCalledTimes(1)
  })

  it('native results mapped to the wrong miss are refused and never cached', async () => {
    const native = vi.fn(async (value: DesktopPlaybackLaneMeasureRequest) => ({
      ok: true,
      error: '',
      lanes: value.lanes.map(lane => measurement(`wrong-${lane.id}`, value))
    }))
    const cache = new LaneMeasureCache({ cacheDir, measure: native })
    const result = await cache.measurePlaybackLanes(request())
    expect(result.ok).toBe(false)
    expect(result.lanes).toEqual([])
    expect(await cacheFiles(cacheDir)).toHaveLength(0)
  })
})
