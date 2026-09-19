/** Anything inside a dialog belongs to the dialog: its Start/Stop buttons
 * take Space and its gain sliders take the arrows. */
export const DIALOG_SELECTOR = '[role="dialog"]'

/** Controls a singer types into — a space there is a space. Every input
 * that is not a slider or an on/off control is text-like here: the bpm
 * fields, the track-name field, search boxes. */
export const TEXT_ENTRY_SELECTOR = [
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  'input:not([type="range"]):not([type="checkbox"]):not([type="radio"])' +
    ':not([type="button"]):not([type="submit"]):not([type="reset"])'
].join(',')

/** Sliders move their value with the arrows, so a focused fader keeps them
 * rather than having the song seek out from under it. Space they never use. */
export const SLIDER_SELECTOR = 'input[type="range"],[role="slider"]'

/** A button that keeps focus after a click would take Space as "press me
 * again" — and every mute, solo and toggle on the song screen keeps focus
 * after a click. Space is play/pause there, as it was before 2026-08-28,
 * when one rule started handing every focused button its native Space and
 * pressing Space after Mute began un-muting instead of pausing. */
export const ACTIVATABLE_SELECTOR =
  'button,[role="button"],a[href],input[type="checkbox"],input[type="radio"],' +
  'input[type="button"],input[type="submit"],input[type="reset"]'

type Closest = (selector: string) => unknown

function closestOf(target: EventTarget | null): Closest | null {
  const closest = (target as { closest?: Closest } | null)?.closest
  return typeof closest === 'function' ? (selector) => closest.call(target, selector) : null
}

/** Whether the focused control (or an open dialog) owns this key, so the
 * song transport must leave it alone. */
export function blocksSongTransportShortcut(
  target: EventTarget | null,
  code: string,
  modalOpen = false
): boolean {
  if (modalOpen) return true
  const closest = closestOf(target)
  if (!closest) return false
  if (closest(DIALOG_SELECTOR) || closest(TEXT_ENTRY_SELECTOR)) return true
  return (code === 'ArrowLeft' || code === 'ArrowRight') && Boolean(closest(SLIDER_SELECTOR))
}

/** The control Space must not re-activate once the transport has taken the
 * key — its own activation fires on keyup, so it loses focus instead. */
export function activatableAncestor(target: EventTarget | null): HTMLElement | null {
  const closest = closestOf(target)
  return closest ? ((closest(ACTIVATABLE_SELECTOR) as HTMLElement | null) ?? null) : null
}
