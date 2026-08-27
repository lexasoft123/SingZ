import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CaptureOwner,
  resolveCaptureAddonPath,
  type NativeCaptureBinding
} from '../../src/main/capture'
import type { CaptureAnalysisWindow, CaptureStartResult } from '../../src/shared/types'

const startResult: CaptureStartResult = {
  ok: true,
  state: 'running',
  sampleRate: 48000,
  inputChannel: 2,
  deviceUid: 'fixture:24',
  deviceLabel: 'Fixture interface',
  deviceChannels: 24,
  sampleFormat: 'float32',
  sharingMode: 'shared',
  performanceMode: 'low-latency',
  timestampSource: 'hardware'
}

const analysisWindow = (generation: string): CaptureAnalysisWindow => ({
  ownershipGeneration: generation,
  resetCount: '0',
  resetReason: 'none',
  start: {
    clockDomainId: '1', streamGeneration: '1', sequence: '1', sourceFrame: '0',
    sampleHostTimeNs: '1', callbackHostTimeNs: '2', quality: 'hardware',
    discontinuity: 'none', flags: 15
  },
  end: {
    clockDomainId: '1', streamGeneration: '1', sequence: '1', sourceFrame: '2048',
    sampleHostTimeNs: '3', callbackHostTimeNs: '4', quality: 'hardware',
    discontinuity: 'none', flags: 15
  },
  deliveredAtNs: '5', bridgeHostTimeNs: '6', callbackToBridgeMs: 0.001,
  sampleRate: 48000, frequency: 220, clarity: 0.99,
  peak: 0.5, rms: 0.25, dbfs: -12
})

function fakeBinding(): NativeCaptureBinding & {
  sink?: (window: CaptureAnalysisWindow) => void
  cancelled: bigint[]
} {
  return {
    cancelled: [],
    buildInfo: { electronVersion: 'test', sourceStamp: 'test' },
    inputDevices: () => ({
      ok: true,
      devices: [{
        uid: 'fixture:24', label: 'Fixture interface', isDefault: true,
        sampleRate: 48000, channels: 24,
        channelLabels: Array.from({ length: 24 }, (_, i) => `Channel ${i + 1}`)
      }]
    }),
    beginCapture(_config, _generation, sink) {
      this.sink = sink
      return startResult
    },
    cancelCapture(generation) {
      this.cancelled.push(generation)
      return { ok: true, cancelled: true }
    },
    captureState: () => ({ state: 'running', ownershipGeneration: '1', error: '' }),
    captureStats: () => ({
      deliveredBlocks: '1', deliveredFrames: '128', overruns: '0',
      deliveryWakeups: '1', droppedEvents: '0', overwrittenWindows: '0'
    })
  }
}

describe('CaptureOwner', () => {
  it('resolves development and packaged addons outside the asar', () => {
    const runtime = {
      packaged: false,
      resourcesPath: '/Applications/SingZ.app/Contents/Resources',
      cwd: '/checkout',
      platform: 'darwin' as const,
      arch: 'arm64'
    }
    expect(resolveCaptureAddonPath(runtime)).toBe(
      '/checkout/vendor/darwin-arm64/singz-capture.node'
    )
    expect(resolveCaptureAddonPath({ ...runtime, packaged: true })).toBe(
      '/Applications/SingZ.app/Contents/Resources/engines/singz-capture.node'
    )
    expect(resolveCaptureAddonPath({ ...runtime, envOverride: './fixture.node' })).toBe(
      resolve('./fixture.node')
    )
  })

  it('delivers copied scalar evidence only to the current renderer generation', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    const received: CaptureAnalysisWindow[] = []
    expect(owner.begin(7, { deviceUid: 'fixture:24', inputChannel: 2 }, '1', (w) => received.push(w))).toEqual(startResult)
    binding.sink?.(analysisWindow('1'))
    binding.sink?.(analysisWindow('2'))
    expect(received.map((window) => window.frequency)).toEqual([220])
    expect(received[0]).not.toHaveProperty('pcm')
  })

  it('rejects stale cancellation and synchronously tears down the owner generation', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    owner.begin(9, { inputChannel: 0 }, '17', () => {})
    expect(owner.cancel(8, '17')).toEqual({ ok: true, cancelled: false })
    expect(owner.cancel(9, '16')).toEqual({ ok: true, cancelled: false })
    expect(owner.cancel(9, '17')).toEqual({ ok: true, cancelled: true })
    expect(binding.cancelled).toEqual([17n])
  })

  it('stops the old generation before a replacement starts', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    owner.begin(3, { inputChannel: 0 }, '41', () => {})
    owner.begin(3, { inputChannel: 1 }, '42', () => {})
    expect(binding.cancelled).toEqual([41n])
  })

  it('binds renderer destruction cleanup only once across restarts', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    expect(owner.bindRendererCleanup(3)).toBe(true)
    expect(owner.bindRendererCleanup(3)).toBe(false)
    owner.begin(3, { deviceUid: 'fixture:24', inputChannel: 2 }, '43', () => {})
    owner.rendererGone(3)
    expect(binding.cancelled).toEqual([43n])
    expect(owner.bindRendererCleanup(3)).toBe(false)
  })

  it('rolls back ownership when native begin throws or returns malformed data', () => {
    const throwing = fakeBinding()
    throwing.beginCapture = () => { throw new Error('bridge down') }
    const thrownOwner = new CaptureOwner(throwing)
    expect(thrownOwner.begin(4, { deviceUid: 'fixture:24', inputChannel: 2 }, '51', () => {})).toMatchObject({
      ok: false,
      state: 'error'
    })
    expect(throwing.cancelled).toEqual([51n])
    expect(thrownOwner.cancel(4, '51')).toEqual({ ok: true, cancelled: false })

    const malformed = fakeBinding()
    malformed.beginCapture = (() => ({ ok: true })) as NativeCaptureBinding['beginCapture']
    const malformedOwner = new CaptureOwner(malformed)
    expect(malformedOwner.begin(5, { deviceUid: 'fixture:24', inputChannel: 2 }, '52', () => {})).toMatchObject({
      ok: false,
      error: 'Native microphone start returned an invalid response.'
    })
    expect(malformed.cancelled).toEqual([52n])
    expect(malformedOwner.cancel(5, '52')).toEqual({ ok: true, cancelled: false })
  })
})
