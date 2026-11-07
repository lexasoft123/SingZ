import type { BoxControllerCommand, BoxControllerSnapshot, BoxQueueRef } from '../../../../shared/box-contract'
import { sanitizeSongVolume, SONG_VOLUME_MAX_DB } from '../../audio/song-volume'
import type { BoxTransportSnapshot } from '../transport'
import { entriesWithQueueRefs, projectQueue, queueRefKey } from './queue'
import { localEntryId, type CollectionEntry, type CollectionInspectionRow } from './types'

const MASTER_GAIN_MAX = 10 ** (SONG_VOLUME_MAX_DB / 20)
const STEM_LABELS: Record<string, string> = {
  vocals: 'Vocals', leadVocal: 'Lead vocal', backingVocals: 'Backing vocals',
  drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Piano', other: 'Other'
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, finite(value, minimum)))
}

function publicText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512)
}

export function sanitizeControllerCommand(command: BoxControllerCommand, duration = Number.POSITIVE_INFINITY): BoxControllerCommand | null {
  switch (command.type) {
    case 'play-pause': return command
    case 'seek':
      return Number.isFinite(command.position) && command.position >= 0
        ? { type: 'seek', position: Math.min(command.position, Math.max(0, finite(duration, 0))) }
        : null
    case 'volume':
      return typeof command.target === 'string' && command.target.length > 0 && Number.isFinite(command.value)
        ? { type: 'volume', target: command.target, value: clamp(command.value, 0, command.target === 'master' ? MASTER_GAIN_MAX : 1) }
        : null
    case 'mute':
    case 'solo':
      return typeof command.target === 'string' && command.target.length > 0 && typeof command.value === 'boolean'
        ? { type: command.type, target: command.target, value: command.value }
        : null
    case 'select':
    case 'queue-add':
      return typeof command.projectId === 'string' && command.projectId.length > 0 ? command : null
    case 'queue-remove':
      return typeof command.entryId === 'string' && command.entryId.length > 0 ? command : null
    case 'queue-move':
      return typeof command.entryId === 'string' && (command.delta === -1 || command.delta === 1) ? command : null
  }
}

export class BoxPhoneProjection {
  private nextProjectId = 1
  private nextQueueId = 1
  private nextStemId = 1
  private projectIds = new Map<string, string>()
  private queueIds = new Map<string, string>()
  private stemScope: string | null = null
  private stemIds = new Map<string, string>()

  update(refs: BoxQueueRef[], regenerateQueueIds = false): void {
    if (regenerateQueueIds) this.queueIds = new Map()
    const active = new Set(refs.map(queueRefKey))
    for (const key of this.queueIds.keys()) if (!active.has(key)) this.queueIds.delete(key)
    for (const key of active) {
      if (!this.queueIds.has(key)) this.queueIds.set(key, `queue-${this.nextQueueId++}`)
    }
  }

  private projectId(key: string): string {
    let id = this.projectIds.get(key)
    if (!id) {
      id = `song-${this.nextProjectId++}`
      this.projectIds.set(key, id)
    }
    return id
  }

  projectForId(entries: CollectionEntry[], refs: BoxQueueRef[], id: string): CollectionEntry | null {
    return entriesWithQueueRefs(entries, refs).find(entry => this.projectIds.get(entry.id) === id) ?? null
  }

  queueRefForId(refs: BoxQueueRef[], entryId: string): BoxQueueRef | null {
    return refs.find(ref => this.queueIds.get(queueRefKey(ref)) === entryId) ?? null
  }

  private updateStemScope(scope: string | null): void {
    if (scope === this.stemScope) return
    this.stemScope = scope
    this.stemIds = new Map()
  }

  stemTarget(activeLocalDir: string | null, target: string): string | null {
    if (target === 'master') return target
    this.updateStemScope(activeLocalDir)
    for (const [internal, publicId] of this.stemIds) if (publicId === target) return internal
    return null
  }

  snapshot(
    entries: CollectionEntry[],
    refs: BoxQueueRef[],
    rows: Record<string, CollectionInspectionRow>,
    transport: BoxTransportSnapshot
  ): BoxControllerSnapshot {
    const withUnresolved = entriesWithQueueRefs(entries, refs)
    const activeEntry = transport.active
      ? withUnresolved.find(entry => entry.local?.dir === transport.active?.item.dir || entry.id === localEntryId(transport.active!.item.dir))
      : null
    this.updateStemScope(transport.active?.item.dir ?? null)
    const queuedEntries = projectQueue(withUnresolved, refs).slice(0, 512)
    const required = new Set(queuedEntries.map(item => item.entry.id))
    if (activeEntry) required.add(activeEntry.id)
    const visibleEntries = withUnresolved.filter(entry => required.has(entry.id))
    for (const entry of withUnresolved) {
      if (visibleEntries.length >= 2000) break
      if (!required.has(entry.id)) visibleEntries.push(entry)
    }
    const songs = visibleEntries.map(entry => ({
      id: this.projectId(entry.id),
      title: publicText(entry.name),
      artist: '',
      ready: entry.local !== null && rows[entry.id]?.inspection?.readiness === 'ready'
    }))
    const queue = queuedEntries.map(({ ref, entry }) => ({
      entryId: this.queueIds.get(queueRefKey(ref)) ?? '',
      projectId: this.projectId(entry.id),
      title: publicText(entry.name),
      artist: ''
    })).filter(entry => entry.entryId)
    const stems = transport.tracks.slice(0, 32).map(track => {
      let id = this.stemIds.get(track.id)
      if (!id) {
        id = `stem-${this.nextStemId++}`
        this.stemIds.set(track.id, id)
      }
      return {
        id,
        label: STEM_LABELS[track.id] ?? 'Track',
        volume: clamp(track.volume, 0, 1),
        muted: track.muted === true,
        solo: track.solo === true
      }
    })
    return {
      activeProjectId: activeEntry ? this.projectId(activeEntry.id) : null,
      transport: {
        playing: transport.playing === true,
        position: clamp(transport.position, 0, Math.max(0, finite(transport.duration, 0))),
        duration: Math.max(0, finite(transport.duration, 0)),
        masterVolume: sanitizeSongVolume(transport.masterVolume)
      },
      songs,
      queue,
      stems
    }
  }
}
