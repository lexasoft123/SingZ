import {
  AudioContext,
  decodeAudioData,
  type AudioBuffer,
  type AudioBufferSourceNode,
  type GainNode
} from 'react-native-audio-api'
import { accentIndex, beatIndexAtOrAfter, beatTime } from './beat'
import { MET_DEFAULTS, type BeatInfo, type MetronomeConfig } from './model'

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
const CLICK_LOOKAHEAD = 0.18 // clicks are queued this far ahead on the audio clock
const CLICK_TICK_MS = 60

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
  private countInfo: { firstCtx: number; periodCtx: number; total: number; perBar: number } | null =
    null

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
        // click times include the stretch latency — re-derive queued ones
        if (this._playing && this.ctx.currentTime >= this.startedAt) {
          this.cancelPendingClicks()
          this.armClicksFromCurrent()
        }
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
    const now = this.ctx.currentTime
    if (now >= this.startedAt) return null
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
    this.clickNodes = this.clickNodes.filter((c) => c.node !== src)
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
        this.scheduleClick(at, accentIndex(this.beatsInfo, this.nextClickIdx) === 0)
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
    return this.tracks.map(({ id, muted, solo, volume }) => ({ id, muted, solo, volume }))
  }

  load(list: EngineTrackInput[], opts: { position?: number; play?: boolean } = {}): void {
    // teardown releases the outgoing project's stems: fresh tracks start
    // unducked, and a loop armed for one song must never bound the next.
    this.teardown()
    this.rate = 1 // neutral until the project's saved key/speed applies
    this.pitchSemis = 0
    this.stretchLatency = 0
    this.applyStretch()
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
    if (opts.play) void this.play({ countIn: false })
  }

  async play(opts: { countIn?: boolean } = {}): Promise<void> {
    if (this._playing || this.tracks.length === 0) return
    if (this.ctx.state === 'suspended') await this.ctx.resume()
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
        const beats = bars * g.beatsPerBar
        const first = i0 - beats
        when += (this.startOffset - beatTime(g, first)) / this.rate
        this.nextClickIdx = first
      } else if (beatTime(g, i0) <= this.duration) {
        this.nextClickIdx = i0
      }
    }
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
      const total = bars * g.beatsPerBar
      const span = this.startOffset - beatTime(g, this.nextClickIdx)
      this.countInfo = {
        firstCtx: this.clickCtxTime(beatTime(g, this.nextClickIdx), 0),
        periodCtx: span / total / this.rate,
        total,
        perBar: g.beatsPerBar
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
    const clamped = Math.max(0, Math.min(t, this.duration))
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
    this.teardown()
    this.training = null
    this.duration = 0
    this.startOffset = 0
    this.emit()
  }
}
