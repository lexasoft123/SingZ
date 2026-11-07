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

export function moveSpatialFocus(scope: HTMLElement, direction: RemoteDirection): boolean {
  const targets = remoteTargets(scope)
  if (targets.length === 0) return false
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (!active || !targets.includes(active)) {
    targets[0].focus()
    targets[0].scrollIntoView({ block: 'nearest', inline: 'nearest' })
    return true
  }
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
  if (!best) return false
  best.element.focus({ preventScroll: true })
  best.element.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return true
}
