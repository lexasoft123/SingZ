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
  /** Reports coordinator-initiated teardown so Settings can invalidate the
   * preview and one-use headphone confirmation. */
  onTerminalStop?: (outcome: MonitorStopOutcome) => void
  sleep?: (milliseconds: number) => Promise<void>
  callbackTimeoutMs?: number
  pollMs?: number
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/** One settings-lifetime owner for the Web Audio -> native -> Web Audio
 * handoff. Native output is never considered active until its own current
 * generation has produced a callback and accepted the enabled gain ramp. */
export class DesktopMonitorCoordinator {
  private readonly listeners = new Set<(snapshot: MonitorCoordinatorSnapshot) => void>()
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly callbackTimeoutMs: number
  private readonly pollMs: number
  private epoch = 0
  private startPending: Promise<MonitorStartOutcome> | null = null
  private stopPending: Promise<MonitorStopOutcome> | null = null
  private terminalStopPending: Promise<MonitorStopOutcome> | null = null
  private refreshPending: Promise<void> | null = null
  private ownershipGeneration = ''
  private legacyOutputReleased = false
  private snapshotValue: MonitorCoordinatorSnapshot = {
    phase: 'idle',
    message: 'Monitoring is off.',
    result: null,
    status: null
  }

  constructor(private readonly dependencies: DesktopMonitorCoordinatorDependencies) {
    this.sleep = dependencies.sleep ?? delay
    this.callbackTimeoutMs = dependencies.callbackTimeoutMs ?? 2500
    this.pollMs = dependencies.pollMs ?? 25
  }

  get snapshot(): MonitorCoordinatorSnapshot {
    return this.snapshotValue
  }

  get hasNativeOwnership(): boolean {
    return Boolean(
      this.ownershipGeneration || this.startPending || this.stopPending ||
      this.legacyOutputReleased
    )
  }

  subscribe(listener: (snapshot: MonitorCoordinatorSnapshot) => void): () => void {
    this.listeners.add(listener)
    listener(this.snapshotValue)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<MonitorCoordinatorSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch }
    for (const listener of this.listeners) listener(this.snapshotValue)
  }

  private current(epoch: number): boolean {
    return epoch === this.epoch
  }

  async start(config: DesktopMonitorConfig, gainDb: number): Promise<boolean> {
    if (this.startPending || this.stopPending || this.ownershipGeneration) return false
    const epoch = ++this.epoch
    const operation = this.startNow(epoch, config, gainDb)
    this.startPending = operation
    let outcome: MonitorStartOutcome
    try {
      outcome = await operation
    } finally {
      if (this.startPending === operation) this.startPending = null
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
      if (!this.current(epoch)) return { active: false, cancelled: true }
      this.dependencies.pauseSong()
      if (!this.current(epoch)) return { active: false, cancelled: true }
      await this.dependencies.releaseLegacyOutput()
      this.legacyOutputReleased = true
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
      if (generation !== this.ownershipGeneration) return
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
      const message = error instanceof Error ? error.message : String(error)
      const stopped = await this.stopForTerminal()
      if (stopped.ok) this.publish({ phase: 'error', message })
      return false
    }
    if (generation !== this.ownershipGeneration) return false
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
    const epoch = ++this.epoch
    const operation = this.stopNow(epoch)
    this.stopPending = operation
    try {
      return await operation
    } finally {
      if (this.stopPending === operation) this.stopPending = null
    }
  }

  private async stopForTerminal(): Promise<MonitorStopOutcome> {
    if (this.terminalStopPending) return this.terminalStopPending
    let operation!: Promise<MonitorStopOutcome>
    operation = this.stop().then((outcome) => {
      this.dependencies.onTerminalStop?.(outcome)
      return outcome
    }).finally(() => {
      if (this.terminalStopPending === operation) this.terminalStopPending = null
    })
    this.terminalStopPending = operation
    return operation
  }

  private async stopNow(epoch: number): Promise<MonitorStopOutcome> {
    const hadOwnership = Boolean(this.ownershipGeneration || this.startPending || this.legacyOutputReleased)
    if (hadOwnership) this.publish({ phase: 'stopping', message: 'Stopping native monitoring…' })
    // Closing Settings also closes its legacy preview. When a start is in
    // flight, startNow observes the epoch and performs the native rollback.
    let previewError = ''
    try {
      await this.dependencies.stopPreview()
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
    try {
      await this.restoreLegacyOutput()
    } catch (error) {
      const message = `Song output could not be restored: ${error instanceof Error ? error.message : String(error)}`
      if (this.current(epoch)) {
        this.publish({ phase: 'error', message })
      }
      return { ok: false, safeToRestartPreview: false, error: message }
    }
    if (previewError) {
      if (this.current(epoch)) this.publish({ phase: 'error', message: previewError })
      return { ok: false, safeToRestartPreview: false, error: previewError }
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
    return true
  }

  private async restoreLegacyOutput(): Promise<void> {
    if (!this.legacyOutputReleased) return
    await this.dependencies.restoreLegacyOutput()
    this.legacyOutputReleased = false
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
