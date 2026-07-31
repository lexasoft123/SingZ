import { yinPitch } from './pitch'

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

  async start(
    ctx: AudioContext,
    opts: { deviceId?: string; onEnded?: () => void } = {}
  ): Promise<void> {
    if (this.stream) return
    const base = { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    let fallback = false
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: opts.deviceId ? { ...base, deviceId: { exact: opts.deviceId } } : base
      })
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (!opts.deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) {
        throw err
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: base })
      fallback = true
    }
    this.stream = stream
    this.onEnded = opts.onEnded ?? null
    const track = stream.getAudioTracks()[0]
    if (track) {
      this.dev = { id: track.getSettings().deviceId ?? '', label: track.label, fallback }
      // unplugged mid-song: release everything and tell the UI, instead of
      // leaving a silent "Mic on" state
      track.addEventListener('ended', () => {
        const cb = this.onEnded
        this.stop()
        cb?.()
      })
    }
    this.source = ctx.createMediaStreamSource(stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.source.connect(this.analyser)
    this.buf = new Float32Array(this.analyser.fftSize)
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
    if (!this.analyser || !this.buf) return 0
    this.analyser.getFloatTimeDomainData(this.buf)
    return yinPitch(this.buf, this.analyser.context.sampleRate)
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.source?.disconnect()
    this.analyser?.disconnect()
    this.stream = null
    this.source = null
    this.analyser = null
    this.buf = null
    this.dev = null
    this.onEnded = null
  }
}
