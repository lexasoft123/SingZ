import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { moveSpatialFocus, type RemoteDirection } from '../../src/renderer/src/box/focus'
import { PhysicalInputsPanel } from '../../src/renderer/src/box/Settings'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { device, fakeHost, newStore } from './box-microphone-host-fake'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

// ---------------------------------------------------------------------------
// Bugs 2 and 3: remote focus around the analysis button row.
// ---------------------------------------------------------------------------

type Rect = { left: number; top: number; width: number; height: number }
const TARGETS = 'button:not(:disabled), input[type="range"]:not(:disabled), [data-remote-focus]'
class FakeElement {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  parent: FakeElement | null = null
  disabled = false
  constructor(readonly tagName: string, readonly name: string, private readonly rect: Rect = { left: 0, top: 0, width: 0, height: 0 }) {}
  attr(name: string, value = ''): this { this.attributes[name] = value; return this }
  append(...children: FakeElement[]): this { for (const child of children) { child.parent = this; this.children.push(child) } return this }
  private descendants(): FakeElement[] { return this.children.flatMap(child => [child, ...child.descendants()]) }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled
    if (selector === '[inert]') return false
    if (selector === 'input[type="range"]') return false
    // Lists of bare attribute selectors are all the production code uses here.
    return selector.split(',').map(part => part.trim()).some(part => {
      const match = /^\[([a-z-]+)\]$/.exec(part)
      if (!match) throw new Error(`Unsupported selector: ${part}`)
      return this.attributes[match[1]] !== undefined
    })
  }
  closest(selector: string): FakeElement | null {
    for (let current: FakeElement | null = this; current; current = current.parent) if (current.matches(selector)) return current
    return null
  }
  contains(other: unknown): boolean {
    for (let current = other as FakeElement | null; current; current = current.parent) if (current === this) return true
    return false
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector !== TARGETS) throw new Error(`Unsupported selector list: ${selector}`)
    return this.descendants().filter(element => element.tagName === 'button' && !element.disabled)
  }
  getClientRects(): object[] { return [this.rect] }
  getBoundingClientRect(): Rect { return this.rect }
  focus(): void { focused = this }
  scrollIntoView(): void {}
}
let focused: FakeElement | null = null
const body = new FakeElement('body', 'body')
function stubDocument(): void {
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('document', { get activeElement() { return focused ?? body }, body })
}

/** The real rendered panel, with and without an edit in flight. */
async function panelHtml(pending = false): Promise<string> {
  vi.useFakeTimers(); await prepareBoxLocale('en')
  const store = newStore(fakeHost()); store.connect(); await vi.advanceTimersByTimeAsync(0)
  const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] },
    snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
  const html = renderToStaticMarkup(createElement(PhysicalInputsPanel, { preview: { state: routing as never, error: '', pending: false, receivedAt: Date.now() },
    selection: null, onSelect: vi.fn(), microphones: store, microphoneSnapshot: { ...store.getSnapshot(), pending } }))
  store.dispose(); vi.useRealTimers()
  return html
}

/** Settings at 1920x1080 as on the Box: output column left, the narrow inputs
 * panel right with its scrolling channel list, and the page Cancel/Apply band
 * below. There is no analysis button row any more. */
function settingsLayout() {
  const button = (name: string, rect: Rect): FakeElement => new FakeElement('button', name, rect)
  const scope = new FakeElement('main', 'settings')
  scope.dataset.surface = 'settings'
  const back = button('Back', { left: 1680, top: 120, width: 120, height: 48 })
  const output = button('output row', { left: 120, top: 260, width: 1000, height: 72 })
  const list = new FakeElement('div', 'input list')
  const rows = Array.from({ length: 12 }, (_, i) => button(`input ${i + 1}`, { left: 1180, top: 260 + i * 46, width: 620, height: 42 }).attr('data-input-channel', String(i)).attr('data-remote-focus'))
  list.append(...rows)
  const pageCancel = button('page Cancel', { left: 1430, top: 950, width: 160, height: 56 })
  const apply = button('Apply', { left: 1610, top: 950, width: 190, height: 56 })
  scope.append(back, output, new FakeElement('aside', 'inputs panel').append(list), pageCancel, apply)
  return { scope, rows }
}
const press = (scope: FakeElement, key: RemoteDirection): string => {
  moveSpatialFocus(scope as unknown as HTMLElement, key)
  return focused?.name ?? 'body'
}

describe('Box Settings remote focus without analysis buttons', () => {
  it('renders no Start/Stop/Cancel analysis row and no custom remote wiring around it', async () => {
    const html = await panelHtml()
    expect(html).not.toMatch(/data-microphone-(start|stop|cancel)|data-remote-id|data-remote-counterpart|data-remote-down|data-remote-up/)
    expect(html).not.toMatch(/Start analysis|Stop analysis|Cancel selection|Use enabled inputs/)
    expect(html.match(/<button/g)).toHaveLength(10) // exactly one focus stop per channel row
  })
  it('keeps every channel focusable while an edit is in flight so remote focus never falls to <body>', async () => {
    const html = await panelHtml(true)
    const buttons = html.match(/<button[^>]*data-input-channel[^>]*>/g) ?? []
    expect(buttons).toHaveLength(10)
    for (const tag of buttons) { expect(tag).toContain('aria-disabled="true"'); expect(tag).not.toMatch(/\sdisabled(=|\s|>)/) }
  })
  it('Down from the last input channel moves straight on to the page buttons, and Up returns to the list', () => {
    stubDocument()
    const ui = settingsLayout()
    focused = ui.rows[ui.rows.length - 1]
    expect(press(ui.scope, 'ArrowDown')).toBe('page Cancel')
    expect(press(ui.scope, 'ArrowUp')).toBe('input 12')
    expect(press(ui.scope, 'ArrowUp')).toBe('input 11')
  })
})
