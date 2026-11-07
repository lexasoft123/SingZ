import type { BoxAPI, BoxQueueRef, BoxState } from '../../../../shared/box-contract'
import type { ProjectListItem } from '../../../../shared/types'
import { collectionEntryByViewDir, driveEntryId, localEntryId, queueViewItem, type CollectionEntry } from './types'

export function queueRefKey(ref: BoxQueueRef): string {
  return ref.kind === 'local' ? localEntryId(ref.dir) : driveEntryId(ref.id)
}

export function queueRefForEntry(entry: CollectionEntry): BoxQueueRef | null {
  if (entry.remoteId) return { kind: 'drive', id: entry.remoteId }
  if (entry.local) return { kind: 'local', dir: entry.local.dir }
  return null
}

export function entryForQueueRef(entries: CollectionEntry[], ref: BoxQueueRef): CollectionEntry | null {
  if (ref.kind === 'local') {
    return entries.find(entry => entry.local?.dir === ref.dir || entry.id === localEntryId(ref.dir)) ?? null
  }
  return entries.find(entry => entry.remoteId === ref.id || entry.id === driveEntryId(ref.id)) ?? null
}

export function entriesWithQueueRefs(entries: CollectionEntry[], refs: BoxQueueRef[]): CollectionEntry[] {
  const next = [...entries]
  for (const ref of refs) {
    if (entryForQueueRef(next, ref)) continue
    next.push(ref.kind === 'local'
      ? { id: localEntryId(ref.dir), remoteId: null, name: 'Unavailable project', local: null, unavailable: true }
      : { id: driveEntryId(ref.id), remoteId: ref.id, name: 'Unavailable Drive project', local: null, unavailable: true })
  }
  return next
}

export interface QueueProjection {
  ref: BoxQueueRef
  entry: CollectionEntry
  item: ProjectListItem
}

export function projectQueue(entries: CollectionEntry[], refs: BoxQueueRef[]): QueueProjection[] {
  const withUnresolved = entriesWithQueueRefs(entries, refs)
  const result: QueueProjection[] = []
  const viewDirs = new Set<string>()
  for (const ref of refs) {
    const entry = entryForQueueRef(withUnresolved, ref)
    if (!entry) continue
    const item = queueViewItem(entry)
    if (viewDirs.has(item.dir)) continue
    viewDirs.add(item.dir)
    result.push({ ref, entry, item })
  }
  return result
}

export function queueHasEntry(entries: CollectionEntry[], refs: BoxQueueRef[], entry: CollectionEntry): boolean {
  return refs.some(ref => entryForQueueRef(entries, ref)?.id === entry.id)
}

export const BOX_QUEUE_LIMIT = 256

export function boxCloseWork(teardown: () => Promise<void>, flush: () => Promise<void>): Promise<void[]> {
  return Promise.all([teardown(), flush()])
}

export function addQueueEntry(entries: CollectionEntry[], refs: BoxQueueRef[], entry: CollectionEntry): BoxQueueRef[] {
  if (queueHasEntry(entries, refs, entry)) return refs
  if (refs.length >= BOX_QUEUE_LIMIT) return refs
  const ref = queueRefForEntry(entry)
  return ref ? [...refs, ref] : refs
}

export function removeQueueViewDir(entries: CollectionEntry[], refs: BoxQueueRef[], dir: string): {
  refs: BoxQueueRef[]
  focus: string | null
} {
  const projection = projectQueue(entries, refs)
  const index = projection.findIndex(item => item.item.dir === dir)
  if (index < 0) return { refs, focus: null }
  const target = projection[index]
  const next = refs.filter(ref => ref !== target.ref)
  const nextProjection = projectQueue(entries, next)
  return { refs: next, focus: nextProjection[Math.min(index, nextProjection.length - 1)]?.item.dir ?? null }
}

export function moveQueueViewDir(entries: CollectionEntry[], refs: BoxQueueRef[], dir: string, delta: number): BoxQueueRef[] {
  const projection = projectQueue(entries, refs)
  const from = projection.findIndex(item => item.item.dir === dir)
  const to = from + delta
  if (from < 0 || to < 0 || to >= projection.length) return refs
  const fromIndex = refs.indexOf(projection[from].ref)
  const toIndex = refs.indexOf(projection[to].ref)
  if (fromIndex < 0 || toIndex < 0) return refs
  const next = [...refs]
  ;[next[fromIndex], next[toIndex]] = [next[toIndex], next[fromIndex]]
  return next
}

export function queueEntryForViewDir(entries: CollectionEntry[], refs: BoxQueueRef[], dir: string): CollectionEntry | null {
  return projectQueue(entries, refs).find(item => item.item.dir === dir)?.entry ?? collectionEntryByViewDir(entries, dir)
}

export interface BoxQueueSnapshot {
  loading: boolean
  loaded: boolean
  saving: boolean
  error: string | null
}

export class BoxQueueStore {
  private refs: BoxQueueRef[] = []
  private hydration: Promise<BoxState | null> | null = null
  private saveTail: Promise<void> = Promise.resolve()
  private generation = 0
  private snapshot: BoxQueueSnapshot = { loading: false, loaded: false, saving: false, error: null }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly api: BoxAPI) {}

  getSnapshot = (): BoxQueueSnapshot => this.snapshot
  getRefs = (): BoxQueueRef[] => this.refs

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<BoxQueueSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  hydrate(): Promise<BoxState | null> {
    if (this.hydration) return this.hydration
    this.publish({ loading: true, loaded: false, error: null })
    this.hydration = (async () => {
      try {
        const result = await this.api.getState()
        if (!result.ok) {
          this.hydration = null
          this.publish({ loading: false, loaded: false, error: result.error })
          return null
        }
        this.refs = [...result.value.queue]
        this.publish({ loading: false, loaded: true, error: null })
        return result.value
      } catch (error) {
        this.hydration = null
        this.publish({ loading: false, loaded: false, error: error instanceof Error ? error.message : String(error) })
        return null
      }
    })()
    return this.hydration
  }

  commit(refs: BoxQueueRef[]): boolean {
    if (!this.snapshot.loaded) return false
    this.refs = [...refs]
    const generation = ++this.generation
    const queuedRefs = [...refs]
    this.publish({ saving: true, error: null })
    this.saveTail = this.saveTail.then(async () => {
      try {
        const result = await this.api.saveQueue(queuedRefs)
        if (generation !== this.generation) return
        this.publish({ saving: false, error: result.ok ? null : result.error })
      } catch (error) {
        if (generation !== this.generation) return
        this.publish({ saving: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
    return true
  }

  async flush(): Promise<void> {
    await this.saveTail
  }
}
