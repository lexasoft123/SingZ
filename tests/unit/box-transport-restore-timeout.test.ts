/**
 * A retained restore whose host read, dynamic import or native attach never
 * settles used to hold the transport `committing` (and the TV on the
 * action-less "Restoring previous song" surface) forever, with engineTail
 * blocked behind it. The deadline supersedes the restore; a completion that
 * arrives after it must not commit.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TrackState } from '../../src/renderer/src/audio/engine'
import type { BoxRetainedPlaybackRecovery, BoxResult, BoxRetainedPlaybackRestore } from '../../src/shared/box-contract'
import type { ParsedGraphDocument } from '../../src/shared/graph-document'
import type { SingzApi } from '../../src/shared/types'
import { BoxTransport, type BoxEngine } from '../../src/renderer/src/box/transport'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { box as english } from '../../src/shared/i18n/en/box'
import { retainedRestore } from '../shared/box-retained-native-fixture'

class AttachEngine implements BoxEngine {
  duration = 0; position = 0; playing = false; starting = false; masterVolume = 1; transpose = 0; tempo = 1
  playbackError = null
  commits = 0
  load(): void {}
  async decode(): Promise<AudioBuffer> { throw new Error('unused') }
  async play(): Promise<void> {}
  pause(): void {}
  toggle(): void {}
  seek(): void {}
  seekBy(): void {}
  setVolume(): void {}
  setMuted(): void {}
  setSolo(): void {}
  setMasterVolume(): void {}
  async setVolumeAccepted(): Promise<void> {}
  async setMutedAccepted(): Promise<void> {}
  async setSoloAccepted(): Promise<void> {}
  async setMasterVolumeAccepted(): Promise<void> {}
  async setTranspose(): Promise<void> {}
  async setTempo(): Promise<void> {}
  async setBeats(): Promise<void> {}
  async setMetronome(): Promise<void> {}
  async setTraining(): Promise<void> {}
  async setRegion(): Promise<void> {}
  getTrackStates(): TrackState[] { return [] }
  setLaneReader(): void {}
  retireForSongSwitch(): void {}
  subscribe(): () => void { return () => {} }
  async teardown(): Promise<void> {}
  async detachPersistentPlayback(): Promise<void> {}
  /** Mirrors MultitrackEngine: confirm, then commit synchronously. */
  async attachRetained(
    _graph: ParsedGraphDocument | null,
    confirm: () => Promise<BoxRetainedPlaybackRecovery | null>,
    commit: () => void
  ): Promise<boolean> {
    const recovery = await confirm()
    if (!recovery) return false
    this.playing = true
    this.duration = 10
    this.commits++
    commit()
    return true
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const ok = (value: BoxRetainedPlaybackRestore): BoxResult<BoxRetainedPlaybackRestore> => ({ ok: true, value })
const expected = { epoch: 'epoch', generation: '7' }
const live: BoxTransport[] = []

function fixture(read: () => Promise<BoxResult<BoxRetainedPlaybackRestore>>) {
  const restoreRetainedPlayback = vi.fn(read)
  const api = { boxAudioPersistent: true, box: { restoreRetainedPlayback } } as unknown as SingzApi
  const engine = new AttachEngine()
  const transport = new BoxTransport(api, engine, { pollMs: 0, restoreTimeoutMs: 40 })
  live.push(transport)
  return { transport, engine, restoreRetainedPlayback }
}

/** Settles `promise` or reports that it is still pending after `ms`. */
function within<T>(promise: Promise<T>, ms = 400): Promise<{ settled: true; value?: T; error?: unknown } | { settled: false }> {
  return Promise.race([
    promise.then(value => ({ settled: true as const, value }), error => ({ settled: true as const, error })),
    new Promise<{ settled: false }>(resolve => setTimeout(() => resolve({ settled: false }), ms))
  ])
}

beforeAll(async () => { await prepareBoxLocale('en') })
afterEach(async () => {
  await Promise.all(live.splice(0).map(transport => within(transport.teardown())))
})

describe('retained restore deadline', () => {
  it('abandons a never-settling host read with an error and ignores its late answer', async () => {
    const hung = deferred<BoxResult<BoxRetainedPlaybackRestore>>()
    const { transport, engine } = fixture(() => hung.promise)
    const outcome = await within(transport.restoreRetained(expected))
    expect(outcome.settled).toBe(true)
    expect(outcome.settled && (outcome.error as Error).message).toBe(english['box.retained.restoreTimedOut'])
    expect(transport.getSnapshot()).toMatchObject({
      active: null, committing: false, loadingName: null, lastError: english['box.retained.restoreTimedOut']
    })

    hung.resolve(ok(retainedRestore('7', 'epoch')))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(engine.commits).toBe(0)
    expect(transport.getSnapshot()).toMatchObject({ active: null, committing: false, loadingName: null })
  })

  it('releases the engine queue when native attach stalls, and a late confirmation cannot commit', async () => {
    const confirm = deferred<BoxResult<BoxRetainedPlaybackRestore>>()
    let reads = 0
    const { transport, engine, restoreRetainedPlayback } = fixture(async () => {
      reads++
      return reads === 1 ? ok(retainedRestore('7', 'epoch')) : await confirm.promise
    })
    const outcome = await within(transport.restoreRetained(expected))
    expect(outcome.settled && (outcome.error as Error).message).toBe(english['box.retained.restoreTimedOut'])
    expect(restoreRetainedPlayback).toHaveBeenCalledTimes(2)
    expect(transport.getSnapshot()).toMatchObject({ active: null, committing: false, loadingName: null })

    confirm.resolve(ok(retainedRestore('7', 'epoch')))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(engine.commits).toBe(0)
    expect(transport.getSnapshot().active).toBeNull()
    // teardown awaits engineTail; before the deadline it hung behind the attach.
    expect((await within(transport.teardown())).settled).toBe(true)
  })

  it('still completes a prompt restore normally', async () => {
    const { transport, engine } = fixture(async () => ok(retainedRestore('7', 'epoch')))
    await expect(transport.restoreRetained(expected)).resolves.toBe(true)
    expect(engine.commits).toBe(1)
    expect(transport.getSnapshot()).toMatchObject({ committing: false, lastError: null })
    expect(transport.getSnapshot().active?.item.dir).toBe('/song')
  })
})
