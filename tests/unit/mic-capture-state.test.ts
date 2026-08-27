import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CaptureStartResult } from '../../src/shared/types'
import {
  captureStateEnded,
  clearStaleMicError,
  MIC_OPEN_FAILURE,
  MicPitch,
  MicPreview,
  micToggleCopy,
  settingsMicDisplay,
  type MicDevice
} from '../../src/renderer/src/audio/mic'

const started: CaptureStartResult = {
  ok: true,
  state: 'running',
  sampleRate: 48000,
  inputChannel: 2,
  deviceUid: 'fixture:1',
  deviceLabel: 'Fixture',
  deviceChannels: 4,
  sampleFormat: 'float32',
  sharingMode: 'shared',
  performanceMode: 'callback',
  timestampSource: 'hardware'
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
})

describe('captureStateEnded', () => {
  it('distinguishes permission denial from an unavailable saved device or channel', () => {
    expect(micToggleCopy('denied')).toEqual(
      expect.objectContaining({
        label: expect.stringContaining('System Settings'),
        title: expect.stringContaining('access is blocked')
      })
    )
    expect(micToggleCopy('unavailable')).toEqual(
      expect.objectContaining({
        label: expect.stringContaining('Audio settings'),
        title: expect.stringContaining('saved microphone or channel')
      })
    )

    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/PitchStrip.tsx'),
      'utf8'
    )
    const startAttempt = source.indexOf('const m = await startMic')
    const permissionFailure = source.slice(source.indexOf('if (!allowed)'), startAttempt)
    const openFailure = source.slice(source.indexOf('if (!m)', startAttempt), source.indexOf('micRef.current = m', startAttempt))
    expect(permissionFailure).toContain("setMic('denied')")
    expect(permissionFailure).not.toContain("setMic('unavailable')")
    expect(openFailure).toContain("setMic('unavailable')")
    expect(openFailure).not.toContain("setMic('denied')")
  })

  it('truthfully describes the durable exact-device preference after an open failure', () => {
    expect(MIC_OPEN_FAILURE.toLowerCase()).not.toContain('selection was not changed')
    expect(MIC_OPEN_FAILURE.toLowerCase()).toContain('selection is still saved')
    expect(MIC_OPEN_FAILURE.toLowerCase()).toContain('reconnect or free the device')

    const copySources = ['PitchStrip.tsx', 'SettingsModal.tsx'].map((name) =>
      readFileSync(resolve(process.cwd(), 'src/renderer/src/components', name), 'utf8')
    )
    expect(copySources.join('\n').toLowerCase()).not.toContain('saved selection was not changed')
  })

  it('gives live song, active preview, then retained song error explicit display precedence', () => {
    const live: MicDevice = {
      id: 'song', label: 'Song mic', inputChannel: 0, fallback: false
    }
    const preview: MicDevice = {
      id: 'preview', label: 'Test mic', inputChannel: 1, fallback: false
    }
    const failed: MicDevice = {
      id: 'failed', label: '', inputChannel: 2, fallback: false, error: 'Exact channel failed'
    }

    expect(settingsMicDisplay(live, preview, true)).toEqual({ device: live, source: 'song' })
    expect(settingsMicDisplay(failed, preview, true)).toEqual({ device: preview, source: 'preview' })
    expect(settingsMicDisplay(failed, preview, false)).toEqual({
      device: failed,
      source: 'song-error'
    })
    expect(settingsMicDisplay(null, preview, false)).toEqual({ device: null, source: 'none' })
  })

  it('clears only stale failures for a new selection or successful preview', () => {
    const live: MicDevice = {
      id: 'live', label: 'Live mic', inputChannel: 0, fallback: false
    }
    const failed: MicDevice = { ...live, error: 'Old failure' }
    expect(clearStaleMicError(failed)).toBeNull()
    expect(clearStaleMicError(live)).toBe(live)
    expect(clearStaleMicError(null)).toBeNull()
  })

  it('preserves the exact-device error when a live settings switch cannot restart', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/PitchStrip.tsx'),
      'utf8'
    )
    const start = source.indexOf('// startMic already published the exact device/channel failure.')
    const end = source.indexOf('    })()', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const failureCleanup = source.slice(start, end)
    expect(failureCleanup).toContain("setMic('unavailable')")
    expect(failureCleanup).toContain('trailRef.current = []')
    expect(failureCleanup).toContain('onMicLevelRef.current?.(-120)')
    expect(failureCleanup).not.toContain('onMicDeviceRef.current')
  })

  it('ends only the matching generation on terminal native state', () => {
    expect(captureStateEnded({ state: 'error', ownershipGeneration: '7' }, '7')).toBe(true)
    expect(captureStateEnded({ state: 'stopped', ownershipGeneration: '7' }, '7')).toBe(true)
    expect(captureStateEnded({ state: 'running', ownershipGeneration: '7' }, '7')).toBe(false)
    expect(captureStateEnded({ state: 'error', ownershipGeneration: '8' }, '7')).toBe(true)
    expect(captureStateEnded({ state: 'stopped', ownershipGeneration: '0' }, '7')).toBe(true)
    expect(captureStateEnded({ state: 'error', ownershipGeneration: '' }, '7')).toBe(true)
    expect(captureStateEnded({ state: 'running', ownershipGeneration: '' }, '7')).toBe(false)
  })

  it('invalidates a pending native start before it can install device state or a poller', async () => {
    const pending = deferred<CaptureStartResult>()
    const cancelCapture = vi.fn(async () => ({ ok: true as const, cancelled: true }))
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        singz: {
          onCaptureWindow: vi.fn(() => vi.fn()),
          beginCapture: vi.fn(() => pending.promise),
          cancelCapture,
          captureState: vi.fn(async () => ({ state: 'running', ownershipGeneration: '1', error: '' }))
        }
      }
    })

    const mic = new MicPitch()
    const start = mic.start({ deviceId: 'fixture:1', inputChannel: 2 })
    await mic.stop()
    pending.resolve(started)
    await expect(start).resolves.toBe(false)
    expect(mic.active).toBe(false)
    expect(mic.device).toBeNull()
    expect(cancelCapture).toHaveBeenCalled()
  })

  it('tears down a Settings preview stopped during permission/start work', async () => {
    const pending = deferred<CaptureStartResult>()
    const cancelCapture = vi.fn(async () => ({ ok: true as const, cancelled: true }))
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        singz: {
          onCaptureWindow: vi.fn(() => vi.fn()),
          beginCapture: vi.fn(() => pending.promise),
          cancelCapture,
          captureState: vi.fn(async () => ({ state: 'running', ownershipGeneration: '1', error: '' }))
        }
      }
    })

    const preview = new MicPreview()
    const start = preview.start({ deviceId: 'fixture:1', inputChannel: 2 })
    await Promise.resolve()
    await preview.stop() // selection change or dialog close
    pending.resolve(started)
    await expect(start).resolves.toBeNull()
    expect(cancelCapture).toHaveBeenCalled()
  })
})
