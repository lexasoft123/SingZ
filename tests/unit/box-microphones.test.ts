import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale } from '../../src/shared/i18n/core'
import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { moveSpatialFocus, remoteTargets } from '../../src/renderer/src/box/focus'
import { renderToStaticMarkup } from 'react-dom/server'
import { MICROPHONE_IDLE_POLL_MS, microphoneChannelLevel, microphoneSlotStatus, type MicrophoneSnapshot } from '../../src/renderer/src/box/microphones'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { PhysicalInputsPanel } from '../../src/renderer/src/box/Settings'
import { PlayerMicrophoneMeters } from '../../src/renderer/src/box/Player'
import { readJourneyAudioInventory } from '../../src/renderer/src/box/journeys/useInventory'
import { audioCounts } from '../../src/renderer/src/box/journeys/format'
import { device, fakeHost, legacy, memoryStorage, newStore } from './box-microphone-host-fake'

beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); await prepareBoxLocale('en') })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setLocale('en') })

async function connected(host = fakeHost(), storage = memoryStorage()) {
  const store = newStore(host, storage)
  store.connect(); await vi.advanceTimersByTimeAsync(0)
  return { host, store, storage }
}

describe('host-owned microphone analysis (read-only store)', () => {
  it('a new UI against a running host shows live levels and sends no command at all', async () => {
    const { host, store } = await connected()
    const snapshot = store.getSnapshot()
    expect(snapshot).toMatchObject({ phase: 'running', device: device.uid, active: { uid: device.uid, enabledChannels: [0, 1], generation: '5' } })
    expect(snapshot.levels?.channelIndices).toEqual([0, 1])
    expect(microphoneChannelLevel(snapshot, device.uid, 1)).toBe(0.5)
    expect(Object.keys(host.api).sort()).toEqual(['microphoneLevels', 'microphones', 'setMicrophoneSelection'])
    expect(host.api.setMicrophoneSelection).not.toHaveBeenCalled()
    store.dispose()
  })
  it('dispose only stops reading: no command, no further reads', async () => {
    const { host, store } = await connected()
    store.dispose(); const reads = host.api.microphones.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.api.microphones.mock.calls.length).toBe(reads)
    expect(host.api.setMicrophoneSelection).not.toHaveBeenCalled()
    expect(host.snapshot.phase).toBe('running')
  })
  it('reads levels at 20 Hz and state at 1 Hz while subscribed; only the slow state read when nothing is', async () => {
    const { host, store } = await connected()
    host.api.microphones.mockClear(); host.api.microphoneLevels.mockClear()
    await vi.advanceTimersByTimeAsync(4000)
    expect(host.api.microphones.mock.calls.length).toBe(4000 / MICROPHONE_IDLE_POLL_MS)
    expect(host.api.microphoneLevels).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1); // one slow timer, no 20 Hz wakeups while no meter is visible
    const unsubscribe = store.subscribe(() => undefined)
    host.api.microphones.mockClear(); host.api.microphoneLevels.mockClear()
    await vi.advanceTimersByTimeAsync(1000)
    expect(host.api.microphoneLevels.mock.calls.length).toBeGreaterThanOrEqual(19)
    expect(host.api.microphoneLevels.mock.calls.length).toBeLessThanOrEqual(21)
    expect(host.api.microphones.mock.calls.length).toBeLessThanOrEqual(2)
    unsubscribe()
    host.api.microphones.mockClear(); host.api.microphoneLevels.mockClear()
    await vi.advanceTimersByTimeAsync(4000)
    expect(host.api.microphoneLevels).not.toHaveBeenCalled()
    expect(host.api.microphones.mock.calls.length).toBe(4000 / MICROPHONE_IDLE_POLL_MS)
    store.dispose()
  })
  it('keeps showing live levels across a host process restart without sending anything', async () => {
    const { host, store } = await connected(); const unsubscribe = store.subscribe(() => undefined)
    host.setReachable(false); await vi.advanceTimersByTimeAsync(600)
    expect(store.getSnapshot()).toMatchObject({ phase: 'unreachable', levels: null, pitch: null })
    host.setReachable(true); host.restart(); await vi.advanceTimersByTimeAsync(400)
    expect(store.getSnapshot()).toMatchObject({ phase: 'running', epoch: 'e2', active: { generation: '9' } })
    expect(store.getSnapshot().levels?.generation).toBe('9')
    expect(host.api.setMicrophoneSelection).not.toHaveBeenCalled()
    unsubscribe(); store.dispose()
  })
  it('hides levels and pitch older than 750 ms, and a subscribed store does not trust an unconfirmed state', async () => {
    const { host, store } = await connected(); const unsubscribe = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(200)
    expect(store.getSnapshot().levels).not.toBeNull(); expect(store.getSnapshot().pitch).not.toBeNull()
    host.api.microphones.mockImplementation(() => new Promise(() => undefined)) // reads stall
    host.api.microphoneLevels.mockImplementation(() => new Promise(() => undefined))
    await vi.advanceTimersByTimeAsync(1000)
    expect(store.getSnapshot()).toMatchObject({ phase: 'unreachable', levels: null, pitch: null })
    unsubscribe(); store.dispose()
  })
  it('accepts levels only for a running host generation with exactly the enabled channels', async () => {
    const { host, store } = await connected(); const unsubscribe = store.subscribe(() => undefined)
    const bad = [
      { levels: { channelIndices: [0], peak: [0.5], rms: [0.1] } },                       // narrower than the enabled set
      { levels: { channelIndices: [0, 7], peak: [0.5, 0.5], rms: [0.1, 0.1] } },           // channel not enabled
      { levels: { channelIndices: [0, 1], peak: [0.5, Number.NaN], rms: [0.1, 0.1] } },    // invalid sample
      { generation: '0' },                                                                  // no capture generation
      { phase: 'starting' as const }                                                         // not running
    ]
    for (const patch of bad) {
      host.patch(patch); await vi.advanceTimersByTimeAsync(200)
      expect(store.getSnapshot().levels, JSON.stringify(patch)).toBeNull()
      host.patch({ generation: '5', phase: 'running', levels: { channelIndices: [0, 1], peak: [0.25, 0.5], rms: [0.1, 0.1] } }); await vi.advanceTimersByTimeAsync(200)
      expect(store.getSnapshot().levels).not.toBeNull()
    }
    unsubscribe(); store.dispose()
  })
  it('maps dense telemetry to physical channels for noncontiguous selections', async () => {
    const { store } = await connected(fakeHost({ channels: { [device.uid]: [2, 7] } }))
    expect(microphoneChannelLevel(store.getSnapshot(), device.uid, 2)).toBe(0.25)
    expect(microphoneChannelLevel(store.getSnapshot(), device.uid, 7)).toBe(0.5)
    expect(microphoneChannelLevel(store.getSnapshot(), device.uid, 0)).toBeNull()
    store.dispose()
  })
})

describe('selection edits by revision', () => {
  it('a channel toggle sends one revision compare-and-set and shows the host reply', async () => {
    const { host, store } = await connected()
    expect(await store.toggleChannel(device.uid, 4)).toBe(true)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledTimes(1)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith({ expectedRevision: '1', device: device.uid, channels: { [device.uid]: [0, 1, 4] } })
    expect(store.getSnapshot()).toMatchObject({ revision: '2', origin: 'user', phase: 'running', error: null, pending: false })
    expect(store.enabledChannels(device.uid)).toEqual([0, 1, 4])
    store.dispose()
  })
  it('turning off the last enabled channel is the explicit off (device null), and turning one on restores analysis', async () => {
    const { host, store } = await connected(fakeHost({ channels: { [device.uid]: [3] } }))
    expect(await store.toggleChannel(device.uid, 3)).toBe(true)
    expect(host.api.setMicrophoneSelection).toHaveBeenLastCalledWith({ expectedRevision: '1', device: null, channels: { [device.uid]: [] } })
    expect(store.getSnapshot()).toMatchObject({ phase: 'off', device: null, active: null, levels: null })
    expect(await store.toggleChannel(device.uid, 3)).toBe(true)
    expect(store.getSnapshot()).toMatchObject({ phase: 'running', device: device.uid })
    store.dispose()
  })
  it('enabling a channel on another device makes that device the active one', async () => {
    const { host, store } = await connected()
    expect(await store.toggleChannel('alsa:other', 0)).toBe(true)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith(expect.objectContaining({ device: 'alsa:other', channels: { [device.uid]: [0, 1], 'alsa:other': [0] } }))
    expect(store.enabledChannels(device.uid)).toEqual([]) // only the active device shows pressed channels
    store.dispose()
  })
  it('refuses a second edit while one is in flight', async () => {
    const { host, store } = await connected()
    let release!: () => void
    const real = host.api.setMicrophoneSelection.getMockImplementation()!
    host.api.setMicrophoneSelection.mockImplementationOnce(async edit => { await new Promise<void>(resolve => { release = resolve }); return real(edit) })
    const first = store.toggleChannel(device.uid, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().pending).toBe(true)
    expect(await store.toggleChannel(device.uid, 3)).toBe(false)
    release(); expect(await first).toBe(true)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().pending).toBe(false)
    store.dispose()
  })
  it('a stale revision shows the current host state, reports it, and does not retry on its own', async () => {
    const { host, store } = await connected()
    host.bumpRevision(device.uid, { [device.uid]: [5] })           // someone else edited
    expect(await store.toggleChannel(device.uid, 4)).toBe(false)
    expect(store.getSnapshot().error).toBe('The input selection changed elsewhere. Showing the current selection.')
    expect(store.enabledChannels(device.uid)).toEqual([5])
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledTimes(1)
    expect(await store.toggleChannel(device.uid, 4)).toBe(true)     // next press uses the fresh revision
    expect(store.getSnapshot().error).toBeNull()
    store.dispose()
  })
  it('a failed save leaves the displayed selection as the host has it', async () => {
    const { host, store } = await connected()
    host.failNextWrite('disk full')
    expect(await store.toggleChannel(device.uid, 4)).toBe(false)
    expect(store.getSnapshot().error).toBe('Could not save the input selection. disk full')
    expect(store.enabledChannels(device.uid)).toEqual([0, 1]); expect(store.getSnapshot().revision).toBe('1')
    store.dispose()
  })
  it('a slow read that began before an edit cannot undo it', async () => {
    const { host, store } = await connected()
    const stale = structuredClone(host.snapshot)
    let answer!: (value: unknown) => void
    host.api.microphones.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }) as never)
    await vi.advanceTimersByTimeAsync(2000) // idle poll starts and stalls
    expect(await store.toggleChannel(device.uid, 4)).toBe(true)
    answer({ ok: true, value: stale })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSnapshot().revision).toBe('2'); expect(store.enabledChannels(device.uid)).toEqual([0, 1, 4])
    store.dispose()
  })
  it('rejects sparse or out-of-range channel lists before sending', async () => {
    const { host, store } = await connected()
    const sparse = [0, 1, 7]; delete sparse[1]
    expect(await store.setEnabledChannels(device.uid, sparse)).toBe(false)
    expect(await store.setEnabledChannels(device.uid, [64])).toBe(false)
    expect(host.api.setMicrophoneSelection).not.toHaveBeenCalled(); store.dispose()
  })
})

describe('one-time migration of the old renderer-only channel preference', () => {
  it('imports it once while the host is still on its default, then removes the key', async () => {
    const storage = memoryStorage(legacy(['alsa:other', []], [device.uid, [7, 2]]))
    const { host, store } = await connected(fakeHost({ origin: 'default' }), storage)
    await vi.advanceTimersByTimeAsync(5000)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledTimes(1)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith({ expectedRevision: '1', device: device.uid, channels: { 'alsa:other': [], [device.uid]: [2, 7] } })
    expect(storage.data.has('singz-box.microphone-channels.v1')).toBe(false)
    expect(store.getSnapshot()).toMatchObject({ origin: 'user', device: device.uid }); store.dispose()
  })
  it('migrates to the device the old store analysed (inventory order), not the first key in the record', async () => {
    // The old store gave every enumerated device inputs 1-2; the onboard codec
    // happened to be recorded first while FLOW 8 is first in inventory.
    const storage = memoryStorage(legacy(['alsa:onboard', [0, 1]], [device.uid, [0, 1]]))
    const { host, store } = await connected(fakeHost({ origin: 'default' }), storage)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith({ expectedRevision: '1', device: device.uid,
      channels: { 'alsa:onboard': [0, 1], [device.uid]: [0, 1] } })
    store.dispose()
  })
  it('falls back to the first non-empty old entry when the host default device has none', async () => {
    const storage = memoryStorage(legacy(['alsa:onboard', [1]], [device.uid, []]))
    const { host, store } = await connected(fakeHost({ origin: 'default' }), storage)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith(expect.objectContaining({ device: 'alsa:onboard' }))
    store.dispose()
  })
  it('imports an old explicit all-off as device null', async () => {
    const storage = memoryStorage(legacy([device.uid, []]))
    const { host, store } = await connected(fakeHost(), storage)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledWith({ expectedRevision: '1', device: null, channels: { [device.uid]: [] } })
    expect(store.getSnapshot().phase).toBe('off'); store.dispose()
  })
  it('never overwrites a selection a person already made on the host, and drops the old key', async () => {
    const storage = memoryStorage(legacy([device.uid, [9]]))
    const { host, store } = await connected(fakeHost({ origin: 'user', channels: { [device.uid]: [0] } }), storage)
    expect(host.api.setMicrophoneSelection).not.toHaveBeenCalled()
    expect(storage.data.has('singz-box.microphone-channels.v1')).toBe(false)
    expect(store.enabledChannels(device.uid)).toEqual([0]); store.dispose()
  })
  it('keeps the old key when the host write fails, and does not hammer it', async () => {
    const storage = memoryStorage(legacy([device.uid, [4]]))
    const host = fakeHost(); host.failNextWrite('disk full')
    const { store } = await connected(host, storage)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(host.api.setMicrophoneSelection).toHaveBeenCalledTimes(1)
    expect(storage.data.has('singz-box.microphone-channels.v1')).toBe(true); store.dispose()
  })
  it('ignores an invalid old preference and unusable storage', async () => {
    const bad = memoryStorage({ version: 1, devices: [[device.uid, [99]]] })
    const a = await connected(fakeHost(), bad)
    expect(a.host.api.setMicrophoneSelection).not.toHaveBeenCalled(); a.store.dispose()
    const blocked = { getItem: () => { throw new Error('blocked') } }
    const b = await connected(fakeHost(), blocked as never)
    expect(b.host.api.setMicrophoneSelection).not.toHaveBeenCalled(); expect(b.store.getSnapshot().phase).toBe('running'); b.store.dispose()
  })
})

const withHost = (host: Partial<MicrophoneSnapshot>): MicrophoneSnapshot => ({
  phase: 'running', reason: '', detail: '', revision: '3', origin: 'user', epoch: 'e', device: device.uid,
  enabledChannelsByDevice: { [device.uid]: [0, 1] }, active: null, levels: null, pitch: null, pending: false, error: null, ...host })

describe('status stripe states', () => {
  const liveAt = (at = Date.now()): MicrophoneSnapshot => withHost({ phase: 'running', active: { uid: device.uid, label: 'FLOW 8', channels: 10, enabledChannels: [0, 1], analysisChannel: 0, generation: '5' },
    levels: { generation: '5', receivedAt: at, channelIndices: [0, 1], peak: [0.25, 0.5], rms: [0.1, 0.1] } })
  const live = liveAt(1000)
  it.each([
    ['running with a fresh level', live, 0, 'level'],
    ['all inputs off', withHost({ phase: 'off', device: null, enabledChannelsByDevice: { [device.uid]: [] } }), 0, 'off'],
    ['one input enabled leaves Mic 2 off', withHost({ phase: 'running', enabledChannelsByDevice: { [device.uid]: [3] } }), 1, 'off'],
    ['starting', withHost({ phase: 'starting' }), 0, 'starting'],
    ['not yet read', withHost({ phase: 'connecting' }), 0, 'starting'],
    ['device missing', withHost({ phase: 'waiting', reason: 'no-device' }), 1, 'no-input'],
    ['channels missing', withHost({ phase: 'waiting', reason: 'channels-unavailable' }), 0, 'no-input'],
    ['host error', withHost({ phase: 'error', reason: 'internal' }), 0, 'unavailable'],
    ['unsupported', withHost({ phase: 'error', reason: 'unsupported' }), 0, 'unavailable'],
    ['host unreachable', withHost({ phase: 'unreachable' }), 0, 'unavailable'],
    ['running without a valid level', { ...live, levels: null }, 0, 'unavailable']
  ] as const)('%s', (_name, snapshot, slot, kind) => { expect(microphoneSlotStatus(snapshot, slot, 1000).kind).toBe(kind) })
  it('Player stripe says Off, Starting…, Not connected or Unavailable instead of Unavailable for everything', () => {
    const text = (snapshot: MicrophoneSnapshot): string => renderToStaticMarkup(createElement(PlayerMicrophoneMeters, { snapshot }))
    expect(text(withHost({ phase: 'off', device: null }))).toContain('>Off<')
    expect(text(withHost({ phase: 'starting' }))).toContain('>Starting…<')
    expect(text(withHost({ phase: 'waiting', reason: 'no-device' }))).toContain('>Not connected<')
    expect(text(withHost({ phase: 'error', reason: 'internal' }))).toContain('>Unavailable<')
    expect(text(withHost({ phase: 'off', device: null }))).not.toContain('Unavailable')
    const html = text(liveAt())
    expect(html.match(/data-mic-status="level"/g)).toHaveLength(2)
  })
})

const routing = { version: 1 as const, inventory: { devicesFresh: true, devices: [{ uid: device.uid, name: device.label, inputChannels: 10, outputChannels: 4 }] },
  snapshot: { revision: { epoch: 'e', generation: '0' }, document: null, restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } } }
const preview = { state: routing as never, error: '', pending: false, receivedAt: Date.now() }
const panel = (store: ReturnType<typeof newStore>, snapshot = store.getSnapshot()): string => renderToStaticMarkup(createElement(PhysicalInputsPanel, {
  preview, selection: null, onSelect: vi.fn(), microphones: store, microphoneSnapshot: snapshot }))

describe('Settings inputs panel', () => {
  it('has one pressed-state button per channel, no Start/Stop/Cancel, and the automatic-analysis sentence', async () => {
    const { store } = await connected()
    const html = panel(store)
    expect(html).not.toMatch(/data-microphone-(start|stop|cancel)|Start analysis|Stop analysis|Cancel selection|data-remote-id|data-remote-down|data-remote-up/)
    expect(html.match(/data-input-channel=/g)).toHaveLength(10)
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2)
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(8)
    expect(html).toContain('Enabled inputs are analyzed automatically. Turn every input off to stop.')
    expect(html).toContain('Analysis: FLOW 8 · input 1')
    expect(html.match(/>Level unavailable</g)).toBeNull() // both enabled channels show live meters
    expect(html.match(/role="meter"/g)).toHaveLength(2)
    expect(html.match(/>Disabled</g)).toHaveLength(8)
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/)
    store.dispose()
  })
  it.each([
    ['off', { phase: 'off' as const, device: null }, 'Microphone analysis is off. Enable an input channel to turn it on.'],
    ['starting', { phase: 'starting' as const }, 'Starting microphone analysis…'],
    ['device missing', { phase: 'waiting' as const, reason: 'no-device' as const }, 'FLOW 8 is not connected. Analysis starts when it returns.'],
    ['channels missing', { phase: 'waiting' as const, reason: 'channels-unavailable' as const }, 'The enabled input channels are not available on FLOW 8. Analysis starts when they return.'],
    ['conflict', { phase: 'error' as const, reason: 'conflict' as const }, 'Another audio setting is using this input. Analysis will retry automatically.'],
    ['internal', { phase: 'error' as const, reason: 'internal' as const, detail: 'boom' }, 'Microphone analysis could not start and will retry. boom'],
    ['unreachable', { phase: 'unreachable' as const }, 'Audio service is reconnecting. Microphone levels return when it is back.']
  ])('explains %s with a sentence, never a button to press', async (_name, patch, sentence) => {
    const { store } = await connected()
    const html = panel(store, withHost(patch))
    expect(html).toContain(sentence.replace('…', '…')); expect(html).not.toContain('<button data-microphone')
    store.dispose()
  })
  it('keeps channel buttons focusable (aria-disabled, not disabled) while an edit is in flight', async () => {
    const { store } = await connected()
    const html = panel(store, withHost({ pending: true }))
    const button = html.match(/<button[^>]*data-input-channel="2"[^>]*>/)?.[0] ?? ''
    expect(button).toContain('aria-disabled="true"'); expect(button).not.toContain(' disabled')
    store.dispose()
  })
  it('only the active device shows pressed channels', async () => {
    const { store } = await connected(fakeHost({ device: null, channels: { [device.uid]: [0, 1] }, origin: 'user' }))
    expect(panel(store).match(/aria-pressed="true"/g)).toBeNull()
    store.dispose()
  })
  it.each([['ru', 'Микрофоны и входы', 'Включённые входы анализируются автоматически'], ['zh-CN', '麦克风和输入', '已启用的输入会自动分析']] as const)('localizes the panel in %s', async (locale, heading, automatic) => {
    const { store } = await connected()
    await prepareBoxLocale(locale)
    const html = panel(store)
    expect(html).toContain(heading); expect(html).toContain(automatic); expect(html).not.toContain('Analysis:')
    store.dispose()
  })
  it('renders live meters only for the active device from the host levels', async () => {
    const { store } = await connected()
    const html = panel(store)
    expect(html).toContain('aria-valuenow="0.25"'); expect(html).toContain('aria-valuenow="0.5"')
    store.dispose()
  })
})

describe('Settings channel remote targets', () => {
  it('uses one focus stop per row; Enter toggles once and the host answer re-renders pressed state', async () => {
    const { host, store } = await connected()
    let active: Target | null = null
    type Props = { disabled?: boolean; children?: ReactNode; onClick?: () => void; 'data-input-channel'?: number; 'aria-pressed'?: boolean }
    class Target {
      constructor(readonly props: Props) {}
      matches(selector: string): boolean { return selector === ':disabled' && !!this.props.disabled }
      closest(): null { return null }
      getClientRects(): object[] { return [{}] }
      getBoundingClientRect(): { left: number; top: number; width: number; height: number } { return { left: 0, top: Number(this.props['data-input-channel']) * 60, width: 400, height: 40 } }
      focus(): void { active = this }
      scrollIntoView(): void {}
      click(): void { if (!this.props.disabled) this.props.onClick?.() }
    }
    vi.stubGlobal('HTMLElement', Target)
    vi.stubGlobal('document', { get activeElement() { return active } })
    const targets = (): Target[] => {
      const found: Target[] = []
      const visit = (value: ReactNode): void => Children.forEach(value, element => {
        if (!isValidElement<Props>(element)) return
        if (element.props['data-input-channel'] !== undefined) found.push(new Target(element.props))
        visit(element.props.children)
      })
      visit(PhysicalInputsPanel({ preview, selection: null, onSelect: vi.fn(), microphones: store, microphoneSnapshot: store.getSnapshot() }))
      return found
    }
    let buttons = targets()
    const scope = { dataset: { surface: 'settings' }, querySelectorAll: () => buttons } as unknown as HTMLElement
    expect(remoteTargets(scope)).toHaveLength(10)
    expect(buttons[0].props['aria-pressed']).toBe(true)
    const toggles = vi.spyOn(store, 'toggleChannel')
    active = buttons[0]; active.click(); await vi.advanceTimersByTimeAsync(0)
    expect(toggles).toHaveBeenCalledTimes(1); expect(host.api.setMicrophoneSelection).toHaveBeenCalledTimes(1)
    expect(store.enabledChannels(device.uid)).toEqual([1])
    buttons = targets(); active = buttons[0]
    expect(buttons[0].props['aria-pressed']).toBe(false); expect(buttons[0].props.disabled).toBe(false)
    expect(moveSpatialFocus(scope, 'ArrowDown')).toBe(true); expect(active).toBe(buttons[1])
    expect(remoteTargets(scope)).toHaveLength(10)
    store.dispose()
  })
})

describe('Home physical input count without fabricated playback devices', () => {
  const virtual = { ok: true as const, platform: 'linux' as const, provider: 'alsa' as const, defaultInputUid: '', defaultOutputUid: 'native:singz', devices: [] }
  const flow = { uid: device.uid, label: device.label, channels: 10, channelLabels: [], sampleRate: 48000, isDefault: true }
  it('reads physical capture inventory separately and keeps the song output identity', async () => {
    const api = { audioHostDevices: vi.fn(async () => virtual), captureInputDevices: vi.fn(async () => ({ ok: true as const, devices: [flow] })) }
    const result = await readJourneyAudioInventory(api, true)
    expect(result.devices).toBe(virtual.devices); expect(result.defaultOutputUid).toBe('native:singz')
    expect(audioCounts(result).inputs).toBe(1)
  })
  it('does not report zero when physical inventory is unavailable, or query it for Desktop', async () => {
    const api = { audioHostDevices: vi.fn(async () => virtual), captureInputDevices: vi.fn(async () => ({ ok: false as const, devices: [] as [], error: 'Disconnected' })) }
    const result = await readJourneyAudioInventory(api, true)
    expect(result.physicalInputCount).toBeNull(); expect(result.physicalInputError).toBe('Disconnected')
    api.captureInputDevices.mockClear()
    expect(await readJourneyAudioInventory(api, false)).toBe(virtual)
    expect(api.captureInputDevices).not.toHaveBeenCalled()
  })
})
