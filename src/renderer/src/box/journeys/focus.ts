export function findJourneyFocus(scope: HTMLElement, visible: boolean): HTMLElement | null {
  if (!visible) return null
  const dialog = scope.querySelector<HTMLElement>('[role="dialog"]')
  if (dialog) return dialog.querySelector<HTMLElement>('[data-journey-confirm-cancel]:not(:disabled)')
  return scope.querySelector<HTMLElement>('.journey-page-layer [data-journey-primary]:not(:disabled)') ??
    scope.querySelector<HTMLElement>('.journey-page-layer [data-journey-back]:not(:disabled)')
}

/** Retry acquisition after asynchronous readiness, but preserve an existing remote choice. */
export function journeyNeedsFocus(active: Element | null, body: HTMLElement, revisionChanged: boolean): boolean {
  if (revisionChanged || active === null || active === body) return true
  return !active.isConnected || active.getClientRects().length === 0 ||
    active.closest('[hidden], [inert]') !== null || active.matches(':disabled')
}

export function acquireJourneyFocus(
  scope: HTMLElement,
  active: Element | null,
  body: HTMLElement,
  revision: number,
  acquiredRevision: number | null,
  opener: Element | null = null
): number | null {
  if (!journeyNeedsFocus(active, body, acquiredRevision !== revision)) return acquiredRevision
  const dialog = scope.querySelector('[role="dialog"]')
  if (!dialog && scope.querySelector('[data-setup-stage="boot"]') &&
    !scope.querySelector('[data-journey-primary]:not(:disabled)')) return acquiredRevision
  // A closed confirmation returns to the control that opened it while that control is still usable.
  const returnTarget = !dialog && opener && scope.contains(opener) && !journeyNeedsFocus(opener, body, false)
    ? opener as HTMLElement : null
  const target = returnTarget ?? findJourneyFocus(scope, true)
  if (!target) return acquiredRevision
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  return revision
}
