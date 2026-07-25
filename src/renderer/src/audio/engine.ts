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

  get position(): number {
    if (!this._playing) return this.startOffset
    const elapsed = this.startOffset + (this.ctx.currentTime - this.startedAt)
    return Math.min(this.duration, Math.max(this.startOffset, elapsed))
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data)
  }

  getTrackStates(): TrackState[] {
    return this.tracks.map(({ id, muted, solo, volume }) => ({ id, muted, solo, volume }))
  }

  load(list: EngineTrackInput[], opts: { position?: number; play?: boolean } = {}): void {
    this.stopSources()
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
    this.emit()
  }

  pause(): void {
    if (!this._playing) return
    this.startOffset = this.position
    this._playing = false
    this.stopSources()
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
      const audible = !t.muted && (!anySolo || t.solo)
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
