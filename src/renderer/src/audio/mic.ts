import { yinPitchInfo, type PitchFrame } from './pitch'

export interface MicDevice {
  id: string
  label: string
  /** The asked-for device was unavailable — this is the default instead. */
  fallback: boolean
  /** The hardware channel actually connected to the analyser (zero-based). */
  channelIndex: number
  /** Channels Chromium exposed for this capture. */
  channelCount: number
  /** The requested channel was outside the exposed range and was clamped. */
  channelFallback: boolean
}

export interface MicLevel {
  /** Linear RMS, useful to tests and non-visual consumers. */
  rms: number
  /** Stable full-scale decibels, clamped to the meter's noise floor. */
  dbfs: number
  signal: boolean
}

/** Never let a temporary default-device fallback rewrite another device's lane. */
export function shouldAdoptInputChannel(
  device: MicDevice | null,
  savedChannel: number | undefined
): device is MicDevice {
  return Boolean(
    device?.channelFallback && !device.fallback && device.channelIndex !== (savedChannel ?? 0)
  )
}

const METER_FLOOR_DB = -72
const MAX_CAPTURE_CHANNELS = 32

/**
 * Live microphone pitch: mic → AnalyserNode, polled from the UI's rAF loop.
 * Echo cancellation stays on so the speakers' backing track doesn't leak into
 * the analysis; AGC/noise-suppression stay off to keep the voice unprocessed.
 * A chosen device is asked for exactly, then dropped for the default rather
 * than not singing at all (`device.fallback` says which one answered).
 */
export class MicPitch {
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null
  private dev: MicDevice | null = null
  private onEnded: (() => void) | null = null
  private endedTrack: MediaStreamTrack | null = null
  private endedHandler: (() => void) | null = null
  private context: AudioContext | null = null
  private startPending: Promise<void> | null = null
  private generation = 0

  async start(
    ctx: AudioContext,
    opts: { deviceId?: string; channelIndex?: number; onEnded?: () => void } = {}
  ): Promise<void> {
    if (this.stream) {
      if (this.context !== ctx) throw new Error('Microphone is already attached to another audio context.')
      return
    }
    if (this.startPending) {
      if (this.context !== ctx) throw new Error('Microphone is starting on another audio context.')
      return this.startPending
    }
    this.context = ctx
    const generation = ++this.generation
    const pending = this.startNow(ctx, opts, generation)
    this.startPending = pending
    try {
      await pending
    } finally {
      if (this.startPending === pending) this.startPending = null
      if (this.generation === generation && !this.stream) this.context = null
    }
  }

  private async startNow(
    ctx: AudioContext,
    opts: { deviceId?: string; channelIndex?: number; onEnded?: () => void },
    generation: number
  ): Promise<void> {
    const base = {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
      // Interfaces commonly default to a stereo pair even when they expose
      // more inputs. An ideal request preserves as many discrete lanes as
      // Chromium/the driver can provide without making older devices fail.
      channelCount: { ideal: MAX_CAPTURE_CHANNELS }
    }
    let fallback = false
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: opts.deviceId ?? 'default' } }
      })
    } catch (err) {
      // Missing (OverconstrainedError/NotFoundError) or busy (NotReadable/
      // Abort — exclusive-mode holds are everyday life on Windows): drop the
      // pick and sing on the default rather than not at all. NotAllowedError
      // stays fatal — no constraint change can fix a permission denial.
      const name = err instanceof DOMException ? err.name : ''
      const recoverable = ['OverconstrainedError', 'NotFoundError', 'NotReadableError', 'AbortError']
      if (!opts.deviceId || !recoverable.includes(name)) {
        throw err
      }
      this.assertStarting(generation)
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...base, deviceId: { exact: 'default' } }
      })
      fallback = true
    }
    let source: MediaStreamAudioSourceNode | null = null
    let splitter: ChannelSplitterNode | null = null
    let analyser: AnalyserNode | null = null
    try {
      this.assertStarting(generation)
      source = ctx.createMediaStreamSource(stream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      const track = stream.getAudioTracks()[0] ?? null
      if (!track) throw new Error('The microphone returned no audio track.')
      const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
      const settingsCount = positiveChannelCount(settings.channelCount)
      const sourceCount = positiveChannelCount(source.channelCount)
      const exposedCount = Math.min(MAX_CAPTURE_CHANNELS, settingsCount ?? sourceCount ?? 1)
      const wantedChannel = sanitizeChannelIndex(opts.channelIndex)
      let channelCount = exposedCount
      let channelIndex = Math.min(wantedChannel, exposedCount - 1)
      if (exposedCount > 1 && typeof ctx.createChannelSplitter === 'function') {
        try {
          splitter = ctx.createChannelSplitter(exposedCount)
          source.connect(splitter)
          splitter.connect(analyser, channelIndex)
        } catch {
          // Some drivers report multiple lanes while their WebAudio source
          // refuses discrete routing. Release the partial graph and keep a
          // truthful, usable direct-mono capture.
          source.disconnect()
          splitter?.disconnect()
          splitter = null
          source.connect(analyser)
          channelCount = 1
          channelIndex = 0
        }
      } else {
        // Test doubles and older WebAudio implementations may not expose a
        // splitter. A direct mono path remains usable and truthful.
        channelCount = 1
        channelIndex = 0
        source.connect(analyser)
      }
      const buf = new Float32Array(analyser.fftSize)
      this.assertStarting(generation)

      const onEnded = (): void => {
        const cb = this.onEnded
        this.stop()
        cb?.()
      }
      if (track) track.addEventListener('ended', onEnded)
      this.stream = stream
      this.source = source
      this.splitter = splitter
      this.analyser = analyser
      this.buf = buf
      this.onEnded = opts.onEnded ?? null
      this.endedTrack = track
      this.endedHandler = track ? onEnded : null
      this.dev = {
        id: typeof settings.deviceId === 'string' ? settings.deviceId : '',
        label: track.label,
        fallback,
        channelIndex,
        channelCount,
        channelFallback: channelIndex !== wantedChannel
      }
    } catch (error) {
      source?.disconnect()
      splitter?.disconnect()
      analyser?.disconnect()
      stream.getTracks().forEach((track) => track.stop())
      throw error
    }
  }

  private assertStarting(generation: number): void {
    if (this.generation !== generation || this.context === null)
      throw new Error('Microphone start was cancelled.')
  }

  get active(): boolean {
    return this.stream !== null
  }

  /** The device actually answering (from the live track); null when off. */
  get device(): MicDevice | null {
    return this.dev
  }

  /** Current sung pitch in Hz (0 = silent/unvoiced). */
  read(): number {
    return this.readInfo().f0
  }

  /** Current pitch plus confidence evidence for reusable training capture. */
  readInfo(): PitchFrame {
    if (!this.analyser || !this.buf) return { f0: 0, clarity: 0, rms: 0 }
    this.analyser.getFloatTimeDomainData(this.buf)
    return yinPitchInfo(this.buf, this.analyser.context.sampleRate)
  }

  /** Current selected-channel loudness. This never retains raw samples. */
  readLevel(): MicLevel {
    if (!this.analyser || !this.buf) return { rms: 0, dbfs: METER_FLOOR_DB, signal: false }
    this.analyser.getFloatTimeDomainData(this.buf)
    let energy = 0
    for (const sample of this.buf) energy += sample * sample
    const rms = Math.sqrt(energy / Math.max(1, this.buf.length))
    const dbfs = Math.max(METER_FLOOR_DB, Math.min(0, 20 * Math.log10(Math.max(rms, 1e-8))))
    return { rms, dbfs, signal: dbfs > METER_FLOOR_DB }
  }

  stop(): void {
    this.generation++
    const stream = this.stream
    const source = this.source
    const splitter = this.splitter
    const analyser = this.analyser
    if (this.endedTrack && this.endedHandler)
      this.endedTrack.removeEventListener('ended', this.endedHandler)
    this.stream = null
    this.source = null
    this.splitter = null
    this.analyser = null
    this.buf = null
    this.dev = null
    this.onEnded = null
    this.endedTrack = null
    this.endedHandler = null
    this.context = null
    stream?.getTracks().forEach((track) => track.stop())
    source?.disconnect()
    splitter?.disconnect()
    analyser?.disconnect()
  }
}

function positiveChannelCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.max(1, Math.floor(value))
    : null
}

function sanitizeChannelIndex(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(MAX_CAPTURE_CHANNELS - 1, value)
    : 0
}
