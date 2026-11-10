import type { BoxQueueRef } from '../../../shared/box-contract'
import type { ProjectListItem } from '../../../shared/types'
import { moveQueueViewDir, projectQueue } from './collection/queue'
import type { CollectionEntry } from './collection/types'

export function queueAdd(items: ProjectListItem[], item: ProjectListItem): ProjectListItem[] {
  return items.some(queued => queued.dir === item.dir) ? items : [...items, item]
}

export function queueRemove(items: ProjectListItem[], dir: string): {
  items: ProjectListItem[]
  focus: string | null
} {
  const index = items.findIndex(item => item.dir === dir)
  if (index < 0) return { items, focus: null }
  const next = items.filter(item => item.dir !== dir)
  return { items: next, focus: next[Math.min(index, next.length - 1)]?.dir ?? null }
}

export function queueMove(items: ProjectListItem[], dir: string, delta: number): ProjectListItem[] {
  const from = items.findIndex(item => item.dir === dir)
  const to = from + delta
  if (from < 0 || to < 0 || to >= items.length) return items
  const next = [...items]
  ;[next[from], next[to]] = [next[to], next[from]]
  return next
}

export function queueHas(items: ProjectListItem[], dir: string): boolean {
  return items.some(item => item.dir === dir)
}

/** Phone queue moves address a visible (de-duplicated) row by its ref. Move it
 * through the same projection the phone sees, so hidden duplicate refs cannot
 * turn a visible move into a no-op swap. */
export function moveQueueRefInView(entries: CollectionEntry[], refs: BoxQueueRef[], ref: BoxQueueRef, delta: number): BoxQueueRef[] {
  const row = projectQueue(entries, refs).find(item => item.ref === ref)
  return row ? moveQueueViewDir(entries, refs, row.item.dir, delta) : refs
}
