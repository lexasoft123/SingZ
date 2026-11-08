import { tMicrophone } from './settings-i18n'
import type { CaptureAnalysisWindow, CaptureInputDevice, CaptureStats, SingzApi } from '../../../shared/types'

export type MicrophoneSelection = { uid: string; channel: number }
export type MicrophoneSnapshot = {
  phase: 'idle' | 'starting' | 'running' | 'stopping' | 'error' | 'uncertain'
  capability: 'unknown' | 'available' | 'unavailable'
  devices: CaptureInputDevice[]
  inventoryError: string | null
  selection: MicrophoneSelection | null
  active: (MicrophoneSelection & { generation: string; label: string; channels: number }) | null
  levels: { generation: string; receivedAt: number; peak: number[]; rms: number[] } | null
  pitch: { frequency: number; clarity: number; receivedAt: number } | null
  error: string | null
}
type Api = Pick<SingzApi, 'captureInputDevices' | 'beginCapture' | 'cancelCapture' | 'captureState' | 'captureStats' | 'onCaptureWindow'> & Partial<Pick<SingzApi, 'askMicAccess'>>
const MAX = (1n << 64n) - 1n
let lastGeneration = 0n
export function microphoneGeneration(): string {
  const candidate = BigInt(Date.now()) * 1000n
  lastGeneration = candidate > lastGeneration ? candidate : lastGeneration + 1n
  if (lastGeneration < 1n || lastGeneration > MAX) throw new Error(tMicrophone('box.microphones.generationUnavailable'))
  return String(lastGeneration)
}
function scalarCapability(value: CaptureStats['microphoneLevels']): value is NonNullable<CaptureStats['microphoneLevels']> {
  return !!value && typeof value.valid === 'boolean' && Number.isInteger(value.channels) && value.channels >= 0 && value.channels <= 64 &&
    typeof value.ownershipGeneration === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.ownershipGeneration) && BigInt(value.ownershipGeneration) <= MAX &&
    Array.isArray(value.peak) && Array.isArray(value.rms) && value.peak.length === value.channels && value.rms.length === value.channels &&
    [...value.peak, ...value.rms].every(level => Number.isFinite(level) && level >= 0)
}
function validLevels(value: CaptureStats['microphoneLevels'], generation: string, channels: number): boolean {
  return scalarCapability(value) && value.valid && value.ownershipGeneration === generation && value.channels === channels && channels > 0
}
async function deadline<T>(operation: Promise<T>, milliseconds: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message())), milliseconds) })])
  } finally { clearTimeout(timer) }
}
/** App-lifetime private scalar reader. No transport, speaker-route or PCM API. */
export class BoxMicrophones {
  private value: MicrophoneSnapshot = { phase: 'idle', capability: 'unknown', devices: [], inventoryError: null,
    selection: null, active: null, levels: null, pitch: null, error: null }
  private listeners = new Set<() => void>()
  private tail: Promise<void> = Promise.resolve()
  private intent = 0
  private owned: { generation: string; selection: MicrophoneSelection } | null = null
  private uncertain = false
  private disposed = false
  private unsubscribe?: () => void
  private timer?: ReturnType<typeof setInterval>
  private polling = false
  private readGeneration = 0
  private transitions = 0
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private inventory: Promise<void> | null = null
  private latestWindow: { value: CaptureAnalysisWindow; receivedAt: number } | null = null
  private disposal?: Promise<void>
  constructor(private readonly api: Api, private readonly now: () => number = Date.now,
    private readonly generation: () => string = microphoneGeneration) {}
  getSnapshot = (): MicrophoneSnapshot => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<MicrophoneSnapshot>): void {
    if (Object.entries(patch).every(([key, value]) => Object.is(this.value[key as keyof MicrophoneSnapshot], value))) return
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
  connect(): void {
    if (this.disposed || this.unsubscribe) return
    this.unsubscribe = this.api.onCaptureWindow(value => {
      if (!this.disposed && this.owned?.generation === value.ownershipGeneration) this.latestWindow = { value, receivedAt: this.now() }
    })
    this.timer = setInterval(() => { this.expire(); void this.poll() }, 200)
    void this.refreshDevices(); void this.poll()
  }
  select = (selection: MicrophoneSelection): void => {
    if (this.disposed || !selection.uid || selection.uid.includes('\0') || selection.uid.length > 4096 ||
      !Number.isInteger(selection.channel) || selection.channel < 0 || selection.channel >= 64) return
    this.publish({ selection: { ...selection } })
  }
  refreshDevices = (): Promise<void> => {
    if (this.disposed || this.inventory) return this.inventory ?? Promise.resolve()
    const operation = (async () => {
      try {
        const result = await this.api.captureInputDevices()
        if (this.disposed) return
        if (result.ok) this.publish({ devices: result.devices, inventoryError: null })
        else this.publish({ inventoryError: tMicrophone('box.microphones.inventoryFailed', { detail: result.error }) })
      } catch (error) { if (!this.disposed) this.publish({ inventoryError: tMicrophone('box.microphones.inventoryFailed', { detail: String(error) }) }) }
    })()
    this.inventory = operation
    void operation.finally(() => { if (this.inventory === operation) this.inventory = null })
    return operation
  }
  private expire(): void {
    const time = this.now()
    const patch: Partial<MicrophoneSnapshot> = {}
    if (this.value.levels && time - this.value.levels.receivedAt > 750) patch.levels = null
    if (this.value.pitch && time - this.value.pitch.receivedAt > 750) patch.pitch = null
    if (Object.keys(patch).length) this.publish(patch)
  }
  private async poll(): Promise<void> {
    if (this.disposed || this.polling || this.transitions > 0 || (this.value.phase === 'error' && this.owned) || this.uncertain) return
    this.polling = true
    const owned = this.owned
    const intent = this.intent
    const readGeneration = this.readGeneration
    const current = (): boolean => !this.disposed && this.owned === owned && this.intent === intent && this.readGeneration === readGeneration &&
      this.transitions === 0 && !this.uncertain && !(owned && this.value.phase === 'error')
    try {
      const [state, stats] = await Promise.all([this.api.captureState(), this.api.captureStats()])
      if (!current()) return
      const capability = scalarCapability(stats.microphoneLevels) ? 'available' : 'unavailable'
      if (!owned || !this.value.active) { this.publish({ capability }); return }
      if (state.ownershipGeneration !== owned.generation) {
        this.failSession(owned, tMicrophone('box.microphones.sessionChanged')); return
      }
      if (state.state === 'starting') {
        this.publish({ capability, phase: 'starting', levels: null, pitch: null, error: null })
        if (!this.recoveryTimer) {
          const intent = this.intent
          this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = undefined
            if (this.owned === owned && this.intent === intent && !this.disposed) this.failSession(owned, tMicrophone('box.microphones.warmupTimeout'))
          }, 5000)
        }
        return
      }
      if (state.state !== 'running') {
        this.failSession(owned, state.error ? tMicrophone('box.microphones.sessionFailure', { detail: state.error }) : tMicrophone('box.microphones.sessionStopped')); return
      }
      this.clearRecovery()
      const time = this.now()
      const levels = validLevels(stats.microphoneLevels, owned.generation, this.value.active.channels)
        ? { generation: owned.generation, receivedAt: time, peak: [...stats.microphoneLevels!.peak], rms: [...stats.microphoneLevels!.rms] } : null
      const event = this.latestWindow
      const pitch = event && event.value.ownershipGeneration === owned.generation && time - event.receivedAt <= 750 &&
        Number.isFinite(event.value.frequency) && event.value.frequency > 0 && event.value.frequency < 5000 &&
        Number.isFinite(event.value.clarity) && event.value.clarity >= 0.5 && event.value.clarity <= 1
        ? { frequency: event.value.frequency, clarity: event.value.clarity, receivedAt: event.receivedAt } : null
      this.publish({ capability, phase: 'running', levels, pitch, error: capability === 'available' ? null : tMicrophone('box.microphones.levelsUnavailable') })
    } catch (error) {
      if (current()) this.publish({ levels: null, pitch: null, error: tMicrophone('box.microphones.readFailed', { detail: String(error) }) })
    } finally { this.polling = false }
  }
  private clearRecovery(): void { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined }
  private failSession(owned: NonNullable<BoxMicrophones['owned']>, detail: string): void {
    this.clearRecovery(); this.readGeneration++
    const intent = this.intent
    this.publish({ phase: 'error', levels: null, pitch: null, error: detail })
    void this.enqueue(async () => {
      if (this.owned !== owned || this.intent !== intent) return
      try {
        await this.cancelOwned()
        if (!this.disposed && this.intent === intent) this.publish({ phase: 'error', error: detail })
      } catch { /* cancelOwned exposes uncertainty and preserves exact ownership */ }
    })
  }
  private async awaitRunning(owned: NonNullable<BoxMicrophones['owned']>, intent: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(tMicrophone('box.microphones.warmupTimeout'))), 5000) })
    try {
      while (!this.disposed && this.intent === intent && this.owned === owned) {
        const state = await Promise.race([this.api.captureState(), timeout])
        if (this.disposed || this.intent !== intent || this.owned !== owned) return false
        if (state.ownershipGeneration !== owned.generation) throw new Error(tMicrophone('box.microphones.sessionChanged'))
        if (state.state === 'running') return true
        if (state.state !== 'starting') throw new Error(state.error ? tMicrophone('box.microphones.sessionFailure', { detail: state.error }) : tMicrophone('box.microphones.sessionStopped'))
        await Promise.race([new Promise<void>(resolve => setTimeout(resolve, 200)), timeout])
      }
      return false
    } finally { clearTimeout(timer) }
  }
  private async cancelOwned(): Promise<void> {
    this.clearRecovery()
    const owned = this.owned
    if (!owned) return
    try {
      await deadline((async () => {
        const result = await this.api.cancelCapture(owned.generation)
        if (!result.ok) throw new Error(result.error)
        if (!result.cancelled) {
          const state = await this.api.captureState()
          if (state.ownershipGeneration === owned.generation && !['idle', 'stopped', 'unsupported'].includes(state.state)) throw new Error(tMicrophone('box.microphones.stopUnconfirmed'))
        }
      })(), 5000, () => tMicrophone('box.microphones.stopUnconfirmed'))
      if (this.owned === owned) this.owned = null
      this.latestWindow = null; this.uncertain = false
      this.publish({ active: null, levels: null, pitch: null })
    } catch (error) {
      this.uncertain = true
      this.publish({ phase: 'uncertain', levels: null, pitch: null, error: tMicrophone('box.microphones.stopFailed', { detail: String(error) }) })
      throw error
    }
  }
  resetSelection = (): void => {
    const active = this.value.active
    this.publish({ selection: active ? { uid: active.uid, channel: active.channel } : null })
  }
  start = (): Promise<boolean> => {
    const selection = this.value.selection
    if (this.disposed || !selection || this.value.capability !== 'available' || this.uncertain) return Promise.resolve(false)
    const intent = ++this.intent
    this.clearRecovery(); this.transitions++
    this.publish({ phase: 'starting', levels: null, pitch: null, error: null })
    return this.enqueue(async () => {
      if (this.disposed || intent !== this.intent || this.uncertain) return false
      try {
        this.publish({ phase: 'starting' })
        await this.cancelOwned()
        if (this.disposed || intent !== this.intent) return false
        const device = this.value.devices.find(device => device.uid === selection.uid)
        if (!device || selection.channel >= device.channels || this.value.inventoryError) throw new Error(tMicrophone('box.microphones.selectedUnavailable'))
        if (this.api.askMicAccess && !await this.api.askMicAccess()) throw new Error(tMicrophone('box.microphones.permissionDenied'))
        if (this.disposed || intent !== this.intent) return false
        const generation = this.generation()
        if (!/^[1-9][0-9]{0,19}$/.test(generation) || BigInt(generation) > MAX) throw new Error(tMicrophone('box.microphones.invalidSession'))
        this.owned = { generation, selection }
        const result = await this.api.beginCapture({ deviceUid: selection.uid, inputChannel: selection.channel }, generation)
        if (this.disposed || intent !== this.intent) { await this.cancelOwned(); return false }
        if (!result.ok) {
          await this.cancelOwned()
          this.publish({ phase: 'error', capability: result.state === 'unsupported' ? 'unavailable' : this.value.capability, error: tMicrophone('box.microphones.startFailed', { detail: result.error ?? '' }) }); return false
        }
        if (!['starting', 'running'].includes(result.state) || result.deviceUid !== selection.uid || result.inputChannel !== selection.channel ||
          !Number.isInteger(result.deviceChannels) || result.deviceChannels <= selection.channel || result.deviceChannels > 64) throw new Error(tMicrophone('box.microphones.unexpectedSession'))
        this.publish({ phase: 'starting', active: { ...selection, generation, label: result.deviceLabel, channels: result.deviceChannels }, levels: null, pitch: null, error: null })
        if (result.state === 'starting' && !await this.awaitRunning(this.owned!, intent)) { await this.cancelOwned(); return false }
        if (this.disposed || intent !== this.intent) { await this.cancelOwned(); return false }
        this.publish({ phase: 'running', error: null })
        void this.poll()
        return true
      } catch (error) {
        if (this.uncertain) return false
        try { await this.cancelOwned() } catch { return false }
        if (!this.disposed && intent === this.intent) this.publish({ phase: 'error', levels: null, pitch: null, error: tMicrophone('box.microphones.startFailed', { detail: String(error) }) })
        return false
      }
    }).finally(() => { this.transitions--; if (!this.transitions && this.value.phase === 'running') void this.poll() })
  }
  stop = (): Promise<boolean> => {
    if (this.disposed) return this.disposal?.then(() => true, () => false) ?? Promise.resolve(false)
    const intent = ++this.intent
    this.clearRecovery(); this.transitions++
    this.publish({ phase: 'stopping', levels: null, pitch: null })
    return this.enqueue(async () => {
      try { await this.cancelOwned(); if (intent === this.intent) this.publish({ phase: 'idle', error: null }); return true }
      catch { return false }
    }).finally(() => { this.transitions-- })
  }
  dispose = (): Promise<void> => {
    if (this.disposal) return this.disposal
    this.disposed = true; ++this.intent; this.clearRecovery()
    clearInterval(this.timer); this.unsubscribe?.(); this.unsubscribe = undefined
    this.publish({ levels: null, pitch: null })
    this.disposal = this.enqueue(() => this.cancelOwned())
    return this.disposal
  }
}
export function microphoneChannelLevel(snapshot: MicrophoneSnapshot | undefined, uid: string, channel: number, now = Date.now()): number | null {
  const value = snapshot?.levels
  return snapshot?.phase === 'running' && snapshot.active?.uid === uid && Number.isInteger(channel) && channel >= 0 && channel < snapshot.active.channels && value?.generation === snapshot.active.generation &&
    now >= value.receivedAt && now - value.receivedAt <= 750 && Number.isFinite(value.peak[channel]) && value.peak[channel] >= 0 ? value.peak[channel] : null
}
