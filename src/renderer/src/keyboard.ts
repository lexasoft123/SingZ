export const TRANSPORT_SHORTCUT_BLOCK_SELECTOR = [
  '[role="dialog"]',
  'button',
  'input',
  'select',
  'textarea',
  'a[href]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="slider"]'
].join(',')

/** Settings and focused controls own their native keyboard behavior. In
 * particular Space clicks the focused Start/Stop button once, while range
 * arrows adjust gain instead of leaking into song seek. */
export function blocksSongTransportShortcut(
  target: EventTarget | null,
  modalOpen = false
): boolean {
  if (modalOpen) return true
  const closest = (target as { closest?: (selector: string) => unknown } | null)?.closest
  return typeof closest === 'function' &&
    Boolean(closest.call(target, TRANSPORT_SHORTCUT_BLOCK_SELECTOR))
}
