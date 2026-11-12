import { ipcMain } from 'electron'
import { desktopAudioProcess } from './audio-process'
import { VOICE_IPC, type VoiceInputLevel, type VoiceRecordStartRequest, type VoiceRecordSettingsChange, type VoicePlayTakeRequest } from '../shared/voice-take'
import { VoiceTakeStore, createUnavailableVoiceNative, type VoiceTakeNative } from './voice-takes'

export const createVoiceTakeNative = (): VoiceTakeNative => ({
  recordTake: async args => {
    const devices = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['inputDevices']>>>('binding', 'inputDevices', [])
    if (!devices.ok) return { ok: false, error: devices.error }
    const chosen = devices.devices.find(device => device.label === args.deviceName) ?? devices.devices.find(device => device.isDefault) ?? devices.devices[0]
    if (!chosen) return { ok: false, error: 'No microphone input is available.' }
    const started = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['beginCapture']>>>(
      'binding', 'beginCapture', [{ deviceUid: chosen.uid, inputChannel: Math.min(args.channelIndex ?? 0, chosen.channels - 1) }, args.generation, () => undefined])
    if (!started.ok) return { ok: false, error: started.error }
    return desktopAudioProcess.call('binding', 'recordTake', [args.dir, args.takeId, args.generation])
  },
  finishTake: args => desktopAudioProcess.call('binding', 'finishTake', [args.generation]),
  cancelTake: args => desktopAudioProcess.call('binding', 'cancelTake', [args.generation]),
  stopCapture: generation => desktopAudioProcess.call('binding', 'cancelCapture', [generation]),
  presentationQuery: async args => {
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
  },
  playTake: args => desktopAudioProcess.call('binding', 'playTake', [{ path: args.path, mode: args.mode, startPositionSec: args.startPositionSec, ...(args.gain === undefined ? {} : { gain: args.gain }), ...(args.tempo === undefined ? {} : { tempo: args.tempo }) }, args.generation]),
  stopTake: generation => desktopAudioProcess.call('binding', 'stopTake', generation === undefined ? [] : [generation]),
  level: async () => {
    const stats = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureStats']>>>('binding', 'captureStats', [])
    return (stats as Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureStats']>> & { inputLevel: VoiceInputLevel }).inputLevel
  }
})

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
  ipcMain.handle(VOICE_IPC.recordStart, async (_event, request: unknown) => { try { return startValid(request) ? await store.start(request) : { ok: false, reason: 'error' as const, message: 'Invalid recording request.' } } catch { return { ok: false, reason: 'error' as const, message: 'Recording could not start.' } } })
  ipcMain.handle(VOICE_IPC.recordStop, async (_event, reason?: 'device-lost' | 'error') => { try { return await store.stop(reason) } catch { return { ok: false, reason: 'error' as const, message: 'The take could not be finalized.' } } })
  ipcMain.handle(VOICE_IPC.recordSettings, async (_event, change: unknown) => { try { return settingsValid(change) ? await store.settings(change) : { ok: false, error: 'Invalid recording settings.' } } catch { return { ok: false, error: 'Recording settings could not be applied.' } } })
  ipcMain.handle(VOICE_IPC.list, async (_event, songId: unknown) => { try { return typeof songId === 'string' ? await store.list(songId) : [] } catch { return [] } })
  ipcMain.handle(VOICE_IPC.play, async (_event, request: unknown) => { try { return playValid(request) ? await store.play(request) : { ok: false, error: 'Invalid take playback request.' } } catch { return { ok: false, error: 'Take playback is unavailable.' } } })
  ipcMain.handle(VOICE_IPC.stopPlay, async () => { try { return await store.stopPlay() } catch { return { ok: false, error: 'Take playback could not stop.' } } })
  ipcMain.handle(VOICE_IPC.remove, (_event, songId: unknown, takeId: unknown) =>
    typeof songId === 'string' && typeof takeId === 'string' ? store.remove(songId, takeId).catch(() => ({ ok: false, error: 'Take could not be deleted.' })) : { ok: false, error: 'Invalid take id.' })
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

