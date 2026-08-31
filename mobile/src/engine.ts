import {
  AudioContext,
  decodeAudioData,
  type AudioBuffer,
  type AudioBufferSourceNode,
  type GainNode,
  type OscillatorNode,
  type WaveShaperNode
} from 'react-native-audio-api'
import { accentIndex, barLengthAt, beatIndexAtOrAfter, beatTime } from './beat'
import { describeOutput } from './latency'
import { log } from './log'
// fmtTime here is the song-position one (M:SS); log.ts exports a same-named
// wall-clock formatter, which is not what a play/pause line wants.
import { fmtTime, MET_DEFAULTS, type BeatInfo, type MetronomeConfig } from './model'
import {
  DEFAULT_TRAINING_REFERENCE_VOLUME,
  clampTrainingReferenceVolume,
  planTrainingCues,
  trainingOrganOscillators,
  type VocalTrainingCue
} from './training/cues'

/**
 * Port of the desktop MultitrackEngine (src/renderer/src/audio/engine.ts) onto
 * react-native-audio-api's native Web Audio implementation. Pitch/tempo
 * (Signalsmith Stretch) is not ported yet — playback runs at the original
 * rate; everything else (sample-locked stems, click-free gains, region loop,
 * training duck layer) is the same logic.
 */

export interface EngineTrackInput {
  id: string
  buffer: AudioBuffer
  /** The singer's own audio rather than part of the song. Length-wise these
   *  are the wild card — see `songDuration`. */
  custom?: boolean
}

interface EngineTrack {
  id: string
  buffer: AudioBuffer
  custom: boolean
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

function trainingLimiterCurve(size = 2_049, drive = 1.55): Float32Array {
  const curve = new Float32Array(size)
  const normalization = Math.tanh(drive)
  for (let index = 0; index < size; index++) {
    const input = (index * 2) / (size - 1) - 1
    curve[index] = Math.tanh(input * drive) / normalization
  }
  return curve
}

/** SingzStretchNode host object (patch 3 in scripts/patch-audio-api.js). */
interface StretchHost {
  setSemitones(semitones: number): void
  getLatencySeconds(): number
  connect(node: unknown): void
}

export class MultitrackEngine {
  private ctx = new AudioContext()
  private backgrounded = false
  /** True while the process output lease belongs to the experimental native
   * playback session. This is separate from backgrounding: a cleanup proof
   * may return ownership to legacy while the app remains foregrounded. */
  private nativeOutputHandoff = false
  private master = this.ctx.createGain()
  /** Cues bypass the song master/stretch chain: transposing or slowing a song
   * must never change the reference pitch the exercise core requested. */
  private trainingGain = this.ctx.createGain()
  private trainingLimiter: WaveShaperNode = this.ctx.createWaveShaper()
  private trainingCueVolume = DEFAULT_TRAINING_REFERENCE_VOLUME
  private trainingCueMuted = false
  private trainingNodes: { oscillator: OscillatorNode; gain: GainNode }[] = []
  private trainingCueGeneration = 0
  private tracks: EngineTrack[] = []
  private sources: AudioBufferSourceNode[] = []
  private generation = 0
  private startedAt = 0
  private startOffset = 0
  private _playing = false
  private listeners = new Set<() => void>()
  private region: { start: number; end: number } | null = null
  private regionLoop = false
  private boundTimer: ReturnType<typeof setInterval> | null = null
  private training: TrainingSpec | null = null
  private ducked = new Set<string>()
  private trainTimer: ReturnType<typeof setInterval> | null = null

  private beatsInfo: BeatInfo | null = null
  private met: MetronomeConfig = { ...MET_DEFAULTS }
  private clickGain: GainNode | null = null
  private clickBufs: { accent: AudioBuffer; beat: AudioBuffer } | null = null
  private clickNodes: { node: AudioBufferSourceNode; at: number }[] = []
  private clickTimer: ReturnType<typeof setInterval> | null = null
  /** Beat index of the next click (negative during a count-in), null = none due. */
  private nextClickIdx: number | null = null
  /** How many times the loop region has wrapped since play() for the click walker. */
  private clickLap = 0
  /** First beat index at/after the play position — where a count-in hands over. */
  private startBeatIdx: number | null = null
  private countInfo: {
    firstCtx: number
    periodCtx: number
    total: number
    perBar: number
  } | null = null

  /** Clicks scheduled since launch (diagnostics/tests). */
  clickCount = 0

  duration = 0

  private stretchHost: StretchHost | null = null
  private stretchLatency = 0
  private rate = 1
  private pitchSemis = 0

  constructor() {
    // Master bus: tracks -> master -> [SingzStretch] -> destination. The
    // stretch node (patched into audio-api) corrects varispeed pitch and
    // applies transpose; at 0 semitones it bypasses with zero latency.
    const ctxHost = (
      this.ctx as unknown as {
        context: { createSingzStretch?: () => StretchHost }
      }
    ).context
    if (typeof ctxHost.createSingzStretch === 'function') {
      this.stretchHost = ctxHost.createSingzStretch()
      ;(this.master as unknown as { node: { connect(n: unknown): void } }).node.connect(
        this.stretchHost
      )
      this.stretchHost.connect((this.ctx.destination as unknown as { node: unknown }).node)
    } else {
      this.master.connect(this.ctx.destination)
    }
    this.trainingGain.gain.value = this.trainingCueVolume
    this.trainingLimiter.curve = trainingLimiterCurve()
    this.trainingLimiter.oversample = '2x'
    this.trainingGain.connect(this.trainingLimiter)
    this.trainingLimiter.connect(this.ctx.destination)
  }

  get trainingCurrentTime(): number {
    return this.ctx.currentTime
  }

  /** Route latency used when mapping recorder timestamps to what was heard. */
  get outputDisplayLatency(): number {
    return this.displayLag
  }

  setTrainingCueMuted(muted: boolean): void {
    this.trainingCueMuted = muted
    this.applyTrainingCueVolume()
  }

  setTrainingCueVolume(volume: number): void {
    this.trainingCueVolume = clampTrainingReferenceVolume(volume)
    this.applyTrainingCueVolume()
  }

  get trainingReferenceVolume(): number {
    return this.trainingCueVolume
  }

  private applyTrainingCueVolume(): void {
    this.trainingGain.gain.value = this.trainingCueMuted ? 0 : this.trainingCueVolume
  }

  /** Schedule a compact warm reference phrase on the engine clock. Song
   * playback is paused first, making cue and karaoke ownership exclusive. */
  async playTrainingCues(
    cues: readonly VocalTrainingCue[]
  ): Promise<{ ok: true; endsAt: number } | { ok: false; error: string }> {
    try {
      if (this.backgrounded)
        return {
          ok: false,
          error: 'Audio is paused while SingZ is in the background.'
        }
      if (this.nativeOutputHandoff)
        return {
          ok: false,
          error: 'Song playback currently owns the iPhone audio output.'
        }
      this.pause()
      this.cancelTrainingCues()
      const generation = ++this.trainingCueGeneration
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      if (this.backgrounded || generation !== this.trainingCueGeneration)
        return { ok: false, error: 'Training cue was cancelled.' }
      const plan = planTrainingCues(cues, this.ctx.currentTime + START_DELAY)
      for (const voice of plan.voices) {
        if (generation !== this.trainingCueGeneration)
          return { ok: false, error: 'Training cue was cancelled.' }
        const { start, end } = voice
        const fundamental = 440 * 2 ** ((voice.midi - 69) / 12)
        const concurrentVoices = plan.voices.filter(
          candidate => candidate.start < end && candidate.end > start
        ).length
        const voiceScale = 1 / Math.max(1, concurrentVoices)
        // Hammond-like drawbars turn the reference into a small instrument:
        // a dominant fundamental, woody upper harmonics and restrained
        // chorus on the three strongest drawbars.
        // Overlapping chord voices share unity gain so even the remembered
        // 100% setting retains a small amount of digital peak headroom.
        for (const partial of trainingOrganOscillators()) {
          const oscillator = this.ctx.createOscillator()
          const gain = this.ctx.createGain()
          oscillator.type = 'sine'
          oscillator.frequency.value = fundamental * partial.frequencyRatio
          gain.gain.setValueAtTime(0.0001, start)
          const level = partial.level * voiceScale
          const duration = end - start
          const attackEnd = start + Math.min(0.032, duration * 0.18)
          const bloomEnd = start + Math.min(0.18, duration * 0.55)
          const releaseStart = Math.max(bloomEnd, end - Math.min(0.22, duration * 0.36))
          gain.gain.exponentialRampToValueAtTime(level * 0.86, attackEnd)
          gain.gain.linearRampToValueAtTime(level, bloomEnd)
          gain.gain.setValueAtTime(level, releaseStart)
          gain.gain.exponentialRampToValueAtTime(0.0001, end)
          oscillator.connect(gain)
          gain.connect(this.trainingGain)
          oscillator.start(start)
          oscillator.stop(end + 0.01)
          this.trainingNodes.push({ oscillator, gain })
        }
      }
      return { ok: true, endsAt: plan.endsAt }
    } catch (error) {
      this.cancelTrainingCues()
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  cancelTrainingCues(): void {
    this.trainingCueGeneration++
    const now = this.ctx.currentTime
    for (const { oscillator, gain } of this.trainingNodes.splice(0)) {
      try {
        oscillator.stop(now)
      } catch {
        /* already ended */
      }
      try {
        oscillator.disconnect()
      } catch {
        /* already disconnected */
      }
      try {
        gain.disconnect()
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Stop native render work before the OS backgrounds the app. Keeping a
   * running WebAudio graph across that transition can leave Android rendering
   * stale oscillator/source buffers as distorted fragments. Foregrounding only
   * re-arms user actions; it never resumes sound by itself. */
  async suspendForBackground(): Promise<void> {
    this.backgrounded = true
    this.pause()
    this.cancelTrainingCues()
    this.cancelPendingClicks()
    if (this.ctx.state !== 'running') return
    try {
      await this.ctx.suspend()
    } catch (error) {
      log(
        'engine',
        `background suspend failed · ${error instanceof Error ? error.message : String(error)}`,
        'warn'
      )
    }
  }

  allowForegroundAudio(): void {
    this.backgrounded = false
  }

  /** Quiesce RNAudioAPI before RemoteIO is allowed to open. `unload()` frees
   * song graph ownership but deliberately leaves this AudioContext alive, so
   * the explicit suspend barrier is required to prevent overlapping output
   * renderers during the B2 handoff. */
  async suspendOutputForNativePlayback(): Promise<void> {
    this.nativeOutputHandoff = true
    this.pause()
    this.cancelTrainingCues()
    this.cancelPendingClicks()
    if (this.ctx.state === 'running') await this.ctx.suspend()
    log('engine', 'legacy output suspended for native playback handoff')
  }

  /** Called only after native unload returned a process-global fallback
   * lease. The next legacy play resumes the AudioContext lazily. */
  allowLegacyOutputAfterNativeCleanup(): void {
    if (!this.nativeOutputHandoff) return
    this.nativeOutputHandoff = false
    log('engine', 'legacy output allowed by native cleanup lease')
  }

  get outputHeldForNativePlayback(): boolean {
    return this.nativeOutputHandoff
  }

  /** Decode stem bytes/asset at the context rate (no runtime resampling). */
  decode(input: number | string | ArrayBuffer): Promise<AudioBuffer> {
    return decodeAudioData(input, this.ctx.sampleRate)
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

  get playing(): boolean {
    return this._playing
  }

  /** Context rate — decode stems at this rate to avoid runtime resampling. */
  get sampleRate(): number {
    return this.ctx.sampleRate
  }

  /**
   * Output-route latency (CarPlay/Bluetooth): what the listener hears trails
   * the context clock, so position — which drives lyrics and training ducks —
   * reports what is audible *now* (desktop parity: its engine subtracts
   * ctx.outputLatency the same way).
   */
  private displayLag = 0

  setDisplayLatency(sec: number): void {
    this.displayLag = Math.max(0, Math.min(3, sec))
    this.emit()
  }

  get displayLatency(): number {
    return this.displayLag
  }

  /**
   * Key & speed (desktop semantics): tempo is source varispeed, and the
   * master-bus stretch corrects its pitch plus the user's transpose —
   * semitones = transpose − 12·log2(rate). Rate changes while playing
   * re-anchor the clock through the coalesced-restart seek path.
   */
  setPitchTempo(semitones: number, rate: number): void {
    const r = Math.max(0.5, Math.min(1.5, rate))
    const rateChanged = Math.abs(r - this.rate) > 0.001
    const changed = rateChanged || semitones !== this.pitchSemis
    this.pitchSemis = semitones
    this.rate = r
    if (!changed) return
    this.applyStretch()
    if (rateChanged && (this._playing || this.restartTimer !== null)) {
      this.seek(this.audioPosition)
    } else {
      this.emit()
    }
  }

  get pitchTempo(): { semitones: number; rate: number } {
    return { semitones: this.pitchSemis, rate: this.rate }
  }

  private applyStretch(): void {
    if (!this.stretchHost) return
    const semis = this.pitchSemis - 12 * Math.log2(this.rate)
    this.stretchHost.setSemitones(Math.abs(semis) < 0.01 ? 0 : semis)
    // engagement happens on the audio thread; read the latency it settles on
    setTimeout(() => {
      if (this.stretchHost) {
        this.stretchLatency = this.stretchHost.getLatencySeconds()
        // click times include the stretch latency — re-derive queued ones
        if (this._playing && this.ctx.currentTime >= this.startedAt) {
          this.cancelPendingClicks()
          this.armClicksFromCurrent()
        }
        this.emit()
      }
    }, 400)
  }

  /**
   * How long the SONG is, as opposed to how long the longest thing loaded is.
   *
   * `duration` is the max over every lane, and a singer's own take can run
   * past the end of the song — a full-length recording that ran a couple of
   * seconds long is enough. A loop must not be armed into that overhang: it
   * would reach past where the stems have audio, and `src.loop` is a
   * whole-lane decision, so the stems would not loop at all. Lap one plays
   * them, laps two onward are the harmony alone with the band gone for good.
   *
   * Custom lanes are EXCLUDED rather than the shortest lane winning: the
   * shortest lane may be a four-second harmony, and letting that set the
   * ceiling shrinks every loop in the song to four seconds (measured — see
   * setRegion). Stems come from one six-stem split and are equal-length by
   * construction, so this is simply the song's real length.
   */
  private get songDuration(): number {
    const song = this.tracks.reduce((d, tr) => (tr.custom ? d : Math.max(d, tr.buffer.duration)), 0)
    return song > 0 ? song : this.duration
  }

  private clockPosition(lag: number): number {
    if (!this._playing) return this.startOffset
    // real seconds scale by the varispeed rate to give song seconds
    const elapsed = this.startOffset + (this.ctx.currentTime - this.startedAt - lag) * this.rate
    const r = this.regionLoop ? this.region : null
    if (r && this.startOffset < r.end && elapsed > r.end) {
      // Sources loop natively at r.end -> r.start; fold the linear clock.
      return r.start + ((elapsed - r.end) % (r.end - r.start))
    }
    return Math.min(this.duration, Math.max(this.startOffset, elapsed))
  }

  /** What the listener hears right now — drives lyrics and other visuals. */
  get position(): number {
    return this.clockPosition(this.displayLag + this.stretchLatency)
  }

  /**
   * What the engine is rendering right now. Gain flips, duck decisions and
   * stop/pause captures must use THIS clock: their effect rides the same
   * output pipeline as the stems, so both reach the ear displayLag later and
   * cancel exactly. Deciding them on the display clock leaks displayLag of
   * un-ducked vocal into every sing line (a full word on high-latency
   * Android routes).
   */
  get audioPosition(): number {
    return this.clockPosition(0)
  }

  /**
   * Play region: with loop, sources wrap natively at the region edges (every
   * stem on the same sample — no gap); without loop, playback that started
   * inside the region stops at its end. Live-updatable while playing.
   */
  setRegion(region: { start: number; end: number } | null, loop: boolean): void {
    /* Where the listener actually is, read BEFORE the fold changes under us —
     * while a loop is armed this is the folded position, and once it is gone
     * the same elapsed time reads as the raw linear one. Clearing a loop after
     * a few laps would otherwise jump the readout forward by every lap played
     * and never come back, because the fold cannot re-engage. */
    const at = this.audioPosition
    const wasFolding = this.regionLoop && this.region !== null
    /* NOT fitted to the shortest lane, deliberately. Lanes differ in length —
     * the added-track test project carries a 4s harmony over a 40.8s song —
     * so clamping the region to the shortest would let one short recording
     * shrink every loop in the song to its own length (measured: a 2→39.5s
     * mark came back as 2→4). A lane that ends inside the region simply does
     * not loop (see applyLoop); it plays its part and falls silent, which is
     * exactly what it does in ordinary playback.
     *
     * The mirror case cannot go silent either: `region.end` is clamped to
     * `duration`, which is the LONGEST lane, so at least that lane always
     * covers the region and loops. A mark past where the stems end loops only
     * the lane that still has audio there — and the stems have already ended
     * at that point, so there is nothing of theirs to hear either way. */
    const capped = region
      ? { start: region.start, end: Math.min(region.end, this.songDuration) }
      : null
    this.region = capped && capped.end - capped.start > 0.05 ? capped : null
    this.regionLoop = loop
    for (const src of this.sources) this.applyLoop(src)
    this.syncBoundWatcher()
    const nowFolding = this.regionLoop && this.region !== null
    /* Arming with the playhead outside the new region is the other half: the
     * native side clamps the start offset into the loop and plays from there
     * while the clock counts on from where it was. seek() puts both at the
     * same place, and clamps into the region on the way. */
    const outside =
      nowFolding && this.region !== null && (at < this.region.start || at >= this.region.end - 0.05)
    /* Only a CLEAR needs the unconditional re-anchor (the fold stops applying
     * under a clock that was folded). Arming is covered by `outside`; when the
     * playhead is already inside, the fold is correct as it stands and a seek
     * would only stop every source and restart 80ms later for nothing. */
    /* `outside` judges the folded position; the fold's PRECONDITION is about
     * startOffset, and after a wrap startOffset sits past it quite normally. A
     * re-arm (armed → a different region) skips the clear term and could leave
     * startOffset beyond the new end with the fold dead. No caller does that
     * today — cycleLoop always clears first — but draggable band edges are the
     * obvious next turn of this UI and they are exactly this call.
     *
     * DO NOT narrow the `startOffset < region.start` half to match the fold's
     * `< region.end`. It looks redundant and is not: it is what guarantees
     * startOffset lies INSIDE an armed region, which `restartPendingStart()`
     * depends on. That path (a beat or metronome edit landing during a
     * count-in pre-roll) restores startOffset and calls play() directly,
     * bypassing seek — so it never gets seek's clamp, and an offset before
     * the region would start every source outside it and desync the clock
     * from the audio exactly as the original blockers did. The cost of
     * keeping it is one extra 80 ms restart when B is marked before A during
     * playback. */
    const offsetOutside =
      nowFolding &&
      this.region !== null &&
      (this.startOffset < this.region.start || this.startOffset >= this.region.end - 0.05)
    if ((wasFolding && !nowFolding) || outside || offsetOutside) this.seek(at)
    if (this._playing && this.ctx.currentTime >= this.startedAt) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
  }

  get regionState(): { start: number; end: number; loop: boolean } | null {
    return this.region ? { ...this.region, loop: this.regionLoop } : null
  }

  private applyLoop(src: AudioBufferSourceNode): void {
    const r = this.regionLoop ? this.region : null
    if (r && src.buffer) {
      src.loopStart = Math.max(0, r.start)
      src.loopEnd = Math.min(r.end, src.buffer.duration)
      /* Lanes may differ in length — a singer's own track is whatever they
       * recorded. One that ends inside the region must NOT loop over the
       * truncated window: it would cycle on a shorter period than the stems
       * and drift out of phase with the music on the first wrap. Let it play
       * out and stop, which is what a short lane does anyway. */
      src.loop = src.loopEnd - src.loopStart > 0.05 && src.buffer.duration >= r.end - 0.001
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
        if (this.startOffset < r.end && this.audioPosition >= r.end - 0.015) {
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
  setTraining(spec: TrainingSpec | null): void {
    this.training = spec
    this.syncTrainWatcher()
    this.trainTick()
  }

  /** Stems currently ducked by the training schedule. */
  get duckedStems(): string[] {
    return [...this.ducked]
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
    const want = tr && this.duckAt(this.audioPosition) ? tr.stems : []
    if (want.length === this.ducked.size && want.every(id => this.ducked.has(id))) return
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

  /* ---- Metronome click pipeline (desktop parity, audio-clock based) ----- */

  get beats(): BeatInfo | null {
    return this.beatsInfo
  }

  get metronome(): MetronomeConfig {
    return this.met
  }

  /** Live count-in progress for the footer dots (null when not counting). */
  get countInStatus(): { total: number; done: number; perBar: number } | null {
    const c = this.countInfo
    if (c === null || !this._playing) return null
    // Dots flip when clicks are HEARD: the render clock leads the ear by the
    // output-route latency (Bluetooth/CarPlay), like `position` vs
    // `audioPosition`. Click times carry stretchLatency already; the music
    // start does not, so the cutoff adds it before comparing.
    const now = this.ctx.currentTime - this.displayLag
    if (now >= this.startedAt + this.stretchLatency) return null
    const done = Math.max(0, Math.min(c.total, Math.floor((now - c.firstCtx) / c.periodCtx) + 1))
    return { total: c.total, done, perBar: c.perBar }
  }

  setBeats(info: BeatInfo | null): void {
    this.beatsInfo = info
    if (!this.restartPendingStart() && this._playing) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
    this.emit()
  }

  setMetronome(m: MetronomeConfig): void {
    const structural = m.click !== this.met.click || m.countInBars !== this.met.countInBars
    this.met = m
    if (this.clickGain) {
      this.clickGain.gain.setTargetAtTime(m.volume, this.ctx.currentTime, 0.02)
    }
    if (structural && !this.restartPendingStart() && this._playing) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
    this.emit()
  }

  /** One immediate click — loudness preview in the practice sheet. */
  previewClick(accent = false): void {
    if (this.backgrounded || this.nativeOutputHandoff) return
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.scheduleClick(this.ctx.currentTime, accent)
  }

  /** Woodblock-ish clicks, synthesized once (no assets). Null if the runtime
   *  cannot create buffers — the metronome then simply stays silent. */
  private ensureClickAudio(): boolean {
    if (this.clickBufs !== null && this.clickGain !== null) return true
    try {
      const sr = this.ctx.sampleRate
      const mk = (freq: number, amp: number): AudioBuffer => {
        const n = Math.round(sr * 0.055)
        const buf = this.ctx.createBuffer(1, n, sr)
        const d = buf.getChannelData(0)
        for (let i = 0; i < n; i++) {
          const t = i / sr
          d[i] =
            amp * Math.min(1, t / 0.0015) * Math.exp(-t / 0.012) * Math.sin(2 * Math.PI * freq * t)
        }
        return buf
      }
      // Clicks bypass the master bus: transpose/tempo correction and stem
      // gains must never color the metronome.
      const gain = this.ctx.createGain()
      gain.gain.value = this.met.volume
      gain.connect(this.ctx.destination)
      this.clickGain = gain
      this.clickBufs = { accent: mk(1568, 0.9), beat: mk(1046.5, 0.62) }
      return true
    } catch {
      this.clickBufs = null
      this.clickGain = null
      return false
    }
  }

  private scheduleClick(at: number, accent: boolean): void {
    if (!this.ensureClickAudio() || this.clickBufs === null || this.clickGain === null) return
    const src = this.ctx.createBufferSource()
    src.buffer = accent ? this.clickBufs.accent : this.clickBufs.beat
    src.connect(this.clickGain)
    src.onEnded = () => {
      this.retireClickSource(src)
    }
    src.start(Math.max(at, this.ctx.currentTime))
    this.clickNodes.push({ node: src, at })
    this.clickCount++
  }

  /** Same discipline as stems: nulling the buffer is the graph's release hook
   *  for the source's grip (the shared click PCM stays alive via clickBufs). */
  private retireClickSource(src: AudioBufferSourceNode): void {
    src.onEnded = null
    try {
      src.disconnect()
    } catch {
      // already disconnected
    }
    try {
      src.buffer = null
    } catch {
      // older audio-api without the null setter
    }
    this.clickNodes = this.clickNodes.filter(c => c.node !== src)
  }

  private cancelPendingClicks(): void {
    const now = this.ctx.currentTime
    for (const c of [...this.clickNodes]) {
      if (c.at > now + 0.002) {
        try {
          c.node.stop()
        } catch {
          // raced its own end
        }
        this.retireClickSource(c.node)
      }
    }
  }

  /**
   * Context time when song time `songT` renders, `lap` region-loop wraps in.
   * Clicks bypass the stretch node, so its latency is added back to stay
   * simultaneous with the (delayed) stems; the output-route latency delays
   * both alike and needs no correction. Valid for pre-start (count-in) song
   * times too: they map to the pre-roll before `startedAt`.
   */
  private clickCtxTime(songT: number, lap: number): number {
    const r = this.regionLoop ? this.region : null
    const linear = r && lap > 0 ? r.end + (lap - 1) * (r.end - r.start) + (songT - r.start) : songT
    return this.startedAt + (linear - this.startOffset) / this.rate + this.stretchLatency
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

  /** Re-derive the next click from what renders right now (seek/region/beat edits). */
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

  /** A beat/metronome change while the pre-roll is pending: rebuild the start. */
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
    void this.play()
    return true
  }

  getTrackStates(): TrackState[] {
    return this.tracks.map(({ id, muted, solo, volume }) => ({
      id,
      muted,
      solo,
      volume
    }))
  }

  load(list: EngineTrackInput[], opts: { position?: number; play?: boolean } = {}): void {
    // teardown releases the outgoing project's stems: fresh tracks start
    // unducked, and a loop armed for one song must never bound the next.
    this.teardown()
    this.rate = 1 // neutral until the project's saved key/speed applies
    this.pitchSemis = 0
    this.stretchLatency = 0
    this.applyStretch()
    this.tracks = list.map(t => {
      const gain = this.ctx.createGain()
      gain.connect(this.master)
      return {
        id: t.id,
        buffer: t.buffer,
        custom: t.custom === true,
        gain,
        volume: 1,
        muted: false,
        solo: false
      }
    })
    this.duration = this.tracks.reduce((d, t) => Math.max(d, t.buffer.duration), 0)
    this.startOffset = Math.min(opts.position ?? 0, this.duration)
    this._playing = false
    this.applyGains(true)
    this.emit()
    log(
      'engine',
      `loaded ${this.tracks.length} lanes · ${fmtTime(this.duration)} · ` +
        `${this.ctx.sampleRate} Hz · ctx ${this.ctx.state}`
    )
    if (opts.play) void this.play({ countIn: false })
  }

  async play(opts: { countIn?: boolean } = {}): Promise<void> {
    if (this.backgrounded || this.nativeOutputHandoff || this._playing || this.tracks.length === 0)
      return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (this.backgrounded || this.nativeOutputHandoff) return
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0

    const gen = ++this.generation
    let when = this.ctx.currentTime + START_DELAY
    // Metronome pipeline (desktop parity): a count-in pushes the music start
    // out and clicks through the beats leading up to it — real preceding
    // beats mid-song, extrapolated ones before the track begins.
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
      watched.onEnded = () => {
        if (gen === this.generation && this._playing) {
          this._playing = false
          this.startOffset = this.duration
          this.nextClickIdx = null
          this.syncBoundWatcher()
          this.syncTrainWatcher()
          this.syncClickWatcher()
          this.emit()
        }
      }
    }
    this.startedAt = when
    this._playing = true
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
      const firstCtx = when + this.stretchLatency - secTicks * SEC_COUNT_PERIOD
      for (let k = 0; k < secTicks; k++) {
        this.scheduleClick(
          firstCtx + k * SEC_COUNT_PERIOD,
          this.met.accent && k % SEC_COUNT_TICKS === 0
        )
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

    // Deliberately not awaited: the route probe can take up to 3 s and play()
    // must not wait on a diagnostic. The line lands a moment after the music.
    const at = fmtTime(this.startOffset)
    void describeOutput().then(({ text, silent }) => {
      if (gen !== this.generation) return // a newer play() already reported
      log('engine', `play from ${at} · ${text}`)
      if (silent) {
        log(
          'engine',
          'media volume is 0 — the song is playing but nothing will be heard. ' +
            'Press volume up while SingZ is open.',
          'warn'
        )
      }
    })
  }

  pause(): void {
    if (this.restartTimer) {
      // pause during a pending post-seek restart cancels the restart
      clearTimeout(this.restartTimer)
      this.restartTimer = null
      this.emit()
    }
    if (!this._playing) return
    this.startOffset = this.audioPosition
    this._playing = false
    log('engine', `pause at ${fmtTime(this.startOffset)}`)
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
    if (this._playing) this.pause()
    else void this.play()
  }

  /** Pending post-seek restart — rapid seeks coalesce into one rebuild. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  seek(t: number): void {
    /*
     * A seek that lands outside an armed loop desynchronises the clock from
     * the audio, and past the end it never heals. The native processor wraps
     * `position_` into [loopStart, loopEnd] unconditionally, while
     * clockPosition only folds when `startOffset < region.end` — so an offset
     * at or past the end leaves the readout walking on to the end of the song
     * while the stems loop forever. Clamping here rather than at each call
     * site because the internal restart below seeks too, and a UI guard
     * cannot reach it.
     *
     * `end - 0.05` rather than `end`: landing exactly on the end is what
     * breaks the fold's precondition, so the offset has to stay strictly
     * inside. While a loop is armed the transport therefore works within it,
     * which is how every A-B repeat behaves — the way out is releasing it.
     */
    const r = this.regionLoop ? this.region : null
    const inRegion = r ? Math.max(r.start, Math.min(t, r.end - 0.05)) : t
    const clamped = Math.max(0, Math.min(inRegion, this.duration))
    if (this._playing || this.restartTimer !== null) {
      // Tearing down and instantly recreating every source per seek can
      // wedge the native render thread on device — stop now, restart once
      // the scrubbing settles.
      this.stopSources()
      this.cancelPendingClicks()
      this.nextClickIdx = null
      this.countInfo = null
      this._playing = false
      this.startOffset = clamped
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        // Seeks restart playback in place — a count-in belongs to a
        // deliberate play, not to scrubbing around.
        void this.play({ countIn: false })
      }, 80)
      this.trainTick()
      this.emit()
    } else {
      this.startOffset = clamped
      this.trainTick() // keep the ducked-lane preview honest while paused
      this.emit()
    }
  }

  seekBy(dt: number): void {
    this.seek(this.audioPosition + dt)
  }

  setMuted(id: string, muted: boolean): void {
    const t = this.tracks.find(t => t.id === id)
    if (!t) return
    t.muted = muted
    this.applyGains()
    this.emit()
  }

  setSolo(id: string, solo: boolean): void {
    const t = this.tracks.find(t => t.id === id)
    if (!t) return
    t.solo = solo
    this.applyGains()
    this.emit()
  }

  setVolume(id: string, volume: number): void {
    const t = this.tracks.find(t => t.id === id)
    if (!t) return
    t.volume = Math.max(0, Math.min(1, volume))
    this.applyGains()
    this.emit()
  }

  private applyGains(instant = false): void {
    const anySolo = this.tracks.some(t => t.solo)
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
      s.onEnded = null
      try {
        s.stop()
      } catch {
        // never started or already stopped
      }
      s.disconnect()
      // Hand the stem PCM back now. The native graph keeps every source node
      // it created until the render thread retires it (use_count 1 AND
      // finished), and each node holds a shared_ptr to its decoded buffer —
      // so a stopped-but-not-yet-retired source pins ~90 MB per stem per four
      // minutes of song for as long as the graph feels like it. Nulling the
      // buffer is the library's release hook: it queues the buffer for
      // destruction immediately, and the render path already no-ops on empty
      // sources. Safe here because these sources are being discarded.
      try {
        s.buffer = null
      } catch {
        // older audio-api without the null setter — GC will get there
      }
    }
    this.sources = []
  }

  /** Stop everything and drop the graph state; leaves the master bus intact. */
  private teardown(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopSources()
    this.cancelPendingClicks()
    this.beatsInfo = null // the next project brings its own beat track
    this.nextClickIdx = null
    this.countInfo = null
    this.startBeatIdx = null
    this.syncClickWatcher()
    for (const t of this.tracks) t.gain.disconnect()
    this.tracks = []
    this.ducked.clear()
    this.region = null
    this.regionLoop = false
    this._playing = false
    this.syncBoundWatcher()
    this.syncTrainWatcher()
  }

  /**
   * Let go of the loaded project. Stem buffers are the app's whole memory
   * budget (six stems ≈ 138 MB per minute of song at 48 kHz float32), and
   * nothing frees them until every reference — engine tracks, source nodes,
   * the LoadedProject itself — is gone. Dropping that on the floor for GC to
   * find is what let the iPhone build climb to 3.5 GB and take a
   * per-process-limit jetsam kill after a few songs.
   */
  unload(): void {
    this.cancelTrainingCues()
    // Leaving a song unloads then releases, and the teardown path can reach
    // here twice; the second call has nothing to free and saying so twice
    // just spends lines of a 400-line log.
    if (this.tracks.length > 0) log('engine', `unload · ${this.tracks.length} lanes released`)
    this.teardown()
    this.training = null
    this.duration = 0
    this.startOffset = 0
    this.emit()
  }
}
