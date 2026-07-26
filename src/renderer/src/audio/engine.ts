import SignalsmithStretch, { type StretchNode } from 'signalsmith-stretch'

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

/**
 * Sample-synchronized multitrack player. All tracks are AudioBufferSources
 * scheduled on the same AudioContext clock; mute/solo/volume are GainNode
 * ramps so toggling mid-playback is click-free.
 */
export class MultitrackEngine {
  private ctx = new AudioContext({ latencyHint: 'interactive' })
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

  duration = 0

  constructor() {
    this.master.connect(this.ctx.destination)
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

  get context(): AudioContext {
    return this.ctx
  }

  get position(): number {
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

  /**
   * Pitch-shift the whole mix (one Signalsmith Stretch node on the master bus:
   * phase-coherent across stems, duration unchanged, per-stem mutes stay live).
   */
  /** Create the stretch worklet once; concurrent callers share the same promise. */
  private ensureStretch(): Promise<StretchNode> {
    if (!this.stretchPromise) {
      this.stretchPromise = (async () => {
        const node = await SignalsmithStretch(this.ctx)
        node.connect(this.ctx.destination)
        try {
          const l = node.latency()
          this.stretchLatency = typeof l === 'number' ? l : ((await l) ?? 0)
        } catch {
          this.stretchLatency = 0
        }
        this.stretch = node
        return node
      })()
      this.stretchPromise.catch(() => {
        this.stretchPromise = null
      })
    }
    return this.stretchPromise
  }

  async setTranspose(st: number): Promise<void> {
    const target = Math.max(-12, Math.min(12, Math.round(st)))
    if (target === this.semitones) return
    this.semitones = target
    await this.applyStretchState()
    this.emit()
  }

  /**
   * Playback speed with pitch preserved: every stem source runs at `rate`
   * (varispeed, sample-locked), and the master-bus stretch node corrects the
   * resulting pitch shift by -12*log2(rate) on top of the user's transpose.
   */
  async setTempo(rate: number): Promise<void> {
    const target = Math.round(Math.max(0.5, Math.min(1.5, rate)) * 10000) / 10000
    if (Math.abs(target - this.rate) < 0.0001) return
    this.applyRate(target)
    await this.applyStretchState()
    this.emit()
  }

  /** Re-anchor the clock at the current position, then switch the rate. */
  private applyRate(rate: number): void {
    if (this._playing) {
      this.startOffset = this.position
      this.startedAt = this.ctx.currentTime
    }
    this.rate = rate
    for (const src of this.sources) src.playbackRate.value = rate
  }

  private async applyStretchState(): Promise<void> {
    const semitones = this.semitones
    const rate = this.rate
    if (semitones === 0 && rate === 1) {
      this.stretchOn = false
      this.stretch?.schedule({ active: false })
      this.master.disconnect()
      this.master.connect(this.ctx.destination)
      return
    }
    try {
      // A worklet that never finishes booting (e.g. CSP blocking its WASM)
      // must fail loudly, not leave the mix silently unprocessed.
      const stretch = await Promise.race([
        this.ensureStretch(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('stretch worklet did not start within 5s')), 5000)
        )
      ])
      if (this.semitones !== semitones || this.rate !== rate) return // superseded
      this.master.disconnect()
      this.master.connect(stretch)
      stretch.schedule({ active: true, semitones: semitones - 12 * Math.log2(rate) })
      this.stretchOn = true
    } catch (err) {
      console.error('Pitch/tempo processing unavailable:', err)
      this.semitones = 0
      this.applyRate(1)
      this.stretchOn = false
      this.master.disconnect()
      this.master.connect(this.ctx.destination)
    }
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data)
  }

  getTrackStates(): TrackState[] {
    return this.tracks.map(({ id, muted, solo, volume }) => ({ id, muted, solo, volume }))
  }

  load(list: EngineTrackInput[], opts: { position?: number; play?: boolean } = {}): void {
    this.stopSources()
    this.ducked.clear() // fresh tracks start unducked; the schedule re-applies on play
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
      watched.onended = () => {
        if (gen === this.generation && this._playing) {
          this._playing = false
          this.startOffset = this.duration
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
    if (!this._playing) return
    this.startOffset = this.position
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

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration))
    if (this._playing) {
      this.stopSources()
      this._playing = false
      this.startOffset = clamped
      void this.play()
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
