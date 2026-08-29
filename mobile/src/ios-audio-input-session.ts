import { NativeEventEmitter, NativeModules } from 'react-native'
import { AudioManager } from 'react-native-audio-api'

type Permission = 'Undetermined' | 'Denied' | 'Granted'

interface DevicesInfo {
  availableInputs?: Array<{ id: string }>
  currentInputs: Array<{ id: string }>
}

export interface IosAudioSessionOwner {
  checkRecordingPermissions(): Promise<Permission>
  requestRecordingPermissions(): Promise<Permission>
  setAudioSessionOptions(options: {
    iosCategory: 'playback' | 'playAndRecord'
    iosMode: 'default' | 'measurement'
    iosOptions?: Array<
      'allowBluetoothHFP' | 'allowBluetoothA2DP' | 'allowAirPlay' | 'defaultToSpeaker'
    >
  }): void
  setAudioSessionActivity(active: boolean): Promise<void>
  getDevicesInfo(): Promise<DevicesInfo>
  setInputDevice(deviceId: string): Promise<void>
}

type OwnedSessionOptions = Parameters<IosAudioSessionOwner['setAudioSessionOptions']>[0]

export interface IosAudioInputLeaseNative {
  prepareCapturePreferences(
    deviceUid: string,
    minimumChannels: number,
    lowLatencyBufferDuration: number,
    timeoutMilliseconds: number
  ): Promise<{ ok: boolean; token?: string; error?: string }>
  restoreCapturePreferences(token: string): Promise<void>
  abandonCapturePreferences(token: string): Promise<void>
  verifyCaptureSession(deviceUid: string, minimumChannels: number): Promise<void>
  verifyPlaybackSession(): Promise<void>
  acquireLease(deviceUid: string, minimumChannels: number): Promise<string>
  releaseLease(token: string): Promise<void>
  startCapture(
    leaseToken: string,
    deviceUid: string,
    channel: number,
    ownershipGeneration: number
  ): Promise<{ ok: boolean; error?: string; sampleRate?: number }>
  stopCapture(ownershipGeneration: number): Promise<void>
}

export interface IosAudioInputLease {
  /** Ownership generation stamped onto every zcore/zdsp frame. */
  readonly generation: number
  release(): Promise<void>
}

export interface IosAudioInputFrame {
  generation: number
  clockDomainId: string
  streamGeneration: string
  startSequence: string
  endSequence: string
  startSourceFrame: string
  endSourceFrame: string
  sampleHostTimeStartNs: string
  sampleHostTimeEndNs: string
  callbackHostTimeNs: string
  startFlags: number
  endFlags: number
  timestampQuality: 'hardware' | 'callback-estimate' | 'unknown'
  discontinuityReason: string
  resetCount: string
  sampleRate: number
  frequency: number
  clarity: number
  peak: number
  rms: number
  dbfs: number
}

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) &&
  value >= 0 && value <= 0xffff_ffff

/** Preserve all native flag bits. Known-bit policy belongs to the graph; the
 * scalar bridge only rejects values that cannot be an exact uint32. */
export const parseIosAudioInputFrame = (
  value: unknown
): IosAudioInputFrame | null => {
  if (!value || typeof value !== 'object') return null
  const frame = value as Partial<IosAudioInputFrame>
  return isUint32(frame.startFlags) && isUint32(frame.endFlags)
    ? value as IosAudioInputFrame
    : null
}

export interface IosAudioInputState {
  generation: number
  state: 'running' | 'stopped' | 'error'
  error?: string
}

export interface AcquireIosAudioInputOptions {
  /** Portable `ios:<AVAudioSession port UID>` selected by the user. */
  deviceUid?: string
  /** Zero-based input lane; channel 2 requests at least three hardware lanes. */
  channel?: number
  /** True only from the user gesture that is allowed to present the prompt. */
  requestPermission?: boolean
}

const playbackSession: OwnedSessionOptions = {
  iosCategory: 'playback',
  iosMode: 'default',
  iosOptions: []
}
const captureSession: OwnedSessionOptions = {
  iosCategory: 'playAndRecord',
  iosMode: 'measurement',
  iosOptions: [
    'allowBluetoothHFP',
    'allowBluetoothA2DP',
    'allowAirPlay',
    'defaultToSpeaker'
  ]
}

const lowLatencyBufferDuration = 0.005
const routeSettleTimeoutMilliseconds = 1500

const rawDeviceUid = (uid: string | undefined): string | undefined =>
  uid?.startsWith('ios:') ? uid.slice(4) : uid

const portableDeviceUid = (uid: string): string => `ios:${uid}`

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const acquisitionAndRestorationError = (
  acquisitionError: unknown,
  restorationError: unknown
): Error => {
  const combined = new Error(
    `${errorMessage(acquisitionError)}; cleaning up iOS audio input also failed: ${errorMessage(
      restorationError
    )}`
  )
  ;(combined as Error & { cause?: unknown }).cause = acquisitionError
  return combined
}

class IosAudioSessionRestoreError extends Error {
  constructor(
    messages: string[],
    readonly retryRequired: boolean
  ) {
    super(messages.join('; '))
  }
}

const restorationNeedsRetry = (error: unknown): boolean =>
  error instanceof IosAudioSessionRestoreError &&
  error.retryRequired

type SavedInputAvailability = 'present' | 'gone' | 'unknown'

const classifySavedInputAvailability = (
  devices: DevicesInfo,
  savedInput: string
): SavedInputAvailability => {
  if (devices.currentInputs.some(({ id }) => id === savedInput)) return 'present'
  if (!Array.isArray(devices.availableInputs)) return 'unknown'
  return devices.availableInputs.some(({ id }) => id === savedInput)
    ? 'present'
    : 'gone'
}

interface SessionContext {
  leaseToken?: string
  preferenceToken?: string
  previousInput?: string
  selectedInput?: string
  leaseReleased: boolean
  preferencesRestored: boolean
  inputRestored: boolean
  playbackTransitionAttempted: boolean
  playbackRestored: boolean
  captureGeneration?: number
  captureStopped: boolean
}

type CoordinatorState =
  | { kind: 'active'; context: SessionContext }
  | { kind: 'recovery'; context: SessionContext }

/**
 * Serializes temporary record-session ownership through AudioManager, the
 * same public owner used by SingZ playback. Native capture receives only a
 * read-only, generation-bound lease after configuration and route settlement.
 */
export class IosAudioInputSessionCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private state: CoordinatorState | null = null
  private nextCaptureGeneration = 1

  constructor(
    private readonly owner: IosAudioSessionOwner,
    private readonly native: IosAudioInputLeaseNative
  ) {}

  acquire(options: AcquireIosAudioInputOptions = {}): Promise<IosAudioInputLease> {
    return this.exclusive(async () => {
      if (this.state?.kind === 'recovery')
        throw new Error('The previous iOS audio session restoration must be retried')
      if (this.state) throw new Error('An iOS audio input session is already active')
      const channel = options.channel ?? 0
      if (!Number.isInteger(channel) || channel < 0)
        throw new Error('The iOS audio input channel must be a non-negative integer')
      const minimumChannels = channel + 1

      let permission = await this.owner.checkRecordingPermissions()
      if (permission === 'Undetermined' && options.requestPermission)
        permission = await this.owner.requestRecordingPermissions()
      if (permission !== 'Granted')
        throw new Error(
          permission === 'Denied'
            ? 'Microphone permission is denied'
            : 'Microphone permission must be requested from the vocal-training screen'
        )

      const context: SessionContext = {
        leaseReleased: false,
        preferencesRestored: false,
        inputRestored: false,
        playbackTransitionAttempted: false,
        playbackRestored: false,
        captureStopped: true
      }
      let transitionStarted = false
      try {
        // RNAudioAPI applies changed options with error:nil when its cached
        // session is active. Deactivate first so reactivation reports failure.
        transitionStarted = true
        await this.owner.setAudioSessionActivity(false)
        this.owner.setAudioSessionOptions(captureSession)
        await this.owner.setAudioSessionActivity(true)

        const devices = await this.owner.getDevicesInfo()
        context.previousInput = devices.currentInputs[0]?.id
        context.selectedInput = rawDeviceUid(options.deviceUid) ?? context.previousInput
        if (!context.selectedInput)
          throw new Error('iOS did not activate an input route')
        if (context.selectedInput !== context.previousInput)
          await this.owner.setInputDevice(context.selectedInput)

        const portableUid = portableDeviceUid(context.selectedInput)
        const prepared = await this.native.prepareCapturePreferences(
          portableUid,
          minimumChannels,
          lowLatencyBufferDuration,
          routeSettleTimeoutMilliseconds
        )
        context.preferenceToken = prepared.token
        if (!prepared.ok)
          throw new Error(prepared.error ?? 'Could not prepare iOS capture preferences')
        await this.native.verifyCaptureSession(portableUid, minimumChannels)
        context.leaseToken = await this.native.acquireLease(portableUid, minimumChannels)
        context.captureGeneration = this.nextCaptureGeneration++
        const started = await this.native.startCapture(
          context.leaseToken,
          portableUid,
          channel,
          context.captureGeneration
        )
        if (!started.ok)
          throw new Error(started.error ?? 'Could not start iOS audio input')
        context.captureStopped = false
        this.state = { kind: 'active', context }
      } catch (acquisitionError) {
        if (!transitionStarted) throw acquisitionError
        try {
          await this.restore(context)
          this.state = null
        } catch (restorationError) {
          this.state = restorationNeedsRetry(restorationError)
            ? { kind: 'recovery', context }
            : null
          throw acquisitionAndRestorationError(acquisitionError, restorationError)
        }
        throw acquisitionError
      }

      let released = false
      return {
        generation: context.captureGeneration,
        release: async (): Promise<void> => {
          if (released) return
          await this.exclusive(async () => {
            if (!this.state || this.state.context !== context) {
              released = true
              return
            }
            try {
              await this.restore(context)
              this.state = null
              released = true
            } catch (error) {
              if (restorationNeedsRetry(error))
                this.state = { kind: 'recovery', context }
              else {
                this.state = null
                released = true
              }
              throw error
            }
          })
        }
      }
    })
  }

  retryRelease(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.state) return
      if (this.state.kind !== 'recovery')
        throw new Error('The active iOS audio input lease must be released by its owner')
      const { context } = this.state
      try {
        await this.restore(context)
        this.state = null
      } catch (error) {
        if (!restorationNeedsRetry(error)) this.state = null
        throw error
      }
    })
  }

  private async restore(context: SessionContext): Promise<void> {
    const errors: string[] = []
    let restorationRetryRequired = false
    if (!context.captureStopped) {
      try {
        if (context.captureGeneration)
          await this.native.stopCapture(context.captureGeneration)
        context.captureStopped = true
      } catch (error) {
        // Native stop joins the AudioInput delivery thread. No session/route
        // owner may be released or mutated while that join is unconfirmed.
        throw new IosAudioSessionRestoreError(
          [`stop native capture: ${errorMessage(error)}`],
          true
        )
      }
    }
    if (!context.leaseReleased) {
      try {
        if (context.leaseToken) await this.native.releaseLease(context.leaseToken)
        context.leaseReleased = true
      } catch (error) {
        restorationRetryRequired = true
        errors.push(`release native lease: ${errorMessage(error)}`)
      }
    }

    const routeCleanupPending =
      !context.preferencesRestored || !context.inputRestored
    let routeCleanupReady = true
    if (context.playbackTransitionAttempted && routeCleanupPending) {
      // A prior finally-style restore has already attempted to move the
      // process-global session toward playback. Even if activation or the
      // read-only verification failed, category/options may have changed and
      // route-bound setters/availableInputs are no longer safe to assume.
      // Temporarily borrow capture mode for cleanup only.
      context.playbackRestored = false
      try {
        await this.reenterCaptureForCleanup(context)
      } catch (error) {
        routeCleanupReady = false
        restorationRetryRequired = true
        errors.push(`re-enter capture session for cleanup: ${errorMessage(error)}`)
      }
    }

    if (routeCleanupReady && !context.preferencesRestored) {
      if (context.preferenceToken) {
        try {
          await this.native.restoreCapturePreferences(context.preferenceToken)
          context.preferencesRestored = true
        } catch (error) {
          errors.push(`restore capture preferences: ${errorMessage(error)}`)
          try {
            await this.native.abandonCapturePreferences(context.preferenceToken)
            context.preferencesRestored = true
          } catch (abandonError) {
            restorationRetryRequired = true
            errors.push(
              `abandon obsolete capture preferences: ${errorMessage(abandonError)}`
            )
          }
        }
      } else {
        context.preferencesRestored = true
      }
    }
    if (routeCleanupReady && !context.inputRestored) {
      try {
        if (
          context.previousInput &&
          context.selectedInput &&
          context.selectedInput !== context.previousInput
        )
          await this.owner.setInputDevice(context.previousInput)
        context.inputRestored = true
      } catch (error) {
        errors.push(`restore previous input: ${errorMessage(error)}`)
        let availability: SavedInputAvailability = 'unknown'
        try {
          availability = classifySavedInputAvailability(
            await this.owner.getDevicesInfo(),
            context.previousInput ?? ''
          )
        } catch (classificationError) {
          errors.push(
            `classify previous input availability: ${errorMessage(
              classificationError
            )}`
          )
        }
        if (availability === 'gone') context.inputRestored = true
        else restorationRetryRequired = true
      }
    }

    let playbackTransitionFailed = false
    context.playbackTransitionAttempted = true
    try {
      await this.owner.setAudioSessionActivity(false)
    } catch (error) {
      playbackTransitionFailed = true
      errors.push(`deactivate capture session: ${errorMessage(error)}`)
    }
    try {
      this.owner.setAudioSessionOptions(playbackSession)
    } catch (error) {
      playbackTransitionFailed = true
      errors.push(`restore playback options: ${errorMessage(error)}`)
    }
    try {
      await this.owner.setAudioSessionActivity(true)
    } catch (error) {
      playbackTransitionFailed = true
      errors.push(`reactivate playback session: ${errorMessage(error)}`)
    }
    try {
      await this.native.verifyPlaybackSession()
    } catch (error) {
      playbackTransitionFailed = true
      errors.push(`verify restored playback: ${errorMessage(error)}`)
    }
    context.playbackRestored = !playbackTransitionFailed
    if (errors.length)
      throw new IosAudioSessionRestoreError(
        errors,
        restorationRetryRequired || playbackTransitionFailed
      )
  }

  private async reenterCaptureForCleanup(context: SessionContext): Promise<void> {
    await this.owner.setAudioSessionActivity(false)
    this.owner.setAudioSessionOptions(captureSession)
    await this.owner.setAudioSessionActivity(true)

    const devices = await this.owner.getDevicesInfo()
    if (!Array.isArray(devices.availableInputs))
      throw new Error('iOS input inventory is unavailable in capture mode')

    const selectedInput = context.selectedInput
    const selectedIsPresent =
      !!selectedInput &&
      devices.availableInputs.some(({ id }) => id === selectedInput)
    let currentInput = devices.currentInputs[0]?.id
    if (selectedInput && selectedIsPresent && currentInput !== selectedInput) {
      await this.owner.setInputDevice(selectedInput)
      currentInput = selectedInput
    }
    const currentIsPresent =
      !!currentInput &&
      devices.availableInputs.some(({ id }) => id === currentInput)
    if (!selectedIsPresent && !currentIsPresent && devices.availableInputs.length) {
      const fallbackInput =
        devices.availableInputs.find(({ id }) => id === context.previousInput)?.id ??
        devices.availableInputs[0].id
      await this.owner.setInputDevice(fallbackInput)
      currentInput = fallbackInput
    }

    // When the captured route is gone, another active input (normally the
    // previous built-in input) is sufficient to verify the exact temporary
    // capture category/mode/options. A known empty inventory is still useful:
    // native safe-abandon can conclusively classify the saved route as gone.
    const verificationInput = selectedIsPresent ? selectedInput : currentInput
    if (verificationInput)
      await this.waitForCleanupCaptureReadiness(verificationInput)
  }

  private async waitForCleanupCaptureReadiness(deviceUid: string): Promise<void> {
    const deadline = Date.now() + routeSettleTimeoutMilliseconds
    let lastError: unknown
    do {
      try {
        await this.native.verifyCaptureSession(portableDeviceUid(deviceUid), 1)
        return
      } catch (error) {
        lastError = error
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    } while (Date.now() <= deadline)
    throw new Error(
      `timed out waiting for the cleanup capture route: ${errorMessage(lastError)}`
    )
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

const nativeLease = NativeModules.AudioInputSession as IosAudioInputLeaseNative
const coordinator = new IosAudioInputSessionCoordinator(AudioManager, nativeLease)

export const acquireIosAudioInputSession = (
  options?: AcquireIosAudioInputOptions
): Promise<IosAudioInputLease> => coordinator.acquire(options)

export const retryIosAudioInputSessionRelease = (): Promise<void> =>
  coordinator.retryRelease()

export const subscribeIosAudioInputFrames = (
  callback: (frame: IosAudioInputFrame) => void
): (() => void) => {
  // RCTEventEmitter listener accounting drives startObserving/stopObserving;
  // subscribing through DeviceEventEmitter would leave the native module at
  // zero listeners and suppress its scalar capture events.
  const subscription = new NativeEventEmitter(
    NativeModules.AudioInputSession
  ).addListener(
    'singzAudioInputFrame',
    (value: unknown) => {
      const frame = parseIosAudioInputFrame(value)
      if (frame) callback(frame)
    }
  )
  return () => subscription.remove()
}

export const subscribeIosAudioInputState = (
  callback: (state: IosAudioInputState) => void
): (() => void) => {
  const subscription = new NativeEventEmitter(
    NativeModules.AudioInputSession
  ).addListener(
    'singzAudioInputState',
    callback
  )
  return () => subscription.remove()
}
