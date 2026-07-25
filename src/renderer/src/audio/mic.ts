import { yinPitch } from './pitch'

/**
 * Live microphone pitch: mic → AnalyserNode, polled from the UI's rAF loop.
 * Echo cancellation stays on so the speakers' backing track doesn't leak into
 * the analysis; AGC/noise-suppression stay off to keep the voice unprocessed.
 */
export class MicPitch {
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private buf: Float32Array<ArrayBuffer> | null = null

  async start(ctx: AudioContext): Promise<void> {
    if (this.stream) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    })
    this.source = ctx.createMediaStreamSource(this.stream)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.source.connect(this.analyser)
    this.buf = new Float32Array(this.analyser.fftSize)
  }

  get active(): boolean {
    return this.stream !== null
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
  }
}
