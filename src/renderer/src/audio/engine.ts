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
  private beatsInfo: BeatInfo | null = null
  private met: MetronomeConfig = { ...MET_DEFAULTS }
  private clickGain = this.ctx.createGain()
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

  /** Current output device id ('' = system default). */
  get outputDeviceId(): string {
    return this.ctx.sinkId
  }

  /**
   * Route everything audible to another device. Mix, metronome and the
   * stretch path all terminate at ctx.destination, so one sinkId move
   * carries them together; '' returns to the system default.
   */
  async setOutput(deviceId: string): Promise<void> {
    if (!('setSinkId' in this.ctx)) throw new Error('Changing outputs is not supported here.')
    if (this.ctx.sinkId === deviceId) return
    await this.ctx.setSinkId(deviceId)
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
    this.clickGain.gain.setTargetAtTime(m.volume, this.ctx.currentTime, 0.02)
    if (structural && !this.restartPendingStart() && this._playing) {
      this.cancelPendingClicks()
      this.armClicksFromCurrent()
    }
    this.emit()
  }

  /** One immediate click — popover feedback (volume preview, tap confirmation). */
  previewClick(accent = false): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    this.scheduleClick(this.ctx.currentTime, accent)
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
    void this.play()
    return true
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
      this.rearmClicksAfterLatencyFlip(wasOn)
    } catch (err) {
      console.error('Pitch/tempo processing unavailable:', err)
      this.semitones = 0
      this.applyRate(1)
      this.stretchOn = false
      this.master.disconnect()
      this.master.connect(this.ctx.destination)
      this.rearmClicksAfterLatencyFlip(wasOn)
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
    this.cancelPendingClicks()
    this.nextClickIdx = null
    this.countInfo = null
    this.startBeatIdx = null
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
    // Mid-session reloads (post-split hot-swap) resume without a count-in.
    if (opts.play) void this.play({ countIn: false })
  }

  async play(opts: { countIn?: boolean } = {}): Promise<void> {
    if (this._playing || this.tracks.length === 0) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0

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
    if (this._playing) this.pause()
    else void this.play()
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.duration))
    if (this._playing) {
      this.stopSources()
      this.cancelPendingClicks()
      this._playing = false
      this.startOffset = clamped
      // Seeks restart playback in place — a count-in belongs to a deliberate
      // play, not to scrubbing around.
      void this.play({ countIn: false })
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
