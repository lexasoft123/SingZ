import { Children, createElement, type ReactElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  audioSafetyLeaseKind,
  applyAfterMonitorStops,
  DesktopMonitorCoordinator,
  runSongTransportToggle,
  SONG_TRANSPORT_AUDIO_LEASE_COPY,
  SettingsRouteApplicationQueue
} from '../../src/renderer/src/audio/monitoring'
import {
  applyPlaybackOutputSelection,
  canRetrySettingsAfterPlaybackRouteFailure,
  PLAYBACK_OUTPUT_UNCONFIRMED_COPY,
  PlaybackOutputArbiter,
  PlaybackOutputRouteSafety,
  PlaybackOutputSelectionError,
  type PlaybackOutputReconcileResult
} from '../../src/renderer/src/audio/output-routing'
import SettingsModal, {
  closeMonitorSettings,
  nativeOwnershipWasReleased,
  OutputRouteRecovery,
  runOutputRouteRetry,
  settingsInputChannelRoute,
  settingsInputDeviceRoute,
  settingsInputPropCommitDecision,
  settingsInputRouteSignature,
  settingsPreviewRestartDecision,
  settingsPreviewCanStart,
  type SettingsModalProps
} from '../../src/renderer/src/components/SettingsModal'
import PersistentMonitorControl from '../../src/renderer/src/components/PersistentMonitorControl'
import { pitchMicrophoneUnavailableCopy } from '../../src/renderer/src/components/PitchStrip'
import VocalTraining, {
  scheduleTrainingFeedbackAdvance,
  shouldAutoStartTrainingPrompt,
  TRAINING_AUDIO_LEASE_COPY,
  runTrainingAudioAction
} from '../../src/renderer/src/components/VocalTraining'
import { emptyTrainingProgress } from '../../src/shared/training-progress'
import { TRAINING_CLEANUP_AUDIO_BLOCKED_COPY } from '../../src/renderer/src/audio/training-cleanup'
import {
  desktopTrainingReducer,
  INITIAL_DESKTOP_TRAINING_STATE
} from '../../src/renderer/src/training-ui-state'
import type {
  DesktopMonitorResult,
  DesktopMonitorStatus
} from '../../src/shared/types'

const nativeResult = (): DesktopMonitorResult => ({
  ok: true,
  ownershipGeneration: '73',
  state: 'running',
  errorCode: 'none',
  error: '',
  format: {
    sampleRate: 48000,
    maximumFrames: 512,
    nominalBufferFrames: 128,
    inputChannels: 1,
    outputChannels: 2,
    sampleFormat: 'float32-planar',
    outputClockMaster: true,
    accessMode: 'shared'
  },
  latency: {
    inputDeviceFrames: 32,
    outputDeviceFrames: 48,
    bufferFrames: 128,
    externalRouteFrames: 0
  }
})

const nativeStatus = (enabled: boolean, callbacks: string): DesktopMonitorStatus => ({
  active: true,
  enabled,
  deviceLost: false,
  ownershipGeneration: '73',
  gainDb: -6,
  state: 'running',
  error: '',
  pre: { peak: 0.5, rms: 0.25, frames: '128' },
  post: { peak: 0.25, rms: 0.125, frames: '128' },
  format: nativeResult().format,
  latency: nativeResult().latency,
  routeGeneration: '1',
  streamGeneration: '1',
  callbacks,
  renderedFrames: '128',
  xruns: '0',
  deadlineMisses: '0',
  renderFailures: '0',
  adapterRenderFailures: 0,
  terminalRenderFailures: 0,
  adapterLastStatusCode: 0,
  parameterOverflows: 0,
  nonFiniteSamples: 0,
  rejectedBlocks: 0
})

function harness(): {
  coordinator: DesktopMonitorCoordinator
  endMonitor: ReturnType<typeof vi.fn>
  restoreLegacyOutput: ReturnType<typeof vi.fn>
} {
  const statuses = [nativeStatus(false, '1'), nativeStatus(true, '2')]
  const endMonitor = vi.fn(async () => ({ ...nativeResult(), state: 'stopped' as const }))
  const restoreLegacyOutput = vi.fn(async () => undefined)
  const coordinator = new DesktopMonitorCoordinator({
    api: {
      beginMonitor: vi.fn(async () => nativeResult()),
      setMonitorGain: vi.fn(async () => nativeResult()),
      monitorStatus: vi.fn(async () => statuses.shift() ?? nativeStatus(true, '3')),
      endMonitor
    },
    stopPreview: vi.fn(async () => undefined),
    pauseSong: vi.fn(),
    releaseLegacyOutput: vi.fn(async () => undefined),
    restoreLegacyOutput,
    sleep: async () => undefined,
    callbackTimeoutMs: 10,
    pollMs: 1
  })
  return { coordinator, endMonitor, restoreLegacyOutput }
}

const config = {
  inputDeviceUid: 'coreaudio:usb',
  outputDeviceUid: 'coreaudio:usb',
  inputChannels: [2],
  outputChannels: [0, 1],
  sampleRate: 48000,
  bufferFrames: 128,
  maximumFrames: 512,
  exclusive: false
}

const outputDevice = (deviceId: string): MediaDeviceInfo => ({
  deviceId,
  groupId: 'outputs',
  kind: 'audiooutput',
  label: deviceId,
  toJSON: () => ({})
})

describe('playback output latest-intent arbitration', () => {
  it.each([
    ['a concrete output', 'B'],
    ['the system default', undefined]
  ] as const)(
    'invalidates a reconcile paused in inventory before selecting %s',
    async (_name, selected) => {
      let finishInventory!: (devices: readonly MediaDeviceInfo[]) => void
      const inventory = new Promise<readonly MediaDeviceInfo[]>((resolve) => {
        finishInventory = resolve
      })
      const setOutput = vi.fn(async () => undefined)
      const commit = vi.fn()
      const arbiter = new PlaybackOutputArbiter('A', {
        setOutput,
        enumerateOutputs: vi.fn(() => inventory),
        commit
      })

      const reconcile = arbiter.reconcile()
      await Promise.resolve()
      const direct = arbiter.select(selected)
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(selected ?? ''))
      finishInventory([outputDevice('A'), outputDevice('B')])

      await expect(reconcile).resolves.toEqual({ kind: 'stale' })
      await expect(direct).resolves.toBe(true)
      expect(setOutput).toHaveBeenCalledTimes(1)
      expect(setOutput).toHaveBeenCalledWith(selected ?? '')
      expect(commit).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenCalledWith(selected)
    }
  )

  it.each([
    ['a concrete output', 'B'],
    ['the system default', undefined]
  ] as const)(
    'reconciles current desired intent when devicechange arrives during %s apply',
    async (_name, selected) => {
      let finishDirect!: () => void
      const directGate = new Promise<void>((resolve) => { finishDirect = resolve })
      const setOutput = vi.fn(async (sinkId: string) => {
        if (setOutput.mock.calls.length === 1) await directGate
        expect(sinkId).toBe(selected ?? '')
      })
      const commit = vi.fn()
      const enumerateOutputs = vi.fn(async () => [outputDevice('A'), outputDevice('B')])
      const arbiter = new PlaybackOutputArbiter('A', {
        setOutput,
        enumerateOutputs,
        commit
      })

      const direct = arbiter.select(selected)
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledTimes(1))
      const deviceChange = arbiter.reconcile()
      finishDirect()

      await expect(direct).resolves.toBe(true)
      await expect(deviceChange).resolves.toEqual({ kind: 'applied', outputId: selected })
      expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual([
        selected ?? '', selected ?? ''
      ])
      expect(enumerateOutputs).toHaveBeenCalledTimes(selected ? 1 : 0)
      expect(commit).toHaveBeenCalledOnce()
      expect(commit).toHaveBeenCalledWith(selected)
    }
  )

  it('prevents a pending B selection from committing after a quick C selection', async () => {
    let finishB!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('B'), outputDevice('C')]),
      commit
    })

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = arbiter.select('C')
    finishB()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).resolves.toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith('C')
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C'])
  })

  it('physically restores committed A when superseded B succeeded but current C fails', async () => {
    let finishB!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
      if (sinkId === 'C') throw new Error('C handoff failed')
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [
        outputDevice('A'), outputDevice('B'), outputDevice('C')
      ]),
      commit
    })

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = arbiter.select('C')
    finishB()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).rejects.toMatchObject({
      name: 'PlaybackOutputSelectionError',
      current: true,
      repairRequired: false
    } satisfies Partial<PlaybackOutputSelectionError>)
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A'])
    expect(commit).not.toHaveBeenCalled()

    await expect(arbiter.reconcile()).resolves.toEqual({ kind: 'applied', outputId: 'A' })
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A', 'A'])
  })

  it('lets quick newer D win when C rollback is still settling', async () => {
    let finishB!: () => void
    let failRollback!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    const rollbackGate = new Promise<void>((_resolve, reject) => {
      failRollback = () => reject(new Error('A rollback failed'))
    })
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) await rollbackGate
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [
        outputDevice('A'), outputDevice('B'), outputDevice('C'), outputDevice('D')
      ]),
      commit
    })

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = arbiter.select('C')
    finishB()
    await vi.waitFor(() => expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A']))
    const selectD = arbiter.select('D')
    failRollback()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).rejects.toMatchObject({
      name: 'PlaybackOutputSelectionError',
      current: false,
      repairRequired: false
    } satisfies Partial<PlaybackOutputSelectionError>)
    await expect(selectD).resolves.toBe(true)
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A', 'D'])
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith('D')
  })

  it('leaves double-failure repair to an awaited caller after rollback fails', async () => {
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) throw new Error('A rollback failed')
    })
    const enumerateOutputs = vi.fn(async () => [outputDevice('A'), outputDevice('C')])
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs,
      commit: vi.fn()
    })

    let failure: PlaybackOutputSelectionError | null = null
    try {
      await arbiter.select('C')
    } catch (error) {
      failure = error as PlaybackOutputSelectionError
    }
    expect(failure).toMatchObject({
      name: 'PlaybackOutputSelectionError',
      current: true,
      repairRequired: true
    } satisfies Partial<PlaybackOutputSelectionError>)

    await Promise.resolve()
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A'])
    await expect(arbiter.repairSelectionFailure(failure!)).resolves.toEqual({
      kind: 'applied', outputId: 'A'
    })
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A', 'A'])
    expect(enumerateOutputs).toHaveBeenCalledOnce()
  })

  it('retains one app safety lease when B landed but C, rollback A and repair A all fail', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const unconfirmedChanges: boolean[] = []
    const acquireLease = vi.spyOn(coordinator, 'acquireRouteTransitionLease')
    const routeSafety = new PlaybackOutputRouteSafety(
      () => coordinator.acquireRouteTransitionLease(),
      (unconfirmed) => unconfirmedChanges.push(unconfirmed)
    )
    let finishB!: () => void
    const bGate = new Promise<void>((resolve) => { finishB = resolve })
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') await bGate
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls <= 2) throw new Error('A handoff failed')
    })
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [
        outputDevice('A'), outputDevice('B'), outputDevice('C'), outputDevice('D')
      ]),
      commit: vi.fn()
    })
    let routeStatus: string | null = null
    const changesStarted = vi.fn()
    const changeOutput = async (outputId: string): Promise<void> => {
      changesStarted(outputId)
      try {
        if (await arbiter.select(outputId)) {
          routeSafety.confirmCurrentRoute()
          routeStatus = null
        }
      } catch (error) {
        if (!(error instanceof PlaybackOutputSelectionError) || !error.current) return
        if (!error.repairRequired) return
        routeSafety.retainUnconfirmed()
        try {
          const repair = await arbiter.repairSelectionFailure(error)
          if (repair.kind !== 'stale') {
            routeSafety.confirmCurrentRoute()
            routeStatus = null
          }
        } catch (repairError) {
          routeStatus = PLAYBACK_OUTPUT_UNCONFIRMED_COPY
          throw repairError
        }
      }
    }

    const selectB = arbiter.select('B')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('B'))
    const selectC = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => changeOutput('C'),
      vi.fn()
    )
    await vi.waitFor(() => expect(changesStarted).toHaveBeenCalledWith('C'))
    finishB()

    await expect(selectB).resolves.toBe(false)
    await expect(selectC).rejects.toThrow('A handoff failed')
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'C', 'A', 'A'])
    expect(routeStatus).toBe(PLAYBACK_OUTPUT_UNCONFIRMED_COPY)
    expect(routeStatus).not.toContain('system default')
    expect(routeSafety.unconfirmed).toBe(true)
    expect(coordinator.hasRouteTransitionLease).toBe(true)
    // One queue lease plus one retained app lease; another failure/notification
    // reuses the retained owner instead of leaking a third lease.
    expect(acquireLease).toHaveBeenCalledTimes(2)
    routeSafety.retainUnconfirmed()
    expect(acquireLease).toHaveBeenCalledTimes(2)
    expect(unconfirmedChanges).toEqual([true])

    const shell = renderToStaticMarkup(createElement(PersistentMonitorControl, {
      snapshot: coordinator.shellSnapshot,
      routeUnconfirmed: routeSafety.unconfirmed,
      onOpenSettings: vi.fn(),
      onStop: vi.fn()
    }))
    expect(shell).toContain('Audio route needs attention')
    expect(shell).not.toContain('persistent-monitor-stop')

    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => changeOutput('D'),
      vi.fn()
    )).resolves.toBe(true)
    expect(routeStatus).toBeNull()
    expect(routeSafety.unconfirmed).toBe(false)
    expect(coordinator.hasRouteTransitionLease).toBe(false)
    expect(unconfirmedChanges).toEqual([true, false])

    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toMatch(
      /outputRouteSafety\.retainUnconfirmed\(\)[\s\S]*await reconcileOutput\(err\)[\s\S]*repair\?\.kind === 'unconfirmed'\) throw repair\.error/
    )
    expect(appSource).toMatch(
      /if \(await outputArbiter\.select\(id\)\)[\s\S]*outputRouteSafety\.confirmCurrentRoute\(\)/
    )
  })

  it('claims a missing saved device uses default only after the default sink settles', async () => {
    let finishDefault!: () => void
    const defaultGate = new Promise<void>((resolve) => { finishDefault = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      expect(sinkId).toBe('')
      await defaultGate
    })
    const arbiter = new PlaybackOutputArbiter('missing-output', {
      setOutput,
      enumerateOutputs: vi.fn(async () => []),
      commit: vi.fn()
    })
    let settled = false
    const repair = arbiter.reconcile().finally(() => { settled = true })

    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(''))
    expect(settled).toBe(false)
    finishDefault()

    await expect(repair).resolves.toEqual({
      kind: 'missing', outputId: 'missing-output'
    })
    expect(settled).toBe(true)
  })

  it('releases a retained route lease once after a current authoritative reconcile', async () => {
    const release = vi.fn()
    const unconfirmedChanges: boolean[] = []
    const routeSafety = new PlaybackOutputRouteSafety(
      () => ({ release }),
      (unconfirmed) => unconfirmedChanges.push(unconfirmed)
    )
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput: vi.fn(async () => undefined),
      enumerateOutputs: vi.fn(async () => [outputDevice('A')]),
      commit: vi.fn()
    })
    routeSafety.retainUnconfirmed()

    const result = await arbiter.reconcile()
    expect(result).toEqual({ kind: 'applied', outputId: 'A' })
    if (result.kind !== 'stale') routeSafety.confirmCurrentRoute()
    routeSafety.confirmCurrentRoute()

    expect(routeSafety.unconfirmed).toBe(false)
    expect(unconfirmedChanges).toEqual([true, false])
    expect(release).toHaveBeenCalledOnce()
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toMatch(
      /if \(result\.kind === 'stale'\) \{[\s\S]*if \(retry\) throw[\s\S]*return[\s\S]*\}\s+outputRouteSafety\.confirmCurrentRoute\(\)/
    )
  })

  it('runs explicit output recovery behind cleanup and restarts preview only after success', async () => {
    const { coordinator } = harness()
    const release = vi.fn()
    const routeSafety = new PlaybackOutputRouteSafety(
      () => ({ release }),
      vi.fn()
    )
    routeSafety.retainUnconfirmed()
    const events: string[] = []
    const arbiter = new PlaybackOutputArbiter(undefined, {
      setOutput: vi.fn(async (sinkId: string) => { events.push(`sink:${sinkId || 'default'}`) }),
      enumerateOutputs: vi.fn(async () => []),
      commit: vi.fn()
    })
    const queue = new SettingsRouteApplicationQueue()
    queue.subscribePreviewRestart(() => events.push('preview'))

    await runOutputRouteRetry(
      (apply) => queue.schedule(
        coordinator,
        () => coordinator.stop(),
        apply,
        vi.fn()
      ),
      async () => {
        const result = await arbiter.reconcile()
        if (result.kind === 'stale') throw new Error('superseded')
        routeSafety.confirmCurrentRoute()
        return result
      }
    )

    expect(events).toEqual(['sink:default', 'preview'])
    expect(routeSafety.unconfirmed).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    // Confirmation is idempotent if a sibling devicechange reports the same
    // now-current route immediately after the explicit retry.
    routeSafety.confirmCurrentRoute()
    expect(release).toHaveBeenCalledOnce()
  })

  it('retains output safety and rejects truthfully when explicit recovery fails', async () => {
    const { coordinator } = harness()
    const release = vi.fn()
    const routeSafety = new PlaybackOutputRouteSafety(
      () => ({ release }),
      vi.fn()
    )
    routeSafety.retainUnconfirmed()
    const arbiter = new PlaybackOutputArbiter(undefined, {
      setOutput: vi.fn(async () => { throw new Error('default sink unavailable') }),
      enumerateOutputs: vi.fn(async () => []),
      commit: vi.fn()
    })
    const queue = new SettingsRouteApplicationQueue()

    await expect(runOutputRouteRetry(
      (apply) => queue.schedule(
        coordinator,
        () => coordinator.stop(),
        apply,
        vi.fn()
      ),
      async () => {
        try {
          const result = await arbiter.reconcile()
          if (result.kind === 'stale') throw new Error('superseded')
          routeSafety.confirmCurrentRoute()
          return result
        } catch (error) {
          routeSafety.retainUnconfirmed()
          throw error
        }
      }
    )).rejects.toThrow('default sink unavailable')

    expect(routeSafety.unconfirmed).toBe(true)
    expect(release).not.toHaveBeenCalled()
    expect(queue.busy).toBe(false)
  })

  it('notifies a reopened Settings owner when an app-lifetime retry fails and becomes retryable again', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let finishRetry!: () => void
    const retryGate = new Promise<void>((resolve) => { finishRetry = resolve })
    const oldOwner = vi.fn()
    const unsubscribeOldOwner = queue.subscribeBusy(oldOwner)
    const firstRetry = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      async () => {
        await retryGate
        throw new Error('route still unavailable')
      },
      vi.fn()
    )

    await vi.waitFor(() => expect(queue.busySnapshot()).toBe(true))
    expect(oldOwner).toHaveBeenCalledOnce()
    const pendingHtml = renderToStaticMarkup(createElement(OutputRouteRecovery, {
      unconfirmed: true,
      busy: queue.busySnapshot(),
      state: 'idle',
      status: PLAYBACK_OUTPUT_UNCONFIRMED_COPY,
      onRetry: vi.fn()
    }))
    expect(pendingHtml).toMatch(/<button[^>]+disabled=""/)

    // Close the first modal and subscribe the replacement while the retained
    // app-shell operation is still the only changing state.
    unsubscribeOldOwner()
    const reopenedSnapshots: boolean[] = []
    const unsubscribeReopened = queue.subscribeBusy(() => {
      reopenedSnapshots.push(queue.busySnapshot())
    })
    finishRetry()
    await expect(firstRetry).rejects.toThrow('route still unavailable')
    expect(reopenedSnapshots).toEqual([false])

    const settledHtml = renderToStaticMarkup(createElement(OutputRouteRecovery, {
      unconfirmed: true,
      busy: queue.busySnapshot(),
      state: 'idle',
      status: PLAYBACK_OUTPUT_UNCONFIRMED_COPY,
      onRetry: vi.fn()
    }))
    expect(settledHtml).toContain('Retry output route')
    expect(settledHtml).not.toMatch(/<button[^>]+disabled=""/)

    await expect(runOutputRouteRetry(
      (apply) => queue.schedule(
        coordinator,
        () => coordinator.stop(),
        apply,
        vi.fn()
      ),
      async () => undefined
    )).resolves.toBeUndefined()
    expect(reopenedSnapshots).toEqual([false, true, false])
    unsubscribeReopened()

    const settingsSource = readFileSync(
      'src/renderer/src/components/SettingsModal.tsx',
      'utf8'
    )
    expect(settingsSource).toContain('useSyncExternalStore(')
    expect(settingsSource).toContain('routeApplicationQueue.subscribeBusy')
    expect(settingsSource).toContain('routeApplicationQueue.busySnapshot')
  })

  it('releases a retained route lease after a current failed pick rolls back successfully', async () => {
    const release = vi.fn()
    const unconfirmedChanges: boolean[] = []
    const routeSafety = new PlaybackOutputRouteSafety(
      () => ({ release }),
      (unconfirmed) => unconfirmedChanges.push(unconfirmed)
    )
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'B') throw new Error('B handoff failed')
    })
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('B')]),
      commit: vi.fn()
    })
    routeSafety.retainUnconfirmed()
    let status: string | null = PLAYBACK_OUTPUT_UNCONFIRMED_COPY

    try {
      await arbiter.select('B')
    } catch (error) {
      expect(error).toMatchObject({
        name: 'PlaybackOutputSelectionError',
        current: true,
        repairRequired: false
      } satisfies Partial<PlaybackOutputSelectionError>)
      if (error instanceof PlaybackOutputSelectionError && error.current && !error.repairRequired) {
        routeSafety.confirmCurrentRoute()
        status = 'Could not switch to that device — still on the previous one'
      }
    }

    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['B', 'A'])
    expect(status).toContain('still on the previous one')
    expect(routeSafety.unconfirmed).toBe(false)
    expect(unconfirmedChanges).toEqual([true, false])
    expect(release).toHaveBeenCalledOnce()

    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toMatch(
      /err instanceof PlaybackOutputSelectionError && !err\.repairRequired\)[\s\S]*outputRouteSafety\.confirmCurrentRoute\(\)[\s\S]*still on the previous one/
    )
  })

  it('does not let a stale selection failure release retained route safety', async () => {
    const release = vi.fn()
    const routeSafety = new PlaybackOutputRouteSafety(
      () => ({ release }),
      vi.fn()
    )
    routeSafety.retainUnconfirmed()
    let finishRollback!: () => void
    const rollbackGate = new Promise<void>((resolve) => { finishRollback = resolve })
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) await rollbackGate
    })
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('C'), outputDevice('D')]),
      commit: vi.fn()
    })

    const failed = arbiter.select('C')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('A'))
    const newer = arbiter.select('D')
    finishRollback()
    let failure!: PlaybackOutputSelectionError
    try {
      await failed
    } catch (error) {
      failure = error as PlaybackOutputSelectionError
      // This is the App boundary: stale selection errors return before either
      // the successful-rollback confirmation or repair branch.
      if (failure.current && !failure.repairRequired) routeSafety.confirmCurrentRoute()
    }
    await expect(newer).resolves.toBe(true)

    expect(failure).toMatchObject({ current: false, repairRequired: false })
    expect(routeSafety.unconfirmed).toBe(true)
    expect(release).not.toHaveBeenCalled()
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toMatch(
      /if \(err instanceof PlaybackOutputSelectionError && !err\.current\) return[\s\S]*if \(err instanceof PlaybackOutputSelectionError && !err\.repairRequired\)/
    )
  })

  it('re-retains route safety when a later repair fails after a concurrent reconcile succeeded', async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = []
    const acquireLease = vi.fn(() => {
      const release = vi.fn()
      releases.push(release)
      return { release }
    })
    const unconfirmedChanges: boolean[] = []
    const routeSafety = new PlaybackOutputRouteSafety(
      acquireLease,
      (unconfirmed) => unconfirmedChanges.push(unconfirmed)
    )
    let finishRepairInventory!: (devices: readonly MediaDeviceInfo[]) => void
    const repairInventory = new Promise<readonly MediaDeviceInfo[]>((resolve) => {
      finishRepairInventory = resolve
    })
    let inventoryCalls = 0
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A') {
        aCalls += 1
        if (aCalls === 1) throw new Error('A rollback failed')
        if (aCalls === 3) throw new Error('A repair failed')
      }
    })
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(() => {
        inventoryCalls += 1
        return inventoryCalls === 1
          ? repairInventory
          : Promise.resolve([outputDevice('A'), outputDevice('C')])
      }),
      commit: vi.fn()
    })
    let selectionFailure!: PlaybackOutputSelectionError
    try {
      await arbiter.select('C')
    } catch (error) {
      selectionFailure = error as PlaybackOutputSelectionError
    }
    expect(selectionFailure).toMatchObject({ current: true, repairRequired: true })
    routeSafety.retainUnconfirmed()

    const settleRoute = async (
      operation: () => Promise<PlaybackOutputReconcileResult>
    ): Promise<'confirmed' | 'unconfirmed' | 'stale'> => {
      try {
        const result = await operation()
        if (result.kind === 'stale') return 'stale'
        routeSafety.confirmCurrentRoute()
        return 'confirmed'
      } catch {
        routeSafety.retainUnconfirmed()
        return 'unconfirmed'
      }
    }

    const repair = settleRoute(() => arbiter.repairSelectionFailure(selectionFailure))
    await vi.waitFor(() => expect(inventoryCalls).toBe(1))
    await expect(settleRoute(() => arbiter.reconcile())).resolves.toBe('confirmed')
    expect(routeSafety.unconfirmed).toBe(false)
    expect(releases[0]).toHaveBeenCalledOnce()

    finishRepairInventory([outputDevice('A'), outputDevice('C')])
    await expect(repair).resolves.toBe('unconfirmed')
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A', 'A', 'A'])
    expect(routeSafety.unconfirmed).toBe(true)
    expect(acquireLease).toHaveBeenCalledTimes(2)
    expect(releases[1]).not.toHaveBeenCalled()
    expect(unconfirmedChanges).toEqual([true, false, true])

    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toMatch(
      /catch \(err\) \{\s*\/\/ The arbiter only surfaces[\s\S]*outputRouteSafety\.retainUnconfirmed\(\)[\s\S]*return \{ kind: 'unconfirmed'/
    )
  })

  it('does not let an awaited repair overwrite a newer direct intent', async () => {
    let aCalls = 0
    const setOutput = vi.fn(async (sinkId: string) => {
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) throw new Error('A rollback failed')
    })
    let finishInventory!: (devices: readonly MediaDeviceInfo[]) => void
    const inventory = new Promise<readonly MediaDeviceInfo[]>((resolve) => {
      finishInventory = resolve
    })
    const commit = vi.fn()
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(() => inventory),
      commit
    })
    let failure!: PlaybackOutputSelectionError
    try {
      await arbiter.select('C')
    } catch (error) {
      failure = error as PlaybackOutputSelectionError
    }

    const repair = arbiter.repairSelectionFailure(failure)
    await Promise.resolve()
    const newer = arbiter.select('D')
    finishInventory([outputDevice('A'), outputDevice('C'), outputDevice('D')])

    await expect(repair).resolves.toEqual({ kind: 'stale' })
    await expect(newer).resolves.toBe(true)
    expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual(['C', 'A', 'D'])
    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith('D')
  })

  it('treats a superseded inventory rejection as stale but surfaces the current one', async () => {
    let rejectOldInventory!: (error: Error) => void
    const oldInventory = new Promise<readonly MediaDeviceInfo[]>((_resolve, reject) => {
      rejectOldInventory = reject
    })
    const enumerateOutputs = vi.fn()
      .mockReturnValueOnce(oldInventory)
      .mockRejectedValueOnce(new Error('current inventory failed'))
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput: vi.fn(async () => undefined),
      enumerateOutputs,
      commit: vi.fn()
    })

    const stale = arbiter.reconcile()
    await Promise.resolve()
    const current = arbiter.reconcile()
    rejectOldInventory(new Error('old inventory failed'))

    await expect(stale).resolves.toEqual({ kind: 'stale' })
    await expect(current).rejects.toThrow('current inventory failed')
  })

  it.each([
    ['a concrete output', 'B'],
    ['the system default', undefined]
  ] as const)(
    'restores the committed intent when selecting %s fails before queued repair',
    async (_name, selected) => {
      let failDirect!: () => void
      const directGate = new Promise<void>((_resolve, reject) => {
        failDirect = () => reject(new Error('direct handoff failed'))
      })
      const targetSink = selected ?? ''
      const setOutput = vi.fn(async (sinkId: string) => {
        if (sinkId === targetSink && setOutput.mock.calls.length === 1) await directGate
      })
      const commit = vi.fn()
      const arbiter = new PlaybackOutputArbiter('A', {
        setOutput,
        enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('B')]),
        commit
      })

      const direct = arbiter.select(selected)
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(targetSink))
      const deviceChange = arbiter.reconcile()
      failDirect()

      await expect(direct).rejects.toMatchObject({
        name: 'PlaybackOutputSelectionError',
        current: true
      } satisfies Partial<PlaybackOutputSelectionError>)
      await expect(deviceChange).resolves.toEqual({ kind: 'applied', outputId: 'A' })
      expect(setOutput.mock.calls.map(([sink]) => sink)).toEqual([targetSink, 'A', 'A'])
      expect(commit).not.toHaveBeenCalled()
    }
  )
})

function settingsProps(coordinator: DesktopMonitorCoordinator): SettingsModalProps {
  return {
    audio: { inputChannel: 2 },
    onChangeOutput: vi.fn(),
    onChangeInput: vi.fn(),
    onMigrateNativeInput: vi.fn(),
    onChangeInputChannel: vi.fn(),
    onChangeNativeMonitorOutput: vi.fn(),
    onChangeNativeMonitorOutputChannels: vi.fn(),
    onChangeMonitorGain: vi.fn(),
    monitorCoordinator: coordinator,
    routeApplicationQueue: new SettingsRouteApplicationQueue(),
    emergencyStopMonitoring: vi.fn(() => coordinator.stop()),
    hasMonitorSafetyLease: vi.fn(() => coordinator.hasAudioSafetyLease),
    canRetrySettingsAfterUnsafeStop: vi.fn(() => coordinator.hasRouteOnlySafetyLease),
    outputRouteUnconfirmed: false,
    onRetryOutputRoute: vi.fn(async () => ({ kind: 'applied' as const, outputId: undefined })),
    outputStatus: null,
    micDevice: null,
    onClose: vi.fn()
  }
}

describe('persistent app-shell monitoring ownership', () => {
  it('uses one stable restart generation for joined Stop and a new one for the next Stop', async () => {
    const { coordinator } = harness()
    const first = coordinator.stop()
    const firstGeneration = coordinator.stopTransitionGeneration
    const joined = coordinator.stop()
    expect(coordinator.stopTransitionGeneration).toBe(firstGeneration)
    await Promise.all([first, joined])

    await coordinator.stop()
    expect(coordinator.stopTransitionGeneration).toBe(firstGeneration + 1)
  })

  it('invalidates one-use confirmation only when native ownership is released', () => {
    expect(nativeOwnershipWasReleased(true, false)).toBe(true)
    expect(nativeOwnershipWasReleased(false, false)).toBe(false)
    expect(nativeOwnershipWasReleased(false, true)).toBe(false)
    expect(nativeOwnershipWasReleased(true, true)).toBe(false)

    const settingsSource = readFileSync(
      'src/renderer/src/components/SettingsModal.tsx',
      'utf8'
    )
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(settingsSource).toMatch(
      /nativeOwnershipWasReleased\(nativeOwnershipRef\.current, shell\.hasNativeOwnership\)[\s\S]*setHeadphonesConfirmed\(false\)[\s\S]*nativeOwnershipRef\.current = shell\.hasNativeOwnership/
    )
    expect(appSource).toContain('onStop={() => monitorCoordinator.stop()}')
  })

  it('preserves pre-start confirmation across ordinary shell changes, then clears on Stop', async () => {
    const { coordinator } = harness()
    let headphonesConfirmed = true
    let previousOwnership = coordinator.hasNativeOwnership
    const unsubscribe = coordinator.subscribeShell((shell) => {
      if (nativeOwnershipWasReleased(previousOwnership, shell.hasNativeOwnership)) {
        headphonesConfirmed = false
      }
      previousOwnership = shell.hasNativeOwnership
    })

    const routeLease = coordinator.acquireRouteTransitionLease()
    routeLease.release()
    expect(headphonesConfirmed).toBe(true)

    expect(await coordinator.start(config, -6)).toBe(true)
    expect(coordinator.hasNativeOwnership).toBe(true)
    headphonesConfirmed = true
    await coordinator.stop()
    expect(coordinator.hasNativeOwnership).toBe(false)
    expect(headphonesConfirmed).toBe(false)
    unsubscribe()
  })

  it('makes the pitch microphone visibly unavailable during Settings or an audio lease', () => {
    const source = readFileSync('src/renderer/src/components/PitchStrip.tsx', 'utf8')
    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(source).toContain('audioLeaseBlocked?: boolean')
    expect(source).toContain("mic === 'starting' || micUnavailableCopy !== null")
    expect(source).toContain('title={micUnavailableCopy ??')
    expect(source).toContain('aria-label={micUnavailableCopy ??')
    expect(source).toContain('Microphone unavailable while Settings is open')
    expect(source).toContain("audioSafetyBlockedCopy('Microphone')")
    expect(source).toContain('setSuspended(settingsOwnsMic || audioLeaseBlocked)')
    expect(appSource).toContain('settingsOwnsMic={showSettings}')
    expect(appSource).toContain(
      "monitorShell.hasAudioSafetyLease || trainingCleanupPhase !== 'idle'"
    )
  })

  it('treats a healthy Settings preview as safety, not unresolved app-shell cleanup', async () => {
    const { coordinator } = harness()
    const previewLease = coordinator.registerPreviewStop(async () => true)

    expect(coordinator.hasAudioSafetyLease).toBe(true)
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(false)
    expect(PersistentMonitorControl({
      snapshot: coordinator.shellSnapshot,
      onOpenSettings: vi.fn(),
      onStop: vi.fn()
    })).toBeNull()

    await previewLease.stopAndRelease()
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('exposes app-shell retry only while preview release is pending or failed', async () => {
    const { coordinator } = harness()
    let releaseStop!: (release: boolean) => void
    const stopGate = new Promise<boolean>((resolve) => { releaseStop = resolve })
    const previewLease = coordinator.registerPreviewStop(() => stopGate)

    const pending = previewLease.stopAndRelease()
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(true)
    expect(renderToStaticMarkup(createElement(PersistentMonitorControl, {
      snapshot: coordinator.shellSnapshot,
      onOpenSettings: vi.fn(),
      onStop: vi.fn()
    }))).toContain('Microphone cleanup needed')

    releaseStop(true)
    await pending
    expect(coordinator.hasAudioSafetyLease).toBe(false)
    expect(PersistentMonitorControl({
      snapshot: coordinator.shellSnapshot,
      onOpenSettings: vi.fn(),
      onStop: vi.fn()
    })).toBeNull()
  })

  it('closing Settings preserves the active generation and reopening reads its live snapshot', async () => {
    const { coordinator, endMonitor, restoreLegacyOutput } = harness()
    let settingsMounted = true
    const stopPreview = vi.fn(async () => !settingsMounted)
    const previewLease = coordinator.registerPreviewStop(stopPreview)

    expect(await coordinator.start(config, -6)).toBe(true)
    expect(stopPreview).toHaveBeenCalledOnce()
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(false)
    const onClose = vi.fn()

    closeMonitorSettings(onClose)
    settingsMounted = false
    await previewLease.stopAndRelease()

    expect(onClose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot.phase).toBe('active')
    expect(coordinator.hasNativeOwnership).toBe(true)
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(false)
    expect(endMonitor).not.toHaveBeenCalled()
    expect(restoreLegacyOutput).not.toHaveBeenCalled()

    const reopened = renderToStaticMarkup(createElement(SettingsModal, settingsProps(coordinator)))
    expect(reopened).toContain('Native DSP monitoring is active.')
    expect(reopened).toContain('Used by headphone monitoring')
    expect(reopened).toContain('Stop monitoring')
    expect(reopened).not.toContain('Stop monitoring and close')
    await coordinator.stop()
  })

  it('global Stop invokes the app coordinator once and restores legacy output', async () => {
    const { coordinator, endMonitor, restoreLegacyOutput } = harness()
    expect(await coordinator.start(config, -6)).toBe(true)
    const stop = vi.fn(() => coordinator.stop())
    const control = PersistentMonitorControl({
      snapshot: coordinator.shellSnapshot,
      onOpenSettings: vi.fn(),
      onStop: stop
    })
    expect(control).not.toBeNull()
    const children = Children.toArray(control!.props.children) as ReactElement[]
    const stopButton = children[1]

    stopButton.props.onClick()

    await vi.waitFor(() => expect(coordinator.hasNativeOwnership).toBe(false))
    expect(stop).toHaveBeenCalledOnce()
    expect(endMonitor).toHaveBeenCalledOnce()
    expect(restoreLegacyOutput).toHaveBeenCalledOnce()
  })

  it('describes the app lease without claiming all current audio is paused', async () => {
    const { coordinator } = harness()
    expect(await coordinator.start(config, -6)).toBe(true)
    const states = [
      coordinator.shellSnapshot,
      { ...coordinator.shellSnapshot, phase: 'preparing' as const },
      {
        ...coordinator.shellSnapshot,
        phase: 'error' as const,
        hasNativeOwnership: false,
        hasUnresolvedPreviewLease: true
      }
    ]

    for (const snapshot of states) {
      const html = renderToStaticMarkup(createElement(PersistentMonitorControl, {
        snapshot,
        onOpenSettings: vi.fn(),
        onStop: vi.fn()
      }))
      expect(html).toContain('New song and training audio starts are blocked')
      expect(html).not.toContain('Song and training audio are paused')
    }
    await coordinator.stop()
  })

  it('inactive Settings close neither touches native state nor restores output', () => {
    const { coordinator, endMonitor, restoreLegacyOutput } = harness()
    const onClose = vi.fn()

    closeMonitorSettings(onClose)

    expect(onClose).toHaveBeenCalledOnce()
    expect(coordinator.snapshot.phase).toBe('idle')
    expect(endMonitor).not.toHaveBeenCalled()
    expect(restoreLegacyOutput).not.toHaveBeenCalled()
  })

  it('a physical route edit still waits for stop and restoration before applying', async () => {
    const { coordinator, endMonitor, restoreLegacyOutput } = harness()
    expect(await coordinator.start(config, -6)).toBe(true)
    const apply = vi.fn()

    expect(await applyAfterMonitorStops(
      coordinator.hasAudioSafetyLease,
      () => coordinator.stop(),
      apply
    )).toBe(true)

    expect(endMonitor).toHaveBeenCalledOnce()
    expect(restoreLegacyOutput).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(coordinator.hasNativeOwnership).toBe(false)
  })

  it("settles the system-default sink before committing it and restarting preview", async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let settleSink!: () => void
    const sinkGate = new Promise<void>((resolve) => { settleSink = resolve })

    const operation = queue.schedule(
      coordinator,
      async () => {
        events.push('stop')
        return coordinator.stop()
      },
      () => applyPlaybackOutputSelection(
        undefined,
        async (sinkId) => {
          events.push(`set-output:${sinkId}`)
          await sinkGate
          events.push('set-output-settled')
        },
        (id) => events.push(`commit:${String(id)}`)
      ),
      () => events.push('preview-restart')
    )

    await vi.waitFor(() => expect(events).toEqual(['stop', 'set-output:']))
    expect(coordinator.hasAudioSafetyLease).toBe(true)
    expect(coordinator.hasRouteTransitionLease).toBe(true)
    settleSink()

    await expect(operation).resolves.toBe(true)
    expect(events).toEqual([
      'stop',
      'set-output:',
      'set-output-settled',
      'commit:undefined',
      'preview-restart'
    ])
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('holds the route lease through an awaited double-failure repair', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let aCalls = 0
    let finishRepair!: () => void
    const repairGate = new Promise<void>((resolve) => { finishRepair = resolve })
    const setOutput = vi.fn(async (sinkId: string) => {
      events.push(`sink:${sinkId}`)
      if (sinkId === 'C') throw new Error('C handoff failed')
      if (sinkId === 'A' && ++aCalls === 1) throw new Error('A rollback failed')
      if (sinkId === 'A') {
        events.push('repair-waiting')
        await repairGate
        events.push('repair-settled')
      }
    })
    const arbiter = new PlaybackOutputArbiter('A', {
      setOutput,
      enumerateOutputs: vi.fn(async () => [outputDevice('A'), outputDevice('C')]),
      commit: vi.fn()
    })
    const restart = vi.fn(() => events.push('preview-restart'))
    const changeOutput = async (): Promise<void> => {
      try {
        await arbiter.select('C')
      } catch (error) {
        if (error instanceof PlaybackOutputSelectionError && error.repairRequired) {
          await arbiter.repairSelectionFailure(error)
        }
      }
    }

    let operationSettled = false
    const operation = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      changeOutput,
      restart
    ).finally(() => { operationSettled = true })

    await vi.waitFor(() => expect(events).toContain('repair-waiting'))
    expect(operationSettled).toBe(false)
    expect(coordinator.hasRouteTransitionLease).toBe(true)
    expect(restart).not.toHaveBeenCalled()

    finishRepair()
    await expect(operation).resolves.toBe(true)
    expect(events).toEqual([
      'sink:C',
      'sink:A',
      'sink:A',
      'repair-waiting',
      'repair-settled',
      'preview-restart'
    ])
    expect(coordinator.hasRouteTransitionLease).toBe(false)
    await Promise.resolve()
    expect(setOutput).toHaveBeenCalledTimes(3)

    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const routingSource = readFileSync('src/renderer/src/audio/output-routing.ts', 'utf8')
    expect(appSource).toMatch(
      /err instanceof PlaybackOutputSelectionError && err\.repairRequired\)[\s\S]*await reconcileOutput\(err\)/
    )
    expect(routingSource).not.toContain('scheduleRepair')
    expect(routingSource).not.toContain('queueMicrotask')
  })

  it('does not restart an old preview before delayed input props commit', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let renderedInput = 'old'
    const starts: string[] = []

    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => undefined,
      (restartPreview) => {
        if (restartPreview) starts.push(renderedInput)
      },
      'after-props-commit'
    )).resolves.toBe(true)

    expect(starts).toEqual([])
    expect(renderedInput).toBe('old')
    expect(settingsPreviewRestartDecision(false, 'new', renderedInput)).toBe('wait-for-props')
    // This represents the Settings prop/effect boundary, which is the first
    // owner allowed to create a capture for the new controlled route.
    renderedInput = 'new'
    expect(settingsPreviewRestartDecision(false, 'new', renderedInput)).toBe('restart')
    starts.push(renderedInput)
    expect(starts).toEqual(['new'])
  })

  it('preserves an acknowledged input marker until a later output edit drains', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let renderedInput = 'old'
    let deferredInput: string | null = 'new'
    let restartHeld = true
    const starts: string[] = []
    let finishOutput!: () => void
    const outputGate = new Promise<void>((resolve) => { finishOutput = resolve })
    const commitInputProps = (): void => {
      renderedInput = 'new'
      const decision = settingsInputPropCommitDecision(
        deferredInput,
        renderedInput,
        queue.busy
      )
      if (decision === 'release') {
        deferredInput = null
        restartHeld = false
        starts.push(renderedInput)
      }
    }
    const afterDrain = (restartPreview: boolean): void => {
      if (settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        renderedInput
      ) !== 'restart') return
      deferredInput = null
      restartHeld = false
      starts.push(renderedInput)
    }

    const input = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      commitInputProps,
      afterDrain,
      'after-props-commit'
    )
    const output = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => outputGate,
      afterDrain,
      'after-drain'
    )

    await vi.waitFor(() => expect(renderedInput).toBe('new'))
    expect(queue.busy).toBe(true)
    expect(deferredInput).toBe('new')
    expect(restartHeld).toBe(true)
    expect(starts).toEqual([])

    finishOutput()
    await expect(Promise.all([input, output])).resolves.toEqual([true, true])
    expect(queue.busy).toBe(false)
    expect(deferredInput).toBeNull()
    expect(restartHeld).toBe(false)
    expect(starts).toEqual(['new'])
  })

  it('keeps rapid device then channel edits on the invocation-order input draft', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let draft = settingsInputDeviceRoute('native-a', 'chromium-a')
    let rendered = draft
    let deferredInput = settingsInputRouteSignature(draft)
    const events: string[] = []
    let finishStop!: () => void
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve })
    const stop = vi.fn(async () => {
      await stopGate
      return coordinator.stop()
    })
    const afterDrain = vi.fn((restartPreview: boolean) => {
      if (settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        settingsInputRouteSignature(rendered)
      ) !== 'restart') return
      events.push(`preview:${settingsInputRouteSignature(rendered)}`)
    })

    const deviceRoute = settingsInputDeviceRoute('native-b', 'chromium-b')
    draft = deviceRoute
    deferredInput = settingsInputRouteSignature(deviceRoute)
    const deviceEdit = queue.schedule(
      coordinator,
      stop,
      () => { events.push(`device:${settingsInputRouteSignature(deviceRoute)}`) },
      afterDrain,
      'after-props-commit'
    )

    // The parent still renders A/1 here. The immediate channel edit must be
    // derived from desired B/1, never from those stale controlled props.
    const channelRoute = settingsInputChannelRoute(draft, 2)
    draft = channelRoute
    deferredInput = settingsInputRouteSignature(channelRoute)
    const channelEdit = queue.schedule(
      coordinator,
      stop,
      () => {
        events.push(`channel:${settingsInputRouteSignature(channelRoute)}`)
        rendered = channelRoute
        expect(settingsInputPropCommitDecision(
          deferredInput,
          settingsInputRouteSignature(rendered),
          queue.busy
        )).toBe('wait-for-drain')
      },
      afterDrain,
      'after-props-commit'
    )

    expect(rendered).toEqual(settingsInputDeviceRoute('native-a', 'chromium-a'))
    expect(channelRoute).toEqual({
      nativeInputUid: 'native-b',
      inputId: 'chromium-b',
      inputChannel: 2
    })
    expect(queue.busy).toBe(true)
    finishStop()

    await expect(Promise.all([deviceEdit, channelEdit])).resolves.toEqual([true, true])
    expect(stop).toHaveBeenCalledOnce()
    expect(afterDrain).toHaveBeenCalledOnce()
    expect(events).toEqual([
      `device:${settingsInputRouteSignature(deviceRoute)}`,
      `channel:${settingsInputRouteSignature(channelRoute)}`,
      `preview:${settingsInputRouteSignature(channelRoute)}`
    ])
  })

  it('releases the input hold at the prop boundary when the queue drained first', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let renderedInput = 'old'
    let deferredInput: string | null = 'new'
    let restartHeld = true
    const starts: string[] = []
    const afterDrain = (restartPreview: boolean): void => {
      expect(settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        renderedInput
      )).toBe('wait-for-props')
    }

    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => undefined,
      afterDrain,
      'after-props-commit'
    )).resolves.toBe(true)

    expect(queue.busy).toBe(false)
    expect(deferredInput).toBe('new')
    expect(restartHeld).toBe(true)
    expect(starts).toEqual([])

    // The delayed controlled prop commit replaces the preview effect. With no
    // app-lifetime route work left, that effect is the one restart boundary.
    renderedInput = 'new'
    expect(settingsInputPropCommitDecision(
      deferredInput,
      renderedInput,
      queue.busy
    )).toBe('release')
    deferredInput = null
    restartHeld = false
    starts.push(renderedInput)

    expect(deferredInput).toBeNull()
    expect(restartHeld).toBe(false)
    expect(starts).toEqual(['new'])
  })

  it('coalesces an overlapping mixed route batch onto the final input preview once', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let renderedInput = 'old'
    const requestedInput = 'new'
    let finishOutput!: () => void
    const outputGate = new Promise<void>((resolve) => { finishOutput = resolve })
    const afterDrain = (restartPreview: boolean): void => {
      if (restartPreview || renderedInput === requestedInput) {
        events.push(`preview:${renderedInput}`)
      }
    }

    const output = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      async () => {
        events.push('output-start')
        await outputGate
        events.push('output-end')
      },
      afterDrain,
      'after-drain'
    )
    await vi.waitFor(() => expect(events).toEqual(['output-start']))
    const input = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => {
        renderedInput = requestedInput
        events.push('input-commit')
      },
      afterDrain,
      'after-props-commit'
    )
    const monitorOutput = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => { events.push('monitor-output') },
      afterDrain,
      'after-drain'
    )

    finishOutput()
    await expect(Promise.all([output, input, monitorOutput])).resolves.toEqual([true, true, true])
    expect(events).toEqual([
      'output-start',
      'output-end',
      'input-commit',
      'monitor-output',
      'preview:new'
    ])
  })

  it('serializes overlapping route edits in invocation order and restarts preview once', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    const committed: string[] = []
    let finishFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve })
    const stop = vi.fn(async () => {
      events.push('stop')
      return coordinator.stop()
    })
    const restart = vi.fn(() => events.push('preview-restart'))

    const first = queue.schedule(coordinator, stop, async () => {
      events.push('first-start')
      await firstGate
      committed.push('first')
      events.push('first-commit')
    }, restart)
    await vi.waitFor(() => expect(events).toEqual(['stop', 'first-start']))

    const second = queue.schedule(coordinator, stop, () => {
      events.push('second-start')
      committed.push('second')
      events.push('second-commit')
    }, restart)
    await Promise.resolve()
    expect(events).toEqual(['stop', 'first-start'])
    expect(coordinator.hasAudioSafetyLease).toBe(true)

    finishFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(events).toEqual([
      'stop',
      'first-start',
      'first-commit',
      'second-start',
      'second-commit',
      'preview-restart'
    ])
    expect(committed.at(-1)).toBe('second')
    expect(stop).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('keeps the route-transition safety lease after Settings closes until apply settles', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let mounted = true
    let finishApply!: () => void
    const applyGate = new Promise<void>((resolve) => { finishApply = resolve })
    const restart = vi.fn(() => { if (mounted) throw new Error('preview restarted while mounted flag was stale') })
    const operation = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => applyGate,
      restart
    )

    await vi.waitFor(() => expect(queue.busy).toBe(true))
    mounted = false
    expect(coordinator.hasAudioSafetyLease).toBe(true)
    expect(coordinator.hasRouteTransitionLease).toBe(true)

    finishApply()
    await expect(operation).resolves.toBe(true)
    expect(coordinator.hasAudioSafetyLease).toBe(false)
    expect(coordinator.hasRouteTransitionLease).toBe(false)
    expect(restart).toHaveBeenCalledOnce()
  })

  it('shows a truthful non-cancellable route transition after Settings closes', () => {
    const { coordinator } = harness()
    const lease = coordinator.acquireRouteTransitionLease()

    expect(coordinator.shellSnapshot).toMatchObject({
      hasRouteTransitionLease: true,
      hasAudioSafetyLease: true,
      hasNativeOwnership: false
    })
    const html = renderToStaticMarkup(createElement(PersistentMonitorControl, {
      snapshot: coordinator.shellSnapshot,
      onOpenSettings: vi.fn(),
      onStop: vi.fn()
    }))
    expect(html).toContain('Changing audio route…')
    expect(html).toContain('Open audio route settings')
    expect(html).not.toContain('persistent-monitor-stop')

    const copies = [
      SONG_TRANSPORT_AUDIO_LEASE_COPY,
      pitchMicrophoneUnavailableCopy(false, true),
      TRAINING_AUDIO_LEASE_COPY
    ]
    expect(audioSafetyLeaseKind(coordinator.shellSnapshot)).toBe('route-only')
    for (const copy of copies) {
      expect(copy).toContain('Open Settings to review the audio owner or retry the output route')
      expect(copy).not.toContain('Stop')
      expect(copy).not.toContain('headphone monitoring')
    }

    const appSource = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(appSource).toContain('? TRAINING_CLEANUP_SONG_BLOCKED_COPY')
    expect(appSource).toContain(': SONG_TRANSPORT_AUDIO_LEASE_COPY')

    lease.release()
    expect(coordinator.shellSnapshot.hasRouteTransitionLease).toBe(false)
  })

  it('permits unsafe Settings recovery only when the retained owner is route-only', async () => {
    const { coordinator } = harness()
    const routeLease = coordinator.acquireRouteTransitionLease()

    expect(coordinator.hasRouteOnlySafetyLease).toBe(true)

    const preview = coordinator.registerPreviewStop(async () => true)
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(false)
    expect(coordinator.hasRouteOnlySafetyLease).toBe(false)

    await preview.stopAndRelease()
    expect(coordinator.hasRouteOnlySafetyLease).toBe(true)

    routeLease.release()
    expect(await coordinator.start(config, -6)).toBe(true)
    const routeDuringNativeOwnership = coordinator.acquireRouteTransitionLease()
    expect(coordinator.hasNativeOwnership).toBe(true)
    expect(coordinator.hasRouteOnlySafetyLease).toBe(false)

    await coordinator.stop()
    expect(coordinator.hasNativeOwnership).toBe(false)
    expect(coordinator.hasRouteOnlySafetyLease).toBe(true)
    routeDuringNativeOwnership.release()
  })

  it('requires exact playback-route provenance before unsafe Settings recovery', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    let finishApply!: () => void
    const applyGate = new Promise<void>((resolve) => { finishApply = resolve })
    const ordinaryRoute = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => applyGate,
      vi.fn()
    )

    await vi.waitFor(() => expect(coordinator.hasRouteOnlySafetyLease).toBe(true))
    expect(canRetrySettingsAfterPlaybackRouteFailure(
      false,
      coordinator.hasRouteOnlySafetyLease
    )).toBe(false)

    finishApply()
    await ordinaryRoute

    const routeSafety = new PlaybackOutputRouteSafety(
      () => coordinator.acquireRouteTransitionLease(),
      vi.fn()
    )
    routeSafety.retainUnconfirmed()
    expect(canRetrySettingsAfterPlaybackRouteFailure(
      routeSafety.unconfirmed,
      coordinator.hasRouteOnlySafetyLease
    )).toBe(true)

    const preview = coordinator.registerPreviewStop(async () => true)
    expect(canRetrySettingsAfterPlaybackRouteFailure(
      routeSafety.unconfirmed,
      coordinator.hasRouteOnlySafetyLease
    )).toBe(false)
    await preview.stopAndRelease()

    expect(await coordinator.start(config, -6)).toBe(false)
    const nativeCoordinator = harness().coordinator
    expect(await nativeCoordinator.start(config, -6)).toBe(true)
    const nativeRouteSafety = new PlaybackOutputRouteSafety(
      () => nativeCoordinator.acquireRouteTransitionLease(),
      vi.fn()
    )
    nativeRouteSafety.retainUnconfirmed()
    expect(canRetrySettingsAfterPlaybackRouteFailure(
      nativeRouteSafety.unconfirmed,
      nativeCoordinator.hasRouteOnlySafetyLease
    )).toBe(false)

    routeSafety.confirmCurrentRoute()
    nativeRouteSafety.confirmCurrentRoute()
    await nativeCoordinator.stop()
  })

  it('pauses the persistent monitor pulse behind an open modal', () => {
    const styles = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(styles).toMatch(
      /body\.modal-open \.persistent-monitor\.active \.persistent-monitor-dot \{[\s\S]*?animation-play-state: paused;/
    )
    expect(styles).toContain('.persistent-monitor .persistent-monitor-stop')
    expect(styles).not.toMatch(/\.persistent-monitor[^}]*!important/)
  })

  it('refuses native Start during route transition or unresolved preview cleanup', async () => {
    const { coordinator } = harness()
    const routeLease = coordinator.acquireRouteTransitionLease()
    expect(await coordinator.start(config, -6)).toBe(false)
    expect(coordinator.snapshot.phase).toBe('idle')
    routeLease.release()

    let finishCleanup!: () => void
    const cleanupGate = new Promise<void>((resolve) => { finishCleanup = resolve })
    const preview = coordinator.registerPreviewStop(async () => {
      await cleanupGate
      return true
    })
    const cleanup = preview.stopAndRelease()
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(true)
    expect(await coordinator.start(config, -6)).toBe(false)
    expect(coordinator.snapshot.phase).toBe('idle')

    finishCleanup()
    await cleanup
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('shares one route queue across immediate close/reopen and wakes preview after both cleanups', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const events: string[] = []
    let renderedInput = 'old'
    let deferredInput: string | null = 'new'
    let restartHeld = true
    let oldMounted = true
    let finishOldPreview!: () => void
    const oldPreviewGate = new Promise<void>((resolve) => { finishOldPreview = resolve })
    const oldPreview = coordinator.registerPreviewStop(async () => {
      events.push('old-preview-stop')
      await oldPreviewGate
      return !oldMounted
    })
    let finishFirstRoute!: () => void
    const firstRouteGate = new Promise<void>((resolve) => { finishFirstRoute = resolve })
    const restart = vi.fn((restartPreview: boolean) => {
      if (settingsPreviewRestartDecision(
        restartPreview,
        deferredInput,
        renderedInput
      ) !== 'restart') return
      deferredInput = null
      restartHeld = false
      events.push(`preview-restart:${renderedInput}`)
    })

    const firstRoute = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      async () => {
        events.push('first-route-start')
        await firstRouteGate
        events.push('first-route-end')
      },
      restart
    )
    oldMounted = false
    const oldCleanup = oldPreview.stopAndRelease()
    const reopenedPreview = coordinator.registerPreviewStop(async () => {
      events.push('reopened-preview-stop')
      return false
    })

    expect(settingsPreviewCanStart(
      false,
      coordinator.hasNativeOwnership,
      coordinator.snapshot.phase === 'stopping',
      coordinator.shellSnapshot.hasRouteTransitionLease ||
        coordinator.shellSnapshot.hasUnresolvedPreviewLease
    )).toBe(false)

    finishOldPreview()
    await oldCleanup
    await vi.waitFor(() => expect(events).toContain('first-route-start'))
    const secondRoute = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => {
        renderedInput = 'new'
        events.push('second-route')
        expect(settingsInputPropCommitDecision(
          deferredInput,
          renderedInput,
          queue.busy
        )).toBe('wait-for-drain')
      },
      restart,
      'after-props-commit'
    )
    expect(events).not.toContain('second-route')
    expect(coordinator.shellSnapshot.hasRouteTransitionLease).toBe(true)
    expect(settingsPreviewCanStart(false, false, false, true)).toBe(false)

    finishFirstRoute()
    await expect(Promise.all([firstRoute, secondRoute])).resolves.toEqual([true, true])
    expect(events.indexOf('second-route')).toBeGreaterThan(events.indexOf('first-route-end'))
    expect(restart).toHaveBeenCalledOnce()
    expect(events).toContain('preview-restart:new')
    expect(deferredInput).toBeNull()
    expect(restartHeld).toBe(false)
    expect(coordinator.shellSnapshot.hasRouteTransitionLease).toBe(false)
    expect(settingsPreviewCanStart(false, false, false, false)).toBe(true)
    await reopenedPreview.stopAndRelease()
  })

  it('retains the stop safety lease until teardown and restoration settle', async () => {
    const events: string[] = []
    let finishPreview!: () => void
    const previewGate = new Promise<void>((resolve) => { finishPreview = resolve })
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: vi.fn(),
        setMonitorGain: vi.fn(),
        monitorStatus: vi.fn(),
        endMonitor: vi.fn()
      },
      stopPreview: async () => {
        events.push(`preview:${coordinator.hasAudioSafetyLease}`)
        await previewGate
        events.push(`preview-final:${coordinator.hasAudioSafetyLease}`)
      },
      pauseSong: vi.fn(),
      releaseLegacyOutput: vi.fn(async () => undefined),
      restoreLegacyOutput: vi.fn(async () => undefined)
    })
    const shellStates: boolean[] = []
    const unsubscribe = coordinator.subscribeShell((snapshot) => {
      shellStates.push(snapshot.hasAudioSafetyLease)
    })

    const stopping = coordinator.stop()
    expect(coordinator.hasAudioSafetyLease).toBe(true)
    await vi.waitFor(() => expect(events).toEqual(['preview:true']))
    finishPreview()
    await expect(stopping).resolves.toEqual({ ok: true, safeToRestartPreview: true })

    expect(events).toEqual(['preview:true', 'preview-final:true'])
    expect(shellStates.at(-2)).toBe(true)
    expect(shellStates.at(-1)).toBe(false)
    expect(coordinator.hasAudioSafetyLease).toBe(false)
    unsubscribe()
  })

  it('restarts preview only after an asynchronous playback route apply settles', async () => {
    const events: string[] = []
    let finishApply!: () => void
    const applyGate = new Promise<void>((resolve) => { finishApply = resolve })
    const operation = applyAfterMonitorStops(
      true,
      async () => {
        events.push('stop-preview')
        return { ok: true, safeToRestartPreview: true }
      },
      async () => {
        events.push('apply-start')
        await applyGate
        events.push('apply-complete')
      },
      () => events.push('preview-restart')
    )

    await vi.waitFor(() => expect(events).toEqual(['stop-preview', 'apply-start']))
    finishApply()

    await expect(operation).resolves.toBe(true)
    expect(events).toEqual([
      'stop-preview', 'apply-start', 'apply-complete', 'preview-restart'
    ])
  })

  it('waits for a failed playback route apply before safely reopening preview', async () => {
    const events: string[] = []
    let failApply!: () => void
    const applyGate = new Promise<void>((_resolve, reject) => {
      failApply = () => reject(new Error('sink switch failed'))
    })
    const operation = applyAfterMonitorStops(
      true,
      async () => {
        events.push('stop-preview')
        return { ok: true, safeToRestartPreview: true }
      },
      async () => {
        events.push('apply-start')
        await applyGate
      },
      () => events.push('preview-restart')
    )

    await vi.waitFor(() => expect(events).toEqual(['stop-preview', 'apply-start']))
    failApply()

    await expect(operation).rejects.toThrow('sink switch failed')
    expect(events).toEqual(['stop-preview', 'apply-start', 'preview-restart'])
  })

  it('keeps a Settings preview mounted during a preview-only Stop dormant until it clears', async () => {
    const { coordinator } = harness()
    let finishPreviewStop!: () => void
    let settingsMounted = true
    const previewStopGate = new Promise<void>((resolve) => { finishPreviewStop = resolve })
    const previewLease = coordinator.registerPreviewStop(async () => {
      await previewStopGate
      return !settingsMounted
    })

    const stopping = coordinator.stop()
    await vi.waitFor(() => expect(coordinator.snapshot.phase).toBe('stopping'))
    expect(coordinator.hasNativeOwnership).toBe(false)
    expect(settingsPreviewCanStart(false, false, true)).toBe(false)

    finishPreviewStop()
    await expect(stopping).resolves.toEqual({ ok: true, safeToRestartPreview: true })
    expect(coordinator.snapshot.phase).toBe('idle')
    expect(settingsPreviewCanStart(false, false, false)).toBe(true)

    settingsMounted = false
    await previewLease.stopAndRelease()
  })

  it('retries failed post-close preview cleanup from global Stop before restoring output', async () => {
    const { coordinator, endMonitor, restoreLegacyOutput } = harness()
    let attempts = 0
    let settingsMounted = true
    const previewLease = coordinator.registerPreviewStop(async () => {
      attempts += 1
      if (settingsMounted) return false
      if (attempts === 2) throw new Error('preview child did not confirm stop')
      return true
    })
    expect(await coordinator.start(config, -6)).toBe(true)
    settingsMounted = false

    await expect(previewLease.stopAndRelease()).rejects.toThrow('preview child did not confirm stop')

    expect(endMonitor).not.toHaveBeenCalled()
    expect(restoreLegacyOutput).not.toHaveBeenCalled()
    expect(coordinator.hasAudioSafetyLease).toBe(true)
    expect(coordinator.shellSnapshot.hasUnresolvedPreviewLease).toBe(true)
    expect(PersistentMonitorControl({
      snapshot: coordinator.shellSnapshot,
      onOpenSettings: vi.fn(),
      onStop: vi.fn()
    })).not.toBeNull()

    const second = await coordinator.stop()

    expect(second).toEqual({ ok: true, safeToRestartPreview: true })
    expect(attempts).toBe(3)
    expect(endMonitor).toHaveBeenCalledOnce()
    expect(restoreLegacyOutput).toHaveBeenCalledOnce()
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('stops a preview-only unresolved lease before applying an output route edit', async () => {
    const { coordinator, endMonitor } = harness()
    let attempts = 0
    const events: string[] = []
    const previewLease = coordinator.registerPreviewStop(async () => {
      attempts += 1
      events.push(`stop-${attempts}`)
      if (attempts === 1) throw new Error('preview cleanup pending')
      return true
    })
    await expect(previewLease.stopAndRelease()).rejects.toThrow('preview cleanup pending')
    const apply = vi.fn(() => { events.push('apply') })

    expect(await applyAfterMonitorStops(
      coordinator.hasAudioSafetyLease,
      () => coordinator.stop(),
      apply
    )).toBe(true)

    expect(attempts).toBe(2)
    expect(events).toEqual(['stop-1', 'stop-2', 'apply'])
    expect(endMonitor).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledOnce()
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('cancels queued app audio immediately before restoring the physical Web Audio sink', async () => {
    const events: string[] = []
    const statuses = [nativeStatus(false, '1'), nativeStatus(true, '2')]
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: vi.fn(async () => nativeResult()),
        setMonitorGain: vi.fn(async () => nativeResult()),
        monitorStatus: vi.fn(async () => statuses.shift() ?? nativeStatus(true, '3')),
        endMonitor: vi.fn(async () => ({ ...nativeResult(), state: 'stopped' as const }))
      },
      stopPreview: vi.fn(async () => undefined),
      pauseSong: vi.fn(),
      releaseLegacyOutput: vi.fn(async () => undefined),
      beforeRestoreLegacyOutput: () => events.push('cancel-cues-and-mic'),
      restoreLegacyOutput: vi.fn(async () => { events.push('restore-output') }),
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })
    expect(await coordinator.start(config, -6)).toBe(true)

    await coordinator.stop()

    expect(events).toEqual(['cancel-cues-and-mic', 'restore-output'])
  })

  it('does not cross the cancellation barrier for preview-only cleanup', async () => {
    const restoreLegacyOutput = vi.fn(async () => undefined)
    const beforeRestoreLegacyOutput = vi.fn()
    // The dependency is intentionally replaced only for this inactive-session
    // coordinator so no physical Web Audio release can have occurred.
    const previewOnly = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: vi.fn(),
        setMonitorGain: vi.fn(),
        monitorStatus: vi.fn(),
        endMonitor: vi.fn()
      },
      stopPreview: vi.fn(async () => undefined),
      pauseSong: vi.fn(),
      releaseLegacyOutput: vi.fn(async () => undefined),
      beforeRestoreLegacyOutput,
      restoreLegacyOutput
    })
    let mounted = true
    const lease = previewOnly.registerPreviewStop(async () => !mounted)

    await expect(previewOnly.stop()).resolves.toEqual({ ok: true, safeToRestartPreview: true })

    expect(beforeRestoreLegacyOutput).not.toHaveBeenCalled()
    expect(restoreLegacyOutput).not.toHaveBeenCalled()
    mounted = false
    await lease.stopAndRelease()
    expect(previewOnly.hasAudioSafetyLease).toBe(false)
  })

  it('does not notify the app shell for meter-only telemetry changes', async () => {
    const { coordinator } = harness()
    expect(await coordinator.start(config, -6)).toBe(true)
    const updates = vi.fn()
    const unsubscribe = coordinator.subscribeShell(updates)

    await coordinator.refreshStatus()
    await coordinator.refreshStatus()

    expect(updates).toHaveBeenCalledOnce()
    unsubscribe()
    await coordinator.stop()
  })
})

describe('app-lifetime Settings input route intent', () => {
  const route = (
    nativeInputUid: string,
    inputId: string,
    inputChannel = 0
  ) => ({ nativeInputUid, inputId, inputChannel })

  it('keeps the desired device through a drained queue and stale rerender before a channel edit', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const deviceRoute = route('native-b', 'chromium-b')
    const restarts: string[] = []
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.subscribePreviewRestart(() => restarts.push('restart'))

    const deviceSignature = queue.deferInputRoute(deviceRoute)
    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => undefined,
      vi.fn(),
      'after-props-commit',
      deviceSignature
    )).resolves.toBe(true)

    expect(queue.busy).toBe(false)
    expect(queue.hasDeferredInputIntent).toBe(true)
    expect(queue.acknowledgeRenderedInputRoute(oldRoute)).toBe('unrelated')
    expect(queue.inputRouteDraft(oldRoute)).toEqual(deviceRoute)

    const channelRoute = settingsInputChannelRoute(queue.inputRouteDraft(oldRoute), 2)
    const channelSignature = queue.deferInputRoute(channelRoute)
    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => {
        expect(queue.acknowledgeRenderedInputRoute(channelRoute)).toBe('wait-for-drain')
      },
      vi.fn(),
      'after-props-commit',
      channelSignature
    )).resolves.toBe(true)

    expect(channelRoute).toEqual(route('native-b', 'chromium-b', 2))
    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(restarts).toEqual(['restart'])
  })

  it('survives a real modal-owner close/reopen before input props and derives the next edit from the shared draft', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const deviceRoute = route('native-b', 'chromium-b')
    const oldModalRestarts = vi.fn()
    const newModalRestarts: string[] = []
    queue.acknowledgeRenderedInputRoute(oldRoute)
    const unsubscribeOldModal = queue.subscribePreviewRestart(oldModalRestarts)
    let finishStop!: () => void
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve })
    const stop = vi.fn(async () => {
      await stopGate
      return coordinator.stop()
    })

    const deviceSignature = queue.deferInputRoute(deviceRoute)
    const deviceEdit = queue.schedule(
      coordinator,
      stop,
      () => undefined,
      vi.fn(),
      'after-props-commit',
      deviceSignature
    )

    // Close the first Settings instance and mount a new one with the same old
    // controlled props while the app-shell queue is still draining.
    unsubscribeOldModal()
    queue.subscribePreviewRestart(() => {
      newModalRestarts.push('restart')
    })
    expect(queue.acknowledgeRenderedInputRoute(oldRoute)).toBe('unrelated')
    const channelRoute = settingsInputChannelRoute(queue.inputRouteDraft(oldRoute), 3)
    const channelSignature = queue.deferInputRoute(channelRoute)
    const channelEdit = queue.schedule(
      coordinator,
      stop,
      () => {
        expect(queue.acknowledgeRenderedInputRoute(channelRoute)).toBe('wait-for-drain')
      },
      vi.fn(),
      'after-props-commit',
      channelSignature
    )

    finishStop()
    await expect(Promise.all([deviceEdit, channelEdit])).resolves.toEqual([true, true])
    expect(stop).toHaveBeenCalledOnce()
    expect(oldModalRestarts).not.toHaveBeenCalled()
    expect(newModalRestarts).toEqual(['restart'])
    expect(queue.inputRouteDraft(channelRoute)).toEqual(route('native-b', 'chromium-b', 3))
    expect(queue.hasDeferredInputIntent).toBe(false)
  })

  it('lets an unresolved input intent dominate a later output-only batch in either batch order', async () => {
    const { coordinator } = harness()
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')

    const inputThenOutput = new SettingsRouteApplicationQueue()
    inputThenOutput.acknowledgeRenderedInputRoute(oldRoute)
    const inputThenOutputRestarts = vi.fn()
    inputThenOutput.subscribePreviewRestart(inputThenOutputRestarts)
    const firstSignature = inputThenOutput.deferInputRoute(nextRoute)
    await inputThenOutput.schedule(
      coordinator, () => coordinator.stop(), () => undefined, vi.fn(),
      'after-props-commit', firstSignature
    )
    await inputThenOutput.schedule(
      coordinator, () => coordinator.stop(), () => undefined, vi.fn(), 'after-drain'
    )
    expect(inputThenOutput.hasDeferredInputIntent).toBe(true)
    expect(inputThenOutputRestarts).not.toHaveBeenCalled()
    expect(inputThenOutput.acknowledgeRenderedInputRoute(nextRoute)).toBe('release')
    expect(inputThenOutputRestarts).toHaveBeenCalledOnce()

    const outputThenInput = new SettingsRouteApplicationQueue()
    outputThenInput.acknowledgeRenderedInputRoute(oldRoute)
    const outputThenInputRestarts = vi.fn()
    outputThenInput.subscribePreviewRestart(outputThenInputRestarts)
    await outputThenInput.schedule(
      coordinator, () => coordinator.stop(), () => undefined, vi.fn(), 'after-drain'
    )
    expect(outputThenInputRestarts).toHaveBeenCalledOnce()
    const secondSignature = outputThenInput.deferInputRoute(nextRoute)
    await outputThenInput.schedule(
      coordinator, () => coordinator.stop(), () => undefined, vi.fn(),
      'after-props-commit', secondSignature
    )
    expect(outputThenInputRestarts).toHaveBeenCalledOnce()
    expect(outputThenInput.hasDeferredInputIntent).toBe(true)
    expect(outputThenInput.acknowledgeRenderedInputRoute(nextRoute)).toBe('release')
    expect(outputThenInputRestarts).toHaveBeenCalledTimes(2)
    expect(outputThenInput.hasDeferredInputIntent).toBe(false)
  })

  it.each(['props-first', 'drain-first'] as const)(
    'restarts exactly once with no permanent hold when acknowledgement is %s',
    async (order) => {
      const { coordinator } = harness()
      const queue = new SettingsRouteApplicationQueue()
      const oldRoute = route('native-a', 'chromium-a')
      const nextRoute = route('native-b', 'chromium-b', 2)
      const restarts = vi.fn()
      queue.acknowledgeRenderedInputRoute(oldRoute)
      queue.subscribePreviewRestart(restarts)
      const signature = queue.deferInputRoute(nextRoute)
      const operation = queue.schedule(
        coordinator,
        () => coordinator.stop(),
        () => {
          if (order === 'props-first') {
            expect(queue.acknowledgeRenderedInputRoute(nextRoute)).toBe('wait-for-drain')
          }
        },
        vi.fn(),
        'after-props-commit',
        signature
      )

      await expect(operation).resolves.toBe(true)
      if (order === 'drain-first') {
        expect(queue.hasDeferredInputIntent).toBe(true)
        expect(restarts).not.toHaveBeenCalled()
        expect(queue.acknowledgeRenderedInputRoute(nextRoute)).toBe('release')
      }
      expect(queue.hasDeferredInputIntent).toBe(false)
      expect(restarts).toHaveBeenCalledOnce()
      expect(queue.inputRouteDraft(nextRoute)).toEqual(nextRoute)
    }
  )

  it('retires failed input intent without dropping the fail-closed preview cleanup lease', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')
    queue.acknowledgeRenderedInputRoute(oldRoute)
    let previewCanStop = false
    const previewLease = coordinator.registerPreviewStop(async () => {
      if (!previewCanStop) throw new Error('capture stop unconfirmed')
      return true
    })
    const signature = queue.deferInputRoute(nextRoute)

    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => undefined,
      vi.fn(),
      'after-props-commit',
      signature
    )).resolves.toBe(false)

    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(queue.inputRouteDraft(oldRoute)).toEqual(oldRoute)
    expect(coordinator.shellSnapshot).toMatchObject({
      hasRouteTransitionLease: false,
      hasUnresolvedPreviewLease: true,
      hasAudioSafetyLease: true
    })

    previewCanStop = true
    await previewLease.stopAndRelease()
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('repairs a rejected input apply to committed props and permits one safe restart', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')
    const restarts = vi.fn()
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.subscribePreviewRestart(restarts)
    const signature = queue.deferInputRoute(nextRoute)

    await expect(queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => { throw new Error('input apply failed') },
      vi.fn(),
      'after-props-commit',
      signature
    )).rejects.toThrow('input apply failed')

    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(queue.inputRouteDraft(oldRoute)).toEqual(oldRoute)
    expect(restarts).toHaveBeenCalledOnce()
    expect(coordinator.hasAudioSafetyLease).toBe(false)
  })

  it('does not retire a later same-signature intent when the earlier apply fails', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    const oldRoute = route('native-a', 'chromium-a')
    const nextRoute = route('native-b', 'chromium-b')
    const restarts = vi.fn()
    queue.acknowledgeRenderedInputRoute(oldRoute)
    queue.subscribePreviewRestart(restarts)

    const firstSignature = queue.deferInputRoute(nextRoute)
    const first = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => { throw new Error('first duplicate failed') },
      vi.fn(),
      'after-props-commit',
      firstSignature
    )
    const secondSignature = queue.deferInputRoute(nextRoute)
    const second = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => {
        expect(queue.acknowledgeRenderedInputRoute(nextRoute)).toBe('wait-for-drain')
      },
      vi.fn(),
      'after-props-commit',
      secondSignature
    )

    const results = await Promise.allSettled([first, second])
    expect(results[0]).toMatchObject({ status: 'rejected' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: true })
    expect(queue.hasDeferredInputIntent).toBe(false)
    expect(restarts).toHaveBeenCalledOnce()
  })
})

describe('app-lifetime Settings monitor output intent', () => {
  it('survives route drain and modal remount without accepting stale output props', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    queue.acknowledgeRenderedMonitorOutputUid('coreaudio:a')
    let finishStop!: () => void
    const stopGate = new Promise<void>((resolve) => { finishStop = resolve })
    const stop = vi.fn(async () => {
      await stopGate
      return coordinator.stop()
    })

    const intentId = queue.deferMonitorOutputUid('coreaudio:b')
    const deviceEdit = queue.schedule(
      coordinator,
      stop,
      () => undefined,
      vi.fn(),
      'after-drain',
      null,
      intentId
    )

    // The old Settings owner closes. A replacement renders A from stale
    // controlled props, but the app-shell queue continues to expose B.
    expect(queue.monitorOutputUid('coreaudio:a')).toBe('coreaudio:b')
    expect(queue.acknowledgeRenderedMonitorOutputUid('coreaudio:a')).toBe('unrelated')
    expect(queue.monitorOutputUid('coreaudio:a')).toBe('coreaudio:b')
    expect(queue.hasDeferredMonitorOutputIntent).toBe(true)

    finishStop()
    await expect(deviceEdit).resolves.toBe(true)
    expect(queue.busy).toBe(false)
    expect(queue.monitorOutputUid('coreaudio:a')).toBe('coreaudio:b')
    expect(queue.hasDeferredMonitorOutputIntent).toBe(true)
    expect(queue.acknowledgeRenderedMonitorOutputUid('coreaudio:b')).toBe('release')
    expect(queue.monitorOutputUid('coreaudio:b')).toBe('coreaudio:b')
    expect(queue.hasDeferredMonitorOutputIntent).toBe(false)
  })

  it.each(['unsafe-stop', 'rejected-apply'] as const)(
    'rolls the desired output back to rendered props after %s',
    async (failure) => {
      const { coordinator } = harness()
      const queue = new SettingsRouteApplicationQueue()
      queue.acknowledgeRenderedMonitorOutputUid('coreaudio:a')
      const intentId = queue.deferMonitorOutputUid('coreaudio:b')
      const operation = queue.schedule(
        coordinator,
        failure === 'unsafe-stop'
          ? async () => ({ ok: false as const, safeToRestartPreview: false as const })
          : () => coordinator.stop(),
        () => {
          if (failure === 'rejected-apply') throw new Error('output apply failed')
        },
        vi.fn(),
        'after-drain',
        null,
        intentId
      )

      if (failure === 'rejected-apply') {
        await expect(operation).rejects.toThrow('output apply failed')
      } else {
        await expect(operation).resolves.toBe(false)
      }
      expect(queue.hasDeferredMonitorOutputIntent).toBe(false)
      expect(queue.monitorOutputUid('coreaudio:a')).toBe('coreaudio:a')
      expect(coordinator.hasAudioSafetyLease).toBe(false)
    }
  )

  it('does not let an older failed output edit retire a newer desired route', async () => {
    const { coordinator } = harness()
    const queue = new SettingsRouteApplicationQueue()
    queue.acknowledgeRenderedMonitorOutputUid('coreaudio:a')
    const firstIntent = queue.deferMonitorOutputUid('coreaudio:b')
    const first = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => { throw new Error('B failed') },
      vi.fn(),
      'after-drain',
      null,
      firstIntent
    )
    const secondIntent = queue.deferMonitorOutputUid('coreaudio:c')
    const second = queue.schedule(
      coordinator,
      () => coordinator.stop(),
      () => {
        expect(queue.acknowledgeRenderedMonitorOutputUid('coreaudio:c'))
          .toBe('wait-for-drain')
      },
      vi.fn(),
      'after-drain',
      null,
      secondIntent
    )

    const results = await Promise.allSettled([first, second])
    expect(results[0]).toMatchObject({ status: 'rejected' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: true })
    expect(queue.monitorOutputUid('coreaudio:c')).toBe('coreaudio:c')
    expect(queue.hasDeferredMonitorOutputIntent).toBe(false)
  })
})

describe('song transport audio lease guard', () => {
  it('blocks a new start but lets an already-playing engine pause under the lease', () => {
    const blocked = vi.fn()
    const toggle = vi.fn()

    expect(runSongTransportToggle(false, true, blocked, toggle)).toBe(false)
    expect(blocked).toHaveBeenCalledOnce()
    expect(toggle).not.toHaveBeenCalled()

    expect(runSongTransportToggle(true, true, blocked, toggle)).toBe(true)
    expect(toggle).toHaveBeenCalledOnce()
  })
})

describe('vocal-training audio lease guard', () => {
  it('rejects a closed-Settings direct audio action before it can schedule anything', () => {
    const blocked = vi.fn()
    const schedule = vi.fn()

    expect(runTrainingAudioAction(true, blocked, schedule)).toBe(false)
    expect(blocked).toHaveBeenCalledOnce()
    expect(schedule).not.toHaveBeenCalled()
    expect(runTrainingAudioAction(false, blocked, schedule)).toBe(true)
    expect(schedule).toHaveBeenCalledOnce()
  })

  it('resumes ready auto-start and feedback advance after the global lease clears', () => {
    vi.useFakeTimers()
    try {
      let ready = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
        type: 'choose-exercise', exercise: 'note'
      })
      ready = desktopTrainingReducer(ready, { type: 'start-session', seed: 'lease-resume' })
      expect(shouldAutoStartTrainingPrompt(true, ready)).toBe(false)
      // Rerender after global Stop: the same unconsumed Ready transition is
      // now eligible and can start normally.
      expect(shouldAutoStartTrainingPrompt(false, ready)).toBe(true)

      const feedback = { ...ready, exercisePhase: 'feedback' as const }
      const nextPrompt = vi.fn()
      let cleanup = scheduleTrainingFeedbackAdvance(true, feedback, nextPrompt)
      vi.advanceTimersByTime(1_500)
      expect(nextPrompt).not.toHaveBeenCalled()

      // Rerender with the released lease. Only this render owns a timer.
      cleanup()
      cleanup = scheduleTrainingFeedbackAdvance(false, feedback, nextPrompt)
      vi.advanceTimersByTime(350)
      expect(nextPrompt).toHaveBeenCalledOnce()
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('explains the lease and disables test-note and session-start controls after Settings closes', () => {
    const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    const html = renderToStaticMarkup(createElement(VocalTraining, {
      state: setup,
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      audioLeaseBlocked: true,
      onSetupChange: vi.fn(),
      referenceVolume: 1,
      onReferenceVolumeChange: vi.fn(),
      progress: emptyTrainingProgress(),
      songPreparation: null,
      onBackToSong: vi.fn()
    }))

    expect(html).toContain(TRAINING_AUDIO_LEASE_COPY)
    expect(html).toContain('Open Settings to review the audio owner or retry the output route')
    expect(html).not.toContain('Stop headphone monitoring')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Test C4/s)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start practice<\/button>/)
  })

  it('shows training-cleanup provenance without presenting it as monitoring/output ownership', () => {
    const setup = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    const html = renderToStaticMarkup(createElement(VocalTraining, {
      state: setup,
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      audioLeaseBlocked: true,
      audioLeaseCopy: TRAINING_CLEANUP_AUDIO_BLOCKED_COPY,
      onSetupChange: vi.fn(),
      referenceVolume: 1,
      onReferenceVolumeChange: vi.fn(),
      progress: emptyTrainingProgress(),
      songPreparation: null,
      onBackToSong: vi.fn()
    }))

    expect(html).toContain(TRAINING_CLEANUP_AUDIO_BLOCKED_COPY)
    expect(html).not.toContain('Open Settings to review the audio owner')
    expect(html).not.toContain('headphone monitoring')
    expect(pitchMicrophoneUnavailableCopy(
      false,
      true,
      TRAINING_CLEANUP_AUDIO_BLOCKED_COPY
    )).toBe(TRAINING_CLEANUP_AUDIO_BLOCKED_COPY)
  })

  it('blocks audio preparation, continue, and replay entry points but leaves key setup available', () => {
    const common = {
      dispatch: vi.fn(),
      engine: { context: { currentTime: 0 } } as never,
      cues: {} as never,
      mic: {} as never,
      onMicDevice: vi.fn(),
      audioLeaseBlocked: true,
      onSetupChange: vi.fn(),
      referenceVolume: 1,
      onReferenceVolumeChange: vi.fn(),
      progress: emptyTrainingProgress(),
      onBackToSong: vi.fn()
    }
    const homeHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common,
      state: INITIAL_DESKTOP_TRAINING_STATE,
      songPreparation: {
        sourceSongId: '/song', songName: 'Song',
        key: { tonicPc: 0, mode: 'major' as const }, transpose: 0
      }
    }))
    expect(homeHtml.match(/<button type="button" disabled="">/g)).toHaveLength(4)

    const unknownKeyHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common,
      state: INITIAL_DESKTOP_TRAINING_STATE,
      songPreparation: {
        sourceSongId: '/song', songName: 'Unknown Key Song', key: null, transpose: 0
      }
    }))
    expect(unknownKeyHtml).toContain('Confirm the song key first')
    expect(unknownKeyHtml).toContain('Choose any preparation focus to open setup')
    expect(unknownKeyHtml).not.toMatch(/<button type="button" disabled="">(?:Notes|Intervals|Chords|Mixed warm-up)<\/button>/)

    let session = desktopTrainingReducer(INITIAL_DESKTOP_TRAINING_STATE, {
      type: 'choose-exercise', exercise: 'note'
    })
    session = desktopTrainingReducer(session, { type: 'start-session', seed: 'lease-ui' })
    session = desktopTrainingReducer(session, { type: 'activate-session' })
    const respond = desktopTrainingReducer(session, { type: 'cue-complete' })
    const respondHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common, state: respond, songPreparation: null
    }))
    expect(respondHtml).toMatch(/<button[^>]*aria-label="Replay target note" disabled=""/)

    const interrupted = desktopTrainingReducer(session, { type: 'interrupt-runtime' })
    const interruptedHtml = renderToStaticMarkup(createElement(VocalTraining, {
      ...common, state: interrupted, songPreparation: null
    }))
    expect(interruptedHtml).toMatch(/<button[^>]*disabled=""[^>]*>Continue practice<\/button>/)
  })
})
