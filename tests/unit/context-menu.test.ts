/*
 * What a right-click offers. Electron ships no context menu, so before this
 * existed a right-click anywhere in SingZ did nothing — reported from the
 * field on 2026-09-07 against the Log, where the only way to get one line out
 * was a Copy button that takes all four thousand.
 */
import { describe, expect, it } from 'vitest'
import { contextMenuItems } from '../../src/main/context-menu'

const flags = (patch: Partial<Electron.EditFlags> = {}): Electron.EditFlags => ({
  canUndo: false,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: true,
  canSelectAll: true,
  canEditRichly: false,
  ...patch
})

const roles = (items: ReturnType<typeof contextMenuItems>): (string | undefined)[] =>
  items.map((item) => item.role)

describe('contextMenuItems', () => {
  it('offers Copy over a selection', () => {
    expect(roles(contextMenuItems({
      isEditable: false,
      selectionText: '10:21:13 dsp: graph ready',
      editFlags: flags()
    }))).toEqual(['copy'])
  })

  it('offers nothing over the bare UI, so no empty menu appears', () => {
    // A menu whose every item is greyed out is worse than no menu, and the
    // app is chrome: `body` sets user-select: none everywhere but the log.
    expect(contextMenuItems({ isEditable: false, selectionText: '', editFlags: flags() })).toEqual([])
  })

  it('treats whitespace as no selection', () => {
    // A click landing between two log lines reports the newline between them.
    expect(contextMenuItems({ isEditable: false, selectionText: ' \n ', editFlags: flags() })).toEqual([])
  })

  it('offers the editing trio in a field, each enabled as the field says', () => {
    const items = contextMenuItems({
      isEditable: true,
      selectionText: '',
      editFlags: flags({ canCut: false, canCopy: false })
    })
    expect(roles(items)).toEqual(['cut', 'copy', 'paste'])
    expect(items.map((item) => item.enabled)).toEqual([false, false, true])
  })

  it('offers the editing trio in an EMPTY field too — Paste is the point', () => {
    expect(roles(contextMenuItems({
      isEditable: true,
      selectionText: '',
      editFlags: flags()
    }))).toEqual(['cut', 'copy', 'paste'])
  })

  it('never offers Select All, which here would select the whole shell', () => {
    for (const params of [
      { isEditable: false, selectionText: 'a line', editFlags: flags() },
      { isEditable: true, selectionText: '', editFlags: flags() }
    ]) {
      expect(roles(contextMenuItems(params))).not.toContain('selectAll')
    }
  })
})
