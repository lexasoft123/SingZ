import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoxQueueRef, BoxRoutingState } from '../../src/shared/box-contract'
import type { CaptureAnalysisWindow, CaptureStartResult, CaptureStats } from '../../src/shared/types'
import { setLocale } from '../../src/shared/i18n/core'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { BoxMicrophones, MICROPHONE_IDLE_POLL_MS } from '../../src/renderer/src/box/microphones'
import { PlayerMicrophoneMeters } from '../../src/renderer/src/box/Player'
import { RoutingSettings } from '../../src/renderer/src/box/RoutingSettings'
import { Settings } from '../../src/renderer/src/box/Settings'
import { PhysicalRoutingPreview } from '../../src/renderer/src/box/physical-inputs-model'
import { routingActivationText, routingGainSteps, stepRoutingGain } from '../../src/renderer/src/box/routing-model'
import { detailsReturnRoute } from '../../src/renderer/src/box/settings-navigation'
import { moveQueueRefInView } from '../../src/renderer/src/box/queue-model'
import { projectQueue } from '../../src/renderer/src/box/collection/queue'
import type { CollectionEntry } from '../../src/renderer/src/box/collection/types'

const root = resolve(__dirname, '../..')
const source = (file: string): string => readFileSync(resolve(root, file), 'utf8')
function rule(file: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = source(file).match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  if (body === undefined) throw new Error(`No rule ${selector} in ${file}`)
  return body
}

afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); setLocale('en'); await prepareBoxLocale('en') })

describe('Box mixer layout', () => {
  it('keeps the first stem row reachable when 7+ rows overflow the centered column', () => {
    const body = rule('src/renderer/src/box/styles.css', '.mixer-rows')
    expect(body).toMatch(/overflow-y:\s*auto/)
    // Plain `center` pushes overflowing top rows above scrollTop 0; `safe` falls back to start.
    expect(body).toMatch(/justify-content:\s*safe center/)
  })
})

describe('Box Settings grid with Routing open', () => {
  it('uses a three-row grid for heading, routing panel and footer', () => {
    expect(rule('src/renderer/src/box/settings.css', '.box-settings[data-routing="open"]')).toMatch(/grid-template-rows:\s*64px minmax\(0, 1fr\) 24px/)
    const html = renderToStaticMarkup(createElement(Settings, { inventory: null, loading: false, error: null, currentOutputUid: null,
      playbackActive: false, onRefresh: vi.fn(), onApplyOutput: vi.fn(async () => undefined), onBack: vi.fn() }))
    expect(html).toContain('data-routing="closed"')
  })
})

describe('Box fixed TV frame', () => {
  it('measures in a layout effect so the first paint is already scaled', () => {
    const text = source('src/renderer/src/box/useFixedTvFrame.ts')
    expect(text).toMatch(/useLayoutEffect\(\(\) => \{/)
    expect(text).not.toMatch(/\buseEffect\(/)
  })
})

describe('Box details Back after a failed open', () => {
  it('returns to the route that opened details, keeping the origin when re-entered', () => {
    expect(detailsReturnRoute('queue', 'catalog')).toBe('queue')
    expect(detailsReturnRoute('details', 'queue')).toBe('queue')
  })
  it('records the origin in openNow before routing to details', () => {
    const text = source('src/renderer/src/box/App.tsx')
    const openNow = text.slice(text.indexOf('const openNow = useCallback'), text.indexOf("setRoute('details')", text.indexOf('const openNow = useCallback')))
    expect(openNow).toContain('detailsReturn.current = detailsReturnRoute(latest.current.route, detailsReturn.current)')
  })
})

describe('Box phone queue move with hidden duplicate refs', () => {
  const item = (dir: string) => ({ dir, name: dir, songPath: `${dir}/song`, savedAt: '', hasStems: true, stemCount: 2, hasLyrics: true, bytes: 1 })
  const entries: CollectionEntry[] = [
    { id: 'a', remoteId: 'drive-a', name: 'A', local: item('/a') },
    { id: 'b', remoteId: null, name: 'B', local: item('/b') }
  ]
  it('moves the visible row instead of swapping with an invisible duplicate', () => {
    const a: BoxQueueRef = { kind: 'local', dir: '/a' }
    const aDuplicate: BoxQueueRef = { kind: 'drive', id: 'drive-a' }
    const b: BoxQueueRef = { kind: 'local', dir: '/b' }
    const refs = [a, aDuplicate, b]
    expect(projectQueue(entries, refs).map(row => row.item.dir)).toEqual(['/a', '/b'])
    const next = moveQueueRefInView(entries, refs, b, -1)
    expect(projectQueue(entries, next).map(row => row.item.dir)).toEqual(['/b', '/a'])
    expect(moveQueueRefInView(entries, refs, a, -1)).toBe(refs)
  })
  it('routes the phone queue-move command through the projection helper', () => {
    const text = source('src/renderer/src/box/App.tsx')
    expect(text).toContain('moveQueueRefInView(latestPhone.current.entries, refs, ref, command.delta)')
  })
})

const routingState = (gain: number): BoxRoutingState => ({ version: 1,
  inventory: { devicesFresh: true, devicesError: '', devices: [
    { uid: 'alsa:flow8', name: 'FLOW 8', inputChannels: 2, outputChannels: 4, defaultInput: true, defaultOutput: true, rate: 48000 },
    { uid: 'alsa:pa', name: 'PA', inputChannels: 0, outputChannels: 2, defaultInput: false, defaultOutput: false, rate: 48000 }
  ] }, snapshot: { revision: { epoch: 'epoch-a', generation: '1' },
    document: { devices: [{ id: 'mix', name: 'Live mix', routing: { outputChannels: 2, sources: [
      { id: 'mic', channels: 2, gain, enabled: true, muted: false, connections: [{ sourceChannel: 0, outputChannel: 0, gain: 1 }] }
    ] }, bindings: [{ id: 'mic', kind: 'input-device', selector: 'alsa:flow8' }], monitors: [] }] },
    restoration: { phase: 'restored', error: '', desiredGeneration: '1', activeGeneration: '1' },
    runtime: { metersFresh: false, monitors: [], devices: [] } }
} as unknown as BoxRoutingState)
const routing = (gain: number): string => renderToStaticMarkup(createElement(RoutingSettings, {
  preview: { state: routingState(gain), error: '', pending: false, receivedAt: Date.now() },
  controller: new PhysicalRoutingPreview({ read: vi.fn(), edit: vi.fn() })
}))
const minusButton = (html: string): string => html.match(/<button[^>]*>−<\/button>/)?.[0] ?? ''

describe('Box routing source gain steps', () => {
  it('snaps to the 10% grid so repeated presses reach exactly 0 and 1', () => {
    let gain = 1
    for (let i = 0; i < 10; ++i) gain = stepRoutingGain(gain, -1)
    expect(gain).toBe(0)
    for (let i = 0; i < 3; ++i) gain = stepRoutingGain(gain, 1)
    expect(gain).toBe(0.3)
    expect(routingGainSteps(1e-16)).toBe(0)
    expect(stepRoutingGain(1, 1)).toBe(1)
  })
  it('disables Minus for float residue that displays as 0%', () => {
    const html = routing(0.30000000000000004 - 0.1 - 0.1 - 0.1)
    expect(html).toContain('>0%<')
    expect(minusButton(html)).toMatch(/disabled/)
    expect(minusButton(routing(0.5))).toMatch(/^<button/)
    expect(minusButton(routing(0.5))).not.toMatch(/disabled/)
  })
})

describe('Box routing localization', () => {
  it.each([['ru', 'Звуковые маршруты', 'Сохранённые маршруты активны.', 'Маршруты'], ['zh-CN', '音频路由', '已保存的路由正在生效。', '路由']] as const)('renders routing copy in %s', async (locale, title, active, toggle) => {
    await prepareBoxLocale(locale)
    const html = routing(0.5)
    expect(html).toContain(title)
    expect(html).toContain(active)
    for (const english of ['Audio routing', 'Microphone monitoring', 'Cancel changes', 'Apply music output', 'Saved revision', 'Disable', 'Mute']) expect(html).not.toContain(english)
    expect(routingActivationText(routingState(0.5))).toBe(active)
    const settings = renderToStaticMarkup(createElement(Settings, { inventory: null, loading: false, error: null, currentOutputUid: null,
      playbackActive: false, onRefresh: vi.fn(), onApplyOutput: vi.fn(async () => undefined), onBack: vi.fn() }))
    expect(settings).toContain(`>${toggle}</`)
    expect(settings).not.toMatch(/>Routing</)
  })
})

const device = { uid: 'alsa:usb', label: 'USB mic', channels: 2, channelLabels: ['In 1', 'In 2'], sampleRate: 48000, isDefault: false }
function micFixture(initialDevices: typeof device[] = [device]) {
  vi.useFakeTimers()
  let native = { generation: '0', running: false }
  let devices = initialDevices
  let counter = 10
  const stats = (): CaptureStats => ({ deliveredBlocks: '1', deliveredFrames: '256', overruns: '0', deliveryWakeups: '1', droppedEvents: '0', overwrittenWindows: '0',
    microphoneLevels: { valid: native.running, channels: native.running ? 2 : 0, ownershipGeneration: native.generation,
      peak: native.running ? [0.25, 0.5] : [], rms: native.running ? [0.1, 0.2] : [] } })
  const api = {
    askMicAccess: vi.fn(async () => true),
    captureInputDevices: vi.fn(async () => ({ ok: true as const, devices })),
    captureState: vi.fn(async () => ({ state: native.running ? 'running' as const : 'idle' as const, ownershipGeneration: native.generation, error: '' })),
    captureStats: vi.fn(async () => stats()),
    beginCapture: vi.fn(async (config: { inputChannel: number }, generation: string): Promise<CaptureStartResult> => {
      native = { generation, running: true }
      return { ok: true, state: 'running', deviceUid: device.uid, deviceLabel: device.label, deviceChannels: 2, inputChannel: config.inputChannel,
        sampleRate: 48000, sampleFormat: 'float32', sharingMode: 'shared-history', performanceMode: 'default', timestampSource: 'hardware' } as CaptureStartResult
    }),
    cancelCapture: vi.fn(async (generation: string) => { if (generation === native.generation) native.running = false; return { ok: true as const, cancelled: true } }),
    onCaptureWindow: vi.fn((_callback: (value: CaptureAnalysisWindow) => void) => vi.fn())
  }
  const storage = new Map<string, string>()
  const controller = new BoxMicrophones(api, () => Date.now(), () => String(++counter),
    { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) } })
  return { api, controller, plug: () => { devices = [device] } }
}

describe('Box microphone hot-plug inventory', () => {
  it('re-reads capture inventory when an interface appeared after boot before toggling and starting', async () => {
    const f = micFixture([])
    f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().devices).toEqual([])
    f.plug() // The routing preview now lists it; capture inventory is stale.
    expect(await f.controller.setEnabledChannels(device.uid, [1])).toBe(true)
    expect(f.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 1 })
    expect(await f.controller.start()).toBe(true)
    expect(f.api.beginCapture).toHaveBeenCalledWith({ deviceUid: device.uid, inputChannel: 1, enabledChannels: [1] }, expect.any(String))
    await f.controller.dispose()
  })
  it('refreshes inside start when the selected device vanished from a stale inventory', async () => {
    const f = micFixture()
    f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(f.controller.getSnapshot().selection).toEqual({ uid: device.uid, channel: 0 })
    f.api.captureInputDevices.mockResolvedValueOnce({ ok: true as const, devices: [] })
    await f.controller.refreshDevices()
    const reads = f.api.captureInputDevices.mock.calls.length
    expect(await f.controller.start()).toBe(true)
    expect(f.api.captureInputDevices.mock.calls.length).toBe(reads + 1)
    expect(f.controller.getSnapshot().error).toBeNull()
    await f.controller.dispose()
  })
})

describe('Box microphone polling and render isolation', () => {
  it('reads only capability slowly without a session and levels at 5 Hz while one is owned', async () => {
    const f = micFixture()
    f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    const idleStart = f.api.captureStats.mock.calls.length
    await vi.advanceTimersByTimeAsync(4 * (MICROPHONE_IDLE_POLL_MS ?? 2000))
    expect(f.api.captureStats.mock.calls.length - idleStart).toBeLessThanOrEqual(4)
    expect(await f.controller.start()).toBe(true)
    const ownedStart = f.api.captureStats.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.api.captureStats.mock.calls.length - ownedStart).toBeGreaterThanOrEqual(4)
    await f.controller.dispose()
  })
  it('lets leaf meters subscribe directly instead of BoxApp', async () => {
    const f = micFixture()
    f.controller.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(await f.controller.start()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    const html = renderToStaticMarkup(createElement(PlayerMicrophoneMeters, { microphones: f.controller }))
    expect(html).toContain('aria-valuenow="0.25"'); expect(html).toContain('aria-valuenow="0.5"')
    const app = source('src/renderer/src/box/App.tsx')
    expect(app).not.toMatch(/useSyncExternalStore\(microphones\.subscribe/)
    expect(app).not.toMatch(/microphoneSnapshot=/)
    await f.controller.dispose()
  })
})
