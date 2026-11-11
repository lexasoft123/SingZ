import type { SingzApi } from '../../../shared/types'
import type { BoxRetainedPlaybackSnapshot } from '../../../shared/box-contract'
import { retainedPlaybackSnapshot } from '../../../shared/box-retained-playback'
import { t } from './i18n'

type RetainedApi = Pick<SingzApi, 'boxAudioPersistent' | 'box'>
export type RetainedRestore = (expected: { epoch: string; generation: string }) => Promise<boolean>
export interface RetainedPlaybackState { epoch: string | null; generation: string | null; playing: boolean; busy: boolean; restoring: boolean; error: string }
export async function restoreRetainedEntry(mounted: boolean, hydrated: boolean, restore: () => Promise<boolean>): Promise<boolean> {
  if (!mounted || !hydrated) return false
  return restore()
}
export function routeRestoredPlayback<TActive>(options: {
  restored: boolean
  mounted: boolean
  hydrated: boolean
  requestCurrent: boolean
  readActive: () => TActive | null
  route: (active: TActive) => void
}): boolean {
  if (!options.restored || !options.mounted || !options.hydrated || !options.requestCurrent) return false
  const active = options.readActive()
  if (!active) return false
  options.route(active)
  return true
}
function generation(status: BoxRetainedPlaybackSnapshot['playback'] | undefined): string | null {
  return status && status.state !== 'unloaded' && /^[1-9][0-9]{0,19}$/.test(status.generation) ? status.generation : null
}
/** A fresh TV can restore a verified retained generation or explicitly stop it.
 *
 * Reads, restores and stops run one at a time. A background poll never marks
 * the surface busy and is skipped while anything else runs; an explicit
 * Refresh or Stop pressed during a poll waits for it instead of being dropped.
 * A restore that never settles is abandoned after `restoreTimeoutMs`, so the
 * action-less "Restoring" surface always falls back to Refresh/Stop. */
export class RetainedPlaybackController {
  private state: RetainedPlaybackState = { epoch: null, generation: null, playing: false, busy: false, restoring: false, error: '' }
  private readonly listeners = new Set<() => void>()
  private readonly attempted = new Set<string>()
  /** The last restore failure, kept only while that same generation is retained. */
  private restoreFailure: { key: string; message: string } | null = null
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private explicit = 0
  private stopQueued = false
  private disposed = false
  private lifetime = 0
  constructor(private readonly api: RetainedApi, private onRestore?: RetainedRestore, private readonly restoreTimeoutMs = 10000) {}
  getSnapshot = (): RetainedPlaybackState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  setRestoreCallback(onRestore?: RetainedRestore): void { this.onRestore = onRestore }
  private live(lifetime: number): boolean { return !this.disposed && lifetime === this.lifetime }
  private update(patch: Partial<RetainedPlaybackState>): void {
    if (this.disposed) return
    const next = { ...this.state, ...patch }
    next.busy = this.explicit > 0 || next.restoring
    this.state = next
    for (const listener of this.listeners) listener()
  }
  private publish(snapshot: BoxRetainedPlaybackSnapshot, error = '', restoring = false): void {
    const status = snapshot.playback
    this.update({ epoch: snapshot.epoch, generation: generation(status), playing: status?.transportState === 'playing' || status?.transportState === 'pre-roll', restoring, error })
  }
  private enqueue(kind: 'poll' | 'refresh' | 'stop', operation: (lifetime: number) => Promise<void>): Promise<void> {
    const lifetime = this.lifetime
    const explicit = kind !== 'poll'
    this.pending++
    if (explicit) { this.explicit++; this.update({}) }
    const run = this.tail
      .then(() => this.live(lifetime) ? operation(lifetime) : undefined)
      .catch(() => undefined)
      .finally(() => {
        if (lifetime !== this.lifetime) return
        this.pending--
        if (explicit) this.explicit--
        if (kind === 'stop') this.stopQueued = false
        this.update({})
      })
    this.tail = run
    return run
  }
  /** Background status poll: silent, and skipped while any other operation runs. */
  poll(): Promise<void> {
    if (!this.api.boxAudioPersistent || this.disposed || this.pending > 0) return Promise.resolve()
    return this.enqueue('poll', lifetime => this.read(lifetime))
  }
  /** Explicit Refresh: waits for a running poll rather than being dropped. */
  refresh(): Promise<void> {
    if (!this.api.boxAudioPersistent || this.disposed || this.state.restoring) return Promise.resolve()
    return this.enqueue('refresh', lifetime => this.read(lifetime))
  }
  private async read(lifetime: number): Promise<void> {
    try {
      const result = await this.api.box.retainedPlaybackSnapshot()
      if (!result.ok) throw new Error(result.error)
      const snapshot = retainedPlaybackSnapshot(result.value)
      if (!this.live(lifetime)) return
      const currentGeneration = generation(snapshot.playback)
      const key = currentGeneration ? JSON.stringify([snapshot.epoch, currentGeneration]) : null
      const restore = this.onRestore
      if (snapshot.recovery && currentGeneration && key && restore && !this.attempted.has(key)) {
        this.attempted.add(key)
        this.publish(snapshot, '', true)
        const failure = await this.attemptRestore(restore, { epoch: snapshot.epoch, generation: currentGeneration })
        if (!this.live(lifetime)) return
        this.restoreFailure = failure ? { key, message: failure } : null
        this.publish(snapshot, failure)
      } else {
        // A successful read clears transient status/stop errors; only a restore
        // failure for this exact retained generation stays visible.
        this.publish(snapshot, key && this.restoreFailure?.key === key ? this.restoreFailure.message : '')
      }
    } catch (error) {
      console.warn('Retained playback status failed', error)
      if (this.live(lifetime)) this.update({ restoring: false, error: t('box.retained.statusUnavailable') })
    }
  }
  /** Resolves to '' on success or the failure to show; never outlives the deadline. */
  private async attemptRestore(restore: RetainedRestore, expected: { epoch: string; generation: string }): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<string>(resolve => {
      timer = setTimeout(() => resolve(t('box.retained.restoreTimedOut')), this.restoreTimeoutMs)
    })
    const attempt = Promise.resolve()
      .then(() => restore(expected))
      .then(
        restored => restored ? '' : t('box.retained.restoreFailed'),
        error => {
          console.warn('Retained playback restore failed', error)
          return t('box.retained.restoreFailed')
        }
      )
    try { return await Promise.race([attempt, deadline]) }
    finally { clearTimeout(timer) }
  }
  stop(): Promise<void> {
    const expected = { epoch: this.state.epoch, generation: this.state.generation }
    if (!this.api.boxAudioPersistent || !expected.epoch || !expected.generation || this.state.restoring || this.stopQueued || this.disposed) return Promise.resolve()
    this.stopQueued = true
    this.update({ error: '' })
    return this.enqueue('stop', async lifetime => {
      try {
        const currentResult = await this.api.box.retainedPlaybackSnapshot()
        if (!currentResult.ok) throw new Error(currentResult.error)
        const current = retainedPlaybackSnapshot(currentResult.value)
        if (!this.live(lifetime)) return
        if (current.epoch !== expected.epoch || generation(current.playback) !== expected.generation) {
          this.publish(current, t('box.retained.songChanged'))
          return
        }
        const receipt = await this.api.box.stopRetainedPlayback({ epoch: expected.epoch!, generation: expected.generation! })
        if (!receipt.ok) throw new Error(receipt.error)
        const after = retainedPlaybackSnapshot(receipt.value)
        if (!this.live(lifetime)) return
        if (after.epoch !== expected.epoch || generation(after.playback) === expected.generation) {
          this.update({ error: t('box.retained.releaseUnconfirmed') })
          return
        }
        this.publish(after)
      } catch (error) {
        console.warn('Retained playback stop failed', error)
        if (this.live(lifetime)) this.update({ error: t('box.retained.stopUncertain') })
      }
    })
  }
  resume(): void {
    this.lifetime++
    this.disposed = false
    this.tail = Promise.resolve()
    this.pending = 0
    this.explicit = 0
    this.stopQueued = false
    this.state = { ...this.state, busy: false, restoring: false }
  }
  dispose(): void { this.lifetime++; this.disposed = true; this.listeners.clear() }
}
