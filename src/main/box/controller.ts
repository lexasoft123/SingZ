import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type {
  BoxControllerCommand,
  BoxControllerEnvelope,
  BoxControllerResponse,
  BoxControllerSnapshot,
  BoxResult
} from '../../shared/box-contract'
import type { BoxCacheGuard } from './storage'
import { SONG_VOLUME_MAX_DB } from '../../shared/song-volume'

const MAX_SONGS = 2000
const MAX_QUEUE = 512
const MAX_STEMS = 32
const MAX_SECONDS = 24 * 60 * 60
const MASTER_VOLUME_MAX = 10 ** (SONG_VOLUME_MAX_DB / 20)
const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
const text = (value: unknown, maximum = 512, allowEmpty = true): value is string =>
  typeof value === 'string' && value.length <= maximum && (allowEmpty || value.length > 0) &&
  !/[\u0000-\u001f\u007f]/.test(value)
const opaqueId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
const finite = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
const localDir = (value: unknown): value is string | null =>
  value === null || (text(value, 4096, false) && isAbsolute(value))
const copySnapshot = (snapshot: BoxControllerSnapshot): BoxControllerSnapshot => ({
  activeProjectId: snapshot.activeProjectId,
  transport: { ...snapshot.transport },
  songs: snapshot.songs.map((song) => ({ ...song })),
  queue: snapshot.queue.map((entry) => ({ ...entry })),
  stems: snapshot.stems.map((stem) => ({ ...stem }))
})

type Published = {
  snapshot: BoxControllerSnapshot
  activeLocalProjectDir: string | null
  openingLocalProjectDir: string | null
}

type PendingCommand = {
  timer: ReturnType<typeof setTimeout>
  expiresAt: number
  ownerEpoch: number
  stillValid: () => boolean
  resolve: (response: BoxControllerResponse) => void
}

type BoxControllerOptions = {
  commandTimeoutMs?: number
  snapshotMaxAgeMs?: number
  now?: () => number
}

export class BoxControllerHub implements BoxCacheGuard {
  private published: Published | null = null
  private publishedAt = 0
  private sender: ((envelope: BoxControllerEnvelope) => void) | null = null
  private ownerEpoch = 0
  private readonly pending = new Map<string, PendingCommand>()
  private removal: { token: number; dir: string } | null = null
  private nextRemovalToken = 1
  private disposed = false
  private readonly commandTimeoutMs: number
  private readonly snapshotMaxAgeMs: number
  private readonly now: () => number

  constructor(options: BoxControllerOptions = {}) {
    this.commandTimeoutMs = Math.max(250, Math.min(15_000, options.commandTimeoutMs ?? 10_000))
    this.snapshotMaxAgeMs = options.snapshotMaxAgeMs ?? 5000
    this.now = options.now ?? Date.now
  }

  setCommandSender(sender: ((envelope: BoxControllerEnvelope) => void) | null): void {
    if (sender === null) this.ownerEpoch++
    this.sender = sender
  }

  snapshot(): BoxControllerSnapshot | null {
    return this.freshSender() && this.published ? copySnapshot(this.published.snapshot) : null
  }

  guardedLocalDirs(): { active: string | null; opening: string | null } {
    return {
      active: this.published?.activeLocalProjectDir ?? null,
      opening: this.published?.openingLocalProjectDir ?? null
    }
  }

  publish(raw: unknown): BoxResult<null> {
    if (this.disposed) return failure('Box controller is disposed.', 'disposed')
    const parsed = parsePublish(raw)
    if (!parsed) return failure('Controller snapshot failed schema validation.', 'invalid-snapshot')
    if (this.removal && [parsed.activeLocalProjectDir, parsed.openingLocalProjectDir].includes(this.removal.dir)) {
      return failure('Cannot open a cached project while it is being removed.', 'project-busy')
    }
    this.published = parsed
    this.publishedAt = this.now()
    return { ok: true, value: null }
  }

  beginCacheRemoval(rawDir: string): BoxResult<number> {
    if (this.disposed) return failure('Box controller is disposed.', 'disposed')
    if (!this.published) return failure('No authoritative controller snapshot has been published.', 'guard-uninitialized')
    if (this.removal) return failure('Another cached project is already being removed.', 'cache-busy')
    const dir = resolve(rawDir)
    const { active, opening } = this.guardedLocalDirs()
    if (dir === active || dir === opening) {
      return failure('The cached project is active or opening.', 'project-active')
    }
    const token = this.nextRemovalToken++
    this.removal = { token, dir }
    return { ok: true, value: token }
  }

  endCacheRemoval(token: number): void {
    if (this.removal?.token === token) this.removal = null
  }

  private freshSender(): boolean {
    const age = this.now() - this.publishedAt
    return !this.disposed && this.sender !== null && this.published !== null && age >= 0 && age <= this.snapshotMaxAgeMs
  }

  isCommandActive(id: string): boolean {
    const pending = this.pending.get(id)
    return Boolean(pending && pending.ownerEpoch === this.ownerEpoch && pending.expiresAt > this.now() &&
      pending.stillValid() && this.freshSender())
  }

  async execute(raw: unknown, stillValid: () => boolean = () => true): Promise<BoxControllerResponse> {
    if (!this.freshSender() || !this.published) return { ok: false, error: 'TV controller is unavailable or stale.' }
    const command = validCommand(raw, this.published.snapshot)
    if (!command) return { ok: false, error: 'Controller command is invalid or refers to a stale item.' }
    if (!stillValid()) return { ok: false, error: 'Phone session is no longer authorized.' }
    const ownerEpoch = this.ownerEpoch
    const id = randomUUID()
    const response = new Promise<BoxControllerResponse>((resolve) => {
      const expiresAt = this.now() + this.commandTimeoutMs
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'Command timed out; it may already have run. Check the TV before retrying.' })
      }, this.commandTimeoutMs)
      timer.unref()
      this.pending.set(id, { timer, expiresAt, ownerEpoch, stillValid, resolve })
    })
    try {
      this.sender?.({ id, command })
    } catch {
      const pending = this.pending.get(id)
      if (pending) {
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.resolve({ ok: false, error: 'TV controller could not receive the command.' })
      }
    }
    const result = await response
    if (!stillValid() || ownerEpoch !== this.ownerEpoch) {
      return { ok: false, error: 'Phone authorization or TV owner changed; the command may already have run.' }
    }
    return result
  }

  respond(rawId: unknown, rawResult: unknown): BoxResult<null> {
    if (typeof rawId !== 'string' || !record(rawResult) || !Object.hasOwn(rawResult, 'ok') ||
      Object.keys(rawResult).some((key) => key !== 'ok' && key !== 'error') || typeof rawResult.ok !== 'boolean' ||
      (rawResult.error !== undefined && !text(rawResult.error, 512))) {
      return failure('Invalid controller response.', 'invalid-input')
    }
    const pending = this.pending.get(rawId)
    if (!pending) return failure('Unknown or expired controller command.', 'unknown-command')
    this.pending.delete(rawId)
    clearTimeout(pending.timer)
    if (pending.ownerEpoch !== this.ownerEpoch || pending.expiresAt <= this.now() ||
      !pending.stillValid() || !this.freshSender()) {
      pending.resolve({ ok: false, error: 'Command is no longer active; it may already have run. Check the TV before retrying.' })
      return failure('Controller command is no longer active.', 'stale-command')
    }
    pending.resolve(rawResult.ok
      ? { ok: true }
      : { ok: false, error: typeof rawResult.error === 'string' && rawResult.error ? rawResult.error : 'TV controller rejected the command.' })
    return { ok: true, value: null }
  }

  dispose(): void {
    this.disposed = true
    this.sender = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, error: 'TV controller is shutting down.' })
    }
    this.pending.clear()
    this.published = null
    this.removal = null
  }
}

function parsePublish(raw: unknown): Published | null {
  if (!record(raw)) return null
  const keys = ['activeProjectId', 'transport', 'songs', 'queue', 'stems', 'activeLocalProjectDir', 'openingLocalProjectDir']
  if (Object.keys(raw).some((key) => !keys.includes(key)) || !Object.hasOwn(raw, 'activeLocalProjectDir')) return null
  const activeLocalProjectDir = raw.activeLocalProjectDir
  const openingLocalProjectDir = raw.openingLocalProjectDir ?? null
  if (!localDir(activeLocalProjectDir) || !localDir(openingLocalProjectDir)) return null
  if (!(raw.activeProjectId === null || opaqueId(raw.activeProjectId)) || !record(raw.transport) ||
    !exactKeys(raw.transport, ['playing', 'position', 'duration', 'masterVolume'])) return null
  const transport = raw.transport
  if (typeof transport.playing !== 'boolean' || !finite(transport.position, 0, MAX_SECONDS) ||
    !finite(transport.duration, 0, MAX_SECONDS) || !finite(transport.masterVolume, 0, MASTER_VOLUME_MAX)) return null
  if (!Array.isArray(raw.songs) || raw.songs.length > MAX_SONGS ||
    !Array.isArray(raw.queue) || raw.queue.length > MAX_QUEUE ||
    !Array.isArray(raw.stems) || raw.stems.length > MAX_STEMS) return null
  const songs: BoxControllerSnapshot['songs'] = []
  const songIds = new Set<string>()
  for (const song of raw.songs) {
    if (!record(song) || !exactKeys(song, ['id', 'title', 'artist', 'ready']) || !opaqueId(song.id) ||
      songIds.has(song.id) || !text(song.title) || !text(song.artist) || typeof song.ready !== 'boolean') return null
    songIds.add(song.id)
    songs.push({ id: song.id, title: song.title, artist: song.artist, ready: song.ready })
  }
  if (raw.activeProjectId !== null && !songIds.has(raw.activeProjectId)) return null
  const queue: BoxControllerSnapshot['queue'] = []
  const entryIds = new Set<string>()
  for (const entry of raw.queue) {
    if (!record(entry) || !exactKeys(entry, ['entryId', 'projectId', 'title', 'artist']) ||
      !opaqueId(entry.entryId) || entryIds.has(entry.entryId) || !opaqueId(entry.projectId) ||
      !songIds.has(entry.projectId) || !text(entry.title) || !text(entry.artist)) return null
    entryIds.add(entry.entryId)
    queue.push({ entryId: entry.entryId, projectId: entry.projectId, title: entry.title, artist: entry.artist })
  }
  const stems: BoxControllerSnapshot['stems'] = []
  const stemIds = new Set<string>()
  for (const stem of raw.stems) {
    if (!record(stem) || !exactKeys(stem, ['id', 'label', 'volume', 'muted', 'solo']) ||
      !opaqueId(stem.id) || stemIds.has(stem.id) || !text(stem.label, 512, false) ||
      !finite(stem.volume, 0, 1) || typeof stem.muted !== 'boolean' || typeof stem.solo !== 'boolean') return null
    stemIds.add(stem.id)
    stems.push({ id: stem.id, label: stem.label, volume: stem.volume, muted: stem.muted, solo: stem.solo })
  }
  return {
    snapshot: {
      activeProjectId: raw.activeProjectId,
      transport: {
        playing: transport.playing,
        position: transport.position,
        duration: transport.duration,
        masterVolume: transport.masterVolume
      },
      songs,
      queue,
      stems
    },
    activeLocalProjectDir: activeLocalProjectDir === null ? null : resolve(activeLocalProjectDir),
    openingLocalProjectDir: openingLocalProjectDir === null ? null : resolve(openingLocalProjectDir)
  }
}

function validCommand(raw: unknown, snapshot: BoxControllerSnapshot): BoxControllerCommand | null {
  if (!record(raw) || typeof raw.type !== 'string') return null
  switch (raw.type) {
    case 'play-pause':
      return exactKeys(raw, ['type']) && snapshot.activeProjectId !== null ? { type: 'play-pause' } : null
    case 'seek':
      return exactKeys(raw, ['type', 'position']) && finite(raw.position, 0, snapshot.transport.duration)
        ? { type: 'seek', position: raw.position }
        : null
    case 'volume': {
      if (!exactKeys(raw, ['type', 'target', 'value']) || !opaqueId(raw.target)) return null
      const maximum = raw.target === 'master' ? MASTER_VOLUME_MAX : 1
      if (!finite(raw.value, 0, maximum)) return null
      return raw.target === 'master' || snapshot.stems.some((stem) => stem.id === raw.target)
        ? { type: 'volume', target: raw.target, value: raw.value }
        : null
    }
    case 'mute':
    case 'solo':
      return exactKeys(raw, ['type', 'target', 'value']) && opaqueId(raw.target) &&
        snapshot.stems.some((stem) => stem.id === raw.target) && typeof raw.value === 'boolean'
        ? { type: raw.type, target: raw.target, value: raw.value }
        : null
    case 'select':
    case 'queue-add':
      return exactKeys(raw, ['type', 'projectId']) && opaqueId(raw.projectId) &&
        snapshot.songs.some((song) => song.id === raw.projectId)
        ? { type: raw.type, projectId: raw.projectId }
        : null
    case 'queue-remove':
      return exactKeys(raw, ['type', 'entryId']) && opaqueId(raw.entryId) &&
        snapshot.queue.some((entry) => entry.entryId === raw.entryId)
        ? { type: 'queue-remove', entryId: raw.entryId }
        : null
    case 'queue-move':
      return exactKeys(raw, ['type', 'entryId', 'delta']) && opaqueId(raw.entryId) &&
        snapshot.queue.some((entry) => entry.entryId === raw.entryId) && (raw.delta === -1 || raw.delta === 1)
        ? { type: 'queue-move', entryId: raw.entryId, delta: raw.delta }
        : null
    default:
      return null
  }
}
