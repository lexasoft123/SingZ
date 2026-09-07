import { MicPitch, type MicDevice, type MicLevel } from './mic'
import { NativeTrainingMicSource } from './training-mic'

export type MicPreviewErrorKind = 'permission' | 'busy' | 'unavailable' | 'unknown'

/** Settings-owned capture with no timer and no destination connection. */
export class MicrophonePreview {
  private readonly makeMic: () => MicPitch | NativeTrainingMicSource
  private readonly makeContext: () => AudioContext
  private readonly askAccess: () => Promise<boolean>
  private context: AudioContext | null = null
  private mic: MicPitch | NativeTrainingMicSource | null = null
  private generation = 0
  private stopPending: Promise<void> | null = null
  private readonly startsPending = new Set<Promise<void>>()
  private readonly retainedCleanup: Array<{
    mic: MicPitch | NativeTrainingMicSource
    context: AudioContext
  }> = []

  constructor(options: {
    makeMic?: () => MicPitch | NativeTrainingMicSource
    makeContext?: () => AudioContext
    askAccess?: () => Promise<boolean>
  } = {}) {
    this.makeMic = options.makeMic ?? (() => new NativeTrainingMicSource())
    this.makeContext = options.makeContext ?? (() => new AudioContext({ latencyHint: 'interactive' }))
    this.askAccess = options.askAccess ?? (() => window.singz.askMicAccess())
  }

  async start(options: {
    deviceId?: string
    nativeDeviceUid?: string
    channelIndex?: number
    onEnded?: () => void
  }): Promise<void> {
    const generation = ++this.generation
    if (
      this.stopPending || this.mic || this.context || this.retainedCleanup.length > 0
    ) await this.stopOwned()
    this.assertCurrent(generation)
    let operation!: Promise<void>
    operation = this.startFresh(generation, options).finally(() => {
      this.startsPending.delete(operation)
    })
    this.startsPending.add(operation)
    return operation
  }

  private async startFresh(generation: number, options: {
    deviceId?: string
    nativeDeviceUid?: string
    channelIndex?: number
    onEnded?: () => void
  }): Promise<void> {
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
      // already own the preview fields by the time this catch runs. If native
      // stop is not confirmed, retain this exact local owner for stopAndWait;
      // dropping it would also drop the only IPC token able to retry teardown.
      const owner = { mic, context }
      try {
        await this.stopCleanupOwner(owner)
      } catch {
        if (!this.retainedCleanup.includes(owner)) this.retainedCleanup.push(owner)
      }
      throw error
    }
  }

  private assertCurrent(generation: number): void {
    if (this.generation !== generation) throw new Error('Microphone preview was cancelled.')
  }

  get active(): boolean {
    return (this.mic?.active ?? false) || this.retainedCleanup.some(({ mic }) => mic.active)
  }
  get device(): MicDevice | null { return this.mic?.device ?? null }
  readLevel(): MicLevel { return this.mic?.readLevel() ?? { rms: 0, dbfs: -72, signal: false } }

  stop(): void {
    this.generation++
    void this.stopOwned().catch(() => {
      // A later stopAndWait/start retries the retained owner. Fire-and-forget
      // UI cleanup must never become an unhandled rejection.
    })
  }

  private async stopOwned(): Promise<void> {
    if (this.stopPending) return this.stopPending
    const operation = (async (): Promise<void> => {
      if (this.startsPending.size > 0) {
        await Promise.allSettled([...this.startsPending])
      }
      for (const owner of [...this.retainedCleanup]) {
        await this.stopCleanupOwner(owner)
        const index = this.retainedCleanup.indexOf(owner)
        if (index >= 0) this.retainedCleanup.splice(index, 1)
      }
      const mic = this.mic
      const context = this.context
      if (mic || context) {
        if (mic) await Promise.resolve(mic.stop())
        if (context) await context.close()
        if (this.mic === mic) this.mic = null
        if (this.context === context) this.context = null
      }
    })()
    this.stopPending = operation
    try {
      await operation
    } finally {
      if (this.stopPending === operation) this.stopPending = null
    }
  }

  async stopAndWait(): Promise<void> {
    this.generation++
    await this.stopOwned()
  }

  private async stopCleanupOwner(owner: {
    mic: MicPitch | NativeTrainingMicSource
    context: AudioContext
  }): Promise<void> {
    await Promise.resolve(owner.mic.stop())
    await owner.context.close()
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
