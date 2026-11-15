import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoxQueueRef, BoxRoutingState } from '../../src/shared/box-contract'
import { setLocale } from '../../src/shared/i18n/core'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { device as micDevice, fakeHost, newStore } from './box-microphone-host-fake'
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

describe('Box microphone hot-plug and render isolation', () => {
  it('accepts a toggle for an interface plugged in after boot: the host, not the renderer, validates devices', async () => {
    vi.useFakeTimers()
    const host = fakeHost({ device: null, origin: 'user', channels: {} })
    const store = newStore(host); store.connect(); await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().phase).toBe('off')
    expect(await store.toggleChannel(micDevice.uid, 1)).toBe(true)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith({ expectedRevision: '1', device: micDevice.uid, channels: { [micDevice.uid]: [1] } })
    expect(store.getSnapshot().phase).toBe('running')
    store.dispose()
  })
  it('lets leaf meters subscribe directly instead of BoxApp', async () => {
    vi.useFakeTimers()
    await prepareBoxLocale('en')
    const store = newStore(fakeHost()); store.connect(); await vi.advanceTimersByTimeAsync(0)
    const html = renderToStaticMarkup(createElement(PlayerMicrophoneMeters, { microphones: store }))
    expect(html.match(/data-mic-status="level"/g)).toHaveLength(2); expect(html.match(/>Singing</g)).toHaveLength(2)
    const app = source('src/renderer/src/box/App.tsx')
    expect(app).not.toMatch(/useSyncExternalStore\(microphones\.subscribe/)
    expect(app).not.toMatch(/microphoneSnapshot=/)
    store.dispose()
  })
  it('App never cancels capture when the UI unmounts or closes', () => {
    const app = source('src/renderer/src/box/App.tsx')
    expect(app).not.toMatch(/cancelCapture|microphones\.(start|stop|select|resetSelection)\b/)
    expect(app).toContain('return () => microphones.dispose()')
  })
})
