import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultVoiceTakeEffects, isVoiceTakeAnchors, isVoiceTakeEffects, resolveVoiceTakeTimeline, VOICE_TAKE_SIDECAR_VERSION, type VoiceTakeEffect, type VoiceTakeSidecar } from '../shared/voice-take'

export type ConformTakeErrorCode = 'take-too-long' | 'memory-budget' | 'conform-error' | 'cancelled'
export class ConformTakeError extends Error {
  constructor(public readonly code: ConformTakeErrorCode, public readonly detail: string) {
    super(detail)
    this.name = code === 'cancelled' ? 'AbortError' : 'ConformTakeError'
  }
}
export const isConformTakeError = (error: unknown): error is ConformTakeError => error instanceof ConformTakeError
const nativeErrorCode = (code: unknown): ConformTakeErrorCode =>
  code === 'take-too-long' || code === 'memory-budget' || code === 'cancelled' ? code : 'conform-error'

export const TAKE_CONFORM_VERSION = 'take-conform-2'
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_BYTES = 8 * 1024 * 1024 * 1024 // disk quota; no PCM is retained in memory
const MAX_TAKE_SECONDS = 4 * 60 * 60
const MAX_WAV_FRAMES = Math.floor((0xffffffff - 36) / 2)
const MAX_ENTRIES = 8
export interface TakeConformNativeRequest {
  anchors: { takeFrame: number; projectFrame: number }[]
  settings: { takeFrame: number; transposeSemitones: number }[]
  effects: VoiceTakeEffect[]
  songDurationProjectFrames: number
  startPositionSec: number
  userOffsetSec: number
  outputRate: number
}
export interface TakeConformNative {
  conformTake(input: string, output: string, request: TakeConformNativeRequest, job: string): Promise<{
    ok: boolean; error?: string; errorCode?: ConformTakeErrorCode; detail?: string; durationFrames: number; inputLatencyFrames?: number; outputLatencyFrames?: number
  }>
  cancelTakeConform(job: string): Promise<void> | void
}
export interface ConformedTake { path: string; key: string; durationFrames: number; placementFrame: number; cached: boolean }
export interface ConformTakeOptions {
  songDurationProjectFrames: number
  outputRate: number
  effects?: VoiceTakeEffect[]
  retain?: boolean
  signal?: AbortSignal
}
const finite = (n: number, bound: number): boolean => Number.isFinite(n) && Math.abs(n) <= bound
function check(condition: unknown, message: string, code: ConformTakeErrorCode = 'conform-error'): asserts condition { if (!condition) throw new ConformTakeError(code, message) }
const cancelled = (): ConformTakeError => new ConformTakeError('cancelled', 'Take conform cancelled')

/** Bounded cache beside the raw take. No PCM is copied over RPC. All file IO is
 * asynchronous and native DSP executes on a worker in the audio utility process.
 * One latest request per song; a replacement cancels and drains its predecessor.
 * A changed placement/sidecar/raw-file identity cannot reuse the old key.
 */
export class VoiceTakeConformer {
  private pins = new Map<string, number>()
  private retain(path: string): void { this.pins.set(path, (this.pins.get(path) ?? 0) + 1) }
  release(path: string): void {
    const count = this.pins.get(path) ?? 0
    if (count <= 1) this.pins.delete(path)
    else this.pins.set(path, count - 1)
  }
  private active = new Map<string, { job: string; stop: () => void; done: Promise<unknown> }>()
  constructor(private readonly rootDir: string, private readonly native: TakeConformNative,
    private readonly limits = { maxBytes: MAX_BYTES, maxEntries: MAX_ENTRIES }) {
    check(Number.isSafeInteger(limits.maxBytes) && limits.maxBytes >= 44 && limits.maxBytes <= MAX_BYTES &&
      Number.isSafeInteger(limits.maxEntries) && limits.maxEntries >= 1 && limits.maxEntries <= MAX_ENTRIES, 'Invalid conform cache limits')
  }

  async conformTake(songId: string, takeId: string, options: ConformTakeOptions): Promise<ConformedTake> {
    check(typeof songId === 'string' && typeof takeId === 'string' && ID.test(songId) && ID.test(takeId), 'Invalid take id')
    check(Number.isSafeInteger(options.outputRate) && options.outputRate >= 8000 && options.outputRate <= 192000 &&
      Number.isSafeInteger(options.songDurationProjectFrames) && options.songDurationProjectFrames >= 0 &&
      options.songDurationProjectFrames <= 36000 * options.outputRate, 'Invalid conform duration/rate')
    check(this.active.has(songId) || this.active.size < 4, 'Conform queue is full')
    const previous = this.active.get(songId)
    previous?.stop()
    let stopped = false
    const job = randomUUID()
    const stop = (): void => {
      stopped = true
      void Promise.resolve(this.native.cancelTakeConform(job)).catch(() => {})
    }
    const assertCurrent = (): void => { if (stopped || options.signal?.aborted) throw cancelled() }
    options.signal?.addEventListener('abort', stop, { once: true })
    let retainedPath: string | undefined
    const done = (async (): Promise<ConformedTake> => {
      await previous?.done.catch(() => {})
      assertCurrent()
      const dir = join(this.rootDir, songId), raw = join(dir, `${takeId}.wav`), sidecarPath = join(dir, `${takeId}.json`)
      // Refuse symlink traversal in every task-controlled path component. Root is
      // selected by main, never from renderer input.
      for (const path of [this.rootDir, dir]) check((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(), 'Invalid conform directory')
      const identity = async (): Promise<string> => {
        const s = await lstat(raw, { bigint: true })
        check(s.isFile() && !s.isSymbolicLink(), 'Invalid conform take file')
        check(s.size <= BigInt(0xffffffff + 8), 'Take file exceeds RIFF size bounds', 'memory-budget')
        return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':')
      }
      const before = await identity()
      const sideStat = await lstat(sidecarPath)
      check(sideStat.isFile() && !sideStat.isSymbolicLink() && sideStat.size <= 4 * 1024 * 1024, 'Invalid conform sidecar')
      const sideText = await readFile(sidecarPath, 'utf8')
      const sidecar = JSON.parse(sideText) as VoiceTakeSidecar
      check(sidecar.version === VOICE_TAKE_SIDECAR_VERSION && sidecar.takeId === takeId && sidecar.songId === songId &&
        sidecar.channels === 1 && sidecar.audio?.fileName === `${takeId}.wav` && sidecar.audio.format === 'wav-pcm16', 'Invalid conform sidecar identity')
      const file = await open(raw, 'r')
      const header = Buffer.alloc(44)
      try { check((await file.read(header, 0, 44, 0)).bytesRead === 44, 'Invalid take WAV') } finally { await file.close() }
      const frames = header.readUInt32LE(40) / 2, rate = header.readUInt32LE(24)
      check(Number.isInteger(frames) && rate === sidecar.sampleRate && rate >= 8000 && rate <= 192000 &&
        header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 16) === 'WAVEfmt ' &&
        header.readUInt16LE(20) === 1 && header.readUInt16LE(22) === 1 && header.readUInt16LE(34) === 16, 'Invalid take WAV')
      check(frames <= MAX_TAKE_SECONDS * rate, 'Take exceeds four-hour conform limit', 'take-too-long')
      const request = prepareConformRequest(sidecar, frames, options)
      const placement = (request.startPositionSec + request.userOffsetSec) * request.outputRate
      const placementFrame = placement < 0 ? -Math.round(-placement) : Math.round(placement)
      const key = createHash('sha256').update(JSON.stringify([TAKE_CONFORM_VERSION, before, request])).digest('hex')
      const cacheDir = join(dir, '.conform')
      try { await mkdir(cacheDir) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
      const cacheStat = await lstat(cacheDir)
      check(cacheStat.isDirectory() && !cacheStat.isSymbolicLink(), 'Invalid conform cache directory')
      const name = `${takeId}.conform-${key}.wav`, path = join(cacheDir, name)
      if (options.retain) { this.retain(path); retainedPath = path }
      await this.prune(dir, '', path)
      assertCurrent()
      try {
        const cache = await lstat(path)
        if (cache.isFile() && !cache.isSymbolicLink() && cache.size >= 44 && cache.size <= this.limits.maxBytes) {
          const h = Buffer.alloc(44), handle = await open(path, 'r')
          try { await handle.read(h, 0, 44, 0) } finally { await handle.close() }
          const durationFrames = h.readUInt32LE(40) / 2
          if (Number.isSafeInteger(durationFrames) && h.readUInt32LE(4) === cache.size - 8 && h.toString('ascii', 36, 40) === 'data' && h.toString('ascii', 0, 4) === 'RIFF' && h.toString('ascii', 8, 16) === 'WAVEfmt ' &&
            h.readUInt32LE(24) === options.outputRate && h.readUInt16LE(22) === 1 && h.readUInt16LE(34) === 16 &&
            durationFrames * 2 + 44 === cache.size && durationFrames <= options.songDurationProjectFrames && await identity() === before && await readFile(sidecarPath, 'utf8') === sideText) {
            await utimes(path, new Date(), new Date()); assertCurrent()
            return { path, key, durationFrames, placementFrame, cached: true }
          }
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      const signedRound = (n: number): number => n < 0 ? -Math.round(-n) : Math.round(n)
      const bodyFrames = Math.round((request.anchors.at(-1)!.projectFrame-request.anchors[0].projectFrame) * options.outputRate / rate)
      const duration = Math.max(0, Math.min(options.songDurationProjectFrames,
        signedRound((request.startPositionSec+request.userOffsetSec)*options.outputRate)+bodyFrames))
      // Windows keeps an open lane file undeletable. Reserve the replacement
      // before rendering; busy old files count against the hard cache bounds.
      check(duration <= MAX_WAV_FRAMES, 'Conform output exceeds RIFF bounds', 'memory-budget')
      await this.prune(dir, '', path, duration * 2 + 44)
      const temp = join(cacheDir, `${name}.${job}.tmp`)
      try {
        assertCurrent()
        const result = await this.native.conformTake(raw, temp, request, job)
        assertCurrent()
        if (!result.ok) throw new ConformTakeError(nativeErrorCode(result.errorCode), result.detail || result.error || 'Take conform failed')
        check(Number.isSafeInteger(result.durationFrames) && result.durationFrames >= 0 && result.durationFrames <= options.songDurationProjectFrames, 'Invalid conform result')
        check(await identity() === before && await readFile(sidecarPath, 'utf8') === sideText, 'Take changed during conform')
        const rendered = await lstat(temp)
        check(rendered.isFile() && !rendered.isSymbolicLink() && rendered.size === result.durationFrames * 2 + 44 && rendered.size <= this.limits.maxBytes, 'Invalid conform output')
        // Native closes/flushed the file before resolving. Atomic publication:
        // callers see a complete WAV or a miss, never a partially-written lane.
        const durable = await open(temp, 'r+')
        try { await durable.sync() } finally { await durable.close() }
        assertCurrent(); await rename(temp, path)
        await this.prune(dir, takeId, path)
        assertCurrent()
        return { path, key, durationFrames: result.durationFrames, placementFrame, cached: false }
      } finally { await rm(temp, { force: true }) }
    })()
    this.active.set(songId, { job, stop, done })
    try { return await done }
    catch (error) {
      if (retainedPath) this.release(retainedPath)
      if (isConformTakeError(error)) throw error
      throw new ConformTakeError('conform-error', error instanceof Error ? error.message : String(error))
    }
    finally {
      options.signal?.removeEventListener('abort', stop)
      if (this.active.get(songId)?.job === job) this.active.delete(songId)
    }
  }

  /** Call after deleting/moving a take when immediate reclamation is wanted;
   * every conform also scans/prunes stale entries, including deleted takes. */
  async invalidate(songId: string, takeId: string, options: { keepPath?: string; cancelActive?: boolean } = {}): Promise<void> {
    check(typeof songId === 'string' && typeof takeId === 'string' && ID.test(songId) && ID.test(takeId), 'Invalid take id')
    for (const path of [this.rootDir, join(this.rootDir, songId)]) check((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink(), 'Invalid conform directory')
    if (options.cancelActive !== false) {
      this.active.get(songId)?.stop()
      await this.active.get(songId)?.done.catch(() => {})
    }
    await this.prune(join(this.rootDir, songId), takeId, options.keepPath)
  }

  private async prune(dir: string, invalidateTake: string, keep?: string, reserveBytes = 0): Promise<void> {
    const remove = async (path: string): Promise<boolean> => {
      if (this.pins.has(path)) return false
      try { await rm(path, { force: true }); return true }
      catch (e) {
        if (['EBUSY', 'EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) return false
        throw e
      }
    }
    const rows: { path: string; bytes: number; mtime: number }[] = []
    const cacheDir = join(dir, '.conform')
    let names: string[]
    try {
      const cacheStat = await lstat(cacheDir)
      check(cacheStat.isDirectory() && !cacheStat.isSymbolicLink(), 'Invalid conform cache directory')
      names = await readdir(cacheDir)
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
    for (const name of names) {
      if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}\.conform-[a-f0-9]{64}\.wav\.[a-f0-9-]{36}\.tmp$/.test(name)) {
        const path = join(cacheDir, name), s = await lstat(path)
        if (Date.now() - s.mtimeMs > 600000) await remove(path)
        continue
      }
      const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\.conform-([a-f0-9]{64})\.wav$/.exec(name)
      if (!match) continue
      const path = join(cacheDir, name), s = await lstat(path)
      let rawExists = true
      try { rawExists = (await lstat(join(dir, `${match[1]}.wav`))).isFile() } catch { rawExists = false }
      if (!rawExists || (match[1] === invalidateTake && path !== keep) || !s.isFile() || s.isSymbolicLink()) { if (await remove(path)) continue }
      rows.push({ path, bytes: s.size, mtime: s.mtimeMs })
    }
    rows.sort((a, b) => Number(b.path === keep) - Number(a.path === keep) || b.mtime - a.mtime || a.path.localeCompare(b.path))
    let bytes = reserveBytes, entries = reserveBytes ? 1 : 0
    for (const row of rows) {
      if (reserveBytes && row.path === keep) continue // atomic replacement
      if ((entries + 1 > this.limits.maxEntries || bytes + row.bytes > this.limits.maxBytes) && await remove(row.path)) continue
      bytes += row.bytes; entries++
    }
    check(bytes <= this.limits.maxBytes && entries <= this.limits.maxEntries, 'Conform cache is full (lane files still in use)', 'memory-budget')
  }
}

/** Legacy settings are integrated only when anchors are absent. At present an
 * anchor map must span the take; extrapolation is bounded by the nearest slope
 * for older/partial additive sidecars which lack an endpoint. */
export function prepareConformRequest(sidecar: VoiceTakeSidecar, frames: number, options: ConformTakeOptions): TakeConformNativeRequest {
  const rate = sidecar.sampleRate
  check(finite(sidecar.startPositionSec, 36000) && finite(sidecar.userOffsetSec ?? 0, 36000), 'Invalid conform placement')
  // The WAV extent is authoritative for old wall-clock settings timelines.
  // Resolve anchors and pitch settings together so both use one clamping rule.
  const legacy = sidecar.anchors === undefined ? resolveVoiceTakeTimeline({ ...sidecar, durationSec: frames / rate }) : undefined
  check(Array.isArray(sidecar.settings) && sidecar.settings.length > 0 && sidecar.settings.length <= 20000, 'Invalid take settings')
  const settings = (legacy?.settings ?? sidecar.settings).map((s, i, all) => {
    check(finite(s.atSec, MAX_TAKE_SECONDS) && s.atSec >= 0 && (i ? s.atSec > all[i - 1].atSec : s.atSec === 0) &&
      s.atSec <= frames / rate && finite(s.tempo, 4) && s.tempo >= 0.25 && finite(s.transposeSemitones, 24), 'Invalid take settings point')
    return { takeFrame: Math.round(s.atSec * rate), transposeSemitones: s.transposeSemitones }
  })
  check(settings.every((s, i) => !i || s.takeFrame > settings[i - 1].takeFrame), 'Settings collapse to same sample')
  if (sidecar.anchors !== undefined) check(isVoiceTakeAnchors(sidecar.anchors), 'Invalid take anchors')
  const anchors = (legacy?.anchors ?? sidecar.anchors)?.map(a => ({ takeFrame: a.takeFrame, projectFrame: a.projectFrame }))
  if (anchors !== undefined) {
    check(anchors.length > 0 && anchors.length <= 20000, 'Invalid take anchors')
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i]
      check(Number.isSafeInteger(a.takeFrame) && a.takeFrame >= 0 && a.takeFrame <= frames && finite(a.projectFrame, 36000 * rate) &&
        (i ? a.takeFrame > anchors[i - 1].takeFrame && a.projectFrame > anchors[i - 1].projectFrame : a.takeFrame === 0), 'Invalid take anchor')
    }
    if (anchors.at(-1)!.takeFrame < frames) {
      const last = anchors.at(-1)!, prev = anchors.at(-2)
      const ratio = prev ? (last.projectFrame - prev.projectFrame) / (last.takeFrame - prev.takeFrame) : sidecar.settings[0].tempo
      anchors.push({ takeFrame: frames, projectFrame: last.projectFrame + (frames - last.takeFrame) * ratio })
    }
  }
  check(anchors && anchors.length >= 2 && anchors.length <= 20000, 'Empty take cannot be conformed')
  for (let i = 1; i < anchors.length; i++) {
    const ratio = (anchors[i].projectFrame - anchors[i - 1].projectFrame) / (anchors[i].takeFrame - anchors[i - 1].takeFrame)
    check(Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 5, 'Invalid take stretch ratio')
  }
  const effects = options.effects ?? sidecar.effects ?? defaultVoiceTakeEffects()
  check(isVoiceTakeEffects(effects), 'Invalid conform effects')
  return { anchors, settings, effects: effects.map(e => ({ ...e, params: { ...e.params } })), outputRate: options.outputRate, songDurationProjectFrames: options.songDurationProjectFrames,
    startPositionSec: sidecar.startPositionSec, userOffsetSec: sidecar.userOffsetSec ?? 0 }
}

let defaultConformer: Promise<VoiceTakeConformer> | undefined
function getDefaultConformer(): Promise<VoiceTakeConformer> {
  return defaultConformer ??= Promise.all([import('electron'), import('./audio-process')]).then(([{ app }, { desktopAudioProcess }]) =>
    new VoiceTakeConformer(join(app.getPath('userData'), 'voice-takes'), {
      conformTake: (...args) => desktopAudioProcess.call('binding', 'conformTake', args),
      cancelTakeConform: job => desktopAudioProcess.call<void>('binding', 'cancelTakeConform', [job])
    }))
}
/** Production entry point: the native binding lives exclusively in SingZ Audio. */
export async function conformTake(songId: string, takeId: string, options: ConformTakeOptions): Promise<ConformedTake> {
  return (await getDefaultConformer()).conformTake(songId, takeId, options)
}
export async function invalidateConformedTake(songId: string, takeId: string, options: { keepPath?: string; cancelActive?: boolean } = {}): Promise<void> {
  await (await getDefaultConformer()).invalidate(songId, takeId, options)
}
export async function releaseConformedTake(path: string): Promise<void> {
  (await getDefaultConformer()).release(path)
}
