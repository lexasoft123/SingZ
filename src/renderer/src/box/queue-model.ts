import type { ProjectListItem } from '../../../shared/types'

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
