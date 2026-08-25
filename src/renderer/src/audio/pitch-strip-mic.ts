import { MicPitch, type MicDevice } from './mic'

export type PitchStripMicState = 'off' | 'starting' | 'on' | 'denied'

export interface PitchStripMicRoute {
  readonly deviceId?: string
  readonly channelIndex?: number
}

interface PitchStripMicOwnerOptions {
  readonly context: AudioContext
  readonly askAccess: () => Promise<boolean>
  readonly makeMic?: () => MicPitch
  readonly onChange: (state: PitchStripMicState, mic: MicPitch | null) => void
  readonly onDevice: (device: MicDevice | null) => void
}

/**
 * Owns the pitch strip's async capture operations. Every requested route gets
 * a generation; a late permission prompt or getUserMedia result can therefore
 * only stop its own MicPitch, never replace the newest route.
 */
export class PitchStripMicOwner {
  private readonly context: AudioContext
  private readonly askAccess: () => Promise<boolean>
  private readonly makeMic: () => MicPitch
  private readonly onChange: PitchStripMicOwnerOptions['onChange']
  private readonly onDevice: PitchStripMicOwnerOptions['onDevice']
  private route: PitchStripMicRoute
  private mic: MicPitch | null = null
  private state: PitchStripMicState = 'off'
  private generation = 0
  private desired = false
  private suspended = false
  private permissionGranted = false
  private permissionPending = false
  private disposed = false

  constructor(options: PitchStripMicOwnerOptions, route: PitchStripMicRoute) {
    this.context = options.context
    this.askAccess = options.askAccess
    this.makeMic = options.makeMic ?? (() => new MicPitch())
    this.onChange = options.onChange
    this.onDevice = options.onDevice
    this.route = route
  }

  get current(): MicPitch | null { return this.mic }
  get status(): PitchStripMicState { return this.state }

  toggle(): void {
    if (this.disposed || this.suspended) return
    // A second click delivered before React paints disabled="true" must not
    // launch another permission prompt or cancel the intended start.
    if (this.desired && this.state === 'starting') return
    if (this.desired || this.mic?.active) {
      this.stop()
      return
    }
    this.desired = true
    ++this.generation
    this.publish('starting', null)
    void this.requestAccessAndStart()
  }

  setRoute(route: PitchStripMicRoute): void {
    if (sameRoute(route, this.route)) return
    this.route = route
    const restart = this.desired
    const generation = ++this.generation
    this.stopOwnedMic()
    if (!restart || this.disposed) {
      this.desired = false
      this.publish('off', null)
      return
    }
    if (this.suspended) {
      this.publish('off', null)
      return
    }
    this.publish('starting', null)
    if (this.permissionGranted) void this.begin(generation, route, 'off')
  }

  /** Give Settings exclusive ownership, then restore the exact latest route. */
  setSuspended(suspended: boolean): void {
    if (suspended === this.suspended || this.disposed) return
    this.suspended = suspended
    const generation = ++this.generation
    this.stopOwnedMic()
    if (suspended || !this.desired) {
      this.publish('off', null)
      return
    }
    this.publish('starting', null)
    if (this.permissionGranted) {
      const route = this.route
      // Let the closing Settings layout cleanup release its preview before
      // getUserMedia is requested again, even if React visits this sibling's
      // layout effect first during the same commit.
      queueMicrotask(() => {
        if (this.owns(generation, route)) void this.begin(generation, route, 'off')
      })
    }
  }

  /** Background capture is not resumed implicitly: the singer opts in again. */
  suspend(): void { this.stop() }

  stop(): void {
    this.desired = false
    this.generation++
    this.stopOwnedMic()
    this.publish('off', null)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
  }

  private async requestAccessAndStart(): Promise<void> {
    if (this.permissionPending) return
    this.permissionPending = true
    let allowed = false
    try {
      allowed = await this.askAccess()
    } catch {
      allowed = false
    } finally {
      this.permissionPending = false
    }
    if (this.disposed || !this.desired) return
    if (!allowed) {
      this.desired = false
      this.publish('denied', null)
      return
    }
    this.permissionGranted = true
    if (this.suspended) return
    const generation = ++this.generation
    void this.begin(generation, this.route, 'denied')
  }

  private async begin(
    generation: number,
    route: PitchStripMicRoute,
    failureState: 'off' | 'denied'
  ): Promise<void> {
    let mic: MicPitch | null = null
    try {
      if (!this.owns(generation, route)) return
      mic = this.makeMic()
      await mic.start(this.context, {
        deviceId: route.deviceId,
        channelIndex: route.channelIndex,
        onEnded: () => {
          if (!this.owns(generation, route) || this.mic !== mic) return
          this.mic = null
          this.desired = false
          this.generation++
          this.publish('off', null)
        }
      })
      if (!this.owns(generation, route)) {
        mic.stop()
        return
      }
      this.stopOwnedMic()
      this.mic = mic
      this.publish('on', mic)
      this.onDevice(mic.device)
    } catch {
      mic?.stop()
      if (!this.owns(generation, route)) return
      this.desired = false
      this.publish(failureState, null)
    }
  }

  private owns(generation: number, route: PitchStripMicRoute): boolean {
    return !this.disposed && !this.suspended && this.desired && generation === this.generation && sameRoute(route, this.route)
  }

  private stopOwnedMic(): void {
    this.mic?.stop()
    this.mic = null
    this.onDevice(null)
  }

  private publish(state: PitchStripMicState, mic: MicPitch | null): void {
    this.state = state
    this.onChange(state, mic)
    if (!mic) this.onDevice(null)
  }
}

function sameRoute(a: PitchStripMicRoute, b: PitchStripMicRoute): boolean {
  return a.deviceId === b.deviceId && (a.channelIndex ?? 0) === (b.channelIndex ?? 0)
}
