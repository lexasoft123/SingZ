import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  awaitTrainingCleanupExit,
  confirmTrainingAudioStopped,
  queueTrainingSectionExit,
  TRAINING_CLEANUP_AUDIO_BLOCKED_COPY,
  TRAINING_CLEANUP_SETTINGS_BLOCKED_COPY,
  TRAINING_CLEANUP_SONG_BLOCKED_COPY,
  TrainingCleanupCoordinator
} from '../../src/renderer/src/audio/training-cleanup'
import { SongLoadRequestEpoch } from '../../src/renderer/src/training-ui-state'

describe('app-shell training cleanup lease', () => {
  it('holds a direct Training -> Songs switch until cleanup confirms, once', async () => {
    let confirm!: () => void
    const cleanup = new Promise<void>((resolve) => { confirm = resolve })
    const runCleanup = vi.fn(() => cleanup)
    const coordinator = new TrainingCleanupCoordinator(runCleanup)
    const apply = vi.fn()

    expect(queueTrainingSectionExit('training', 'songs', 'training', coordinator, apply)).toBe(true)
    // A repeated top-nav click updates the retained intent but does not start a
    // second cleanup or navigate through the still-live microphone owner.
    expect(queueTrainingSectionExit('training', 'songs', 'training', coordinator, apply)).toBe(true)
    expect(coordinator.phase).toBe('stopping')
    expect(coordinator.blocksAudio).toBe(true)
    expect(runCleanup).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()

    confirm()
    await cleanup
    await Promise.resolve()
    expect(coordinator.phase).toBe('idle')
    expect(coordinator.blocksAudio).toBe(false)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith('songs')
  })

  it('stays in Training after rejection and performs the latest exit once after retry', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('native token remains owned'))
      .mockResolvedValueOnce(undefined)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const first = vi.fn()
    const latest = vi.fn()

    coordinator.requestExit(first)
    coordinator.requestExit(latest)
    await vi.waitFor(() => expect(coordinator.phase).toBe('unsafe'))
    expect(first).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
    expect(coordinator.blocksAudio).toBe(true)

    coordinator.retry()
    expect(coordinator.phase).toBe('stopping')
    await vi.waitFor(() => expect(coordinator.phase).toBe('idle'))
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledOnce()
  })

  it('cancels a retained exit when Training is selected during stopping cleanup', async () => {
    let confirm!: () => void
    const pending = new Promise<void>((resolve) => { confirm = resolve })
    const cleanup = vi.fn(() => pending)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const apply = vi.fn()

    expect(queueTrainingSectionExit('training', 'songs', 'training', coordinator, apply)).toBe(true)
    expect(coordinator.phase).toBe('stopping')
    expect(queueTrainingSectionExit('training', 'training', 'training', coordinator, apply)).toBe(true)

    confirm()
    await pending
    await vi.waitFor(() => expect(coordinator.phase).toBe('idle'))
    expect(cleanup).toHaveBeenCalledOnce()
    expect(apply).not.toHaveBeenCalled()
  })

  it('cancels an unsafe exit, stays after retry, then performs a later exit once', async () => {
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error('native token remains owned'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const apply = vi.fn()

    queueTrainingSectionExit('training', 'songs', 'training', coordinator, apply)
    await vi.waitFor(() => expect(coordinator.phase).toBe('unsafe'))
    queueTrainingSectionExit('training', 'training', 'training', coordinator, apply)

    await expect(coordinator.retry()).resolves.toBe(true)
    expect(coordinator.phase).toBe('idle')
    expect(apply).not.toHaveBeenCalled()

    queueTrainingSectionExit('training', 'songs', 'training', coordinator, apply)
    await vi.waitFor(() => expect(coordinator.phase).toBe('idle'))
    expect(cleanup).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledWith('songs')
  })

  it('keeps the active Training section as a no-op while cleanup is idle', () => {
    const cleanup = vi.fn().mockResolvedValue(undefined)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const apply = vi.fn()

    expect(queueTrainingSectionExit('training', 'training', 'training', coordinator, apply)).toBe(true)
    expect(coordinator.phase).toBe('idle')
    expect(cleanup).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it('resumes an accepted song with its original token so a later valid request wins', async () => {
    let section = 'training'
    const cleanup = deferred<void>()
    const coordinator = new TrainingCleanupCoordinator(() => cleanup.promise)
    const epoch = new SongLoadRequestEpoch()
    const begin = vi.spyOn(epoch, 'begin')
    const aRegistration = deferred<boolean>()
    const bRegistration = deferred<boolean>()
    const published: string[] = []
    const run = async (name: string, registration: Promise<boolean>): Promise<void> => {
      const request = epoch.begin()
      const valid = await registration
      if (!epoch.isLatest(request) || !valid || !epoch.acceptIfLatest(request)) return
      if (section === 'training') {
        const confirmed = await awaitTrainingCleanupExit(
          coordinator,
          () => epoch.isAccepted(request),
          () => { section = 'songs' }
        )
        if (!confirmed || !epoch.isAccepted(request)) return
      }
      published.push(name)
    }

    const a = run('A', aRegistration.promise)
    aRegistration.resolve(true)
    await vi.waitFor(() => expect(coordinator.phase).toBe('stopping'))
    const b = run('B', bRegistration.promise)

    // Cleanup resolves first, but B's valid registration becomes authoritative
    // before A's retained continuation resumes in the next microtask.
    cleanup.resolve(undefined)
    bRegistration.resolve(true)
    await Promise.all([a, b])
    expect(begin).toHaveBeenCalledTimes(2)
    expect(published).toEqual(['B'])
  })

  it('invalidates a pending registration when stay-in-Training cancels its exit', async () => {
    let section = 'training'
    const firstCleanup = deferred<void>()
    const cleanup = vi.fn()
      .mockImplementationOnce(() => firstCleanup.promise)
      .mockResolvedValueOnce(undefined)
    const coordinator = new TrainingCleanupCoordinator(cleanup)
    const epoch = new SongLoadRequestEpoch()
    const oldRegistration = deferred<boolean>()
    const published: string[] = []
    const apply = (next: string): void => { section = next }
    const run = async (name: string, registration: Promise<boolean>): Promise<void> => {
      const request = epoch.begin()
      const valid = await registration
      if (!epoch.isLatest(request) || !valid || !epoch.acceptIfLatest(request)) return
      if (section === 'training') {
        if (!epoch.isAccepted(request)) return
        const confirmed = await awaitTrainingCleanupExit(
          coordinator,
          () => epoch.isAccepted(request),
          () => { section = 'songs' }
        )
        if (!confirmed || !epoch.isAccepted(request)) return
      }
      published.push(name)
    }

    const oldLoad = run('old', oldRegistration.promise)
    queueTrainingSectionExit(section, 'songs', 'training', coordinator, apply)
    expect(coordinator.phase).toBe('stopping')
    queueTrainingSectionExit(section, 'training', 'training', coordinator, apply, () => epoch.invalidate())
    oldRegistration.resolve(true)
    await oldLoad
    firstCleanup.resolve(undefined)
    await vi.waitFor(() => expect(coordinator.phase).toBe('idle'))
    expect(section).toBe('training')
    expect(published).toEqual([])

    await run('fresh', Promise.resolve(true))
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(section).toBe('songs')
    expect(published).toEqual(['fresh'])
  })

  it('wires App song continuation to the accepted token without recursive loadPath', () => {
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const loadPath = source.slice(source.indexOf('const loadPath:'), source.indexOf('const loadFile ='))
    expect(loadPath).toContain('await awaitTrainingCleanupExit(')
    expect(loadPath).not.toContain('void loadPath(path)')
    expect(source).toContain('() => songLoadRequests.current.invalidate()')
  })

  it('uses an opaque blur-free cleanup gate on Windows', () => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const override = css.match(/body\.win \.vt-cleanup-gate\s*\{([^}]+)\}/s)?.[1] ?? ''
    expect(override).toMatch(/background:\s*var\(--bg\)/)
    expect(override).toMatch(/backdrop-filter:\s*none/)
    expect(override).not.toContain('transparent')
  })

  it('retains cleanup ownership when its route subscriber unmounts', async () => {
    let confirm!: () => void
    const pending = new Promise<void>((resolve) => { confirm = resolve })
    const coordinator = new TrainingCleanupCoordinator(() => pending)
    const listener = vi.fn()
    const unsubscribe = coordinator.subscribe(listener)
    coordinator.requestCleanup()
    expect(listener).toHaveBeenCalledWith('stopping')
    unsubscribe()

    confirm()
    await pending
    await Promise.resolve()
    expect(coordinator.phase).toBe('idle')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('disposes a pending success without a late exit, listener, or renderer mutation', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const lateMutation = vi.fn()
    const exit = vi.fn()
    const listener = vi.fn()
    const coordinator = new TrainingCleanupCoordinator(async (stillOwned) => {
      await pending
      if (stillOwned()) lateMutation()
    })
    coordinator.subscribe(listener)
    const operation = coordinator.requestCleanup()
    coordinator.requestExit(exit)
    expect(listener).toHaveBeenCalledWith('stopping')

    coordinator.dispose()
    coordinator.dispose()
    finish()
    await expect(operation).resolves.toBe(false)
    expect(coordinator.phase).toBe('stopping')
    expect(coordinator.blocksAudio).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    expect(lateMutation).not.toHaveBeenCalled()
    await expect(coordinator.requestCleanup()).resolves.toBe(false)
    await expect(coordinator.retry()).resolves.toBe(false)
    coordinator.requestExit(exit)
    expect(exit).not.toHaveBeenCalled()
    const afterDispose = vi.fn()
    coordinator.subscribe(afterDispose)
    expect(afterDispose).not.toHaveBeenCalled()
  })

  it('ignores a late cleanup rejection after disposal without publishing unsafe', async () => {
    let fail!: (reason?: unknown) => void
    const pending = new Promise<void>((_resolve, reject) => { fail = reject })
    const listener = vi.fn()
    const exit = vi.fn()
    const coordinator = new TrainingCleanupCoordinator(() => pending)
    coordinator.subscribe(listener)
    coordinator.requestExit(exit)
    const operation = coordinator.requestCleanup()
    coordinator.dispose()
    fail(new Error('late native rejection'))

    await expect(operation).resolves.toBe(false)
    expect(coordinator.phase).toBe('stopping')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).not.toHaveBeenCalledWith('unsafe')
    expect(exit).not.toHaveBeenCalled()
  })

  it('disposes the coordinator before microphone and cue renderer teardown', () => {
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toMatch(
      /trainingCleanupCoordinator\.dispose\(\)[\s\S]*trainingMic\.dispose\(\)[\s\S]*trainingCues\.dispose\(\)/
    )
  })

  it('attempts every owner and only clears the microphone after awaited stop', async () => {
    const order: string[] = []
    let finish!: () => void
    const stopped = new Promise<void>((resolve) => { finish = resolve })
    const operation = confirmTrainingAudioStopped({
      pauseSong: () => order.push('pause'),
      cancelCues: () => order.push('cues'),
      interruptTraining: () => order.push('interrupt'),
      stopMicrophone: () => { order.push('stop-start'); return stopped },
      clearMicrophoneDevice: () => order.push('clear')
    })
    expect(order).toEqual(['pause', 'cues', 'interrupt', 'stop-start'])
    finish()
    await operation
    expect(order).toEqual(['pause', 'cues', 'interrupt', 'stop-start', 'clear'])
  })

  it('keeps training cleanup guidance distinct from monitor/output recovery', () => {
    for (const copy of [
      TRAINING_CLEANUP_SONG_BLOCKED_COPY,
      TRAINING_CLEANUP_SETTINGS_BLOCKED_COPY,
      TRAINING_CLEANUP_AUDIO_BLOCKED_COPY
    ]) {
      expect(copy).toContain('Vocal training')
      expect(copy).not.toContain('output route')
      expect(copy).not.toContain('top-bar Stop')
    }
  })
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}
