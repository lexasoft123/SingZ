import { ipcMain, systemPreferences, type WebContents } from 'electron'
import { desktopAudioProcess } from './audio-process'
import { VoiceMonitorStore, microphonePermission, isAudioProcessFailure, type VoiceMonitorNative } from './voice-monitor'
import { VOICE_IPC, type VoiceMonitorAvailabilityRequest, type VoiceMonitorSetRequest, type VoiceMonitorState } from '../shared/voice-take'

export function createVoiceMonitorNative(): VoiceMonitorNative {
  return {
    inputDevices: () => desktopAudioProcess.call('binding', 'inputDevices', []),
    voiceMonitorAvailability: async args => { try { return await desktopAudioProcess.call('binding', 'voiceMonitorAvailability', [args]) } catch (error) { if (isAudioProcessFailure(error)) throw error; return { available: false, reason: 'error' } } },
    beginVoiceMonitor: (args, generation) => desktopAudioProcess.call('binding', 'beginVoiceMonitor', [args, generation]),
    setVoiceMonitorGain: gain => desktopAudioProcess.call('binding', 'setVoiceMonitorGain', [gain]),
    voiceMonitorStatus: () => desktopAudioProcess.call('binding', 'voiceMonitorStatus', []),
    endVoiceMonitor: generation => desktopAudioProcess.call('binding', 'endVoiceMonitor', [generation])
  }
}
const validInput = (value: unknown): value is VoiceMonitorAvailabilityRequest => {
  const v = value as VoiceMonitorAvailabilityRequest
  if (v && typeof v === 'object' && v.contextOnly === true) {
    const c = v.playbackContext
    return Boolean(c && typeof c.webAudioPlaying === 'boolean' &&
      typeof c.browserOutputUid === 'string' && c.browserOutputUid.length <= 4096 && !c.browserOutputUid.includes('\0') &&
      typeof c.selectedOutputUid === 'string' && c.selectedOutputUid.length <= 4096 && !c.selectedOutputUid.includes('\0'))
  }
  return Boolean(v && v.contextOnly === undefined && typeof v === 'object' && v.input && typeof v.input.deviceName === 'string' && Number.isInteger(v.input.channelIndex) && v.input.channelIndex >= 0)
}
const invalidChannel = (value: unknown): boolean => {
  const v = value as VoiceMonitorAvailabilityRequest
  return Boolean(v && v.contextOnly === undefined && typeof v === 'object' && v.input && typeof v.input.deviceName === 'string' && typeof v.input.channelIndex === 'number' && Number.isFinite(v.input.channelIndex) && (!Number.isInteger(v.input.channelIndex) || v.input.channelIndex < 0))
}
const errorState = (): VoiceMonitorState => ({ available: { reason: 'error' }, on: false, gainDb: 0, latency: null, warnings: [] })
/** Installed on monitor activation itself, independently of capture:begin or takes. */
export class VoiceMonitorRendererOwnership {
  private watched = new WeakMap<WebContents, { epoch: number }>()
  private owner?: WebContents
  private ownerInput?: () => Promise<unknown>
  private cleanup: Promise<void> = Promise.resolve()
  constructor(private store: Pick<VoiceMonitorStore, 'dispose'>, private releaseInput: () => Promise<unknown> = async () => undefined,
    private captureInput?: () => (() => Promise<unknown>)) {}
  release(sender: WebContents): Promise<void> {
    if (this.owner === sender) {
      const releaseInput = this.ownerInput ?? this.releaseInput
      this.owner = undefined
      this.ownerInput = undefined
      this.cleanup = this.store.dispose('renderer-lost').then(() => releaseInput()).then(() => undefined).catch(() => undefined)
    }
    return this.cleanup
  }
  claim(sender: WebContents): () => boolean {
    let state = this.watched.get(sender)
    if (!state) {
      state = { epoch: 0 }; this.watched.set(sender, state)
      const tracked = state
      const detached = () => { ++tracked.epoch; void this.release(sender) }
      sender.on('render-process-gone', detached)
      sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) detached() })
      sender.once('destroyed', detached)
    }
    this.owner = sender
    this.ownerInput = this.captureInput?.() ?? this.releaseInput
    const epoch = state.epoch
    return () => !sender.isDestroyed() && this.owner === sender && state.epoch === epoch
  }
}

export function registerVoiceMonitor(native: VoiceMonitorNative = createVoiceMonitorNative(), permission = () => microphonePermission(systemPreferences), releaseInput: () => Promise<unknown> = async () => undefined, platform: NodeJS.Platform = process.platform,
  captureInput?: () => (() => Promise<unknown>)): VoiceMonitorStore {
  const store = new VoiceMonitorStore(native, permission, platform)
  const ownership = new VoiceMonitorRendererOwnership(store, releaseInput, captureInput)
  ipcMain.handle(VOICE_IPC.monitorAvailability, async (_e, request: unknown) => { try { return (validInput(request) || invalidChannel(request)) ? await store.availability(request as VoiceMonitorAvailabilityRequest) : errorState() } catch { return errorState() } })
  ipcMain.handle(VOICE_IPC.monitorSet, async (event, request: unknown) => { try {
    const r = request as VoiceMonitorSetRequest
    const valid = r && typeof r === 'object' && typeof r.on === 'boolean' &&
      (r.gainDb === undefined || Number.isFinite(r.gainDb)) &&
      !(r as VoiceMonitorAvailabilityRequest).contextOnly && (validInput(request) || invalidChannel(request))
    if (!valid) return errorState()
    if (invalidChannel(request)) return await store.set(r)
    if (!r.on) { const result = await store.set(r); await releaseInput(); return result }
    if (!event.sender || event.sender.isDestroyed()) return errorState()
    const live = ownership.claim(event.sender)
    const result = await store.set(r)
    if (!live()) { await ownership.release(event.sender); return errorState() }
    return result
  } catch { return errorState() } })
  ipcMain.handle(VOICE_IPC.monitorGain, async (_e, request: unknown) => { try { const r = request as { gainDb?: number }; return r && typeof r === 'object' && Number.isFinite(r.gainDb) ? await store.gain(r.gainDb!) : errorState() } catch { return errorState() } })
  ipcMain.handle(VOICE_IPC.monitorState, async () => { try { return await store.state() } catch { return errorState() } })
  return store
}
