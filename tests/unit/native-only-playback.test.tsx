import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import PlaybackFailurePanel from '../../src/renderer/src/components/PlaybackFailurePanel'
import { NATIVE_PLAYBACK_FAILURE_KEYS, nativePlaybackFailureCopy, type DesktopNativePlaybackFailureCode } from '../../src/renderer/src/audio/native-playback-failure'
import { DesktopNativePlaybackClient } from '../../src/renderer/src/audio/desktop-native-playback'
import { sanitizeAudioPrefs } from '../../src/renderer/src/model'
import { MET_DEFAULTS } from '../../src/renderer/src/audio/beat'
import { retainedStatus } from '../shared/box-retained-native-fixture'
import type { DesktopPlaybackErrorCode, DesktopPlaybackResult, SingzApi } from '../../src/shared/types'

const started = vi.fn(() => { throw new Error('Web Audio source must never start') })
const source = vi.fn(() => ({ buffer: null, playbackRate: { value: 1 }, connect() {}, disconnect() {}, stop() {}, start: started }))
class Context {
  currentTime = 0; sampleRate = 48000; state = 'suspended'; destination = {}
  createGain() { return { gain: { value: 1, setTargetAtTime() {}, setValueAtTime() {} }, connect() {}, disconnect() {} } }
  createBufferSource = source
}
const codes = Object.keys(NATIVE_PLAYBACK_FAILURE_KEYS) as DesktopNativePlaybackFailureCode[]
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { singz: {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  source.mockClear(); started.mockClear()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('native-only blocking failure contract', () => {
  it.each(codes)('%s shows its translated reason and cannot start a browser source', async code => {
    const failure = { code, detail: `diagnostic-${code}`, ...(code === 'format-unreadable' ? { laneId: 'guide', format: 'm4a' } : {}) }
    const engine = new MultitrackEngine()
    engine.setNativeAheadAllowed(false)
    engine.load([{ id: 'guide', path: '/song/guide.flac', duration: 10, buffer: { duration: 10 } as AudioBuffer }])
    const client = { active: false, recoveryPending: false, lastFailure: failure }
    Object.assign(engine, { ensureNativePlayback: async () => ({ client, tryStart: async () => false }) })
    await expect(engine.play()).rejects.toThrow(failure.detail)
    expect(engine.playing).toBe(false)
    expect(engine.playbackError?.failure).toEqual(failure)
    expect(engine.playbackError?.userInitiated).toBe(true)
    const markup = renderToStaticMarkup(<PlaybackFailurePanel error={engine.playbackError!} onRetry={() => engine.retryPlayback()} onChooseDevice={() => {}} />)
    expect(markup).toContain('role="alertdialog"')
    expect(markup).toContain(`data-failure-code="${code}"`)
    expect(markup).toContain(nativePlaybackFailureCopy(failure))
    expect(markup).toContain('Retry')
    expect(markup).toContain('Choose device')
    expect(source).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
    expect(engine.getTrackBuffer('guide')).not.toBeNull()
    expect(engine.playbackError).not.toBeNull()
    await engine.teardown()
  })

  it('ignores and never writes either old preference store on failure or retry', async () => {
    const storage = { getItem: vi.fn(() => '0'), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', storage)
    expect(sanitizeAudioPrefs({ nativePlayback: false })).toEqual({})
    expect(sanitizeAudioPrefs({ nativePlayback: true })).toEqual({})
    const engine = new MultitrackEngine()
    engine.setNativeAheadAllowed(false)
    engine.load([{ id: 'guide', path: '/song/guide.flac', duration: 10, buffer: null }])
    const client = { active: false, recoveryPending: false, lastFailure: { code: 'addon-unavailable', detail: 'addon' } }
    const tryStart = vi.fn(async () => false)
    Object.assign(engine, { ensureNativePlayback: async () => ({ client, tryStart }) })
    await expect(engine.play()).rejects.toThrow()
    await expect(engine.retryPlayback()).rejects.toThrow()
    expect(tryStart).toHaveBeenCalledTimes(2)
    expect(storage.getItem).not.toHaveBeenCalledWith('singz.desktop.native-playback')
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(app).not.toContain('audioPrefs.nativePlayback')
    expect(app).not.toContain('singz.desktop.native-playback')
    await engine.teardown()
  })

  it('keeps retry and device actions independent from dismissible app toasts', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    expect(app).toContain('setEnginePlaybackError(engine.playbackError)')
    expect(app).toContain('onRetry={() => engine.retryPlayback()}')
    expect(app).toContain('setSettingsAudioRouteFocus(true); setShowSettings(true)')
    expect(app).toContain('if (engine.playbackError) return')
    expect(app).not.toContain('playbackErrorToast')
    for (const path of ['src/renderer/src/audio/engine.ts', 'src/renderer/src/audio/desktop-native-playback.ts']) {
      const text = readFileSync(path, 'utf8')
      for (const removed of ['setSinkId', 'releaseLegacyOutput', 'restoreLegacyOutput', 'setDesktopPlaybackNativeOutputCurrent', 'browserOutputId', "'native:'"]) expect(text).not.toContain(removed)
    }
  })
})

const wireCodes: Exclude<DesktopPlaybackErrorCode, 'none'>[] = ['invalid-generation', 'invalid-state', 'invalid-configuration', 'cancelled', 'decode-failure', 'limit-exceeded', 'resource-exhausted', 'graph-failure', 'host-failure', 'provider-failure', 'queue-full', 'teardown-uncertain', 'unsupported-playback-rate', 'native-audio-busy', 'platform-not-ready', 'unauthorized-path', 'path-too-long']
describe('bridge failure preservation', () => {
  it.each(wireCodes)('preserves prepare result %s through the native client', async errorCode => {
    const result: DesktopPlaybackResult = { ok: false, errorCode, error: `refused-${errorCode}`, generation: '0', state: 'unloaded', format: retainedStatus().format, latency: retainedStatus().latency }
    const api = {
      desktopPlaybackProviders: async () => [{ id: 'coreaudio', available: true }],
      audioHostDevices: async () => ({ ok: true, provider: 'coreaudio', defaultOutputUid: 'speaker', devices: [{ uid: 'speaker', outputChannels: 2, nominalSampleRate: 48000, bufferFrames: { preferredFrames: 128, minimumFrames: 32, maximumFrames: 1024, fundamentalFrames: 1 } }] }),
      prepareDesktopPlayback: vi.fn(async () => result),
      openDesktopPlayback: vi.fn()
    }
    vi.stubGlobal('window', { singz: api as unknown as SingzApi })
    const client = new DesktopNativePlaybackClient(() => {})
    await expect(client.prepareAndStart({ provider: 'coreaudio', lanes: [{ id: 'guide', path: '/song/guide.flac', gain: 1, muted: false, solo: false }], beat: null, metronome: { ...MET_DEFAULTS }, countIn: false, positionSeconds: 0, durationSeconds: 10, sampleRate: 48000, masterGain: 1, playbackRate: 1, transpose: 0, training: null, loop: null })).rejects.toMatchObject({ failure: { code: errorCode } })
    expect(client.lastFailure?.code).toBe(errorCode)
    expect(api.openDesktopPlayback).not.toHaveBeenCalled()
    await client.unload()
  })
})

it('Retry discards a prepared native graph and prepares again instead of resuming it', async () => {
  const engine = new MultitrackEngine()
  engine.setNativeAheadAllowed(false)
  engine.load([{ id: 'guide', path: '/song/guide.flac', duration: 10, buffer: null }])
  const client = { active: false, preparedAhead: true, recoveryPending: false,
    discardAhead: vi.fn(async () => { client.preparedAhead = false }), resume: vi.fn() }
  const tryStart = vi.fn(async () => true)
  Object.assign(engine, { nativePlayback: client, ensureNativePlayback: async () => ({ client, tryStart }) })
  await engine.retryPlayback()
  expect(client.discardAhead).toHaveBeenCalledOnce()
  expect(tryStart).toHaveBeenCalledOnce()
  expect(client.resume).not.toHaveBeenCalled()
  expect(engine.playbackError).toBeNull()
  expect(started).not.toHaveBeenCalled()
  Object.assign(engine, { nativePlayback: null })
  await engine.teardown()
})

it('a failed prepared-graph cleanup retains its generation for explicit Retry cleanup', async () => {
  const status = retainedStatus('7')
  let clean = false
  const unload = vi.fn(async (generation: string) => ({ ok: clean, errorCode: clean ? 'none' : 'teardown-uncertain', error: clean ? '' : 'cleanup not proven', generation, state: 'unloaded', format: status.format, latency: status.latency, cleanupComplete: clean }))
  const api = {
    desktopPlaybackProviders: async () => [{ id: 'coreaudio', available: true }],
    audioHostDevices: async () => ({ ok: true, provider: 'coreaudio', defaultOutputUid: 'speaker', devices: [{ uid: 'speaker', outputChannels: 2, nominalSampleRate: 48000, bufferFrames: { preferredFrames: 128 } }] }),
    prepareDesktopPlayback: async () => ({ ok: true, errorCode: 'none', error: '', generation: '7', state: 'prepared', format: status.format, latency: status.latency }),
    unloadDesktopPlayback: unload
  }
  vi.stubGlobal('window', { singz: api as unknown as SingzApi })
  const client = new DesktopNativePlaybackClient(() => {})
  expect(await client.prepareAhead({ provider: 'coreaudio', lanes: [{ id: 'guide', path: '/song/guide.flac', gain: 1, muted: false, solo: false }], beat: null, metronome: { ...MET_DEFAULTS }, countIn: false, positionSeconds: 0, durationSeconds: 10, sampleRate: 48000, masterGain: 1, playbackRate: 1, transpose: 0, training: null, loop: null })).toBe(true)
  await expect(client.discardAhead()).rejects.toMatchObject({ failure: { code: 'recovery-required' } })
  expect(client.recoveryMode).toBe('cleanup-required')
  expect(client.active).toBe(true)
  clean = true
  await client.cleanupForRetry()
  expect(unload.mock.calls).toEqual([['7'], ['7']])
  expect(client.recoveryMode).toBe('prepare-retry')
  await client.unload()
  expect(client.active).toBe(false)
})

it('a Retry cleanup failure replaces the previous reason and stays blocked', async () => {
  const engine = new MultitrackEngine()
  engine.setNativeAheadAllowed(false)
  engine.load([{ id: 'guide', path: '/song/guide.flac', duration: 10, buffer: null }])
  const failure = { code: 'recovery-required', detail: 'Previous native generation is still retained' }
  const cause = Object.assign(new Error(failure.detail), { failure })
  Object.assign(engine, { nativePlayback: { active: true, discardAhead: async () => { throw cause } } })
  await expect(engine.retryPlayback()).rejects.toBe(cause)
  expect(engine.playbackError?.failure).toEqual(failure)
  expect(engine.playing).toBe(false)
  expect(started).not.toHaveBeenCalled()
  Object.assign(engine, { nativePlayback: null })
  await engine.teardown()
})


it('marks a prepare-ahead failure as background work, preserving the editor focus policy', async () => {
  const engine = new MultitrackEngine()
  const failure = { code: 'addon-unavailable', detail: 'Prepare ahead could not load audio' }
  const client = { active: false, recoveryPending: false, preparedAhead: false, lastFailure: failure }
  Object.assign(engine, { ensureNativePlayback: async () => ({ client, prepareAhead: async () => false }) })
  engine.load([{ id: 'guide', path: '/song/guide.flac', duration: 10, buffer: null }])
  await vi.advanceTimersByTimeAsync(400)
  expect(engine.playbackError).toMatchObject({ failure, userInitiated: false })
  await engine.teardown()
})
