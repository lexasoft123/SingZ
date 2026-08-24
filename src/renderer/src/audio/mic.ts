import { yinPitchInfo, type PitchFrame } from './pitch'

export interface MicDevice {
  id: string
  label: string
  /** The asked-for device was unavailable — this is the default instead. */
  fallback: boolean
}

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
    opts: { deviceId?: string; onEnded?: () => void } = {}
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
    opts: { deviceId?: string; onEnded?: () => void },
    generation: number
  ): Promise<void> {
    const base = { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    let fallback = false
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: opts.deviceId ? { ...base, deviceId: { exact: opts.deviceId } } : base
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
      stream = await navigator.mediaDevices.getUserMedia({ audio: base })
      fallback = true
    }
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    try {
      this.assertStarting(generation)
      source = ctx.createMediaStreamSource(stream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      this.assertStarting(generation)

      const track = stream.getAudioTracks()[0] ?? null
      const onEnded = (): void => {
        const cb = this.onEnded
        this.stop()
        cb?.()
      }
      if (track) track.addEventListener('ended', onEnded)
      this.stream = stream
      this.source = source
      this.analyser = analyser
      this.buf = buf
      this.onEnded = opts.onEnded ?? null
      this.endedTrack = track
      this.endedHandler = track ? onEnded : null
      this.dev = track
        ? { id: track.getSettings().deviceId ?? '', label: track.label, fallback }
        : null
    } catch (error) {
      source?.disconnect()
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

  stop(): void {
    this.generation++
    const stream = this.stream
    const source = this.source
    const analyser = this.analyser
    if (this.endedTrack && this.endedHandler)
      this.endedTrack.removeEventListener('ended', this.endedHandler)
    this.stream = null
    this.source = null
    this.analyser = null
    this.buf = null
    this.dev = null
    this.onEnded = null
    this.endedTrack = null
    this.endedHandler = null
    this.context = null
    stream?.getTracks().forEach((track) => track.stop())
    source?.disconnect()
    analyser?.disconnect()
  }
}
