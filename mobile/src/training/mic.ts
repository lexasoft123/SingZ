import { AudioManager, AudioRecorder, type AudioBuffer } from 'react-native-audio-api'
import { Platform } from 'react-native'
import {
  frequencyToFractionalMidi,
  yinPitchInfo,
  type TrainingPitchObservation
} from '../gen/training-lib'
import {
  acquireAndroidAudioInputSession,
  subscribeAndroidAudioInputFrames,
  subscribeAndroidAudioInputState,
  type AndroidAudioInputFrame,
  type AndroidAudioInputLease
} from '../android-audio-input-session'
import {
  acquireIosAudioInputSession,
  type IosAudioInputLease
} from '../ios-audio-input-session'

const SAMPLE_RATE = 16_000
const BUFFER_LENGTH = 1_024
const MAX_OBSERVATIONS = 512

export type TrainingMicErrorKind = 'permission-denied' | 'unavailable' | 'interrupted'
export type TrainingMicResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: TrainingMicErrorKind; readonly error: string }

export interface TrainingMicDependencies {
  readonly permission: () => Promise<'Undetermined' | 'Denied' | 'Granted'>
  readonly requestPermission: () => Promise<'Undetermined' | 'Denied' | 'Granted'>
  readonly setSession: (recording: boolean) => Promise<void>
  readonly createRecorder: () => AudioRecorder
  readonly androidCore?: {
    acquire(): Promise<AndroidAudioInputLease>
    subscribeFrames(callback: (frame: AndroidAudioInputFrame) => void): () => void
    subscribeState(
      callback: (state: { generation: number; state: 'running' | 'stopped' | 'error'; error?: string }) => void
    ): () => void
  }
  readonly acquireIosLease?: () => Promise<IosAudioInputLease>
}

const nativeDependencies: TrainingMicDependencies = {
  permission: () => AudioManager.checkRecordingPermissions(),
  requestPermission: () => AudioManager.requestRecordingPermissions(),
  async setSession(recording) {
    AudioManager.setAudioSessionOptions(
      recording
        ? {
            iosCategory: 'playAndRecord',
            iosMode: 'measurement',
            iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP']
          }
        : { iosCategory: 'playback', iosMode: 'default' }
    )
    await AudioManager.setAudioSessionActivity(true)
  },
  createRecorder: () => new AudioRecorder(),
  androidCore:
    Platform.OS === 'android'
      ? {
          acquire: () =>
            acquireAndroidAudioInputSession({
              owner: 'vocal-training',
              requestPermission: true
            }),
          subscribeFrames: subscribeAndroidAudioInputFrames,
          subscribeState: subscribeAndroidAudioInputState
        }
      : undefined,
  acquireIosLease:
    Platform.OS === 'ios'
      ? () => acquireIosAudioInputSession({ requestPermission: false })
      : undefined
}

/** Generation-safe recorder owner. Late permission/start/stop completions can
 * never revive a capture belonging to a screen or prompt that has exited. */
export class TrainingMicrophone {
  private generation = 0
  private transition: Promise<void> = Promise.resolve()
  private recorder: AudioRecorder | null = null
  private androidLease: AndroidAudioInputLease | null = null
  private iosLease: IosAudioInputLease | null = null
  private unsubscribeAndroidFrames: (() => void) | null = null
  private unsubscribeAndroidState: (() => void) | null = null
  private nativeHostAnchorNs: bigint | null = null
  private nativeClockAnchorMs = 0
  private ownsRecordingSession = false
  private observations: TrainingPitchObservation[] = []
  private clockEpochMs: number | null = null
  private permissionPromptActive = false
  private cleanupError: string | null = null
  private latestMidi: number | null = null
  private latestConfidence = 0
  private latestTimestampMs: number | null = null

  constructor(private readonly deps: TrainingMicDependencies = nativeDependencies) {}

  get live(): { readonly midi: number | null; readonly confidence: number; readonly timestampMs: number | null } {
    return { midi: this.latestMidi, confidence: this.latestConfidence, timestampMs: this.latestTimestampMs }
  }

  snapshot(): readonly TrainingPitchObservation[] {
    return this.observations.slice()
  }

  resetObservations(): void {
    this.observations = []
    this.latestMidi = null
    this.latestConfidence = 0
    this.latestTimestampMs = null
  }

  isRequestingPermission(): boolean {
    return this.permissionPromptActive
  }

  start(clockNowMs: () => number, onError: (message: string) => void): Promise<TrainingMicResult> {
    const generation = ++this.generation
    return this.enqueue(() => this.startGeneration(generation, clockNowMs, onError))
  }

  stop(): Promise<void> {
    ++this.generation
    return this.enqueue(async () => {
      try {
        await this.stopCapture(true)
        this.cleanupError = null
      } catch (error) {
        // The native coordinators retain their lease after a failed release,
        // blocking overlap. Screen/background cleanup is often fire-and-forget,
        // so remember the failure for the next explicit Start instead of
        // leaking an unhandled rejection.
        this.cleanupError = cleanupMessage(error)
      }
      this.clockEpochMs = null
      this.latestMidi = null
      this.latestConfidence = 0
      this.latestTimestampMs = null
    })
  }

  private async startGeneration(
    generation: number,
    clockNowMs: () => number,
    onError: (message: string) => void
  ): Promise<TrainingMicResult> {
    try {
      await this.stopCapture(Boolean(this.deps.androidCore || this.deps.acquireIosLease))
      this.cleanupError = null
    } catch (error) {
      this.cleanupError = cleanupMessage(error)
      return { ok: false, kind: 'unavailable', error: this.cleanupError }
    }
    this.clockEpochMs = null
    if (this.deps.androidCore)
      return this.startAndroidCore(generation, clockNowMs, onError)
    let permission = await this.deps.permission().catch(() => 'Denied' as const)
    if (generation !== this.generation) return cancelled()
    if (permission === 'Undetermined') {
      this.permissionPromptActive = true
      try {
        permission = await this.deps.requestPermission().catch(() => 'Denied' as const)
      } finally {
        this.permissionPromptActive = false
      }
    }
    if (generation !== this.generation) return cancelled()
    if (permission !== 'Granted') {
      return {
        ok: false,
        kind: 'permission-denied',
        error: 'Microphone access is off. Allow it in Settings, then tap Start again.'
      }
    }

    try {
      if (this.deps.acquireIosLease) {
        this.iosLease = await this.deps.acquireIosLease()
      } else if (!this.ownsRecordingSession) {
        // Options are applied before native activation awaits. Claim first so
        // a rejected activation is still treated as a partial acquisition and
        // catch restores playback instead of leaving playAndRecord behind.
        this.ownsRecordingSession = true
        await this.deps.setSession(true)
      }
      if (generation !== this.generation) return cancelled()
      const recorder = this.deps.createRecorder()
      this.recorder = recorder
      this.observations = []
      recorder.onError(({ message }) => {
        if (generation !== this.generation) return
        onError(message || 'The microphone stopped. Tap Start to try again.')
        void this.stop()
      })
      const callback = recorder.onAudioReady(
        { sampleRate: SAMPLE_RATE, bufferLength: BUFFER_LENGTH, channelCount: 1 },
        ({ buffer, numFrames, when }) => this.consumeBuffer(buffer, numFrames, when, generation)
      )
      if (callback.status === 'error') throw new Error(callback.message || 'Could not read microphone audio.')
      const started = await recorder.start()
      if (started.status === 'error') throw new Error(started.message || 'Could not start the microphone.')
      if (generation !== this.generation) {
        await this.stopRecorder(true)
        return cancelled()
      }
      // Permission prompts and AudioRecorder.start may take seconds (and on
      // iOS can rebuild the shared audio engine). Anchor only after both have
      // succeeded; callbacks delivered before this point are released but do
      // not receive a fabricated old timestamp.
      this.clockEpochMs = clockNowMs()
      return { ok: true }
    } catch (error) {
      const startError = error instanceof Error ? error.message : String(error)
      try {
        await this.stopCapture(true)
        this.cleanupError = null
      } catch (cleanupError) {
        this.cleanupError = cleanupMessage(cleanupError)
        return {
          ok: false,
          kind: 'unavailable',
          error: `${startError}; ${this.cleanupError}`
        }
      }
      return {
        ok: false,
        kind: 'unavailable',
        error: startError
      }
    }
  }

  private async startAndroidCore(
    generation: number,
    clockNowMs: () => number,
    onError: (message: string) => void
  ): Promise<TrainingMicResult> {
    const core = this.deps.androidCore
    if (!core) return cancelled()
    this.permissionPromptActive = true
    try {
      const lease = await core.acquire()
      // Own the lease before checking cancellation. If its first release
      // fails, the normal latched teardown path must retain and retry it.
      this.androidLease = lease
      if (generation !== this.generation) {
        try {
          await this.stopAndroidCore()
          this.cleanupError = null
        } catch (error) {
          this.cleanupError = cleanupMessage(error)
        }
        return cancelled()
      }
      this.observations = []
      this.nativeHostAnchorNs = null
      this.nativeClockAnchorMs = clockNowMs()
      this.unsubscribeAndroidFrames = core.subscribeFrames((frame) => {
        if (generation !== this.generation || frame.generation !== lease.generation) return
        this.consumeAndroidFrame(frame, clockNowMs)
      })
      this.unsubscribeAndroidState = core.subscribeState((state) => {
        if (generation !== this.generation || state.generation !== lease.generation) return
        if (state.state !== 'error') return
        onError(state.error || 'The microphone stopped. Tap Start to try again.')
        void this.stop()
      })
      return { ok: true }
    } catch (error) {
      await this.stopAndroidCore().catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        kind: /permission/i.test(message) ? 'permission-denied' : 'unavailable',
        error: /permission/i.test(message)
          ? 'Microphone access is off. Allow it in Settings, then tap Start again.'
          : message
      }
    } finally {
      this.permissionPromptActive = false
    }
  }

  private consumeAndroidFrame(
    frame: AndroidAudioInputFrame,
    clockNowMs: () => number
  ): void {
    let midpoint: bigint
    try {
      midpoint = (BigInt(frame.sampleHostTimeStartNs) + BigInt(frame.sampleHostTimeEndNs)) / 2n
    } catch {
      return
    }
    if (this.nativeHostAnchorNs === null) {
      this.nativeHostAnchorNs = midpoint
      this.nativeClockAnchorMs = clockNowMs()
    }
    const timestampMs =
      this.nativeClockAnchorMs + Number(midpoint - this.nativeHostAnchorNs) / 1_000_000
    const frequencyHz = frame.frequency > 0 ? frame.frequency : 0
    const midi = frequencyToFractionalMidi(frequencyHz)
    const observation: TrainingPitchObservation = {
      timestampMs,
      frequencyHz,
      midi,
      confidence: frame.clarity
    }
    this.latestMidi = midi
    this.latestConfidence = frame.clarity
    this.latestTimestampMs = timestampMs
    this.observations.push(observation)
    if (this.observations.length > MAX_OBSERVATIONS)
      this.observations.splice(0, this.observations.length - MAX_OBSERVATIONS)
  }

  private consumeBuffer(buffer: AudioBuffer, numFrames: number, when: number, generation: number): void {
    try {
      const clockEpochMs = this.clockEpochMs
      if (generation !== this.generation || clockEpochMs === null) return
      const frame = yinPitchInfo(buffer.getChannelData(0), SAMPLE_RATE)
      const frequencyHz = frame.f0 > 0 ? frame.f0 : 0
      const midi = frequencyToFractionalMidi(frequencyHz)
      const observation: TrainingPitchObservation = {
        timestampMs: clockEpochMs + when * 1000 + (numFrames / SAMPLE_RATE) * 500,
        frequencyHz,
        midi,
        confidence: frame.clarity
      }
      this.latestMidi = midi
      this.latestConfidence = frame.clarity
      this.latestTimestampMs = observation.timestampMs
      this.observations.push(observation)
      if (this.observations.length > MAX_OBSERVATIONS)
        this.observations.splice(0, this.observations.length - MAX_OBSERVATIONS)
    } finally {
      // AudioBuffer is a host object owning native PCM. Hermes GC is far too
      // late for a continuous callback, so every block is returned immediately.
      const host = (buffer as unknown as { buffer?: { release?: () => void } }).buffer
      host?.release?.()
    }
  }

  private async stopRecorder(restorePlayback: boolean): Promise<void> {
    const recorder = this.recorder
    this.recorder = null
    if (recorder) {
      recorder.clearOnAudioReady()
      recorder.clearOnError()
      recorder.disconnect()
      if (recorder.isRecording()) await recorder.stop().catch(() => undefined)
    }
    if (restorePlayback && this.iosLease) {
      const lease = this.iosLease
      await lease.release()
      this.iosLease = null
    } else if (restorePlayback && this.ownsRecordingSession) {
      // Relinquish ownership before the await. A queued second stop is then
      // idempotent even when native session restoration itself is slow.
      this.ownsRecordingSession = false
      await this.deps.setSession(false).catch(() => undefined)
    }
  }

  private async stopAndroidCore(): Promise<void> {
    this.unsubscribeAndroidFrames?.()
    this.unsubscribeAndroidFrames = null
    this.unsubscribeAndroidState?.()
    this.unsubscribeAndroidState = null
    const lease = this.androidLease
    if (lease) {
      await lease.release()
      if (this.androidLease === lease) this.androidLease = null
    }
    this.nativeHostAnchorNs = null
  }

  private async stopCapture(restorePlayback: boolean): Promise<void> {
    await this.stopAndroidCore()
    await this.stopRecorder(restorePlayback)
  }

  /** One lane owns recorder and audio-session transitions. In particular, a
   * slow old stop must restore playback before—not underneath—a new capture. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation)
    this.transition = next.then(() => undefined, () => undefined)
    return next
  }
}

function cancelled(): TrainingMicResult {
  return { ok: false, kind: 'interrupted', error: 'Microphone start was cancelled.' }
}

function cleanupMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `The previous microphone session could not close cleanly: ${detail}. Tap Start to retry.`
}
