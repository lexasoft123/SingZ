import type {
  DesktopMonitorConfig,
  DesktopMonitorResult,
  DesktopMonitorStatus,
  SingzApi
} from '../../../shared/types'

export type MonitorCoordinatorPhase =
  | 'idle'
  | 'preparing'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'error'

export interface MonitorCoordinatorSnapshot {
  phase: MonitorCoordinatorPhase
  message: string
  result: DesktopMonitorResult | null
  status: DesktopMonitorStatus | null
}

/** Change-gated app-shell state. Detailed meters/counters stay on the Settings
 * subscription so native telemetry does not repaint the whole application. */
export interface MonitorShellSnapshot {
  phase: MonitorCoordinatorPhase
  message: string
  hasNativeOwnership: boolean
  hasAudioSafetyLease: boolean
  hasRouteTransitionLease: boolean
  hasPreviewLease: boolean
  hasUnresolvedPreviewLease: boolean
}

export type AudioSafetyLeaseKind =
  | 'none'
  | 'app-shell-stop'
  | 'route-only'
  | 'settings-preview'
  | 'unknown'

export const AUDIO_ROUTE_SETTINGS_GUIDANCE =
  'Open Settings to review the audio owner or retry the output route.'

/** Copy shared by callers that only need a truthful action. It deliberately
 * does not promise a top-bar Stop button: route-only handoffs expose no Stop,
 * while a healthy Settings preview is controlled inside Settings itself. */
export function audioSafetyBlockedCopy(subject: string): string {
  return `${subject} is unavailable while another audio owner or route change is active. ${AUDIO_ROUTE_SETTINGS_GUIDANCE}`
}

export const SONG_TRANSPORT_AUDIO_LEASE_COPY = audioSafetyBlockedCopy('Song playback')

/** Preserves the provenance needed by recovery copy. `app-shell-stop` is the
 * exact set of states for which PersistentMonitorControl renders Stop. */
export function audioSafetyLeaseKind(snapshot: MonitorShellSnapshot): AudioSafetyLeaseKind {
  if (!snapshot.hasAudioSafetyLease) return 'none'
  if (snapshot.hasNativeOwnership || snapshot.hasUnresolvedPreviewLease)
    return 'app-shell-stop'
  if (snapshot.hasRouteTransitionLease) return 'route-only'
  if (snapshot.hasPreviewLease) return 'settings-preview'
  return 'unknown'
}

export type MonitorStopOutcome =
  | { ok: true; safeToRestartPreview: true }
  | { ok: false; safeToRestartPreview: false; error: string }

type MonitorStartOutcome =
  | { active: true }
  | { active: false; cancelled: true }
  | {
      active: false
      cancelled: false
      error: string
      result?: DesktopMonitorResult
      status?: DesktopMonitorStatus
    }

type MonitorApi = Pick<
  SingzApi,
  'beginMonitor' | 'setMonitorGain' | 'monitorStatus' | 'endMonitor'
>

export interface DesktopMonitorCoordinatorDependencies {
  api: MonitorApi
  /** Settings' preview owns the same physical microphone immediately before handoff. */
  stopPreview: () => Promise<void>
  pauseSong: () => void
  releaseLegacyOutput: () => Promise<void>
  restoreLegacyOutput: () => Promise<void>
  /** Final cancellation barrier before physical Web Audio output returns. */
  beforeRestoreLegacyOutput?: () => void
  /** Reports coordinator-initiated teardown so Settings can invalidate the
   * preview and one-use headphone confirmation. */
  onTerminalStop?: (outcome: MonitorStopOutcome) => void
  sleep?: (milliseconds: number) => Promise<void>
  callbackTimeoutMs?: number
  pollMs?: number
}

/** false means the mounted Settings view keeps the confirmed-stopped handle so
 * it can restart later; true/void retires it. */
export type MonitorPreviewStop = () => Promise<boolean | void>

export interface MonitorPreviewLeaseHandle {
  /** Used by route cleanup. Rejection retains an unresolved app-shell lease. */
  stopAndRelease: () => Promise<void>
}

export interface MonitorRouteTransitionLeaseHandle {
  release: () => void
}

interface SettingsRouteApplication {
  apply: () => void | Promise<void>
  inputRouteIntentId: number | null
  inputRouteSignature: string | null
  monitorOutputIntentId: number | null
  lease: MonitorRouteTransitionLeaseHandle
  resolve: (applied: boolean) => void
  reject: (error: unknown) => void
}

export type SettingsPreviewRestartPolicy = 'after-drain' | 'after-props-commit'

export interface SettingsInputRouteDraft {
  nativeInputUid: string | undefined
  inputId: string | undefined
  inputChannel: number
}

export function settingsInputDeviceRoute(
  nativeInputUid: string | undefined,
  inputId: string | undefined,
): SettingsInputRouteDraft {
  return { nativeInputUid, inputId, inputChannel: 0 }
}

export function settingsInputChannelRoute(
  current: SettingsInputRouteDraft,
  inputChannel: number
): SettingsInputRouteDraft {
  return { ...current, inputChannel }
}

export function settingsInputRouteSignature(route: SettingsInputRouteDraft): string {
  return `${route.nativeInputUid ?? ''}\u0000${route.inputId ?? ''}\u0000${route.inputChannel}`
}

export type SettingsInputPropCommitDecision = 'unrelated' | 'wait-for-drain' | 'release'

/** Pure decision helpers remain exported for route-state regression tests;
 * production ownership lives in SettingsRouteApplicationQueue. */
export function settingsPreviewRestartDecision(
  restartAfterDrain: boolean,
  deferredInputRoute: string | null,
  renderedInputRoute: string
): 'restart' | 'wait-for-props' {
  return restartAfterDrain || (
    deferredInputRoute !== null && deferredInputRoute === renderedInputRoute
  ) ? 'restart' : 'wait-for-props'
}

export function settingsInputPropCommitDecision(
  deferredInputRoute: string | null,
  renderedInputRoute: string,
  routeApplicationBusy: boolean
): SettingsInputPropCommitDecision {
  if (deferredInputRoute === null || deferredInputRoute !== renderedInputRoute) {
    return 'unrelated'
  }
  return routeApplicationBusy ? 'wait-for-drain' : 'release'
}

interface DeferredSettingsInputRoute {
  id: number
  signature: string
  acknowledged: boolean
}

interface SettingsMonitorOutputRoute {
  uid: string | undefined
}

interface DeferredSettingsMonitorOutputRoute extends SettingsMonitorOutputRoute {
  id: number
  acknowledged: boolean
}

/** Settings route edits run in invocation order. One cleanup boundary precedes
 * the whole drain, every scheduled edit owns a coordinator-visible lease until
 * its own apply settles, and preview restart is emitted only after the last
 * queued edit. Later edits therefore cannot race or be overwritten by an
 * earlier asynchronous completion. */
export class SettingsRouteApplicationQueue {
  private readonly pending: SettingsRouteApplication[] = []
  private readonly previewRestartListeners = new Set<() => void>()
  private readonly busyListeners = new Set<() => void>()
  private lastPublishedBusy = false
  private draining = false
  private afterDrain: ((restartPreview: boolean) => void) | null = null
  private restartAfterDrain = true
  private desiredInputRoute: SettingsInputRouteDraft | null = null
  private renderedInputRoute: SettingsInputRouteDraft | null = null
  private deferredInputRoute: DeferredSettingsInputRoute | null = null
  private nextInputRouteIntentId = 1
  private desiredMonitorOutputRoute: SettingsMonitorOutputRoute | null = null
  private renderedMonitorOutputRoute: SettingsMonitorOutputRoute | null = null
  private deferredMonitorOutputRoute: DeferredSettingsMonitorOutputRoute | null = null
  private nextMonitorOutputIntentId = 1

  get busy(): boolean {
    return this.draining || this.pending.length > 0
  }

  /** Stable external-store hooks let a remounted Settings route observe an
   * app-lifetime operation settling even when no controlled preference or
   * safety verdict changes. Notifications are limited to actual idle/busy
   * edges, so route internals cannot turn into renderer polling churn. */
  readonly busySnapshot = (): boolean => this.busy

  readonly subscribeBusy = (listener: () => void): (() => void) => {
    this.busyListeners.add(listener)
    return () => this.busyListeners.delete(listener)
  }

  get hasDeferredInputIntent(): boolean {
    return this.deferredInputRoute !== null
  }

  get hasDeferredMonitorOutputIntent(): boolean {
    return this.deferredMonitorOutputRoute !== null
  }

  /** Return the invocation-order desired route. Rendered controlled props may
   * refresh it only when no input intent is waiting for acknowledgement. */
  inputRouteDraft(rendered: SettingsInputRouteDraft): SettingsInputRouteDraft {
    if (this.deferredInputRoute === null) this.desiredInputRoute = rendered
    return this.desiredInputRoute ?? rendered
  }

  /** Record a desired input edit before it enters the async route queue. This
   * app-lifetime state deliberately survives Settings unmount/remount. */
  deferInputRoute(route: SettingsInputRouteDraft): string {
    const signature = settingsInputRouteSignature(route)
    this.desiredInputRoute = route
    this.deferredInputRoute = {
      id: this.nextInputRouteIntentId++,
      signature,
      // Selecting the already-rendered signature (for example A -> B -> A)
      // needs no future React state change to prove the final route.
      acknowledged: this.renderedInputRoute !== null &&
        settingsInputRouteSignature(this.renderedInputRoute) === signature
    }
    return signature
  }

  /** A layout-effect calls this only for committed props. Stale controlled
   * renders remain useful as failure rollback state, but cannot overwrite the
   * desired draft or release a different deferred intent. */
  acknowledgeRenderedInputRoute(
    rendered: SettingsInputRouteDraft
  ): SettingsInputPropCommitDecision {
    this.renderedInputRoute = rendered
    const deferred = this.deferredInputRoute
    const signature = settingsInputRouteSignature(rendered)
    if (deferred === null) {
      this.desiredInputRoute = rendered
      return 'unrelated'
    }
    if (deferred.signature !== signature) return 'unrelated'
    deferred.acknowledged = true
    this.desiredInputRoute = rendered
    if (this.busy) return 'wait-for-drain'
    this.deferredInputRoute = null
    this.emitPreviewRestart()
    return 'release'
  }

  /** Return the invocation-order desired native monitor output. A wrapper is
   * used so an intentional undefined fallback route remains distinguishable
   * from uninitialised state. */
  monitorOutputUid(renderedUid: string | undefined): string | undefined {
    if (this.deferredMonitorOutputRoute === null) {
      this.desiredMonitorOutputRoute = { uid: renderedUid }
    }
    return this.desiredMonitorOutputRoute === null
      ? renderedUid
      : this.desiredMonitorOutputRoute.uid
  }

  /** Record an output-device intent before scheduling its physical route
   * apply. The returned identity prevents an older failed apply from retiring
   * a newer same-UID or different-UID request. */
  deferMonitorOutputUid(uid: string | undefined): number {
    const id = this.nextMonitorOutputIntentId++
    this.desiredMonitorOutputRoute = { uid }
    this.deferredMonitorOutputRoute = {
      id,
      uid,
      acknowledged: this.renderedMonitorOutputRoute !== null &&
        this.renderedMonitorOutputRoute.uid === uid
    }
    return id
  }

  /** Only the exact effective controlled output may release the lane gate.
   * Stale props are remembered as rollback state but never replace an active
   * desired route, including after Settings closes and reopens. */
  acknowledgeRenderedMonitorOutputUid(
    renderedUid: string | undefined
  ): SettingsInputPropCommitDecision {
    this.renderedMonitorOutputRoute = { uid: renderedUid }
    const deferred = this.deferredMonitorOutputRoute
    if (deferred === null) {
      this.desiredMonitorOutputRoute = { uid: renderedUid }
      return 'unrelated'
    }
    if (deferred.uid !== renderedUid) return 'unrelated'
    deferred.acknowledged = true
    this.desiredMonitorOutputRoute = { uid: renderedUid }
    if (this.busy) return 'wait-for-drain'
    this.deferredMonitorOutputRoute = null
    return 'release'
  }

  subscribePreviewRestart(listener: () => void): () => void {
    this.previewRestartListeners.add(listener)
    return () => this.previewRestartListeners.delete(listener)
  }

  schedule(
    coordinator: DesktopMonitorCoordinator,
    stop: () => Promise<MonitorStopOutcome>,
    apply: () => void | Promise<void>,
    afterDrain: (restartPreview: boolean) => void,
    restartPolicy: SettingsPreviewRestartPolicy = 'after-drain',
    inputRouteSignature: string | null = null,
    monitorOutputIntentId: number | null = null
  ): Promise<boolean> {
    // One input edit makes the entire overlapping batch prop-boundary-owned.
    // An output edit queued after it must not resurrect the old input preview.
    this.restartAfterDrain &&= restartPolicy === 'after-drain'
    const lease = coordinator.acquireRouteTransitionLease()
    this.afterDrain = afterDrain
    const inputRouteIntentId = inputRouteSignature !== null &&
      this.deferredInputRoute?.signature === inputRouteSignature
      ? this.deferredInputRoute.id
      : null
    const result = new Promise<boolean>((resolve, reject) => {
      this.pending.push({
        apply,
        inputRouteIntentId,
        inputRouteSignature,
        monitorOutputIntentId,
        lease,
        resolve,
        reject
      })
    })
    this.publishBusyIfChanged()
    if (!this.draining) void this.drain(stop)
    return result
  }

  private async drain(stop: () => Promise<MonitorStopOutcome>): Promise<void> {
    this.draining = true
    let safe = false
    try {
      // The transition lease intentionally remains held while stop runs. Stop
      // cleans preview/native owners but never waits for this fail-closed route
      // lease, which each route operation releases in its own finally block.
      safe = (await stop()).safeToRestartPreview
    } catch {
      safe = false
    }

    while (this.pending.length > 0) {
      const operation = this.pending.shift()!
      if (!safe) {
        this.retireFailedInputRoute(
          operation.inputRouteIntentId,
          operation.inputRouteSignature
        )
        this.retireFailedMonitorOutputRoute(operation.monitorOutputIntentId)
        operation.lease.release()
        operation.resolve(false)
        continue
      }
      try {
        await operation.apply()
        operation.resolve(true)
      } catch (error) {
        this.retireFailedInputRoute(
          operation.inputRouteIntentId,
          operation.inputRouteSignature
        )
        this.retireFailedMonitorOutputRoute(operation.monitorOutputIntentId)
        operation.reject(error)
      } finally {
        operation.lease.release()
      }
    }

    this.draining = false
    this.publishBusyIfChanged()
    const notify = this.afterDrain
    const deferred = this.deferredInputRoute
    const deferredMonitorOutput = this.deferredMonitorOutputRoute
    const restartPreview = safe && (
      deferred === null
        ? this.restartAfterDrain
        : deferred.acknowledged
    )
    if (restartPreview && deferred?.acknowledged) this.deferredInputRoute = null
    if (deferredMonitorOutput?.acknowledged) this.deferredMonitorOutputRoute = null
    this.afterDrain = null
    this.restartAfterDrain = true
    if (safe) {
      notify?.(restartPreview)
      if (restartPreview) this.emitPreviewRestart()
    }
    // Scheduling is synchronous, but the drain callback may enqueue another
    // route. Start a fresh cleanup boundary for that new batch.
    if (this.pending.length > 0 && !this.draining) void this.drain(stop)
  }

  private retireFailedInputRoute(id: number | null, signature: string | null): void {
    if (
      id === null || signature === null ||
      this.deferredInputRoute?.id !== id ||
      this.deferredInputRoute.signature !== signature
    ) return
    this.deferredInputRoute = null
    // The requested input never committed. A safe queue boundary may reopen
    // the last rendered route even though this batch originally waited for
    // input props.
    this.restartAfterDrain = true
    if (this.renderedInputRoute !== null) this.desiredInputRoute = this.renderedInputRoute
  }

  private retireFailedMonitorOutputRoute(id: number | null): void {
    if (id === null || this.deferredMonitorOutputRoute?.id !== id) return
    this.deferredMonitorOutputRoute = null
    this.desiredMonitorOutputRoute = this.renderedMonitorOutputRoute
  }

  private emitPreviewRestart(): void {
    for (const listener of this.previewRestartListeners) {
      try { listener() } catch { /* a remounted view cannot corrupt queue ownership */ }
    }
  }

  private publishBusyIfChanged(): void {
    const busy = this.busy
    if (busy === this.lastPublishedBusy) return
    this.lastPublishedBusy = busy
    for (const listener of this.busyListeners) {
      try { listener() } catch { /* view failures cannot corrupt queue ownership */ }
    }
  }
}

/** Physical route edits are serialized behind every audio safety lease. An
 * unowned route applies synchronously; a preview/native route applies only
 * after exact cleanup and any legacy-output restoration are confirmed. */
export async function applyAfterMonitorStops(
  hasAudioSafetyLease: boolean,
  stop: () => Promise<MonitorStopOutcome>,
  apply: () => void | Promise<void>,
  afterApplySettles?: () => void
): Promise<boolean> {
  if (!hasAudioSafetyLease) {
    try {
      await apply()
      return true
    } finally {
      afterApplySettles?.()
    }
  }
  const outcome = await stop()
  if (!outcome.safeToRestartPreview) return false
  try {
    await apply()
    return true
  } finally {
    // Route application may cross an asynchronous device handoff. A caller
    // may reopen its preview only after that handoff has either completed or
    // failed, never while the old sink is still being changed.
    afterApplySettles?.()
  }
}

/** A lease may prevent opening a new physical output session, but an existing
 * song session must retain its pause/stop path. */
export function runSongTransportToggle(
  playing: boolean,
  hasAudioSafetyLease: boolean,
  blocked: () => void,
  toggle: () => void
): boolean {
  if (!playing && hasAudioSafetyLease) {
    blocked()
    return false
  }
  toggle()
  return true
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** One app-lifetime owner for the Web Audio -> native -> Web Audio
 * handoff. Native output is never considered active until its own current
 * generation has produced a callback and accepted the enabled gain ramp. */
export class DesktopMonitorCoordinator {
  private readonly listeners = new Set<(snapshot: MonitorCoordinatorSnapshot) => void>()
  private readonly shellListeners = new Set<(snapshot: MonitorShellSnapshot) => void>()
  private readonly terminalStopListeners = new Set<(outcome: MonitorStopOutcome) => void>()
  private readonly previewStops = new Map<number, {
    stop: MonitorPreviewStop
    unresolved: boolean
    pending: Promise<boolean | void> | null
  }>()
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly callbackTimeoutMs: number
  private readonly pollMs: number
  private epoch = 0
  private startPending: Promise<MonitorStartOutcome> | null = null
  private stopPending: Promise<MonitorStopOutcome> | null = null
  private stopTransitionGenerationValue = 0
  private terminalStopPending: Promise<MonitorStopOutcome> | null = null
  private refreshPending: Promise<void> | null = null
  private ownershipGeneration = ''
  private legacyOutputReleased = false
  private readonly routeTransitionLeases = new Set<number>()
  private nextRouteTransitionLeaseId = 1
  private nextPreviewStopId = 1
  private snapshotValue: MonitorCoordinatorSnapshot = {
    phase: 'idle',
    message: 'Monitoring is off.',
    result: null,
    status: null
  }
  private shellSnapshotValue: MonitorShellSnapshot = {
    phase: 'idle',
    message: 'Monitoring is off.',
    hasNativeOwnership: false,
    hasAudioSafetyLease: false,
    hasRouteTransitionLease: false,
    hasPreviewLease: false,
    hasUnresolvedPreviewLease: false
  }

  constructor(private readonly dependencies: DesktopMonitorCoordinatorDependencies) {
    this.sleep = dependencies.sleep ?? delay
    this.callbackTimeoutMs = dependencies.callbackTimeoutMs ?? 2500
    this.pollMs = dependencies.pollMs ?? 25
  }

  /** Stable identity shared by every observer joining the current Stop. A new
   * value is minted only when a genuinely new stop transition begins. */
  get stopTransitionGeneration(): number {
    return this.stopTransitionGenerationValue
  }

  get snapshot(): MonitorCoordinatorSnapshot {
    return this.snapshotValue
  }

  get hasNativeOwnership(): boolean {
    return Boolean(
      this.ownershipGeneration || this.startPending || this.legacyOutputReleased
    )
  }

  get hasAudioSafetyLease(): boolean {
    // A healthy mounted preview is still a physical microphone owner. It
    // blocks song/training audio and participates in route-edit teardown, but
    // only a failed/pending route cleanup needs an app-shell retry control.
    return this.hasNativeOwnership || Boolean(this.stopPending) || this.previewStops.size > 0 ||
      this.routeTransitionLeases.size > 0
  }

  get hasRouteTransitionLease(): boolean {
    return this.routeTransitionLeases.size > 0
  }

  /** Settings may reopen after a failed emergency stop only when the retained
   * owner is the physical output-route handoff that Settings itself can
   * repair. A mounted preview (even one whose cleanup has not failed yet), a
   * pending stop, or native ownership must keep recovery on the exact-owner
   * Stop path. */
  get hasRouteOnlySafetyLease(): boolean {
    return this.hasRouteTransitionLease &&
      !this.hasNativeOwnership &&
      !this.stopPending &&
      this.previewStops.size === 0
  }

  private get hasUnresolvedPreviewLease(): boolean {
    return [...this.previewStops.values()].some((entry) => entry.unresolved)
  }

  get shellSnapshot(): MonitorShellSnapshot {
    return this.shellSnapshotValue
  }

  subscribe(listener: (snapshot: MonitorCoordinatorSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshotValue)
    return () => this.listeners.delete(listener)
  }

  subscribeShell(listener: (snapshot: MonitorShellSnapshot) => void): () => void {
    this.shellListeners.add(listener)
    listener(this.shellSnapshotValue)
    return () => this.shellListeners.delete(listener)
  }

  /** Registers one exact Chromium preview owner. The returned release is only
   * called after stopAndWait confirms cleanup; rejection deliberately retains
   * the lease so the app-shell Stop control can retry the same owner. */
  registerPreviewStop(stop: MonitorPreviewStop): MonitorPreviewLeaseHandle {
    const id = this.nextPreviewStopId++
    const entry = { stop, unresolved: false, pending: null as Promise<boolean | void> | null }
    this.previewStops.set(id, entry)
    this.publishShellIfChanged()
    return {
      stopAndRelease: async () => {
        if (this.previewStops.get(id) !== entry) return
        entry.unresolved = true
        this.publishShellIfChanged()
        try {
          await this.runPreviewStop(entry)
          if (this.previewStops.get(id) === entry) this.previewStops.delete(id)
          this.publishShellIfChanged()
        } catch (error) {
          entry.unresolved = true
          this.publishShellIfChanged()
          throw error
        }
      }
    }
  }

  /** A fail-closed control-domain lease for a physical route handoff. It
   * blocks new song/training starts even after Settings unmounts. The lease is
   * retained until the browser promise settles (or app quit), because a late
   * sink write is less safe than a visible, non-cancellable waiting state. */
  acquireRouteTransitionLease(): MonitorRouteTransitionLeaseHandle {
    const id = this.nextRouteTransitionLeaseId++
    let released = false
    this.routeTransitionLeases.add(id)
    this.publishShellIfChanged()
    return {
      release: () => {
        if (released) return
        released = true
        this.routeTransitionLeases.delete(id)
        this.publishShellIfChanged()
      }
    }
  }

  /** A mounted controller can react to fail-closed teardown without owning
   * the session lifetime. Reopening Settings subscribes to the same owner. */
  subscribeTerminalStop(listener: (outcome: MonitorStopOutcome) => void): () => void {
    this.terminalStopListeners.add(listener)
    return () => this.terminalStopListeners.delete(listener)
  }

  private publish(patch: Partial<MonitorCoordinatorSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    for (const listener of this.listeners) listener(this.snapshotValue)
    this.publishShellIfChanged()
  }

  private publishShellIfChanged(): void {
    const next: MonitorShellSnapshot = {
      phase: this.snapshotValue.phase,
      message: this.snapshotValue.message,
      hasNativeOwnership: this.hasNativeOwnership,
      hasAudioSafetyLease: this.hasAudioSafetyLease,
      hasRouteTransitionLease: this.hasRouteTransitionLease,
      hasPreviewLease: this.previewStops.size > 0,
      hasUnresolvedPreviewLease: this.hasUnresolvedPreviewLease
    }
    const current = this.shellSnapshotValue
    if (
      next.phase === current.phase && next.message === current.message &&
      next.hasNativeOwnership === current.hasNativeOwnership &&
      next.hasAudioSafetyLease === current.hasAudioSafetyLease &&
      next.hasRouteTransitionLease === current.hasRouteTransitionLease &&
      next.hasPreviewLease === current.hasPreviewLease &&
      next.hasUnresolvedPreviewLease === current.hasUnresolvedPreviewLease
    ) return
    this.shellSnapshotValue = next
    for (const listener of this.shellListeners) listener(next)
  }

  private current(epoch: number): boolean {
    return epoch === this.epoch
  }

  async start(config: DesktopMonitorConfig, gainDb: number): Promise<boolean> {
    if (
      this.startPending || this.stopPending || this.ownershipGeneration ||
      this.hasRouteTransitionLease || this.hasUnresolvedPreviewLease
    ) return false
    const epoch = ++this.epoch
    const operation = this.startNow(epoch, config, gainDb)
    this.startPending = operation
    this.publishShellIfChanged()
    let outcome: MonitorStartOutcome
    try {
      outcome = await operation
    } finally {
      if (this.startPending === operation) this.startPending = null
      this.publishShellIfChanged()
    }
    if (outcome.active) return true
    if (outcome.cancelled) return false
    const stopped = await this.stopForTerminal()
    if (stopped.ok) {
      this.publish({
        phase: 'error',
        message: outcome.error,
        ...(outcome.result ? { result: outcome.result } : {}),
        ...(outcome.status ? { status: outcome.status } : {})
      })
    }
    return false
  }

  private async startNow(
    epoch: number,
    config: DesktopMonitorConfig,
    gainDb: number
  ): Promise<MonitorStartOutcome> {
    this.publish({ phase: 'preparing', message: 'Releasing the microphone and song output…', result: null })
    try {
      // This order is the product safety contract. The preview stop resolves
      // only after its native capture child confirms termination.
      await this.dependencies.stopPreview()
      if (this.previewStops.size > 0) await this.stopRegisteredPreviews()
      if (!this.current(epoch)) return { active: false, cancelled: true }
      this.dependencies.pauseSong()
      if (!this.current(epoch)) return { active: false, cancelled: true }
      await this.dependencies.releaseLegacyOutput()
      this.legacyOutputReleased = true
      this.publishShellIfChanged()
      if (!this.current(epoch)) return { active: false, cancelled: true }

      this.publish({ phase: 'starting', message: 'Starting the native DSP path…' })
      const result = await this.dependencies.api.beginMonitor(config)
      this.publish({ result })
      if (result.ok) this.ownershipGeneration = result.ownershipGeneration
      else if (await this.failedBeginRetained(result)) {
        this.ownershipGeneration = result.ownershipGeneration
      }
      if (!this.current(epoch)) {
        return { active: false, cancelled: true }
      }
      if (!result.ok) {
        return {
          active: false,
          cancelled: false,
          error: monitorErrorCopy(result),
          result
        }
      }

      const first = await this.waitForStatus(epoch, (status) =>
        status.active && status.state === 'running' && BigInt(status.callbacks) > 0n
      )
      if (!first) return { active: false, cancelled: true }
      const gainResult = await this.dependencies.api.setMonitorGain(
        this.ownershipGeneration,
        gainDb,
        true
      )
      if (!gainResult.ok) throw new MonitorTransitionError(monitorErrorCopy(gainResult))
      const enabled = await this.waitForStatus(
        epoch,
        (status) => status.enabled && status.state === 'running'
      )
      if (!enabled) return { active: false, cancelled: true }
      this.publish({
        phase: 'active',
        message: 'Native DSP monitoring is active.',
        result: gainResult,
        status: enabled
      })
      return { active: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.current(epoch)
        ? { active: false, cancelled: false, error: message }
        : { active: false, cancelled: true }
    }
  }

  private async failedBeginRetained(result: DesktopMonitorResult): Promise<boolean> {
    if (result.ownershipGeneration === '0') return false
    try {
      const status = await this.dependencies.api.monitorStatus()
      return status.active && status.ownershipGeneration === result.ownershipGeneration
    } catch {
      // Main retains uncertain generations when the bridge cannot prove that
      // rollback succeeded. Preserve the only token needed to retry end.
      return true
    }
  }

  private async waitForStatus(
    epoch: number,
    accept: (status: DesktopMonitorStatus) => boolean
  ): Promise<DesktopMonitorStatus | null> {
    const attempts = Math.max(1, Math.ceil(this.callbackTimeoutMs / this.pollMs))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!this.current(epoch)) {
        return null
      }
      const status = await this.dependencies.api.monitorStatus()
      if (!this.current(epoch)) return null
      if (status.ownershipGeneration !== this.ownershipGeneration) {
        throw new MonitorTransitionError('The native monitor generation changed before it became ready.')
      }
      this.publish({ status })
      if (status.deviceLost || status.state === 'device-lost') {
        throw new MonitorTransitionError('The monitoring device disconnected. Reconnect it and start again.')
      }
      if (status.state === 'error' || status.state === 'unsupported') {
        throw new MonitorTransitionError(status.error || 'The native monitoring host stopped.')
      }
      if (accept(status)) return status
      await this.sleep(this.pollMs)
    }
    throw new MonitorTransitionError('The native DSP path did not confirm an audio callback in time.')
  }

  /** Polls scalar telemetry. A terminal route is stopped before Web Audio is
   * restored; healthy counter increases remain visible instead of hidden. */
  async refreshStatus(): Promise<void> {
    if (this.refreshPending) return this.refreshPending
    const operation = this.refreshStatusNow()
    this.refreshPending = operation
    try {
      await operation
    } finally {
      if (this.refreshPending === operation) this.refreshPending = null
    }
  }

  private async refreshStatusNow(): Promise<void> {
    const generation = this.ownershipGeneration
    if (!generation || this.snapshotValue.phase !== 'active') return
    try {
      const status = await this.dependencies.api.monitorStatus()
      if (
        generation !== this.ownershipGeneration ||
        this.snapshotValue.phase !== 'active'
      ) return
      if (
        status.ownershipGeneration !== generation || status.deviceLost ||
        status.state === 'device-lost' || status.state === 'error' ||
        status.state === 'unsupported'
      ) {
        const message = status.error || 'The native monitoring route stopped.'
        const stopped = await this.stopForTerminal()
        if (stopped.ok) this.publish({ phase: 'error', message, status })
        return
      }
      this.publish({ status })
    } catch (error) {
      if (
        generation !== this.ownershipGeneration ||
        this.snapshotValue.phase !== 'active'
      ) return
      const message = error instanceof Error ? error.message : String(error)
      const stopped = await this.stopForTerminal()
      if (stopped.ok) this.publish({ phase: 'error', message })
    }
  }

  async setGain(gainDb: number): Promise<boolean> {
    const generation = this.ownershipGeneration
    if (!generation || this.snapshotValue.phase !== 'active') return false
    let result: DesktopMonitorResult
    try {
      result = await this.dependencies.api.setMonitorGain(generation, gainDb, true)
    } catch (error) {
      // A gain request can settle after an explicit Stop, or even after a new
      // generation has become active. That old control failure no longer owns
      // terminal teardown and must never stop the current session.
      if (
        generation !== this.ownershipGeneration ||
        this.snapshotValue.phase !== 'active'
      ) return false
      const message = error instanceof Error ? error.message : String(error)
      const stopped = await this.stopForTerminal()
      if (stopped.ok) this.publish({ phase: 'error', message })
      return false
    }
    if (
      generation !== this.ownershipGeneration ||
      this.snapshotValue.phase !== 'active'
    ) return false
    if (!result.ok) {
      const message = monitorErrorCopy(result)
      const stopped = await this.stopForTerminal()
      if (stopped.ok) this.publish({ phase: 'error', message, result })
      return false
    }
    this.publish({ result })
    return true
  }

  async stop(): Promise<MonitorStopOutcome> {
    if (this.stopPending) return this.stopPending
    this.stopTransitionGenerationValue += 1
    const epoch = ++this.epoch
    // Defer stopNow by one microtask so stopPending becomes a published safety
    // lease before any dependency callback can observe or re-enter Stop.
    const operation = Promise.resolve().then(() => this.stopNow(epoch))
    this.stopPending = operation
    this.publishShellIfChanged()
    try {
      return await operation
    } finally {
      if (this.stopPending === operation) this.stopPending = null
      this.publishShellIfChanged()
    }
  }

  private async stopForTerminal(): Promise<MonitorStopOutcome> {
    if (this.terminalStopPending) return this.terminalStopPending
    let operation!: Promise<MonitorStopOutcome>
    operation = this.stop().then((outcome) => {
      try { this.dependencies.onTerminalStop?.(outcome) } catch { /* observer cannot retain ownership */ }
      for (const listener of this.terminalStopListeners) {
        try { listener(outcome) } catch { /* isolate route observers */ }
      }
      return outcome
    }).finally(() => {
      if (this.terminalStopPending === operation) this.terminalStopPending = null
    })
    this.terminalStopPending = operation
    return operation
  }

  private async stopNow(epoch: number): Promise<MonitorStopOutcome> {
    const hadOwnership = this.hasAudioSafetyLease
    if (hadOwnership) this.publish({ phase: 'stopping', message: 'Stopping native monitoring…' })
    // Stopping the app session also closes every registered legacy preview.
    // When a start is in flight, startNow observes the epoch and performs the
    // native rollback.
    let previewError = ''
    try {
      await this.dependencies.stopPreview()
      if (this.previewStops.size > 0) await this.stopRegisteredPreviews()
    } catch (error) {
      previewError = error instanceof Error ? error.message : String(error)
    }
    if (this.startPending) {
      try { await this.startPending } catch { /* startNow reports its own failure */ }
    }
    const ended = await this.endCurrentGeneration()
    if (!ended) {
      const error = 'Native monitoring did not confirm shutdown. Song output remains released for safety.'
      if (this.current(epoch)) {
        this.publish({ phase: 'error', message: error })
      }
      return { ok: false, safeToRestartPreview: false, error }
    }
    if (previewError) {
      // Native output is now off, but Chromium capture ownership remains
      // uncertain. Keep Web Audio released until a later Stop retries the
      // retained preview lease successfully.
      if (this.current(epoch)) this.publish({ phase: 'error', message: previewError })
      return { ok: false, safeToRestartPreview: false, error: previewError }
    }
    try {
      // Preview-only cleanup never released the physical Web Audio session,
      // so it must not pause a song or cancel scheduled cues on the way out.
      if (this.legacyOutputReleased) this.dependencies.beforeRestoreLegacyOutput?.()
      await this.restoreLegacyOutput()
    } catch (error) {
      const message = `Song output could not be restored: ${error instanceof Error ? error.message : String(error)}`
      if (this.current(epoch)) {
        this.publish({ phase: 'error', message })
      }
      return { ok: false, safeToRestartPreview: false, error: message }
    }
    if (this.current(epoch)) {
      this.publish({
        phase: 'idle',
        message: 'Monitoring is off.',
        result: null,
        status: null
      })
    }
    return { ok: true, safeToRestartPreview: true }
  }

  private async endCurrentGeneration(): Promise<boolean> {
    const generation = this.ownershipGeneration
    if (!generation) return true
    try {
      // Mute request is best effort; the synchronous end confirmation is the
      // boundary that permits Chromium to own output again.
      await this.dependencies.api.setMonitorGain(generation, -60, false)
    } catch { /* end still owns the safety decision */ }
    let result: DesktopMonitorResult
    try {
      result = await this.dependencies.api.endMonitor(generation)
    } catch {
      return false
    }
    if (!result.ok) return false
    if (this.ownershipGeneration === generation) this.ownershipGeneration = ''
    this.publishShellIfChanged()
    return true
  }

  private async stopRegisteredPreviews(): Promise<void> {
    let firstError: unknown = null
    for (const [id, entry] of [...this.previewStops]) {
      try {
        const release = await this.runPreviewStop(entry)
        if (this.previewStops.get(id) !== entry) continue
        if (release === false) entry.unresolved = false
        else this.previewStops.delete(id)
      } catch (error) {
        entry.unresolved = true
        firstError ??= error
      }
    }
    this.publishShellIfChanged()
    if (firstError) throw firstError
  }

  private async runPreviewStop(entry: {
    stop: MonitorPreviewStop
    unresolved: boolean
    pending: Promise<boolean | void> | null
  }): Promise<boolean | void> {
    if (entry.pending) return entry.pending
    const operation = Promise.resolve().then(entry.stop)
    entry.pending = operation
    try {
      return await operation
    } finally {
      if (entry.pending === operation) entry.pending = null
    }
  }

  private async restoreLegacyOutput(): Promise<void> {
    if (!this.legacyOutputReleased) return
    await this.dependencies.restoreLegacyOutput()
    this.legacyOutputReleased = false
    this.publishShellIfChanged()
  }
}

class MonitorTransitionError extends Error {}

export function monitorErrorCopy(result: Pick<DesktopMonitorResult, 'errorCode' | 'error'>): string {
  if (result.errorCode === 'platform-not-ready')
    return 'Headphone monitoring is not available on Windows yet. Native output stayed off.'
  if (result.errorCode === 'unsupported-route')
    return 'That route is not approved for low-latency monitoring. Choose a wired audio device.'
  if (result.errorCode === 'native-audio-busy')
    return 'The microphone is still in use. Stop the preview or exercise, then try again.'
  if (result.errorCode === 'queue-full')
    return 'The DSP control queue is busy. Wait a moment, then try again.'
  return result.error || 'Native headphone monitoring could not start.'
}

export function linearToDbfs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return -72
  return Math.max(-72, Math.min(0, 20 * Math.log10(value)))
}
