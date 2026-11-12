/*
 * Voice strip controller (ADR 0014, docs/specs/voice-strip/spec.md §4).
 *
 * One object owns the strip's state machine so the strip, the transport
 * Record button and the R shortcut all read and drive the same thing. It has
 * no React and no DOM: the engine, the preload bridge and the clock come in
 * as ports, which is also what the tests swap for fakes. `useVoiceController`
 * (components/VoiceStrip.tsx) binds it to React.
 *
 * M1 scope: record a take over the song, listen back, keep or discard. The
 * `monitoring-*` states exist in the type and in `primaryState`, but nothing
 * sets them yet: monitoring is inert until M2.
 */
import type {
  VoiceInputLevel,
  VoicePlayTakeRequest,
  VoiceRecordSettingsChange,
  VoiceRecordStartRequest,
  VoiceRecordStartResult,
  VoiceRecordStopResult,
  VoiceTakeSummary
} from '../../../shared/voice-take'
import { stableVoiceSongId } from './voice-song-id'

export { stableVoiceSongId }

export const VOICE_STATES = [
  'idle',
  'input-missing',
  'permission-needed',
  'armed',
  'recording',
  'take-review',
  'playing-take',
  'monitoring-on',
  'monitoring-unavailable-latency',
  'monitoring-unavailable-route',
  'error-recoverable'
] as const
export type VoiceState = (typeof VOICE_STATES)[number]

export type VoiceListenMode = 'take' | 'with-song'
export type VoiceErrorKind = 'device-lost' | 'busy' | 'error' | 'no-bridge'

/** What the strip needs of the preload bridge (`window.singz.voiceTakes`, WP4). */
export interface VoiceTakeApi {
  recordStart(req: VoiceRecordStartRequest): Promise<VoiceRecordStartResult>
  recordStop(): Promise<VoiceRecordStopResult>
  recordSettings(change: VoiceRecordSettingsChange): Promise<unknown>
  list(songId: string): Promise<VoiceTakeSummary[]>
  play(req: VoicePlayTakeRequest): Promise<{ ok: boolean } | void>
  stopPlay(): Promise<unknown>
  remove(songId: string, takeId: string): Promise<unknown>
  level(): Promise<VoiceInputLevel | null>
}

/** The slice of MultitrackEngine the strip drives. */
export interface VoiceEnginePort {
  readonly playing: boolean
  readonly position: number
  readonly duration?: number
  readonly tempo: number
  readonly transpose: number
  play(): Promise<void>
  pause(): void
  seek(t: number): void
  setTempo(rate: number): Promise<void>
  setTranspose(st: number): Promise<void>
  /** Stem mute control, used to solo the take against the song. */
  getTrackStates?(): { id: string; muted: boolean }[]
  setMuted?(id: string, muted: boolean): void
}

export interface VoiceInputOption {
  id: string
  label: string
}

export interface VoiceControllerDeps {
  api: VoiceTakeApi
  engine: VoiceEnginePort
  /** Ask the OS for microphone access; true when granted. */
  askMicAccess: () => Promise<boolean>
  /** Capture devices; `labelsHidden` means the OS has not granted access. */
  listInputs: () => Promise<{ inputs: VoiceInputOption[]; labelsHidden: boolean }>
  now?: () => number
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
}

export interface VoiceTake {
  takeId: string
  n: number
  startSec: number
  durationSec: number
  /** Ratio, 1 = 100%. Updated while recording when the singer changes it. */
  tempo: number
  transpose: number
  changed: boolean
  kept: boolean
  partial: boolean
  recovered: boolean
}

export interface VoiceModel {
  songId: string | null
  armed: boolean
  starting: boolean
  recording: boolean
  listen: VoiceListenMode | null
  perm: 'unknown' | 'granted' | 'denied'
  inputMissing: boolean
  /** Monitoring is inert in M1: always 'ok' and off. */
  monitor: { avail: 'ok' | 'latency' | 'route'; on: boolean }
  error: VoiceErrorKind | null
  /** Why the last take ended without the singer pressing stop. */
  stoppedBy: 'seek' | 'auto' | null
  take: VoiceTake | null
  inputs: VoiceInputOption[]
  input: string | null
  clipped: boolean
  /** Take playback mute / solo and level: view state, not yet in the IPC contract. */
  takeMuted: boolean
  solo: boolean
  level: number
  elapsedSec: number
  /** Bumped for each new announcement so the live region re-reads equal text. */
  announce: { seq: number; key: AnnounceKey | null }
}

export type AnnounceKey =
  | 'announceRecording'
  | 'announceReview'
  | 'announceKept'
  | 'announceDiscarded'
  | 'announceArmed'
  | 'announceDisarmed'
  | 'announceGranted'
  | 'announceRetried'
  | 'announceClipReset'

export const INITIAL_VOICE_MODEL: VoiceModel = {
  songId: null,
  armed: false,
  starting: false,
  recording: false,
  listen: null,
  perm: 'unknown',
  inputMissing: false,
  monitor: { avail: 'ok', on: false },
  error: null,
  stoppedBy: null,
  take: null,
  inputs: [],
  input: null,
  clipped: false,
  takeMuted: false,
  solo: false,
  /** Take level: 100 is the native maximum (-1 dB), the sensible default. */
  level: 100,
  elapsedSec: 0,
  announce: { seq: 0, key: null }
}

/** Spec §4.1 precedence: error > recording > playing > review > permission >
 *  input-missing > monitoring-* > armed > idle. A kept take is resolved, so it
 *  no longer holds the strip in take-review. */
export function primaryState(m: VoiceModel): VoiceState {
  if (m.error) return 'error-recoverable'
  if (m.recording) return 'recording'
  if (m.listen) return 'playing-take'
  if (m.take && !m.take.kept) return 'take-review'
  if (m.perm === 'denied') return 'permission-needed'
  if (m.inputMissing) return 'input-missing'
  if (m.monitor.avail === 'latency') return 'monitoring-unavailable-latency'
  if (m.monitor.avail === 'route') return 'monitoring-unavailable-route'
  if (m.monitor.on) return 'monitoring-on'
  if (m.armed) return 'armed'
  return 'idle'
}

export type RecordBlock = 'starting' | 'perm' | 'missing' | 'error' | 'take' | 'listening' | 'no-song' | null

/** Why Record is unavailable right now, or null when it is available. */
export function recordBlock(m: VoiceModel): RecordBlock {
  if (m.songId === null) return 'no-song'
  if (m.starting) return 'starting'
  if (m.error) return 'error'
  if (m.perm === 'denied') return 'perm'
  if (m.inputMissing) return 'missing'
  if (m.listen) return 'listening'
  if (m.take && !m.take.kept) return 'take'
  return null
}

/** Pressing Record while recording stops it, so the button stays live then. */
export const canPressRecord = (m: VoiceModel): boolean => m.recording || recordBlock(m) === null

export const CLIP_DB = -0.1
const SEEK_JUMP_SEC = 0.75
const STORAGE_KEY = 'singz.voice.input'
const SONG_START_TIMEOUT_MS = 3000
const BRIDGE_MISSING = 'voice bridge unavailable'

/**
 * Stems this feature muted for a soloed Listen with song, per engine. It lives
 * outside any controller so that a controller torn down mid-listen (the host
 * unmounts, the song changes) cannot strand the stems muted: the next
 * controller for the same engine restores them on startup.
 */
const MUTED_BY_SOLO = new WeakMap<object, string[]>()

export class VoiceController {
  private model: VoiceModel = INITIAL_VOICE_MODEL
  private readonly listeners = new Set<() => void>()
  private readonly levelListeners = new Set<() => void>()
  private levelDb = -120
  private peakDb = -120
  private timer: ReturnType<typeof setInterval> | null = null
  private levelTimer: ReturnType<typeof setInterval> | null = null
  private recordingId: string | null = null
  private startedAtMs = 0
  private lastPos = 0
  private lastTickMs = 0
  private listenStartedMs = 0
  private listenSawPlaying = false
  private takeCount = 0
  private songEpoch = 0
  private disposed = false
  private startToken = 0
  private soloedStems: string[] | null = null
  private listenToken = 0
  private pendingListen: VoiceListenMode | null = null
  private readonly now: () => number

  constructor(private readonly deps: VoiceControllerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.restoreStems(MUTED_BY_SOLO.get(deps.engine) ?? null)
    const saved = this.readStored()
    if (saved) this.model = { ...this.model, input: saved }
  }

  // ── external store ──
  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  readonly getSnapshot = (): VoiceModel => this.model
  readonly subscribeLevel = (fn: () => void): (() => void) => {
    this.levelListeners.add(fn)
    return () => this.levelListeners.delete(fn)
  }
  /** Live input level for the meter; -120 dBFS when nothing is live. */
  getLevel(): { db: number; peak: number } {
    return { db: this.levelDb, peak: this.peakDb }
  }
  get state(): VoiceState {
    return primaryState(this.model)
  }

  private set(patch: Partial<VoiceModel>): void {
    this.model = { ...this.model, ...patch }
    this.syncTimers()
    for (const fn of [...this.listeners]) fn()
  }
  private say(key: AnnounceKey): Partial<VoiceModel> {
    return { announce: { seq: this.model.announce.seq + 1, key } }
  }

  // ── lifecycle ──
  /** Follow the song on screen (null = none): metadata, takes, input devices. Returns the cleanup. */
  bindSong(src: { path: string; projectDir: string | null; title: string; artist: string } | null): () => void {
    this.songMeta = { title: src?.title ?? '', artist: src?.artist ?? '' }
    const id = src ? stableVoiceSongId(src) : null
    void this.setSong(id)
    if (id === null) return () => this.dispose()
    void this.refreshInputs()
    const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    const onChange = (): void => void this.refreshInputs()
    md?.addEventListener?.('devicechange', onChange)
    return () => {
      md?.removeEventListener?.('devicechange', onChange)
      this.dispose()
    }
  }

  dispose(): void {
    this.clearTimers()
    void this.abortActivity()
  }

  /** A song was opened (id) or closed (null): live capture and playback end,
   *  stored takes stay. The newest stored take of the song is offered as kept. */
  async setSong(songId: string | null): Promise<void> {
    if (songId === this.model.songId) return
    const epoch = ++this.songEpoch
    await this.abortActivity()
    this.set({
      songId,
      armed: false,
      starting: false,
      error: null,
      stoppedBy: null,
      take: null,
      elapsedSec: 0,
      listen: null,
      recording: false
    })
    if (songId === null) return
    try {
      const takes = await this.deps.api.list(songId)
      if (epoch !== this.songEpoch || this.disposed || this.model.take) return
      const newest = [...takes]
        .filter((tk) => tk.status !== 'partial-error' || tk.durationSec > 0)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
      if (newest) this.set({ take: this.fromSummary(newest, true) })
    } catch {
      // Listing is a convenience; the strip works without it.
    }
  }

  private async abortActivity(): Promise<void> {
    // An in-flight start undoes itself when it resolves (see startRecording).
    this.startToken++
    // A listen ends synchronously here, before any await: stems restored, song
    // paused, listen state cleared (stopListening does all three).
    if (this.pendingListen) {
      // A listen still starting: cancel it and undo what it did so far.
      const mode = this.pendingListen
      this.listenToken++
      this.pendingListen = null
      this.restoreStems(this.soloedStems)
      this.soloedStems = null
      if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
      await this.deps.api.stopPlay().catch(() => undefined)
    }
    if (this.model.listen) await this.stopListening()
    if (this.model.recording && this.recordingId) {
      this.recordingId = null
      await this.deps.api.recordStop().catch(() => undefined)
    }
  }

  /** Re-read capture devices; also the "Check again" action. */
  async refreshInputs(): Promise<void> {
    try {
      const { inputs, labelsHidden } = await this.deps.listInputs()
      if (this.disposed) return
      const keep = inputs.some((i) => i.id === this.model.input)
      this.set({
        inputs,
        input: keep ? this.model.input : (inputs[0]?.id ?? null),
        inputMissing: inputs.length === 0 && !labelsHidden,
        perm: labelsHidden && this.model.perm === 'unknown' ? 'unknown' : this.model.perm
      })
    } catch {
      this.set({ inputs: [], inputMissing: true })
    }
  }

  async allowMic(): Promise<void> {
    const ok = await this.deps.askMicAccess().catch(() => false)
    this.set({ perm: ok ? 'granted' : 'denied', ...(ok ? this.say('announceGranted') : {}) })
    if (ok) await this.refreshInputs()
  }

  selectInput(id: string): void {
    this.set({ input: id })
    try {
      this.deps.storage?.setItem(STORAGE_KEY, id)
    } catch {
      /* private mode */
    }
  }

  // ── strip controls ──
  setLevel(level: number): void {
    this.set({ level: Math.max(0, Math.min(100, Math.round(level))) })
  }
  toggleTakeMute(): void {
    this.set({ takeMuted: !this.model.takeMuted })
  }
  toggleSolo(): void {
    this.set({ solo: !this.model.solo })
  }
  resetClip(): void {
    this.peakDb = this.levelDb
    this.set({ clipped: false, ...this.say('announceClipReset') })
    this.emitLevel()
  }

  async arm(): Promise<void> {
    const m = this.model
    if (m.armed) {
      this.set({ armed: false, ...this.say('announceDisarmed') })
      return
    }
    if (recordBlock(m) !== null) return
    if (m.perm !== 'granted') {
      const ok = await this.deps.askMicAccess().catch(() => false)
      if (!ok) {
        this.set({ perm: 'denied' })
        return
      }
      this.set({ perm: 'granted' })
      await this.refreshInputs()
      if (recordBlock(this.model) !== null) return
    }
    this.set({ armed: true, clipped: false, ...this.say('announceArmed') })
  }

  /** The Record button, the R key and the strip all end up here. */
  async toggleRecord(): Promise<void> {
    if (this.model.recording) return this.stopRecording()
    return this.startRecording()
  }

  async startRecording(): Promise<void> {
    const block = recordBlock(this.model)
    if (block !== null) return
    const { engine, api } = this.deps
    this.set({ starting: true, clipped: false })
    if (this.model.perm !== 'granted') {
      const ok = await this.deps.askMicAccess().catch(() => false)
      if (!ok) {
        this.set({ starting: false, perm: 'denied' })
        return
      }
      this.set({ perm: 'granted' })
      await this.refreshInputs()
      if (this.model.inputMissing) {
        this.set({ starting: false })
        return
      }
    }
    const input = this.model.inputs.find((i) => i.id === this.model.input)
    const epoch = this.songEpoch
    const token = ++this.startToken
    const stale = (): boolean => epoch !== this.songEpoch || token !== this.startToken || this.disposed
    // Main places the take from the capture's first sample, so the song must
    // already be playing when capture starts: play first, never record paused.
    let startedSong = false
    if (!engine.playing) {
      try {
        await engine.play()
        startedSong = true
        const deadline = this.now() + SONG_START_TIMEOUT_MS
        while (!engine.playing && this.now() < deadline && !stale()) {
          await new Promise<void>((r) => setTimeout(r, 25))
        }
      } catch {
        // falls through to the not-playing check
      }
      if (stale()) return
      if (!engine.playing) {
        this.failStart('error')
        return
      }
    }
    const songIdAtStart = this.model.songId ?? ''
    let res: VoiceRecordStartResult
    try {
      res = await api.recordStart({
        songId: songIdAtStart,
        songTitle: this.songMeta.title,
        songArtist: this.songMeta.artist,
        input: { deviceName: input?.label ?? '', channelIndex: 0 },
        tempo: engine.tempo,
        transposeSemitones: engine.transpose
      })
    } catch (err) {
      if (stale()) return
      if (startedSong && engine.playing) engine.pause()
      if (err instanceof Error && err.message === BRIDGE_MISSING) {
        this.set({ starting: false, error: 'no-bridge' })
        return
      }
      res = { ok: false, reason: 'error', message: '' }
    }
    if (stale()) {
      // The song changed (or the start was aborted) while main was opening the
      // mic: undo the start so main is not left recording.
      if (res.ok) await this.undoStart(songIdAtStart, res.takeId)
      return
    }
    if (!res.ok) {
      if (startedSong && engine.playing) engine.pause()
      this.failStart(res.reason)
      return
    }
    const startPos = engine.position
    this.recordingId = res.takeId
    this.startedAtMs = this.now()
    this.lastTickMs = this.startedAtMs
    this.lastPos = engine.position
    this.takeCount += 1
    this.set({
      starting: false,
      recording: true,
      armed: false,
      stoppedBy: null,
      elapsedSec: 0,
      take: {
        takeId: res.takeId,
        n: this.takeCount,
        startSec: startPos,
        durationSec: 0,
        tempo: engine.tempo,
        transpose: engine.transpose,
        changed: false,
        kept: false,
        partial: false,
        recovered: false
      },
      ...this.say('announceRecording')
    })
  }

  private async undoStart(songId: string, takeId: string): Promise<void> {
    await this.deps.api.recordStop().catch(() => undefined)
    await this.deps.api.remove(songId, takeId).catch(() => undefined)
  }

  private failStart(reason: 'permission' | 'no-input' | 'busy' | 'error'): void {
    if (reason === 'permission') this.set({ starting: false, perm: 'denied' })
    else if (reason === 'no-input') this.set({ starting: false, inputMissing: true })
    else this.set({ starting: false, error: reason === 'busy' ? 'busy' : 'error' })
  }

  async stopRecording(reason: 'user' | 'seek' | 'auto' = 'user'): Promise<void> {
    const id = this.recordingId
    if (!this.model.recording || !id) return
    this.recordingId = null
    const cur = this.model.take
    const elapsed = (this.now() - this.startedAtMs) / 1000
    // Stop the song first for an explicit stop (the take is then reviewed
    // against a still song); a pause or seek already moved it.
    if (reason === 'user' && this.deps.engine.playing) this.deps.engine.pause()
    this.set({ recording: false, elapsedSec: elapsed })
    let res: VoiceRecordStopResult
    try {
      res = await this.deps.api.recordStop()
    } catch {
      res = { ok: false, reason: 'error' }
    }
    if (this.disposed) return
    if (res.ok && res.take) {
      this.set({
        take: { ...this.fromSummary(res.take, false, cur?.n ?? this.takeCount), changed: res.take.settingsChanged || !!cur?.changed },
        stoppedBy: reason === 'user' ? null : reason,
        ...this.say('announceReview')
      })
      return
    }
    const salvaged = res.take
    this.set({
      error: res.reason === 'device-lost' ? 'device-lost' : 'error',
      take: salvaged
        ? { ...this.fromSummary(salvaged, false, cur?.n ?? this.takeCount), partial: true }
        : cur && elapsed > 0 && res.reason === 'device-lost'
          ? { ...cur, durationSec: elapsed, partial: true }
          : null
    })
  }

  keep(): void {
    const tk = this.model.take
    if (!tk || tk.kept || this.model.recording) return
    this.set({ take: { ...tk, kept: true }, ...this.say('announceKept') })
  }

  async discard(): Promise<void> {
    const tk = this.model.take
    if (!tk || this.model.recording) return
    if (this.pendingListen) {
      // A listen still starting: cancel it and undo what it did so far.
      const mode = this.pendingListen
      this.listenToken++
      this.pendingListen = null
      this.restoreStems(this.soloedStems)
      this.soloedStems = null
      if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
      await this.deps.api.stopPlay().catch(() => undefined)
    }
    if (this.model.listen) await this.stopListening()
    this.set({ take: null, error: null, ...this.say('announceDiscarded') })
    await this.deps.api.remove(this.model.songId ?? '', tk.takeId).catch(() => undefined)
  }

  /** Clears the error so Record is available again; the salvaged take stays. */
  retry(): void {
    this.set({ error: null, ...this.say('announceRetried') })
    void this.refreshInputs()
  }

  async listen(mode: VoiceListenMode): Promise<void> {
    const tk = this.model.take
    const { engine, api } = this.deps
    if (!tk || this.model.recording || this.model.listen || this.pendingListen) return
    // From here until the listen settles, abortActivity can cancel it: every
    // continuation below checks the token and does nothing once it is stale.
    const token = ++this.listenToken
    this.pendingListen = mode
    const stale = (): boolean => token !== this.listenToken
    let startedSong = false
    try {
      if (mode === 'take') {
        if (engine.playing) engine.pause()
      } else {
        await engine.setTempo(tk.tempo)
        await engine.setTranspose(tk.transpose)
        if (stale()) return
        // Play first, then seek: a seek on a paused, never-played song asks the
        // native engine to prepare a route before Play (see report, D1), and
        // that can throw. Cost: the song is audible from its current position
        // for an instant before the seek lands.
        if (!engine.playing) {
          await engine.play()
          startedSong = true
        }
        if (stale()) {
          if (startedSong && engine.playing) engine.pause()
          return
        }
        engine.seek(tk.startSec)
      }
    } catch {
      if (stale()) return
      // Never hide a failure: show it, and leave the song as we found it.
      if (startedSong && engine.playing) engine.pause()
      this.pendingListen = null
      this.set({ error: 'error' })
      return
    }
    // Recorded BEFORE the await so a teardown during it can restore the stems.
    this.soloedStems = mode === 'with-song' && this.model.solo ? this.muteStems() : null
    let ok = true
    try {
      const res = await api.play({ takeId: tk.takeId, mode, gain: takeGain(this.model.level, this.model.takeMuted) })
      ok = !res || res.ok !== false
    } catch {
      ok = false
    }
    // Torn down meanwhile: abortActivity already stopped native play and
    // restored everything; setting listen or a timer now would resurrect it.
    if (stale()) return
    this.pendingListen = null
    if (!ok) {
      this.restoreStems(this.soloedStems)
      this.soloedStems = null
      if (mode === 'with-song') engine.pause()
      this.set({ error: 'error' })
      return
    }
    this.listenStartedMs = this.now()
    this.listenSawPlaying = engine.playing
    this.set({ listen: mode })
  }

  async stopListening(): Promise<void> {
    if (!this.model.listen) return
    const mode = this.model.listen
    this.set({ listen: null })
    this.restoreStems(this.soloedStems)
    this.soloedStems = null
    if (mode === 'with-song' && this.deps.engine.playing) this.deps.engine.pause()
    await this.deps.api.stopPlay().catch(() => undefined)
  }

  /** Mute every stem that is not already muted; returns what to restore. */
  private muteStems(): string[] | null {
    const { engine } = this.deps
    if (!engine.getTrackStates || !engine.setMuted) return null
    const ids = engine.getTrackStates().filter((tr) => !tr.muted).map((tr) => tr.id)
    for (const id of ids) engine.setMuted(id, true)
    MUTED_BY_SOLO.set(engine, ids)
    return ids
  }
  private restoreStems(ids: string[] | null): void {
    if (!ids) return
    for (const id of ids) this.deps.engine.setMuted?.(id, false)
    MUTED_BY_SOLO.delete(this.deps.engine)
  }

  // ── time-driven checks (setInterval while recording or listening) ──
  tick(): void {
    const m = this.model
    const nowMs = this.now()
    const { engine } = this.deps
    if (m.recording && this.recordingId) {
      const dt = (nowMs - this.lastTickMs) / 1000
      const expected = this.lastPos + dt * engine.tempo
      const pos = engine.position
      const jumped = Math.abs(pos - expected) > SEEK_JUMP_SEC
      this.lastTickMs = nowMs
      this.lastPos = pos
      // M1: a seek or a pause ends the take (spec OQ-2 simplification).
      if (jumped || !engine.playing) {
        void this.stopRecording('seek')
        return
      }
      const cur = m.take
      let take = cur
      if (cur && (Math.abs(cur.tempo - engine.tempo) > 1e-4 || cur.transpose !== engine.transpose)) {
        take = { ...cur, tempo: engine.tempo, transpose: engine.transpose, changed: true }
        void Promise.resolve(
          this.deps.api.recordSettings({
            takeId: cur.takeId,
            tempo: engine.tempo,
            transposeSemitones: engine.transpose
          })
        ).catch(() => undefined)
      }
      this.set({ elapsedSec: (nowMs - this.startedAtMs) / 1000, take })
      return
    }
    if (m.listen && m.take) {
      const heard = (nowMs - this.listenStartedMs) / 1000
      if (engine.playing) this.listenSawPlaying = true
      const songStopped = m.listen === 'with-song' && this.listenSawPlaying && !engine.playing
      // With the song, the take is anchored to the song timeline (native
      // re-anchors it on a seek), so it ends where the SONG passes its end, not
      // after a wall-clock length. The span is in song time: the take's seconds
      // times the tempo it was recorded at, which Listen with song restores.
      const songPastEnd =
        m.listen === 'with-song' && engine.position >= m.take.startSec + m.take.durationSec * m.take.tempo
      const aloneDone = m.listen === 'take' && heard >= m.take.durationSec
      if (aloneDone || songPastEnd || songStopped) void this.stopListening()
    }
  }

  async pollLevel(): Promise<void> {
    const m = this.model
    if (!(m.armed || m.recording)) return
    let lv: VoiceInputLevel | null = null
    const issuedMs = this.now()
    try {
      lv = await this.deps.api.level()
    } catch {
      lv = null
    }
    if (this.disposed) return
    this.setLevelDb(lv ? lv.peakDb : null)
    // Main ended the take on its own (device lost, song end, storage): run the
    // normal stop path; main's recordStop is idempotent and returns the take.
    // A reading issued before this take began says nothing about it.
    if (lv?.takeActive === false && this.model.recording && this.recordingId && issuedMs >= this.startedAtMs) {
      void this.stopRecording('auto')
    }
  }

  /** Feed a peak reading (dBFS) or null for "no signal". Latches the clip LED. */
  setLevelDb(db: number | null): void {
    if (db === null) {
      this.levelDb = -120
      this.peakDb = -120
    } else {
      this.levelDb = Math.max(-120, Math.min(0, db))
      this.peakDb = Math.max(this.levelDb, this.peakDb - 0.5)
    }
    if (db !== null && db >= CLIP_DB && !this.model.clipped) this.set({ clipped: true })
    this.emitLevel()
  }
  private emitLevel(): void {
    for (const fn of [...this.levelListeners]) fn()
  }

  // ── internals ──
  /** Song metadata for the sidecar, set by the host (App). */
  songMeta: { title: string; artist: string } = { title: '', artist: '' }

  private fromSummary(s: VoiceTakeSummary, kept: boolean, n = ++this.takeCount): VoiceTake {
    return {
      takeId: s.takeId,
      n,
      startSec: s.startPositionSec,
      durationSec: s.durationSec,
      tempo: s.tempo,
      transpose: s.transposeSemitones,
      changed: s.settingsChanged,
      kept,
      partial: s.status === 'partial-device-lost' || s.status === 'partial-error',
      recovered: s.status === 'recovered'
    }
  }

  private readStored(): string | null {
    try {
      return this.deps.storage?.getItem(STORAGE_KEY) ?? null
    } catch {
      return null
    }
  }

  private syncTimers(): void {
    const m = this.model
    const wantTick = m.recording || m.listen !== null
    if (wantTick && !this.timer) this.timer = setInterval(() => this.tick(), 100)
    else if (!wantTick && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const wantLevel = (m.armed || m.recording) && !this.disposed
    if (wantLevel && !this.levelTimer) {
      this.levelTimer = setInterval(() => void this.pollLevel(), 50)
    } else if (!wantLevel && this.levelTimer) {
      clearInterval(this.levelTimer)
      this.levelTimer = null
      this.levelDb = -120
      this.peakDb = -120
      this.emitLevel()
    }
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.timer = null
    this.levelTimer = null
  }
}

/** Native clamps take gain here (about -1 dB of headroom); above it nothing changes. */
export const TAKE_GAIN_MAX = 0.891
/**
 * The Level fader as take gain: 100 is the native maximum (-1 dB), falling
 * 60 dB over the scale to silence at 0. There is no boost above unity to offer:
 * the native side would clamp it. Level, M and S changes while a take plays
 * apply to the NEXT Listen (native setGain ignores take voices), so they are
 * read when a play request is built, never pushed live.
 */
export function takeGainDb(level: number): number {
  if (level <= 0) return -Infinity
  return 20 * Math.log10(TAKE_GAIN_MAX) - 60 * (1 - Math.min(100, level) / 100)
}
/** Linear gain sent with a play request; the M chip forces silence. */
export function takeGain(level: number, muted: boolean): number {
  if (muted || level <= 0) return 0
  return Math.min(TAKE_GAIN_MAX, 10 ** (takeGainDb(level) / 20))
}

/** dBFS (-60..0) to a 0..1 meter fraction. */
export const meterFraction = (db: number): number => Math.max(0, Math.min(1, (db + 60) / 60))

/** Lazy adapter over the preload bridge. Every call rejects when the bridge is
 *  absent, which the controller reports as a recoverable error. */
export function createBridgeVoiceApi(
  bridge: () => Partial<VoiceTakeApi> | undefined = () =>
    (globalThis as { singz?: { voiceTakes?: Partial<VoiceTakeApi> } }).singz?.voiceTakes
): VoiceTakeApi {
  const call =
    <K extends keyof VoiceTakeApi>(name: K) =>
    (...args: Parameters<VoiceTakeApi[K]>): ReturnType<VoiceTakeApi[K]> => {
      const fn = bridge()?.[name] as ((...a: unknown[]) => unknown) | undefined
      if (!fn) return Promise.reject(new Error(BRIDGE_MISSING)) as ReturnType<VoiceTakeApi[K]>
      return fn(...args) as ReturnType<VoiceTakeApi[K]>
    }
  return {
    recordStart: call('recordStart'),
    recordStop: call('recordStop'),
    recordSettings: call('recordSettings'),
    list: call('list'),
    play: call('play'),
    stopPlay: call('stopPlay'),
    remove: call('remove'),
    level: call('level')
  }
}

