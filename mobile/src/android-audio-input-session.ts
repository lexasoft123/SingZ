import {
  DeviceEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform
} from 'react-native'

export interface AndroidAudioInputDevice {
  uid: string
  label: string
  channels: number
  channelLabels: string[]
  sampleRate: number
  /** SingZ fallback preference, not a claim about Android's active/default input. */
  isPreferred: boolean
  transport:
    | 'built-in'
    | 'wired'
    | 'usb'
    | 'bluetooth-sco'
    | 'bluetooth-le'
    | 'hearing-aid'
    | 'automotive'
    | 'other'
  highLatency: boolean
  note?: string
}

export interface AndroidAudioInputFrame {
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
  discontinuityReason:
    | 'none'
    | 'stream-generation'
    | 'sequence-gap'
    | 'sample-rate'
    | 'timestamp-quality'
    | 'clock-reanchored'
    | 'device-lost'
    | 'source-frame-overflow'
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
export const parseAndroidAudioInputFrame = (
  value: unknown
): AndroidAudioInputFrame | null => {
  if (!value || typeof value !== 'object') return null
  const frame = value as Partial<AndroidAudioInputFrame>
  return isUint32(frame.startFlags) && isUint32(frame.endFlags)
    ? value as AndroidAudioInputFrame
    : null
}

export interface AndroidAudioInputState {
  generation: number
  state: 'running' | 'stopped' | 'error'
  error?: string
}

export interface AndroidAudioInputNative {
  listInputs(): Promise<AndroidAudioInputDevice[]>
  start(
    owner: string,
    deviceUid: string,
    channel: number
  ): Promise<{
    ok: boolean
    error?: string
    generation?: number
    deviceUid?: string
    sampleRate?: number
    deviceChannels?: number
    selectedChannel?: number
    sampleFormat?: string
    sharingMode?: string
    performanceMode?: string
    inputPreset?: string
    timestampSource?: string
  }>
  stop(owner: string, generation: number): Promise<boolean>
}

export interface AndroidMicrophonePermission {
  check(): Promise<boolean>
  request(): Promise<boolean>
}

export interface AndroidAudioInputLease {
  readonly generation: number
  readonly device: AndroidAudioInputDevice
  readonly channel: number
  readonly negotiated: AndroidAudioInputNegotiated
  release(): Promise<void>
  /** Retry a failed native stop. New acquisitions remain blocked until this succeeds. */
  retryRelease(): Promise<void>
}

export interface AndroidAudioInputNegotiated {
  deviceUid: string
  sampleRate: number
  deviceChannels: number
  selectedChannel: number
  sampleFormat: string
  sharingMode: string
  performanceMode: string
  /** `*-verified`, `*-requested-unverified`, or `*-default-unverified`. */
  inputPreset: string
  timestampSource: string
}

export interface AcquireAndroidAudioInputOptions {
  owner?: string
  deviceUid?: string
  channel?: number
  /** True only from the button press allowed to show Android's prompt. */
  requestPermission?: boolean
}

type StateSubscriber = (callback: (state: AndroidAudioInputState) => void) => () => void

interface ActiveLease {
  owner: string
  generation: number
  released: boolean
}

/**
 * Serial owner above the Kotlin/native one-owner guard. It requests no route,
 * mode, audio focus, or playback-session mutation; AudioManager remains owned
 * by react-native-audio-api. Permission can only be requested when the caller
 * explicitly marks a user-initiated acquisition.
 */
export class AndroidAudioInputSessionCoordinator {
  private tail: Promise<void> = Promise.resolve()
  private active: ActiveLease | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly native: AndroidAudioInputNative,
    private readonly permission: AndroidMicrophonePermission,
    subscribeState: StateSubscriber = () => () => undefined
  ) {
    this.unsubscribe = subscribeState((state) => {
      const active = this.active
      if (!active || active.generation !== state.generation) return
      if (state.state === 'error' || state.state === 'stopped') {
        active.released = true
        this.active = null
      }
    })
  }

  listInputs(): Promise<AndroidAudioInputDevice[]> {
    return this.native.listInputs()
  }

  acquire(options: AcquireAndroidAudioInputOptions = {}): Promise<AndroidAudioInputLease> {
    return this.exclusive(async () => {
      if (this.active) throw new Error('An Android audio input session is already active')
      const owner = options.owner?.trim() || 'vocal-training'
      const channel = options.channel ?? 0
      if (!Number.isInteger(channel) || channel < 0)
        throw new Error('The Android audio input channel must be a non-negative integer')

      let granted = await this.permission.check()
      if (!granted && options.requestPermission) granted = await this.permission.request()
      if (!granted)
        throw new Error(
          options.requestPermission
            ? 'Microphone permission is denied'
            : 'Microphone permission must be requested from the vocal-training screen'
        )

      const devices = await this.native.listInputs()
      const device = options.deviceUid
        ? devices.find((candidate) => candidate.uid === options.deviceUid)
        : devices.find((candidate) => candidate.isPreferred) ?? devices[0]
      if (!device) throw new Error('No Android audio input is available')
      if (channel >= device.channels)
        throw new Error(`Channel ${channel + 1} is unavailable on ${device.label}`)

      const started = await this.native.start(owner, device.uid, channel)
      if (!started.ok || !Number.isInteger(started.generation))
        throw new Error(started.error ?? 'Android audio input could not start')
      const negotiated: AndroidAudioInputNegotiated = {
        deviceUid: started.deviceUid ?? '',
        sampleRate: started.sampleRate ?? 0,
        deviceChannels: started.deviceChannels ?? 0,
        selectedChannel: started.selectedChannel ?? -1,
        sampleFormat: started.sampleFormat ?? '',
        sharingMode: started.sharingMode ?? '',
        performanceMode: started.performanceMode ?? '',
        inputPreset: started.inputPreset ?? '',
        timestampSource: started.timestampSource ?? ''
      }
      // Kotlin validates this contract before returning ok. Keep the actual
      // facts intact here rather than replacing them with inventory guesses.
      const context = { owner, generation: started.generation as number, released: false }
      this.active = context
      const stop = async (): Promise<void> => {
        await this.exclusive(async () => {
          if (context.released) return
          if (this.active !== context)
            throw new Error('This Android audio input lease is no longer current')
          // Keep the ownership latch until native positively confirms stop.
          // A rejection or false result leaves the lease recoverable and blocks
          // a new capture instead of risking two native owners.
          const stopped = await this.native.stop(context.owner, context.generation)
          if (context.released) return // native state event confirmed teardown
          if (!stopped)
            throw new Error('Android audio input did not confirm that capture stopped')
          context.released = true
          this.active = null
        })
      }
      return {
        generation: context.generation,
        device,
        channel,
        negotiated,
        release: stop,
        retryRelease: stop
      }
    })
  }

  dispose(): void {
    this.unsubscribe()
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

const productionPermission: AndroidMicrophonePermission = {
  check: async () =>
    Platform.OS === 'android' &&
    PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO),
  request: async () =>
    Platform.OS === 'android' &&
    (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO)) ===
      PermissionsAndroid.RESULTS.GRANTED
}

const subscribeState: StateSubscriber = (callback) => {
  const subscription = DeviceEventEmitter.addListener('singzAudioInputState', callback)
  return () => subscription.remove()
}

let productionCoordinator: AndroidAudioInputSessionCoordinator | null = null
const coordinator = (): AndroidAudioInputSessionCoordinator => {
  if (!productionCoordinator)
    productionCoordinator = new AndroidAudioInputSessionCoordinator(
      NativeModules.AudioInput as AndroidAudioInputNative,
      productionPermission,
      subscribeState
    )
  return productionCoordinator
}

export const listAndroidAudioInputs = (): Promise<AndroidAudioInputDevice[]> =>
  coordinator().listInputs()

export const acquireAndroidAudioInputSession = (
  options?: AcquireAndroidAudioInputOptions
): Promise<AndroidAudioInputLease> => coordinator().acquire(options)

export const subscribeAndroidAudioInputFrames = (
  callback: (frame: AndroidAudioInputFrame) => void
): (() => void) => {
  const subscription = DeviceEventEmitter.addListener(
    'singzAudioInputFrame',
    (value: unknown) => {
      const frame = parseAndroidAudioInputFrame(value)
      if (frame) callback(frame)
    }
  )
  return () => subscription.remove()
}

export const subscribeAndroidAudioInputState = (
  callback: (state: AndroidAudioInputState) => void
): (() => void) => subscribeState(callback)
