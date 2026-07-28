import {
  AudioContext,
  decodeAudioData,
  type AudioBuffer,
  type AudioBufferSourceNode,
  type GainNode
} from 'react-native-audio-api'

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
}

interface EngineTrack {
  id: string
  buffer: AudioBuffer
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

/** SingzStretchNode host object (patch 3 in scripts/patch-audio-api.js). */
interface StretchHost {
  setSemitones(semitones: number): void
  getLatencySeconds(): number
  connect(node: unknown): void
}

export class MultitrackEngine {
  private ctx = new AudioContext()
  private master = this.ctx.createGain()
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

  duration = 0

  private stretchHost: StretchHost | null = null
  private stretchLatency = 0
  private rate = 1
  private pitchSemis = 0

  constructor() {
    // Master bus: tracks -> master -> [SingzStretch] -> destination. The
    // stretch node (patched into audio-api) corrects varispeed pitch and
    // applies transpose; at 0 semitones it bypasses with zero latency.
    const ctxHost = (this.ctx as unknown as { context: { createSingzStretch?: () => StretchHost } })
      .context
    if (typeof ctxHost.createSingzStretch === 'function') {
      this.stretchHost = ctxHost.createSingzStretch()
      ;(this.master as unknown as { node: { connect(n: unknown): void } }).node.connect(
        this.stretchHost
      )
      this.stretchHost.connect(
        (this.ctx.destination as unknown as { node: unknown }).node
      )
    } else {
      this.master.connect(this.ctx.destination)
    }
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
        this.emit()
      }
    }, 400)
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
    this.region = region && region.end - region.start > 0.05 ? region : null
    this.regionLoop = loop
    for (const src of this.sources) this.applyLoop(src)
    this.syncBoundWatcher()
  }

  get regionState(): { start: number; end: number; loop: boolean } | null {
    return this.region ? { ...this.region, loop: this.regionLoop } : null
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

  getTrackStates(): TrackState[] {
    return this.tracks.map(({ id, muted, solo, volume }) => ({ id, muted, solo, volume }))
  }

  load(list: EngineTrackInput[], opts: { position?: number; play?: boolean } = {}): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.stopSources()
    this.ducked.clear() // fresh tracks start unducked; the schedule re-applies on play
    this.region = null // a loop armed for one song must never bound the next
    this.regionLoop = false
    this.rate = 1 // neutral until the project's saved key/speed applies
    this.pitchSemis = 0
    this.stretchLatency = 0
    this.applyStretch()
    for (const t of this.tracks) t.gain.disconnect()
    this.tracks = list.map((t) => {
      const gain = this.ctx.createGain()
      gain.connect(this.master)
      return { id: t.id, buffer: t.buffer, gain, volume: 1, muted: false, solo: false }
    })
    this.duration = this.tracks.reduce((d, t) => Math.max(d, t.buffer.duration), 0)
    this.startOffset = Math.min(opts.position ?? 0, this.duration)
    this._playing = false
    this.applyGains(true)
    this.emit()
    if (opts.play) void this.play()
  }

  async play(): Promise<void> {
    if (this._playing || this.tracks.length === 0) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0

    const gen = ++this.generation
    const when = this.ctx.currentTime + START_DELAY
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
          this.syncBoundWatcher()
          this.syncTrainWatcher()
          this.emit()
        }
      }
    }
    this.startedAt = when
    this._playing = true
    this.syncBoundWatcher()
    this.syncTrainWatcher()
    this.trainTick() // duck state must be right before the first sample sounds
    this.emit()
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
    this.stopSources()
    this.syncBoundWatcher()
    this.syncTrainWatcher()
    this.emit()
  }

  toggle(): void {
    if (this._playing) this.pause()
    else void this.play()
  }

  /** Pending post-seek restart — rapid seeks coalesce into one rebuild. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration))
    if (this._playing || this.restartTimer !== null) {
      // Tearing down and instantly recreating every source per seek can
      // wedge the native render thread on device — stop now, restart once
      // the scrubbing settles.
      this.stopSources()
      this._playing = false
      this.startOffset = clamped
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        void this.play()
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
    const t = this.tracks.find((t) => t.id === id)
    if (!t) return
    t.muted = muted
    this.applyGains()
    this.emit()
  }

  setSolo(id: string, solo: boolean): void {
    const t = this.tracks.find((t) => t.id === id)
    if (!t) return
    t.solo = solo
    this.applyGains()
    this.emit()
  }

  setVolume(id: string, volume: number): void {
    const t = this.tracks.find((t) => t.id === id)
    if (!t) return
    t.volume = Math.max(0, Math.min(1, volume))
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
      s.onEnded = null
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
