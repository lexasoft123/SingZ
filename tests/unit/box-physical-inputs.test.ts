import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BoxResult, BoxRoutingMeter, BoxRoutingState } from '../../src/shared/box-contract'
import type { DesktopAudioHostInventoryResult } from '../../src/shared/types'
import { Settings, PhysicalInputsPanel } from '../../src/renderer/src/box/Settings'
import * as model from '../../src/renderer/src/box/physical-inputs-model'
import { validRoutingState } from '../../src/main/box/routing'
import { microphoneRouteCommands, musicOutputCommands } from '../../src/renderer/src/box/routing-model'

const meter = (channels: number, peak = 0.4): BoxRoutingMeter => ({ valid: true, channels, frames: 256,
  peak: Array(channels).fill(peak), rms: Array(channels).fill(peak / 2) })
const state = (): BoxRoutingState => ({ version: 1,
  inventory: { devicesFresh: true, devicesError: '', devices: [
    { uid: 'alsa:flow8', name: 'FLOW 8', inputChannels: 10, outputChannels: 4,
      inputChannelNames: ['Mic One', 'Mic Two', 'Mic Three', 'Mic Four', 'Line 5', 'Line 6', 'Line 7', 'Line 8', 'Main L', 'Main R'],
      outputChannelNames: ['USB 1', 'USB 2', 'USB 3', 'USB 4'], defaultInput: true, defaultOutput: true, rate: 48000 }
  ] }, snapshot: { revision: { epoch: 'epoch-a', generation: '1' },
    document: { devices: [{ id: 'mix', name: 'Live mix', routing: { outputChannels: 2, sources: [
      { id: 'mic', channels: 10, gain: 0.5, enabled: true, muted: false, connections: [{ sourceChannel: 2, outputChannel: 0, gain: 1 }] }
    ] }, bindings: [{ id: 'mic', kind: 'input-device', selector: 'alsa:flow8' }], monitors: [] }] },
    restoration: { phase: 'restored', error: '', desiredGeneration: '1', activeGeneration: '1' },
    runtime: { metersFresh: true, monitors: [{ device: 'mix', monitor: 'speaker', sourceOnline: true, meter: { valid: true, peak: [0.99, 0.99] } }],
      devices: [{ id: 'mix', active: true, meter: meter(2, 0.95), sources: [{ id: 'mic', online: true, missingFrames: '0', meter: meter(10) }] }] }
  }
})
const preview = (value = state()): model.RoutingPreview => ({ state: value, error: '', pending: false, receivedAt: 1000 })
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('physical microphone inventory and source levels', () => {
  it('shows all ten named physical channels even when the song producer has zero inputs', () => {
    const value = preview()
    const controller = new model.PhysicalRoutingPreview({ read: vi.fn(), edit: vi.fn() })
    vi.spyOn(model, 'usePhysicalRoutingPreview').mockReturnValue({ preview: value, controller })
    vi.stubGlobal('window', { singz: { boxAudioPersistent: true } })
    const inventory: DesktopAudioHostInventoryResult = { ok: true, platform: 'linux', provider: 'alsa', defaultInputUid: '', defaultOutputUid: 'native:singz', devices: [{
      uid: 'native:singz', label: 'Song producer', defaultInput: false, defaultOutput: true,
      inputChannels: 0, outputChannels: 2, inputChannelLabels: [], outputChannelLabels: ['L', 'R'], nominalSampleRate: 48000,
      direction: 'output', transport: 'virtual', accessMode: 'exclusive', monitoringSuitability: 'unknown', sampleRateRanges: [],
      bufferFrames: { minimumFrames: 256, maximumFrames: 256, preferredFrames: 256, fundamentalFrames: 0 }
    }] }
    const apply = vi.fn()
    const html = renderToStaticMarkup(createElement(Settings, { inventory, loading: false, error: null, currentOutputUid: 'native:singz', playbackActive: true,
      onRefresh: vi.fn(), onApplyOutput: apply, onBack: vi.fn() }))
    expect(html).toContain('FLOW 8'); expect(html).toContain('Input channels: 10')
    expect(html.match(/data-input-channel=/g)).toHaveLength(10)
    expect(html).toContain('Mic Three'); expect(html).toContain('Main R')
    expect(html).toContain('data-settings-output="native:singz"')
    expect(html).not.toContain('data-settings-output="alsa:flow8"')
    expect(apply).not.toHaveBeenCalled()
    expect(html).toContain('Pitch analysis is currently unavailable')
    vi.stubGlobal('window', { singz: { boxAudioPersistent: false } })
    const oldMode = renderToStaticMarkup(createElement(Settings, { inventory, loading: false, error: null, currentOutputUid: 'native:singz', playbackActive: false,
      onRefresh: vi.fn(), onApplyOutput: apply, onBack: vi.fn() }))
    expect(oldMode).not.toContain('FLOW 8')
    expect(oldMode.match(/data-input-channel=/g)).toBeNull()
  })
  it('uses pre-fader input source meter, never the aggregate output meter', () => {
    expect(model.physicalInputLevel(preview(), 'alsa:flow8', 0, 1000)).toEqual({ peak: 0.4, rms: 0.2 })
    const value = state(); value.snapshot.runtime.devices![0].sources = []
    expect(model.physicalInputLevel(preview(value), 'alsa:flow8', 2, 1000)).toBeNull()
  })
  it.each(['stale', 'inventory', 'offline', 'inactive', 'invalid-meter', 'read-error', 'expired', 'no-route', 'disconnected', 'generation'] as const)('reports unavailable for %s', reason => {
    const value = preview()
    if (reason === 'stale') value.state!.snapshot.runtime.metersFresh = false
    if (reason === 'inventory') value.state!.inventory.devicesFresh = false
    if (reason === 'offline') value.state!.snapshot.runtime.devices![0].sources[0].online = false
    if (reason === 'inactive') value.state!.snapshot.runtime.devices![0].active = false
    if (reason === 'invalid-meter') value.state!.snapshot.runtime.devices![0].sources[0].meter.valid = false
    if (reason === 'read-error') value.error = 'Offline'
    if (reason === 'expired') value.receivedAt = 0
    if (reason === 'no-route') value.state!.snapshot.document = null
    if (reason === 'disconnected') value.state!.inventory.devices = []
    if (reason === 'generation') value.state!.snapshot.restoration.activeGeneration = '0'
    expect(model.physicalInputLevel(value, 'alsa:flow8', 2, 2000)).toBeNull()
  })
  it('distinguishes unavailable inventory and absent analysis from a measured zero', () => {
    const value = preview(); value.state!.inventory.devicesFresh = false; value.state!.inventory.devicesError = 'Interface disconnected'
    const html = renderToStaticMarkup(createElement(PhysicalInputsPanel, { preview: value, selection: null, onSelect: vi.fn() }))
    expect(html).toContain('Interface disconnected'); expect(html).toContain('FLOW 8')
    expect(html).toContain('Level unavailable'); expect(html).not.toContain('role="meter"')
    expect(html).toContain('Pitch analysis is currently unavailable')
  })
  it('preserves selected physical identity/channel across reordering and rejects missing channels', () => {
    const value = state()
    const selected = model.selectPhysicalChannel(value, 'alsa:flow8', 9)!
    value.inventory.devices.unshift({ uid: 'alsa:other', name: 'Other', inputChannels: 2, outputChannels: 2 })
    expect(model.selectPhysicalChannel(value, selected.uid, selected.channel)).toEqual(selected)
    value.inventory.devices.find(row => row.uid === selected.uid)!.inputChannels = 2
    expect(model.selectPhysicalChannel(value, selected.uid, selected.channel)).toBeNull()
    expect(model.cyclePhysicalDevice(value.inventory.devices, selected.uid)).toBe('alsa:other')
  })
  it('never applies routes against explicitly stale physical inventory', () => {
    const value = state(); value.inventory.devicesFresh = false
    expect(() => musicOutputCommands(value, 'alsa:flow8', 0)).toThrow('inventory')
    expect(() => microphoneRouteCommands(value, 'alsa:flow8', 0, 'alsa:flow8', 0)).toThrow('inventory')
  })
})

describe('visible serialized routing preview', () => {
  it('polls at5Hz without overlapping reads or creating implicit microphone routes', async () => {
    vi.useFakeTimers()
    const pending = deferred<BoxResult<BoxRoutingState>>()
    const read = vi.fn(() => pending.promise); const edit = vi.fn()
    const controller = new model.PhysicalRoutingPreview({ read, edit }, () => 1000)
    controller.start()
    await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenCalledTimes(1)
    pending.resolve({ ok: true, value: state() }); await controller.refresh()
    const selected = model.selectPhysicalChannel(controller.getSnapshot().state, 'alsa:flow8', 2)
    await vi.advanceTimersByTimeAsync(600)
    expect(read).toHaveBeenCalledTimes(4)
    expect(selected).toEqual({ uid: 'alsa:flow8', channel: 2 })
    expect(edit).not.toHaveBeenCalled()
    controller.stop(); await vi.advanceTimersByTimeAsync(1000)
    expect(read).toHaveBeenCalledTimes(4)
  })
  it('hides old levels on read failure and ignores a hidden/unmounted reply', async () => {
    vi.useFakeTimers()
    const read = vi.fn<() => Promise<BoxResult<BoxRoutingState>>>().mockResolvedValueOnce({ ok: true, value: state() }).mockRejectedValueOnce(new Error('Disconnected'))
    const pending = deferred<BoxResult<BoxRoutingState>>(); read.mockImplementation(() => pending.promise)
    const controller = new model.PhysicalRoutingPreview({ read, edit: vi.fn() }, () => 1000)
    controller.start(); await controller.refresh()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.getSnapshot().receivedAt).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    controller.setVisible(false)
    pending.resolve({ ok: true, value: state() }); await controller.refresh()
    expect(controller.getSnapshot().receivedAt).toBeNull()
    const calls = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(calls)
    controller.stop()
  })
  it('waits for outstanding reads before edits, preserves drafts and revokes queued edits on unmount', async () => {
    vi.useFakeTimers()
    const first = state(); const pending = deferred<BoxResult<BoxRoutingState>>()
    const read = vi.fn().mockResolvedValueOnce({ ok: true, value: first }).mockImplementation(() => pending.promise)
    const edit = vi.fn(async () => ({ ok: true as const, value: first }))
    const controller = new model.PhysicalRoutingPreview({ read, edit }, () => 1000)
    controller.start(); await controller.refresh()
    await vi.advanceTimersByTimeAsync(200)
    const selected = model.selectPhysicalChannel(first, 'alsa:flow8', 2)
    const operation = controller.edit(first.snapshot.revision, [{ type: 'explicit-user-action' }])
    expect(controller.getSnapshot().pending).toBe(true)
    await vi.advanceTimersByTimeAsync(600); expect(edit).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledTimes(2)
    controller.stop(); pending.resolve({ ok: true, value: first })
    expect(await operation).toBe(false); expect(edit).not.toHaveBeenCalled()
    expect(selected).toEqual({ uid: 'alsa:flow8', channel: 2 })
  })
  it('reads only while visible and accepts one explicit edit using its native returned state', async () => {
    vi.useFakeTimers()
    let current = state()
    const read = vi.fn(async () => ({ ok: true as const, value: current }))
    const edit = vi.fn(async () => {
      current = state(); current.snapshot.revision.generation = '2'
      return { ok: true as const, value: current }
    })
    const controller = new model.PhysicalRoutingPreview({ read, edit }, () => 1000)
    controller.start(false); await vi.advanceTimersByTimeAsync(1000)
    expect(read).not.toHaveBeenCalled()
    controller.setVisible(true); await controller.refresh()
    const commands = [{ type: 'explicit-user-action' }]
    expect(await controller.edit(current.snapshot.revision, commands)).toBe(true)
    expect(edit).toHaveBeenCalledTimes(1)
    expect(edit.mock.calls[0]).toEqual([{ expected: { epoch: 'epoch-a', generation: '1' }, commands }])
    expect(controller.getSnapshot().state!.snapshot.revision.generation).toBe('2')
    expect(controller.getSnapshot().pending).toBe(false)
    controller.setVisible(false); const calls = read.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000); expect(read).toHaveBeenCalledTimes(calls)
    expect(controller.getSnapshot().receivedAt).toBeNull()
    controller.stop()
  })
  it('discards old-mount replies and recovers with a new service snapshot without overlapping them', async () => {
    vi.useFakeTimers()
    const old = deferred<BoxResult<BoxRoutingState>>()
    const newer = state(); newer.snapshot.revision.epoch = 'new-service'
    const read = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ ok: true, value: newer })
    const controller = new model.PhysicalRoutingPreview({ read, edit: vi.fn() }, () => 1000)
    controller.start(); controller.stop(); controller.start()
    await vi.advanceTimersByTimeAsync(400); expect(read).toHaveBeenCalledTimes(1)
    old.resolve({ ok: true, value: state() }); await controller.refresh()
    expect(controller.getSnapshot().state).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(controller.getSnapshot().state!.snapshot.revision.epoch).toBe('new-service')
    controller.stop()
  })
  it('fails closed if an in-flight read changes the service epoch before an explicit edit', async () => {
    vi.useFakeTimers()
    const initial = state(); const newer = state(); newer.snapshot.revision.epoch = 'epoch-b'
    const pending = deferred<BoxResult<BoxRoutingState>>()
    const read = vi.fn().mockResolvedValueOnce({ ok: true, value: initial }).mockImplementation(() => pending.promise)
    const edit = vi.fn(); const controller = new model.PhysicalRoutingPreview({ read, edit }, () => 1000)
    controller.start(); await controller.refresh(); await vi.advanceTimersByTimeAsync(200)
    const operation = controller.edit(initial.snapshot.revision, [{}])
    pending.resolve({ ok: true, value: newer })
    expect(await operation).toBe(false); expect(edit).not.toHaveBeenCalled()
    expect(controller.getSnapshot().error).toContain('changed')
    controller.stop()
  })
})

describe('physical routing wire validation', () => {
  it('accepts actual source meter/channel fields and older optional-field snapshots', () => {
    expect(validRoutingState(state())).toBe(true)
    const old = state(); delete old.snapshot.runtime.devices; delete old.inventory.devicesFresh; delete old.inventory.devicesError
    delete old.inventory.devices[0].inputChannelNames; delete old.inventory.devices[0].rate
    expect(validRoutingState(old)).toBe(true)
  })
  it.each(['nan-level', 'negative-level', 'oversized-meter', 'wrong-length', 'bad-frame', 'bad-label', 'bad-freshness'] as const)('rejects %s', bad => {
    const value = state()
    const m = value.snapshot.runtime.devices![0].sources[0].meter
    if (bad === 'nan-level') m.peak[0] = Number.NaN
    if (bad === 'negative-level') m.rms[0] = -1
    if (bad === 'oversized-meter') m.channels = 65
    if (bad === 'wrong-length') m.peak.pop()
    if (bad === 'bad-frame') m.frames = -1
    if (bad === 'bad-label') value.inventory.devices[0].inputChannelNames = ['bad\0label']
    if (bad === 'bad-freshness') (value.inventory as any).devicesFresh = 'true'
    expect(validRoutingState(value)).toBe(false)
  })
})
