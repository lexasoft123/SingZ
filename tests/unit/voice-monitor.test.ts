import { describe, expect, it, vi } from 'vitest'
const ipc = vi.hoisted(() => new Map<string, (event: unknown, request?: unknown) => unknown>())
vi.mock('electron', async (importOriginal) => { const actual = await importOriginal<Record<string, unknown>>(); return { ...actual, ipcMain: { handle: (channel: string, fn: (event: unknown, request?: unknown) => unknown) => ipc.set(channel, fn) } } })
import { registerVoiceMonitor } from '../../src/main/voice-monitor-ipc'
import { VOICE_IPC } from '../../src/shared/voice-take'
import { VoiceMonitorStore, microphonePermission, type VoiceMonitorNative } from '../../src/main/voice-monitor'
import { disposeWithin } from '../../src/main/box-audio/microphones'

const input = { deviceName: 'mic', channelIndex: 0 }
function fixture() {
  const device = { uid: 'mic', label: 'AirPods', isDefault: true, sampleRate: 48000, channels: 1, channelLabels: ['1'] }
  const native: VoiceMonitorNative = {
    hostDevices: vi.fn(async () => ({ ok: true as const, platform: 'darwin' as const, provider: 'coreaudio' as const, defaultInputUid: 'mic', defaultOutputUid: 'mic', devices: [{ uid: 'mic', label: 'AirPods', direction: 'duplex' as const, transport: 'usb' as const, defaultInput: true, defaultOutput: true, inputChannels: 1, outputChannels: 2, inputChannelLabels: [], outputChannelLabels: [], nominalSampleRate: 48000, accessMode: 'shared' as const, monitoringSuitability: 'low-latency' as const, sampleRateRanges: [], bufferFrames: { minimumFrames: 32, maximumFrames: 256, preferredFrames: 32, fundamentalFrames: 1 } }] })),
    inputDevices: vi.fn(async () => ({ ok: true, devices: [device] })),
    voiceMonitorAvailability: vi.fn(async () => ({ available: true })),
    beginVoiceMonitor: vi.fn(async () => ({ ok: true })),
    setVoiceMonitorGain: vi.fn(async () => ({ ok: true })),
    voiceMonitorStatus: vi.fn(async () => ({ running: true })),
    endVoiceMonitor: vi.fn(async () => ({ ok: true }))
  }
  const permission = vi.fn(() => true)
  return { native, permission, store: new VoiceMonitorStore(native, permission, 'darwin') }
}
describe('voice monitoring', () => {
  it('uses native typed route decisions, not the AirPods label', async () => {
    const { store, native } = fixture()
    expect((await store.availability({ input })).available).toBe(true)
    for (const reason of ['route-separate-devices', 'route-latency', 'route-bluetooth', 'route-wireless'] as const) {
      vi.mocked(native.voiceMonitorAvailability).mockResolvedValueOnce({ available: false, reason })
      expect((await store.availability({ input })).available).toEqual({ reason })
    }
    expect(native.voiceMonitorAvailability).toHaveBeenCalledWith({ inputUid: 'mic', inputChannel: 0 })
  })
  it('rejects missing typed direction or transport without guessing from the label', async () => {
    const { store, native } = fixture()
    const inventory = await native.hostDevices()
    if (!inventory.ok) throw new Error('fixture')
    for (const field of ['direction', 'transport'] as const) {
      const device = { ...inventory.devices[0], [field]: undefined }
      vi.mocked(native.hostDevices).mockResolvedValueOnce({ ...inventory, devices: [device as typeof inventory.devices[0]] })
      expect((await store.availability({ input })).available).toEqual({ reason: 'error' })
    }
    expect(native.voiceMonitorAvailability).not.toHaveBeenCalled()
  })
  it('ends the monitor when the song changes', async () => {
    const { store, native } = fixture()
    await store.songChanged('song-a')
    await store.set({ input, on: true })
    await store.songChanged('song-a')
    expect(native.endVoiceMonitor).not.toHaveBeenCalled()
    await store.songChanged('song-b')
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1)
    expect((await store.state()).on).toBe(false)
  })
  it('never substitutes an unrecognized or ambiguous input', async () => {
    const { store, native } = fixture()
    expect((await store.availability({ input: { ...input, deviceName: 'missing' } })).available).toEqual({ reason: 'no-input' })
    expect(native.voiceMonitorAvailability).not.toHaveBeenCalled()
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
    expect(vi.mocked(native.beginVoiceMonitor).mock.calls[0][0]).toMatchObject({ gainDb: 12, targetFrames: 32, maxFrames: 256 })
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
  it('disposes at most once after a confirmed close', async () => {
    const { store, native } = fixture()
    await store.set({ input, on: true })
    await store.dispose()
    await store.dispose()
    expect(native.endVoiceMonitor).toHaveBeenCalledTimes(1)
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
    expect((await new VoiceMonitorStore(native, () => true, 'win32').availability({ input })).available).toEqual({ reason: 'platform' })
    vi.mocked(native.voiceMonitorAvailability).mockRejectedValueOnce(new Error('missing export'))
    expect((await new VoiceMonitorStore(native, () => true, 'darwin').availability({ input })).available).toEqual({ reason: 'platform' })
  })
})
