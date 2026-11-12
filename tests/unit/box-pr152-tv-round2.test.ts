import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { sideExit } from '../../src/renderer/src/box/focus'
import { switchNeedsConfirmation } from '../../src/renderer/src/box/next-song'
import { Queue } from '../../src/renderer/src/box/Queue'

const app = readFileSync(resolve(__dirname, '../../src/renderer/src/box/App.tsx'), 'utf8')

describe('PR #152 round 2, fix 1: Sing and Next confirm by one rule', () => {
  it('asks for a paused or playing loaded song, never for nothing loaded or an ended song', () => {
    expect(switchNeedsConfirmation(true, 'paused')).toBe(true) // old Sing: only playing || starting asked
    expect(switchNeedsConfirmation(true, 'playing')).toBe(true)
    expect(switchNeedsConfirmation(true, 'ended')).toBe(false)
    expect(switchNeedsConfirmation(false, 'paused')).toBe(false)
  })
  it('requestSing and requestNext both route through it; Sing no longer keys on playing || starting', () => {
    const sing = app.slice(app.indexOf('const requestSing'), app.indexOf('const prepare = '))
    expect(sing).toContain('switchNeedsConfirmation(true, playbackStatus(current))')
    expect(sing).not.toContain('current.playing || current.starting')
    expect(app).toContain('switchNeedsConfirmation(snapshot.active !== null, playbackStatus(snapshot))')
  })
})

describe('PR #152 round 2, fix 2: an open that starts playback lands on Play/Pause', () => {
  it('openNow arms the focus request and the effect honours it once Play is enabled', () => {
    const open = app.slice(app.indexOf('const openNow = useCallback'), app.indexOf('const requestSing'))
    expect(open).toContain('playFocusPending.current = true')
    expect(app).toContain("if (playFocusPending.current && play && !(play as HTMLButtonElement).disabled) { target = play; playFocusPending.current = false }")
    expect(app).toMatch(/endedWithNext, metronomeError, metronomeBusy, playEnabled\]\)/) // re-runs when Play becomes enabled (old deps never did)
  })
})

describe('PR #152 round 2, fix 3: Right from a row enters the primary action', () => {
  class El {
    dataset: Record<string, string> = {}
    constructor(private readonly selectors: string[] = []) {}
    matches(selector: string): boolean { return this.selectors.includes(selector) }
  }
  const renderQueue = (): string => renderToStaticMarkup(createElement(Queue, {
    items: [{ dir: '/a', name: 'B - A', songPath: '', hasStems: false }, { dir: '/b', name: 'B - B', songPath: '', hasStems: false }] as never,
    rows: {}, selectedDir: '/a', active: null, position: 0, playing: false, status: 'paused',
    onRemember: () => {}, onChoose: () => {}, onMove: () => {}, onRemove: () => {}, onBrowse: () => {}, onClose: () => {}, onToggle: () => {}
  }))
  it('uses the rendered hand-over selector and never lands on Remove, even when Move is disabled', () => {
    const selector = /data-remote-right="([^"]+)"/.exec(renderQueue())?.[1]
    expect(selector).toBeDefined()
    const group = new El()
    const row = new El()
    const select = new El(['[data-queue-action]', "[data-queue-action=select]"])
    const remove = new El(['[data-queue-action]'])
    ;(group as never as { contains(e: unknown): boolean }).contains = element => element === row
    ;(row as never as { closest(s: string): unknown }).closest = candidate => candidate === '[data-remote-right]' ? group : null
    ;(group as never as { getAttribute(a: string): string }).getAttribute = () => selector!
    const back = new El(['[data-queue-return]'])
    const scope = { contains: () => true }
    // Negative control: the old all-action selector sees Remove first here and selects it.
    expect(sideExit(scope as never, row as never, [back, row, remove, select] as never, 'ArrowRight')).toBe(select)
  })
  it('every action button carries the marker, but row entry names only Select song / Back to lyrics', () => {
    const html = renderQueue()
    for (const action of ['select', 'up', 'down', 'remove']) expect(html).toContain(`data-queue-action="${action}"`)
    expect(html).toContain('data-remote-right="[data-queue-action=select]"')
  })
  it('Down from the list lands on Select song and Left from it returns to the selected row (negative control: on 2e8acc53 neither attribute exists, so geometry picks Remove / stays put)', () => {
    const html = renderQueue()
    expect(html).toContain('class="queue-list" aria-label="')
    expect(/class="queue-list"[^>]*data-remote-down="\[data-queue-action=select\]"/.test(html)).toBe(true)
    expect(/<button[^>]*data-remote-left="\[data-queue-index\]"[^>]*data-queue-action="select"|<button[^>]*data-queue-action="select"[^>]*data-remote-left="\[data-queue-index\]"/.test(html)).toBe(true)
    expect(/data-queue-index="0" data-current="true"/.test(html)).toBe(true)
    expect(/data-queue-index="1" data-current/.test(html)).toBe(false)
    const row = new El(['[data-queue-index]'])
    const other = new El(['[data-queue-index]'])
    other.dataset.current = 'true'
    const select = new El(['[data-queue-action=select]'])
    const group = select as never as { closest(s: string): unknown; contains(e: unknown): boolean; getAttribute(a: string): string }
    group.closest = candidate => candidate === '[data-remote-left]' ? select : null
    group.contains = element => element === select
    group.getAttribute = () => '[data-queue-index]'
    const scope = { contains: () => true }
    expect(sideExit(scope as never, select as never, [row, other, select] as never, 'ArrowLeft')).toBe(other)
  })
})
