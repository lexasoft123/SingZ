import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

/**
 * What a right-click offers, given what was clicked.
 *
 * Electron ships NO context menu of its own, so until this existed a
 * right-click anywhere in SingZ did nothing at all — including on the Log,
 * where the only way to get a line out was a Copy button that takes all four
 * thousand of them.
 *
 * The app is chrome, not a document: `body` sets `user-select: none` and only
 * the log body turns it back on. So this offers Copy exactly where there is
 * something to copy — a selection, or an editable field, where Cut and Paste
 * belong beside it. An empty list means no menu is shown at all, which is
 * right for a bare right-click over the UI: a menu whose every item is
 * greyed out is worse than none.
 *
 * There is deliberately no Select All. In a document it would be the obvious
 * companion to Copy; here it would select the whole shell.
 *
 * Split out of the window setup so the decision can be tested without an
 * Electron window — the roles and their enablement are the part that can be
 * wrong, and popping a native menu is the part that cannot be asserted.
 */
export function contextMenuItems(
  params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>
): MenuItemConstructorOptions[] {
  if (params.isEditable) {
    return [
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste }
    ]
  }
  // Whitespace is not a selection worth a menu: a click that lands between
  // two log lines reports the newline between them.
  return params.selectionText.trim() ? [{ role: 'copy' }] : []
}
