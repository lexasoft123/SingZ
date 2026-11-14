import { retainedRecovery, retainedStatus } from '../shared/box-retained-native-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopNativePlaybackClient,
  decideDesktopNativePlayback,
  inspectDesktopNativePlayback,
  tryStartDesktopNativePlayback,
  prepareDesktopNativePlaybackAhead,
  selectDesktopPlaybackBackend,
  type DesktopNativePlaybackEngineRequest,
  type DesktopNativePlaybackFeatures
} from '../../src/renderer/src/audio/desktop-native-playback'
import { clampNativePlaybackRate, clampNativeTranspose, clampPlaybackRate } from '../../src/renderer/src/audio/native-playback-limits'
import { MET_DEFAULTS } from '../../src/renderer/src/audio/beat'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_BASE_MASK,
  DESKTOP_PLAYBACK_CODEC_BASE_TAG,
  DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_FULL_MASK,
  DESKTOP_PLAYBACK_CODEC_FULL_TAG,
  DESKTOP_PLAYBACK_CODEC_PROFILE,
  type DesktopPlaybackRuntimeCapability
} from '../../src/shared/types'
import { GRAPH_NODE_TYPES, parseGraphDocument } from '../../src/shared/graph-document'

const runtime = (full = false): DesktopPlaybackRuntimeCapability => ({
  available: true, playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
  mediaCodec: {
    abiVersion: 1,
    formatMask: full ? DESKTOP_PLAYBACK_CODEC_FULL_MASK : DESKTOP_PLAYBACK_CODEC_BASE_MASK,
    capabilityTag: full ? DESKTOP_PLAYBACK_CODEC_FULL_TAG : DESKTOP_PLAYBACK_CODEC_BASE_TAG,
    dynamicallyLinkedFfmpeg: full, runtimeVersion: full ? 'proven-runtime' : '',
    target: full ? 'darwin-arm64' : '', profile: full ? DESKTOP_PLAYBACK_CODEC_PROFILE : '',
    extensions: [...(full ? DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS : DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS)]
  }
})
const features = (): DesktopNativePlaybackFeatures => ({
  enabled: true, playbackRate: 1, transpose: 0, training: null,
  lanes: [{ id: 'guide', path: '/authorized/guide.flac' }], runtime: runtime()
})
it('admits 300-character Windows and namespaced stem paths', () => {
  const path='C:\\'+('p'.repeat(100)+'\\').repeat(3)+'vocals.flac'
  for(const value of [path,'\\\\?\\'+path]) expect(selectDesktopPlaybackBackend('win32',{...features(),lanes:[{id:'guide',path:value}]}).backend).toBe('native')
  expect(selectDesktopPlaybackBackend('win32',{...features(),lanes:[{id:'guide',path:'C:\\'+('p'.repeat(200)+'\\').repeat(164)+'vocals.flac'}]}).backend).toBe('legacy')
})
const request = (): DesktopNativePlaybackEngineRequest => ({
  ...features(), lanes: [{ id: 'guide', path: '/authorized/guide.flac', volume: 1, muted: false, solo: false }],
  nativePlaybackEnabled: true, nativeAudioProvider: 'wasapi', graphDocument: null,
  beat: null, metronome: { ...MET_DEFAULTS }, countIn: false, positionSeconds: 0,
  durationSeconds: 10, sampleRate: 48000, masterGain: 1, loop: null
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.stubGlobal('navigator', { platform: 'MacIntel' })
  vi.stubGlobal('window', { singz: { desktopPlaybackCapability: vi.fn(async () => runtime()) } })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('native selector admission diagnostics (ADR 0015 WP1a)', () => {
  it.each([0.25, 0.49, 0.5, 1.5, 1.51, 4])('accepts core tempo %s, including the former decline band', (playbackRate) => {
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), playbackRate }).backend).toBe('native')
  })
  it.each([-24, -13, -0.5, 0.5, 13, 24])('accepts core fractional/broader transpose %s', (transpose) => {
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), transpose }).backend).toBe('native')
  })
  it.each([[0.25, 24], [4, -24]])('accepts the inclusive time-pitch correction boundary at rate %s, transpose %s', (playbackRate, transpose) => {
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), playbackRate, transpose }).backend).toBe('native')
  })
  it.each([0, -1, 0.24999, 4.00001, NaN, Infinity])('names invalid tempo %s', (playbackRate) => {
    const decision = selectDesktopPlaybackBackend('darwin', { ...features(), playbackRate })
    expect(decision).toMatchObject({ backend: 'legacy', failure: { code: 'graph-rejected', detail: expect.stringContaining('0.25..4') } })
    expect(console.warn).toHaveBeenCalledWith('Native playback declined:', expect.objectContaining({ code: 'graph-rejected' }))
  })
  it.each([-24.001, 24.001, NaN, Infinity])('names invalid transpose %s', (transpose) => {
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), transpose })).toMatchObject({
      backend: 'legacy', failure: { code: 'graph-rejected', detail: expect.stringContaining('-24..24') }
    })
  })
  it('accepts 1..16 lanes and explicitly names empty and excessive songs', () => {
    for (const count of [0, 1, 16, 17]) {
      const lanes = Array.from({ length: count }, (_, i) => ({ id: `lane-${i}`, path: `/song/${i}.flac` }))
      const decision = selectDesktopPlaybackBackend('darwin', { ...features(), lanes })
      if (count === 1 || count === 16) expect(decision.backend).toBe('native')
      else expect(decision).toMatchObject({ backend: 'legacy', failure: {
        code: 'graph-rejected', detail: expect.stringContaining(count === 0 ? 'song is empty' : '17 lanes')
      } })
    }
  })
  it.each(DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS)('accepts proven format %s case-insensitively', (extension) => {
    expect(selectDesktopPlaybackBackend('darwin', {
      ...features(), runtime: runtime(true), lanes: [{ id: 'guide', path: `C:\\Music\\guide.${extension.toUpperCase()}` }]
    }).backend).toBe('native')
  })
  it.each([undefined, '/song/guide', '/song/guide.', '/song/.flac', '/song/guide.M4A?download=1', '/song/guide.wav#fragment', '/dir.flac/guide', '/song/guide.xyz'])('names lane and unsupported/absent format for %s', (path) => {
    expect(selectDesktopPlaybackBackend('darwin', {
      ...features(), runtime: runtime(true), lanes: [{ id: 'guide', path }]
    })).toMatchObject({ backend: 'legacy', failure: {
      code: 'graph-rejected', laneId: 'guide', format: expect.any(String), detail: expect.stringContaining('lane guide')
    } })
  })
  it('never treats the importable codec list as proof of runtime decoder support', () => {
    const lanes = [{ id: 'guide', path: '/song/guide.M4A' }]
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), lanes })).toMatchObject({
      backend: 'legacy', failure: { code: 'graph-rejected', laneId: 'guide', format: 'm4a' }
    })
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), lanes, runtime: runtime(true) }).backend).toBe('native')
  })
  it.each([
    { runtime: null },
    { runtime: { ...runtime(), available: false } },
    { runtime: { ...runtime(), mediaCodec: { ...runtime().mediaCodec, abiVersion: 2 } } as unknown as DesktopPlaybackRuntimeCapability },
    { runtime: { ...runtime(), mediaCodec: undefined } as unknown as DesktopPlaybackRuntimeCapability }
  ])('names missing or incompatible addon capability', (patch) => {
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), ...patch })).toMatchObject({
      backend: 'legacy', failure: { code: 'addon-unavailable', detail: expect.any(String) }
    })
  })
  it('names disabled native playback and mismatched providers', () => {
    expect(selectDesktopPlaybackBackend('darwin', { ...features(), enabled: false })).toMatchObject({ failure: { code: 'disabled-by-preference' } })
    expect(selectDesktopPlaybackBackend('linux', { ...features(), requestedProvider: 'wasapi' })).toMatchObject({
      failure: { code: 'provider-unavailable', detail: expect.stringContaining('wasapi') }
    })
  })
  it('returns capability exceptions to callers and logs them instead of losing them in null', async () => {
    window.singz.desktopPlaybackCapability = vi.fn(async () => { throw new Error('addon did not load') })
    const onDecline = vi.fn()
    expect(await decideDesktopNativePlayback(request(), onDecline)).toBeNull()
    expect(onDecline).toHaveBeenCalledWith({ code: 'addon-unavailable', detail: expect.stringContaining('addon did not load') })
    expect(console.warn).toHaveBeenCalledWith('Native playback declined:', expect.objectContaining({ code: 'addon-unavailable' }))
  })
  it.each([tryStartDesktopNativePlayback, prepareDesktopNativePlaybackAhead])('retains selector failures on the boolean adapter client', async (admit) => {
    const client = new DesktopNativePlaybackClient({ releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => undefined }, () => undefined)
    const onDecline = vi.fn()
    expect(await admit(client, { ...request(), playbackRate: 0.1 }, onDecline)).toBe(false)
    expect(client.lastFailure).toMatchObject({ code: 'graph-rejected', detail: expect.stringContaining('0.25..4') })
    expect(onDecline).toHaveBeenCalledWith(client.lastFailure)
  })
  it('returns the complete synthesized node cause breakdown on cap overflow', async () => {
    const req = request()
    req.lanes = Array.from({ length: 40 }, (_, i) => ({ ...req.lanes[0], id: `lane-${i}` }))
    req.playbackRate = 0.8
    req.training = { mode: 'period', periodSec: 8, stems: ['lane-0'] }
    const decision = await inspectDesktopNativePlayback(req)
    expect(decision).toMatchObject({ backend: 'legacy', failure: { code: 'graph-rejected', detail:
      'native graph exceeds 128 nodes: total=131, lanes=40 (120 nodes), training stems=1 (1 nodes), reference=5, time-pitch=1, mix/master/limiter/output=4'
    } })
  })
  it.each([128, 129])('names explicit graph node cap overflow at %s and admits the cap itself', async (count) => {
    const graphDocument = parseGraphDocument(JSON.stringify({ format: 1, engine: 'singz-dsp',
      nodes: Array.from({ length: count }, (_, i) => ({ id: String(i + 1), type: GRAPH_NODE_TYPES.gain,
        typeVersion: 1, execution: 'builtin', unavailable: 'silence',
        ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] }, parameters: { gain: 1 } })), connections: [] }))
    const decision = await inspectDesktopNativePlayback({ ...request(), graphDocument })
    if (count === 128) expect(decision.backend).toBe('native')
    else expect(decision).toMatchObject({ backend: 'legacy', failure: { code: 'graph-rejected', detail: expect.stringContaining('native topology cap') } })
  })
  it.each([[0.25, 13.5], [4, -24]])('reattaches retained tempo %s/transpose %s without rejecting valid native controls', async (playbackRate, transposeSemitones) => {
    const snapshot = retainedStatus('7', 'playing', { playbackRate, transposeSemitones })
    vi.stubGlobal('window', { singz: { boxAudioPersistent: true } })
    const client = new DesktopNativePlaybackClient({ releaseLegacyOutput: async () => undefined,
      restoreLegacyOutput: async () => undefined }, () => undefined)
    try {
      expect(client.attachRetained(retainedRecovery(snapshot), null)).toMatchObject({ playbackRate, transpose: transposeSemitones })
    } finally { await client.detachPersistentPlayback() }
  })
  it('passes broad tempo/fractional transpose unchanged into the actual native prepare request', async () => {
    expect(await decideDesktopNativePlayback({ ...request(), playbackRate: 0.25, transpose: 13.5 })).toMatchObject({
      playbackRate: 0.25, transpose: 13.5
    })
  })
})

describe('desktop control admission bounds', () => {
  it('clamps tempo to 0.25..4 and keeps rates rejected by the old clamp', () => {
    expect([-1, 0.25, 0.49, 1.6, 4, 5, NaN].map(clampNativePlaybackRate)).toEqual([0.25, 0.25, 0.49, 1.6, 4, 4, 1])
  })
  it('rounds to integer semitones (product keys) and clamps at the core bound', () => {
    expect([-25, -24, -13.4, 0.4, 13, 24, 25, NaN].map(clampNativeTranspose)).toEqual([-24, -24, -13, 0, 13, 24, 24, 0])
  })
  it('keeps the narrow tempo range on the Web Audio path; the wide one only when native owns playback', () => {
    expect([0.25, 0.49, 0.5, 1.5, 1.6, 4, NaN].map((r) => clampPlaybackRate(r, false))).toEqual([0.5, 0.5, 0.5, 1.5, 1.5, 1.5, 1])
    expect([0.25, 0.49, 1.6, 4, 5].map((r) => clampPlaybackRate(r, true))).toEqual([0.25, 0.49, 1.6, 4, 4])
  })
  it('sends the controls through the real engine methods: native widens tempo, Web Audio keeps the narrow range', async () => {
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const make = (active: boolean) => {
      const engine: InstanceType<typeof MultitrackEngine> = Object.create(MultitrackEngine.prototype)
      const reconfigure = vi.fn(async () => undefined)
      Object.assign(engine, { rate: 1, semitones: 0, teardownStarted: false,
        nativePlayback: { active, reconfigure },
        scheduleNativePrepareAhead: vi.fn(), emit: vi.fn(),
        applyRate(this: { rate: number }, r: number) { this.rate = r }, applyStretchState: async () => undefined })
      return { engine, reconfigure }
    }
    const native = make(true)
    await native.engine.setTempo(0.25)
    await native.engine.setTranspose(13.4)
    expect(native.reconfigure.mock.calls).toEqual([[{ playbackRate: 0.25 }], [{ transpose: 13 }]])
    expect(native.engine.tempo).toBe(0.25)
    await native.engine.setTempo(5)
    await native.engine.setTranspose(-25)
    expect(native.engine.tempo).toBe(4)
    expect(native.engine.transpose).toBe(-24)
    const web = make(false)
    await web.engine.setTempo(0.25)
    expect(web.engine.tempo).toBe(0.5) // negative control: not the native 0.25
    await web.engine.setTempo(4)
    expect(web.engine.tempo).toBe(1.5)
  })
})
