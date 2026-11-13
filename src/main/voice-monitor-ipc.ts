import { ipcMain, systemPreferences } from 'electron'
import { desktopAudioProcess } from './audio-process'
import { VoiceMonitorStore, microphonePermission, type VoiceMonitorNative } from './voice-monitor'
import { VOICE_IPC, type VoiceMonitorAvailabilityRequest, type VoiceMonitorSetRequest, type VoiceMonitorState } from '../shared/voice-take'

export function createVoiceMonitorNative(): VoiceMonitorNative {
  return {
    hostDevices: () => desktopAudioProcess.call('owner', 'hostDevices', []),
    inputDevices: () => desktopAudioProcess.call('binding', 'inputDevices', []),
    voiceMonitorAvailability: async args => { try { return await desktopAudioProcess.call('binding', 'voiceMonitorAvailability', [args]) } catch { return { available: false, reason: 'platform' } } },
    beginVoiceMonitor: (args, generation) => desktopAudioProcess.call('binding', 'beginVoiceMonitor', [args, generation]),
    setVoiceMonitorGain: gain => desktopAudioProcess.call('binding', 'setVoiceMonitorGain', [gain]),
    voiceMonitorStatus: () => desktopAudioProcess.call('binding', 'voiceMonitorStatus', []),
    endVoiceMonitor: generation => desktopAudioProcess.call('binding', 'endVoiceMonitor', [generation])
  }
}
const validInput = (value: unknown): value is VoiceMonitorAvailabilityRequest => {
  const v = value as VoiceMonitorAvailabilityRequest
  return Boolean(v && typeof v === 'object' && v.input && typeof v.input.deviceName === 'string' && Number.isInteger(v.input.channelIndex) && v.input.channelIndex >= 0)
}
const invalidChannel = (value: unknown): boolean => {
  const v = value as VoiceMonitorAvailabilityRequest
  return Boolean(v && typeof v === 'object' && v.input && typeof v.input.deviceName === 'string' && typeof v.input.channelIndex === 'number' && Number.isFinite(v.input.channelIndex) && (!Number.isInteger(v.input.channelIndex) || v.input.channelIndex < 0))
}
const errorState = (): VoiceMonitorState => ({ available: { reason: 'error' }, on: false, gainDb: 0, latency: null, warnings: [] })
export function registerVoiceMonitor(): VoiceMonitorStore {
  const store = new VoiceMonitorStore(createVoiceMonitorNative(), () => microphonePermission(systemPreferences))
  ipcMain.handle(VOICE_IPC.monitorAvailability, async (_e, request: unknown) => { try { return (validInput(request) || invalidChannel(request)) ? await store.availability(request as VoiceMonitorAvailabilityRequest) : errorState() } catch { return errorState() } })
  ipcMain.handle(VOICE_IPC.monitorSet, async (_e, request: unknown) => { try { const r = request as VoiceMonitorSetRequest; const validOptions = r && typeof r === 'object' && typeof r.on === 'boolean' && (r.gainDb === undefined || Number.isFinite(r.gainDb)); return validOptions && (validInput(request) || invalidChannel(request)) ? await store.set(r) : errorState() } catch { return errorState() } })
  ipcMain.handle(VOICE_IPC.monitorGain, async (_e, request: unknown) => { try { const r = request as { gainDb?: number }; return r && typeof r === 'object' && Number.isFinite(r.gainDb) ? await store.gain(r.gainDb!) : errorState() } catch { return errorState() } })
  ipcMain.handle(VOICE_IPC.monitorState, async () => { try { return await store.state() } catch { return errorState() } })
  return store
}
