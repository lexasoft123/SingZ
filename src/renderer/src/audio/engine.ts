import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch'
import {
  accentIndex,
  barLengthAt,
  beatIndexAtOrAfter,
  beatTime,
  MET_DEFAULTS,
  type BeatInfo,
  type MetronomeConfig
} from './beat'
import { DesktopTrainingCueController } from './training-audio'
import type {
  DesktopNativePlaybackClient,
  DesktopNativeRecoveryErrorCode
} from './desktop-native-playback'
import type { DesktopPlaybackProvider, DesktopPlaybackStatus } from '../../../shared/types'
import type { ParsedGraphDocument } from '../../../shared/graph-document'

export interface EngineTrackInput {
  id: string
  buffer: AudioBuffer
  /** Main-authorized source used by the portable native session. */
  path?: string
}

interface EngineTrack {
  id: string
  buffer: AudioBuffer
  path?: string
  gain: GainNode
  volume: number
  muted: boolean
  solo: boolean
}

export interface TrackState {
  id: string
  muted: boolean
  solo: boolean
  volume: number
}

export type EnginePlayRequestReason =
  | 'toggle'
  | 'auto-resume'
  | 'pre-roll-restart'
  | 'seek-restart'

export type EnginePlaybackErrorCode =
  | 'provider-failure'
  | DesktopNativeRecoveryErrorCode
  | 'playback-failure'

export interface EnginePlaybackError {
  reason: EnginePlayRequestReason
  code: EnginePlaybackErrorCode
  provider: DesktopPlaybackProvider | null
  message: string
  cause: unknown
}

const PROVIDER_PLAYBACK_ERROR_CODES = new Set<EnginePlaybackErrorCode>([
  'provider-failure',
  'provider-recovery-conflict',
  'provider-recovery-unavailable',
  'provider-cleanup-incomplete',
  'provider-route-restore-incomplete'
])

/**
 * Vocal-training schedule: the chosen stems duck (gain 0) while the singer
 * carries them. 'period' alternates hear/sing every periodSec of song time
 * (first phase is always hear); 'windows' ducks inside explicit song-time
 * ranges (computed from lyric lines by the app).
 */
export type TrainingSpec =
  | { mode: 'period'; periodSec: number; stems: string[] }
  | { mode: 'windows'; windows: { s: number; e: number }[]; stems: string[] }

const START_DELAY = 0.04 // scheduling headroom so all stems start sample-locked
const CLICK_LOOKAHEAD = 0.18 // clicks are queued this far ahead on the audio clock
const CLICK_TICK_MS = 60
// Grid-less (rubato) count-in: each chosen "bar" is 3 ticks, one per second
// of wall clock — free-tempo songs have no beat to count on.
const SEC_COUNT_TICKS = 3
const SEC_COUNT_PERIOD = 1

/**
 * Sample-synchronized multitrack player. All tracks are AudioBufferSources
 * scheduled on the same AudioContext clock; mute/solo/volume are GainNode
 * ramps so toggling mid-playback is click-free.
 */
export class MultitrackEngine {
  private ctx = new AudioContext({ latencyHint: 'interactive' })
  private desiredOutputId = ''
  private confirmedOutputId = ''
  private outputRouteVersion = 0
  private outputRouteApplyPending: Promise<void> | null = null
  private nativeMonitorLease = false
  private nativePlayback: DesktopNativePlaybackClient | null = null
  private nativePlaybackUnload: Promise<void> | null = null
  private nativePlaybackUnloadError: unknown = null
  private pendingPlayRequests = new Set<Promise<void>>()
  private teardownPending: Promise<void> | null = null
  private teardownStarted = false
  private playRequestEpoch = 0
  private requestedPlaybackError: EnginePlaybackError | null = null
  private nativeAudioProvider: Extract<DesktopPlaybackProvider, 'wasapi' | 'asio'> = 'wasapi'
  /** Full verified JS document. Opaque state remains here; the native facade
   * creates the bounded projection immediately before each prepare/rebuild. */
  private graphDocument: ParsedGraphDocument | null = null
  private master = this.ctx.createGain()
  private tracks: EngineTrack[] = []
  private sources: AudioBufferSourceNode[] = []
  private generation = 0
  private startedAt = 0
  private startOffset = 0
  private _playing = false
  private listeners = new Set<() => void>()
  private stretch: StretchNode | null = null
  private stretchPromise: Promise<StretchNode> | null = null
  private pendingStretches = new Set<StretchNode>()
  private stretchEpoch = 0
  private stretchTimeouts = new Set<ReturnType<typeof setTimeout>>()
  /** Rejecters for every in-flight stretch wait. Teardown settles them so a
   * worklet that never boots cannot leave setTranspose/setTempo pending. */
  private stretchWaiters = new Set<(reason: Error) => void>()
  private stretchLatency = 0
  private stretchOn = false
  private semitones = 0
  private rate = 1
  private region: { start: number; end: number } | null = null
  private regionLoop = false
  private boundTimer: ReturnType<typeof setInterval> | null = null
  private training: TrainingSpec | null = null
  private ducked = new Set<string>()
  private trainTimer: ReturnType<typeof setInterval> | null = null
  private beatsInfo: BeatInfo | null = null
  private met: MetronomeConfig = { ...MET_DEFAULTS }
  private clickGain = this.ctx.createGain()
  /** Exercise cues bypass pitch/stretch processing but follow the user's master volume. */
  private trainingGain = this.ctx.createGain()
  private trainingCues: DesktopTrainingCueController | null = null
  /** Output level for everything the singer hears, mix and click alike. */
  private masterVol = 1
  private clickBufs: { accent: AudioBuffer; beat: AudioBuffer } | null = null
  private clickNodes: { node: AudioBufferSourceNode; at: number }[] = []
  private clickTimer: ReturnType<typeof setInterval> | null = null
  /** Beat index of the next click (negative during a count-in), null = none due. */
  private nextClickIdx: number | null = null
  /** How many times the loop region has wrapped since play() for the click walker. */
  private clickLap = 0
  /** First beat index at/after the play position — where a count-in hands over. */
  private startBeatIdx: number | null = null
  private countInfo: { firstCtx: number; periodCtx: number; total: number; perBar: number } | null =
    null

  /** Clicks scheduled since launch (diagnostics/E2E). */
  clickCount = 0

  duration = 0

  constructor() {
    this.master.connect(this.ctx.destination)
    // Clicks bypass the master bus: transpose/tempo correction and stem
    // gains must never color the metronome.
    this.clickGain.gain.value = this.met.volume
    this.clickGain.connect(this.ctx.destination)
    this.trainingGain.gain.value = this.masterVol
    this.trainingGain.connect(this.ctx.destination)
  }

  /** Native status is the transport's word. A song that played to its end
   * is Completed in the callback domain while the control domain still says
   * Playing, and the core refuses resume() from there: park the renderer at
   * the end and hand the core a Pause, so the next Play seeks and resumes. */
  private onNativeStatus(status: DesktopPlaybackStatus | null): void {
    if (status?.transportState === 'completed' && this._playing && this.nativePlayback?.active) {
      this._playing = false
      this.startOffset = this.duration
      this.syncBoundWatcher()
      this.syncTrainWatcher()
      void this.nativePlayback.pause().catch((error) => {
        console.error('Native pause after the song completed failed:', error)
      })
    }
    this.emit()
  }

  /** Bumps on every load() and on retireForSongSwitch(). The renderer's
   * rollbacks compare it, so a native mutation issued for the song being
   * left can never restore that song's grid, region or training into the
   * next one — the cross-song contamination class CLAUDE.md records. */
  private _songEpoch = 0
  get songEpoch(): number {
    return this._songEpoch
  }

  /** The loader calls this before it resets a single control for the next
   * song. Native is retired FIRST, so the resets that follow (transpose 0,
   * tempo 1, beats null) become no-ops instead of three structural rebuilds
   * of the song being left — one of which fails when the click is on and
   * would roll the OLD grid into the NEW song's UI. */
  retireForSongSwitch(): void {
    if (this.teardownStarted) return
    this._songEpoch++
    this._playing = false
    if (this.nativePlayback?.active) this.beginNativePlaybackUnload()
  }

  private async ensureNativePlayback(): Promise<{
    client: DesktopNativePlaybackClient
    tryStart: typeof import('./desktop-native-playback').tryStartDesktopNativePlayback
    RecoveryError: typeof import('./desktop-native-playback').DesktopNativeRecoveryError
  }> {
    const module = await import('./desktop-native-playback')
    this.nativePlayback ??= new module.DesktopNativePlaybackClient(
      {
        releaseLegacyOutput: () => this.releaseOutputForNativeMonitor(),
        restoreLegacyOutput: () => this.restoreOutputAfterNativeMonitor()
      },
      (status) => this.onNativeStatus(status)
    )
    return {
      client: this.nativePlayback,
      tryStart: module.tryStartDesktopNativePlayback,
      RecoveryError: module.DesktopNativeRecoveryError
    }
  }

  /** Start or retry one client-owned unload without leaving a rejecting
   * promise unobserved. A failed promise and its typed error remain available
   * for the next deliberate load/play/teardown boundary. */
  private beginNativePlaybackUnload(): Promise<void> | null {
    if (!this.nativePlayback?.active) return null
    if (this.nativePlaybackUnload && this.nativePlaybackUnloadError === null) {
      return this.nativePlaybackUnload
    }
    const operation = this.nativePlayback.unload()
    this.nativePlaybackUnload = operation
    this.nativePlaybackUnloadError = null
    void operation.then(() => {
      if (this.nativePlaybackUnload !== operation) return
      this.nativePlaybackUnload = null
      this.nativePlaybackUnloadError = null
      this.emit()
    }, (error) => {
      if (this.nativePlaybackUnload !== operation) return
      this.nativePlaybackUnloadError = error
      console.error('Native playback cleanup needs an explicit retry:', error)
      this.emit()
    })
    return operation
  }

  /** Await an in-flight unload and make at most one explicit retry for a
   * previously observed failure. */
  private async settleNativePlaybackUnload(): Promise<void> {
    const first = this.nativePlaybackUnload
    if (!first) return
    try {
      await first
    } catch (error) {
      if (this.nativePlaybackUnload === first && this.nativePlaybackUnloadError === null) {
        this.nativePlaybackUnloadError = error
      }
    }
    if (this.nativePlaybackUnloadError === null) return
    if (!this.nativePlayback?.active) throw this.nativePlaybackUnloadError
    const retry = this.beginNativePlaybackUnload()
    if (retry) await retry
  }

  /** Stop every renderer-owned transport primitive without publishing an
   * intermediate safe state. Native cleanup still owns the verdict about
   * whether the physical route can be released. */
  private stopTransportForTeardown(): void {
    this.generation++
    this._playing = false
    this.trainingCues?.dispose()
    this.cancelStretchForTeardown()
    this.stopSources()
    for (const click of this.clickNodes) {
      click.node.onended = null
      try {
        click.node.stop()
      } catch {
        // never started or already stopped
      }
      click.node.disconnect()
    }
    this.clickNodes = []
    this.nextClickIdx = null
    this.countInfo = null
    this.startBeatIdx = null
    this.syncBoundWatcher()
    this.syncTrainWatcher()
    this.syncClickWatcher()
  }

  private async performTeardown(): Promise<void> {
    this.stopTransportForTeardown()

    // A play may still be waiting for AudioContext.resume(), the lazy native
    // module, or native prepare. Its generation has already been revoked.
    // Wait for it to observe that revocation, then retire any generation it
    // managed to prepare before returning from the bridge.
    const pendingPlays = [...this.pendingPlayRequests]
    if (pendingPlays.length > 0) await Promise.allSettled(pendingPlays)
    if (!this.nativePlaybackUnload) this.beginNativePlaybackUnload()

    let cleanupError: unknown = null
    try {
      await this.settleNativePlaybackUnload()
    } catch (error) {
      cleanupError = error
    }

    // No late completion may resurrect renderer transport state. Emit only
    // after native cleanup and route restoration have produced their final
    // success/recovery verdict.
    this.stopTransportForTeardown()
    this.emit()
    if (cleanupError !== null) throw cleanupError
  }

  /** App teardown is an explicit recovery boundary. Repeated callers share
   * the same cleanup transaction; a typed final failure remains retryable. */
  teardown(): Promise<void> {
    if (this.teardownPending) return this.teardownPending
    // Admission closes before performTeardown takes its pending-play snapshot.
    // This engine instance is app-lifetime state and is not reusable after
    // teardown, including when cleanup remains retained for an exact retry.
    this.teardownStarted = true
    this.playRequestEpoch++
    const operation = this.performTeardown()
    this.teardownPending = operation
    // A successful app-lifetime teardown remains the permanent idempotent
    // result. Only a typed cleanup failure reopens this exact retry boundary.
    void operation.catch(() => {
      if (this.teardownPending === operation) this.teardownPending = null
    })
    return operation
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  get playbackError(): EnginePlaybackError | null {
    return this.requestedPlaybackError
  }

  /** The public play() promise remains rejectable for callers that await it.
   * Product actions that cannot await use this boundary so a provider or
   * cleanup rejection is observed immediately and becomes renderer state. */
  private requestPlay(reason: EnginePlayRequestReason, opts: { countIn?: boolean } = {}): void {
    if (this.teardownStarted) return
    const requestEpoch = ++this.playRequestEpoch
    void this.play(opts).catch((cause: unknown) => {
      if (this.teardownStarted || requestEpoch !== this.playRequestEpoch) return
      const candidate = cause as { code?: unknown; provider?: unknown }
      const code = typeof candidate?.code === 'string' &&
        PROVIDER_PLAYBACK_ERROR_CODES.has(candidate.code as EnginePlaybackErrorCode)
        ? candidate.code as EnginePlaybackErrorCode
        : 'playback-failure'
      const provider = candidate?.provider === 'asio' || candidate?.provider === 'wasapi' ||
        candidate?.provider === 'coreaudio'
        ? candidate.provider
        : null
      const message = cause instanceof Error ? cause.message : String(cause)
      this._playing = false
      this.stopSources()
      this.cancelPendingClicks()
      this.nextClickIdx = null
      this.countInfo = null
      this.startBeatIdx = null
      this.syncBoundWatcher()
      this.syncTrainWatcher()
      this.syncClickWatcher()
      this.requestedPlaybackError = { reason, code, provider, message, cause }
      console.error('Playback request failed:', this.requestedPlaybackError)
      this.emit()
    })
  }

  private clearRequestedPlaybackError(): void {
    this.requestedPlaybackError = null
  }

  /** Which backend is rendering right now: true while a native desktop
   *  generation is active, false on Web Audio. Read by the E2E hook so a
   *  driver can prove which backend a pass actually measured. */
  get nativeActive(): boolean {
    return this.nativePlayback?.active === true
  }

  get playing(): boolean {
    if (this.nativePlayback?.active) return this._playing && this.nativePlayback.transportActive
    return this._playing
  }

  get context(): AudioContext {
    return this.ctx
  }

  /** Inject the one sanitized AudioPrefs provider value. The engine does not
   * read a second localStorage mirror, so UI and product selection cannot
   * silently diverge after restore. */
  setNativeAudioProvider(provider: Extract<DesktopPlaybackProvider, 'wasapi' | 'asio'>): void {
    this.nativeAudioProvider = provider === 'asio' ? 'asio' : 'wasapi'
  }

  /** Create the one active cue controller; replacing it cleans up the previous owner's nodes. */
  createTrainingCueController(): DesktopTrainingCueController {
    if (this.teardownStarted) throw new Error('Audio engine is disposed.')
    this.trainingCues?.dispose()
    this.trainingCues = new DesktopTrainingCueController(this.ctx, this.trainingGain, () => {
      this.pause()
    })
    return this.trainingCues
  }

  /** Current output device id ('' = system default). */
  get outputDeviceId(): string {
    return this.desiredOutputId
  }

  /**
   * Route everything audible to another device. Mix, metronome and the
   * stretch path all terminate at ctx.destination, so one sinkId move
   * carries them together; '' returns to the system default.
   */
  async setOutput(deviceId: string): Promise<void> {
    if (!('setSinkId' in this.ctx)) throw new Error('Changing outputs is not supported here.')
    this.desiredOutputId = deviceId
    this.outputRouteVersion++
    // A native monitor owns the physical output. Remember route changes for
    // restoration, but never let Chromium reacquire a device underneath it.
    if (this.nativeMonitorLease) return
    await this.applyDesiredOutputRoute()
  }

  /** Applies the newest desired Chromium route. A slower stale setSinkId can
   * never finish after a newer request and silently become the physical sink. */
  private async applyDesiredOutputRoute(): Promise<void> {
    if (this.outputRouteApplyPending) return this.outputRouteApplyPending
    const operation = (async (): Promise<void> => {
      while (true) {
        const version = this.outputRouteVersion
        const target = this.desiredOutputId
        try {
          if (this.ctx.sinkId !== target) await this.ctx.setSinkId(target)
        } catch (error) {
          if (version !== this.outputRouteVersion) continue
          this.desiredOutputId = this.confirmedOutputId
          this.outputRouteVersion++
          const fallbackVersion = this.outputRouteVersion
          if (this.ctx.sinkId !== this.confirmedOutputId) {
            await this.ctx.setSinkId(this.confirmedOutputId)
          }
          if (fallbackVersion !== this.outputRouteVersion) continue
          throw error
        }
        if (version !== this.outputRouteVersion) continue
        this.confirmedOutputId = target
        return
      }
    })()
    this.outputRouteApplyPending = operation
    try {
      await operation
    } finally {
      if (this.outputRouteApplyPending === operation) this.outputRouteApplyPending = null
    }
  }

  /** Pause/suspend and detach Chromium's destination before the native host
   * opens it. The silent sink is an explicit device release, not a mute. */
  async releaseOutputForNativeMonitor(): Promise<void> {
    if (this.nativeMonitorLease) return
    this.nativeMonitorLease = true
    this.emit()
    try {
      // Drain a route switch already inside setSinkId, then make the silent
      // sink the last physical operation before native begin.
      if (this.outputRouteApplyPending) await this.outputRouteApplyPending
      if (this.ctx.state === 'running') await this.ctx.suspend()
      // Chromium accepts the standards-track silent sink object; the DOM lib
      // bundled with this TypeScript release still declares only the older
      // string overload.
      await (this.ctx.setSinkId as unknown as (
        sink: string | { type: 'none' }
      ) => Promise<void>)({ type: 'none' })
    } catch (error) {
      this.nativeMonitorLease = false
      this.emit()
      try { await this.ctx.resume() } catch { /* preserve the release failure */ }
      throw error
    }
  }

  /** Reattach the saved Chromium route and make the context ready. Sources
   * remain paused; ending monitoring never resumes song playback. */
  async restoreOutputAfterNativeMonitor(): Promise<void> {
    if (!this.nativeMonitorLease) return
    while (true) {
      await this.applyDesiredOutputRoute()
      const restoredVersion = this.outputRouteVersion
      if (this.ctx.state !== 'running') await this.ctx.resume()
      if (restoredVersion !== this.outputRouteVersion) continue
      this.nativeMonitorLease = false
      this.emit()
      return
    }
  }

  get nativeMonitorOwnsOutput(): boolean {
    // During a successful restore the AudioContext lease finishes one
    // microtask before the client clears its renderer ownership. Expose the
    // union so subscribers never observe an unsafe transient "unloaded and
    // unowned" window in which Settings could replace the provider.
    return this.nativeMonitorLease || this.nativePlayback?.active === true
  }

  get position(): number {
    const native = this.nativePlayback?.status
    if (this.nativePlayback?.active && native?.format.sampleRate) {
      const frame = Number(native.audibleProjectFrame)
      return Number.isSafeInteger(frame)
        ? Math.max(0, Math.min(this.duration, frame / native.format.sampleRate))
        : this.startOffset
    }
    if (!this._playing) return this.startOffset
    // Track what the listener hears: stretch-node latency plus device output
    // latency (real seconds), converted to song time by the playback rate.
    const lag = (this.stretchOn ? this.stretchLatency : 0) + (this.ctx.outputLatency || 0)
    const elapsed =
      this.startOffset + (this.ctx.currentTime - this.startedAt - lag) * this.rate
    const r = this.regionLoop ? this.region : null
    if (r && this.startOffset < r.end && elapsed > r.end) {
      // Sources loop natively at r.end -> r.start; fold the linear clock.
      return r.start + ((elapsed - r.end) % (r.end - r.start))
    }
    return Math.min(this.duration, Math.max(this.startOffset, elapsed))
  }

  get transpose(): number {
    return this.semitones
  }

  get tempo(): number {
    return this.rate
  }

  get beats(): BeatInfo | null {
    return this.beatsInfo
  }

  get metronome(): MetronomeConfig {
    return this.met
  }

  /** Live count-in progress for the transport dots (null when not counting). */
  get countInStatus(): { total: number; done: number; perBar: number } | null {
    const c = this.countInfo
    if (c === null || !this._playing) return null
    // Dots flip when clicks are HEARD: the render clock leads the ear by the
    // output-route latency (Bluetooth headphones bite on desktop too). Click
    // times carry the stretch-bus latency already; the music start does not,
    // so the cutoff adds it before comparing.
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0)
    if (now >= this.startedAt + (this.stretchOn ? this.stretchLatency : 0)) return null
    const done = Math.max(0, Math.min(c.total, Math.floor((now - c.firstCtx) / c.periodCtx) + 1))
    return { total: c.total, done, perBar: c.perBar }
  }

  async setBeats(info: BeatInfo | null): Promise<void> {
    if (JSON.stringify(info) === JSON.stringify(this.beatsInfo)) return
    if (this.nativePlayback?.active) {
      await this.nativePlayback.reconfigure({ beat: info })
      this.beatsInfo = info
      this.emit()
      return
    }
    this.beatsInfo = info
    if (!this.restartPendingStart() && this._playing) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
    this.emit()
  }

  get masterVolume(): number {
    return this.masterVol
  }

  /**
   * Master output level. The click bypasses the master bus (so tempo/pitch
   * processing never colors it) but not the master *volume* — pulling
   * everything down has to take the metronome with it.
   */
  setMasterVolume(v: number): void {
    const target = Math.max(0, Math.min(1, v))
    if (this.nativePlayback?.active) {
      void this.nativePlayback.setMasterGain(target).then(() => {
        this.masterVol = target
        this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02)
        this.clickGain.gain.setTargetAtTime(this.met.volume * target, this.ctx.currentTime, 0.02)
        this.trainingGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02)
        this.emit()
      }).catch((error) => console.error('Native master-gain update failed:', error))
      return
    }
    this.masterVol = target
    this.master.gain.setTargetAtTime(this.masterVol, this.ctx.currentTime, 0.02)
    this.clickGain.gain.setTargetAtTime(this.met.volume * this.masterVol, this.ctx.currentTime, 0.02)
    this.trainingGain.gain.setTargetAtTime(this.masterVol, this.ctx.currentTime, 0.02)
    this.emit()
  }

  async setMetronome(m: MetronomeConfig): Promise<void> {
    if (JSON.stringify(m) === JSON.stringify(this.met)) return
    if (this.nativePlayback?.active) {
      await this.nativePlayback.reconfigure({ metronome: m })
      this.met = m
      this.clickGain.gain.setTargetAtTime(m.volume * this.masterVol, this.ctx.currentTime, 0.02)
      this.emit()
      return
    }
    const structural = m.click !== this.met.click || m.countInBars !== this.met.countInBars
    this.met = m
    this.clickGain.gain.setTargetAtTime(m.volume * this.masterVol, this.ctx.currentTime, 0.02)
    if (structural && !this.restartPendingStart() && this._playing) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
    this.emit()
  }

  /** One immediate click — popover feedback (volume preview, tap confirmation). */
  previewClick(accent = false): void {
    if (this.teardownStarted || this.nativeMonitorLease) return
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().then(() => {
        if (!this.teardownStarted && !this.nativeMonitorLease) this.scheduleClick(this.ctx.currentTime, accent)
      }).catch((error: unknown) => {
        if (!this.teardownStarted) console.error('Metronome preview could not start:', error)
      })
      return
    }
    this.scheduleClick(this.ctx.currentTime, accent)
  }

  /**
   * Play region: with loop, sources wrap natively at the region edges (every
   * stem on the same sample — no gap); without loop, playback that started
   * inside the region stops at its end. Live-updatable while playing.
   */
  async setRegion(region: { start: number; end: number } | null, loop: boolean): Promise<void> {
    const targetRegion = region && region.end - region.start > 0.05 ? region : null
    const targetLoop = loop && targetRegion !== null
    if (targetLoop === this.regionLoop &&
        targetRegion?.start === this.region?.start && targetRegion?.end === this.region?.end &&
        (targetRegion !== null) === (this.region !== null)) return
    if (this.nativePlayback?.active) {
      await this.nativePlayback.reconfigure({
        loop: targetLoop ? targetRegion : null
      })
      this.region = targetRegion
      this.regionLoop = targetLoop
      this.syncBoundWatcher()
      this.emit()
      return
    }
    this.region = targetRegion
    this.regionLoop = targetLoop
    for (const src of this.sources) this.applyLoop(src)
    this.syncBoundWatcher()
    if (this._playing && this.ctx.currentTime >= this.startedAt) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
  }

  private applyLoop(src: AudioBufferSourceNode): void {
    const r = this.regionLoop ? this.region : null
    if (r && src.buffer) {
      src.loopStart = Math.max(0, r.start)
      src.loopEnd = Math.min(r.end, src.buffer.duration)
      src.loop = src.loopEnd - src.loopStart > 0.05
    } else {
      src.loop = false
    }
  }

  /** A selection without loop bounds playback: stop when its end is reached. */
  private syncBoundWatcher(): void {
    const active = this._playing && this.region !== null && !this.regionLoop
    if (active && this.boundTimer === null) {
      this.boundTimer = setInterval(() => {
        const r = this.region
        if (!this._playing || !r || this.regionLoop) return
        if (this.startOffset < r.end && this.position >= r.end - 0.015) {
          this.pause()
          this.startOffset = Math.min(r.end, this.duration)
          this.emit()
        }
      }, 25)
    } else if (!active && this.boundTimer !== null) {
      clearInterval(this.boundTimer)
      this.boundTimer = null
    }
  }

  /**
   * Arm or clear the vocal-training schedule. Ducking is a separate layer on
   * the per-stem gains — user mute/solo/volume are untouched and restored
   * exactly when training ends.
   */
  async setTraining(spec: TrainingSpec | null): Promise<void> {
    if (JSON.stringify(spec) === JSON.stringify(this.training)) return
    if (this.nativePlayback?.active) {
      await this.nativePlayback.reconfigure({ training: spec })
      this.training = spec
      this.ducked.clear()
      this.syncTrainWatcher()
      this.trainTick()
      return
    }
    this.training = spec
    this.syncTrainWatcher()
    this.trainTick()
  }

  /** Stems currently ducked by the training schedule. */
  get duckedStems(): string[] {
    return [...this.ducked]
  }

  get acceptedRegion(): { region: { start: number; end: number } | null; loop: boolean } {
    return { region: this.region ? { ...this.region } : null, loop: this.regionLoop }
  }

  get acceptedTraining(): TrainingSpec | null {
    if (this.training === null) return null
    return this.training.mode === 'period'
      ? { ...this.training, stems: [...this.training.stems] }
      : {
          ...this.training,
          windows: this.training.windows.map((window) => ({ ...window })),
          stems: [...this.training.stems]
        }
  }

  private duckAt(pos: number): boolean {
    const tr = this.training
    if (!tr) return false
    if (tr.mode === 'period') return Math.floor(pos / tr.periodSec) % 2 === 1
    for (const w of tr.windows) if (pos >= w.s && pos < w.e) return true
    return false
  }

  /** Apply the schedule at the current position; a no-op while nothing changes. */
  private trainTick(): void {
    const tr = this.training
    const want = tr && this.duckAt(this.position) ? tr.stems : []
    if (want.length === this.ducked.size && want.every((id) => this.ducked.has(id))) return
    this.ducked = new Set(want)
    this.applyGains()
    this.emit()
  }

  private syncTrainWatcher(): void {
    const active = this._playing && this.training !== null
    if (active && this.trainTimer === null) {
      this.trainTimer = setInterval(() => this.trainTick(), 50)
    } else if (!active && this.trainTimer !== null) {
      clearInterval(this.trainTimer)
      this.trainTimer = null
    }
  }

  /* ---- Metronome click pipeline ----------------------------------------- */

  /** Woodblock-ish clicks, synthesized once per context (no assets). */
  private makeClickBuffers(): { accent: AudioBuffer; beat: AudioBuffer } {
    const sr = this.ctx.sampleRate
    const mk = (freq: number, amp: number): AudioBuffer => {
      const n = Math.round(sr * 0.055)
      const buf = this.ctx.createBuffer(1, n, sr)
      const d = buf.getChannelData(0)
      for (let i = 0; i < n; i++) {
        const t = i / sr
        d[i] = amp * Math.min(1, t / 0.0015) * Math.exp(-t / 0.012) * Math.sin(2 * Math.PI * freq * t)
      }
      return buf
    }
    return { accent: mk(1568, 0.9), beat: mk(1046.5, 0.62) }
  }

  private scheduleClick(at: number, accent: boolean): void {
    if (this.clickBufs === null) this.clickBufs = this.makeClickBuffers()
    const src = this.ctx.createBufferSource()
    src.buffer = accent ? this.clickBufs.accent : this.clickBufs.beat
    src.connect(this.clickGain)
    src.onended = () => src.disconnect()
    src.start(Math.max(at, this.ctx.currentTime))
    this.clickNodes.push({ node: src, at })
    this.clickCount++
  }

  private cancelPendingClicks(): void {
    const now = this.ctx.currentTime
    for (const c of this.clickNodes) {
      if (c.at > now + 0.002) {
        c.node.onended = null
        try {
          c.node.stop()
        } catch {
          // raced its own end
        }
        c.node.disconnect()
      }
    }
    this.clickNodes = this.clickNodes.filter((c) => c.at <= now + 0.002)
  }

  /**
   * Context time when song time `songT` sounds, `lap` region-loop wraps in.
   * Clicks bypass the stretch node, so its latency is added back to stay
   * simultaneous with the (delayed) stems. Valid for pre-start (count-in)
   * song times too: they map to the pre-roll before `startedAt`.
   */
  private clickCtxTime(songT: number, lap: number): number {
    const r = this.regionLoop ? this.region : null
    const linear = r && lap > 0 ? r.end + (lap - 1) * (r.end - r.start) + (songT - r.start) : songT
    const lat = this.stretchOn ? this.stretchLatency : 0
    return this.startedAt + (linear - this.startOffset) / this.rate + lat
  }

  /** Step the click walker one beat forward (loop wraps, region/song ends). */
  private advanceClick(): void {
    const g = this.beatsInfo
    if (g === null || this.nextClickIdx === null) return
    const idx = this.nextClickIdx + 1
    // A count-in without the playback click ends where the music enters.
    if (!this.met.click && this.startBeatIdx !== null && idx >= this.startBeatIdx) {
      this.nextClickIdx = null
      return
    }
    const t = beatTime(g, idx)
    const r = this.region
    if (r && this.startOffset < r.end && t > r.end - 1e-6) {
      if (this.regionLoop) {
        const wrapped = beatIndexAtOrAfter(g, r.start)
        if (beatTime(g, wrapped) < r.end - 1e-6) {
          this.clickLap++
          this.nextClickIdx = wrapped
        } else {
          this.nextClickIdx = null // no beat inside the loop
        }
      } else {
        this.nextClickIdx = null // playback stops at the selection end
      }
      return
    }
    this.nextClickIdx = t > this.duration ? null : idx
  }

  /** Re-derive the next click from what sounds right now (seek/rate/region/beat edits). */
  private armClicksFromCurrent(): void {
    const g = this.beatsInfo
    this.countInfo = null
    this.startBeatIdx = null
    this.nextClickIdx = null
    if (this._playing && g !== null && this.met.click) {
      const linear = this.startOffset + (this.ctx.currentTime - this.startedAt) * this.rate
      const r = this.regionLoop ? this.region : null
      let lap = 0
      let pos = linear
      if (r && this.startOffset < r.end && linear > r.end) {
        const len = r.end - r.start
        lap = 1 + Math.floor((linear - r.end) / len)
        pos = r.start + ((linear - r.end) % len)
      }
      let idx = beatIndexAtOrAfter(g, Math.max(0, pos))
      if (r && beatTime(g, idx) > r.end - 1e-6) {
        const wrapped = beatIndexAtOrAfter(g, r.start)
        if (beatTime(g, wrapped) < r.end - 1e-6) {
          lap++
          idx = wrapped
        } else {
          idx = Number.NaN
        }
      }
      if (Number.isFinite(idx) && beatTime(g, idx) <= this.duration) {
        this.nextClickIdx = idx
        this.clickLap = lap
      }
    }
    this.syncClickWatcher()
  }

  private clickTick(): void {
    if (!this._playing || this.beatsInfo === null) return
    const now = this.ctx.currentTime
    if (this.clickNodes.length > 0) {
      this.clickNodes = this.clickNodes.filter((c) => c.at > now - 0.5)
    }
    const horizon = now + CLICK_LOOKAHEAD
    let guard = 96 // hard cap per tick (degenerate region/beat combinations)
    while (this.nextClickIdx !== null && guard-- > 0) {
      const at = this.clickCtxTime(beatTime(this.beatsInfo, this.nextClickIdx), this.clickLap)
      if (at > horizon) return
      if (at >= now - 0.02) {
        this.scheduleClick(
          at,
          this.met.accent && accentIndex(this.beatsInfo, this.nextClickIdx) === 0
        )
      }
      this.advanceClick()
    }
    if (this.nextClickIdx === null) this.syncClickWatcher()
  }

  private syncClickWatcher(): void {
    const active = this._playing && this.beatsInfo !== null && this.nextClickIdx !== null
    if (active && this.clickTimer === null) {
      this.clickTimer = setInterval(() => this.clickTick(), CLICK_TICK_MS)
    } else if (!active && this.clickTimer !== null) {
      clearInterval(this.clickTimer)
      this.clickTimer = null
    }
  }

  /**
   * A tempo-rate/grid/count-in change while the pre-roll is still pending:
   * rebuild the whole start (sources have not sounded yet, so restarting is
   * inaudible and keeps every schedule consistent).
   */
  private restartPendingStart(): boolean {
    if (!this._playing || this.ctx.currentTime >= this.startedAt - 1e-3) return false
    const off = this.startOffset
    this.stopSources()
    this.cancelPendingClicks()
    this._playing = false
    this.countInfo = null
    this.startBeatIdx = null
    this.nextClickIdx = null
    this.startOffset = off
    this.requestPlay('pre-roll-restart')
    return true
  }

  /**
   * Pitch-shift the whole mix (one Signalsmith Stretch node on the master bus:
   * phase-coherent across stems, duration unchanged, per-stem mutes stay live).
   */
  private disposeStretchNode(node: StretchNode | null): void {
    if (!node) return
    try { node.schedule({ active: false }) } catch { /* node did not finish initializing */ }
    try { node.stop() } catch { /* node was never started or already stopped */ }
    try { node.disconnect() } catch { /* node was never connected */ }
  }

  private cancelStretchForTeardown(): void {
    this.stretchEpoch++
    for (const timeout of this.stretchTimeouts) clearTimeout(timeout)
    this.stretchTimeouts.clear()
    // Clearing the 5 s timeout alone would leave a never-booting worklet's
    // Promise.race pending forever. Settle every waiter now; each one sees
    // teardownStarted and returns without touching the graph.
    const reason = new Error('Audio engine is disposed.')
    for (const reject of this.stretchWaiters) reject(reason)
    this.stretchWaiters.clear()
    for (const node of this.pendingStretches) this.disposeStretchNode(node)
    this.pendingStretches.clear()
    this.disposeStretchNode(this.stretch)
    this.stretch = null
    this.stretchPromise = null
    this.stretchLatency = 0
    this.stretchOn = false
    try { this.master.disconnect() } catch { /* already disconnected */ }
  }

  /** Create the stretch worklet once; concurrent callers share the same promise. */
  private ensureStretch(): Promise<StretchNode> {
    if (this.teardownStarted) return Promise.reject(new Error('Audio engine is disposed.'))
    if (!this.stretchPromise) {
      const expectedEpoch = this.stretchEpoch
      const operation = (async () => {
        const node = await SignalsmithStretch(this.ctx)
        this.pendingStretches.add(node)
        if (this.teardownStarted || expectedEpoch !== this.stretchEpoch) {
          this.disposeStretchNode(node)
          this.pendingStretches.delete(node)
          throw new Error('Stretch initialization was cancelled.')
        }
        let latency = 0
        try {
          const l = node.latency()
          latency = typeof l === 'number' ? l : ((await l) ?? 0)
        } catch {
          latency = 0
        }
        if (this.teardownStarted || expectedEpoch !== this.stretchEpoch) {
          this.disposeStretchNode(node)
          this.pendingStretches.delete(node)
          throw new Error('Stretch initialization was cancelled.')
        }
        node.connect(this.ctx.destination)
        this.stretchLatency = latency
        this.stretch = node
        this.pendingStretches.delete(node)
        return node
      })()
      this.stretchPromise = operation
      void operation.catch(() => {
        if (this.stretchPromise === operation) this.stretchPromise = null
      })
    }
    return this.stretchPromise
  }

  async setTranspose(st: number): Promise<void> {
    if (this.teardownStarted) return
    const target = Math.max(-12, Math.min(12, Math.round(st)))
    if (target === this.semitones) return
    if (this.nativePlayback?.active) {
      await this.nativePlayback.reconfigure({ transpose: target })
      this.semitones = target
      this.emit()
      return
    }
    this.semitones = target
    await this.applyStretchState()
    if (this.teardownStarted) return
    this.emit()
  }

  /**
   * Playback speed with pitch preserved: every stem source runs at `rate`
   * (varispeed, sample-locked), and the master-bus stretch node corrects the
   * resulting pitch shift by -12*log2(rate) on top of the user's transpose.
   */
  async setTempo(rate: number): Promise<void> {
    if (this.teardownStarted) return
    const target = Math.round(Math.max(0.5, Math.min(1.5, rate)) * 10000) / 10000
    if (Math.abs(target - this.rate) < 0.0001) return
    if (this.nativePlayback?.active) {
      await this.nativePlayback.reconfigure({ playbackRate: target })
      this.rate = target
      this.emit()
      return
    }
    this.applyRate(target)
    await this.applyStretchState()
    if (this.teardownStarted) return
    this.emit()
  }

  /** Re-anchor the clock at the current position, then switch the rate. */
  private applyRate(rate: number): void {
    if (this._playing && this.ctx.currentTime < this.startedAt - 1e-3) {
      // Still in the count-in pre-roll: nothing has sounded, restart it
      // wholesale at the new rate (re-anchoring here would teleport the start).
      this.rate = rate
      this.restartPendingStart()
      return
    }
    if (this._playing) {
      this.startOffset = this.position
      this.startedAt = this.ctx.currentTime
    }
    this.rate = rate
    for (const src of this.sources) src.playbackRate.value = rate
    if (this._playing) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
  }

  /** Click times include the stretch latency — re-derive when it flips on/off. */
  private rearmClicksAfterLatencyFlip(wasOn: boolean): void {
    if (this.stretchOn !== wasOn && this._playing && this.ctx.currentTime >= this.startedAt) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
  }

  private async applyStretchState(): Promise<void> {
    if (this.teardownStarted) return
    const expectedEpoch = this.stretchEpoch
    const semitones = this.semitones
    const rate = this.rate
    const wasOn = this.stretchOn
    if (semitones === 0 && rate === 1) {
      this.stretchOn = false
      this.stretch?.schedule({ active: false })
      this.master.disconnect()
      this.master.connect(this.ctx.destination)
      this.rearmClicksAfterLatencyFlip(wasOn)
      return
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    let waiter: ((reason: Error) => void) | null = null
    try {
      // A worklet that never finishes booting (e.g. CSP blocking its WASM)
      // must fail loudly, not leave the mix silently unprocessed.
      const stretch = await Promise.race([
        this.ensureStretch(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('stretch worklet did not start within 5s')), 5000)
          this.stretchTimeouts.add(timeout)
          waiter = reject
          this.stretchWaiters.add(reject)
        })
      ])
      if (this.teardownStarted || expectedEpoch !== this.stretchEpoch ||
          this.semitones !== semitones || this.rate !== rate) return // superseded
      this.master.disconnect()
      this.master.connect(stretch)
      stretch.schedule({ active: true, semitones: semitones - 12 * Math.log2(rate) })
      this.stretchOn = true
      this.rearmClicksAfterLatencyFlip(wasOn)
    } catch (err) {
      if (this.teardownStarted || expectedEpoch !== this.stretchEpoch) return
      this.stretchEpoch++
      for (const node of this.pendingStretches) this.disposeStretchNode(node)
      this.pendingStretches.clear()
      this.stretchPromise = null
      console.error('Pitch/tempo processing unavailable:', err)
      this.semitones = 0
      this.applyRate(1)
      this.stretchOn = false
      this.master.disconnect()
      this.master.connect(this.ctx.destination)
      this.rearmClicksAfterLatencyFlip(wasOn)
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout)
        this.stretchTimeouts.delete(timeout)
      }
      if (waiter !== null) this.stretchWaiters.delete(waiter)
    }
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data)
  }

  getTrackStates(): TrackState[] {
    return this.tracks.map(({ id, muted, solo, volume }) => ({ id, muted, solo, volume }))
  }

  load(
    list: EngineTrackInput[],
    opts: {
      position?: number
      play?: boolean
      /** Omitted only for a same-song lane hot-swap. New-song loads pass the
       * verified document or explicit null so an old graph cannot leak. */
      graphDocument?: ParsedGraphDocument | null
    } = {}
  ): void {
    // Teardown is terminal for this app-lifetime engine: a late song load
    // must not allocate graph nodes, replace state or wake dead subscribers.
    if (this.teardownStarted) return
    this.clearRequestedPlaybackError()
    this._songEpoch++
    if (this.nativePlayback?.active) this.beginNativePlaybackUnload()
    this.stopSources()
    this.cancelPendingClicks()
    this.nextClickIdx = null
    this.countInfo = null
    this.startBeatIdx = null
    this.ducked.clear() // fresh tracks start unducked; the schedule re-applies on play
    if (Object.prototype.hasOwnProperty.call(opts, 'graphDocument')) {
      this.graphDocument = opts.graphDocument ?? null
    }
    for (const t of this.tracks) t.gain.disconnect()
    this.tracks = list.map((t) => {
      const gain = this.ctx.createGain()
      gain.connect(this.master)
      return { id: t.id, buffer: t.buffer, path: t.path, gain, volume: 1, muted: false, solo: false }
    })
    this.duration = this.tracks.reduce((d, t) => Math.max(d, t.buffer.duration), 0)
    this.startOffset = Math.min(opts.position ?? 0, this.duration)
    this._playing = false
    this.applyGains(true)
    this.emit()
    // Mid-session reloads (post-split hot-swap) resume without a count-in.
    if (opts.play) this.requestPlay('auto-resume', { countIn: false })
  }

  play(opts: { countIn?: boolean } = {}): Promise<void> {
    if (this.teardownStarted) return Promise.resolve()
    const operation = this.performPlay(opts)
    this.pendingPlayRequests.add(operation)
    return operation.finally(() => {
      this.pendingPlayRequests.delete(operation)
    })
  }

  private async performPlay(opts: { countIn?: boolean }): Promise<void> {
    const requestGeneration = ++this.generation
    if (this.nativePlaybackUnload) await this.settleNativePlaybackUnload()
    if (requestGeneration !== this.generation) return
    const nativeRecoveryPending = this.nativePlayback?.recoveryPending === true
    if (this.nativePlayback?.active && !nativeRecoveryPending) {
      // Play after the song ran out restarts it: the core's resume() only
      // continues a paused transport, and a seek while paused stays paused,
      // so seek first — to the region start when looping, else the top.
      const atEnd = this.nativePlayback.status?.transportState === 'completed' ||
        this.startOffset >= this.duration - 0.01
      if (atEnd) {
        const restart = this.regionLoop && this.region ? this.region.start : 0
        await this.nativePlayback.seek(restart)
        if (requestGeneration !== this.generation) return
        this.startOffset = restart
      }
      await this.nativePlayback.resume()
      if (requestGeneration !== this.generation) return
      this._playing = true
      this.clearRequestedPlaybackError()
      this.emit()
      return
    }
    if ((this.nativeMonitorLease && !nativeRecoveryPending) ||
        this._playing || this.tracks.length === 0) return
    this.trainingCues?.cancel()
    // A recovery retry deliberately keeps Chromium on the silent sink. It
    // must not reacquire WASAPI before retrying the exact native provider.
    if (!nativeRecoveryPending && this.ctx.state === 'suspended') await this.ctx.resume()
    if (requestGeneration !== this.generation) return
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0

    const nativeModule = await this.ensureNativePlayback()
    if (requestGeneration !== this.generation) return
    // A quarantined native generation is not resumable. Retire it while the
    // renderer keeps the silent output lease, then let the ordinary native
    // selection path retry only the same provider. No WebAudio route is
    // restored or started inside this recovery request.
    if (nativeRecoveryPending && nativeModule.client.recoveryMode === 'cleanup-required') {
      await nativeModule.client.cleanupForRetry()
      if (requestGeneration !== this.generation) return
    }
    const nativeStarted = await nativeModule.tryStart(nativeModule.client, {
      lanes: this.tracks,
      beat: this.beatsInfo,
      metronome: this.met,
      countIn: opts.countIn !== false,
      positionSeconds: this.startOffset,
      durationSeconds: this.duration,
      sampleRate: this.ctx.sampleRate,
      masterGain: this.masterVol,
      playbackRate: this.rate,
      transpose: this.semitones,
      training: this.training,
      loop: this.regionLoop ? this.region : null,
      nativeAudioProvider: this.nativeAudioProvider,
      graphDocument: this.graphDocument
    })
    if (requestGeneration !== this.generation) return
    if (nativeStarted) {
      this._playing = true
      this.clearRequestedPlaybackError()
      this.syncBoundWatcher()
      this.syncTrainWatcher()
      this.emit()
      return
    }
    if (nativeRecoveryPending) {
      throw new nativeModule.RecoveryError(
        nativeModule.client.recoveryProviderId ?? this.nativeAudioProvider,
        'provider-recovery-unavailable',
        null,
        'The retained native provider cannot retry with the current runtime, toggle, or graph.'
      )
    }

    const gen = ++this.generation
    let when = this.ctx.currentTime + START_DELAY
    // Metronome pipeline. A count-in pushes the music start out and clicks
    // through the beats leading up to it — real preceding beats when they
    // exist (mid-song starts count in at the local tempo), extrapolated ones
    // before the track begins. The playback click then carries on from the
    // first in-song beat.
    this.countInfo = null
    this.startBeatIdx = null
    this.nextClickIdx = null
    this.clickLap = 0
    const g = this.beatsInfo
    const bars = this.met.countInBars
    const countIn = opts.countIn !== false && bars > 0 && g !== null
    if (g !== null && (countIn || this.met.click)) {
      const i0 = beatIndexAtOrAfter(g, this.startOffset)
      this.startBeatIdx = i0
      if (countIn) {
        // Bar length AT the entry beat: a count-in into a 3-beat bar counts 3.
        const beats = bars * barLengthAt(g, i0)
        const first = i0 - beats
        when += (this.startOffset - beatTime(g, first)) / this.rate
        this.nextClickIdx = first
      } else if (beatTime(g, i0) <= this.duration) {
        this.nextClickIdx = i0
      }
    }
    // No grid (rubato) — count in by the clock instead: bars×3 ticks, one per
    // second, the music entering one second after the last tick. Wall-clock
    // pre-roll: the playback rate has no bearing on how humans count seconds.
    const secTicks = opts.countIn !== false && bars > 0 && g === null ? bars * SEC_COUNT_TICKS : 0
    when += secTicks * SEC_COUNT_PERIOD
    this.sources = []
    let longestIdx = 0
    this.tracks.forEach((t, i) => {
      const src = this.ctx.createBufferSource()
      src.buffer = t.buffer
      src.playbackRate.value = this.rate
      this.applyLoop(src)
      src.connect(t.gain)
      src.start(when, Math.min(this.startOffset, t.buffer.duration))
      this.sources.push(src)
      if (t.buffer.duration > this.tracks[longestIdx].buffer.duration) longestIdx = i
    })
    const watched = this.sources[longestIdx]
    if (watched) {
      watched.onended = () => {
        if (gen === this.generation && this._playing) {
          this._playing = false
          this.startOffset = this.duration
          this.nextClickIdx = null
          this.syncClickWatcher()
          this.emit()
        }
      }
    }
    this.startedAt = when
    this._playing = true
    this.clearRequestedPlaybackError()
    if (countIn && g !== null && this.nextClickIdx !== null && this.startBeatIdx !== null) {
      const perBar = barLengthAt(g, this.startBeatIdx)
      const total = bars * perBar
      const span = this.startOffset - beatTime(g, this.nextClickIdx)
      this.countInfo = {
        firstCtx: this.clickCtxTime(beatTime(g, this.nextClickIdx), 0),
        periodCtx: span / total / this.rate,
        total,
        perBar
      }
    } else if (secTicks > 0) {
      // Short and bounded — schedule every tick now, no walker involved.
      // Ticks carry the stretch-bus latency like beat clicks do, so the
      // last-tick→music gap is exactly one second at the ear.
      const firstCtx = when + (this.stretchOn ? this.stretchLatency : 0) - secTicks * SEC_COUNT_PERIOD
      for (let k = 0; k < secTicks; k++) {
        this.scheduleClick(firstCtx + k * SEC_COUNT_PERIOD, this.met.accent && k % SEC_COUNT_TICKS === 0)
      }
      this.countInfo = {
        firstCtx,
        periodCtx: SEC_COUNT_PERIOD,
        total: secTicks,
        perBar: SEC_COUNT_TICKS
      }
    }
    this.syncBoundWatcher()
    this.syncTrainWatcher()
    this.trainTick() // duck state must be right before the first sample sounds
    this.syncClickWatcher()
    this.clickTick() // first clicks must land inside the initial lookahead
    this.emit()
  }

  pause(): void {
    // A play request can be awaiting AudioContext.resume() without having
    // created sources or set _playing yet. Pausing still revokes that request.
    this.generation++
    if (this.nativePlayback?.active) {
      // Nothing to pause when the transport is KNOWN to be parked and no play
      // is in flight: the core refuses the command and it reads as a failure.
      // Mid-rebuild (no status yet) the pause must still queue behind the
      // rebuild, which would otherwise restart playback under a paused UI.
      if (this.nativePlayback.transportParked && this.pendingPlayRequests.size === 0) {
        this._playing = false
        this.syncBoundWatcher()
        this.syncTrainWatcher()
        this.emit()
        return
      }
      void this.nativePlayback.pause().then(() => {
        this._playing = false
        this.syncBoundWatcher()
        this.syncTrainWatcher()
        this.emit()
      }).catch((error) => console.error('Native pause failed:', error))
      return
    }
    if (!this._playing) return
    this.startOffset = this.position
    this._playing = false
    this.stopSources()
    this.cancelPendingClicks()
    this.nextClickIdx = null
    this.countInfo = null
    this.startBeatIdx = null
    this.syncBoundWatcher()
    this.syncTrainWatcher()
    this.syncClickWatcher()
    this.emit()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.requestPlay('toggle')
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration))
    if (this.nativePlayback?.active) {
      void this.nativePlayback.seek(clamped).then(() => {
        this.startOffset = clamped
        this.trainTick()
        this.emit()
      }).catch((error) => console.error('Native seek failed:', error))
      return
    }
    if (this._playing) {
      this.stopSources()
      this.cancelPendingClicks()
      this._playing = false
      this.startOffset = clamped
      // Seeks restart playback in place — a count-in belongs to a deliberate
      // play, not to scrubbing around.
      this.requestPlay('seek-restart', { countIn: false })
    } else {
      this.startOffset = clamped
      this.trainTick() // keep the ducked-lane preview honest while paused
      this.emit()
    }
  }

  seekBy(dt: number): void {
    this.seek(this.position + dt)
  }

  setMuted(id: string, muted: boolean): void {
    const t = this.tracks.find((t) => t.id === id)
    if (!t) return
    if (this.nativePlayback?.active) {
      void this.nativePlayback.updateLane(t.id, { muted }).then((accepted) => {
        t.volume = accepted.gain
        t.muted = accepted.muted
        t.solo = accepted.solo
        this.applyGains()
        this.emit()
      }).catch((error) => console.error('Native lane mute update failed:', error))
      return
    }
    t.muted = muted
    this.applyGains()
    this.emit()
  }

  setSolo(id: string, solo: boolean): void {
    const t = this.tracks.find((t) => t.id === id)
    if (!t) return
    if (this.nativePlayback?.active) {
      void this.nativePlayback.updateLane(t.id, { solo }).then((accepted) => {
        t.volume = accepted.gain
        t.muted = accepted.muted
        t.solo = accepted.solo
        this.applyGains()
        this.emit()
      }).catch((error) => console.error('Native lane solo update failed:', error))
      return
    }
    t.solo = solo
    this.applyGains()
    this.emit()
  }

  setVolume(id: string, volume: number): void {
    const t = this.tracks.find((t) => t.id === id)
    if (!t) return
    const target = Math.max(0, Math.min(1, volume))
    if (this.nativePlayback?.active) {
      void this.nativePlayback.updateLane(t.id, { gain: target }).then((accepted) => {
        t.volume = accepted.gain
        t.muted = accepted.muted
        t.solo = accepted.solo
        this.applyGains()
        this.emit()
      }).catch((error) => console.error('Native lane volume update failed:', error))
      return
    }
    t.volume = target
    this.applyGains()
    this.emit()
  }

  private applyGains(instant = false): void {
    const anySolo = this.tracks.some((t) => t.solo)
    for (const t of this.tracks) {
      const audible = !t.muted && (!anySolo || t.solo) && !this.ducked.has(t.id)
      const target = audible ? t.volume : 0
      if (instant) {
        t.gain.gain.value = target
      } else {
        t.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.02)
      }
    }
  }

  private stopSources(): void {
    this.generation++
    for (const s of this.sources) {
      s.onended = null
      try {
        s.stop()
      } catch {
        // never started or already stopped
      }
      s.disconnect()
    }
    this.sources = []
  }
}
