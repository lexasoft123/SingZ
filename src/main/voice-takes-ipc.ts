import { ipcMain } from 'electron'
import { desktopAudioProcess } from './audio-process'
import { VOICE_IPC, VOICE_TAKE_MAX_OFFSET_SEC, type VoiceTakeMoveRequest, type VoiceTakePeaksRequest, type VoiceArmRequest, type VoiceInputLevel, type VoiceRecordStartRequest, type VoiceRecordSettingsChange, type VoicePlayTakeRequest } from '../shared/voice-take'
import { VoiceTakeStore, createUnavailableVoiceNative, type VoiceTakeNative } from './voice-takes'

const normalizeDeviceLabel = (value: string): string => value.trim().replace(/\s+\([^()]*\)\s*$/, '').trim().toLocaleLowerCase()

let nextVoiceCaptureGeneration = BigInt(Date.now()) * 1000n

export const createVoiceTakeNative = (audioProcess: typeof desktopAudioProcess = desktopAudioProcess): VoiceTakeNative => {
  const desktopAudioProcess = audioProcess
  let captureGeneration: bigint | undefined
  let captureDeviceName = ''
  let captureDeviceUid = ''
  let captureChannel = -1
  const chooseDevice = async (deviceName: string, channelIndex: number): Promise<{ ok: true; device: import('../shared/types').CaptureInputDevice; channel: number } | { ok: false; reason: 'no-input'; error: string }> => {
    const devices = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['inputDevices']>>>('binding', 'inputDevices', [])
    if (!devices.ok) return { ok: false, reason: 'no-input', error: devices.error }
    const requested = deviceName.trim()
    const unique = (matches: typeof devices.devices) => matches.length === 1 ? matches[0] : undefined
    const chosen = requested
      ? unique(devices.devices.filter(device => device.uid === requested)) ??
        unique(devices.devices.filter(device => device.label === requested)) ??
        unique(devices.devices.filter(device => normalizeDeviceLabel(device.label) === normalizeDeviceLabel(requested)))
      : devices.devices.find(device => device.isDefault) ?? devices.devices[0]
    if (!chosen || !Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= chosen.channels) return { ok: false, reason: 'no-input', error: 'The selected microphone is unavailable.' }
    return { ok: true, device: chosen, channel: channelIndex }
  }
  const openCapture = async (deviceName: string, channelIndex: number, generation: bigint): Promise<{ ok: boolean; reason?: 'no-input' | 'busy' | 'error'; error?: string; deviceName?: string; generation?: bigint }> => {
    const selected = await chooseDevice(deviceName, channelIndex)
    if (!selected.ok) return selected
    if (captureGeneration !== undefined) {
      const state = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureState']>>>('binding', 'captureState', [])
      if (state.state === 'running' && state.ownershipGeneration === captureGeneration.toString()) {
        if (selected.device.uid === captureDeviceUid && selected.channel === captureChannel) return { ok: true, generation: captureGeneration, deviceName: captureDeviceName }
        const stopped = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('binding', 'cancelCapture', [captureGeneration])
        if (!stopped.ok) return { ok: false, reason: 'error', error: 'The microphone could not be released.' }
      }
      captureGeneration = undefined; captureDeviceName = ''; captureDeviceUid = ''; captureChannel = -1
    }
    let started: Awaited<ReturnType<import('./capture').NativeCaptureBinding['beginCapture']>>
    try {
      started = await desktopAudioProcess.call('binding', 'beginCapture', [{ deviceUid: selected.device.uid, inputChannel: selected.channel }, generation, () => undefined])
    } catch (error) {
      // The begin may have succeeded despite a lost reply; release that generation.
      await desktopAudioProcess.call('binding', 'cancelCapture', [generation]).catch(() => undefined)
      throw error
    }
    if (!started.ok) return { ok: false, reason: 'error', error: started.error }
    captureGeneration = generation; captureDeviceName = selected.device.label; captureDeviceUid = selected.device.uid; captureChannel = selected.channel
    return { ok: true, generation, deviceName: captureDeviceName }
  }
  const presentationQuery: VoiceTakeNative['presentationQuery'] = async args => {
    if (!args.firstSampleHostNs || !args.sampleRate || !Number.isFinite(args.sampleRate) || args.sampleRate <= 0)
      return { ok: true, found: false, latencySource: 'measured-trim' as const }
    let hostNs: bigint
    try { hostNs = BigInt(args.firstSampleHostNs) } catch { return { ok: true, found: false, latencySource: 'measured-trim' as const } }
    const inputTrimNs = args.trimInputLatency ? (args.inputLatencyFrames ?? 0) * 1e9 / args.sampleRate : 0
    const outputRate = args.outputSampleRate ?? args.sampleRate
    const outputTrimNs = ((args.outputLatencyFrames ?? 0) + (args.graphLatencyFrames ?? 0)) * 1e9 / outputRate
    const trimNs = BigInt(Math.max(0, Math.round(inputTrimNs + outputTrimNs)))
    const adjustedHostNs = hostNs > trimNs ? hostNs - trimNs : 0n
    const raw = await desktopAudioProcess.call<{
      found: boolean; projectFrame?: number; songSeconds?: number; rate?: number; sampleRate?: number;
      outputLatencyFrames?: number; graphLatencyFrames?: number; discontinuitySerial?: number;
      paused?: boolean; seekDuringCallback?: boolean; generation?: string | number
    }>('binding', 'presentationQuery', [adjustedHostNs.toString()])
    return {
      ok: true, found: raw.found, projectFrame: raw.projectFrame, songSeconds: raw.songSeconds, sampleRate: raw.sampleRate,
      startPositionSec: raw.songSeconds, paused: raw.paused, outputLatencyFrames: raw.outputLatencyFrames,
      graphLatencyFrames: raw.graphLatencyFrames, discontinuitySerial: raw.discontinuitySerial,
      seekDuringCallback: raw.seekDuringCallback,
      latencySource: raw.found ? (args.firstSampleQuality === 'unknown' ? 'measured-trim' as const : 'reported' as const) : 'measured-trim' as const
    }
  }
  return {
  armCapture: args => openCapture(args.deviceName, args.channelIndex, ++nextVoiceCaptureGeneration),
  disarmCapture: async generation => { if (captureGeneration && (!generation || generation === captureGeneration)) { const result = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('binding', 'cancelCapture', [captureGeneration]); if (result.ok) { captureGeneration = undefined; captureDeviceName = ''; captureDeviceUid = ''; captureChannel = -1 } return result } return { ok: true } },
  recordTake: async args => {
    const generation = args.generation ?? (++nextVoiceCaptureGeneration)
    const started = await openCapture(args.deviceName ?? '', args.channelIndex ?? 0, generation)
    if (!started.ok) return started
    // An armed input can deliver immediately after Play, before the song's
    // first audible frame. At non-unity tempo (or transpose), the time/pitch
    // latency makes this window much longer. Wait BEFORE opening the writer:
    // retrying placement later cannot move a first sample out of old silence.
    let ready = false
    for (let attempt = 0; attempt < 80; attempt++) {
      const stats = await desktopAudioProcess.call<Awaited<ReturnType<VoiceTakeNative['captureStats']>>>('binding', 'captureStats', [])
      if (stats.lastSampleHostNs && stats.lastSampleHostNs !== '0' && stats.sampleRate) {
        const probe = { songId: '', firstSampleHostNs: stats.lastSampleHostNs, sampleRate: stats.sampleRate }
        const raw = await presentationQuery(probe)
        if (raw.ok && raw.found && !raw.paused && !raw.seekDuringCallback) {
          const placed = await presentationQuery({ ...probe, outputSampleRate: raw.sampleRate,
            inputLatencyFrames: stats.inputLatencySource === 'reported' && stats.inputLatencyStable !== false ? stats.inputLatencyFrames : 0,
            outputLatencyFrames: raw.outputLatencyFrames, graphLatencyFrames: raw.graphLatencyFrames, trimInputLatency: true })
          if (placed.ok && placed.found && !placed.paused && !placed.seekDuringCallback) { ready = true; break }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (!ready) return { ok: false, generation: started.generation ?? generation, reason: 'error', error: 'The song is not ready to record. Try again after playback starts.' }
    const result = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('binding', 'recordTake', [args.dir, args.takeId, started.generation ?? generation])
    return { ...result, generation: started.generation ?? generation, deviceName: started.deviceName }
  },
  finishTake: args => desktopAudioProcess.call('binding', 'finishTake', [args.generation]),
  cancelTake: args => desktopAudioProcess.call('binding', 'cancelTake', [args.generation]),
  stopCapture: async generation => {
    try { return await desktopAudioProcess.call<{ ok: boolean; cancelled?: boolean; error?: string }>('binding', 'cancelCapture', [generation]) }
    finally { if (captureGeneration === generation) { captureGeneration = undefined; captureDeviceName = ''; captureDeviceUid = ''; captureChannel = -1 } }
  },
  presentationQuery,
  playTake: args => desktopAudioProcess.call('binding', 'playTake', [{ path: args.path, mode: args.mode, startPositionSec: args.startPositionSec, ...(args.gain === undefined ? {} : { gain: args.gain }), ...(args.tempo === undefined ? {} : { tempo: args.tempo }) }, args.generation]),
  stopTake: generation => desktopAudioProcess.call('binding', 'stopTake', generation === undefined ? [] : [generation]),
  captureStats: () => desktopAudioProcess.call('binding', 'captureStats', []),
  level: async () => {
    const stats = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureStats']>>>('binding', 'captureStats', [])
    return (stats as Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureStats']>> & { inputLevel: VoiceInputLevel }).inputLevel
  }
  }
}

export function registerVoiceTakeIpc(store: VoiceTakeStore): void {
  const startValid = (value: unknown): value is VoiceRecordStartRequest => {
    const request = value as VoiceRecordStartRequest
    return Boolean(request && typeof request === 'object' && typeof request.songId === 'string' && typeof request.songTitle === 'string' && typeof request.songArtist === 'string' && request.input && typeof request.input.deviceName === 'string' && Number.isFinite(request.input.channelIndex) && Number.isFinite(request.tempo) && Number.isFinite(request.transposeSemitones))
  }
  const settingsValid = (value: unknown): value is VoiceRecordSettingsChange => {
    const change = value as VoiceRecordSettingsChange
    return Boolean(change && typeof change === 'object' && typeof change.takeId === 'string' && Number.isFinite(change.tempo) && Number.isFinite(change.transposeSemitones))
  }
  const playValid = (value: unknown): value is VoicePlayTakeRequest => {
    const play = value as VoicePlayTakeRequest
    return Boolean(play && typeof play === 'object' && typeof play.takeId === 'string' && (play.mode === 'take' || play.mode === 'with-song') && (play.gain === undefined || Number.isFinite(play.gain)))
  }
  const armValid = (value: unknown): value is VoiceArmRequest => {
    const arm = value as VoiceArmRequest
    return Boolean(arm && typeof arm === 'object' && arm.input && typeof arm.input.deviceName === 'string' && Number.isFinite(arm.input.channelIndex))
  }
  ipcMain.handle(VOICE_IPC.arm, async (_event, request: unknown) => { try { return armValid(request) ? await store.arm(request) : { ok: false, reason: 'error' as const, message: 'Invalid arm request.' } } catch { return { ok: false, reason: 'error' as const, message: 'Microphone could not be armed.' } } })
  ipcMain.handle(VOICE_IPC.disarm, async () => { try { return await store.disarm() } catch { return { ok: false, error: 'Microphone could not be disarmed.' } } })
  ipcMain.handle(VOICE_IPC.recordStart, async (_event, request: unknown) => { try { return startValid(request) ? await store.start(request) : { ok: false, reason: 'error' as const, message: 'Invalid recording request.' } } catch { return { ok: false, reason: 'error' as const, message: 'Recording could not start.' } } })
  ipcMain.handle(VOICE_IPC.recordStop, async (_event, reason?: 'device-lost' | 'error') => { try { return await store.stop(reason) } catch { return { ok: false, reason: 'error' as const, message: 'The take could not be finalized.' } } })
  ipcMain.handle(VOICE_IPC.recordSettings, async (_event, change: unknown) => { try { return settingsValid(change) ? await store.settings(change) : { ok: false, error: 'Invalid recording settings.' } } catch { return { ok: false, error: 'Recording settings could not be applied.' } } })
  ipcMain.handle(VOICE_IPC.list, async (_event, songId: unknown) => { try { return typeof songId === 'string' ? await store.list(songId) : [] } catch { return [] } })
  ipcMain.handle(VOICE_IPC.play, async (_event, request: unknown) => { try { return playValid(request) ? await store.play(request) : { ok: false, error: 'Invalid take playback request.' } } catch { return { ok: false, error: 'Take playback is unavailable.' } } })
  ipcMain.handle(VOICE_IPC.stopPlay, async () => { try { return await store.stopPlay() } catch { return { ok: false, error: 'Take playback could not stop.' } } })
  ipcMain.handle(VOICE_IPC.remove, (_event, songId: unknown, takeId: unknown) =>
    typeof songId === 'string' && typeof takeId === 'string' ? store.remove(songId, takeId).catch(() => ({ ok: false, error: 'Take could not be deleted.' })) : { ok: false, error: 'Invalid take id.' })
  const takeRefValid = (value: unknown): value is VoiceTakePeaksRequest => {
    const ref = value as VoiceTakePeaksRequest
    return Boolean(ref && typeof ref === 'object' && typeof ref.songId === 'string' && ref.songId.length <= 200 && typeof ref.takeId === 'string' && ref.takeId.length <= 200)
  }
  ipcMain.handle(VOICE_IPC.peaks, async (_event, request: unknown) => { try { return takeRefValid(request) ? await store.peaks({ songId: request.songId, takeId: request.takeId }) : { ok: false as const, error: 'Invalid take peaks request.' } } catch { return { ok: false as const, error: 'Take peaks are unavailable.' } } })
  ipcMain.handle(VOICE_IPC.move, async (_event, request: unknown) => {
    try {
      const move = request as VoiceTakeMoveRequest
      return takeRefValid(request) && typeof move.userOffsetSec === 'number' && Number.isFinite(move.userOffsetSec) && Math.abs(move.userOffsetSec) <= VOICE_TAKE_MAX_OFFSET_SEC
        ? await store.move({ songId: move.songId, takeId: move.takeId, userOffsetSec: move.userOffsetSec })
        : { ok: false as const, error: 'Invalid take move request.' }
    } catch { return { ok: false as const, error: 'The take could not be moved.' } }
  })
  ipcMain.handle(VOICE_IPC.level, async () => { try { return await store.level() } catch { return { peakDb: -120, rmsDb: -120, takeActive: false } } })
}

export function createRegisteredVoiceTakeStore(): VoiceTakeStore {
  // The native action surface is deliberately injected so the store remains testable
  // while older addons return a clear unavailable error through the RPC layer.
  return new VoiceTakeStore({
    native: process.env.SINGZ_VOICE_NATIVE === '0' ? createUnavailableVoiceNative() : createVoiceTakeNative(),
    rootDir: undefined
  })
}

export function registerVoiceTakes(): VoiceTakeStore {
  const store = createRegisteredVoiceTakeStore()
  registerVoiceTakeIpc(store)
  return store
}

