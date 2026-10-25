import { NativeModules } from 'react-native'
import { sanitizeSongVolume } from '../../../src/shared/song-volume'
import { getStoredText, setStoredText } from '../latency'
import { mutateProjectDocument, type ProjectDocumentApi } from '../project-document'
import type { ProjectDoc } from '../model'
import type { MetronomeProjectRef } from './metronome-persistence'

export const SONG_VOLUME_KEY = 'singz.song-volume.v1'
interface Entry { gain: number; at: number; sourceGain?: number | null }
interface Store { version: 1; entries: Record<string, Entry> }
interface Api extends ProjectDocumentApi {
  getPreference(key: string): Promise<string | null>
  setPreference(key: string, value: string): Promise<void>
}
const folder = NativeModules.FolderAccess as ProjectDocumentApi
const defaultApi: Api = {
  readText: (dir, file) => folder.readText(dir, file),
  writeText: (dir, file, text) => folder.writeText(dir, file, text),
  getPreference: getStoredText, setPreference: setStoredText
}

/** Read-only libraries use account/root-scoped local preferences until their
 * source gain changes. A new desktop value takes precedence. Phone
 * projects journal first, then merge only masterVolume through the shared
 * project writer. A kill or a failed write leaves the journal recoverable. */
export class SongVolumePersistence {
  private tail: Promise<void> = Promise.resolve()
  private sourceGains = new Map<string, number | null>()
  constructor(private readonly api: Api = defaultApi) {}
  private async key(ref: MetronomeProjectRef): Promise<string> {
    if ((ref.source === 'readonly' && ref.dir !== 'bundled-sample') ||
        (ref.source === 'picked' && !ref.root))
      throw new Error('The source folder for this song could not be identified.')
    const owner = ref.source === 'gdrive'
      ? (await this.api.getPreference('singz.gdrive.email'))?.trim().toLowerCase()
      : ref.root ?? ''
    if (ref.source === 'gdrive' && !owner) throw new Error('The Drive account for this song is unavailable.')
    return JSON.stringify([ref.source, owner, ref.dir])
  }
  private async store(): Promise<Store> {
    const text = await this.api.getPreference(SONG_VOLUME_KEY)
    if (text === null || text === '') return { version: 1, entries: {} }
    if (text.length > 64 * 1024) throw new Error('Saved song output preferences are too large.')
    const raw = JSON.parse(text) as Store
    if (raw.version !== 1 || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries))
      throw new Error('Saved song output preferences need a newer app.')
    for (const row of Object.values(raw.entries)) {
      if (!row || !Number.isFinite(row.gain) || row.gain < 0 || row.gain > 4 || !Number.isFinite(row.at) || (row.sourceGain !== undefined && row.sourceGain !== null && (!Number.isFinite(row.sourceGain) || row.sourceGain < 0 || row.sourceGain > 4)))
        throw new Error('Saved song output preferences could not be read.')
    }
    return raw
  }
  private async write(store: Store): Promise<void> {
    const keys = Object.keys(store.entries).sort((a, b) => store.entries[a].at - store.entries[b].at)
    while (keys.length > 512 || JSON.stringify(store).length > 64 * 1024) {
      const index = keys.findIndex(key => JSON.parse(key)[0] !== 'phone')
      const key = index >= 0 ? keys.splice(index, 1)[0] : undefined
      if (!key) throw new Error('Song output preference is too large.')
      delete store.entries[key]
    }
    await this.retry(() => this.api.setPreference(SONG_VOLUME_KEY, JSON.stringify(store)))
  }
  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let last: unknown
    for (let i = 0; i < 3; i++) {
      try { return await operation() } catch (error) { last = error }
      if (i < 2) await new Promise(resolve => setTimeout(resolve, i === 0 ? 15 : 75))
    }
    throw last
  }
  async resolve(ref: MetronomeProjectRef, fallback: ProjectDoc): Promise<ProjectDoc> {
    await this.tail
    let gain = sanitizeSongVolume(fallback.settings?.masterVolume)
    if (ref.source === 'phone') {
      try {
        const current = JSON.parse(await this.api.readText(ref.dir, 'project.json')) as ProjectDoc
        gain = sanitizeSongVolume(current.settings?.masterVolume)
      } catch { /* Keep the catalog copy when the file is temporarily unavailable. */ }
    }
    try {
      const key = await this.key(ref)
      const sourceGain = typeof fallback.settings?.masterVolume === 'number' && Number.isFinite(fallback.settings.masterVolume)
        ? sanitizeSongVolume(fallback.settings.masterVolume) : null
      this.sourceGains.set(key, sourceGain)
      const row = (await this.store()).entries[key]
      if (row) {
        // A new desktop gain supersedes a phone override. Legacy overrides
        // have no baseline: an explicit synced gain wins those on upgrade.
        const changed = ref.source !== 'phone' && (row.sourceGain === undefined
          ? sourceGain !== null : row.sourceGain !== sourceGain)
        if (changed) this.discard(key, row)
        else {
          gain = sanitizeSongVolume(row.gain)
          if (ref.source === 'phone') void this.save(ref, gain).catch(() => undefined)
        }
      }
    } catch { /* An unknown preference never prevents song playback. */ }
    return { ...fallback, settings: { ...fallback.settings, masterVolume: gain } }
  }
  private discard(key: string, old: Entry): void {
    const operation = this.tail.then(async () => {
      const store = await this.store()
      const current = store.entries[key]
      if (current?.at === old.at && current.gain === old.gain && current.sourceGain === old.sourceGain) {
        delete store.entries[key]
        await this.write(store)
      }
    })
    this.tail = operation.catch(() => undefined)
  }
  save(ref: MetronomeProjectRef, value: number): Promise<void> {
    const gain = sanitizeSongVolume(value)
    const identity = this.key(ref).then(key => ({ key }), error => ({ error }))
    const operation = this.tail.then(async () => {
      const resolved = await identity
      if ('error' in resolved) throw resolved.error
      const key = resolved.key
      const store = await this.store()
      store.entries[key] = { gain, at: Date.now(), sourceGain: this.sourceGains.get(key) }
      await this.write(store)
      if (ref.source === 'phone') {
        await this.retry(() => mutateProjectDocument(ref.dir, current => ({
          ...current, settings: { ...current.settings, masterVolume: gain }
        }), this.api))
        delete store.entries[key]
        await this.write(store)
      }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
}
export const mobileSongVolumePersistence = new SongVolumePersistence()
