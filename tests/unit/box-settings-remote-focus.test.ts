import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { CaptureAnalysisWindow, CaptureStartResult, CaptureStats } from '../../src/shared/types'
import { BoxMicrophones, MICROPHONE_RESUME_ATTEMPTS } from '../../src/renderer/src/box/microphones'
import { disabledFocusReplacement, moveSpatialFocus, type RemoteDirection } from '../../src/renderer/src/box/focus'
import { PhysicalInputsPanel } from '../../src/renderer/src/box/Settings'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

// ---------------------------------------------------------------------------
// Bug 1: the persistent Box audio host restarts underneath running analysis.
// ---------------------------------------------------------------------------

const device = { uid: 'alsa:flow8', label: 'FLOW 8', channels: 10, channelLabels: Array.from({ length: 10 }, (_, i) => `Input ${i + 1}`), sampleRate: 48000, isDefault: true }
const ENOENT = "Error: ENOENT: no such file or directory, lstat '/run/singz-box-audio/control.sock'"
const UNCERTAIN = 'BoxAudioUncertainError: Audio state is uncertain; reconcile authoritative service state before another mutation'

function hostFixture() {
  vi.useFakeTimers()
  // `host` models the persistent service: 'up' (same process), 'gone' (socket
  // absent during the systemd restart) or 'restarted' (new epoch, no owner;
  // the main-process client refuses mutations until something reconciles).
  let host: 'up' | 'gone' | 'restarted' = 'up'
  let native = { generation: '0', running: false }
  let counter = 10
  const stored = new Map<string, string>()
  const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value) } }
  const stats = (): CaptureStats => ({ deliveredBlocks: '1', deliveredFrames: '256', overruns: '0', deliveryWakeups: '1', droppedEvents: '0', overwrittenWindows: '0',
    ...(host === 'gone' ? {} : { microphoneLevels: { valid: native.running, channels: native.running ? 10 : 0, ownershipGeneration: native.generation,
      peak: native.running ? Array(10).fill(0.4) : [], rms: native.running ? Array(10).fill(0.2) : [] } }) })
  const started = (channel: number): CaptureStartResult => ({ ok: true, state: 'running', deviceUid: device.uid, deviceLabel: device.label, deviceChannels: 10,
    inputChannel: channel, sampleRate: 48000, sampleFormat: 'float32', sharingMode: 'shared-history', performanceMode: 'default', timestampSource: 'hardware' })
  const api = {
    askMicAccess: vi.fn(async () => true),
    captureInputDevices: vi.fn(async () => ({ ok: true as const, devices: [device] })),
    // Mirrors main's `capture:state` handler: a transport failure becomes an
    // error state with no owner generation.
    captureState: vi.fn(async () => host === 'gone'
      ? { state: 'error' as const, ownershipGeneration: '', error: ENOENT }
      : { state: native.running ? 'running' as const : 'idle' as const, ownershipGeneration: native.generation, error: '' }),
    captureStats: vi.fn(async () => stats()),
    beginCapture: vi.fn(async (config: { inputChannel: number }, generation: string): Promise<CaptureStartResult> => {
      if (host !== 'up') return { ...started(config.inputChannel), ok: false, state: 'error', error: host === 'gone' ? ENOENT : UNCERTAIN }
      native = { generation, running: true }; return started(config.inputChannel)
    }),
    cancelCapture: vi.fn(async (generation: string): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string }> => {
      if (host === 'gone') return { ok: false, error: ENOENT }
      if (host === 'restarted') return { ok: false, error: UNCERTAIN }
      const cancelled = generation === native.generation && native.running
      if (cancelled) native.running = false
      return { ok: true, cancelled }
    }),
    onCaptureWindow: vi.fn((_callback: (value: CaptureAnalysisWindow) => void) => vi.fn())
  }
  const controller = new BoxMicrophones(api, () => Date.now(), () => String(++counter), storage)
  return {
    api, controller, stored,
    /** systemd stops the service: the socket and its capture process vanish. */
    stopHost: () => { host = 'gone'; native = { generation: '0', running: false } },
    /** A new service process answers on the socket: new epoch, idle owner. */
    restartHost: () => { host = 'restarted' },
    /** Something (routing preview, retained snapshot) reconciled the client. */
    reconcileClient: () => { host = 'up' },
    /** The socket blinked but the same process kept the session. */
    socketBack: (value: typeof native) => { host = 'up'; native = value }
  }
}
async function running(f: ReturnType<typeof hostFixture>): Promise<void> {
  f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
  await f.controller.setEnabledChannels(device.uid, [0, 1])
  f.controller.select({ uid: device.uid, channel: 0 })
  expect(await f.controller.start()).toBe(true); await vi.advanceTimersByTimeAsync(0)
  expect(f.controller.getSnapshot()).toMatchObject({ phase: 'running', error: null, active: { generation: '11' } })
}

describe('Box microphone analysis across an audio-service restart', () => {
  it('waits through the socket outage, then restarts analysis on the new host instead of sticking on an unconfirmed stop', async () => {
    const f = hostFixture(); await running(f)
    const persisted = f.stored.get('singz-box.microphone-channels.v1')
    f.stopHost()
    await vi.advanceTimersByTimeAsync(3000)
    const outage = f.controller.getSnapshot()
    // Old code: failSession → cancel ENOENT → phase 'uncertain' + stopFailed, and polling stopped forever.
    expect(outage.phase).not.toBe('uncertain')
    expect(outage.error).toMatch(/reconnecting/)
    expect(outage.error).not.toMatch(/could not be confirmed/)
    expect(outage.levels).toBeNull()
    f.restartHost()
    await vi.advanceTimersByTimeAsync(2500)
    // The new host refuses mutations until reconciled; that is transient too.
    expect(f.controller.getSnapshot().phase).not.toBe('uncertain')
    f.reconcileClient()
    await vi.advanceTimersByTimeAsync(5000)
    const resumed = f.controller.getSnapshot()
    expect(resumed).toMatchObject({ phase: 'running', error: null, active: { uid: device.uid, channel: 0, enabledChannels: [0, 1] } })
    expect(resumed.active!.generation).not.toBe('11')
    expect(resumed.levels).not.toBeNull()
    expect(f.api.beginCapture.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(f.stored.get('singz-box.microphone-channels.v1')).toBe(persisted)
    await f.controller.dispose()
  })

  it('restarts immediately when the host comes back already reconciled', async () => {
    const f = hostFixture(); await running(f)
    f.stopHost(); await vi.advanceTimersByTimeAsync(2500)
    f.reconcileClient(); await vi.advanceTimersByTimeAsync(2500)
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'running', error: null })
    expect(f.api.beginCapture).toHaveBeenCalledTimes(2)
    await f.controller.dispose()
  })

  it('keeps the same session when only the socket blinked and the host still owns it', async () => {
    const f = hostFixture(); await running(f)
    f.stopHost(); await vi.advanceTimersByTimeAsync(2500)
    f.socketBack({ generation: '11', running: true }); await vi.advanceTimersByTimeAsync(2500)
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'running', error: null, active: { generation: '11' } })
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    expect(f.api.cancelCapture).not.toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('a Stop pressed during the outage settles to stopped once the host answers, without restarting', async () => {
    const f = hostFixture(); await running(f)
    f.stopHost(); await vi.advanceTimersByTimeAsync(2500)
    expect(await f.controller.stop()).toBe(false)
    expect(f.controller.getSnapshot().phase).toBe('uncertain')
    expect(f.controller.getSnapshot().error).toMatch(/reconnecting/)
    f.restartHost(); await vi.advanceTimersByTimeAsync(2500)
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'idle', error: null, active: null })
    f.reconcileClient(); await vi.advanceTimersByTimeAsync(10_000)
    expect(f.controller.getSnapshot().phase).toBe('idle')
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1)
    expect(await f.controller.start()).toBe(true)
    await f.controller.dispose()
  })

  it('bounds automatic restarts and then reports a stopped, retryable state', async () => {
    const f = hostFixture(); await running(f)
    f.stopHost(); await vi.advanceTimersByTimeAsync(2500)
    f.restartHost() // never reconciled: every begin is refused
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1 + MICROPHONE_RESUME_ATTEMPTS)
    expect(f.controller.getSnapshot().phase).toBe('error')
    expect(f.controller.getSnapshot().error).toMatch(/could not resume/)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(f.api.beginCapture).toHaveBeenCalledTimes(1 + MICROPHONE_RESUME_ATTEMPTS)
    f.reconcileClient()
    expect(await f.controller.start()).toBe(true)
    await f.controller.dispose()
  })
})

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

/** The production wiring, read from the real rendered panel. */
function panelWiring(): { down: string; up: string; start: Record<string, string>; stop: Record<string, string> } {
  const f = hostFixture()
  const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] },
    snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
  const html = renderToStaticMarkup(createElement(PhysicalInputsPanel, { preview: { state: routing as never, error: '', pending: false, receivedAt: Date.now() },
    selection: null, onSelect: vi.fn(), microphones: f.controller, microphoneSnapshot: f.controller.getSnapshot() }))
  vi.useRealTimers()
  const attribute = (tag: string | undefined, name: string): string => {
    const value = tag?.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]
    if (value === undefined) throw new Error(`missing ${name} in ${tag}`)
    return value.replace(/&quot;/g, '"')
  }
  const list = html.match(/<div class="settings-input-list"[^>]*>/)?.[0]
  const controls = html.match(/<div class="settings-analysis-controls"[^>]*>/)?.[0]
  const start = html.match(/<button[^>]*\sdata-microphone-start="true"[^>]*>/)?.[0]
  const stop = html.match(/<button[^>]*\sdata-microphone-stop="true"[^>]*>/)?.[0]
  return {
    down: attribute(list, 'data-remote-down'), up: attribute(controls, 'data-remote-up'),
    start: { 'data-remote-id': attribute(start, 'data-remote-id'), 'data-remote-counterpart': attribute(start, 'data-remote-counterpart') },
    stop: { 'data-remote-id': attribute(stop, 'data-remote-id'), 'data-remote-counterpart': attribute(stop, 'data-remote-counterpart') }
  }
}

/** Settings at 1920×1080 as on the Box: a wide output column on the left, the
 * narrow inputs panel on the right with its own scrolling channel list, the
 * left-aligned analysis row under it, and the page Cancel/Apply band below. */
function settingsLayout(wiring = panelWiring()) {
  const button = (name: string, rect: Rect): FakeElement => new FakeElement('button', name, rect)
  const scope = new FakeElement('main', 'settings')
  scope.dataset.surface = 'settings'
  const catalog = button('header Catalog', { left: 120, top: 40, width: 140, height: 48 })
  const back = button('Back', { left: 1680, top: 120, width: 120, height: 48 })
  const output = button('output row', { left: 120, top: 260, width: 1000, height: 72 })
  const list = new FakeElement('div', 'input list').attr('data-remote-down', wiring.down)
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => `FLOW 8 ${i + 1}`),
    'Analog / PCM 0 1', 'Analog / PCM 0 2'
  ].map((name, i) => button(name, { left: 1180, top: 260 + i * 46, width: 620, height: 42 }).attr('data-input-channel', String(i % 10)).attr('data-remote-focus'))
  list.append(...rows)
  const controls = new FakeElement('div', 'analysis controls').attr('data-remote-up', wiring.up)
  const start = button('Start analysis', { left: 1180, top: 860, width: 180, height: 44 }).attr('data-microphone-start').attr('data-remote-id', wiring.start['data-remote-id']).attr('data-remote-counterpart', wiring.start['data-remote-counterpart'])
  const stop = button('Stop analysis', { left: 1372, top: 860, width: 170, height: 44 }).attr('data-microphone-stop').attr('data-remote-id', wiring.stop['data-remote-id']).attr('data-remote-counterpart', wiring.stop['data-remote-counterpart'])
  const cancelSelection = button('Cancel selection', { left: 1554, top: 860, width: 190, height: 44 }).attr('data-microphone-cancel')
  const row = new FakeElement('div', 'analysis row').append(start, stop, cancelSelection)
  controls.append(row)
  const pageCancel = button('page Cancel', { left: 1430, top: 950, width: 160, height: 56 })
  const apply = button('Apply', { left: 1610, top: 950, width: 190, height: 56 })
  const panel = new FakeElement('aside', 'inputs panel').append(list, controls)
  scope.append(catalog, back, output, panel, pageCancel, apply)
  return { scope, rows, start, stop, cancelSelection, row, pageCancel }
}
const press = (scope: FakeElement, key: RemoteDirection): string => {
  moveSpatialFocus(scope as unknown as HTMLElement, key)
  return focused?.name ?? 'body'
}

describe('Box Settings remote focus around microphone analysis', () => {
  it('Down from the last input channel lands on the analysis row, and Up returns to the list', () => {
    stubDocument()
    const ui = settingsLayout()
    ui.stop.disabled = true // idle: only Start and Cancel selection are enabled
    focused = ui.rows[ui.rows.length - 1]
    // Old spatial search jumped to the better-aligned page Cancel.
    expect(press(ui.scope, 'ArrowDown')).toBe('Start analysis')
    expect(press(ui.scope, 'ArrowRight')).toBe('Cancel selection')
    expect(press(ui.scope, 'ArrowUp')).toBe('Analog / PCM 0 2')
    expect(press(ui.scope, 'ArrowUp')).toBe('Analog / PCM 0 1')
    expect(press(ui.scope, 'ArrowUp')).toBe('FLOW 8 10')
    expect(press(ui.scope, 'ArrowDown')).toBe('Analog / PCM 0 1')
    focused = ui.start
    expect(press(ui.scope, 'ArrowDown')).toBe('page Cancel')
  })

  it('Down lands on the first enabled analysis button', () => {
    stubDocument()
    const ui = settingsLayout()
    ui.start.disabled = true // running on the selected channel: Stop is the first enabled button
    focused = ui.rows[ui.rows.length - 1]
    expect(press(ui.scope, 'ArrowDown')).toBe('Stop analysis')
    expect(press(ui.scope, 'ArrowUp')).toBe('Analog / PCM 0 2')
  })

  it('moves focus from a pressed Start/Stop that disabled itself to its counterpart, never to <body>', () => {
    stubDocument()
    const ui = settingsLayout()
    const row = ui.row as unknown as HTMLElement
    const replace = (last: FakeElement): string | null => (disabledFocusReplacement(row, last as unknown as HTMLElement) as unknown as FakeElement | null)?.name ?? null
    // Start pressed → phase 'starting': Start disabled, Stop enabled.
    focused = ui.start; ui.start.disabled = true
    expect(replace(ui.start)).toBe('Stop analysis')
    // Chromium already blurred the disabled button to <body>.
    focused = null
    expect(replace(ui.start)).toBe('Stop analysis')
    // Stop pressed → 'stopping': every row button is pending; nothing to take focus yet.
    ui.start.disabled = true; ui.stop.disabled = true; ui.cancelSelection.disabled = true
    focused = null
    expect(replace(ui.stop)).toBeNull()
    // Idle again: Start is enabled and focus is still on <body>.
    ui.start.disabled = false; ui.cancelSelection.disabled = false
    expect(replace(ui.stop)).toBe('Start analysis')
    // No counterpart enabled: nearest enabled button in the row.
    ui.start.disabled = true
    expect(replace(ui.stop)).toBe('Cancel selection')
    // The user already moved elsewhere: never steal focus back.
    focused = ui.pageCancel
    expect(replace(ui.stop)).toBeNull()
    // An enabled control keeps its focus.
    ui.stop.disabled = false; focused = ui.stop
    expect(replace(ui.stop)).toBeNull()
  })
})
