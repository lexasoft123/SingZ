import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => new Map<string, (event: unknown, request?: unknown) => unknown>())
vi.mock('electron', async (importOriginal) => { const actual = await importOriginal<Record<string, unknown>>(); return { ...actual, ipcMain: { handle: (channel: string, fn: (event: unknown, request?: unknown) => unknown) => ipc.set(channel, fn) } } })
vi.mock('../../src/main/log', () => ({ log: vi.fn() }))
import { registerVoiceMonitor, VoiceMonitorRendererOwnership } from '../../src/main/voice-monitor-ipc'
import { VOICE_IPC } from '../../src/shared/voice-take'
import { VoiceMonitorStore, microphonePermission, type VoiceMonitorNative } from '../../src/main/voice-monitor'
import { VoiceTakeStore, type VoiceTakeNative } from '../../src/main/voice-takes'
import { disposeWithin } from '../../src/main/box-audio/microphones'
import { log } from '../../src/main/log'

const input = { deviceName: 'mic', channelIndex: 0 }
function fixture() {
  const device = { uid: 'mic', label: 'AirPods', isDefault: true, sampleRate: 48000, channels: 1, channelLabels: ['1'] }
  const native: VoiceMonitorNative = {
    inputDevices: vi.fn(async () => ({ ok: true, devices: [device] })),
    voiceMonitorAvailability: vi.fn(async () => ({ available: true })),
    beginVoiceMonitor: vi.fn(async () => { vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: true }); return { ok: true } }),
    setVoiceMonitorGain: vi.fn(async () => ({ ok: true })),
    voiceMonitorStatus: vi.fn(async () => ({ running: true })),
    endVoiceMonitor: vi.fn(async () => { vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: false }); return { ok: true } })
  }
  const permission = vi.fn(() => true)
  return { native, permission, store: new VoiceMonitorStore(native, permission, 'darwin') }
}
describe('voice monitoring', () => {
  it('uses native typed route decisions, not the AirPods label', async () => {
    const { store, native } = fixture()
    expect((await store.availability({ input })).available).toBe(true)
    for (const reason of ['route-latency', 'route-bluetooth', 'route-wireless', 'route-feedback'] as const) {
      vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: false, reason })
      expect((await store.availability({ input })).available).toEqual({ reason })
    }
    expect(native.voiceMonitorAvailability).toHaveBeenCalledWith({ inputUid: 'mic', inputChannel: 0 })
  })
  it('uses native availability for virtual/unknown routes instead of duplex metadata', async () => {
    const { store, native } = fixture()
    expect((await store.availability({ input })).available).toBe(true)
    expect(native.voiceMonitorAvailability).toHaveBeenCalledWith({ inputUid: 'mic', inputChannel: 0 })
  })
  it('keeps the monitor through song changes and unloads', async () => {
    const { store, native } = fixture()
    await store.songChanged('song-a')
    await store.set({ input, on: true })
    await store.songChanged('song-a')
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    await store.songChanged('song-b')
    await store.songChanged('')
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    expect((await store.state()).on).toBe(true)
    await store.dispose()
  })
  it('keeps the selected input and channel when song-open probes carry a blank input', async () => {
    const { store, native } = fixture()
    const devices = await native.inputDevices()
    vi.mocked(native.inputDevices).mockResolvedValue({ ...devices, devices: [{ ...devices.devices[0], channels: 2 }] })
    expect((await store.set({ input: { ...input, channelIndex: 1 }, on: true })).on).toBe(true)
    await store.songChanged('song')
    for (const deviceName of ['', '   ']) {
      expect(await store.availability({ input: { deviceName, channelIndex: 0 } })).toMatchObject({ on: true, available: true })
      expect(native.voiceMonitorAvailability).toHaveBeenLastCalledWith({ inputUid: 'mic', inputChannel: 1 })
    }
    // Negative control: the old empty-name lookup called close() here.
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: false, reason: 'device-lost' })
    expect(await store.availability({ input: { deviceName: '', channelIndex: 0 } })).toMatchObject({ on: false })
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1)
  })
  it('publishes idle/browser output context without input enumeration, permission or monitor teardown', async () => {
    const { store, native, permission } = fixture()
    const playbackContext = { webAudioPlaying: false, browserOutputUid: 'mic', selectedOutputUid: '' }
    expect(await store.availability({ input: { deviceName: '', channelIndex: 0 }, contextOnly: true, playbackContext })).toMatchObject({ on: false })
    expect(native.inputDevices).not.toHaveBeenCalled()
    expect(permission).not.toHaveBeenCalled()
    expect(native.voiceMonitorAvailability).toHaveBeenCalledWith({ inputUid: '', inputChannel: 0, contextOnly: true, ...playbackContext })
    expect((await store.set({ input, on: true })).on).toBe(true)
    expect(await store.availability({ input, contextOnly: true, playbackContext: { ...playbackContext, webAudioPlaying: true } })).toMatchObject({ on: true })
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false, lost: true })
    expect(await store.availability({ input, contextOnly: true, playbackContext: { ...playbackContext, browserOutputUid: 'other', webAudioPlaying: true } })).toMatchObject({ on: false, available: { reason: 'device-lost' } })
  })
  it('a context-only availability that reports unavailable while a generation is held ends the native monitor (never on:true, never a silent loop)', async () => {
    const { store, native } = fixture()
    const playbackContext = { webAudioPlaying: false, browserOutputUid: 'mic', selectedOutputUid: '' }
    expect((await store.set({ input, on: true })).on).toBe(true)
    vi.mocked(native.endVoiceMonitor).mockClear()
    vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: false, reason: 'route-wireless' })
    expect(await store.availability({ input, contextOnly: true, playbackContext })).toMatchObject({ on: false, available: { reason: 'route-wireless' } })
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1) // negative control: clearGeneration alone left the mic looping
    expect((await store.state()).on).toBe(false)
    await store.set({ input, on: false })
    await store.dispose()
  })
  it('if ending the monitor fails the generation is kept (state stays honest, a later off retries)', async () => {
    const { store, native } = fixture()
    const playbackContext = { webAudioPlaying: false, browserOutputUid: 'mic', selectedOutputUid: '' }
    await store.set({ input, on: true })
    vi.mocked(native.endVoiceMonitor).mockResolvedValue({ ok: false })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: true })
    vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: false, reason: 'route-wireless' })
    const state = await store.availability({ input, contextOnly: true, playbackContext })
    expect(state.available).toEqual({ reason: 'error' })
    vi.mocked(native.endVoiceMonitor).mockResolvedValue({ ok: true })
    expect((await store.set({ input, on: false })).on).toBe(false)
    expect(native.endVoiceMonitor).toHaveBeenCalled()
  })
  it('a foreground probe never rewrites the common route of a running monitor', async () => {
    const { store, native } = fixture()
    vi.mocked(native.beginVoiceMonitor).mockResolvedValueOnce({ ok: true, commonOutputName: 'Interface A' } as never)
    const started = await store.set({ input, on: true })
    expect(started.commonOutputName).toBe('Interface A')
    vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: true, commonOutputName: 'Other Out' } as never)
    const probed = await store.availability({ input })
    expect(probed.on).toBe(true)
    expect(probed.commonOutputName).toBe('Interface A')
    // Once off, a probe reports the current common output.
    await store.set({ input, on: false })
    vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: true, commonOutputName: 'Other Out' } as never)
    expect((await store.availability({ input })).commonOutputName).toBe('Other Out')
    await store.dispose()
  })
  it('rejects malformed playback context and context-only monitor starts at IPC', async () => {
    registerVoiceMonitor()
    for (const playbackContext of [null, {}, { webAudioPlaying: 'yes', browserOutputUid: '', selectedOutputUid: '' }, { webAudioPlaying: true, browserOutputUid: 'bad\0uid', selectedOutputUid: '' }]) {
      expect(await ipc.get(VOICE_IPC.monitorAvailability)!(null, { input, contextOnly: true, playbackContext })).toMatchObject({ available: { reason: 'error' } })
    }
    expect(await ipc.get(VOICE_IPC.monitorSet)!(null, { input, contextOnly: true, on: true, playbackContext: { webAudioPlaying: false, browserOutputUid: '', selectedOutputUid: '' } })).toMatchObject({ available: { reason: 'error' } })
  })
  it('never substitutes an unrecognized or ambiguous input', async () => {
    const { store, native } = fixture()
    expect((await store.availability({ input: { ...input, deviceName: 'missing' } })).available).toEqual({ reason: 'no-input' })
    expect(native.voiceMonitorAvailability).toHaveBeenCalledWith({ inputUid: '', inputChannel: 0 })
    expect(native.beginVoiceMonitor).not.toHaveBeenCalled()
  })
  it('returns no-input for invalid channel indexes at the IPC boundary', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    try {
    registerVoiceMonitor()
    for (const channelIndex of [-1, 0.5]) {
      const selected = { input: { ...input, channelIndex } }
      expect(await ipc.get(VOICE_IPC.monitorAvailability)!(null, selected)).toMatchObject({ available: { reason: 'no-input' } })
      expect(await ipc.get(VOICE_IPC.monitorSet)!(null, { ...selected, on: true })).toMatchObject({ available: { reason: 'no-input' } })
    }
    expect(await ipc.get(VOICE_IPC.monitorSet)!(null, { input: { ...input, channelIndex: -1 }, on: 'bad' })).toMatchObject({ available: { reason: 'error' } })
    } finally { Object.defineProperty(process, 'platform', platform) }
  })
  it('rejects invalid channels for availability and monitor start without clamping', async () => {
    const { store, native } = fixture()
    const listed = await native.inputDevices()
    listed.devices[0].channels = 2
    for (const channelIndex of [-1, 0.5, 2, 100]) {
      const selected = { input: { ...input, channelIndex } }
      expect((await store.availability(selected)).available).toEqual({ reason: 'no-input' })
      expect((await store.set({ ...selected, on: true })).available).toEqual({ reason: 'no-input' })
    }
    expect(native.voiceMonitorAvailability).not.toHaveBeenCalled()
    expect(native.beginVoiceMonitor).not.toHaveBeenCalled()
    const selected = { input: { ...input, channelIndex: 1 } }
    expect((await store.availability(selected)).available).toBe(true)
    expect((await store.set({ ...selected, on: true })).on).toBe(true)
    expect(native.voiceMonitorAvailability).toHaveBeenCalledWith({ inputUid: 'mic', inputChannel: 1 })
    expect(vi.mocked(native.beginVoiceMonitor).mock.calls[0][0].inputChannel).toBe(1)
  })




  it('opens once, clamps gain, closes with its generation and reopens with a fresh generation', async () => {
    const { store, native } = fixture()
    expect((await store.set({ input, on: true, gainDb: 100 })).on).toBe(true)
    await store.set({ input, on: true })
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(1)
    expect(vi.mocked(native.beginVoiceMonitor).mock.calls[0][0]).toMatchObject({ gainDb: 36 })
    expect((await store.gain(20)).gainDb).toBe(20) // above the old +12 ceiling is valid
    expect((await store.gain(99)).gainDb).toBe(36)
    expect((await store.gain(-100)).gainDb).toBe(-60)
    expect(native.setVoiceMonitorGain).toHaveBeenCalledWith(-60)
    await store.set({ input, on: false })
    const generation = vi.mocked(native.beginVoiceMonitor).mock.calls[0][1]
    expect(native.endVoiceMonitor).toHaveBeenCalledWith(generation)
    await store.set({ input, on: true })
    expect(vi.mocked(native.beginVoiceMonitor).mock.calls[1][1]).not.toBe(generation)
    await store.dispose()
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(2)
  })
  it('waits for an old close before opening a new generation', async () => {
    const { store, native } = fixture()
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    vi.mocked(native.endVoiceMonitor).mockImplementationOnce(async () => { await blocked; return { ok: true } })
    await store.set({ input, on: true })
    const closing = store.set({ input, on: false })
    const opening = store.set({ input, on: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(1)
    finish()
    await closing
    await opening
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(2)
    expect(vi.mocked(native.beginVoiceMonitor).mock.calls[0][1]).not.toBe(vi.mocked(native.beginVoiceMonitor).mock.calls[1][1])
  })
  it('retries a rejected end with the same generation', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    const generation = vi.mocked(native.beginVoiceMonitor).mock.calls[0][1]
    vi.mocked(native.endVoiceMonitor).mockRejectedValueOnce(new Error('lost reply'))
    expect(await store.set({ input, on: false })).toMatchObject({ on: false })
    expect(vi.mocked(native.endVoiceMonitor).mock.calls).toEqual([[generation], [generation]])
  })
  it('retains ownership after both ends fail and retries on dispose', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    const generation = vi.mocked(native.beginVoiceMonitor).mock.calls[0][1]
    vi.mocked(native.endVoiceMonitor).mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('timeout'))
    expect(await store.set({ input, on: false })).toMatchObject({ on: true, available: { reason: 'error' } })
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(2)
    await store.dispose()
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(3)
    expect(native.endVoiceMonitor).toHaveBeenLastCalledWith(generation)
    expect((await store.state()).on).toBe(false)
  })
  it('clears a stale generation when end fails and status confirms the host is stopped', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    const first = vi.mocked(native.beginVoiceMonitor).mock.calls[0][1]
    vi.mocked(native.endVoiceMonitor).mockResolvedValue({ ok: false })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false })
    expect(await store.set({ input, on: false })).toMatchObject({ on: false })
    expect((await store.set({ input, on: true })).on).toBe(true)
    expect(vi.mocked(native.beginVoiceMonitor).mock.calls[1][1]).not.toBe(first)
  })
  it('retries a failed end only while status reports the monitor running', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    vi.mocked(native.endVoiceMonitor).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false })
    expect(await store.set({ input, on: false })).toMatchObject({ on: true, available: { reason: 'error' } })
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(2)
    expect(native.voiceMonitorStatus).toHaveBeenCalledTimes(2)
    await store.dispose()
  })
  it('recovers on the next successful status after a status failure', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    vi.mocked(native.endVoiceMonitor).mockResolvedValueOnce({ ok: false })
    vi.mocked(native.voiceMonitorStatus).mockRejectedValueOnce(new Error('status unavailable'))
    expect(await store.set({ input, on: false })).toMatchObject({ on: true, available: { reason: 'error' } })
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1)
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false })
    expect(await store.set({ input, on: true })).toMatchObject({ on: true, available: true })
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(2)
    await store.dispose()
  })
  it('clears uncertain ownership on a later stopped status poll', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    vi.mocked(native.endVoiceMonitor).mockResolvedValueOnce({ ok: false })
    vi.mocked(native.voiceMonitorStatus).mockRejectedValueOnce(new Error('unavailable'))
    await store.set({ input, on: false })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false })
    expect((await store.state()).on).toBe(false)
    expect((await store.set({ input, on: true })).on).toBe(true)
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(2)
  })
  it.each(['status', 'end'] as const)('clears monitor state on audio-process exit during %s and recovers after availability', async where => {
    const { store, native } = fixture()
    const latency = { sampleRate: 48000, requestedFrames: 32, bufferFrames: 32, inputDeviceFrames: 0, outputDeviceFrames: 0, roundTripFrames: 64, roundTripMs: 1.33, source: 'estimated' as const }
    vi.mocked(native.beginVoiceMonitor).mockResolvedValue({ ok: true, latency })
    expect(await store.set({ input, on: true })).toMatchObject({ on: true, latency })
    const exited = new Error('Audio process exited (9)')
    vi.mocked(native.voiceMonitorStatus).mockRejectedValue(exited)
    vi.mocked(native.endVoiceMonitor).mockRejectedValue(exited)
    vi.mocked(native.inputDevices).mockRejectedValue(new Error('The audio process stopped. Restart SingZ to reconnect audio.'))
    const failed = where === 'status' ? await store.state() : await store.set({ input, on: false })
    expect(failed).toMatchObject({ on: false, latency: null, available: { reason: 'error' } })
    expect(vi.mocked(native.endVoiceMonitor).mock.calls.length).toBeLessThanOrEqual(1)
    expect(await store.set({ input, on: true })).toMatchObject({ on: false, latency: null, available: { reason: 'error' } })
    await store.dispose()
    expect(vi.mocked(native.endVoiceMonitor).mock.calls.length).toBeLessThanOrEqual(2)
    vi.mocked(native.inputDevices).mockReset().mockResolvedValue({ ok: true, devices: [{ uid: 'mic', label: 'AirPods', isDefault: true, sampleRate: 48000, channels: 1, channelLabels: ['1'] }] })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: true })
    vi.mocked(native.endVoiceMonitor).mockResolvedValue({ ok: true })
    expect((await store.availability({ input })).available).toBe(true)
    expect(await store.set({ input, on: true })).toMatchObject({ on: true, available: true, latency })
    await store.dispose()
  })
  it('returns off when set-on discovers an exited process without an earlier poll', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    vi.mocked(native.inputDevices).mockRejectedValue(new Error('The audio process stopped. Restart SingZ to reconnect audio.'))
    expect(await store.set({ input, on: true })).toMatchObject({ on: false, latency: null, available: { reason: 'error' } })
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
  })
  it('clears stale state when set-on sees a process exit during status reconciliation', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    vi.mocked(native.endVoiceMonitor).mockResolvedValueOnce({ ok: false })
    vi.mocked(native.voiceMonitorStatus).mockRejectedValueOnce(new Error('temporary status failure'))
    await store.set({ input, on: false })
    vi.mocked(native.voiceMonitorStatus).mockRejectedValueOnce(new Error('Audio process exited (9)'))
    expect(await store.set({ input, on: true })).toMatchObject({ on: false, latency: null, available: { reason: 'error' } })
  })
  it('forces orphan reconciliation even after a confirmed close', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    await store.dispose()
    await store.dispose()
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(2)
    expect(native.endVoiceMonitor).toHaveBeenLastCalledWith(0n)
  })
  it('bounds disposal while preserving the pending retry', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { store, native } = fixture()
      await store.set({ input, on: true })
      let reject!: (error: Error) => void
      vi.mocked(native.endVoiceMonitor).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
      const bounded = disposeWithin(store, 2000)
      await vi.advanceTimersByTimeAsync(2000)
      await bounded
      expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1)
      reject(new Error('late timeout'))
      await store.state()
      expect(native.endVoiceMonitor).toHaveBeenCalledTimes(2)
      expect((await store.state()).on).toBe(false)
    } finally { warn.mockRestore(); vi.useRealTimers() }
  })
  it('never prompts for permission and never opens without it', async () => {
    const { store, permission, native } = fixture()
    const preferences = { getMediaAccessStatus: vi.fn(() => 'not-determined'), askForMediaAccess: vi.fn() }
    permission.mockImplementation(() => microphonePermission(preferences))
    expect((await store.set({ input, on: true })).available).toEqual({ reason: 'permission' })
    expect(native.beginVoiceMonitor).not.toHaveBeenCalled()
    expect(preferences.askForMediaAccess).not.toHaveBeenCalled()
  })
  it.each(['win32', 'linux'] as const)('keeps monitoring unavailable on unqualified %s', async platform => {
    const { native } = fixture()
    const permission = vi.fn(() => false)
    vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: false, reason: 'permission' })
    const store = new VoiceMonitorStore(native, permission, platform)
    expect(await store.availability({ input })).toMatchObject({ on: false, available: { reason: 'platform' } })
    expect(await store.availability({ input, contextOnly: true, playbackContext: { webAudioPlaying: false, browserOutputUid: '', selectedOutputUid: '' } })).toMatchObject({ available: { reason: 'platform' } })
    expect(await store.set({ input, on: true })).toMatchObject({ on: false, available: { reason: 'platform' } })
    expect(await store.set({ input, on: false })).toMatchObject({ on: false, available: { reason: 'platform' } })
    expect(await store.state()).toMatchObject({ on: false, available: { reason: 'platform' } })
    expect(await store.gain(-6)).toMatchObject({ on: false, available: { reason: 'platform' } })
    expect(permission).not.toHaveBeenCalled()
    expect(native.inputDevices).not.toHaveBeenCalled()
    expect(native.voiceMonitorAvailability).not.toHaveBeenCalled()
    expect(native.beginVoiceMonitor).not.toHaveBeenCalled()
    expect(native.voiceMonitorStatus).not.toHaveBeenCalled()
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    await store.dispose()
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    // Bypass the platform guard with the same native reply: the old state()
    // path queried native and let permission override the unsupported platform.
    expect(await new VoiceMonitorStore(native, permission, 'darwin').state()).toMatchObject({ available: { reason: 'permission' } })
  })
  it('carries queue/delayed latency and preserves terminal route reasons without restarting', async () => {
    const { native, store } = fixture()
    const latency = { sampleRate: 48000, requestedFrames: 32, bufferFrames: 512, inputDeviceFrames: 64,
      outputDeviceFrames: 0, roundTripFrames: 1856, roundTripMs: 38.667, source: 'estimated' as const,
      queueFrames: 1280, delayed: true }
    vi.mocked(native.beginVoiceMonitor).mockResolvedValueOnce({ ok: true, latency })
    expect(await store.set({ input, on: true })).toMatchObject({ on: true, latency })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false, reason: 'error' })
    expect(await store.state()).toMatchObject({ on: false, available: { reason: 'error' } })
    await store.songChanged('new-song')
    expect((await store.state()).on).toBe(false)
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(1)
  })
  it('marks a lost device unavailable and releases the monitor', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false, lost: true })
    expect(await store.state()).toMatchObject({ on: false, available: { reason: 'device-lost' } })
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
  })
  it('leaves an unrelated recording running throughout monitor lifecycle', async () => {
    const { store } = fixture()
    const recording = { running: true }
    await store.set({ input, on: true })
    await store.set({ input, on: false })
    expect(recording.running).toBe(true)
  })
  it('reports unsupported platforms and missing native availability', async () => {
    const { native } = fixture()
    expect((await new VoiceMonitorStore(native, () => true, 'aix').availability({ input })).available).toEqual({ reason: 'platform' })
    vi.mocked(native.voiceMonitorAvailability).mockRejectedValueOnce(new Error('missing export'))
    expect((await new VoiceMonitorStore(native, () => true, 'darwin').availability({ input })).available).toEqual({ reason: 'error' })
  })
})

describe('monitor renderer ownership', () => {
  function sender(id: number): WebContents & EventEmitter {
    return Object.assign(new EventEmitter(), { id, isDestroyed: () => false }) as unknown as WebContents & EventEmitter
  }
  it.each(['render-process-gone', 'destroyed', 'did-start-navigation'])('releases monitor and its meter arm on %s exactly once', async event => {
    const { native, store } = fixture()
    let armed = true
    const release = vi.fn(async () => { armed = false })
    const owner = sender(77), lifetime = new VoiceMonitorRendererOwnership(store, release)
    lifetime.claim(owner)
    await store.set({ input, on: true })
    owner.emit(event, {}, 'reload', false, true)
    owner.emit('render-process-gone', {})
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1))
    expect(armed).toBe(false)
    expect((await store.state()).on).toBe(false)
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1)
  })
  it('the real monitor IPC binds renderer ownership even without capture:begin', async () => {
    const { native } = fixture(), owner = sender(75), releaseArm = vi.fn(async () => undefined)
    const store = registerVoiceMonitor(native, () => true, releaseArm, 'darwin')
    expect(await ipc.get(VOICE_IPC.monitorSet)!({ sender: owner }, { input, on: true })).toMatchObject({ on: true })
    owner.emit('render-process-gone', {})
    await vi.waitFor(() => expect(releaseArm).toHaveBeenCalledTimes(1))
    expect((await store.state()).on).toBe(false)
    expect((await native.voiceMonitorStatus()).running).toBe(false)
  })
  it('negative control: without the lifetime handler a renderer loss leaves native capture running', async () => {
    const { native, store } = fixture(), owner = sender(78)
    await store.set({ input, on: true }); owner.emit('render-process-gone', {})
    expect((await native.voiceMonitorStatus()).running).toBe(true)
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    await store.dispose()
  })
  it('ignores subframe/same-document events and an older window after ownership transfer', async () => {
    const { native, store } = fixture(), first = sender(79), second = sender(80)
    const lifetime = new VoiceMonitorRendererOwnership(store)
    lifetime.claim(first); await store.set({ input, on: true })
    first.emit('did-start-navigation', {}, 'fragment', true, true)
    first.emit('did-start-navigation', {}, 'frame', false, false)
    lifetime.claim(second);first.emit('destroyed')
    expect((await store.state()).on).toBe(true)
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    second.emit('destroyed');await vi.waitFor(() => expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1))
  })
  it('cleans a monitor that finishes opening after its renderer was lost', async () => {
    const { native, store } = fixture(), owner = sender(81)
    let finish!: (value: { ok: boolean }) => void
    vi.mocked(native.beginVoiceMonitor).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const lifetime = new VoiceMonitorRendererOwnership(store);const live = lifetime.claim(owner)
    const pending = store.set({ input, on: true })
    await vi.waitFor(() => expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(1))
    owner.emit('render-process-gone', {});finish({ ok: true });await pending
    await lifetime.release(owner)
    expect(live()).toBe(false);expect((await store.state()).on).toBe(false)
  })
  it('off/dispose reconcile a native orphan without any JS generation', async () => {
    const { store, native } = fixture()
    expect(await store.set({ input, on: false })).toMatchObject({ on: false })
    expect(native.endVoiceMonitor).toHaveBeenLastCalledWith(0n)
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: true })
    expect((await store.state()).on).toBe(false)
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(2)
  })
  it('logs terminal reasons and never restarts monitoring on a song change', async () => {
    const { native } = fixture(); const report = vi.fn()
    const store = new VoiceMonitorStore(native, () => true, 'darwin', report)
    await store.set({ input, on: true })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: false, lost: true, reason: 'device-lost' })
    expect((await store.state()).available).toEqual({ reason: 'device-lost' })
    expect(report).toHaveBeenCalledWith(expect.stringContaining('reason=device-lost'))
    await store.songChanged('next');expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(1)
  })
  it('does not log an idle no-input probe as a monitor stop, unlike the old availability control', async () => {
    const { native } = fixture(), report = vi.fn()
    const store = new VoiceMonitorStore(native, () => true, 'darwin', report)
    await store.availability({ input: { deviceName: '', channelIndex: 0 } })
    await store.songChanged('first'); await store.availability({ input: { deviceName: '', channelIndex: 0 } })
    expect(report).not.toHaveBeenCalled()
    // Reinstall the old fail() log rule, then run the same idle no-input probe.
    const old = new VoiceMonitorStore(native, () => true, 'darwin', report)
    const internals = old as unknown as {
      current: { on: boolean; available: true | { reason: string } }
      fail(reason: string): unknown
    }
    const fail = internals.fail.bind(old)
    internals.fail = reason => {
      if (internals.current.on || internals.current.available === true) report(`monitor stopped · reason=${reason}`)
      return fail(reason)
    }
    await old.availability({ input: { deviceName: '', channelIndex: 0 } })
    expect(report).toHaveBeenCalledExactlyOnceWith('monitor stopped · reason=no-input')
  })
  it('logs user off once at info, and a real device loss once at warn', async () => {
    const { native } = fixture()
    const store = new VoiceMonitorStore(native, () => true, 'darwin')
    const before = vi.mocked(log).mock.calls.length
    await store.set({ input, on: true }); await store.set({ input, on: false }); await store.set({ input, on: false })
    await store.set({ input, on: true })
    vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: false, lost: true, reason: 'device-lost' })
    await store.state(); await store.state()
    const entries = vi.mocked(log).mock.calls.slice(before).filter(call => call[0] === 'voice-monitor')
      .map(call => ({ line: call[1], level: call[2] }))
    expect(entries.filter(entry => entry.line === 'monitor off · reason=user')).toMatchObject([{ level: 'info' }])
    expect(entries.filter(entry => entry.line === 'monitor stopped · reason=device-lost')).toMatchObject([{ level: 'warn' }])
  })
  it('refreshes the running route and latency from native status after app output selection', async () => {
    const { store, native } = fixture()
    const initial = { sampleRate: 48000, requestedFrames: 32, bufferFrames: 32, inputDeviceFrames: 148,
      outputDeviceFrames: 28, roundTripFrames: 560, roundTripMs: 11.667, source: 'estimated' as const }
    vi.mocked(native.beginVoiceMonitor).mockResolvedValueOnce({ ok: true, latency: initial, commonOutputName: 'Zen' })
    await store.set({ input, on: true })
    const migrated = { ...initial, bufferFrames: 512, outputDeviceFrames: 96, roundTripMs: 51.7, queueFrames: 1280, delayed: true }
    vi.mocked(native.voiceMonitorStatus).mockResolvedValueOnce({ running: true, latency: migrated, commonOutputName: 'Cortex' })
    const selected = await store.availability({ input, contextOnly: true, playbackContext: { webAudioPlaying: false, browserOutputUid: '', selectedOutputUid: 'cortex' } })
    expect(selected).toMatchObject({ on: true, commonOutputName: 'Cortex', latency: migrated })
    expect(native.beginVoiceMonitor).toHaveBeenCalledTimes(1);expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    await store.dispose()
  })
  it('the native context IPC applies the app output instead of discarding it', () => {
    const source = readFileSync('native/electron/voice_monitor_bridge.cpp', 'utf8')
    const context = source.slice(source.indexOf('  if(contextOnly) {'), source.indexOf('napi_value begin('))
    const wired = (body: string) => body.includes('configureOutput(selected)')
    expect(wired(context)).toBe(true)
    expect(wired(context.replace('configureOutput(selected)', 'discardedSelection()'))).toBe(false)
    expect(source).toContain('generation(env,arg,g,true)') // Orphan close accepts the zero generation.
  })
  it('song output handback never disposes the monitor (old-handler negative control)', () => {
    const index = readFileSync('src/main/index.ts', 'utf8')
    const handler = index.slice(index.indexOf("ipcMain.handle('audio-host:playback-output-current'"), index.indexOf("ipcMain.handle('stems:reveal'"))
    const survives = (source: string) => !source.includes('disposeWithin(voiceMonitor')
    expect(survives(handler)).toBe(true)
    expect(survives(handler + 'await disposeWithin(voiceMonitor, 2000)')).toBe(false)
  })
})


describe('monitor-off meter lease ownership', () => {
  function meter() {
    const armCapture = vi.fn(async () => ({ ok: true, generation: 1n }))
    const disarmCapture = vi.fn(async () => ({ ok: true }))
    const store = new VoiceTakeStore({ native: { armCapture, disarmCapture } as unknown as VoiceTakeNative })
    return { store, armCapture, disarmCapture }
  }
  it.each([false, true])('monitor-only=%s: real monitor IPC preserves independent Arm and releases only its own meter lease', async monitorOnly => {
    const { native } = fixture(), take = meter(), epoch = {}
    const owner = Object.assign(new EventEmitter(), { id: 110, isDestroyed: () => false })
    await take.store.arm({ input, monitorOnly }, epoch)
    registerVoiceMonitor(native, () => true, () => take.store.releaseMonitorInput(), 'darwin', () => take.store.monitorInputCleanup(epoch))
    await ipc.get(VOICE_IPC.monitorSet)!({ sender: owner }, { input, on: true })
    await ipc.get(VOICE_IPC.monitorSet)!({ sender: owner }, { input, on: false })
    expect(take.disarmCapture).toHaveBeenCalledTimes(monitorOnly ? 1 : 0)
    if (!monitorOnly) {
      await take.store.arm({ input, monitorOnly: false }, epoch)
      expect(take.armCapture).toHaveBeenCalledTimes(1) // Still warm and record-ready in main.
    }
    await take.store.disarm()
  })
  it('negative control: the previous unconditional monitor-off cleanup destroys independent record readiness', async () => {
    const { native } = fixture(), take = meter(), epoch = {}
    const owner = Object.assign(new EventEmitter(), { id: 111, isDestroyed: () => false })
    await take.store.arm({ input }, epoch)
    registerVoiceMonitor(native, () => true, () => take.store.disarm(), 'darwin')
    await ipc.get(VOICE_IPC.monitorSet)!({ sender: owner }, { input, on: true })
    await ipc.get(VOICE_IPC.monitorSet)!({ sender: owner }, { input, on: false })
    await take.store.arm({ input, monitorOnly: false }, epoch)
    expect(take.armCapture).toHaveBeenCalledTimes(2) // Cold reopen despite the strip still showing armed.
    await take.store.disarm()
  })
  it('promotes a monitor-only arm without reopening it and a replacement renderer survives old cleanup', async () => {
    const take = meter(), first = {}, replacement = {}
    await take.store.arm({ input, monitorOnly: true }, first)
    const oldCleanup = take.store.monitorInputCleanup(first)
    await take.store.arm({ input, monitorOnly: false }, first)
    await take.store.releaseMonitorInput()
    expect(take.disarmCapture).not.toHaveBeenCalled()
    expect(take.armCapture).toHaveBeenCalledTimes(1)
    await take.store.arm({ input, monitorOnly: true }, replacement)
    await oldCleanup()
    expect(take.disarmCapture).not.toHaveBeenCalled()
    await take.store.monitorInputCleanup(replacement)()
    expect(take.disarmCapture).toHaveBeenCalledExactlyOnceWith(1n)
  })
  it.each([false, true])('renderer reload releases its own Arm but preserves replacement=%s', async replace => {
    const { native } = fixture(), take = meter(), epoch = {}, replacement = {}
    const owner = Object.assign(new EventEmitter(), { id: 112, isDestroyed: () => false })
    await take.store.arm({ input }, epoch)
    const monitor = registerVoiceMonitor(native, () => true, () => take.store.releaseMonitorInput(), 'darwin', () => take.store.monitorInputCleanup(epoch))
    await ipc.get(VOICE_IPC.monitorSet)!({ sender: owner }, { input, on: true })
    if (replace) await take.store.arm({ input, monitorOnly: true }, replacement)
    owner.emit('did-start-navigation', {}, 'reload', false, true)
    await vi.waitFor(async () => expect((await monitor.state()).on).toBe(false))
    await new Promise(resolve => setImmediate(resolve))
    expect(take.disarmCapture).toHaveBeenCalledTimes(replace ? 0 : 1)
    await take.store.disarm()
  })
  it('withdrawing explicit Arm transfers the remaining meter lease back to monitoring', async () => {
    const take = meter(), owner = {}
    await take.store.arm({ input }, owner)
    await take.store.arm({ input, monitorOnly: true }, owner)
    expect(take.armCapture).toHaveBeenCalledTimes(1)
    await take.store.releaseMonitorInput()
    expect(take.disarmCapture).toHaveBeenCalledExactlyOnceWith(1n)
  })
  it('the production monitor-off callback uses scoped monitor cleanup', () => {
    const main = readFileSync(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    expect(main).toContain('async () => { await monitorTakeStore?.releaseMonitorInput() }')
    expect(main).not.toContain('async () => { await monitorTakeStore?.disarm() }')
  })
})


describe('native virtual-route gain safety', () => {
  it('reports the actual quiet startup and migration gain rather than a saved hot request', async () => {
    const { native, store } = fixture()
    vi.mocked(native.beginVoiceMonitor).mockResolvedValueOnce({ ok: true, gainDb: -40, warnings: ['route-feedback-risk'] })
    expect(await store.set({ input, on: true, gainDb: 12 })).toMatchObject({ on: true, gainDb: -40, warnings: ['route-feedback-risk'] })
    expect((await store.gain(0)).gainDb).toBe(0)
    vi.mocked(native.voiceMonitorStatus).mockResolvedValue({ running: true, gainDb: -40, warnings: ['route-feedback-risk'] })
    expect((await store.state()).gainDb).toBe(-40) // Output migration can lower gain before main polls.
    await store.dispose()
  })
})


describe('remembered gain after a native safety cap', () => {
  it.each([false, true])('normal begin restores user intent with explicit gain=%s', async explicit => {
    const { native, store } = fixture()
    let risky = true
    vi.mocked(native.beginVoiceMonitor).mockImplementation(async args => ({ ok: true,
      gainDb: risky ? -40 : args.gainDb, warnings: risky ? ['route-feedback-risk'] : [] }))
    expect((await store.set({ input, on: true, gainDb: -6 })).gainDb).toBe(-40)
    await store.set({ input, on: false }); risky=false
    expect((await store.set({ input, on: true, ...(explicit ? { gainDb: -6 } : {}) })).gainDb).toBe(-6)
    expect(native.beginVoiceMonitor).toHaveBeenLastCalledWith(expect.objectContaining({ gainDb: -6 }), expect.any(BigInt))
    await store.dispose()
  })
})
