import type { SingzApi } from '../../../shared/types'
import type { BoxRetainedPlaybackSnapshot } from '../../../shared/box-contract'
import { retainedPlaybackSnapshot } from '../../../shared/box-retained-playback'

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
/** A fresh TV can restore a verified retained generation or explicitly stop it. */
export class RetainedPlaybackController {
  private state: RetainedPlaybackState = { epoch: null, generation: null, playing: false, busy: false, restoring: false, error: '' }
  private readonly listeners = new Set<() => void>()
  private readonly attempted = new Set<string>()
  private inFlight = false
  private disposed = false
  private lifetime = 0
  constructor(private readonly api: RetainedApi, private onRestore?: RetainedRestore) {}
  getSnapshot = (): RetainedPlaybackState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  setRestoreCallback(onRestore?: RetainedRestore): void { this.onRestore = onRestore }
  private publish(snapshot: BoxRetainedPlaybackSnapshot, error = '', restoring = false): void {
    if (this.disposed) return
    const status = snapshot.playback
    this.state = { epoch: snapshot.epoch, generation: generation(status), playing: status?.transportState === 'playing' || status?.transportState === 'pre-roll', busy: this.inFlight, restoring, error }
    for (const listener of this.listeners) listener()
  }
  async refresh(): Promise<void> {
    if (!this.api.boxAudioPersistent || this.inFlight || this.disposed) return
    const lifetime = this.lifetime
    this.inFlight = true
    try {
      const result = await this.api.box.retainedPlaybackSnapshot()
      if (!result.ok) throw new Error(result.error)
      const snapshot = retainedPlaybackSnapshot(result.value)
      if (this.disposed || lifetime !== this.lifetime) return
      const currentGeneration = generation(snapshot.playback)
      const key = currentGeneration ? JSON.stringify([snapshot.epoch, currentGeneration]) : null
      const restore = this.onRestore
      if (snapshot.recovery && currentGeneration && key && restore && !this.attempted.has(key)) {
        this.attempted.add(key)
        this.publish(snapshot, '', true)
        try {
          const restored = await restore({ epoch: snapshot.epoch, generation: currentGeneration })
          if (this.disposed || lifetime !== this.lifetime) return
          this.publish(snapshot, restored ? '' : 'The previous song could not be restored. Refresh its status or stop it.')
        } catch (error) {
          if (!this.disposed && lifetime === this.lifetime) this.publish(snapshot, error instanceof Error ? error.message : 'Song restoration is unavailable. Refresh its status or stop it.')
        }
      } else {
        this.publish(snapshot, currentGeneration ? this.state.error : '')
      }
    }
    catch (error) { if (!this.disposed && lifetime === this.lifetime) this.state = { ...this.state, error: error instanceof Error ? error.message : 'Audio status is unavailable.' } }
    finally { if (lifetime === this.lifetime) this.inFlight = false; if (!this.disposed && lifetime === this.lifetime) { this.state = { ...this.state, busy: false, restoring: false }; for (const listener of this.listeners) listener() } }
  }
  async stop(): Promise<void> {
    const expected = { epoch: this.state.epoch, generation: this.state.generation }
    if (!this.api.boxAudioPersistent || !expected.epoch || !expected.generation || this.inFlight || this.disposed) return
    const lifetime = this.lifetime
    this.inFlight = true
    this.state = { ...this.state, busy: true, error: '' }
    for (const listener of this.listeners) listener()
    try {
      const currentResult = await this.api.box.retainedPlaybackSnapshot()
      if (!currentResult.ok) throw new Error(currentResult.error)
      const current = retainedPlaybackSnapshot(currentResult.value)
      if (this.disposed || lifetime !== this.lifetime) return
      if (current.epoch !== expected.epoch || generation(current.playback) !== expected.generation) {
        this.publish(current, 'The song changed. Review its state before stopping.')
        return
      }
      const receipt = await this.api.box.stopRetainedPlayback({ epoch: expected.epoch!, generation: expected.generation! })
      if (!receipt.ok) throw new Error(receipt.error)
      const after = retainedPlaybackSnapshot(receipt.value)
      if (this.disposed || lifetime !== this.lifetime) return
      if (after.epoch !== expected.epoch || generation(after.playback) === expected.generation)
        throw new Error('The audio host has not confirmed that this song was released. Refresh before retrying.')
      this.publish(after)
    } catch (error) {
      if (!this.disposed && lifetime === this.lifetime) { this.state = { ...this.state, error: error instanceof Error ? error.message : 'Song shutdown is uncertain. Refresh before retrying.' } }
    } finally { if (lifetime === this.lifetime) this.inFlight = false; if (!this.disposed && lifetime === this.lifetime) { this.state = { ...this.state, busy: false }; for (const listener of this.listeners) listener() } }
  }
  resume(): void { this.lifetime++; this.disposed = false; this.inFlight = false; this.state = { ...this.state, busy: false, restoring: false } }
  dispose(): void { this.lifetime++; this.disposed = true; this.listeners.clear() }
}
