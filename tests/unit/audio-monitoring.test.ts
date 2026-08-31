import { describe, expect, it, vi } from 'vitest'
import {
  DesktopMonitorCoordinator,
  linearToDbfs,
  monitorErrorCopy
} from '../../src/renderer/src/audio/monitoring'
import type {
  DesktopMonitorConfig,
  DesktopMonitorResult,
  DesktopMonitorStatus
} from '../../src/shared/types'

const config: DesktopMonitorConfig = {
  inputDeviceUid: 'coreaudio:usb',
  outputDeviceUid: 'coreaudio:usb',
  inputChannels: [2],
  outputChannels: [0, 1],
  sampleRate: 48000,
  bufferFrames: 128,
  maximumFrames: 512,
  exclusive: false
}

const result = (ok = true, errorCode: Exclude<DesktopMonitorResult['errorCode'], 'none'> = 'host-failure'): DesktopMonitorResult => {
  const common = {
    ownershipGeneration: '41',
    state: ok ? 'running' as const : 'error' as const,
    format: {
    sampleRate: 48000,
    maximumFrames: 512,
    nominalBufferFrames: 128,
    inputChannels: 1,
    outputChannels: 2,
    sampleFormat: 'float32-planar',
    outputClockMaster: true,
    accessMode: 'shared'
    } as const,
    latency: {
    inputDeviceFrames: 32,
    outputDeviceFrames: 48,
    bufferFrames: 128,
    externalRouteFrames: 0
    }
  }
  return ok
    ? { ...common, ok: true, errorCode: 'none', error: '' }
    : { ...common, ok: false, errorCode, error: 'fixture failure' }
}

const status = (enabled: boolean, callbacks = '1'): DesktopMonitorStatus => ({
  active: true,
  enabled,
  deviceLost: false,
  ownershipGeneration: '41',
  gainDb: -12,
  state: 'running',
  error: '',
  pre: { peak: 0.5, rms: 0.25, frames: '128' },
  post: { peak: 0.25, rms: 0.125, frames: '128' },
  format: result().format,
  latency: result().latency,
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

describe('DesktopMonitorCoordinator', () => {
  it('hands off in safety order and waits for a current native callback before active', async () => {
    const calls: string[] = []
    const statuses = [status(false), status(true, '2')]
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async (actual) => { calls.push(`begin:${actual.inputDeviceUid}`); return result() },
        setMonitorGain: async (generation, gain, enabled) => {
          calls.push(`gain:${generation}:${gain}:${enabled}`)
          return result()
        },
        monitorStatus: async () => { calls.push('status'); return statuses.shift() ?? status(true, '3') },
        endMonitor: async (generation) => { calls.push(`end:${generation}`); return result() }
      },
      stopPreview: async () => { calls.push('preview-stop') },
      pauseSong: () => { calls.push('song-pause') },
      releaseLegacyOutput: async () => { calls.push('web-release') },
      restoreLegacyOutput: async () => { calls.push('web-restore') },
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })

    expect(await coordinator.start(config, -12)).toBe(true)
    expect(coordinator.snapshot.phase).toBe('active')
    expect(calls.slice(0, 7)).toEqual([
      'preview-stop',
      'song-pause',
      'web-release',
      'begin:coreaudio:usb',
      'status',
      'gain:41:-12:true',
      'status'
    ])

    expect(await coordinator.stop()).toEqual({ ok: true, safeToRestartPreview: true })
    expect(calls.slice(-4)).toEqual([
      'preview-stop',
      'gain:41:-60:false',
      'end:41',
      'web-restore'
    ])
    expect(coordinator.snapshot.phase).toBe('idle')
  })

  it('does not accept enabled readiness until the native host is running', async () => {
    const monitorStatus = vi.fn()
      .mockResolvedValueOnce(status(false))
      .mockResolvedValueOnce({ ...status(true, '2'), state: 'stopped' as const })
      .mockResolvedValueOnce(status(true, '3'))
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async () => result(),
        monitorStatus,
        endMonitor: async () => ({ ...result(), state: 'stopped' as const })
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => undefined,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })

    expect(await coordinator.start(config, -12)).toBe(true)
    expect(monitorStatus).toHaveBeenCalledTimes(3)
  })

  it('restores Web Audio after a typed begin refusal without enabling native output', async () => {
    const calls: string[] = []
    const refused = result(false, 'platform-not-ready')
    const inactive = { ...status(false, '0'), active: false, ownershipGeneration: '0', state: 'closed' as const }
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => { calls.push('begin'); return refused },
        setMonitorGain: vi.fn(),
        monitorStatus: async () => { calls.push('status'); return inactive },
        endMonitor: async () => { calls.push('end'); return refused }
      },
      stopPreview: async () => { calls.push('preview-stop') },
      pauseSong: () => { calls.push('song-pause') },
      releaseLegacyOutput: async () => { calls.push('web-release') },
      restoreLegacyOutput: async () => { calls.push('web-restore') },
      sleep: async () => undefined
    })

    expect(await coordinator.start(config, -12)).toBe(false)
    expect(calls).toEqual([
      'preview-stop', 'song-pause', 'web-release', 'begin', 'status',
      'preview-stop', 'web-restore'
    ])
    expect(coordinator.snapshot).toMatchObject({
      phase: 'error',
      message: 'Headphone monitoring is not available on Windows yet. Native output stayed off.'
    })
  })

  it('does not release Web Audio or call native begin when preview stop is unconfirmed', async () => {
    const begin = vi.fn(async () => result())
    const release = vi.fn(async () => undefined)
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: begin,
        setMonitorGain: vi.fn(),
        monitorStatus: vi.fn(),
        endMonitor: vi.fn()
      },
      stopPreview: async () => { throw new Error('The native microphone did not confirm that it stopped.') },
      pauseSong: vi.fn(),
      releaseLegacyOutput: release,
      restoreLegacyOutput: vi.fn(),
      sleep: async () => undefined
    })

    expect(await coordinator.start(config, -12)).toBe(false)
    expect(begin).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(coordinator.snapshot.message).toContain('did not confirm')
  })

  it('stops native ownership when an active gain ramp is refused', async () => {
    const calls: string[] = []
    const statuses = [status(false), status(true, '2')]
    let gainCalls = 0
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async (_generation, gain, enabled) => {
          calls.push(`gain:${gain}:${enabled}`)
          gainCalls++
          return gainCalls === 2 ? result(false, 'queue-full') : result()
        },
        monitorStatus: async () => statuses.shift() ?? status(true, '3'),
        endMonitor: async () => { calls.push('end'); return result() }
      },
      stopPreview: async () => { calls.push('preview-stop') },
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => { calls.push('web-restore') },
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })

    expect(await coordinator.start(config, -12)).toBe(true)
    expect(await coordinator.setGain(-9)).toBe(false)
    expect(calls.slice(-4)).toEqual(['preview-stop', 'gain:-60:false', 'end', 'web-restore'])
    expect(coordinator.snapshot).toMatchObject({ phase: 'error' })
    expect(coordinator.snapshot.message).toContain('queue is busy')
  })

  it.each(['success', 'refusal', 'rejection'] as const)(
    'ignores a delayed gain %s after explicit Stop has completed',
    async (settlement) => {
      let settleGain!: () => void
      const pendingGain = new Promise<DesktopMonitorResult>((resolve, reject) => {
        settleGain = () => {
          if (settlement === 'rejection') reject(new Error('late control rejection'))
          else resolve(settlement === 'success' ? result() : result(false, 'queue-full'))
        }
      })
      const statuses = [status(false), status(true, '2')]
      const endMonitor = vi.fn(async () => ({ ...result(), state: 'stopped' as const }))
      const terminal = vi.fn()
      const coordinator = new DesktopMonitorCoordinator({
        api: {
          beginMonitor: async () => result(),
          setMonitorGain: async (_generation, gain) => gain === -9 ? pendingGain : result(),
          monitorStatus: async () => statuses.shift() ?? status(true, '3'),
          endMonitor
        },
        stopPreview: async () => undefined,
        pauseSong: () => undefined,
        releaseLegacyOutput: async () => undefined,
        restoreLegacyOutput: async () => undefined,
        onTerminalStop: terminal,
        sleep: async () => undefined,
        callbackTimeoutMs: 10,
        pollMs: 1
      })

      expect(await coordinator.start(config, -12)).toBe(true)
      const gain = coordinator.setGain(-9)
      await Promise.resolve()
      expect(await coordinator.stop()).toEqual({ ok: true, safeToRestartPreview: true })
      settleGain()

      await expect(gain).resolves.toBe(false)
      expect(coordinator.snapshot).toMatchObject({ phase: 'idle', message: 'Monitoring is off.' })
      expect(endMonitor).toHaveBeenCalledOnce()
      expect(terminal).not.toHaveBeenCalled()
    }
  )

  it('does not let an old gain refusal stop a newer active generation', async () => {
    let settleOldGain!: () => void
    const oldGain = new Promise<DesktopMonitorResult>((resolve) => {
      settleOldGain = () => resolve({
        ...result(false, 'queue-full'),
        ownershipGeneration: '41'
      })
    })
    let generation = '41'
    let statusCall = 0
    const currentResult = (): DesktopMonitorResult => ({
      ...result(),
      ownershipGeneration: generation
    })
    const currentStatus = (): DesktopMonitorStatus => ({
      ...status(statusCall % 2 === 1, String(statusCall + 1)),
      ownershipGeneration: generation
    })
    const endMonitor = vi.fn(async () => ({ ...currentResult(), state: 'stopped' as const }))
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => { statusCall = 0; return currentResult() },
        setMonitorGain: async (requestedGeneration, gain) =>
          requestedGeneration === '41' && gain === -9 ? oldGain : currentResult(),
        monitorStatus: async () => { const value = currentStatus(); statusCall += 1; return value },
        endMonitor
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => undefined,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })

    expect(await coordinator.start(config, -12)).toBe(true)
    const staleGain = coordinator.setGain(-9)
    await Promise.resolve()
    expect(await coordinator.stop()).toMatchObject({ ok: true })
    generation = '42'
    expect(await coordinator.start(config, -6)).toBe(true)
    settleOldGain()

    await expect(staleGain).resolves.toBe(false)
    expect(coordinator.snapshot).toMatchObject({ phase: 'active' })
    expect(coordinator.snapshot.result?.ownershipGeneration).toBe('42')
    expect(endMonitor).toHaveBeenCalledOnce()
    await coordinator.stop()
  })

  it.each([
    ['telemetry', true],
    ['telemetry', false],
    ['gain', true],
    ['gain', false]
  ] as const)(
    'notifies Settings after internal %s teardown (end confirmed: %s)',
    async (trigger, endConfirmed) => {
      const statuses = [status(false), status(true, '2')]
      const terminal = vi.fn()
      const restore = vi.fn(async () => undefined)
      const coordinator = new DesktopMonitorCoordinator({
        api: {
          beginMonitor: async () => result(),
          setMonitorGain: async (_generation, gain, enabled) =>
            trigger === 'gain' && enabled && gain === -9
              ? result(false, 'queue-full')
              : result(),
          monitorStatus: async () => statuses.shift() ?? (
            trigger === 'telemetry'
              ? { ...status(true, '3'), deviceLost: true, state: 'device-lost' as const, error: 'route gone' }
              : status(true, '3')
          ),
          endMonitor: async () => endConfirmed
            ? { ...result(), state: 'stopped' as const }
            : result(false, 'graph-failure')
        },
        stopPreview: async () => undefined,
        pauseSong: () => undefined,
        releaseLegacyOutput: async () => undefined,
        restoreLegacyOutput: restore,
        onTerminalStop: terminal,
        sleep: async () => undefined,
        callbackTimeoutMs: 10,
        pollMs: 1
      })
      expect(await coordinator.start(config, -12)).toBe(true)

      if (trigger === 'telemetry') await coordinator.refreshStatus()
      else expect(await coordinator.setGain(-9)).toBe(false)

      expect(terminal).toHaveBeenCalledOnce()
      expect(terminal).toHaveBeenCalledWith(endConfirmed
        ? { ok: true, safeToRestartPreview: true }
        : expect.objectContaining({ ok: false, safeToRestartPreview: false }))
      expect(restore).toHaveBeenCalledTimes(endConfirmed ? 1 : 0)
      expect(coordinator.hasNativeOwnership).toBe(!endConfirmed)
    }
  )

  it('keeps Web Audio released when native teardown cannot confirm', async () => {
    const restore = vi.fn(async () => undefined)
    const statuses = [status(false), status(true, '2')]
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async () => result(),
        monitorStatus: async () => statuses.shift() ?? status(true, '3'),
        endMonitor: async () => result(false, 'graph-failure')
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: restore,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })

    expect(await coordinator.start(config, -12)).toBe(true)
    expect(await coordinator.stop()).toMatchObject({ ok: false, safeToRestartPreview: false })
    expect(restore).not.toHaveBeenCalled()
    expect(coordinator.snapshot.message).toContain('Song output remains released')
    expect(coordinator.hasNativeOwnership).toBe(true)
  })

  it('single-flights concurrent stop callers into one native end and restore', async () => {
    let releaseEnd!: () => void
    const endGate = new Promise<void>((resolve) => { releaseEnd = resolve })
    const endMonitor = vi.fn(async () => {
      await endGate
      return { ...result(), state: 'stopped' as const }
    })
    const restore = vi.fn(async () => undefined)
    const statuses = [status(false), status(true, '2')]
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async () => result(),
        monitorStatus: async () => statuses.shift() ?? status(true, '3'),
        endMonitor
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: restore,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })
    expect(await coordinator.start(config, -12)).toBe(true)

    const first = coordinator.stop()
    const second = coordinator.stop()
    await vi.waitFor(() => expect(endMonitor).toHaveBeenCalledTimes(1))
    releaseEnd()
    await expect(first).resolves.toEqual({ ok: true, safeToRestartPreview: true })
    await expect(second).resolves.toEqual({ ok: true, safeToRestartPreview: true })
    expect(endMonitor).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
    expect(coordinator.hasNativeOwnership).toBe(false)
  })

  it('stops once when cleanup interrupts first-callback confirmation', async () => {
    let releaseStatus!: (value: DesktopMonitorStatus) => void
    const statusGate = new Promise<DesktopMonitorStatus>((resolve) => { releaseStatus = resolve })
    const endMonitor = vi.fn(async () => ({ ...result(), state: 'stopped' as const }))
    const restore = vi.fn(async () => undefined)
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async () => result(),
        monitorStatus: async () => statusGate,
        endMonitor
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: restore,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })
    const starting = coordinator.start(config, -12)
    await Promise.resolve()
    await Promise.resolve()
    const stopping = coordinator.stop()
    releaseStatus(status(false))

    await expect(starting).resolves.toBe(false)
    await expect(stopping).resolves.toEqual({ ok: true, safeToRestartPreview: true })
    expect(endMonitor).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('single-flights overlapping telemetry refreshes', async () => {
    let releaseStatus!: (value: DesktopMonitorStatus) => void
    const statuses = [status(false), status(true, '2')]
    const monitorStatus = vi.fn(async () => {
      if (statuses.length > 0) return statuses.shift()!
      return new Promise<DesktopMonitorStatus>((resolve) => { releaseStatus = resolve })
    })
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async () => result(),
        monitorStatus,
        endMonitor: async () => ({ ...result(), state: 'stopped' as const })
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => undefined,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })
    expect(await coordinator.start(config, -12)).toBe(true)
    const first = coordinator.refreshStatus()
    const second = coordinator.refreshStatus()
    expect(monitorStatus).toHaveBeenCalledTimes(3)
    releaseStatus(status(true, '3'))
    await Promise.all([first, second])
    expect(monitorStatus).toHaveBeenCalledTimes(3)
  })

  it('ignores a delayed telemetry rejection after explicit Stop takes ownership', async () => {
    let rejectRefresh!: (error: Error) => void
    const statuses = [status(false), status(true, '2')]
    const monitorStatus = vi.fn(async () => {
      if (statuses.length > 0) return statuses.shift()!
      return new Promise<DesktopMonitorStatus>((_resolve, reject) => {
        rejectRefresh = reject
      })
    })
    const terminal = vi.fn()
    const coordinator = new DesktopMonitorCoordinator({
      api: {
        beginMonitor: async () => result(),
        setMonitorGain: async () => result(),
        monitorStatus,
        endMonitor: async () => ({ ...result(), state: 'stopped' as const })
      },
      stopPreview: async () => undefined,
      pauseSong: () => undefined,
      releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => undefined,
      onTerminalStop: terminal,
      sleep: async () => undefined,
      callbackTimeoutMs: 10,
      pollMs: 1
    })
    expect(await coordinator.start(config, -12)).toBe(true)

    const refresh = coordinator.refreshStatus()
    await vi.waitFor(() => expect(monitorStatus).toHaveBeenCalledTimes(3))
    await expect(coordinator.stop()).resolves.toEqual({ ok: true, safeToRestartPreview: true })
    rejectRefresh(new Error('late status bridge rejection'))
    await refresh

    expect(terminal).not.toHaveBeenCalled()
    expect(coordinator.snapshot).toMatchObject({
      phase: 'idle',
      message: 'Monitoring is off.'
    })
  })
})

describe('monitoring scalar presentation', () => {
  it('clamps meters to their declared dBFS range', () => {
    expect(linearToDbfs(0)).toBe(-72)
    expect(linearToDbfs(1)).toBe(0)
    expect(linearToDbfs(0.5)).toBeCloseTo(-6.02, 1)
    expect(linearToDbfs(Number.NaN)).toBe(-72)
  })

  it('uses actionable route and platform errors', () => {
    expect(monitorErrorCopy(result(false, 'unsupported-route'))).toContain('wired audio device')
    expect(monitorErrorCopy(result(false, 'native-audio-busy'))).toContain('Stop the preview')
  })
})
