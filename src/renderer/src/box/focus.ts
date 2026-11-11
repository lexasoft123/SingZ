export type RemoteDirection = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'

export function remoteScope(root: HTMLElement): HTMLElement {
  const visible = (element: HTMLElement): boolean =>
    element.getClientRects().length > 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]')
  const dialogs = Array.from(root.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-surface], [role="dialog"] [data-surface]'
  )).filter(visible)
  if (dialogs.length > 0) return dialogs[dialogs.length - 1]
  const mixers = Array.from(root.querySelectorAll<HTMLElement>('[data-surface="mix"]')).filter(visible)
  return mixers[mixers.length - 1] ?? root
}

export function remoteTargets(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input[type="range"]:not(:disabled), [data-remote-focus]'
  )).filter(element =>
    !element.matches(':disabled') && element.getClientRects().length > 0 && !element.closest('[inert]')
  )
}

function moveMixerChannelFocus(scope: HTMLElement, direction: 'ArrowUp' | 'ArrowDown'): boolean {
  const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-mix-row]'))
  const channels = rows.flatMap(row => {
    const level = remoteTargets(row).find(target => target.matches('input[type="range"]'))
    return level ? [{ row, level }] : []
  })
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const currentRow = active?.closest('[data-mix-row]')
  const current = channels.findIndex(channel => channel.row === currentRow)
  let target: HTMLElement | null | undefined
  if (!currentRow) {
    if (direction === 'ArrowDown') target = channels[0]?.level
  } else if (current < 0) {
    const rowIndex = rows.indexOf(currentRow as HTMLElement)
    const ordered = direction === 'ArrowDown' ? channels : [...channels].reverse()
    target = ordered.find(channel => {
      const index = rows.indexOf(channel.row)
      return direction === 'ArrowDown' ? index > rowIndex : index < rowIndex
    })?.level
  } else if (direction === 'ArrowDown') {
    target = channels[current + 1]?.level
  } else if (current === 0) {
    target = scope.querySelector<HTMLElement>('.mode-seg button[aria-pressed="true"]')
  } else {
    target = channels[current - 1]?.level
  }
  if (target) {
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return true
}

/** Nearest target in `direction`, scored like a TV remote: distance along the
 * key's axis plus a heavy penalty for drifting off it. */
function nearestInDirection(active: HTMLElement, targets: HTMLElement[], direction: RemoteDirection): HTMLElement | null {
  const from = active.getBoundingClientRect()
  const x = from.left + from.width / 2
  const y = from.top + from.height / 2
  let best: { element: HTMLElement; score: number } | null = null
  for (const element of targets) {
    if (element === active) continue
    const rect = element.getBoundingClientRect()
    const dx = rect.left + rect.width / 2 - x
    const dy = rect.top + rect.height / 2 - y
    const primary = direction === 'ArrowLeft' ? -dx : direction === 'ArrowRight' ? dx : direction === 'ArrowUp' ? -dy : dy
    if (primary <= 2) continue
    const orthogonal = direction === 'ArrowLeft' || direction === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx)
    const score = primary + orthogonal * 4
    if (!best || score < best.score) best = { element, score }
  }
  return best?.element ?? null
}

/** Explicit vertical exits. A container marked `data-remote-down="<selector>"`
 * (or `data-remote-up`) keeps Up/Down inside itself; at its edge focus goes to
 * the declared targets: the first enabled one going Down, the nearest going Up.
 * Geometry alone cannot express this for a narrow control row under a wide
 * list, where a page-level button farther away is better aligned. */
const EXIT_ATTRIBUTE: Partial<Record<RemoteDirection, string>> = { ArrowDown: 'data-remote-down', ArrowUp: 'data-remote-up' }
function explicitExit(scope: HTMLElement, active: HTMLElement, targets: HTMLElement[], direction: RemoteDirection): HTMLElement | null {
  const attribute = EXIT_ATTRIBUTE[direction]
  const group = attribute ? active.closest<HTMLElement>(`[${attribute}]`) : null
  const selector = group?.getAttribute(attribute!)
  if (!group || !selector || !scope.contains(group)) return null
  const local = nearestInDirection(active, targets.filter(target => group.contains(target)), direction)
  if (local) return local
  const exits = targets.filter(target => target !== active && !group.contains(target) && target.matches(selector))
  return direction === 'ArrowDown' ? exits[0] ?? null : nearestInDirection(active, exits, direction) ?? exits[exits.length - 1] ?? null
}

/** Explicit horizontal hand-over between a list and its side rail. A container
 * marked `data-remote-right="<selector>"` (or `data-remote-left`) sends Right
 * (Left) to the matching target — the one flagged `data-current="true"` when
 * there is one — instead of the geometrically nearest control, which for a
 * long list would be whichever rail letter happens to sit beside the row. */
const SIDE_ATTRIBUTE: Partial<Record<RemoteDirection, string>> = { ArrowRight: 'data-remote-right', ArrowLeft: 'data-remote-left' }
export function sideExit(scope: HTMLElement, active: HTMLElement, targets: HTMLElement[], direction: RemoteDirection): HTMLElement | null {
  const attribute = SIDE_ATTRIBUTE[direction]
  const group = attribute ? active.closest<HTMLElement>(`[${attribute}]`) : null
  const selector = group?.getAttribute(attribute!)
  if (!group || !selector || !scope.contains(group)) return null
  const candidates = targets.filter(target => target !== active && !group.contains(target) && target.matches(selector))
  return candidates.find(target => target.dataset.current === 'true') ?? candidates[0] ?? null
}

export function moveSpatialFocus(scope: HTMLElement, direction: RemoteDirection): boolean {
  if (scope.dataset.surface === 'mix' && (direction === 'ArrowUp' || direction === 'ArrowDown')) {
    return moveMixerChannelFocus(scope, direction)
  }
  const targets = remoteTargets(scope)
  if (targets.length === 0) return false
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!active || !targets.includes(active)) {
    targets[0].focus()
    targets[0].scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return true
  }
  const next = sideExit(scope, active, targets, direction) ?? explicitExit(scope, active, targets, direction) ?? nearestInDirection(active, targets, direction)
  if (!next) return false
  next.focus({ preventScroll: true })
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return true
}

/** A remote-pressed control that disables itself (Start → Stop analysis) must
 * not drop focus to <body>. Returns the replacement inside `group`: the
 * enabled target whose `data-remote-id` equals its `data-remote-counterpart`, else the nearest
 * enabled target in the group; null when focus already moved elsewhere or
 * nothing in the group is enabled yet (the caller retries on a later render). */
export function disabledFocusReplacement(group: HTMLElement, last: HTMLElement | null): HTMLElement | null {
  if (!last || !group.contains(last) || !last.matches(':disabled')) return null
  const active = document.activeElement
  if (active && active !== last && active !== document.body) return null
  const targets = remoteTargets(group).filter(target => target !== last)
  const id = last.getAttribute('data-remote-counterpart')
  const counterpart = id ? targets.find(target => target.getAttribute('data-remote-id') === id) : undefined
  if (counterpart) return counterpart
  const from = last.getBoundingClientRect()
  let best: { element: HTMLElement; distance: number } | null = null
  for (const element of targets) {
    const rect = element.getBoundingClientRect()
    const distance = Math.abs(rect.left + rect.width / 2 - (from.left + from.width / 2)) + Math.abs(rect.top + rect.height / 2 - (from.top + from.height / 2))
    if (!best || distance < best.distance) best = { element, distance }
  }
  return best?.element ?? null
}
