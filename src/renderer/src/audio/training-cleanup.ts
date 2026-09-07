export type TrainingCleanupPhase = 'idle' | 'stopping' | 'unsafe'

export const TRAINING_CLEANUP_SONG_BLOCKED_COPY =
  'Song playback is unavailable until Vocal training confirms that its microphone and exercise audio stopped. Retry cleanup in Vocal training.'

export const TRAINING_CLEANUP_SETTINGS_BLOCKED_COPY =
  'Audio settings are unavailable until Vocal training confirms that its microphone and exercise audio stopped. Retry cleanup in Vocal training.'

export const TRAINING_CLEANUP_AUDIO_BLOCKED_COPY =
  'Vocal training audio is unavailable while its previous microphone and exercise audio cleanup is unresolved. Retry cleanup before continuing.'

export type TrainingExitAction = () => void | Promise<void>

interface PendingTrainingExit {
  readonly run: TrainingExitAction
  readonly cancel?: () => void
}

export async function confirmTrainingAudioStopped(owners: {
  readonly pauseSong: () => void
  readonly cancelCues: () => void
  readonly stopMicrophone: () => Promise<void>
  readonly clearMicrophoneDevice: () => void
  readonly interruptTraining: () => void
  /** Coordinator generation guard. Native release still finishes after app
   * teardown, but its late continuation must not mutate the dead renderer. */
  readonly stillOwned?: () => boolean
}): Promise<void> {
  let firstError: unknown = null
  try { owners.pauseSong() } catch (error) { firstError = error }
  try { owners.cancelCues() } catch (error) { firstError ??= error }
  try { owners.interruptTraining() } catch (error) { firstError ??= error }
  try {
    await owners.stopMicrophone()
    if (owners.stillOwned?.() !== false) owners.clearMicrophoneDevice()
  } catch (error) {
    firstError ??= error
  }
  if (firstError) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Training audio cleanup could not be confirmed.')
  }
}

/**
 * App-lifetime fail-closed owner for training cleanup. Route UI may disappear
 * or fail, but this coordinator retains the cleanup verdict and the latest
 * requested exit until microphone release is positively confirmed.
 */
export class TrainingCleanupCoordinator {
  private readonly listeners = new Set<(phase: TrainingCleanupPhase) => void>()
  private readonly cleanup: (stillOwned: () => boolean) => Promise<void>
  private currentPhase: TrainingCleanupPhase = 'idle'
  private pendingExit: PendingTrainingExit | null = null
  private cleanupGeneration = 0
  private currentCleanup: Promise<boolean> | null = null
  private disposed = false

  constructor(cleanup: (stillOwned: () => boolean) => Promise<void>) {
    this.cleanup = cleanup
  }

  get phase(): TrainingCleanupPhase {
    return this.currentPhase
  }

  get blocksAudio(): boolean {
    return this.disposed || this.currentPhase !== 'idle'
  }

  subscribe(listener: (phase: TrainingCleanupPhase) => void): () => void {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Start cleanup without leaving Training, for a loaded route runtime fault. */
  requestCleanup(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.currentPhase === 'idle') return this.startCleanup()
    if (this.currentPhase === 'stopping' && this.currentCleanup) return this.currentCleanup
    return Promise.resolve(false)
  }

  /** Keep the most recent destination intent while one single cleanup runs.
   * Replacing an awaiting continuation releases it without running it. */
  requestExit(action: TrainingExitAction, onCancel?: () => void): void {
    if (this.disposed) return
    try { this.pendingExit?.cancel?.() } catch { /* cancellation still wins */ }
    this.pendingExit = { run: action, cancel: onCancel }
    if (this.currentPhase === 'idle') this.startCleanup()
  }

  /** Replace the retained destination with "stay in Training". Native cleanup
   * continues, but its eventual success (or a later retry) must not execute a
   * destination the singer explicitly cancelled. */
  cancelPendingExit(): void {
    if (this.disposed) return
    const exit = this.pendingExit
    this.pendingExit = null
    try { exit?.cancel?.() } catch { /* cancellation still wins */ }
  }

  retry(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.currentPhase === 'unsafe') return this.startCleanup()
    if (this.currentPhase === 'stopping' && this.currentCleanup) return this.currentCleanup
    return Promise.resolve(this.currentPhase === 'idle')
  }

  private publish(phase: TrainingCleanupPhase): void {
    if (this.disposed) return
    if (phase === this.currentPhase) return
    this.currentPhase = phase
    for (const listener of this.listeners) {
      try { listener(phase) } catch { /* view failure cannot release the lease */ }
    }
  }

  private startCleanup(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.currentPhase === 'stopping' && this.currentCleanup) return this.currentCleanup
    const generation = ++this.cleanupGeneration
    this.publish('stopping')
    let cleanup: Promise<void>
    const stillOwned = (): boolean => !this.disposed && generation === this.cleanupGeneration
    try { cleanup = this.cleanup(stillOwned) } catch (error) { cleanup = Promise.reject(error) }
    const operation = cleanup.then(() => {
      if (!stillOwned()) return false
      this.publish('idle')
      const exit = this.pendingExit
      this.pendingExit = null
      if (exit) {
        try { void Promise.resolve(exit.run()).catch(() => undefined) } catch { /* cleanup is still safe */ }
      }
      return true
    }, () => {
      if (!stillOwned()) return false
      this.publish('unsafe')
      return false
    })
    this.currentCleanup = operation
    void operation.then(() => {
      if (this.currentCleanup === operation) this.currentCleanup = null
    })
    return operation
  }

  /** Renderer-lifetime teardown. The native stop is deliberately allowed to
   * settle, but every renderer continuation and retained destination is dead. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cleanupGeneration++
    this.pendingExit = null
    this.currentCleanup = null
    this.listeners.clear()
  }
}

/** Shared by nav buttons and programmatic section switches. `true` means the
 * request was either already current or is retained behind cleanup. */
export function queueTrainingSectionExit<Section extends string>(
  current: Section,
  target: Section,
  trainingSection: Section,
  coordinator: TrainingCleanupCoordinator,
  apply: (section: Section) => void,
  invalidateRetainedWork?: () => void
): boolean {
  if (target === current) {
    if (current === trainingSection && coordinator.phase !== 'idle') {
      invalidateRetainedWork?.()
      coordinator.cancelPendingExit()
    }
    return true
  }
  if (current !== trainingSection) return false
  coordinator.requestExit(() => apply(target))
  return true
}

/** Await the app-owned cleanup without minting a new song-load request. The
 * caller's closure keeps the original accepted request token authoritative. */
export function awaitTrainingCleanupExit(
  coordinator: TrainingCleanupCoordinator,
  isStillAccepted: () => boolean,
  onConfirmed: () => void
): Promise<boolean> {
  if (!isStillAccepted()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    if (!isStillAccepted()) {
      resolve(false)
      return
    }
    coordinator.requestExit(() => {
      if (!isStillAccepted()) {
        resolve(false)
        return
      }
      onConfirmed()
      resolve(true)
    }, () => resolve(false))
  })
}
