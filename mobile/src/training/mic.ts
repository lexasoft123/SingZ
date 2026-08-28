import { AudioManager, AudioRecorder, type AudioBuffer } from 'react-native-audio-api'
import { Platform } from 'react-native'
import {
  frequencyToFractionalMidi,
  yinPitchInfo,
  type TrainingPitchObservation
} from '../gen/training-lib'
import {
  acquireAndroidAudioInputSession,
  androidAudioInputStats,
  listAndroidAudioInputs,
  subscribeAndroidAudioInputFrames,
  subscribeAndroidAudioInputState,
  type AndroidAudioInputFrame,
  type AndroidAudioInputDevice,
  type AndroidAudioInputLease,
  type AndroidAudioInputStats
} from '../android-audio-input-session'
import {
  acquireIosAudioInputSession,
  type IosAudioInputLease
} from '../ios-audio-input-session'
import { log } from '../log'

const SAMPLE_RATE = 16_000
const BUFFER_LENGTH = 1_024
const MAX_OBSERVATIONS = 512
/** yinPitchInfo's own gate, mirrored here so the screen and the log can say
 * WHY there is no note. Below it the detector reports frequency 0 and clarity
 * 0, which is exactly what a dead microphone reports — the two are
 * indistinguishable to a singer unless somebody publishes the level. */
const PITCH_GATE_RMS = 0.01
const PITCH_GATE_DBFS = -40
/** How long a capture may deliver nothing loud enough before it is written
 * down. A release APK has no inspector, so this line is the only evidence
 * that the microphone was open and heard nothing. */
const SILENCE_REPORT_MS = 3_000
/** How long a capture may deliver NO BLOCKS AT ALL before that is written
 * down. Measured on an Android phone: AAudio reported STARTED, never called
 * back, and the whole session produced not one log line — because every other
 * report here is driven by a block arriving. This one is driven by a timer, so
 * the silence reports itself. */
const NO_AUDIO_REPORT_MS = 3_000
/** A gap this long, after blocks HAVE been arriving, is capture dying
 * mid-session rather than starting dead — a different fault with the same
 * screen, and worth telling apart in a field log. */
const AUDIO_GAP_REPORT_MS = 1_500
const WATCHDOG_TICK_MS = 500

export interface TrainingMicSignal {
  /** Analysis blocks consumed since the last start. */
  readonly windows: number
  /** Of those, how many cleared the detector's RMS gate. */
  readonly voiced: number
  /** Loudest block so far, dBFS; null before the first one arrives. */
  readonly peakDbfs: number | null
  /** The most recent block's level, dBFS; null before the first one. */
  readonly dbfs: number | null
}

const dbfsFromRms = (rms: number): number =>
  rms > 0 && Number.isFinite(rms) ? Math.max(-120, 20 * Math.log10(rms)) : -120

/** One sentence a singer's shared log can be read from. */
export function describeTrainingMicSignal(signal: TrainingMicSignal): string {
  if (signal.windows === 0 || signal.peakDbfs === null)
    return 'no audio arrived from the microphone'
  return `${signal.windows} blocks · peak ${signal.peakDbfs.toFixed(1)} dBFS · ` +
    `${signal.voiced} above the ${PITCH_GATE_DBFS} dBFS pitch gate`
}

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
    stats?(): Promise<AndroidAudioInputStats | null>
    listInputs?(): Promise<AndroidAudioInputDevice[]>
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
          subscribeState: subscribeAndroidAudioInputState,
          stats: androidAudioInputStats,
          listInputs: listAndroidAudioInputs
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
  private windows = 0
  private voiced = 0
  private peakDbfs: number | null = null
  private lastDbfs: number | null = null
  private captureStartedMs: number | null = null
  private silenceReported = false
  private firstBlockMs: number | null = null
  private lastBlockMs: number | null = null
  private noAudioReported = false
  private gapReported = false
  private quality = { hardware: 0, 'callback-estimate': 0, unknown: 0 }
  private watchdog: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: TrainingMicDependencies = nativeDependencies) {}

  get live(): { readonly midi: number | null; readonly confidence: number; readonly timestampMs: number | null } {
    return { midi: this.latestMidi, confidence: this.latestConfidence, timestampMs: this.latestTimestampMs }
  }

  /** What the microphone is actually delivering. Without this the screen has
   * one word — "waiting" — for three different situations: no audio at all, a
   * stream of digital silence, and a real voice too quiet for the detector. */
  get signal(): TrainingMicSignal {
    return {
      windows: this.windows,
      voiced: this.voiced,
      peakDbfs: this.peakDbfs,
      dbfs: this.lastDbfs
    }
  }

  snapshot(): readonly TrainingPitchObservation[] {
    return this.observations.slice()
  }

  resetObservations(): void {
    this.observations = []
    this.latestMidi = null
    this.latestConfidence = 0
    this.latestTimestampMs = null
    // Deliberately NOT resetSignal(): the screen calls this while the previous
    // capture is still live (Replay, and every next prompt), and the counters
    // belong to that capture until its end-of-capture line is written. Wiping
    // them here made a healthy capture report "no audio arrived from the
    // microphone" — a false verdict on the one line that states the verdict.
    // Both start paths reset the signal themselves.
  }

  private resetSignal(): void {
    this.windows = 0
    this.voiced = 0
    this.peakDbfs = null
    this.lastDbfs = null
    this.silenceReported = false
    this.firstBlockMs = null
    this.lastBlockMs = null
    this.noAudioReported = false
    this.gapReported = false
    this.quality = { hardware: 0, 'callback-estimate': 0, unknown: 0 }
  }

  /** Every other report here is driven by a block ARRIVING, which is exactly
   * the event that goes missing in the fault worth catching. This timer is
   * what makes a capture that delivers nothing say so. */
  private startWatchdog(): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      const started = this.captureStartedMs
      if (started === null) return
      const now = Date.now()
      if (this.lastBlockMs === null) {
        if (this.noAudioReported || now - started < NO_AUDIO_REPORT_MS) return
        this.noAudioReported = true
        log(
          'mic',
          `no audio after ${((now - started) / 1000).toFixed(1)} s — capture is open and delivering nothing`,
          'warn'
        )
        return
      }
      if (this.gapReported || now - this.lastBlockMs < AUDIO_GAP_REPORT_MS) return
      this.gapReported = true
      log(
        'mic',
        `audio stopped arriving ${((now - this.lastBlockMs) / 1000).toFixed(1)} s ago · ` +
          describeTrainingMicSignal(this.signal),
        'warn'
      )
    }, WATCHDOG_TICK_MS)
    // A no-op on React Native, whose process never exits on an empty loop. It
    // matters under node: the screen's cleanup stops capture fire-and-forget,
    // so this timer can outlive a test that has already finished and hold the
    // worker open.
    ;(this.watchdog as unknown as { unref?: () => void }).unref?.()
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog)
    this.watchdog = null
  }

  /** Every consumed block passes through here, so the level is recorded once
   * for both capture paths. */
  private recordLevel(rms: number): void {
    const dbfs = dbfsFromRms(rms)
    const now = Date.now()
    this.windows++
    this.lastDbfs = dbfs
    if (this.firstBlockMs === null) {
      this.firstBlockMs = now
      if (this.captureStartedMs !== null)
        log(
          'mic',
          `first audio after ${now - this.captureStartedMs} ms · ${dbfs.toFixed(1)} dBFS`
        )
    } else if (this.gapReported && this.lastBlockMs !== null) {
      // Say so when it comes back, or the log ends on a scare that resolved.
      this.gapReported = false
      log('mic', `audio resumed after ${((now - this.lastBlockMs) / 1000).toFixed(1)} s`)
    }
    this.lastBlockMs = now
    if (this.peakDbfs === null || dbfs > this.peakDbfs) this.peakDbfs = dbfs
    if (rms >= PITCH_GATE_RMS) this.voiced++
    if (this.silenceReported || this.voiced > 0 || this.captureStartedMs === null) return
    if (Date.now() - this.captureStartedMs < SILENCE_REPORT_MS) return
    this.silenceReported = true
    log('mic', `nothing loud enough to read · ${describeTrainingMicSignal(this.signal)}`, 'warn')
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
      log('mic', `microphone permission is ${permission.toLowerCase()}`, 'warn')
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
      this.resetSignal()
      this.captureStartedMs = Date.now()
      log('mic', `listening · ${Platform.OS} recorder · ${SAMPLE_RATE} Hz · ${BUFFER_LENGTH}-frame blocks`)
      this.startWatchdog()
      return { ok: true }
    } catch (error) {
      const startError = error instanceof Error ? error.message : String(error)
      log('mic', `could not start · ${startError}`, 'error')
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
      // What Android offered, before we choose. Nothing in the app lets a
      // singer pick an input, so which endpoint the ranking landed on is a
      // question only the log can answer on somebody else's phone.
      await this.reportInputs(core)
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
        log('mic', `stopped by the system · ${state.error ?? 'no reason given'}`, 'error')
        onError(state.error || 'The microphone stopped. Tap Start to try again.')
        void this.stop()
      })
      this.resetSignal()
      this.captureStartedMs = Date.now()
      // Which endpoint Android actually gave us, and on what terms. Every
      // field here has been the answer to a "the mic does nothing" report on
      // some phone: the wrong device, a lane that carries no audio, a rate
      // nobody expected, a preset the vendor silently refused.
      log(
        'mic',
        `listening · ${lease.device.label} (${lease.device.transport}) · ` +
          `${lease.negotiated.sampleRate} Hz · channel ` +
          `${lease.negotiated.selectedChannel + 1}/${lease.negotiated.deviceChannels} · ` +
          `${lease.negotiated.sampleFormat} · ${lease.negotiated.sharingMode} · ` +
          `${lease.negotiated.performanceMode} · ${lease.negotiated.inputPreset}`
      )
      this.startWatchdog()
      return { ok: true }
    } catch (error) {
      await this.stopAndroidCore().catch(() => undefined)
      const message = error instanceof Error ? error.message : String(error)
      log('mic', `could not start · ${message}`, 'error')
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

  private async reportInputs(core: NonNullable<TrainingMicDependencies['androidCore']>): Promise<void> {
    const devices = await core.listInputs?.().catch(() => null)
    if (!devices) return
    if (devices.length === 0) {
      log('mic', 'Android offered no audio inputs at all', 'warn')
      return
    }
    const inventory = devices
      .map((device) =>
        `${device.label} (${device.transport}, ${device.channels}ch` +
        `${device.isPreferred ? ', chosen' : ''})`
      )
      .join(' · ')
    log('mic', `inputs · ${inventory}`)
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
    // The core re-anchors its analysis window whenever this flips, discarding
    // whatever it had buffered — so a high flip rate is a way for a healthy
    // stream to starve the detector. The tally is how a field log shows it.
    if (frame.timestampQuality in this.quality) this.quality[frame.timestampQuality]++
    this.recordLevel(frame.rms)
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
      this.recordLevel(frame.rms)
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
    await this.reportCaptureEnd()
    await this.stopAndroidCore()
    await this.stopRecorder(restorePlayback)
  }

  /** The one place a finished capture is written down. Teardown funnels
   * through stopCapture, so a session cannot end without leaving its level in
   * the log — which on a release build is the only place to read it.
   *
   * The native counters are read BEFORE teardown, and they are what separates
   * the two ways a capture delivers nothing: blocks of digital silence, or a
   * hardware callback that never fired at all. Only the second is the app's
   * problem, and from the level alone the two look identical. */
  private async reportCaptureEnd(): Promise<void> {
    this.stopWatchdog()
    if (this.captureStartedMs === null) return
    this.captureStartedMs = null
    const stats = await this.deps.androidCore?.stats?.().catch(() => null)
    const transport = stats
      ? ` · transport ${stats.deliveredBlocks} callbacks/${stats.deliveredFrames} frames, ` +
        `${stats.overruns} overruns, ${stats.wakeups} wakeups`
      : ''
    const q = this.quality
    const timestamps = q.hardware + q['callback-estimate'] + q.unknown > 0
      ? ` · timestamps ${q.hardware} hardware/${q['callback-estimate']} estimate/${q.unknown} unknown`
      : ''
    log('mic', `stopped · ${describeTrainingMicSignal(this.signal)}${transport}${timestamps}`)
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
