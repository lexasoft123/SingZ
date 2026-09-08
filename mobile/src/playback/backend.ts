import type {
  EngineTrackInput,
  MultitrackEngine,
  TrackState,
  TrainingSpec
} from '../engine'
import {
  MET_DEFAULTS,
  sanitizeBeatInfo,
  sanitizeMetronome,
  type BeatInfo,
  type MetronomeConfig
} from '../model'
import type {
  LoadedProject,
  NativePlaybackHandle,
  NativePlaybackStartOutcome,
  PlaybackCountInStatus
} from '../projects'
import { log } from '../log'
import { rebuildNativePlaybackCues } from './native'

/**
 * What the singer just did, and how long it took them to get it.
 *
 * The graph lines under `dsp` already say a generation was prepared and a seam
 * landed; what they do not say is which TOUCH caused it. A log showing
 * "preparing graph · generation 4 · ×1.05" asks the reader to know that ×1.05
 * is the pitch control, and a metronome toggle is only visible as the words
 * "cues click off" inside a much longer line. Both were invisible to the
 * person who pressed them.
 *
 * Timed from the touch to the point the change is actually in effect, which is
 * the number a singer cares about and no other line reports: the graph lines
 * time their own stage, so a slow pitch change could be a slow prepare, a slow
 * seam, or a wait behind another action, and none of them would say so.
 *
 * Continuous controls (a volume drag, the master fader) are deliberately NOT
 * logged: one line per animation frame would bury everything else in a log
 * that keeps 400 lines.
 */
/** "pitch +1", "tempo x1.05", or both — and what it moved FROM, since a log
 *  read after the fact cannot otherwise tell a nudge from a jump. */
export function describePitchTempo(
  semitones: number,
  rate: number,
  fromSemitones: number,
  fromRate: number
): string {
  const parts: string[] = []
  if (semitones !== fromSemitones) {
    const signed = (value: number): string => (value > 0 ? `+${value}` : `${value}`)
    parts.push(`pitch ${signed(semitones)}${
      fromSemitones === 0 && semitones === 0 ? '' : ` (was ${signed(fromSemitones)})`
    }`)
  }
  if (rate !== fromRate)
    parts.push(`tempo x${rate.toFixed(2)} (was x${fromRate.toFixed(2)})`)
  return parts.length === 0 ? 'pitch and tempo unchanged' : parts.join(' · ')
}

/** A metronome toggle reads as "cues click off" inside a 2000-character graph
 *  line today, which is not something anyone finds. This is the short form:
 *  what the singer turned on or off, and the count-in that came with it. */
export function describeCueChange(
  before: MetronomeConfig | null,
  after: MetronomeConfig | null
): string {
  if (after === null) return 'metronome off'
  const parts: string[] = []
  if (before === null || before.click !== after.click)
    parts.push(`metronome ${after.click ? 'on' : 'off'}`)
  if (before === null || before.accent !== after.accent)
    parts.push(`accent ${after.accent ? 'on' : 'off'}`)
  if (before === null || before.countInBars !== after.countInBars)
    parts.push(`count-in ${after.countInBars} ${after.countInBars === 1 ? 'bar' : 'bars'}`)
  if (before === null || before.volume !== after.volume)
    parts.push(`click volume ${Math.round(after.volume * 100)}%`)
  // A beat-grid change with the metronome untouched still rebuilds the cue
  // graph and still costs the singer the wait, so it says so rather than
  // printing nothing.
  return parts.length === 0 ? 'beat grid rebuilt' : parts.join(' · ')
}

/** Which lanes drop out and on what schedule — the two things that decide
 *  whether training sounded the way the singer meant it to. */
export function describeTraining(spec: TrainingSpec | null): string {
  if (spec === null) return 'training off'
  const lanes = spec.stems.length === 0 ? 'no lanes' : spec.stems.join('+')
  return spec.mode === 'period'
    ? `training on · ${lanes} · every ${spec.periodSec}s`
    : `training on · ${lanes} · ${spec.windows.length} ${
        spec.windows.length === 1 ? 'window' : 'windows'
      }`
}

/** m:ss — a loop at "1:02-1:18" is readable; one at "62.4-78.9" is not. */
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function logAction(what: string, startedAt: number): void {
  log('action', `${what} · ${fmtDuration(Date.now() - startedAt)}`)
}

function logActionFailed(what: string, startedAt: number): void {
  log('action', `${what} · did not take · ${fmtDuration(Date.now() - startedAt)}`, 'warn')
}

/** Clamped, because a clock that steps backwards must not print nonsense. */
export function fmtDuration(ms: number): string {
  const value = Math.max(0, ms)
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
}

export type PlaybackOperation =
  | 'pause'
  | 'seek'
  | 'loop-region'
  | 'metronome'
  | 'mixer'
  | 'pitch-tempo'
  | 'training'
  | 'preview-click'

export interface PlaybackCapabilities {
  readonly pause: boolean
  readonly seek: boolean
  readonly loopRegion: boolean
  readonly metronome: boolean
  readonly mixer: boolean
  readonly pitchTempo: boolean
  readonly training: boolean
  readonly previewClick: boolean
}

export class PlaybackUnsupportedError extends Error {
  readonly code = 'PLAYBACK_OPERATION_UNSUPPORTED' as const

  constructor(
    readonly backend: PlaybackBackend['kind'],
    readonly operation: PlaybackOperation
  ) {
    super(`${operation} is not supported by the ${backend} playback backend.`)
    this.name = 'PlaybackUnsupportedError'
  }
}

export type PlaybackActionOutcome =
  | { readonly kind: 'completed' }
  | { readonly kind: 'fallback'; readonly project: LoadedProject }

interface NativeCueState {
  readonly beat: BeatInfo | null
  readonly metronome: MetronomeConfig
}

/**
 * The ordinary player's public audio contract. Both implementations own one
 * output path: the native implementation never creates or drives an
 * RNAudioAPI graph, while the legacy implementation delegates every operation
 * directly to the existing MultitrackEngine.
 */
export interface PlaybackBackend {
  readonly kind: 'legacy' | 'ios-native' | 'android-native'
  readonly capabilities: PlaybackCapabilities
  readonly playing: boolean
  readonly position: number
  readonly audioPosition: number
  readonly duration: number
  readonly displayLatency: number
  /**
   * A control is withdrawn only for the moment, not for good.
   *
   * A structural graph swap makes the core refuse seeks for its duration, so
   * `capabilities.seek` goes false — but the singer has not asked for
   * something the app cannot do, and telling them it "stays disabled until
   * its native DSP control is connected" would be a lie in a modal.
   */
  readonly reconfiguring: boolean
  readonly countInStatus: PlaybackCountInStatus | null
  readonly regionState: { start: number; end: number; loop: boolean } | null
  readonly duckedStems: string[]
  readonly beats: BeatInfo | null
  readonly metronome: MetronomeConfig
  readonly pitchTempo: { semitones: number; rate: number }
  readonly masterGain: number
  /** Last native command/rebuild failure. A rejected receipt is observable
   * without publishing the requested control as accepted. */
  readonly error: string | null

  /**
   * The singer's per-route latency correction, in seconds.
   *
   * The OS under-reports output latency on Bluetooth and CarPlay by 30-100 ms,
   * which is why this trim exists at all. The legacy engine has always been
   * given it folded into its display latency by the app shell; the native
   * backend was given nothing, so on exactly the routes where the correction
   * matters the lyric highlight ran early by whatever the singer had dialled
   * in — the "highlighting moves slow" report.
   */
  setDisplayTrim(seconds: number): void

  attach(project: LoadedProject): void
  subscribe(listener: () => void): () => void
  getTrackStates(): TrackState[]
  play(): Promise<PlaybackActionOutcome>
  toggle(): Promise<PlaybackActionOutcome>
  pause(): void
  stop(reason?: string): Promise<void>
  seek(seconds: number): void
  seekBy(seconds: number): void
  setRegion(region: { start: number; end: number } | null, loop: boolean): Promise<void>
  setBeats(info: BeatInfo | null): void
  setMetronome(config: MetronomeConfig): void
  setMuted(id: string, muted: boolean): void
  setSolo(id: string, solo: boolean): void
  setVolume(id: string, volume: number): void
  setMasterGain(gain: number): void
  setPitchTempo(semitones: number, rate: number): void
  setTraining(spec: TrainingSpec | null): void
  previewClick(accent?: boolean): void
  unload(reason?: string): Promise<void>
}

const LEGACY_CAPABILITIES: PlaybackCapabilities = {
  pause: true,
  seek: true,
  loopRegion: true,
  metronome: true,
  mixer: true,
  pitchTempo: true,
  training: true,
  previewClick: true
}

const nativeTransportCapabilities = (
  transportControls: boolean,
  structuralChangePending: boolean
): PlaybackCapabilities => ({
  pause: transportControls,
  // A structural graph swap temporarily owns the signed transport snapshot.
  // Disable commands synchronously while it is in flight so a seek/loop can
  // never queue behind a request whose target graph did not exist yet. The
  // prepared Signalsmith state supports transport again after publication,
  // including at non-identity pitch/rate.
  seek: transportControls && !structuralChangePending,
  loopRegion: transportControls && !structuralChangePending,
  metronome: true,
  mixer: true,
  pitchTempo: true,
  training: true,
  previewClick: true
})

export class LegacyPlaybackBackend implements PlaybackBackend {
  readonly kind = 'legacy' as const
  readonly capabilities = LEGACY_CAPABILITIES

  constructor(private readonly engine: MultitrackEngine) {}

  get playing(): boolean {
    return this.engine.playing
  }
  get position(): number {
    return this.engine.position
  }
  get audioPosition(): number {
    return this.engine.audioPosition
  }
  get duration(): number {
    return this.engine.duration
  }
  get displayLatency(): number {
    return this.engine.displayLatency
  }
  /** Legacy swaps nothing: what it offers, it offers always. */
  get reconfiguring(): boolean {
    return false
  }
  /** Already applied: the app shell folds route latency and this trim
   *  together into the engine's own display latency. Taking it a second
   *  time here would double the correction. */
  setDisplayTrim(): void {}
  get countInStatus(): PlaybackCountInStatus | null {
    const status = this.engine.countInStatus
    return status === null ? null : { kind: 'beats', ...status }
  }
  get regionState(): { start: number; end: number; loop: boolean } | null {
    return this.engine.regionState
  }
  get duckedStems(): string[] {
    return this.engine.duckedStems
  }
  get beats(): BeatInfo | null {
    return this.engine.beats
  }
  get metronome(): MetronomeConfig {
    return this.engine.metronome
  }
  get pitchTempo(): { semitones: number; rate: number } {
    return this.engine.pitchTempo
  }
  get masterGain(): number {
    return this.engine.masterGain
  }
  get error(): null {
    return null
  }

  attach(project: LoadedProject): void {
    const list: EngineTrackInput[] = project.stems.map(({ id, buffer, custom }) => ({
      id,
      buffer,
      custom
    }))
    this.engine.load(list)
  }

  subscribe(listener: () => void): () => void {
    return this.engine.subscribe(listener)
  }

  getTrackStates(): TrackState[] {
    return this.engine.getTrackStates()
  }

  async play(): Promise<PlaybackActionOutcome> {
    await this.engine.play()
    return { kind: 'completed' }
  }

  async toggle(): Promise<PlaybackActionOutcome> {
    this.engine.toggle()
    return { kind: 'completed' }
  }

  pause(): void {
    this.engine.pause()
  }

  async stop(): Promise<void> {
    this.engine.pause()
  }

  seek(seconds: number): void {
    this.engine.seek(seconds)
  }

  seekBy(seconds: number): void {
    this.engine.seekBy(seconds)
  }

  async setRegion(
    region: { start: number; end: number } | null,
    loop: boolean
  ): Promise<void> {
    this.engine.setRegion(region, loop)
  }

  setBeats(info: BeatInfo | null): void {
    this.engine.setBeats(info)
  }

  setMetronome(config: MetronomeConfig): void {
    this.engine.setMetronome(config)
  }

  setMuted(id: string, muted: boolean): void {
    this.engine.setMuted(id, muted)
  }

  setSolo(id: string, solo: boolean): void {
    this.engine.setSolo(id, solo)
  }

  setVolume(id: string, volume: number): void {
    this.engine.setVolume(id, volume)
  }

  setMasterGain(gain: number): void {
    this.engine.setMasterGain(gain)
  }

  setPitchTempo(semitones: number, rate: number): void {
    this.engine.setPitchTempo(semitones, rate)
  }

  setTraining(spec: TrainingSpec | null): void {
    this.engine.setTraining(spec)
  }

  previewClick(accent = false): void {
    this.engine.previewClick(accent)
  }

  async unload(): Promise<void> {
    this.engine.unload()
  }
}

export class IosNativePlaybackBackend implements PlaybackBackend {
  readonly kind: NativePlaybackHandle['kind']
  capabilities: PlaybackCapabilities
  private readonly tracks: TrackState[]
  private attached = false
  private beatInfo: BeatInfo | null
  private metronomeConfig: MetronomeConfig
  private songMasterGain = 1
  private transposeSemitones: number
  private playbackRate: number
  private trainingSpec: TrainingSpec | null = null
  private desiredCueState: NativeCueState
  private desiredMasterGain = 1
  private desiredTrainingSpec: TrainingSpec | null = null
  private readonly desiredTracks: TrackState[]
  private cueIntentVersion = 0
  private cueReconcileRunning = false
  private masterRequest = 0
  private trainingRequest = 0
  private structuralChangesPending = 0
  private displayTrimSec = 0
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeHandle: () => void
  /** Serialize compound/native commands so seek→loop cannot be interleaved. */
  private transportTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly handle: NativePlaybackHandle,
    private readonly project: LoadedProject
  ) {
    this.kind = handle.kind
    this.transposeSemitones = Math.round(project.doc.settings?.transpose ?? 0)
    this.playbackRate = project.doc.settings?.tempo ?? 1
    this.capabilities = nativeTransportCapabilities(handle.transportControls, false)
    this.tracks = handle.lanes.map(lane => {
      const saved = project.doc.settings?.tracks?.[lane.id]
      return {
        id: lane.id,
        muted: saved?.muted === true,
        solo: saved?.solo === true,
        volume: Number.isFinite(saved?.volume) ? Math.max(0, Math.min(1, saved!.volume)) : 1
      }
    })
    this.beatInfo = sanitizeBeatInfo(project.doc.settings?.beat)
    this.metronomeConfig = project.doc.settings?.metronome
      ? sanitizeMetronome(project.doc.settings.metronome)
      : MET_DEFAULTS
    this.desiredCueState = {
      beat: this.beatInfo,
      metronome: this.metronomeConfig
    }
    this.desiredTracks = this.tracks.map(track => ({ ...track }))
    this.desiredMasterGain = this.songMasterGain
    this.unsubscribeHandle = handle.subscribe(() => this.emit())
  }

  private unsupported(operation: PlaybackOperation): never {
    throw new PlaybackUnsupportedError(this.kind, operation)
  }

  private state() {
    return this.handle.snapshot()
  }

  /** Playing is what the core's transport says RIGHT NOW when the clock is
   *  live — a song that ran out reads as stopped on the next render, not on
   *  the next poll — and the polled phase on a build without the clock. */
  get playing(): boolean {
    const clock = this.handle.clock()
    return clock.live ? clock.playing : this.state().phase === 'playing'
  }
  /**
   * A trim can only ever ADD lag, never remove more than there is.
   *
   * The singer can dial the trim negative, and legacy floors the TOTAL at
   * zero (route latency plus trim), so its highlight can at most track the
   * render clock. Subtracting a raw negative trim here would push the
   * highlight AHEAD of audio that has not been rendered yet — the same
   * setting giving two answers on the two backends, which is the thing this
   * work exists to stop.
   */
  private get effectiveTrimSec(): number {
    return Math.max(this.displayTrimSec, -this.state().displayLatencySec)
  }
  /**
   * What the singer is hearing RIGHT NOW, corrected twice — legacy's exact
   * shape: `startOffset + (currentTime − startedAt − lag) · rate`, with the
   * render head read synchronously from the core in place of currentTime.
   *
   * The presentation latency is the part the core can measure; the trim is
   * the part it cannot — the OS's own figure is short on Bluetooth and
   * CarPlay — so the true heard frame is earlier still by exactly the amount
   * the singer dialled in. Both are subtracted here, once, for both the
   * live clock and the polled fallback.
   */
  get position(): number {
    const clock = this.handle.clock()
    // Only while the song is actually coming out of the speaker. The
    // correction says where the EAR is inside sound already rendered; a
    // stopped transport is making none, and a count-in holds its position at
    // the landing. Legacy has always agreed by construction — `clockPosition`
    // returns the start offset untouched when it is not playing, and clamps
    // to it through a count-in — and subtracting anyway put a paused seek a
    // latency BEFORE its target: tapping a lyric line while stopped
    // highlighted the line before the one tapped (a phone, 2026-09-06; the
    // simulator's 10 ms route never crossed a line boundary, which is why
    // every driver passed).
    if (!clock.playing || clock.preRoll) return Math.max(0, clock.renderedSec)
    // Floored where the run began, as legacy floors at its start offset: for
    // the latency's worth of time it takes the ear to reach the first sample,
    // the corrected position is BELOW the spot the singer started from, and
    // the highlight would sit in the line before it — 34 ms on a wired route,
    // a fifth of a second on Bluetooth or with a trim dialled in.
    return Math.max(
      0,
      clock.floorSec ?? 0,
      clock.renderedSec - this.state().displayLatencySec - this.effectiveTrimSec
    )
  }
  /**
   * The RENDER clock, deliberately untrimmed.
   *
   * This is the base for relative seeks, loop marks and region arming, so a
   * trim folded in here is subtracted again on every use: one skip forward
   * and back would lose twice the trim, and it accumulates without bound.
   * Legacy keeps the same split for the same reason — its `audioPosition`
   * passes a lag of zero while `position` carries the full display lag.
   */
  get audioPosition(): number {
    return this.handle.clock().renderedSec
  }
  get duration(): number {
    return this.state().durationSec
  }
  get reconfiguring(): boolean {
    return this.structuralChangesPending > 0
  }
  /** What the UI reports as the shift it is applying — both halves of it,
   *  or the readout would contradict the correction it describes. */
  get displayLatency(): number {
    return this.state().displayLatencySec + this.effectiveTrimSec
  }
  setDisplayTrim(seconds: number): void {
    const next = Number.isFinite(seconds) ? Math.max(-2, Math.min(2, seconds)) : 0
    if (next === this.displayTrimSec) return
    this.displayTrimSec = next
    // The count-in dots are computed inside the handle, from the same
    // audible frame, so it needs the trim too or the two disagree.
    this.handle.setDisplayTrim(next)
    this.emit()
  }
  /** The dots read the clock too, so they light on the frame the lyric
   *  sweep is on rather than on the poll grid. */
  get countInStatus(): PlaybackCountInStatus | null {
    return this.handle.clock().countIn
  }
  get regionState(): { start: number; end: number; loop: boolean } | null {
    return this.state().regionState
  }
  get duckedStems(): string[] {
    const training = this.trainingSpec
    if (training === null) return []
    const position = this.audioPosition
    const inside = training.mode === 'period'
      ? training.periodSec > 0 && Math.floor(position / training.periodSec) % 2 === 1
      : training.windows.some(window => position >= window.s && position < window.e)
    return inside ? [...training.stems] : []
  }
  get beats(): BeatInfo | null {
    return this.beatInfo
  }
  get metronome(): MetronomeConfig {
    return this.metronomeConfig
  }
  get pitchTempo(): { semitones: number; rate: number } {
    return {
      semitones: this.transposeSemitones,
      rate: this.playbackRate
    }
  }
  get masterGain(): number {
    return this.songMasterGain
  }
  get error(): string | null {
    return this.state().error
  }

  attach(project: LoadedProject): void {
    if (project.nativePlayback !== this.handle)
      throw new Error('The native playback handle does not own this project.')
    this.attached = true
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getTrackStates(): TrackState[] {
    return this.tracks.map(track => ({ ...track }))
  }

  async play(): Promise<PlaybackActionOutcome> {
    return this.mapStart(await this.serialize(() => this.handle.start()))
  }

  async toggle(): Promise<PlaybackActionOutcome> {
    if (this.playing) {
      await this.serialize(() => this.handle.pause())
      return { kind: 'completed' }
    }
    // A terminal native failure stays on this backend. Resetting it to the
    // coordinator's stopped state permits a native-only retry; it never opens
    // a concurrent legacy output path.
    return this.serialize(async () => {
      if (this.state().phase === 'error')
        await this.handle.stop('reset native playback error')
      return this.mapStart(await this.handle.start())
    })
  }

  pause(): void {
    if (!this.capabilities.pause) return this.unsupported('pause')
    this.serialize(() => this.handle.pause()).catch(() => undefined)
  }

  stop(reason = 'user stopped'): Promise<void> {
    return this.serialize(() => this.handle.stop(reason))
  }

  seek(seconds: number): void {
    if (!this.capabilities.seek) return this.unsupported('seek')
    const target = Math.max(0, Math.min(this.duration, seconds))
    this.dispatchSeek(() => this.handle.seek(target))
  }

  seekBy(seconds: number): void {
    if (!this.capabilities.seek) return this.unsupported('seek')
    // Queued, never ahead of it: a relative seek reads the render head, and
    // only after all earlier transport commands have settled does that read
    // mean what the singer meant — seek(2); seekBy(1) ahead of the queue
    // observes the pre-seek position on a build whose clock carries no seek
    // overlay (no positionNow), and queues an absolute seek to 1 instead
    // of 3. A skip tap waiting a seam out costs nothing a scrub does.
    this.serialize(() => {
      const target = Math.max(0, Math.min(this.duration, this.audioPosition + seconds))
      return this.handle.seek(target)
    }).catch(() => undefined)
  }

  /** An absolute seek does not wait behind a seam. The cue rebuild sits in
   *  the transport queue, and a scrub issued while one was in flight used to
   *  sit behind it — behind the wait for the PREVIOUS seam to land, the
   *  prepare and the arm read — before the handle so much as recorded the
   *  target: 568 ms for the first seek after three metronome touches on the
   *  simulator, against 25–35 ms for the next three. A seam refuses no seek
   *  (the core carries one across the landing), so while the handle swaps in
   *  place the seek goes straight to it: the handle records the target and
   *  its clock reads it at once, and the command itself still takes its
   *  turn behind the coordinator's ownership lock if a rebuild holds it.
   *  Refused all the same — the seam turned into the six-call rebuild
   *  underneath — and it takes the place in the queue it always had, after
   *  the rebuild. Relative seeks stay queued (see seekBy). */
  private dispatchSeek(operation: () => Promise<void>): void {
    if (!this.handle.swapsInPlace()) {
      this.serialize(operation).catch(() => undefined)
      return
    }
    operation().catch(() => {
      this.serialize(operation).catch(() => undefined)
    })
  }

  setRegion(
    region: { start: number; end: number } | null,
    loop: boolean
  ): Promise<void> {
    if (!this.capabilities.loopRegion) return this.unsupported('loop-region')
    const startedAt = Date.now()
    if (region === null) {
      return this.serialize(() => this.handle.clearLoop()).then(
        () => logAction('A-B cleared', startedAt),
        error => {
          logActionFailed('A-B cleared', startedAt)
          throw error
        }
      )
    }
    if (!loop) return this.unsupported('loop-region')
    const what = `A-B ${fmtClock(region.start)}-${fmtClock(region.end)}`
    return this.serialize(async () => {
      // Match MultitrackEngine: an armed loop owns [A,B). Relocate an
      // out-of-range render head to A first, then enable the loop in the same
      // generation-bound command queue. Once setLoop resolves there is no
      // successful state in which the playhead remains outside the region.
      const at = this.audioPosition
      if (at < region.start || at >= region.end)
        await this.handle.seek(region.start)
      await this.handle.setLoop(region.start, region.end)
    }).then(
      () => logAction(what, startedAt),
      error => {
        logActionFailed(what, startedAt)
        throw error
      }
    )
  }

  setBeats(info: BeatInfo | null): void {
    const next = sanitizeBeatInfo(info)
    if (sameBeatInfo(this.desiredCueState.beat, next)) return
    this.desiredCueState = {
      beat: next,
      metronome: this.desiredCueState.metronome
    }
    this.cueIntentVersion += 1
    this.reconcileCueState()
  }

  setMetronome(config: MetronomeConfig): void {
    const next = sanitizeMetronome(config)
    if (sameMetronome(this.desiredCueState.metronome, next)) return
    this.desiredCueState = {
      beat: this.desiredCueState.beat,
      metronome: next
    }
    this.cueIntentVersion += 1
    this.reconcileCueState()
  }

  setMuted(id: string, muted: boolean): void {
    this.updateLane(id, { muted })
  }

  setSolo(id: string, solo: boolean): void {
    this.updateLane(id, { solo })
  }

  setVolume(id: string, volume: number): void {
    if (!Number.isFinite(volume)) return
    this.updateLane(id, { volume: Math.max(0, Math.min(1, volume)) })
  }

  setMasterGain(gain: number): void {
    if (!Number.isFinite(gain)) return
    const next = Math.max(0, Math.min(1, gain))
    if (next === this.desiredMasterGain) return
    const request = ++this.masterRequest
    this.desiredMasterGain = next
    this.serialize(() => this.handle.setMasterGain(next)).then(() => {
      this.songMasterGain = next
      this.emit()
    }).catch(() => {
      if (request === this.masterRequest) this.desiredMasterGain = this.songMasterGain
      this.emit()
    })
  }

  setPitchTempo(semitones: number, rate: number): void {
    if (!this.capabilities.pitchTempo) return this.unsupported('pitch-tempo')
    if (!Number.isFinite(semitones) || !Number.isFinite(rate)) return
    // From the TOUCH, not from the point the queue reaches it: a pitch change
    // behind a metronome rebuild waits seconds before its own work starts, and
    // that wait is the singer's wait.
    const startedAt = Date.now()
    const what = describePitchTempo(semitones, rate, this.transposeSemitones, this.playbackRate)
    this.structuralChangesPending += 1
    this.refreshCapabilities()
    this.emit()
    this.serialize(async () => {
      await this.handle.setPitchTempo(semitones, rate)
      this.transposeSemitones = semitones
      this.playbackRate = rate
    }).then(
      () => {
        logAction(what, startedAt)
        this.finishStructuralChange()
      },
      () => {
        logActionFailed(what, startedAt)
        this.finishStructuralChange()
      }
    )
  }

  setTraining(spec: TrainingSpec | null): void {
    const next: TrainingSpec | null = spec === null
      ? null
      : spec.mode === 'period'
        ? { mode: 'period', periodSec: spec.periodSec, stems: [...spec.stems] }
        : {
            mode: 'windows',
            windows: spec.windows.map(window => ({ ...window })),
            stems: [...spec.stems]
          }
    if (sameTrainingSpec(this.desiredTrainingSpec, next)) return
    const startedAt = Date.now()
    const what = describeTraining(next)
    const request = ++this.trainingRequest
    this.desiredTrainingSpec = next
    this.serialize(() => this.handle.setTraining(next)).then(() => {
      this.trainingSpec = cloneTrainingSpec(next)
      logAction(what, startedAt)
      this.emit()
    }).catch(() => {
      if (request === this.trainingRequest)
        this.desiredTrainingSpec = cloneTrainingSpec(this.trainingSpec)
      logActionFailed(what, startedAt)
      this.emit()
    })
  }

  previewClick(accent = false): void {
    if (!this.capabilities.previewClick) return this.unsupported('preview-click')
    this.serialize(() => this.handle.previewClick(accent)).catch(() => undefined)
  }

  async unload(reason = 'player closed'): Promise<void> {
    if (!this.attached) return
    this.attached = false
    await this.serialize(() => this.handle.unload(reason))
    this.unsubscribeHandle()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transportTail.then(operation)
    this.transportTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * Beat and metronome settings are one structural native cue graph. Keep a
   * single desired composite and reconcile it in version order: a failed
   * stale snapshot must never roll back one field underneath a newer intent.
   * A latest failure rolls the whole desired pair back to the last graph that
   * the native owner actually accepted, so later equality checks cannot hide
   * a UI/native divergence.
   */
  private reconcileCueState(): void {
    if (this.cueReconcileRunning) return
    this.cueReconcileRunning = true
    // The touch, before the reconcile loop: the loop coalesces several
    // toggles into one rebuild, and what the singer waited for is the time
    // from the tap they made to the graph that finally carried it.
    const startedAt = Date.now()
    const before = this.metronomeConfig
    // A cue rebuild is a full generation swap — measured at 4.2 s of silence
    // on a phone — and the core refuses a seek throughout it. Without this
    // the scrub rail stayed live and every drag the singer made during those
    // seconds was accepted by the UI and thrown away by the core.
    this.structuralChangesPending += 1
    this.refreshCapabilities()
    this.emit()
    this.serialize(async () => {
      for (;;) {
        const version = this.cueIntentVersion
        const requested: NativeCueState = {
          beat: this.desiredCueState.beat,
          metronome: this.desiredCueState.metronome
        }
        const accepted: NativeCueState = {
          beat: this.beatInfo,
          metronome: this.metronomeConfig
        }
        if (sameCueState(requested, accepted)) {
          if (version === this.cueIntentVersion) return
          continue
        }
        try {
          await rebuildNativePlaybackCues(
            this.handle,
            requested.beat,
            requested.metronome
          )
        } catch {
          if (version === this.cueIntentVersion) {
            this.desiredCueState = accepted
            this.emit()
            return
          }
          // A newer composite intent superseded this rejected snapshot. Keep
          // it intact and reconcile that whole pair on the next iteration.
          continue
        }
        this.beatInfo = requested.beat
        this.metronomeConfig = requested.metronome
        logAction(describeCueChange(before, requested.metronome), startedAt)
        this.emit()
        if (version === this.cueIntentVersion) return
      }
    }).finally(() => {
      this.cueReconcileRunning = false
      this.finishStructuralChange()
      const accepted: NativeCueState = {
        beat: this.beatInfo,
        metronome: this.metronomeConfig
      }
      // A listener may publish a new intent from the final acceptance/error
      // notification while this transaction is still marked running.
      if (!sameCueState(this.desiredCueState, accepted))
        this.reconcileCueState()
    })
  }

  private updateLane(
    id: string,
    patch: Partial<Pick<TrackState, 'muted' | 'solo' | 'volume'>>
  ): void {
    const track = this.tracks.find(candidate => candidate.id === id)
    const desired = this.desiredTracks.find(candidate => candidate.id === id)
    if (!track || !desired) return
    const muted = patch.muted ?? desired.muted
    const solo = patch.solo ?? desired.solo
    const volume = patch.volume ?? desired.volume
    if (
      muted === desired.muted &&
      solo === desired.solo &&
      volume === desired.volume
    ) return
    desired.muted = muted
    desired.solo = solo
    desired.volume = volume
    const requested = { muted, solo, volume }
    this.serialize(() =>
      this.handle.setLaneControl(id, volume, muted, solo)
    ).then(() => {
      track.muted = muted
      track.solo = solo
      track.volume = volume
      this.emit()
    }).catch(() => {
      if (
        desired.muted === requested.muted &&
        desired.solo === requested.solo &&
        desired.volume === requested.volume
      ) {
        desired.muted = track.muted
        desired.solo = track.solo
        desired.volume = track.volume
      }
      this.emit()
    })
  }

  private finishStructuralChange(): void {
    this.structuralChangesPending = Math.max(0, this.structuralChangesPending - 1)
    this.refreshCapabilities()
    this.emit()
  }

  private refreshCapabilities(): void {
    // A seam on the running stream refuses no seek; only the six-call
    // rebuild does, and only that takes the scrub rail away.
    this.capabilities = nativeTransportCapabilities(
      this.handle.transportControls,
      this.structuralChangesPending > 0 && !this.handle.swapsInPlace()
    )
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  private mapStart(outcome: NativePlaybackStartOutcome): PlaybackActionOutcome {
    if (outcome.kind === 'started') return { kind: 'completed' }
    if (outcome.kind === 'fallback') return outcome
    throw new Error(outcome.error)
  }
}

function sameBeatInfo(left: BeatInfo | null, right: BeatInfo | null): boolean {
  if (left === null || right === null) return left === right
  return (
    left.beatsPerBar === right.beatsPerBar &&
    left.downbeat === right.downbeat &&
    left.beats.length === right.beats.length &&
    left.beats.every((beat, index) => beat === right.beats[index]) &&
    (left.downbeats?.length ?? 0) === (right.downbeats?.length ?? 0) &&
    (left.downbeats ?? []).every(
      (downbeat, index) => downbeat === right.downbeats?.[index]
    )
  )
}

function sameMetronome(left: MetronomeConfig, right: MetronomeConfig): boolean {
  return (
    left.click === right.click &&
    left.countInBars === right.countInBars &&
    left.volume === right.volume &&
    left.accent === right.accent
  )
}

function sameCueState(left: NativeCueState, right: NativeCueState): boolean {
  return (
    sameBeatInfo(left.beat, right.beat) &&
    sameMetronome(left.metronome, right.metronome)
  )
}

function cloneTrainingSpec(spec: TrainingSpec | null): TrainingSpec | null {
  if (spec === null) return null
  return spec.mode === 'period'
    ? { mode: 'period', periodSec: spec.periodSec, stems: [...spec.stems] }
    : {
        mode: 'windows',
        windows: spec.windows.map(window => ({ ...window })),
        stems: [...spec.stems]
      }
}

function sameTrainingSpec(left: TrainingSpec | null, right: TrainingSpec | null): boolean {
  if (left === null || right === null) return left === right
  if (left.mode !== right.mode) return false
  if (
    left.stems.length !== right.stems.length ||
    left.stems.some((stem, index) => stem !== right.stems[index])
  ) return false
  if (left.mode === 'period' && right.mode === 'period')
    return left.periodSec === right.periodSec
  if (left.mode !== 'windows' || right.mode !== 'windows') return false
  return (
    left.windows.length === right.windows.length &&
    left.windows.every(
      (window, index) =>
        window.s === right.windows[index]?.s && window.e === right.windows[index]?.e
    )
  )
}

export function createPlaybackBackend(
  engine: MultitrackEngine,
  project: LoadedProject
): PlaybackBackend {
  return project.nativePlayback
    ? new IosNativePlaybackBackend(project.nativePlayback, project)
    : new LegacyPlaybackBackend(engine)
}
