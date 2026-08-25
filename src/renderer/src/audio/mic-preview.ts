import { MicPitch, type MicDevice, type MicLevel } from './mic'

export type MicPreviewErrorKind = 'permission' | 'busy' | 'unavailable' | 'unknown'

/** Settings-owned capture with no timer and no destination connection. */
export class MicrophonePreview {
  private readonly makeMic: () => MicPitch
  private readonly makeContext: () => AudioContext
  private readonly askAccess: () => Promise<boolean>
  private context: AudioContext | null = null
  private mic: MicPitch | null = null
  private generation = 0

  constructor(options: {
    makeMic?: () => MicPitch
    makeContext?: () => AudioContext
    askAccess?: () => Promise<boolean>
  } = {}) {
    this.makeMic = options.makeMic ?? (() => new MicPitch())
    this.makeContext = options.makeContext ?? (() => new AudioContext({ latencyHint: 'interactive' }))
    this.askAccess = options.askAccess ?? (() => window.singz.askMicAccess())
  }

  async start(options: { deviceId?: string; channelIndex?: number; onEnded?: () => void }): Promise<void> {
    this.stop()
    const generation = ++this.generation
    let allowed: boolean
    try {
      allowed = await this.askAccess()
    } catch (error) {
      // Permission prompts may settle out of order. Never surface a result
      // from an operation that was replaced while the prompt was open.
      this.assertCurrent(generation)
      throw error
    }
    this.assertCurrent(generation)
    if (!allowed) throw new MicPreviewError('permission')
    const context = this.makeContext()
    const mic = this.makeMic()
    try {
      await context.resume()
      this.assertCurrent(generation)
      await mic.start(context, options)
      this.assertCurrent(generation)
      this.context = context
      this.mic = mic
    } catch (error) {
      // Only tear down resources created by this operation. A newer start may
      // already own the preview fields by the time this catch runs.
      mic.stop()
      void context.close()
      throw error
    }
  }

  private assertCurrent(generation: number): void {
    if (this.generation !== generation) throw new Error('Microphone preview was cancelled.')
  }

  get active(): boolean { return this.mic?.active ?? false }
  get device(): MicDevice | null { return this.mic?.device ?? null }
  readLevel(): MicLevel { return this.mic?.readLevel() ?? { rms: 0, dbfs: -72, signal: false } }

  stop(): void {
    this.generation++
    this.mic?.stop()
    this.mic = null
    const context = this.context
    this.context = null
    if (context) void context.close()
  }
}

export class MicPreviewError extends Error {
  constructor(readonly kind: MicPreviewErrorKind) {
    super(kind === 'permission' ? 'Microphone access is blocked.' : 'Microphone preview failed.')
  }
}

export function micPreviewErrorKind(error: unknown): MicPreviewErrorKind {
  if (error instanceof MicPreviewError) return error.kind
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission'
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'unavailable'
  return 'unknown'
}

export function micPreviewErrorCopy(kind: MicPreviewErrorKind): string {
  if (kind === 'permission') return 'Microphone access is blocked. Allow SingZ in system privacy settings.'
  if (kind === 'busy') return 'The microphone is busy in another app. Close that app, then choose the input again.'
  if (kind === 'unavailable') return 'That microphone is not available. Reconnect it or choose another input.'
  return 'The microphone could not start. Check the device connection and try again.'
}
