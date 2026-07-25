declare module 'signalsmith-stretch' {
  export interface StretchScheduleChange {
    output?: number
    active?: boolean
    input?: number
    rate?: number
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
    loopStart?: number
    loopEnd?: number
  }

  export interface StretchNode extends AudioNode {
    schedule(change: StretchScheduleChange): void
    start(when?: number): void
    stop(when?: number): void
    latency(): number | Promise<number>
    addBuffers(buffers: Float32Array[]): Promise<number>
    dropBuffers(toSeconds?: number): Promise<unknown>
    setUpdateInterval(seconds: number, callback?: () => void): void
    configure(opts: Record<string, unknown>): void
  }

  export default function SignalsmithStretch(
    ctx: AudioContext,
    channelOptions?: Record<string, unknown>
  ): Promise<StretchNode>
}
