import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DesktopNativePlaybackClient,
  DesktopNativeProviderError,
  selectDesktopPlaybackBackend
} from '../../src/renderer/src/audio/desktop-native-playback'
import { playbackProviderCanChange } from '../../src/renderer/src/components/SettingsModal'
import type {
  DesktopPlaybackPrepareConfig,
  DesktopPlaybackResult,
  DesktopPlaybackRuntimeCapability,
  DesktopPlaybackStatus,
  SingzApi
} from '../../src/shared/types'
import { GRAPH_NODE_TYPES, parseGraphDocument } from '../../src/shared/graph-document'
import {
  DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_BASE_MASK,
  DESKTOP_PLAYBACK_CODEC_BASE_TAG,
  DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_FULL_MASK,
  DESKTOP_PLAYBACK_CODEC_FULL_TAG,
  DESKTOP_PLAYBACK_CODEC_PROFILE
} from '../../src/shared/types'

const runtime = (full: boolean): DesktopPlaybackRuntimeCapability => ({
  available: true,
  playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
  mediaCodec: full
    ? {
        abiVersion: 1,
        formatMask: DESKTOP_PLAYBACK_CODEC_FULL_MASK,
        dynamicallyLinkedFfmpeg: true,
        runtimeVersion: 'a'.repeat(64),
        capabilityTag: DESKTOP_PLAYBACK_CODEC_FULL_TAG,
        profile: DESKTOP_PLAYBACK_CODEC_PROFILE,
        target: 'darwin-arm64',
        extensions: [...DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS]
      }
    : {
        abiVersion: 1,
        formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
        dynamicallyLinkedFfmpeg: false,
        runtimeVersion: '',
        capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
        profile: '',
        target: '',
        extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS]
      }
})

const eligible = {
  enabled: true,
  playbackRate: 1,
  transpose: 0,
  training: null,
  lanes: [
    { id: 'vocals', path: '/authorized/stems/vocals.flac' },
    { id: 'guitar', path: '/authorized/stems/guitar.wav' }
  ],
  runtime: runtime(false)
}

describe('desktop native playback selection', () => {
  it('renders the persisted Windows provider choice and unavailable ASIO reason in Settings', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('System audio (WASAPI)')
    expect(source).toContain('ASIO unavailable: {asioProviderInfo.detail}')
    expect(source).toContain('onChangeNativeAudioProvider?.(')
    expect(source).toContain(
      'disabled={!playbackProviderCanChange(playbackStatus, nativePlaybackLeaseBlocked)}'
    )
    expect(source).toContain('disabled={nativePlaybackLeaseBlocked}')
  })

  it('uses canonical AudioPrefs injection instead of a second provider mirror', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const engine = readFileSync('src/renderer/src/audio/engine.ts', 'utf8')
    const facade = readFileSync('src/renderer/src/audio/desktop-native-playback.ts', 'utf8')
    expect(app).not.toContain('singz.desktop.audio-provider')
    expect(facade).not.toContain('singz.desktop.audio-provider')
    expect(app).toContain("engine.setNativeAudioProvider(audioPrefs.nativeAudioProvider ?? 'wasapi')")
    expect(engine).toContain('nativeAudioProvider: this.nativeAudioProvider')
  })

  it('selects separate platform providers only for an exact compatible graph', () => {
    expect(selectDesktopPlaybackBackend('darwin', eligible)).toEqual({
      backend: 'native',
      provider: 'coreaudio'
    })
    expect(selectDesktopPlaybackBackend('win32', eligible)).toEqual({
      backend: 'native',
      provider: 'wasapi'
    })
    expect(selectDesktopPlaybackBackend('win32', {
      ...eligible,
      requestedProvider: 'asio'
    })).toEqual({ backend: 'native', provider: 'asio' })
    expect(DESKTOP_PLAYBACK_CAPABILITY).toBe(
      'singz.native.playback-session.anchored-preview.v4'
    )
  })

  it.each([
    [{ ...eligible, enabled: false }, 'native playback is off in Settings'],
    [{ ...eligible, runtime: null }, 'native playback runtime capability is unavailable'],
    [{ ...eligible, playbackRate: 0.49 }, 'tempo is outside the desktop control range'],
    [{ ...eligible, transpose: 13 }, 'transpose is outside the desktop control range'],
    [{ ...eligible, lanes: [{ id: 'guide', path: '/authorized/guide.mp3' }] },
      'a lane needs a format proven by this native runtime']
  ])('stays legacy before ownership for unsupported features', (features, reason) => {
    expect(selectDesktopPlaybackBackend('darwin', features)).toEqual({
      backend: 'legacy',
      reason
    })
  })

  it('never aliases ASIO to WASAPI', () => {
    const decision = selectDesktopPlaybackBackend('win32', eligible)
    expect(decision).toEqual({ backend: 'native', provider: 'wasapi' })
    expect(decision.backend === 'native' && decision.provider).not.toBe('asio')
  })

  it('allows provider replacement only after exact unloaded status', () => {
    expect(playbackProviderCanChange(null)).toBe(false)
    for (const state of ['preparing', 'prepared', 'output-open', 'running', 'stopped',
      'terminal', 'quarantined'] as const) {
      expect(playbackProviderCanChange({ state } as DesktopPlaybackStatus)).toBe(false)
    }
    expect(playbackProviderCanChange({ state: 'unloaded' } as DesktopPlaybackStatus)).toBe(true)
    expect(playbackProviderCanChange(
      { state: 'unloaded' } as DesktopPlaybackStatus,
      true
    )).toBe(false)
  })

  it('selects the complete native graph and full codec matrix only from exact proof', () => {
    const complete = {
      ...eligible,
      playbackRate: 0.8,
      transpose: 4,
      training: { mode: 'period' as const, periodSec: 8, stems: ['vocals'] },
      lanes: [
        { id: 'guide', path: '/authorized/guide.mp3' },
        { id: 'reference', path: '/authorized/reference.m4a' },
        { id: 'choir', path: '/authorized/choir.opus' },
        { id: 'piano', path: '/authorized/piano.aiff' }
      ],
      runtime: runtime(true)
    }
    expect(selectDesktopPlaybackBackend('darwin', complete)).toEqual({
      backend: 'native', provider: 'coreaudio'
    })
    expect(selectDesktopPlaybackBackend('darwin', {
      ...complete,
      runtime: {
        ...runtime(true),
        mediaCodec: { ...runtime(true).mediaCodec, capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG }
      }
    })).toEqual({
      backend: 'legacy', reason: 'native playback runtime capability is unavailable'
    })
  })
})

const result = (
  generation: string,
  state: DesktopPlaybackResult['state'] = 'prepared',
  cleanupComplete?: boolean
): DesktopPlaybackResult => ({
  ok: true,
  errorCode: 'none',
  error: '',
  generation,
  state,
  format: {
    sampleRate: 48_000,
    maximumFrames: 4096,
    nominalBufferFrames: 128,
    inputChannels: 0,
    outputChannels: 2
  },
  latency: {
    inputDeviceFrames: 0,
    outputDeviceFrames: 64,
    bufferFrames: 128,
    externalRouteFrames: 0
  },
  ...(cleanupComplete === undefined ? {} : { cleanupComplete })
})

const status = (generation: string, frame = '-960'): DesktopPlaybackStatus => ({
  capability: DESKTOP_PLAYBACK_CAPABILITY,
  generation,
  state: 'running',
  hostState: 'running',
  terminalReason: '',
  terminalOrdinal: '0',
  transportGeneration: generation,
  transportState: 'pre-roll',
  transportTelemetryQuality: 'current',
  lastTransportBoundary: 'start',
  renderedProjectFrame: frame,
  audibleProjectFrame: frame,
  audibleProjectionQuality: 'current',
  continuousFrame: '128',
  durationFrames: '480000',
  remainingPreRollFrames: '960',
  cueEventsCompleted: 1,
  nextCueEventIndex: 1,
  presentationLatencyFrames: '128',
  graphLatencyFrames: '64',
  devicePresentationLatencyFrames: '64',
  totalPresentationLatencyFrames: '128',
  renderedFrames: '128',
  audibleFrames: '64',
  routeGeneration: '1',
  streamGeneration: '1',
  callbacks: '1',
  xruns: '0',
  deadlineMisses: '0',
  discontinuities: '0',
  invalidCallbacks: '0',
  renderFailures: '0',
  loopEnabled: true,
  loopStartFrame: '48000',
  loopEndFrame: '96000',
  loopCount: '0',
  seekCount: '0',
  transportDiscontinuities: '0',
  playbackRate: 0.8,
  transposeSemitones: 3,
  timePitchAnchorsPrepared: '1',
  timePitchAnchorsPublished: '1',
  timePitchAnchorMisses: '0',
  timePitchReplacementReady: true,
  timePitchLoopPriming: true,
  preparedStartProjectFrame: '-960',
  swapPendingGeneration: '0',
  retiringSwapGeneration: '0',
  swapLandings: 0,
  swapLateLandings: 0,
  swapPrimeNs: '0',
  swapLandingFrames: '0',
  retainedBytes: '1024',
  graphArenaBytes: '512',
  parkedLaneBytes: '0',
  parkedLaneCount: 0,
  masterGain: 0.7,
  referenceGain: 0.5,
  trainingEnabled: true,
  trainingLanes: ['vocals'],
  preRollFrames: '1920',
  cueEventCount: 8,
  countInEventCount: 4,
  countInBeatsPerBar: 4,
  previewClicksEnqueued: '0',
  previewClicksStarted: '0',
  previewClicksCompleted: '0',
  previewClicksPending: 0,
  laneDecodeFallback: '',
  topology: 'source→mix→output',
  graphNodeCount: 5,
  graphConnectionCount: 4,
  latencyCompensatedEdgeCount: 1,
  graphSnapshot: null,
  graphStatusCode: 0,
  graphStatusDetail: 0,
  timePitchAnchorOutcome: 0,
  adapterRenderFailures: 0,
  terminalRenderFailures: 0,
  parameterOverflows: 0,
  nonFiniteSamples: 0,
  rejectedBlocks: 0,
  error: '',
  format: result(generation).format,
  latency: result(generation).latency,
  lanes: []
})

const asioRequest = () => ({
  provider: 'asio' as const,
  lanes: [{ id: 'vocals', path: '/allowed/vocals.flac', gain: 1, muted: false, solo: false }],
  beat: null,
  metronome: { click: false, countInBars: 0, volume: 0.6, accent: true, grid: false },
  countIn: false,
  positionSeconds: 0,
  durationSeconds: 10,
  sampleRate: 48_000,
  masterGain: 1,
  playbackRate: 1,
  transpose: 0,
  training: null,
  loop: null
})

const asioPollingApi = (
  readStatus: () => Promise<DesktopPlaybackStatus>,
  unload: (generation: string) => Promise<DesktopPlaybackResult>
): SingzApi => ({
  desktopPlaybackProviders: vi.fn(async () => [{
    id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
  }]),
  audioHostDevices: vi.fn(async () => ({
    ok: true, platform: 'win32', provider: 'asio', defaultInputUid: '',
    defaultOutputUid: 'asio:driver-guid:output-1',
    devices: [{
      uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
      defaultOutput: true, inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
      outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000, direction: 'output',
      accessMode: 'exclusive', transport: 'virtual', monitoringSuitability: 'low-latency',
      sampleRateRanges: [],
      bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
    }]
  })),
  prepareDesktopPlayback: vi.fn(async () => result('1')),
  openDesktopPlayback: vi.fn(async () => result('1', 'output-open')),
  startDesktopPlayback: vi.fn(async () => result('1', 'running')),
  stopDesktopPlayback: vi.fn(async () => result('1', 'stopped')),
  desktopPlaybackStatus: vi.fn(readStatus),
  unloadDesktopPlayback: vi.fn(unload),
  pauseDesktopPlayback: vi.fn(async () => result('1', 'running')),
  resumeDesktopPlayback: vi.fn(async () => result('1', 'running')),
  seekDesktopPlayback: vi.fn(async () => result('1', 'running')),
  setDesktopPlaybackLoop: vi.fn(async () => result('1', 'running')),
  clearDesktopPlaybackLoop: vi.fn(async () => result('1', 'running')),
  setDesktopPlaybackLane: vi.fn(async () => result('1', 'running')),
  setDesktopPlaybackMasterGain: vi.fn(async () => result('1', 'running'))
} as unknown as SingzApi)

const nonDefaultSongGraph = () => parseGraphDocument(JSON.stringify({
  format: 1,
  engine: 'singz-dsp',
  nodes: [
    { id: '1', type: GRAPH_NODE_TYPES.projectLaneSource, typeVersion: 1, execution: 'native',
      unavailable: 'silence', ports: { inputs: [], outputs: [{ id: 'out', channels: 1 }] },
      parameters: {}, binding: { kind: 'project-lane', laneId: 'vocals' } },
    { id: '2', type: GRAPH_NODE_TYPES.channelMap, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 1 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: {}, binding: { kind: 'project-lane', laneId: 'vocals' } },
    { id: '3', type: GRAPH_NODE_TYPES.gain, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: { gain: 1 }, binding: { kind: 'project-lane', laneId: 'vocals' } },
    { id: '4', type: GRAPH_NODE_TYPES.mix, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'lane:vocals', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] }, parameters: {} },
    { id: '5', type: GRAPH_NODE_TYPES.gain, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: { gain: 1 }, binding: { kind: 'song-master' } },
    { id: '6', type: GRAPH_NODE_TYPES.gain, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: { gain: 0.5 }, opaqueLayout: { x: 42 } },
    { id: '7', type: GRAPH_NODE_TYPES.cueSource, typeVersion: 1, execution: 'native',
      unavailable: 'silence', ports: { inputs: [], outputs: [{ id: 'out', channels: 1 }] },
      parameters: {}, binding: { kind: 'reference-cues' } },
    { id: '8', type: GRAPH_NODE_TYPES.channelMap, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 1 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: {}, binding: { kind: 'reference-map' } },
    { id: '9', type: GRAPH_NODE_TYPES.gain, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: { gain: 1 }, binding: { kind: 'reference-gain' } },
    { id: '10', type: GRAPH_NODE_TYPES.mix, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'song', channels: 2 }, { id: 'reference', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] }, parameters: {} },
    { id: '11', type: GRAPH_NODE_TYPES.gain, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: { gain: 1 }, binding: { kind: 'output-gain' } },
    { id: '12', type: GRAPH_NODE_TYPES.safetyLimiter, typeVersion: 1, execution: 'builtin',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] }, parameters: { ceiling: 0.891250938 } },
    { id: '13', type: GRAPH_NODE_TYPES.physicalOutput, typeVersion: 1, execution: 'native',
      unavailable: 'silence', ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [] },
      parameters: {}, binding: { kind: 'project-output' } }
  ],
  connections: [
    ['1', 'out', '2', 'in'], ['2', 'out', '3', 'in'], ['3', 'out', '4', 'lane:vocals'],
    ['4', 'out', '5', 'in'], ['5', 'out', '6', 'in'], ['6', 'out', '10', 'song'],
    ['7', 'out', '8', 'in'], ['8', 'out', '9', 'in'], ['9', 'out', '10', 'reference'],
    ['10', 'out', '11', 'in'], ['11', 'out', '12', 'in'], ['12', 'out', '13', 'in']
  ].map(([fromNode, fromPort, toNode, toPort]) => ({
    from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort }
  }))
}))

describe('desktop native playback facade', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('prepares every native feature and hot-swaps at the exact signed frame without legacy overlap', async () => {
    let generation = '1'
    let nextGeneration = 0
    const prepared: Array<{ config: Parameters<SingzApi['prepareDesktopPlayback']>[0]; lanes: Parameters<SingzApi['prepareDesktopPlayback']>[1] }> = []
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'coreaudio', label: 'CoreAudio', available: true, errorCode: 'none', detail: ''
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true,
        platform: 'darwin',
        provider: 'coreaudio',
        defaultInputUid: '',
        defaultOutputUid: 'speaker',
        error: '',
        devices: [{
          uid: 'speaker', label: 'Speaker', defaultInput: false, defaultOutput: true,
          inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000,
          direction: 'output', accessMode: 'shared', transport: 'built-in',
          monitoringSuitability: 'low-latency',
          sampleRateRanges: [{ minimumHz: 48_000, maximumHz: 48_000 }],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async (config, lanes) => {
        generation = String(++nextGeneration)
        prepared.push({ config, lanes })
        return result(generation)
      }),
      openDesktopPlayback: vi.fn(async (value) => result(value, 'output-open')),
      startDesktopPlayback: vi.fn(async (value) => result(value, 'running')),
      stopDesktopPlayback: vi.fn(async (value) => result(value, 'stopped')),
      desktopPlaybackStatus: vi.fn(async () => status(generation)),
      unloadDesktopPlayback: vi.fn(async (value) => result(value, 'unloaded', true)),
      setDesktopPlaybackLane: vi.fn(async (value) => result(value, 'running')),
      setDesktopPlaybackMasterGain: vi.fn(async (value) => result(value, 'running'))
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const release = vi.fn(async () => undefined)
    const restore = vi.fn(async () => undefined)
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: release, restoreLegacyOutput: restore },
      () => undefined
    )

    expect(await client.prepareAndStart({
      provider: 'coreaudio',
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: { beats: [0, 0.5, 1, 1.5], bpm: 120, beatsPerBar: 4, downbeat: 0,
        downbeats: [0], source: 'auto' },
      metronome: { click: true, countInBars: 1, volume: 0.6, accent: true, grid: false },
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0.7,
      playbackRate: 0.8,
      transpose: 3,
      training: { mode: 'windows', windows: [{ s: 2, e: 4 }], stems: ['vocals'] },
      loop: { start: 1, end: 2 },
      graphDocument: nonDefaultSongGraph()
    })).toBe(true)
    expect(prepared[0].config).toMatchObject({
      capability: DESKTOP_PLAYBACK_CAPABILITY,
      provider: 'coreaudio',
      accessMode: 'shared',
      playback: {
        transport: { playbackRate: 0.8, transposeSemitones: 3 },
        cues: { click: true, countInBars: 1 }
      },
      training: {
        mode: 'windows',
        windows: [{ startProjectFrame: 96_000, endProjectFrame: 192_000 }],
        laneIds: ['vocals'],
        enabled: true
      },
      initialTransport: {
        state: 'playing',
        loop: { startProjectFrame: 48_000, endProjectFrame: 96_000 }
      }
    })
    expect(prepared[0].config).not.toHaveProperty('preparedStartProjectFrame')
    expect(prepared[0].config.graphDocument?.nodes.find((node) => node.id === '6')).toMatchObject({
      id: '6', type: GRAPH_NODE_TYPES.gain, parameters: { gain: 0.5 }
    })
    expect(prepared[0].config.graphDocument?.nodes.find((node) => node.id === '6'))
      .not.toHaveProperty('opaqueLayout')
    expect(prepared[0].config.graphDocument?.connections).toEqual(expect.arrayContaining([
      { from: { node: '5', port: 'out' }, to: { node: '6', port: 'in' } },
      { from: { node: '6', port: 'out' }, to: { node: '10', port: 'song' } }
    ]))

    const gainAccepted = client.updateLane('vocals', { gain: 0.4 })
    const muteAccepted = client.updateLane('vocals', { muted: true })
    await expect(gainAccepted).resolves.toEqual({ gain: 0.4, muted: false, solo: false })
    await expect(muteAccepted).resolves.toEqual({ gain: 0.4, muted: true, solo: false })
    await client.setMasterGain(0.5)
    await client.reconfigure({
      playbackRate: 1.1,
      transpose: -2,
      metronome: { click: false, countInBars: 0, volume: 0.4, accent: false, grid: false },
      training: { mode: 'period', periodSec: 3, stems: ['vocals'] }
    })
    // A structural change while the song renders is a SEAM now: the candidate
    // is prepared naming the running generation, the core hands the clock
    // across at a block boundary and retires the old graph itself — no stop,
    // no unload. The frame primes the replacement's Stretch anchor and a
    // pre-roll frame has no place in it (−960 → 0).
    expect(api.stopDesktopPlayback).not.toHaveBeenCalled()
    expect(api.unloadDesktopPlayback).not.toHaveBeenCalled()
    expect(prepared[1].config).toMatchObject({
      swapFromGeneration: '1',
      preparedStartProjectFrame: 0,
      masterGain: 0.5,
      playback: {
        transport: { playbackRate: 1.1, transposeSemitones: -2 },
        cues: { click: false, countInBars: 0 }
      },
      training: { mode: 'period', periodFrames: 144_000, laneIds: ['vocals'], enabled: true },
      initialTransport: { state: 'playing' }
    })
    expect(prepared[1].lanes[0]).toMatchObject({ gain: 0.4, muted: true, solo: false })
    expect(prepared[1].config.graphDocument).toEqual(prepared[0].config.graphDocument)
    expect(release).toHaveBeenCalledTimes(1)
    expect(restore).not.toHaveBeenCalled()

    await client.unload()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('a second rebuild queued behind the first restores the intended transport, not the snapshot', async () => {
    // Measured on the desktop player-session run (2026-09-05): the click and
    // the count-in toggled within one popover visit are two structural
    // rebuilds back to back. The second read the status of the generation the
    // first had prepared 80 ms earlier — start acknowledged, transport not yet
    // reported running — took 'stopped' for a pause, and re-prepared the song
    // paused. The music stopped and Play had to be pressed again.
    let generation = '1'
    let nextGeneration = 0
    const prepared: DesktopPlaybackPrepareConfig[] = []
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'coreaudio', label: 'CoreAudio', available: true, errorCode: 'none', detail: ''
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true, platform: 'darwin', provider: 'coreaudio', defaultInputUid: '',
        defaultOutputUid: 'speaker', error: '',
        devices: [{
          uid: 'speaker', label: 'Speaker', defaultInput: false, defaultOutput: true,
          inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000,
          direction: 'output', accessMode: 'shared', transport: 'built-in',
          monitoringSuitability: 'low-latency',
          sampleRateRanges: [{ minimumHz: 48_000, maximumHz: 48_000 }],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async (config: DesktopPlaybackPrepareConfig) => {
        generation = String(++nextGeneration)
        prepared.push(config)
        return result(generation)
      }),
      openDesktopPlayback: vi.fn(async (value: string) => result(value, 'output-open')),
      startDesktopPlayback: vi.fn(async (value: string) => result(value, 'running')),
      stopDesktopPlayback: vi.fn(async (value: string) => result(value, 'stopped')),
      // Every status after the first generation reads the transport as
      // freshly prepared and not yet running — what the core reports in the
      // window between the start acknowledgement and the render thread's
      // first report.
      desktopPlaybackStatus: vi.fn(async () => ({
        ...status(generation, '48000'),
        transportState: generation === '1' ? 'playing' : 'stopped'
      })),
      pauseDesktopPlayback: vi.fn(async (value: string) => result(value, 'running')),
      unloadDesktopPlayback: vi.fn(async (value: string) => result(value, 'unloaded', true)),
      setDesktopPlaybackLane: vi.fn(async (value: string) => result(value, 'running')),
      setDesktopPlaybackMasterGain: vi.fn(async (value: string) => result(value, 'running'))
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    const metronome = { click: false, countInBars: 0, volume: 0, accent: true, grid: false }
    expect(await client.prepareAndStart({
      provider: 'coreaudio',
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: { beats: [0, 0.5, 1, 1.5], bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats: [0], source: 'auto' },
      metronome,
      // Play's count-in permission travels in the request: with it off the
      // count-in toggle changes no cue and is no rebuild at all.
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    })).toBe(true)
    // The click, then the count-in, as fast as a thumb: two rebuilds, the
    // second queued behind the first.
    await Promise.all([
      client.reconfigure({ metronome: { ...metronome, click: true } }),
      client.reconfigure({ metronome: { ...metronome, click: true, countInBars: 1 } })
    ])
    expect(prepared).toHaveLength(3)
    expect(prepared[1].initialTransport).toMatchObject({ state: 'playing' })
    expect(prepared[2].initialTransport).toMatchObject({ state: 'playing' })
    // And a rebuild after a real pause restores the pause.
    await client.pause()
    await client.reconfigure({ metronome: { ...metronome, click: true, countInBars: 2 } })
    expect(prepared[3].initialTransport).toMatchObject({ state: 'paused' })
    await client.unload()
  })

  /** A CoreAudio harness for the seam tests: prepare mints generations, the
   *  status mock is whatever `nextStatus` returns, every call is recorded. */
  const seamHarness = (nextStatus: (generation: string, reads: number) => DesktopPlaybackStatus) => {
    let generation = '1'
    let nextGeneration = 0
    let reads = 0
    const prepared: DesktopPlaybackPrepareConfig[] = []
    const calls: string[] = []
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'coreaudio', label: 'CoreAudio', available: true, errorCode: 'none', detail: ''
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true, platform: 'darwin', provider: 'coreaudio', defaultInputUid: '',
        defaultOutputUid: 'speaker', error: '',
        devices: [{
          uid: 'speaker', label: 'Speaker', defaultInput: false, defaultOutput: true,
          inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000,
          direction: 'output', accessMode: 'shared', transport: 'built-in',
          monitoringSuitability: 'low-latency',
          sampleRateRanges: [{ minimumHz: 48_000, maximumHz: 48_000 }],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async (config: DesktopPlaybackPrepareConfig) => {
        generation = String(++nextGeneration)
        prepared.push(config)
        calls.push(`prepare:${generation}${config.swapFromGeneration ? `:swap-from-${config.swapFromGeneration}` : ''}`)
        return result(generation)
      }),
      openDesktopPlayback: vi.fn(async (value: string) => { calls.push(`open:${value}`); return result(value, 'output-open') }),
      startDesktopPlayback: vi.fn(async (value: string) => { calls.push(`start:${value}`); return result(value, 'running') }),
      stopDesktopPlayback: vi.fn(async (value: string) => { calls.push(`stop:${value}`); return result(value, 'stopped') }),
      pauseDesktopPlayback: vi.fn(async (value: string) => { calls.push(`pause:${value}`); return result(value, 'running') }),
      resumeDesktopPlayback: vi.fn(async (value: string) => { calls.push(`resume:${value}`); return result(value, 'running') }),
      seekDesktopPlayback: vi.fn(async (value: string) => { calls.push(`seek:${value}`); return result(value, 'running') }),
      desktopPlaybackStatus: vi.fn(async () => nextStatus(generation, ++reads)),
      unloadDesktopPlayback: vi.fn(async (value: string) => { calls.push(`unload:${value}`); return result(value, 'unloaded', true) }),
      setDesktopPlaybackLane: vi.fn(async (value: string) => result(value, 'running')),
      setDesktopPlaybackMasterGain: vi.fn(async (value: string) => result(value, 'running'))
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    const metronome = { click: false, countInBars: 0, volume: 0, accent: true, grid: false }
    const start = () => client.prepareAndStart({
      provider: 'coreaudio',
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: { beats: [0, 0.5, 1, 1.5], bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats: [0], source: 'auto' },
      metronome,
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    })
    return { api, client, prepared, calls, metronome, start, generationNow: () => generation }
  }
  const playing = (generation: string, patch: Partial<DesktopPlaybackStatus> = {}): DesktopPlaybackStatus => ({
    ...status(generation, '48000'),
    transportState: 'playing',
    loopEnabled: false,
    // The fixture's default rate is 0.8; the clock tests read in real seconds.
    playbackRate: 1,
    ...patch
  })

  it('a cue change while playing is a SEAM: one prepare naming the old generation, no stop, no unload, and the transport lands on the new one', async () => {
    // Measured on the desktop player-session harness: training on was an
    // 840-900 ms rebuild, and every metronome touch one too; the phones seam
    // these, and the core does the whole hand-over once a prepare names the
    // generation it replaces. The transport telemetry names the OLD
    // generation until the render thread lands the seam.
    let landAfterRead = Infinity
    const h = seamHarness((generation, reads) =>
      playing(generation, {
        transportGeneration: generation === '2' && reads < landAfterRead ? '1' : generation,
        swapPendingGeneration: generation === '2' && reads < landAfterRead ? '1' : '0'
      })
    )
    expect(await h.start()).toBe(true)
    const reads = (h.api.desktopPlaybackStatus as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    landAfterRead = reads + 3
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...h.metronome, click: true } })
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])
    expect(h.prepared[1]).toMatchObject({ swapFromGeneration: '1', initialTransport: { state: 'playing' } })
    expect(h.prepared[1].preparedStartProjectFrame).toBe(48_000)
    expect(h.client.status).toMatchObject({ generation: '2', transportGeneration: '2' })
    expect(h.client.transportActive).toBe(true)
    await h.client.unload()
  })

  it('a seam the core refuses falls back to the rebuild, asking for the refused candidate\'s receipt on the way', async () => {
    const h = seamHarness((generation) => playing(generation))
    expect(await h.start()).toBe(true)
    const prepare = h.api.prepareDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    prepare.mockImplementationOnce(async (config: DesktopPlaybackPrepareConfig) => {
      h.prepared.push(config)
      h.calls.push('prepare:2:swap-from-1:refused')
      return { ...result('2'), ok: false, errorCode: 'invalid-state', error: 'cannot replace that generation on its stream' }
    })
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...h.metronome, click: true } })
    expect(h.calls).toEqual(['prepare:2:swap-from-1:refused', 'unload:2', 'stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[2]).not.toHaveProperty('swapFromGeneration')
    expect(h.prepared[2].initialTransport).toMatchObject({ state: 'playing' })
    await h.client.unload()
  })

  it('a refusal that echoes the RUNNING generation unloads nothing: the rebuild takes it from there', async () => {
    // Main's own busy guard answers a prepare with the live generation's
    // number, not a candidate's. Treating that as a refused candidate
    // unloaded the playing graph on the first real seam attempt.
    const h = seamHarness((generation) => playing(generation))
    expect(await h.start()).toBe(true)
    const prepare = h.api.prepareDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    prepare.mockImplementationOnce(async (config: DesktopPlaybackPrepareConfig) => {
      h.prepared.push(config)
      h.calls.push('prepare:swap:busy')
      return { ...result('1'), ok: false, errorCode: 'native-audio-busy', error: 'Unload the active native player before preparing another.' }
    })
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...h.metronome, click: true } })
    expect(h.calls).toEqual(['prepare:swap:busy', 'stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    await h.client.unload()
  })

  it('a paused song is rebuilt, not seamed: the core only seams a running generation', async () => {
    const h = seamHarness((generation) => playing(generation))
    expect(await h.start()).toBe(true)
    await h.client.pause()
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...h.metronome, click: true } })
    expect(h.calls[0]).toBe('stop:1')
    expect(h.prepared[1]).not.toHaveProperty('swapFromGeneration')
    expect(h.prepared[1].initialTransport).toMatchObject({ state: 'paused' })
    await h.client.unload()
  })

  it('transportParked follows the intent, not a snapshot that still says stopped', async () => {
    // Every status reads 'stopped' — what a generation reports for ~80 ms
    // after its start is acknowledged. A pause issued then used to be
    // skipped as "already parked" while the core played on.
    const h = seamHarness((generation) => playing(generation, { transportState: 'stopped' }))
    expect(await h.start()).toBe(true)
    expect(h.client.transportParked).toBe(false)
    await h.client.pause()
    expect(h.client.transportParked).toBe(true)
    await h.client.resume()
    expect(h.client.transportParked).toBe(false)
    await h.client.unload()
  })

  it('the audible position is projected between polls, bounded, folded at the loop, and pre-empted by an accepted seek', async () => {
    vi.setSystemTime(new Date('2026-09-06T00:00:00Z'))
    const h = seamHarness((generation) =>
      playing(generation, { audibleProjectFrame: '48000', loopEnabled: true, loopStartFrame: '0', loopEndFrame: '192000', seekCount: '0' })
    )
    expect(await h.start()).toBe(true)
    // The poller would re-read under the fake clock and move the read time;
    // this test is about what happens BETWEEN reads.
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    // The last read is 1.0 s in; 100 ms later the bar shows 1.1 s.
    expect(h.client.audibleSeconds()).toBeCloseTo(1.0, 3)
    vi.advanceTimersByTime(100)
    expect(h.client.audibleSeconds()).toBeCloseTo(1.1, 3)
    // A stalled poll cannot run it away: one second is the most.
    vi.advanceTimersByTime(3000)
    expect(h.client.audibleSeconds()).toBeCloseTo(2.0, 3)
    // Folded at B: a read at 3.95 s projected 100 ms lands at 0.05, not 4.05.
    const statusMock = h.api.desktopPlaybackStatus as unknown as ReturnType<typeof vi.fn>
    statusMock.mockImplementationOnce(async () => playing(h.generationNow(), { audibleProjectFrame: '189600', loopEnabled: true, loopStartFrame: '0', loopEndFrame: '192000' }))
    await (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh('1')
    vi.advanceTimersByTime(100)
    expect(h.client.audibleSeconds()).toBeCloseTo(0.05, 3)
    // A seek shows its target the moment the core accepts it, before any
    // status reflects it; the status never increments seekCount here, so the
    // wait gives up after its bounded reads and the projection resumes.
    const during: number[] = []
    statusMock.mockImplementation(async () => {
      during.push(h.client.audibleSeconds() ?? -1)
      return playing(h.generationNow(), { audibleProjectFrame: '48000', seekCount: '0' })
    })
    await h.client.seek(7)
    expect(during.length).toBeGreaterThan(1)
    expect(during.every((value) => Math.abs(value - 7) < 1e-6)).toBe(true)
    expect(h.client.audibleSeconds()).toBeCloseTo(1.0, 3)
    await h.client.unload()
  })

  it('a graph prepared ahead of Play is opened and started by Play, with no second prepare and the output released only then', async () => {
    // The phones prepare at open; the desktop prepared at Play, which put
    // the whole decode and graph build inside "Play → advancing" (+0.7-2.8 s
    // over Web Audio on the harness). Nothing is opened ahead of time, so
    // Chromium keeps the output — and the metronome preview keeps sounding —
    // until the singer presses Play.
    const release = vi.fn(async () => undefined)
    const h = seamHarness((generation) => playing(generation))
    ;(h.client as unknown as { lease: { releaseLegacyOutput: () => Promise<void> } }).lease.releaseLegacyOutput = release
    const request = {
      provider: 'coreaudio' as const,
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: null,
      metronome: h.metronome,
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    }
    expect(await h.client.prepareAhead(request)).toBe(true)
    expect(h.client.preparedAhead).toBe(true)
    expect(h.client.active).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(h.calls).toEqual(['prepare:1'])
    // A second prepare ahead while one stands is declined, not stacked.
    expect(await h.client.prepareAhead(request)).toBe(false)
    h.calls.length = 0
    // Play with the same request: open and start the prepared generation.
    expect(await h.client.prepareAndStart(request)).toBe(true)
    expect(h.calls).toEqual(['open:1', 'start:1'])
    expect(release).toHaveBeenCalledTimes(1)
    expect(h.client.active).toBe(true)
    expect(h.client.preparedAhead).toBe(false)
    expect(h.client.transportActive).toBe(true)
    await h.client.unload()
  })

  it('a graph prepared ahead for a different request is unloaded, and Play prepares afresh', async () => {
    const h = seamHarness((generation) => playing(generation))
    const request = {
      provider: 'coreaudio' as const,
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: null,
      metronome: h.metronome,
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    }
    expect(await h.client.prepareAhead(request)).toBe(true)
    h.calls.length = 0
    // The singer scrubbed before Play: a different start.
    expect(await h.client.prepareAndStart({ ...request, positionSeconds: 3 })).toBe(true)
    expect(h.calls).toEqual(['unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[1]).not.toHaveProperty('swapFromGeneration')
    await h.client.unload()
    // And a control change: a different graph.
    const h2 = seamHarness((generation) => playing(generation))
    expect(await h2.client.prepareAhead(request)).toBe(true)
    h2.calls.length = 0
    expect(await h2.client.prepareAndStart({ ...request, masterGain: 0.5 })).toBe(true)
    expect(h2.calls).toEqual(['unload:1', 'prepare:2', 'open:2', 'start:2'])
    await h2.client.unload()
  })

  it('an adoption whose request cannot be built unloads the prepared generation before the error', async () => {
    // A click with no grid is refused by configFor. Without this the ahead
    // generation would be nobody's — not the facade's, not main's to unload —
    // and it would hold the device for the rest of the process.
    const h = seamHarness((generation) => playing(generation))
    const request = {
      provider: 'coreaudio' as const,
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: null,
      metronome: h.metronome,
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    }
    expect(await h.client.prepareAhead(request)).toBe(true)
    h.calls.length = 0
    await expect(h.client.prepareAndStart({ ...request, metronome: { ...h.metronome, click: true } }))
      .rejects.toThrow(/beat grid/)
    expect(h.calls).toEqual(['unload:1'])
    expect(h.client.preparedAhead).toBe(false)
    expect(h.client.active).toBe(false)
  })

  it('a graph prepared ahead is let go by discardAhead and by unload, restoring nothing', async () => {
    const restore = vi.fn(async () => undefined)
    const h = seamHarness((generation) => playing(generation))
    ;(h.client as unknown as { lease: { restoreLegacyOutput: () => Promise<void> } }).lease.restoreLegacyOutput = restore
    const request = {
      provider: 'coreaudio' as const,
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: null,
      metronome: h.metronome,
      countIn: true,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    }
    expect(await h.client.prepareAhead(request)).toBe(true)
    h.calls.length = 0
    await h.client.discardAhead()
    expect(h.calls).toEqual(['unload:1'])
    expect(h.client.preparedAhead).toBe(false)
    expect(await h.client.prepareAhead(request)).toBe(true)
    h.calls.length = 0
    await h.client.unload()
    expect(h.calls).toEqual(['unload:2'])
    expect(h.client.preparedAhead).toBe(false)
    expect(h.client.active).toBe(false)
    // Chromium never lost the output: the lease's restore is a no-op here,
    // and the facade did not call for one on the ahead generation's account.
    expect(restore).not.toHaveBeenCalled()
  })

  it.each(['prepare', 'open'] as const)(
    'binds explicit ASIO to exclusive output and never starts or restores legacy on %s failure',
    async (failureStage) => {
    const prepared: DesktopPlaybackPrepareConfig[] = []
    const failedOpen: DesktopPlaybackResult = {
      ...result('1', 'prepared'),
      ok: false,
      errorCode: 'provider-failure',
      error: 'ASIO driver refused exclusive output'
    }
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true,
        platform: 'win32',
        provider: 'asio',
        defaultInputUid: '',
        defaultOutputUid: 'asio:driver-guid:output-1',
        devices: [{
          uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
          defaultOutput: true, inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000, direction: 'output',
          accessMode: 'exclusive', transport: 'virtual', monitoringSuitability: 'low-latency',
          sampleRateRanges: [{ minimumHz: 48_000, maximumHz: 48_000 }],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async (config) => {
        prepared.push(config)
        return failureStage === 'prepare'
          ? { ...failedOpen, ownershipRetained: true }
          : result('1')
      }),
      openDesktopPlayback: vi.fn(async () => failureStage === 'open' ? failedOpen : result('1', 'output-open')),
      startDesktopPlayback: vi.fn(async () => result('1', 'running')),
      unloadDesktopPlayback: vi.fn(async () => result('1', 'unloaded', true))
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const release = vi.fn(async () => undefined)
    const restore = vi.fn(async () => undefined)
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: release, restoreLegacyOutput: restore },
      () => undefined
    )

    const attempt = client.prepareAndStart(asioRequest())
    await expect(attempt).rejects.toMatchObject({
      name: 'DesktopNativeProviderError',
      code: 'provider-failure',
      provider: 'asio'
    } satisfies Partial<DesktopNativeProviderError>)
    expect(prepared[0]).toMatchObject({
      provider: 'asio',
      accessMode: 'exclusive',
      outputDeviceUid: 'asio:driver-guid:output-1'
    })
    expect(release).toHaveBeenCalledOnce()
    expect(api.startDesktopPlayback).not.toHaveBeenCalled()
    expect(api.openDesktopPlayback).toHaveBeenCalledTimes(failureStage === 'open' ? 1 : 0)
    expect(api.unloadDesktopPlayback).toHaveBeenCalledWith('1')
    expect(restore).not.toHaveBeenCalled()
    expect(client.active).toBe(true)
    expect(client.recoveryPending).toBe(true)
    await client.unload()
    expect(client.active).toBe(false)
    expect(restore).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['backend replacement', 'native-audio-busy', '7'],
    ['native owner', 'host-failure', '1'],
    ['generation claim', 'invalid-generation', '0']
  ] as const)(
    'retains renderer recovery ownership after ASIO %s failure without a native claim',
    async (stage, errorCode, failedGeneration) => {
      let prepareCount = 0
      let rendererLease = false
      const api = {
        desktopPlaybackProviders: vi.fn(async () => [{
          id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
        }]),
        audioHostDevices: vi.fn(async () => ({
          ok: true,
          platform: 'win32',
          provider: 'asio',
          defaultInputUid: '',
          defaultOutputUid: 'asio:driver-guid:output-1',
          devices: [{
            uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
            defaultOutput: true, inputChannels: 0, outputChannels: 2,
            inputChannelLabels: [], outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000,
            direction: 'output', accessMode: 'exclusive', transport: 'virtual',
            monitoringSuitability: 'low-latency', sampleRateRanges: [],
            bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
          }]
        })),
        prepareDesktopPlayback: vi.fn(async () => {
          prepareCount++
          return prepareCount === 1
            ? {
                ...result(failedGeneration),
                ok: false,
                errorCode,
                error: `ASIO ${stage} failed`,
                ownershipRetained: false
              }
            : result('2')
        }),
        openDesktopPlayback: vi.fn(async () => result('2', 'output-open')),
        startDesktopPlayback: vi.fn(async () => result('2', 'running')),
        desktopPlaybackStatus: vi.fn(async () => status('2')),
        unloadDesktopPlayback: vi.fn(async () => result('2', 'unloaded', true))
      } as unknown as SingzApi
      vi.stubGlobal('window', { singz: api })
      const release = vi.fn(async () => { rendererLease = true })
      const restore = vi.fn(async () => { rendererLease = false })
      const client = new DesktopNativePlaybackClient(
        { releaseLegacyOutput: release, restoreLegacyOutput: restore },
        () => undefined
      )

      await expect(client.prepareAndStart(asioRequest())).rejects.toMatchObject({
        code: 'provider-failure', provider: 'asio'
      })
      expect(client.active).toBe(true)
      expect(client.recoveryPending).toBe(true)
      expect(rendererLease).toBe(true)
      expect(release).toHaveBeenCalledOnce()
      expect(restore).not.toHaveBeenCalled()
      expect(api.openDesktopPlayback).not.toHaveBeenCalled()
      expect(api.startDesktopPlayback).not.toHaveBeenCalled()
      expect(api.unloadDesktopPlayback).not.toHaveBeenCalled()
      await expect(client.prepareAndStart({
        ...asioRequest(), provider: 'wasapi'
      })).rejects.toMatchObject({
        code: 'provider-recovery-conflict', provider: 'asio'
      })
      expect(api.prepareDesktopPlayback).toHaveBeenCalledOnce()

      await expect(client.prepareAndStart(asioRequest())).resolves.toBe(true)
      expect(client.active).toBe(true)
      expect(client.recoveryPending).toBe(false)
      expect(rendererLease).toBe(true)
      expect(release).toHaveBeenCalledOnce()
      expect(api.openDesktopPlayback).toHaveBeenCalledOnce()
      expect(api.startDesktopPlayback).toHaveBeenCalledOnce()

      await client.unload()
      expect(client.active).toBe(false)
      expect(rendererLease).toBe(false)
      expect(restore).toHaveBeenCalledOnce()
    }
  )

  it('retains both ownership flags until incomplete native cleanup recovers', async () => {
    let unloadCount = 0
    let prepareCount = 0
    let rendererLease = false
    const cleanupFailed: DesktopPlaybackResult = {
      ...result('1', 'quarantined', false),
      ok: false,
      errorCode: 'teardown-uncertain',
      error: 'ASIO cleanup is incomplete'
    }
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true, platform: 'win32', provider: 'asio', defaultInputUid: '',
        defaultOutputUid: 'asio:driver-guid:output-1',
        devices: [{
          uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
          defaultOutput: true, inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000, direction: 'output',
          accessMode: 'exclusive', transport: 'virtual', monitoringSuitability: 'low-latency',
          sampleRateRanges: [],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async () => {
        prepareCount++
        return prepareCount === 1
          ? {
              ...result('1'), ok: false, errorCode: 'provider-failure',
              error: 'ASIO prepare failed after ownership', ownershipRetained: true
            }
          : result('2')
      }),
      openDesktopPlayback: vi.fn(async () => result('2', 'output-open')),
      startDesktopPlayback: vi.fn(async () => result('2', 'running')),
      resumeDesktopPlayback: vi.fn(async () => result('2', 'running')),
      desktopPlaybackStatus: vi.fn(async () => status('2', '0')),
      unloadDesktopPlayback: vi.fn(async (generation: string) => {
        unloadCount++
        return generation === '1' && unloadCount < 3
          ? cleanupFailed
          : result(generation, 'unloaded', true)
      })
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const release = vi.fn(async () => { rendererLease = true })
    const restore = vi.fn(async () => { rendererLease = false })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: release, restoreLegacyOutput: restore },
      () => undefined
    )

    await expect(client.prepareAndStart(asioRequest())).rejects.toMatchObject({
      code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(client.active).toBe(true)
    expect(client.recoveryPending).toBe(true)
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(rendererLease).toBe(true)
    expect(restore).not.toHaveBeenCalled()
    await expect(client.resume()).rejects.toMatchObject({
      code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(api.resumeDesktopPlayback).not.toHaveBeenCalled()
    await expect(client.cleanupForRetry()).rejects.toMatchObject({
      code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(client.active).toBe(true)
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(rendererLease).toBe(true)
    expect(restore).not.toHaveBeenCalled()
    await client.cleanupForRetry()
    expect(client.active).toBe(true)
    expect(client.recoveryMode).toBe('prepare-retry')
    expect(rendererLease).toBe(true)
    expect(restore).not.toHaveBeenCalled()
    await expect(client.prepareAndStart(asioRequest())).resolves.toBe(true)
    expect(client.recoveryPending).toBe(false)
    expect(api.prepareDesktopPlayback).toHaveBeenCalledTimes(2)
    expect(api.openDesktopPlayback).toHaveBeenCalledOnce()
    expect(api.startDesktopPlayback).toHaveBeenCalledOnce()
    expect(api.resumeDesktopPlayback).not.toHaveBeenCalled()
    await client.unload()
    expect(client.active).toBe(false)
    expect(rendererLease).toBe(false)
    expect(restore).toHaveBeenCalledOnce()
  })

  it('retains playing diagnostics but deactivates transport before failed cleanup', async () => {
    const cleanupFailed: DesktopPlaybackResult = {
      ...result('1', 'quarantined', false),
      ok: false,
      errorCode: 'teardown-uncertain',
      error: 'ASIO cleanup is incomplete'
    }
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true, platform: 'win32', provider: 'asio', defaultInputUid: '',
        defaultOutputUid: 'asio:driver-guid:output-1',
        devices: [{
          uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
          defaultOutput: true, inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000, direction: 'output',
          accessMode: 'exclusive', transport: 'virtual', monitoringSuitability: 'low-latency',
          sampleRateRanges: [],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async () => result('1')),
      openDesktopPlayback: vi.fn(async () => result('1', 'output-open')),
      startDesktopPlayback: vi.fn(async () => result('1', 'running')),
      resumeDesktopPlayback: vi.fn(async () => result('1', 'running')),
      desktopPlaybackStatus: vi.fn(async () => ({ ...status('1'), transportState: 'playing' })),
      unloadDesktopPlayback: vi.fn(async () => cleanupFailed)
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )

    await expect(client.prepareAndStart(asioRequest())).resolves.toBe(true)
    expect(client.transportActive).toBe(true)
    expect(client.status?.transportState).toBe('playing')
    await expect(client.unload()).rejects.toMatchObject({
      code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(client.active).toBe(true)
    expect(client.recoveryPending).toBe(true)
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(client.status?.transportState).toBe('playing')
    expect(client.transportActive).toBe(false)
    await expect(client.resume()).rejects.toMatchObject({
      code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(api.resumeDesktopPlayback).not.toHaveBeenCalled()
    await expect(client.cleanupForRetry()).rejects.toMatchObject({
      code: 'provider-cleanup-incomplete', provider: 'asio'
    })
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(client.status?.transportState).toBe('playing')
  })

  it.each(['activation', 'rebuild', 'unload', 'retry'] as const)(
    'publishes typed cleanup ownership before raw %s cleanup rejection',
    async (stage) => {
      const rawFailure = new Error(`${stage} unload IPC rejected`)
      const unload = vi.fn(async (generation: string) => {
        throw rawFailure
      })
      const api = asioPollingApi(
        async () => ({ ...status('1'), transportState: 'playing' }),
        unload
      )
      if (stage === 'activation') {
        api.startDesktopPlayback = vi.fn(async () => { throw new Error('start IPC rejected') })
      }
      vi.stubGlobal('window', { singz: api })
      const restore = vi.fn(async () => undefined)
      const client = new DesktopNativePlaybackClient(
        { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: restore },
        () => undefined
      )

      if (stage === 'activation') {
        await expect(client.prepareAndStart(asioRequest())).rejects.toMatchObject({
          name: 'DesktopNativeRecoveryError', code: 'provider-cleanup-incomplete', provider: 'asio'
        })
      } else {
        await client.prepareAndStart(asioRequest())
        if (stage === 'rebuild') {
          // A paused song takes the rebuild path (a rendering one would be
          // seamed, and a seam never unloads); the rebuild's unload is what
          // this stage is about.
          await client.pause()
          await expect(client.reconfigure({ playbackRate: 1.1 })).rejects.toMatchObject({
            name: 'DesktopNativeRecoveryError', code: 'provider-cleanup-incomplete', provider: 'asio'
          })
        } else {
          await expect(client.unload()).rejects.toMatchObject({
            name: 'DesktopNativeRecoveryError', code: 'provider-cleanup-incomplete', provider: 'asio'
          })
          if (stage === 'retry') {
            await expect(client.cleanupForRetry()).rejects.toMatchObject({
              name: 'DesktopNativeRecoveryError', code: 'provider-cleanup-incomplete', provider: 'asio'
            })
          }
        }
      }

      expect(client.active).toBe(true)
      expect(client.recoveryMode).toBe('cleanup-required')
      expect(client.transportActive).toBe(false)
      await expect(client.resume()).rejects.toMatchObject({
        code: 'provider-cleanup-incomplete', provider: 'asio'
      })
      expect(api.resumeDesktopPlayback).not.toHaveBeenCalled()
      expect(restore).not.toHaveBeenCalled()
      expect(unload).toHaveBeenCalled()
    }
  )

  it('polls at 20 Hz for two seconds after activity and at 5 Hz while a song simply plays', async () => {
    // Measured on a quiet desktop: the 20 Hz status invoke alone cost the
    // renderer ~2 CPU points while playing; at 5 Hz it sat below Web Audio.
    // The burst keeps every command's read-back at the fast cadence.
    let frame = 0
    const api = asioPollingApi(
      async () => ({ ...status('1', String((frame += 480))), transportState: 'playing', remainingPreRollFrames: '0' }),
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    await client.prepareAndStart(asioRequest())
    const reads = () => vi.mocked(api.desktopPlaybackStatus).mock.calls.length
    const afterStart = reads()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads() - afterStart).toBeGreaterThanOrEqual(18)
    // Past the burst, with the transport steady: five reads a second.
    await vi.advanceTimersByTimeAsync(1500)
    const steadyFrom = reads()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads() - steadyFrom).toBeGreaterThanOrEqual(4)
    expect(reads() - steadyFrom).toBeLessThanOrEqual(6)
    // A command re-arms the burst.
    await client.setMasterGain(0.5)
    const afterCommand = reads()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reads() - afterCommand).toBeGreaterThanOrEqual(18)
    ;(client as unknown as { stopPolling: () => void }).stopPolling()
  })

  it('makes a current polling rejection observable and cleanup-only', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let reads = 0
    const pollFailure = new Error('status IPC disconnected')
    const api = asioPollingApi(
      async () => {
        reads++
        if (reads === 1) return { ...status('1'), transportState: 'playing' }
        throw pollFailure
      },
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const changes = vi.fn()
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      changes
    )

    await expect(client.prepareAndStart(asioRequest())).resolves.toBe(true)
    expect(client.transportActive).toBe(true)
    await vi.advanceTimersByTimeAsync(50)

    expect(client.active).toBe(true)
    expect(client.transportActive).toBe(false)
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(client.status).toMatchObject({
      generation: '1',
      transportTelemetryQuality: 'unavailable',
      error: 'Native playback status refresh failed: status IPC disconnected'
    })
    expect(consoleError).toHaveBeenCalledWith('Native playback status refresh failed:', pollFailure)
    expect(changes).toHaveBeenLastCalledWith(client.status)

    const commands = [
      () => client.reconfigure({ playbackRate: 1.1 }),
      () => client.pause(),
      () => client.resume(),
      () => client.seek(1),
      () => client.setLoop({ start: 1, end: 2 }, true),
      () => client.updateLane('vocals', { gain: 0.5 }),
      () => client.setMasterGain(0.5)
    ]
    for (const command of commands) {
      await expect(command()).rejects.toMatchObject({
        name: 'DesktopNativeRecoveryError',
        code: 'provider-cleanup-incomplete',
        provider: 'asio'
      })
    }
    expect(api.pauseDesktopPlayback).not.toHaveBeenCalled()
    expect(api.resumeDesktopPlayback).not.toHaveBeenCalled()
    expect(api.seekDesktopPlayback).not.toHaveBeenCalled()
    expect(api.setDesktopPlaybackLoop).not.toHaveBeenCalled()
    expect(api.clearDesktopPlaybackLoop).not.toHaveBeenCalled()
    expect(api.setDesktopPlaybackLane).not.toHaveBeenCalled()
    expect(api.setDesktopPlaybackMasterGain).not.toHaveBeenCalled()
    expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)
  })

  it('observes but ignores an in-flight polling rejection after unload retires its epoch', async () => {
    let reads = 0
    let rejectPoll!: (error: unknown) => void
    const pendingPoll = new Promise<DesktopPlaybackStatus>((_resolve, reject) => {
      rejectPoll = reject
    })
    let finishUnload!: (receipt: DesktopPlaybackResult) => void
    const pendingUnload = new Promise<DesktopPlaybackResult>((resolve) => { finishUnload = resolve })
    const api = asioPollingApi(
      async () => {
        reads++
        return reads === 1 ? { ...status('1'), transportState: 'playing' } : pendingPoll
      },
      async () => pendingUnload
    )
    vi.stubGlobal('window', { singz: api })
    const changes = vi.fn()
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      changes
    )

    await client.prepareAndStart(asioRequest())
    await vi.advanceTimersByTimeAsync(50)
    expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)
    const unloading = client.unload()
    await vi.waitFor(() => expect(api.unloadDesktopPlayback).toHaveBeenCalledWith('1'))
    rejectPoll(new Error('late status rejection'))
    await Promise.resolve()
    await Promise.resolve()
    expect(client.recoveryPending).toBe(false)
    finishUnload(result('1', 'unloaded', true))
    await unloading

    expect(client.active).toBe(false)
    expect(client.recoveryPending).toBe(false)
    expect(client.transportActive).toBe(false)
    expect(client.status).toBeNull()
    expect(changes).toHaveBeenLastCalledWith(null)
  })

  it.each(['success', 'failure'] as const)(
    'serializes polling so a deferred poll settles before the next one is issued (%s)',
    async (olderOutcome) => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      consoleError.mockClear()
      let resolveA!: (value: DesktopPlaybackStatus) => void
      let rejectA!: (error: unknown) => void
      const pollA = new Promise<DesktopPlaybackStatus>((resolve, reject) => {
        resolveA = resolve
        rejectA = reject
      })
      let reads = 0
      const api = asioPollingApi(
        async () => {
          reads++
          if (reads === 1) return status('1', '0')
          return reads === 2 ? pollA : status('1', '200')
        },
        async (generation) => result(generation, 'unloaded', true)
      )
      vi.stubGlobal('window', { singz: api })
      const client = new DesktopNativePlaybackClient(
        { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
        () => undefined
      )

      await client.prepareAndStart(asioRequest())
      await vi.advanceTimersByTimeAsync(50)
      expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)
      // Backpressure: however many poll periods elapse, no second read is
      // issued while A is in flight, so reads can never overlap or reorder.
      await vi.advanceTimersByTimeAsync(500)
      expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)
      expect(client.status?.renderedProjectFrame).toBe('0')

      if (olderOutcome === 'success') {
        resolveA(status('1', '100'))
        await vi.advanceTimersByTimeAsync(0)
        expect(client.status?.renderedProjectFrame).toBe('100')
        // Only a settled read arms the next poll.
        await vi.advanceTimersByTimeAsync(50)
        expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(3)
        expect(client.status?.renderedProjectFrame).toBe('200')
        expect(client.recoveryPending).toBe(false)
        expect(client.transportActive).toBe(true)
        expect(consoleError).not.toHaveBeenCalled()
      } else {
        const failure = new Error('deferred poll failed')
        rejectA(failure)
        await vi.advanceTimersByTimeAsync(0)
        expect(client.recoveryMode).toBe('cleanup-required')
        expect(client.transportActive).toBe(false)
        expect(client.status).toMatchObject({
          generation: '1',
          renderedProjectFrame: '0',
          transportTelemetryQuality: 'unavailable',
          error: 'Native playback status refresh failed: deferred poll failed'
        })
        expect(consoleError).toHaveBeenCalledWith('Native playback status refresh failed:', failure)
        // A current failure stops polling rather than re-arming it.
        await vi.advanceTimersByTimeAsync(500)
        expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)
      }
    }
  )

  it('quarantines a structural rebuild queued behind a failing poll instead of rebuilding', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let rejectPoll!: (error: unknown) => void
    const pendingPoll = new Promise<DesktopPlaybackStatus>((_resolve, reject) => {
      rejectPoll = reject
    })
    let reads = 0
    const api = asioPollingApi(
      async () => {
        reads++
        return reads === 1 ? { ...status('1'), transportState: 'playing' } : pendingPoll
      },
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const changes = vi.fn()
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      changes
    )

    await client.prepareAndStart(asioRequest())
    await vi.advanceTimersByTimeAsync(50)
    expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)

    // The rebuild passes the entry guard, then queues its own status read
    // behind the in-flight poll rather than issuing a second IPC read.
    const outcome = client.reconfigure({ playbackRate: 1.1 }).then(
      () => 'resolved' as const,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)

    rejectPoll(new Error('status IPC disconnected'))
    await expect(outcome).resolves.toMatchObject({
      name: 'DesktopNativeRecoveryError',
      code: 'provider-cleanup-incomplete',
      provider: 'asio'
    })
    // The quarantine landed before the rebuild could retire the old graph:
    // nothing was stopped, unloaded or re-prepared, and the generation is
    // retained for exact cleanup.
    expect(api.desktopPlaybackStatus).toHaveBeenCalledTimes(2)
    expect(api.stopDesktopPlayback).not.toHaveBeenCalled()
    expect(api.unloadDesktopPlayback).not.toHaveBeenCalled()
    expect(api.prepareDesktopPlayback).toHaveBeenCalledOnce()
    expect(client.active).toBe(true)
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(client.transportActive).toBe(false)
    expect(client.status).toMatchObject({ generation: '1', transportTelemetryQuality: 'unavailable' })
    expect(changes).toHaveBeenLastCalledWith(client.status)
  })

  it('makes a failed post-command status confirmation cleanup-only', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let reads = 0
    const api = asioPollingApi(
      async () => {
        reads++
        if (reads === 1) return { ...status('1'), transportState: 'playing' }
        throw new Error('status IPC disconnected')
      },
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )

    await client.prepareAndStart(asioRequest())
    expect(client.transportActive).toBe(true)

    await expect(client.pause()).rejects.toMatchObject({
      name: 'DesktopNativeRecoveryError',
      code: 'provider-cleanup-incomplete',
      provider: 'asio',
      message: 'Native playback command completed but its status could not be confirmed.'
    })
    expect(api.pauseDesktopPlayback).toHaveBeenCalledWith('1')
    expect(client.active).toBe(true)
    expect(client.recoveryMode).toBe('cleanup-required')
    expect(client.transportActive).toBe(false)
    await expect(client.resume()).rejects.toMatchObject({ code: 'provider-cleanup-incomplete' })
    expect(api.resumeDesktopPlayback).not.toHaveBeenCalled()
  })

  it('does not clear renderer ownership when Chromium route restoration is incomplete', async () => {
    let restoreCount = 0
    let rendererLease = false
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'asio', label: 'ASIO', available: true, errorCode: 'none', detail: 'ASIO ready'
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true, platform: 'win32', provider: 'asio', defaultInputUid: '',
        defaultOutputUid: 'asio:driver-guid:output-1',
        devices: [{
          uid: 'asio:driver-guid:output-1', label: 'ASIO Phones', defaultInput: false,
          defaultOutput: true, inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000, direction: 'output',
          accessMode: 'exclusive', transport: 'virtual', monitoringSuitability: 'low-latency',
          sampleRateRanges: [],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 64, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async () => ({
        ...result('0'), ok: false, errorCode: 'host-failure',
        error: 'ASIO owner was not created', ownershipRetained: false
      }))
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const release = vi.fn(async () => { rendererLease = true })
    const restore = vi.fn(async () => {
      restoreCount++
      if (restoreCount === 1) throw new Error('Chromium route is still unconfirmed')
      rendererLease = false
    })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: release, restoreLegacyOutput: restore },
      () => undefined
    )

    await expect(client.prepareAndStart(asioRequest())).rejects.toMatchObject({
      code: 'provider-failure', provider: 'asio'
    })
    expect(client.active).toBe(true)
    expect(rendererLease).toBe(true)
    await expect(client.unload()).rejects.toMatchObject({
      code: 'provider-route-restore-incomplete', provider: 'asio'
    })
    expect(client.active).toBe(true)
    expect(client.recoveryPending).toBe(true)
    expect(rendererLease).toBe(true)
    await expect(client.prepareAndStart(asioRequest())).rejects.toMatchObject({
      code: 'provider-recovery-conflict', provider: 'asio'
    })
    expect(api.prepareDesktopPlayback).toHaveBeenCalledOnce()
    await client.unload()
    expect(client.active).toBe(false)
    expect(rendererLease).toBe(false)
    expect(restore).toHaveBeenCalledTimes(2)
  })

  it('keeps the old generation and UI intent when rebuild telemetry is not trustworthy', async () => {
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'coreaudio', label: 'CoreAudio', available: true, errorCode: 'none', detail: ''
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true, platform: 'darwin', provider: 'coreaudio', defaultInputUid: '', defaultOutputUid: 'speaker', error: '',
        devices: [{
          uid: 'speaker', label: 'Speaker', defaultInput: false, defaultOutput: true,
          inputChannels: 0, outputChannels: 2, inputChannelLabels: [], outputChannelLabels: ['L', 'R'],
          nominalSampleRate: 48_000, direction: 'output', accessMode: 'shared', transport: 'built-in',
          monitoringSuitability: 'low-latency', sampleRateRanges: [],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async () => result('1')),
      openDesktopPlayback: vi.fn(async () => result('1', 'output-open')),
      startDesktopPlayback: vi.fn(async () => result('1', 'running')),
      desktopPlaybackStatus: vi.fn(async () => ({
        ...status('1'), transportTelemetryQuality: 'unavailable'
      })),
      unloadDesktopPlayback: vi.fn(async () => result('1', 'unloaded', true))
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    await client.prepareAndStart({
      provider: 'coreaudio', lanes: [{ id: 'vocals', path: '/allowed/vocals.flac', gain: 1, muted: false, solo: false }],
      beat: null,
      metronome: { click: false, countInBars: 0, volume: 0.6, accent: true, grid: false },
      countIn: false, positionSeconds: 0, durationSeconds: 10, sampleRate: 48_000,
      masterGain: 1, playbackRate: 1, transpose: 0, training: null, loop: null
    })
    await expect(client.reconfigure({ transpose: 2 })).rejects.toThrow('trustworthy signed')
    expect(api.unloadDesktopPlayback).not.toHaveBeenCalled()
    expect(client.active).toBe(true)
  })
})

describe('desktop native transport boundaries', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('re-anchors once per host boundary and rebuilds at the signed frame when the session refuses', async () => {
    let generation = '1'
    let nextGeneration = 0
    let current: Partial<DesktopPlaybackStatus> = {}
    const prepared: DesktopPlaybackPrepareConfig[] = []
    // The core answers every accepted re-anchor with its own ClockReanchored
    // discontinuity; a facade that reads that echo as a new boundary would
    // re-anchor forever.
    const reanchor = vi.fn(async (value: string) => {
      current = {
        ...current,
        lastTransportBoundary: 'clock-reanchored',
        transportDiscontinuities: String(Number(current.transportDiscontinuities ?? 0) + 1)
      }
      return result(value, 'running')
    })
    const api = {
      desktopPlaybackProviders: vi.fn(async () => [{
        id: 'coreaudio', label: 'CoreAudio', available: true, errorCode: 'none', detail: ''
      }]),
      audioHostDevices: vi.fn(async () => ({
        ok: true,
        platform: 'darwin',
        provider: 'coreaudio',
        defaultInputUid: '',
        defaultOutputUid: 'speaker',
        error: '',
        devices: [{
          uid: 'speaker', label: 'Speaker', defaultInput: false, defaultOutput: true,
          inputChannels: 0, outputChannels: 2, inputChannelLabels: [],
          outputChannelLabels: ['L', 'R'], nominalSampleRate: 48_000,
          direction: 'output', accessMode: 'shared', transport: 'built-in',
          monitoringSuitability: 'low-latency',
          sampleRateRanges: [{ minimumHz: 48_000, maximumHz: 48_000 }],
          bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
        }]
      })),
      prepareDesktopPlayback: vi.fn(async (config: DesktopPlaybackPrepareConfig) => {
        generation = String(++nextGeneration)
        prepared.push(config)
        return result(generation)
      }),
      openDesktopPlayback: vi.fn(async (value: string) => result(value, 'output-open')),
      startDesktopPlayback: vi.fn(async (value: string) => result(value, 'running')),
      stopDesktopPlayback: vi.fn(async (value: string) => result(value, 'stopped')),
      desktopPlaybackStatus: vi.fn(async () => ({
        ...status(generation, '2400'),
        transportState: 'playing',
        ...current,
        generation,
        transportGeneration: generation
      })),
      unloadDesktopPlayback: vi.fn(async (value: string) => result(value, 'unloaded', true)),
      reanchorDesktopPlayback: reanchor
    } as unknown as SingzApi
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: vi.fn(async () => undefined), restoreLegacyOutput: vi.fn(async () => undefined) },
      () => undefined
    )
    expect(await client.prepareAndStart({
      provider: 'coreaudio',
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: { beats: [0, 0.5, 1, 1.5], bpm: 120, beatsPerBar: 4, downbeat: 0,
        downbeats: [0], source: 'auto' },
      metronome: { click: false, countInBars: 0, volume: 0.6, accent: true, grid: false },
      countIn: false,
      positionSeconds: 0,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0.7,
      playbackRate: 0.8,
      transpose: 3,
      training: null,
      loop: null,
      graphDocument: nonDefaultSongGraph()
    })).toBe(true)
    await vi.advanceTimersByTimeAsync(60)
    expect(reanchor).not.toHaveBeenCalled()

    // Headphones plugged in: the host bumps its route generation. With the
    // time/pitch processor in the graph the callback then fails every block
    // until someone re-anchors — the facade, exactly once.
    current = { routeGeneration: '2', lastTransportBoundary: 'route-generation-changed', transportDiscontinuities: '1' }
    await vi.advanceTimersByTimeAsync(120)
    expect(reanchor).toHaveBeenCalledTimes(1)
    expect(reanchor).toHaveBeenCalledWith('1')
    // Its echo arrives and is consumed; polling on does not re-anchor again.
    await vi.advanceTimersByTimeAsync(400)
    expect(reanchor).toHaveBeenCalledTimes(1)

    // A scrub is a boundary the session primes for itself.
    current = { ...current, lastTransportBoundary: 'source-seek', transportDiscontinuities: '2' }
    await vi.advanceTimersByTimeAsync(120)
    expect(reanchor).toHaveBeenCalledTimes(1)

    // The session refuses the next one: rebuild the graph at the signed frame.
    reanchor.mockImplementationOnce(async () => ({
      ...result('1', 'running'), ok: false, errorCode: 'invalid-state', error: 'no anchor armed'
    }))
    current = {
      ...current, streamGeneration: '2', lastTransportBoundary: 'sample-rate-changed',
      transportDiscontinuities: '3', renderedProjectFrame: '4800'
    }
    await vi.advanceTimersByTimeAsync(400)
    expect(reanchor).toHaveBeenCalledTimes(2)
    expect(api.stopDesktopPlayback).toHaveBeenCalledWith('1')
    expect(api.unloadDesktopPlayback).toHaveBeenCalledWith('1')
    expect(prepared).toHaveLength(2)
    expect(prepared[1]).toMatchObject({ preparedStartProjectFrame: 4800, initialTransport: { state: 'playing' } })

    // Adapter render failures rising while the transport advances are the
    // same signal seen from the other side.
    await vi.advanceTimersByTimeAsync(120)
    current = { ...current, adapterRenderFailures: 3 }
    await vi.advanceTimersByTimeAsync(120)
    expect(reanchor).toHaveBeenCalledTimes(3)
    expect(reanchor).toHaveBeenLastCalledWith('2')
    await client.unload()
  })
})

describe('desktop native control acceptance wiring', () => {
  it('guards top-level rollbacks against stale mutations and song loads', () => {
    const source = readFileSync('src/renderer/src/App.tsx', 'utf8')
    for (const sequence of [
      'beatMutationSeq',
      'metronomeMutationSeq',
      'regionMutationSeq',
      'trainingMutationSeq',
      'pitchTempoMutationSeq'
    ]) {
      expect(source).toContain(`const ${sequence} = useRef(0)`)
      expect(source).toContain(
        `mutation !== ${sequence}.current || songVersion !== loadSeq.current || songEpoch !== engine.songEpoch`
      )
    }
    // The loader retires native BEFORE resetting a single control, so the
    // resets cannot rebuild the old song, and a rollback that lands after the
    // switch is dropped by the engine's own song epoch, not only by loadSeq.
    expect(source.indexOf('engine.retireForSongSwitch()')).toBeGreaterThan(-1)
    expect(source.indexOf('engine.retireForSongSwitch()')).toBeLessThan(source.indexOf('void engine.setTranspose(0)'))
    expect(source).toContain('setMetCfg(engine.metronome)')
    expect(source).toContain('const accepted = acceptedRegionUiRef.current')
    expect(source).toContain('const accepted = acceptedTrainingUiRef.current')
    expect(source).toContain('setTranspose(engine.transpose)')
    expect(source).toContain('setTempoRate(engine.tempo)')
  })

  it('publishes structural engine state only after the native rebuild receipt', () => {
    const source = readFileSync('src/renderer/src/audio/engine.ts', 'utf8')
    const assertAcceptedAfterAwait = (method: string, acceptedAssignment: string): void => {
      const start = source.indexOf(`async ${method}`)
      const end = source.indexOf('\n  }', start)
      const body = source.slice(start, end)
      expect(body.indexOf('await this.nativePlayback.reconfigure')).toBeGreaterThan(-1)
      expect(body.indexOf(acceptedAssignment)).toBeGreaterThan(
        body.indexOf('await this.nativePlayback.reconfigure')
      )
    }
    assertAcceptedAfterAwait('setMetronome', 'this.met = m')
    assertAcceptedAfterAwait('setRegion', 'this.region = targetRegion')
    assertAcceptedAfterAwait('setTraining', 'this.training = spec')
  })

  it('parks a completed native transport and restarts it from a seek', () => {
    const source = readFileSync('src/renderer/src/audio/engine.ts', 'utf8')
    // The core refuses resume() unless the transport is Paused, and a song
    // that ran out is Completed in the callback domain while the control
    // domain still says Playing: completion must pause, and Play must seek
    // before it resumes (a seek while paused stays paused).
    const completion = source.indexOf('private onNativeStatus(')
    expect(completion).toBeGreaterThan(-1)
    const completionBody = source.slice(completion, source.indexOf('\n  }', completion))
    expect(completionBody).toContain("transportState === 'completed'")
    expect(completionBody).toContain('this.nativePlayback.pause()')
    const play = source.indexOf('private async performPlay(')
    const resume = source.indexOf('await this.nativePlayback.resume()', play)
    expect(resume).toBeGreaterThan(play)
    expect(source.slice(play, resume)).toContain('await this.nativePlayback.seek(restart)')
  })
})
