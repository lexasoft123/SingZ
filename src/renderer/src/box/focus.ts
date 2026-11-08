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
