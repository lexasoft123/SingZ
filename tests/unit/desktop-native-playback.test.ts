import { readSourceWithEnglish } from './i18n-source'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  COUNT_IN_PROJECTION_MAX_MS,
  DESKTOP_PLAYBACK_CAPABILITY,
  DesktopNativePlaybackClient,
  DesktopNativeProviderError,
  PENDING_SEEK_MAX_MS,
  SEAM_LANDING_WAIT_MS,
  POLL_BURST_MS,
  POLL_EDGE_MAX_MS,
  POLL_EDGE_MS,
  POLL_FAST_MS,
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
  DESKTOP_PLAYBACK_CODEC_NATIVE_TAG,
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
    const source = readSourceWithEnglish('src/renderer/src/components/SettingsModal.tsx')
    expect(source).toContain('System audio (WASAPI)')
    expect(source).toContain('ASIO unavailable: {detail} */, { detail: asioProviderInfo.detail })')
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
  lanes: [],
  mediaCodecTag: DESKTOP_PLAYBACK_CODEC_NATIVE_TAG
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
        // A rebuild keeps the origin too: the start frame above is the core's
        // own entry-relative rendered frame, and it is only right against an
        // entry that has not moved.
        transport: { entrySeconds: 0, playbackRate: 1.1, transposeSemitones: -2 },
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
      reanchorDesktopPlayback: vi.fn(async (value: string) => { calls.push(`reanchor:${value}`); return result(value, 'running') }),
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

  it('a seam landing is the core handing the clock over, not a host boundary: no re-anchor for it — a route change at the landing or after it still gets one', async () => {
    // The replacement takes the old transport's clock and counters over and
    // announces the hand-over with ONE ClockReanchored of its own, so the
    // discontinuity count moves under a name the facade re-anchors for.
    // Measured on the Mac (CoreAudio, a real song): every seam was followed
    // by a "reanchor · generation N" — a processor reset nobody needed — and
    // a seek clicked right after an A-B loop was armed drained in the same
    // callback as that re-anchor in 11 seams of 12.
    let swapping: { from: string; to: string; landAfterRead: number; routeChange: boolean } | null = null
    let route = '1'
    let discontinuities = 3
    let boundary = 'stream-generation-changed'
    const h = seamHarness((generation, reads) => {
      if (swapping && swapping.to === generation && reads >= swapping.landAfterRead) {
        // The landing callback: the replacement emits its hand-over boundary,
        // outranked by a route change that lands in the same callback.
        discontinuities += 1
        boundary = swapping.routeChange ? 'route-generation-changed' : 'clock-reanchored'
        if (swapping.routeChange) route = String(Number(route) + 1)
        swapping = null
      }
      const armed = swapping !== null && swapping.to === generation
      return playing(generation, {
        transportGeneration: armed ? swapping!.from : generation,
        swapPendingGeneration: armed ? swapping!.from : '0',
        routeGeneration: route,
        transportDiscontinuities: String(discontinuities),
        lastTransportBoundary: boundary
      })
    })
    // The core answers an accepted re-anchor with its own ClockReanchored.
    ;(h.api.reanchorDesktopPlayback as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (value: string) => {
      h.calls.push(`reanchor:${value}`)
      discontinuities += 1
      boundary = 'clock-reanchored'
      return result(value, 'running')
    })
    const readsSoFar = () => (h.api.desktopPlaybackStatus as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(await h.start()).toBe(true)
    await vi.advanceTimersByTimeAsync(120)

    // A plain seam, landing a few reads after it is armed: nothing else is sent.
    h.calls.length = 0
    swapping = { from: '1', to: '2', landAfterRead: readsSoFar() + 3, routeChange: false }
    await h.client.reconfigure({ loop: { start: 2, end: 3.5 } })
    await vi.advanceTimersByTimeAsync(400)
    expect(h.client.status).toMatchObject({
      generation: '2', transportGeneration: '2', lastTransportBoundary: 'clock-reanchored'
    })
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])

    // Headphones plugged in afterwards: a host boundary on the landed
    // generation, re-anchored exactly once, its echo consumed.
    route = '2'
    discontinuities += 1
    boundary = 'route-generation-changed'
    await vi.advanceTimersByTimeAsync(400)
    expect(h.calls).toEqual(['prepare:2:swap-from-1', 'reanchor:2'])

    // A seam whose landing callback also carries a route change: the host's
    // boundary outranks the seam's, and it is re-anchored.
    h.calls.length = 0
    swapping = { from: '2', to: '3', landAfterRead: readsSoFar() + 3, routeChange: true }
    await h.client.reconfigure({ loop: null })
    await vi.advanceTimersByTimeAsync(400)
    expect(h.calls).toEqual(['prepare:3:swap-from-2', 'reanchor:3'])
    await h.client.unload()
  })

  const armedSeamHarness = () => {
    const state = {
      landed: false,
      discontinuities: 3,
      boundary: 'stream-generation-changed',
      failures: 0
    }
    const h = seamHarness((generation) => {
      const armed = generation === '2' && !state.landed
      return playing(generation, {
        transportGeneration: armed ? '1' : generation,
        swapPendingGeneration: armed ? '1' : '0',
        transportDiscontinuities: String(state.discontinuities),
        lastTransportBoundary: state.boundary,
        adapterRenderFailures: state.failures
      })
    })
    /** One boundary on the transport being read: its count and its name. */
    const boundary = (name: string): void => {
      state.discontinuities += 1
      state.boundary = name
    }
    return { h, state, boundary }
  }

  it('a host boundary read while a seam is armed is not re-anchored — the replacement would take the command at the frame it was prepared at — and a wedge after the landing still is', async () => {
    // While a seam is armed a re-anchor names the NEW generation, and the
    // core queues it on the replacement, which has taken no clock yet: it is
    // anchored at the frame the replacement was prepared at and applied
    // right after the hand-over, so a song with a time/pitch stage jumped
    // back there (a core probe: the landing block rendered frame 75, against
    // 1521 without the re-anchor). The landing resets the replacement's graph
    // anyway, with its own ClockReanchored.
    const { h, state, boundary } = armedSeamHarness()
    ;(h.api.reanchorDesktopPlayback as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (value: string) => {
      h.calls.push(`reanchor:${value}`)
      boundary('clock-reanchored')
      return result(value, 'running')
    })
    expect(await h.start()).toBe(true)
    await vi.advanceTimersByTimeAsync(120)
    h.calls.length = 0
    // Armed, and not landed by the time reconfigure stops reading — a
    // transposed song's landing waits out its Stretch prime.
    await h.client.reconfigure({ loop: { start: 2, end: 3.5 } })
    await vi.advanceTimersByTimeAsync(250)
    // An XRun on the outgoing transport, read while the seam is armed.
    boundary('sequence-gap')
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])
    // The landing: the seam's own boundary, not re-anchored either.
    state.landed = true
    boundary('clock-reanchored')
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])
    // The landed callback refuses every block: failures rise, no boundary.
    state.failures += 1
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls).toEqual(['prepare:2:swap-from-1', 'reanchor:2'])
    await h.client.unload()
  })

  it('a re-anchor the core took just before a seam armed: its echo, read while the seam is armed, is not re-anchored — and a wedge on the landed generation still is', async () => {
    // The facade re-anchors generation 1 for a host clock flag, and the core
    // takes the command; before the outgoing transport has emitted its echo
    // a structural change arms a seam. The echo then arrives on the outgoing
    // transport while the seam is armed — after the seam's first read has
    // already started the new generation's bookkeeping, so it reads as a new
    // clock boundary. Re-anchoring for it would hand the replacement a
    // command at the frame it was prepared at. And nothing may be left owed
    // across the landing: a stale echo would swallow what came next, here a
    // callback refusing every block after the landing, never re-anchored.
    const { h, state, boundary } = armedSeamHarness()
    let echoOwed = false
    ;(h.api.reanchorDesktopPlayback as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (value: string) => {
      h.calls.push(`reanchor:${value}`)
      // Taken, echoed later: the outgoing transport applies it at its next
      // callback. The landed generation's echo comes at once.
      if (value === '1') echoOwed = true
      else boundary('clock-reanchored')
      return result(value, 'running')
    })
    expect(await h.start()).toBe(true)
    await vi.advanceTimersByTimeAsync(120)
    // A clock flag from the host on generation 1: re-anchored.
    boundary('clock-reanchored')
    await vi.advanceTimersByTimeAsync(120)
    expect(h.calls).toContain('reanchor:1')
    expect(echoOwed).toBe(true)
    h.calls.length = 0
    // A seam armed right behind it, not landed while reconfigure reads.
    await h.client.reconfigure({ loop: { start: 2, end: 3.5 } })
    // The echo arrives now, on the outgoing transport, with the seam armed.
    boundary('clock-reanchored')
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])
    // The landing, and nothing owed across it.
    state.landed = true
    boundary('clock-reanchored')
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])
    state.failures += 1
    await vi.advanceTimersByTimeAsync(250)
    expect(h.calls).toEqual(['prepare:2:swap-from-1', 'reanchor:2'])
    await h.client.unload()
  })

  it('a structural change while the previous seam is still landing waits for the landing and seams from it — and one after a seam that never lands is rebuilt from where the song is, never refused', async () => {
    // seam() stops reading after 40 statuses and returns with the seam still
    // armed: a transposed song's landing waits out its Stretch prime. The
    // next change read a status naming the new generation over the OUTGOING
    // transport's telemetry and refused it — "Native rebuild has no
    // trustworthy signed transport position" — so a loop set right after a
    // transpose was not applied at all (seen ~75 ms after the transpose).
    // The candidate `as`, armed over `from`'s transport until read `until`.
    let seam: { as: string; from: string; until: number } | null = null
    const h = seamHarness((generation, reads) => {
      const armed = seam !== null && seam.as === generation && reads < seam.until
      return playing(generation, {
        transportGeneration: armed ? seam!.from : generation,
        swapPendingGeneration: armed ? seam!.from : '0'
      })
    })
    const readsSoFar = () => (h.api.desktopPlaybackStatus as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    expect(await h.start()).toBe(true)
    // A transpose: a seam still armed when reconfigure stops reading.
    seam = { as: '2', from: '1', until: readsSoFar() + 60 }
    await h.client.reconfigure({ transpose: 2 })
    expect(h.client.status).toMatchObject({ generation: '2', transportGeneration: '1', swapPendingGeneration: '1' })
    // A loop right behind it waits the landing out, then seams from the
    // generation that landed.
    h.calls.length = 0
    const loop = h.client.reconfigure({ loop: { start: 2, end: 3.5 } })
    await vi.advanceTimersByTimeAsync(SEAM_LANDING_WAIT_MS)
    await loop
    expect(h.calls).toEqual(['prepare:3:swap-from-2'])
    expect(h.client.status).toMatchObject({ generation: '3', transportGeneration: '3' })
    // A seam that never lands: the change after it goes on from where the
    // song is — the outgoing transport, still the one rendering — as a
    // rebuild, whose stop retires both graphs.
    seam = { as: '4', from: '3', until: Infinity }
    await h.client.reconfigure({ transpose: 3 })
    expect(h.client.status).toMatchObject({ generation: '4', transportGeneration: '3' })
    h.calls.length = 0
    const next = h.client.reconfigure({ loop: null })
    await vi.advanceTimersByTimeAsync(SEAM_LANDING_WAIT_MS + 100)
    await next
    expect(h.calls).toEqual(['stop:4', 'unload:4', 'prepare:5', 'open:5', 'start:5'])
    expect(h.prepared[h.prepared.length - 1]).toMatchObject({
      preparedStartProjectFrame: 48_000,
      initialTransport: { state: 'playing' }
    })
    await h.client.unload()
  })

  it('a rebuild starts where a seek still owed its receipt is taking the song, not where the core last reported', async () => {
    // Paused with the playhead past a selection, the Loop button seeks to the
    // selection's start and then arms the loop, and while paused a
    // structural change is a REBUILD. It prepared the new generation at the
    // frame the core last reported, so a seek the callback had not applied
    // yet went away with the old generation and the next Play started from
    // the old spot, wrapped into the loop (a probe on the facade: prepared
    // at 80.05 s, not at 70 s).
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '386400', audibleProjectFrame: '386272', seekCount: '0'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.start()).toBe(true)
    current = { ...current, transportState: 'paused', audibleProjectFrame: '386400' }
    await h.client.pause()
    // The core has not taken the seek: every read still says 8.05 s, seekCount 0.
    await h.client.seek(2)
    h.calls.length = 0
    await h.client.reconfigure({ loop: { start: 2, end: 3.5 } })
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[1]).toMatchObject({
      preparedStartProjectFrame: 96_000,
      initialTransport: { state: 'paused', loop: { startProjectFrame: 96_000, endProjectFrame: 168_000 } }
    })
    // A seek past the loop's end starts where the core would have put it:
    // folded into the loop with no lap, as its resolvedSeekFrame folds it.
    await h.client.seek(4)
    await h.client.reconfigure({ playbackRate: 1.1 })
    expect(h.prepared[2]).toMatchObject({ preparedStartProjectFrame: 120_000 })
    // A seek the core HAS taken is owed nothing: the rebuild starts at the
    // frame the core reports, as before — here a frame that is not the seek's
    // target (144000), so the leg can tell which one the rebuild used.
    await h.client.seek(3)
    current = { ...current, renderedProjectFrame: '146400', audibleProjectFrame: '146400', seekCount: '1' }
    await h.client.reconfigure({ playbackRate: 1.2 })
    expect(h.prepared[3]).toMatchObject({ preparedStartProjectFrame: 146_400 })
    // A seek never acknowledged within PENDING_SEEK_MAX_MS is no longer owed
    // — the bar has given it up by then — so the rebuild starts at the frame
    // the core reports, not at that target (120000).
    await h.client.seek(2.5)
    vi.advanceTimersByTime(PENDING_SEEK_MAX_MS + 1)
    await h.client.reconfigure({ playbackRate: 1.3 })
    expect(h.prepared[4]).toMatchObject({ preparedStartProjectFrame: 146_400 })
    await h.client.unload()
  })

  it('a seek still owed its receipt inside a count-in is the singer moving: the rebuild starts there, flat, not anchored at the old landing', async () => {
    // The core cancels a count-in's landing when it applies a seek, and the
    // song plays on from the seek's target. A structural change inside the
    // count-in is otherwise a rebuild anchored at the landing — which, with a
    // seek still owed, would count in again to the spot the singer left.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128', seekCount: '0'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(3))).toBe(true)
    current = { ...current, transportState: 'paused', renderedProjectFrame: '-48000', audibleProjectFrame: '-48000' }
    await h.client.pause()
    await h.client.seek(1)
    h.calls.length = 0
    await h.client.reconfigure({ playbackRate: 1.1 })
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[1]).toMatchObject({ preparedStartProjectFrame: 48_000, initialTransport: { state: 'paused' } })
    expect(h.prepared[1].playback.transport).not.toHaveProperty('countInAnchorSeconds')
    await h.client.unload()
  })

  it('PLAYING inside a mid-song count-in, a change with a seek still owed is a seam that carries none of the count-in', async () => {
    // Otherwise such a change is a rebuild anchored at the landing: with a
    // seek owed that counted in again to the spot the singer had left. It is
    // a seam now — the outgoing transport applies the seek before the
    // hand-over, or the replacement right after it, and either way the
    // count-in is over — so no landing is held and no dots are counted.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128', seekCount: '0'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(3))).toBe(true)
    expect(h.client.countInHeard()).not.toBeNull()
    await h.client.seek(1)
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...countInRequest(3).metronome, click: true } })
    expect(h.calls).toEqual(['prepare:2:swap-from-1'])
    expect(h.client.countInHeard()).toBeNull()
    expect(h.client.audibleSeconds()).toBe(1)
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
    // status reflects it — and it does NOT wait around for the receipt.
    //
    // It used to: a loop of up to 24 status reads, spinning until seekCount
    // moved. Since the callback applies a queued seek at its next period, that
    // put a fifth of a second inside every scrub (the session harness measured
    // 191/201/191 ms against legacy's 10) and the singer saw the bar and the
    // lanes lurch after the finger had stopped. One read now, and the target
    // stands until the receipt lands on the ordinary poll.
    const during: number[] = []
    statusMock.mockImplementation(async () => {
      during.push(h.client.audibleSeconds() ?? -1)
      return playing(h.generationNow(), { audibleProjectFrame: '48000', seekCount: '0' })
    })
    await h.client.seek(7)
    expect(during.length).toBe(1)
    expect(during.every((value) => Math.abs(value - 7) < 1e-6)).toBe(true)
    // Still the target: this status never incremented seekCount, so the core
    // has not said where it went yet.
    expect(h.client.audibleSeconds()).toBeCloseTo(7, 3)
    // But a seek the core NEVER acknowledges must not leave a phantom position
    // on the bar for the rest of the song. That give-up used to come from the
    // blocking wait running out of reads; it is a deadline now.
    vi.advanceTimersByTime(PENDING_SEEK_MAX_MS + 1)
    expect(h.client.audibleSeconds()).toBeCloseTo(2.0, 3)
    await h.client.unload()
  })

  it('two seeks in flight keep the LAST target until the core has applied both', async () => {
    // A scrub is several seeks in flight, and the core may apply them a
    // callback block apart (it drains its whole mailbox every block, and
    // counts every seek it applies, so two drained together move the count
    // by two at once). Retiring the target the moment `seekCount` MOVED
    // retired the second seek's target on the first seek's receipt: the bar
    // showed the first spot for a poll, then jumped to the second — the same
    // lurch this file's seek path was just cured of, one block wide. The
    // target now stands until the receipt reaches base + issued.
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'))
    let seekCount = '0'
    const h = seamHarness((generation) =>
      playing(generation, { audibleProjectFrame: '48000', seekCount })
    )
    expect(await h.start()).toBe(true)
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    const refresh = (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh.bind(h.client)

    await h.client.seek(7)
    await h.client.seek(9)
    expect(h.client.audibleSeconds()).toBeCloseTo(9, 3)

    // The first receipt: seek A applied. The bar must NOT fall back to the
    // status frame here — that is A's position, and B is still owed.
    seekCount = '1'
    await refresh('1')
    expect(h.client.audibleSeconds()).toBeCloseTo(9, 3)

    // The second receipt: both applied, and the core's own frame takes over.
    seekCount = '2'
    await refresh('1')
    expect(h.client.audibleSeconds()).toBeCloseTo(1.0, 3)
    await h.client.unload()
  })

  it('a refused seek drops its target at once, even with an earlier seek still owed a receipt', async () => {
    // The refusal path used to keep `pendingSeekFrame` whenever another seek
    // was still in flight, so the bar drew the REFUSED spot until that other
    // receipt landed or the second-long expiry ran out — a position the song
    // was never asked to reach. Now the target goes with the refusal and the
    // earlier seek's receipt is still awaited on its own count.
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'))
    let seekCount = '0'
    const h = seamHarness((generation) =>
      playing(generation, { audibleProjectFrame: '48000', seekCount })
    )
    expect(await h.start()).toBe(true)
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    const refresh = (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh.bind(h.client)
    const seekMock = h.api.seekDesktopPlayback as unknown as ReturnType<typeof vi.fn>

    await h.client.seek(7)
    seekMock.mockImplementationOnce(async () => ({
      ...result('1', 'running'), ok: false, errorCode: 'invalid-configuration', error: 'The absolute playback seek is invalid'
    }))
    await expect(h.client.seek(9)).rejects.toThrow()
    // Not 9 (refused) and not held: the core's own projection is what shows.
    expect(h.client.audibleSeconds()).toBeCloseTo(1.0, 3)
    // The first seek's receipt still retires cleanly on its own count.
    seekCount = '1'
    await refresh('1')
    expect(h.client.audibleSeconds()).toBeCloseTo(1.0, 3)
    await h.client.seek(3)
    expect(h.client.audibleSeconds()).toBeCloseTo(3, 3)
    seekCount = '2'
    await refresh('1')
    expect(h.client.audibleSeconds()).toBeCloseTo(1.0, 3)
    await h.client.unload()
  })

  it('unloading forgets a seek still owed a receipt, so the next generation starts with none pending', async () => {
    // A generation's `seekCount` starts at zero. A receipt base read off the
    // previous generation would make the next one wait for a count it may
    // never reach, holding a stale target for the whole expiry.
    vi.setSystemTime(new Date('2026-09-13T00:00:00Z'))
    const h = seamHarness((generation) =>
      playing(generation, { audibleProjectFrame: '48000', seekCount: '0' })
    )
    expect(await h.start()).toBe(true)
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    await h.client.seek(7)
    expect(h.client.audibleSeconds()).toBeCloseTo(7, 3)
    await h.client.unload()
    const pending = h.client as unknown as { pendingSeekFrame: number | null; pendingSeekReceipt: string | null; pendingSeekIssued: number }
    expect(pending.pendingSeekFrame).toBeNull()
    expect(pending.pendingSeekReceipt).toBeNull()
    expect(pending.pendingSeekIssued).toBe(0)
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
    // THE ENTRY DOES NOT FOLLOW THE POSITION. The scrubbed spot travels as
    // the signed transport start; the frame origin stays at the song's top.
    // This used to send `entrySeconds: 3`, which made the core's timeline
    // relative to the scrub while every seek stayed absolute — seeks into the
    // last three seconds refused as "The absolute playback seek is invalid",
    // the rest landing three seconds late, and the bar drawn from a project
    // frame nothing added the entry back to. A saved project reopens at its
    // remembered position, so on a Mac this was every song, every time.
    expect(h.prepared[1].playback.transport).toMatchObject({ entrySeconds: 0 })
    expect(h.prepared[1].playback.transport).not.toHaveProperty('countInAnchorSeconds')
    expect(h.prepared[1].preparedStartProjectFrame).toBe(144_000)
    await h.client.unload()
    // And a control change: a different graph.
    const h2 = seamHarness((generation) => playing(generation))
    expect(await h2.client.prepareAhead(request)).toBe(true)
    h2.calls.length = 0
    expect(await h2.client.prepareAndStart({ ...request, masterGain: 0.5 })).toBe(true)
    expect(h2.calls).toEqual(['unload:1', 'prepare:2', 'open:2', 'start:2'])
    await h2.client.unload()
  })

  it('a Play from mid-song with the count-in on names the spot as the ANCHOR, and the entry still stays 0', async () => {
    // The phones' rule, in their own words: "the source/cue plan stays
    // anchored to the song's original entry ... changing both would
    // double-offset the positioned decoded source." With the count-in on the
    // remembered position is where the count-in LANDS, the start is the
    // ordinary pre-rolled one, and the frame origin does not move. The
    // desktop had no way to say this — its bridge refused the anchor key —
    // and moved the entry instead, which is the double offset.
    const h = seamHarness((generation) => playing(generation))
    expect(await h.client.prepareAndStart({
      provider: 'coreaudio',
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], bpm: 120, beatsPerBar: 4, downbeat: 0,
        downbeats: [0, 4], source: 'auto' },
      metronome: { ...h.metronome, click: true, countInBars: 1 },
      countIn: true,
      positionSeconds: 3,
      durationSeconds: 10,
      sampleRate: 48_000,
      masterGain: 0,
      playbackRate: 1,
      transpose: 0,
      training: null,
      loop: null,
      graphDocument: undefined
    })).toBe(true)
    expect(h.prepared[0].playback.transport).toMatchObject({ entrySeconds: 0, countInAnchorSeconds: 3 })
    expect(h.prepared[0]).not.toHaveProperty('preparedStartProjectFrame')
    await h.client.unload()
  })

  it('an adoption whose request cannot be built unloads the prepared generation before the error', async () => {
    // Loop bounds the facade cannot represent are refused by configFor.
    // Without this the ahead generation would be nobody's — not the
    // facade's, not main's to unload — and it would hold the device for the
    // rest of the process.
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
    await expect(h.client.prepareAndStart({ ...request, loop: { start: 4, end: 4 } }))
      .rejects.toThrow(/loop bounds/)
    expect(h.calls).toEqual(['unload:1'])
    expect(h.client.preparedAhead).toBe(false)
    expect(h.client.active).toBe(false)
  })

  it('a song with no beat grid plays with the click dropped, and the click sounds the moment a grid arrives', async () => {
    // The field report: a Windows singer met "Playback could not start:
    // Native metronome playback requires a beat grid." over a song that
    // would not play at all. The click is a saved setting of the SONG
    // (`settings.metronome`), the grid is a detection that can be absent,
    // stale or still running, so the two disagree routinely — and nothing
    // turns a click off when a grid goes away. Web Audio has always played
    // that song with no clicks (`armClicksFromCurrent` returns on a null
    // grid); refusing to play it was native's alone.
    const h = seamHarness((generation) => playing(generation))
    const request = {
      provider: 'coreaudio' as const,
      lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
      beat: null,
      metronome: { ...h.metronome, click: true, countInBars: 1 },
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
    expect(await h.client.prepareAndStart(request)).toBe(true)
    // Nothing refused, nothing clicking, and the count-in the singer asked
    // for is still asked for — the core counts that one in gridless.
    expect(h.prepared[0].playback.cues).toMatchObject({ click: false, countInBars: 1 })
    expect(h.prepared[0].playback.cues).not.toHaveProperty('beatGrid')
    // Detection lands while the song plays: the saved click has a grid to
    // click on now, and the same rebuild that adopts the grid starts it.
    await h.client.reconfigure({
      beat: { beats: [0, 0.5, 1, 1.5], bpm: 120, beatsPerBar: 4, downbeat: 0, downbeats: [0], source: 'auto' }
    })
    expect(h.prepared[1].playback.cues).toMatchObject({ click: true })
    expect(h.prepared[1].playback.cues.beatGrid?.beats).toEqual([0, 0.5, 1, 1.5])
    await h.client.unload()
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

  it('looks at a fresh start every edge period until it runs with a current audible frame', async () => {
    // The render thread publishes the start from its first callbacks, and the
    // start's own read-back always lands before them: 'stopped', nothing
    // rendered. Waiting a whole fast poll for the next look is what kept the
    // bar still for ~40 ms of music on every Play (measured on the Mac:
    // 'playing' 4-6 ms after the start returned, a current audible frame one
    // callback later, the first look 55 ms after).
    let reads = 0
    const api = asioPollingApi(
      async () => {
        reads++
        if (reads <= 2) {
          return { ...status('1', '0'), transportState: 'stopped', audibleProjectionQuality: 'unavailable', callbacks: '0' }
        }
        const frame = String(512 * (reads - 2))
        return {
          ...status('1', frame),
          transportState: 'playing',
          remainingPreRollFrames: '0',
          audibleProjectionQuality: reads === 3 ? 'unavailable' : 'current'
        }
      },
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    await client.prepareAndStart(asioRequest())
    expect(reads).toBe(1)
    expect(client.transportActive).toBe(false)
    await vi.advanceTimersByTimeAsync(POLL_EDGE_MS)
    expect(reads).toBe(2)
    await vi.advanceTimersByTimeAsync(POLL_EDGE_MS)
    expect(reads).toBe(3)
    expect(client.transportActive).toBe(true)
    // Running, but the audible frame is not current yet: one more look.
    await vi.advanceTimersByTimeAsync(POLL_EDGE_MS)
    expect(reads).toBe(4)
    // Shown. Back to the burst cadence.
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS - 1)
    expect(reads).toBe(4)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toBe(5)
    ;(client as unknown as { stopPolling: () => void }).stopPolling()
  })

  it('holds the edge cadence for at most POLL_EDGE_MAX_MS when the start never shows', async () => {
    const api = asioPollingApi(
      async () => ({ ...status('1', '0'), transportState: 'stopped', audibleProjectionQuality: 'unavailable' }),
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
    await vi.advanceTimersByTimeAsync(POLL_EDGE_MAX_MS)
    const edgeReads = reads() - afterStart
    expect(edgeReads).toBeGreaterThanOrEqual(POLL_EDGE_MAX_MS / POLL_EDGE_MS - 2)
    expect(edgeReads).toBeLessThanOrEqual(POLL_EDGE_MAX_MS / POLL_EDGE_MS)
    // Past the bound it is the ordinary burst: 20 Hz, not 100.
    const afterEdge = reads()
    await vi.advanceTimersByTimeAsync(10 * POLL_FAST_MS)
    expect(reads() - afterEdge).toBeGreaterThanOrEqual(9)
    expect(reads() - afterEdge).toBeLessThanOrEqual(11)
    ;(client as unknown as { stopPolling: () => void }).stopPolling()
  })

  it('pulls the next look forward when a long pause is resumed', async () => {
    // A paused song past the burst polls at 5 Hz, so the poll armed before a
    // resume could be 200 ms away, and so could the bar's first step.
    let transportState: DesktopPlaybackStatus['transportState'] = 'playing'
    let frame = 0
    const api = asioPollingApi(
      async () => ({
        ...status('1', String(frame += 480)),
        transportState,
        remainingPreRollFrames: '0',
        audibleProjectionQuality: 'current'
      }),
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    await client.prepareAndStart(asioRequest())
    transportState = 'paused'
    await client.pause()
    await vi.advanceTimersByTimeAsync(POLL_BURST_MS + 1010)
    // The core accepts the resume; its render thread has not taken it yet.
    await client.resume()
    expect(client.transportActive).toBe(false)
    const afterResume = vi.mocked(api.desktopPlaybackStatus).mock.calls.length
    transportState = 'playing'
    await vi.advanceTimersByTimeAsync(POLL_EDGE_MS)
    expect(vi.mocked(api.desktopPlaybackStatus).mock.calls.length).toBe(afterResume + 1)
    expect(client.transportActive).toBe(true)
    ;(client as unknown as { stopPolling: () => void }).stopPolling()
  })

  it('pulls the next look forward after a Pause, so the park point is drawn within a fast poll', async () => {
    // The pause's read-back often lands before the render thread has taken
    // it, and the bar is held where it was pressed until a status says where
    // the core parked: that status must not wait for a steady poll 200 ms out.
    let transportState: DesktopPlaybackStatus['transportState'] = 'playing'
    let frame = 0
    const api = asioPollingApi(
      async () => ({
        ...status('1', String(frame += 480)),
        transportState,
        remainingPreRollFrames: '0',
        audibleProjectionQuality: 'current'
      }),
      async (generation) => result(generation, 'unloaded', true)
    )
    vi.stubGlobal('window', { singz: api })
    const client = new DesktopNativePlaybackClient(
      { releaseLegacyOutput: async () => undefined, restoreLegacyOutput: async () => undefined },
      () => undefined
    )
    await client.prepareAndStart(asioRequest())
    const reads = () => vi.mocked(api.desktopPlaybackStatus).mock.calls.length
    // Past the burst, and pressed just after a steady poll, whose successor
    // is armed 200 ms out.
    await vi.advanceTimersByTimeAsync(POLL_BURST_MS + 1000)
    const steady = reads()
    while (reads() === steady) await vi.advanceTimersByTimeAsync(1)
    await client.pause()
    const afterPause = reads()
    transportState = 'paused'
    await vi.advanceTimersByTimeAsync(POLL_FAST_MS)
    expect(reads()).toBe(afterPause + 1)
    expect(client.status?.transportState).toBe('paused')
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

  it('does not ask a transport that is already playing to resume, and does ask one whose pause has not reached the callback yet', async () => {
    // A field session pressed Play twice inside one 5 Hz status poll and got
    // sixteen `resume failed · invalid-state · Native playback is not paused`
    // warnings, with the button stuck on Play for the rest of the song. Both
    // halves of the rule are here because each opinion alone is wrong in a
    // different direction, and getting the second one wrong rebuilds the same
    // bug upside down: `pause()` flips the core's desired state at once but
    // the published transportState comes from the render callback, so a
    // just-paused transport still READS playing for a buffer period.
    const h = seamHarness((generation) => playing(generation))
    expect(await h.start()).toBe(true)

    // Intent playing, snapshot playing: nothing to ask for.
    const before = h.calls.filter((c) => c.startsWith('resume:')).length
    await h.client.resume()
    expect(h.calls.filter((c) => c.startsWith('resume:')).length).toBe(before)

    // Paused — and the fixture's pause deliberately answers 'running', which
    // is exactly the lag. The command must still go out.
    await h.client.pause()
    await h.client.resume()
    expect(h.calls.filter((c) => c.startsWith('resume:')).length).toBe(before + 1)
  })

  it('survives a resume the core refuses because it is already playing, instead of leaving the caller believing the song is stopped', async () => {
    // The refusal used to throw, so the engine never recorded that the song
    // was playing: the button stayed on Play while the core played on.
    const h = seamHarness((generation, reads) =>
      playing(generation, { transportState: reads < 3 ? 'paused' : 'playing' })
    )
    expect(await h.start()).toBe(true)
    await h.client.pause()
    ;(h.api.resumeDesktopPlayback as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (value: string) => ({
        ...result(value, 'running'),
        ok: false,
        errorCode: 'invalid-state' as const,
        error: 'Native playback is not paused'
      })
    )
    await expect(h.client.resume()).resolves.toBeUndefined()
  })

  it('rethrows a resume the core refuses for any other reason', async () => {
    const h = seamHarness((generation) => playing(generation, { transportState: 'paused' }))
    expect(await h.start()).toBe(true)
    await h.client.pause()
    ;(h.api.resumeDesktopPlayback as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (value: string) => ({
        ...result(value, 'running'),
        ok: false,
        errorCode: 'host-failure' as const,
        error: 'the output went away'
      })
    )
    await expect(h.client.resume()).rejects.toThrow(/the output went away/)
  })

  // The count-in request the three tests below share: a grid, one bar of
  // count-in, a Play from 3 s. The core runs that count-in at NEGATIVE
  // project frames and lands on 3 s when it ends.
  const countInRequest = (positionSeconds: number, countIn = true) => ({
    provider: 'coreaudio' as const,
    lanes: [{ id: 'vocals', path: '/allowed/vocals.mp3', gain: 1, muted: false, solo: false }],
    beat: { beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5], bpm: 120, beatsPerBar: 4, downbeat: 0,
      downbeats: [0, 4, 8], source: 'auto' as const },
    metronome: { click: false, countInBars: 1, volume: 0, accent: true, grid: false },
    countIn,
    positionSeconds,
    durationSeconds: 10,
    sampleRate: 48_000,
    masterGain: 0,
    playbackRate: 1,
    transpose: 0,
    training: null,
    loop: null,
    graphDocument: undefined
  })

  it('the bar HOLDS at the landing through a mid-song count-in, and through a Pause inside it — never at 0', async () => {
    // Field report on 0.21.1: a Play from mid-song with the count-in on drew
    // the bar at the top of the song for the whole count-in, and a Pause
    // inside the count-in parked it there ("the seek bar jumps to the song
    // start when I hit pause fast"). The core reports the pre-roll as
    // negative frames counting up to 0, and `Math.max(0, …)` turned every
    // one of them into the song's first second. The phones hold the bar at
    // the LANDING (legacy's clock clamps at the start offset until the
    // music enters) — the line the singer chose stays on screen.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(3))).toBe(true)
    expect(h.client.status?.transportState).toBe('pre-roll')
    expect(h.client.audibleSeconds()).toBe(3)
    // Paused inside the count-in: still the landing.
    current = { transportState: 'paused', renderedProjectFrame: '-48000', audibleProjectFrame: '-48000' }
    await h.client.pause()
    expect(h.client.status?.transportState).toBe('paused')
    expect(h.client.audibleSeconds()).toBe(3)
    // Landed, with the ear one output latency (128 frames) behind the render
    // head: the audible frame reads a hair BEFORE the landing, which for a
    // mid-song start is a line the singer never chose — floored at the
    // landing for that one latency span.
    current = { transportState: 'playing', renderedProjectFrame: '144064', audibleProjectFrame: '143936' }
    await h.client.resume()
    expect(h.client.audibleSeconds()).toBe(3)
    // Past it: the ordinary audible frame.
    current = { transportState: 'playing', renderedProjectFrame: '148800', audibleProjectFrame: '148672' }
    await h.client.setMasterGain(0.5)
    expect(h.client.audibleSeconds()).toBeCloseTo(148_672 / 48_000, 3)
    // A count-in at the TOP holds at 0, by the same rule rather than by the
    // clamp; and a generation with the count-in OFF has no landing at all,
    // so a negative frame there — which the core never produces — is not
    // mistaken for one.
    await h.client.unload()
    current = { transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128' }
    const top = seamHarness((generation) => playing(generation, current))
    expect(await top.client.prepareAndStart(countInRequest(0))).toBe(true)
    expect(top.client.audibleSeconds()).toBe(0)
    await top.client.unload()
    const off = seamHarness((generation) => playing(generation, current))
    expect(await off.client.prepareAndStart(countInRequest(3, false))).toBe(true)
    expect(off.client.countInHeard()).toBeNull()
    await off.client.unload()
  })

  it('Play after a Pause with the count-in on is a RESTART anchored at the paused spot: stop, unload, prepare with the anchor and no signed start, open, start', async () => {
    // Legacy counts in on every Play; the phones stop a paused native
    // transport, park it and prepare it again anchored where it paused. The
    // desktop resumed instead, so a song counted in on its first Play and
    // never again — not after a scrub, not after a Pause.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '240000', audibleProjectFrame: '239872'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(0))).toBe(true)
    current = { transportState: 'paused', renderedProjectFrame: '240000', audibleProjectFrame: '240000' }
    await h.client.pause()
    h.calls.length = 0
    current = { transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128' }
    await h.client.restartWithCountIn(countInRequest(5))
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[1].playback.transport).toMatchObject({ entrySeconds: 0, countInAnchorSeconds: 5 })
    expect(h.prepared[1]).not.toHaveProperty('preparedStartProjectFrame')
    expect(h.prepared[1]).not.toHaveProperty('swapFromGeneration')
    expect(h.prepared[1].initialTransport).toEqual({ state: 'playing' })
    expect(h.client.active).toBe(true)
    expect(h.client.transportActive).toBe(true)
    // And the new generation's landing is what the bar holds at.
    expect(h.client.audibleSeconds()).toBe(5)
    // From the top the same restart carries no anchor — the count-in
    // precedes the entry itself — and still no signed start.
    current = { transportState: 'paused', renderedProjectFrame: '-48000', audibleProjectFrame: '-48000' }
    await h.client.pause()
    h.calls.length = 0
    await h.client.restartWithCountIn(countInRequest(0))
    expect(h.calls).toEqual(['stop:2', 'unload:2', 'prepare:3', 'open:3', 'start:3'])
    expect(h.prepared[2].playback.transport).not.toHaveProperty('countInAnchorSeconds')
    expect(h.prepared[2]).not.toHaveProperty('preparedStartProjectFrame')
    // A request the facade cannot build is refused BEFORE anything is torn
    // down: the running generation stays exactly as it was.
    await h.client.pause()
    h.calls.length = 0
    await expect(h.client.restartWithCountIn({
      ...countInRequest(2), loop: { start: 4, end: 4 }
    })).rejects.toThrow(/loop bounds/)
    expect(h.calls).toEqual([])
    expect(h.client.status?.generation).toBe('3')
    await h.client.unload()
  })

  it('countInHeard reports the ear on its runway to the landing, keeps the row through the latency tail after it, and nothing for a run that never counted in', async () => {
    // The transport dots under native. Before this the dots never showed at
    // all on native playback: `countInfo` is the Web Audio schedule, and
    // native never builds one.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48128',
      presentationLatencyFrames: '128', preRollFrames: '96000', countInEventCount: 4, countInBeatsPerBar: 4
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(3))).toBe(true)
    // Counting: the render head is at −1 s and the ear 128 frames behind it.
    expect(h.client.countInHeard()).toEqual({
      secondsToLanding: -(48_000 + 128) / 48_000, landingSeconds: 3, total: 4, perBar: 4, preRollSeconds: 2
    })
    // Landed 64 frames ago: the last click is still sounding for another 64
    // frames, so the row stays up — the phones measured a 0.6 s route ending
    // the row at three dots of four when it dropped at the landing.
    current = {
      ...current, transportState: 'playing', renderedProjectFrame: '144064', audibleProjectFrame: '143936'
    }
    await h.client.setMasterGain(0.5)
    expect(h.client.countInHeard()).toEqual({
      secondsToLanding: -64 / 48_000, landingSeconds: 3, total: 4, perBar: 4, preRollSeconds: 2
    })
    // The tail has passed: the row is over, and stays over.
    current = { ...current, renderedProjectFrame: '144256', audibleProjectFrame: '144128' }
    await h.client.setMasterGain(0.4)
    expect(h.client.countInHeard()).toBeNull()
    current = { ...current, renderedProjectFrame: '144100', audibleProjectFrame: '143972' }
    await h.client.setMasterGain(0.3)
    expect(h.client.countInHeard()).toBeNull()
    await h.client.unload()
    // A generation that started flat (a rebuild at a signed frame) has no
    // landing and no row, whatever the telemetry says about the plan.
    current = { ...current, transportState: 'playing', renderedProjectFrame: '144064', audibleProjectFrame: '143936' }
    const flat = seamHarness((generation) => playing(generation, current))
    expect(await flat.client.prepareAndStart(countInRequest(3))).toBe(true)
    await flat.client.reconfigure({ playbackRate: 1.1 })
    expect(flat.prepared[1]).toHaveProperty('preparedStartProjectFrame')
    expect(flat.client.countInHeard()).toBeNull()
    await flat.client.unload()
  })

  it('an audible projection the core has not matured yet reads the render head, never the default 0', async () => {
    // After every transport edge the core republishes the audible frame only
    // once a latency's worth of callbacks has passed; until then the field
    // is its default 0 with the quality 'unavailable'. Read as a position
    // that is the top of the song — a burst of Space presses drew the bar at
    // 0.00 for one poll on every playing→paused edge. The render head stands
    // in, as it does on the phones.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '2880000', audibleProjectFrame: '2879872',
      audibleProjectionQuality: 'current'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart({ ...countInRequest(60), countIn: false })).toBe(true)
    expect(h.client.audibleSeconds()).toBeCloseTo(2879872 / 48_000, 3)
    // The pause lands: the projection is immature for the first status.
    current = {
      transportState: 'paused', renderedProjectFrame: '2881024', audibleProjectFrame: '0',
      audibleProjectionQuality: 'unavailable'
    }
    await h.client.pause()
    expect(h.client.audibleSeconds()).toBeCloseTo(2881024 / 48_000, 3)
    // Matured: the audible frame is back and wins again.
    current = {
      transportState: 'paused', renderedProjectFrame: '2881024', audibleProjectFrame: '2881024',
      audibleProjectionQuality: 'current'
    }
    await h.client.setMasterGain(0.5)
    expect(h.client.audibleSeconds()).toBeCloseTo(2881024 / 48_000, 3)
    await h.client.unload()
  })

  it('a Pause after a stale steady poll never draws the bar behind where it was pressed, and lands on the park point', async () => {
    // Measured on the Windows field laptop, per frame: in 4 of 28 Pauses the
    // bar stepped BACK by up to 131 ms between two frames that still read
    // playing, then jumped 20-150 ms forward. The intent flipped to paused
    // when the command returned and the projection stopped with it, so for
    // the read-back's round trip the bar drew the last poll unprojected — up
    // to a steady 200 ms old while a song simply plays.
    vi.setSystemTime(new Date('2026-09-25T00:00:00Z'))
    const current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '2880512', audibleProjectFrame: '2880000',
      audibleProjectionQuality: 'current'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart({ ...countInRequest(60), countIn: false })).toBe(true)
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    // The last poll is 180 ms old and the bar is projected past it.
    vi.advanceTimersByTime(180)
    const pressed = h.client.audibleSeconds()!
    expect(pressed).toBeCloseTo(60.18, 6)
    // Everything the bar reads while the pause crosses and its read-back comes
    // back — which lands before the render thread has taken the pause, so it
    // still says playing, a little further on.
    const seen: number[] = []
    const pauseMock = h.api.pauseDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    pauseMock.mockImplementationOnce(async (value: string) => {
      vi.advanceTimersByTime(20)
      seen.push(h.client.audibleSeconds()!)
      return result(value, 'running')
    })
    const statusMock = h.api.desktopPlaybackStatus as unknown as ReturnType<typeof vi.fn>
    statusMock.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(20)
      seen.push(h.client.audibleSeconds()!)
      return playing(h.generationNow(), { ...current, renderedProjectFrame: '2891072', audibleProjectFrame: '2890560' })
    })
    await h.client.pause()
    seen.push(h.client.audibleSeconds()!)
    // Never behind the press — and held there until the core says it parked.
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(pressed)
    expect(seen).toEqual([pressed, pressed, pressed])
    // The park point lands on the next poll, the render head a latency and a
    // delivery past the ear: the bar moves FORWARD to it.
    current.transportState = 'paused'
    current.renderedProjectFrame = '2891264'
    current.audibleProjectFrame = '0'
    current.audibleProjectionQuality = 'unavailable'
    await (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh(h.generationNow())
    expect(h.client.audibleSeconds()).toBeCloseTo(2891264 / 48_000, 6)
    expect(h.client.transportParked).toBe(true)
    await h.client.unload()
  })

  it('the pause hold is a floor under the park point, is never left behind by a refused Pause, and gives way to a seek, to Play, to a seek target that never lands, and to a loop that wrapped under it', async () => {
    vi.setSystemTime(new Date('2026-09-25T00:00:00Z'))
    // Pressed right after a start, where the render head less the fixture's
    // 128-frame latency stands in for an audible frame the core has not
    // matured yet: the park point can land a hair behind that projection, and
    // the bar must not step back to it.
    const latency = 128 / 48_000
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '480000', audibleProjectFrame: '0',
      audibleProjectionQuality: 'unavailable'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart({ ...countInRequest(10), countIn: false })).toBe(true)
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    vi.advanceTimersByTime(30)
    // A Pause the core refuses stopped nothing: the song plays on, and so
    // must the bar — a hold left behind would freeze it over the music.
    const pauseMock = h.api.pauseDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    pauseMock.mockImplementationOnce(async () => ({
      ...result('1', 'running'), ok: false, errorCode: 'host-failure', error: 'the output went away'
    }))
    await expect(h.client.pause()).rejects.toThrow(/the output went away/)
    vi.advanceTimersByTime(20)
    expect(h.client.audibleSeconds()).toBeCloseTo(10.05 - latency, 6)
    current = { transportState: 'paused', renderedProjectFrame: '481000', audibleProjectFrame: '0', audibleProjectionQuality: 'unavailable' }
    await h.client.pause()
    expect(h.client.audibleSeconds()).toBeCloseTo(10.05 - latency, 6)
    // A refused seek moved nothing, so the hold is still the floor.
    const seekMock = h.api.seekDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    seekMock.mockImplementationOnce(async () => ({
      ...result('1', 'running'), ok: false, errorCode: 'invalid-configuration', error: 'The absolute playback seek is invalid'
    }))
    await expect(h.client.seek(5)).rejects.toThrow()
    expect(h.client.audibleSeconds()).toBeCloseTo(10.05 - latency, 6)
    // Play reads the core again, from its park point on: a hold that
    // outlived the resume would freeze the bar while the song plays.
    current = { transportState: 'playing', renderedProjectFrame: '481512', audibleProjectFrame: '0', audibleProjectionQuality: 'unavailable' }
    await h.client.resume()
    vi.advanceTimersByTime(100)
    expect(h.client.audibleSeconds()).toBeCloseTo(481_512 / 48_000 + 0.1 - latency, 6)
    // A seek takes the bar back, however far past the target a Pause held it.
    await h.client.pause()
    await h.client.seek(5)
    current = { transportState: 'paused', renderedProjectFrame: '240000', audibleProjectFrame: '240000', audibleProjectionQuality: 'current', seekCount: '1' }
    await (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh('1')
    expect(h.client.audibleSeconds()).toBe(5)
    // Pressed while a seek is still owed a receipt, the hold is that target;
    // a core that never acknowledges it must not leave it on the bar through
    // the hold once the target itself has expired.
    await h.client.seek(8)
    await h.client.pause()
    expect(h.client.audibleSeconds()).toBe(8)
    vi.advanceTimersByTime(PENDING_SEEK_MAX_MS + 1)
    expect(h.client.audibleSeconds()).toBe(5)
    await h.client.unload()

    // Pressed a hair before a loop's end, with the last poll read just short
    // of the wrap: the render head wraps before the pause reaches the core,
    // and the core parks past the wrap. That is where the song is.
    current = {
      transportState: 'playing', renderedProjectFrame: '479128', audibleProjectFrame: '479000',
      audibleProjectionQuality: 'current', loopEnabled: true, loopStartFrame: '0', loopEndFrame: '480000', loopCount: '3'
    }
    const looped = seamHarness((generation) => playing(generation, current))
    expect(await looped.client.prepareAndStart({ ...countInRequest(9), countIn: false })).toBe(true)
    ;(looped.client as unknown as { stopPolling: () => void }).stopPolling()
    vi.advanceTimersByTime(10)
    expect(looped.client.audibleSeconds()).toBeCloseTo(479_480 / 48_000, 6)
    current = { ...current, transportState: 'paused', renderedProjectFrame: '1024', audibleProjectFrame: '0', audibleProjectionQuality: 'unavailable', loopCount: '4' }
    await looped.client.pause()
    expect(looped.client.audibleSeconds()).toBeCloseTo(1024 / 48_000, 6)
    await looped.client.unload()
  })

  /** A core that is continuous and exact, for the tests below. The render
   *  head moves 48 frames a millisecond at `rate` from wherever the last
   *  transport edge left it, and the audible projection is published only
   *  once `latency` output frames have passed since that edge, as the core
   *  publishes it. Nothing quantizes to a callback, so the bar can be held to
   *  EXACTLY where the ear is at every millisecond, and any difference is the
   *  facade's. Commands take effect the moment they are sent (a seek
   *  `seekDelayMs` later, when set); the core's own edges (a count-in's
   *  landing, a loop's wrap) at the times queued in `dues`; and a seam lands
   *  at the first read of the generation it prepared. With `quantum` set, the
   *  core publishes its status once a callback of that many output frames, as
   *  the real one does, and a read between two callbacks sees the last one. */
  const continuousCore = (latency: number, rate = 1, quantum = 0) => {
    type State = DesktopPlaybackStatus['transportState']
    const perMs = 48 * rate
    const lag = Math.round(latency * rate)
    const born = Date.now()
    const publishedAt = (): number =>
      quantum > 0 ? born + (Math.floor(((Date.now() - born) * 48) / quantum) * quantum) / 48 : Date.now()
    const core = {
      state: 'stopped' as State,
      frame: 0,
      at: Date.now(),
      loop: null as { start: number; end: number } | null,
      loopCount: 0,
      seekCount: 0,
      seekDelayMs: 0,
      dues: [] as Array<{ at: number; state: State; frame: number; lap: boolean; seek?: boolean }>
    }
    const moving = (): boolean => core.state === 'playing' || core.state === 'pre-roll'
    const head = (at = Date.now()): number => core.frame + (moving() ? Math.max(0, at - core.at) * perMs : 0)
    const edge = (state: State, frame: number, at = Date.now()): void => {
      core.state = state
      core.frame = frame
      core.at = at
    }
    // The core's own edges happen in the core's time, read or not.
    const settle = (now = Date.now()): void => {
      core.dues.sort((a, b) => a.at - b.at)
      while (core.dues.length > 0 && core.dues[0].at <= now) {
        const due = core.dues.shift()!
        if (due.seek) core.seekCount++
        edge(due.state, due.frame, due.at)
        if (due.lap) core.loopCount++
      }
    }
    let transportGeneration = '1'
    const h = seamHarness((generation) => {
      const now = publishedAt()
      settle(now)
      // A seam hands the clock across mid-song, at a callback: the head
      // carries on, and the projection starts over from the landing.
      if (generation !== transportGeneration) {
        transportGeneration = generation
        const at = Math.max(now, core.at)
        edge(core.state, head(at), at)
      }
      const rendered = Math.round(head(now))
      // A latency of OUTPUT frames after the edge, whatever the rate.
      const matured = Math.round((now - core.at) * 48) >= latency
      return playing(generation, {
        transportState: core.state,
        renderedProjectFrame: String(rendered),
        audibleProjectFrame: matured ? String(core.state === 'playing' ? rendered - lag : rendered) : '0',
        audibleProjectionQuality: matured ? 'current' : 'unavailable',
        presentationLatencyFrames: String(latency),
        durationFrames: String(48_000 * 600),
        playbackRate: rate,
        loopEnabled: core.loop !== null,
        loopStartFrame: String(core.loop?.start ?? 0),
        loopEndFrame: String(core.loop?.end ?? 0),
        loopCount: String(core.loopCount),
        seekCount: String(core.seekCount)
      })
    })
    const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>
    mock(h.api.startDesktopPlayback).mockImplementation(async (value: string) => {
      settle()
      edge(core.frame < 0 ? 'pre-roll' : 'playing', core.frame)
      return result(value, 'running')
    })
    mock(h.api.pauseDesktopPlayback).mockImplementation(async (value: string) => {
      settle()
      edge('paused', head())
      return result(value, 'running')
    })
    mock(h.api.resumeDesktopPlayback).mockImplementation(async (value: string) => {
      settle()
      edge('playing', core.frame)
      return result(value, 'running')
    })
    mock(h.api.seekDesktopPlayback).mockImplementation(async (value: string, asked: number) => {
      settle()
      // A seek at or past the loop's end lands inside it, with no lap
      // counted — the core's resolvedSeekFrame.
      const loop = core.loop
      const frame = loop !== null && asked >= loop.end ? loop.start + ((asked - loop.start) % (loop.end - loop.start)) : asked
      if (core.seekDelayMs > 0) {
        core.dues.push({ at: Date.now() + core.seekDelayMs, state: core.state, frame, lap: false, seek: true })
      } else {
        core.seekCount++
        edge(core.state, frame)
      }
      return result(value, 'running')
    })
    const misses: string[] = []
    let samples = 0
    /** The bar every millisecond for `ms`, a status read every 10 ms (the
     *  edge cadence after a Play), each sample held against `ear`: where the
     *  ear is, in frames, `sinceMs` after the call. */
    const follow = async (label: string, ms: number, ear: (sinceMs: number) => number): Promise<void> => {
      const t0 = Date.now()
      for (let t = 0; t <= ms; t++) {
        settle()
        if (t % 10 === 0) {
          await (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh(h.generationNow())
        }
        const bar = h.client.audibleSeconds()
        const want = ear(Date.now() - t0) / 48_000
        samples++
        if (bar === null || Math.abs(bar - want) > 1e-9) {
          misses.push(`${label}, ${t} ms in: the bar at ${bar === null ? 'null' : bar.toFixed(6)} s, the ear at ${want.toFixed(6)} s`)
        }
        vi.advanceTimersByTime(1)
      }
    }
    const stopPolling = (): void => (h.client as unknown as { stopPolling: () => void }).stopPolling()
    const verdict = (): void => {
      expect(misses.slice(0, 6), `${misses.length} of ${samples} samples away from the ear`).toEqual([])
    }
    return { h, core, perMs, lag, head, follow, stopPolling, verdict }
  }
  /** Where the ear is `dt` ms into a run that began at `start`: nothing new
   *  until the latency has passed, then the run itself. */
  const heard = (start: number, perMs: number, lag: number) => (dt: number) => Math.max(start, start + dt * perMs - lag)

  it('Play, a resume and a seek while playing: the bar waits on the spot until the ear gets there, then moves with it, and never steps back as the projection matures', async () => {
    // Measured on the Mac's built-in route (2026-09-25): 6 of 6 Plays stepped
    // the bar BACK by 9.6-11.6 ms, 22-75 ms after the press: the route's
    // presentation latency, 540 frames. After every edge the core publishes
    // the ear only once its projection has matured, a latency later, and the
    // render head stood in until then, a latency AHEAD of the ear. The bar
    // ran ahead of the music and stepped back when the projection took over.
    // On a 150-250 ms Bluetooth route that is a fifth of a second on every
    // Play and every scrub.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(540)
    c.core.frame = 60 * 48_000
    expect(await c.h.client.prepareAndStart({ ...countInRequest(60), countIn: false })).toBe(true)
    c.stopPolling()
    await c.follow('Play from 60 s', 40, heard(60 * 48_000, c.perMs, c.lag))
    // Paused a while: the core parks at its render head, which is where the
    // run after it begins.
    await c.h.client.pause()
    vi.advanceTimersByTime(400)
    const park = c.core.frame
    await c.h.client.resume()
    await c.follow('Play after a pause', 40, heard(park, c.perMs, c.lag))
    vi.advanceTimersByTime(200)
    await c.h.client.seek(70)
    await c.follow('a seek to 70 s while playing', 40, heard(70 * 48_000, c.perMs, c.lag))
    // A structural change while playing is a SEAM: the new generation takes
    // the clock mid-song with its projection unmatured, and the ear goes on
    // hearing the last latency of the old graph. No run starts there.
    vi.advanceTimersByTime(300)
    await c.h.client.reconfigure({ metronome: { ...countInRequest(60).metronome, click: true } })
    expect(c.h.client.status?.transportGeneration).toBe('2')
    await c.follow('a seam while playing', 30, () => c.head() - c.lag)
    c.verdict()
    await c.h.client.unload()
  })

  it('a Play that reaches the core after a Pause pressed just before it starts the bar where the core parked, never back from there', async () => {
    // Play pressed within a callback of Pause: the resume goes out while the
    // core still reads playing, so the spot the bar showed was the pause
    // hold. The core then parks at its render head, a latency past the hold,
    // takes the resume from there, and the bar drew that park point while
    // the core sat on it. The run begins at the park point, not at the hold.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '2880540', audibleProjectFrame: '2880000',
      audibleProjectionQuality: 'current', presentationLatencyFrames: '540'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart({ ...countInRequest(60), countIn: false })).toBe(true)
    ;(h.client as unknown as { stopPolling: () => void }).stopPolling()
    await h.client.pause()
    expect(h.client.audibleSeconds()).toBe(60)
    vi.advanceTimersByTime(2)
    current = { ...current, renderedProjectFrame: '2880636', audibleProjectFrame: '2880096' }
    const park = 2_880_732
    const resumeMock = h.api.resumeDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    resumeMock.mockImplementationOnce(async (value: string) => {
      current = { transportState: 'paused', renderedProjectFrame: String(park), audibleProjectFrame: '0', audibleProjectionQuality: 'unavailable', presentationLatencyFrames: '540' }
      return result(value, 'running')
    })
    await h.client.resume()
    expect(h.client.audibleSeconds()).toBe(park / 48_000)
    const refresh = () => (h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh(h.generationNow())
    // The resume taken, 480 frames rendered: the ear has not reached the park point.
    current = { transportState: 'playing', renderedProjectFrame: String(park + 480), audibleProjectFrame: '0', audibleProjectionQuality: 'unavailable', presentationLatencyFrames: '540' }
    await refresh()
    expect(h.client.audibleSeconds()).toBe(park / 48_000)
    vi.advanceTimersByTime(1)
    expect(h.client.audibleSeconds()).toBe(park / 48_000)
    vi.advanceTimersByTime(9)
    current = { transportState: 'playing', renderedProjectFrame: String(park + 960), audibleProjectFrame: String(park + 420), audibleProjectionQuality: 'current', presentationLatencyFrames: '540' }
    await refresh()
    expect(h.client.audibleSeconds()).toBe((park + 420) / 48_000)
    await h.client.unload()
  })

  it('a loop lap wraps the bar when the ear wraps, and a run that begins within a latency of either end of the loop keeps to its own lap', async () => {
    // The core re-anchors its projection at every wrap too, so the head stood
    // in for the ear through the first latency of every lap: the bar wrapped
    // a latency EARLY and then stepped back by one.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(540)
    const A = 70 * 48_000
    const B = A + 48_000
    const fold = (frame: number): number => (frame >= B ? A + ((frame - A) % (B - A)) : frame)
    c.core.frame = A + 24_000
    c.core.loop = { start: A, end: B }
    expect(await c.h.client.prepareAndStart({ ...countInRequest((A + 24_000) / 48_000), countIn: false })).toBe(true)
    c.stopPolling()
    const started = Date.now()
    await c.follow('Play inside the loop', 30, heard(A + 24_000, c.perMs, c.lag))
    // The head reaches B 500 ms after Play; the ear a latency after that.
    c.core.dues.push({ at: started + 500, state: 'playing', frame: A, lap: true })
    vi.advanceTimersByTime(started + 470 - Date.now())
    await c.follow('a lap of the loop', 60, (dt) => fold(B - 30 * 48 + dt * 48 - 540))
    // A seek to 4 ms short of B: the head wraps long before the ear has even
    // reached the target, and the ear then wraps as well. The run's floor
    // holds in the lap it began in and not a moment after.
    const near = B - 4 * 48
    await c.h.client.seek(near / 48_000)
    c.core.dues.push({ at: Date.now() + 4, state: 'playing', frame: A, lap: true })
    await c.follow('a seek to just short of the loop end', 30, (dt) => fold(heard(near, c.perMs, c.lag)(dt)))
    // And a seek to just past A: the ear is before the loop's start for a
    // latency, which is a run that has not begun yet, not a wrap to fold.
    const early = A + 96
    await c.h.client.seek(early / 48_000)
    const seeked = Date.now()
    const lapFromEarly = (): number => fold(early + (Date.now() - seeked) * 48 - 540)
    await c.follow('a seek to just past the loop start', 30, heard(early, c.perMs, c.lag))
    // A seam in the lap forgets the run, and the lap the core places the ear
    // in once the new generation's projection matures is what tells the next
    // wrap apart. The head reaches B 998 ms after that seek.
    vi.advanceTimersByTime(seeked + 500 - Date.now())
    await c.h.client.reconfigure({ metronome: { ...countInRequest(60).metronome, click: true } })
    await c.follow('a seam inside the loop', 30, lapFromEarly)
    c.core.dues.push({ at: seeked + 998, state: 'playing', frame: A, lap: true })
    vi.advanceTimersByTime(seeked + 968 - Date.now())
    await c.follow('the lap after the seam', 60, lapFromEarly)
    c.verdict()
    await c.h.client.unload()
  })

  it('a status up to a callback stale never folds the bar back into a loop lap it has shown, nor past the lap its run began in', async () => {
    // The core publishes its status once a callback, so a read between two
    // callbacks is up to a callback stale, and each status the bar switches
    // to can move it by up to a callback either way. Right after a wrap the
    // projection has not matured and the head less the latency stands in for
    // the ear. When the status before had already wrapped the bar with the
    // ear, a staler stand-in landed a hair short of the loop's start and was
    // folded into the lap the head had left: the loop's start, its tail, then
    // its start again, two whole-loop jumps. Measured on the Mac's plain
    // route in 6 of ~190 wraps of a short loop. And a loop shorter than the
    // latency (the app allows 0.05 s) folded the stand-in back past the lap
    // the run began in, so after Play the bar ran through the loop before the
    // first note had reached the ear.
    // 512-frame callbacks (the Mac's route) and a read every 47 ms, which
    // lines up with neither the callbacks nor the loop, so the laps meet every
    // phase of both. The bar is sampled every millisecond: never ahead of the
    // ear and never more than a callback behind it, one wrap for each of the
    // ear's, and no step back of more than a callback in between.
    const quantum = 512
    const A = 70 * 48_000
    const route = async (label: string, latency: number, span: number, laps: number): Promise<void> => {
      vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
      const c = continuousCore(latency, 1, quantum)
      const B = A + span
      const from = A + span / 2
      c.core.frame = from
      c.core.loop = { start: A, end: B }
      expect(await c.h.client.prepareAndStart({ ...countInRequest(from / 48_000), countIn: false })).toBe(true)
      c.stopPolling()
      const played = Date.now()
      // The head reaches B half a lap after Play, then wraps every lap.
      const lapMs = span / 48
      for (let k = 0; k < laps; k++) {
        c.core.dues.push({ at: played + lapMs / 2 + k * lapMs, state: 'playing', frame: A, lap: true })
      }
      const ear = (t: number): number => {
        const frame = from + (t - played) * 48 - latency
        if (frame < from) return from
        return frame >= B ? A + ((frame - A) % span) : frame
      }
      const refresh = () => (c.h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh(c.h.generationNow())
      const misses: string[] = []
      let before: number | null = null
      let heardBefore: number | null = null
      let wraps = 0
      let earWraps = 0
      // Reads whose stand-in, folded as it used to be, lands in a lap before
      // one the bar has shown: the reads this is about, counted so that a
      // sweep that never meets one fails rather than passes.
      let crossings = 0
      for (let t = 0; t <= laps * lapMs; t++) {
        if (t % 47 === 0) {
          await refresh()
          const status = c.h.client.status!
          const standIn = Number(status.renderedProjectFrame) - latency
          if (status.audibleProjectionQuality !== 'current' && standIn < A &&
              Number(status.loopCount) - Math.ceil((A - standIn) / span) < wraps) crossings++
        }
        const bar = c.h.client.audibleSeconds()! * 48_000
        const heard = ear(Date.now())
        let behind = heard - bar
        if (behind < -span / 2) behind += span
        if (behind > span / 2) behind -= span
        if (behind < -1e-6 || behind > quantum + 1e-6 || bar < A - 1e-6 || bar >= B) {
          misses.push(`${label}, ${t} ms after Play: the bar ${(bar - A).toFixed(0)} frames into the loop, the ear ${(heard - A).toFixed(0)}`)
        }
        if (before !== null) {
          const step = bar - before
          if (step > span / 2) {
            misses.push(`${label}, ${t} ms after Play: a whole loop forward, ${(before - A).toFixed(0)} to ${(bar - A).toFixed(0)} frames into it`)
          } else if (step < -span / 2) {
            wraps++
          } else if (step < -quantum - 1e-6) {
            misses.push(`${label}, ${t} ms after Play: ${(-step).toFixed(0)} frames back`)
          }
        }
        if (heardBefore !== null && heard - heardBefore < -span / 2) earWraps++
        before = bar
        heardBefore = heard
        vi.advanceTimersByTime(1)
      }
      expect(misses.slice(0, 6), `${label}: ${misses.length} samples wrong`).toEqual([])
      expect(wraps, `${label}: the bar wrapped ${wraps} times for the ear's ${earWraps}`).toBe(earWraps)
      expect(crossings, `${label}: no read crossed back into a lap the bar had shown`).toBeGreaterThan(0)
      await c.h.client.unload()
    }
    await route('a plain route', 540, 12_960, 60)
    await route('a transposed song', 7_260, 12_960, 60)
    await route('a loop shorter than the latency', 9_600, 7_200, 60)
  })

  it('a seam that lands a callback after a loop wrap keeps the lap the bar has shown', async () => {
    // The core hands the clock and the lap count across a seam, so the laps
    // the bar has shown go across with the run. Forgotten, a seam landing at
    // the callback after a wrap drew the loop's tail again: its first status
    // stands in for the ear from a head read before the ear wrapped.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(540, 1, 512)
    const A = 70 * 48_000
    const span = 12_960
    const B = A + span
    const from = A + span / 2
    c.core.frame = from
    c.core.loop = { start: A, end: B }
    expect(await c.h.client.prepareAndStart({ ...countInRequest(from / 48_000), countIn: false })).toBe(true)
    c.stopPolling()
    const played = Date.now()
    // Callbacks every 10.67 ms from Play; the head wraps at 135 ms, between
    // the ones at 128 and 138.67, and the ear 11.25 ms later, at 146.25.
    c.core.dues.push({ at: played + 135, state: 'playing', frame: A, lap: true })
    const refresh = () => (c.h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh(c.h.generationNow())
    const ear = (t: number): number => {
      const frame = from + (t - played) * 48 - 540
      return frame >= B ? A + (frame - B) : Math.max(from, frame)
    }
    const misses: string[] = []
    let before: number | null = null
    const look = (): number => {
      const bar = c.h.client.audibleSeconds()! * 48_000
      let behind = ear(Date.now()) - bar
      if (behind < -span / 2) behind += span
      if (behind < -1e-6 || behind > 512 + 1e-6) misses.push(`${Date.now() - played} ms after Play: the bar ${(bar - A).toFixed(0)} frames into the loop`)
      if (before !== null && bar - before > span / 2) misses.push(`${Date.now() - played} ms after Play: a whole loop forward`)
      before = bar
      return bar
    }
    // A matured status read at the callback, 128 ms after Play: its
    // projection wraps the bar with the ear.
    vi.advanceTimersByTime(128)
    await refresh()
    expect(c.h.client.status?.audibleProjectionQuality).toBe('current')
    let bar = 0
    while (Date.now() - played < 147) {
      bar = look()
      vi.advanceTimersByTime(1)
    }
    bar = look()
    expect(bar).toBeGreaterThanOrEqual(A)
    expect(bar).toBeLessThan(A + 512)
    // The seam lands at the callback of 138.67 ms, with the head 176 frames
    // into the new lap and the ear 364 short of it by that callback's clock.
    await c.h.client.reconfigure({ metronome: { ...countInRequest(60).metronome, click: true } })
    expect(c.h.client.status?.transportGeneration).toBe('2')
    for (let t = 0; t < 60; t++) {
      if (t % 10 === 0) await refresh()
      look()
      vi.advanceTimersByTime(1)
    }
    expect(misses.slice(0, 6), `${misses.length} samples wrong`).toEqual([])
    await c.h.client.unload()
  })

  it('in a loop shorter than the latency a seek holds the bar on its target until the ear gets there, even when the head wraps before the bar is next drawn', async () => {
    // The head of a 0.15 s loop on a 200 ms route is more than a lap ahead of
    // the ear. Taken 1 ms short of the loop's end, the seek has the head wrap
    // before the bar is drawn again, and the stand-in, two laps back from the
    // head's, belongs to a lap before the run's own, where no floor holds:
    // the bar showed a spot the ear had not reached.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(9600)
    const A = 70 * 48_000
    const span = 7_200
    const B = A + span
    c.core.frame = A + 3_600
    c.core.loop = { start: A, end: B }
    expect(await c.h.client.prepareAndStart({ ...countInRequest((A + 3_600) / 48_000), countIn: false })).toBe(true)
    c.stopPolling()
    vi.advanceTimersByTime(30)
    const target = B - 48
    await c.h.client.seek(target / 48_000)
    const seeked = Date.now()
    for (let k = 0; k < 4; k++) c.core.dues.push({ at: seeked + 1 + k * 150, state: 'playing', frame: A, lap: true })
    vi.advanceTimersByTime(5)
    await (c.h.client as unknown as { refresh: (g: string) => Promise<void> }).refresh(c.h.generationNow())
    expect(c.h.client.status?.loopCount).toBe('1')
    expect(c.h.client.audibleSeconds()).toBe(target / 48_000)
    const ear = (dt: number): number => {
      const frame = target + (dt + 5) * 48 - 9600
      return frame < target ? target : frame >= B ? A + ((frame - A) % span) : frame
    }
    await c.follow('the seek and the laps after it', 400, ear)
    c.verdict()
    await c.h.client.unload()
  })

  it('a seek right after a wrap the facade never read takes the lap the core took it in', async () => {
    // A song looping between two polls wraps with no status to say so, and
    // `seek()` used to take the run's lap from the last poll: a whole wrap
    // behind. On a long route that folded the ear of a seek near the loop's
    // start into the lap before, so the bar sat at the loop's END for the
    // whole latency, or it dropped the floor under a seek mid-loop, so the
    // bar fell below the target. 9600 frames is a 200 ms Bluetooth route.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(9600)
    const A = 70 * 48_000
    const B = A + 4 * 48_000
    c.core.frame = B - 14_400
    c.core.loop = { start: A, end: B }
    expect(await c.h.client.prepareAndStart({ ...countInRequest((B - 14_400) / 48_000), countIn: false })).toBe(true)
    c.stopPolling()
    const started = Date.now()
    await c.follow('Play 0.3 s before the loop end', 250, heard(B - 14_400, c.perMs, c.lag))
    // The head wraps 300 ms after Play, with nothing read after 250 ms.
    c.core.dues.push({ at: started + 300, state: 'playing', frame: A, lap: true })
    vi.advanceTimersByTime(started + 320 - Date.now())
    const nearStart = A + 48
    await c.h.client.seek(nearStart / 48_000)
    const seeked = Date.now()
    await c.follow('a seek to the loop start after an unread wrap', 250, heard(nearStart, c.perMs, c.lag))
    // Again, and mid-loop: the head reaches B 3999 ms after that seek.
    c.core.dues.push({ at: seeked + 3999, state: 'playing', frame: A, lap: true })
    vi.advanceTimersByTime(seeked + 4019 - Date.now())
    const mid = A + 2 * 48_000
    await c.h.client.seek(mid / 48_000)
    await c.follow('a seek mid-loop after an unread wrap', 250, heard(mid, c.perMs, c.lag))
    // And 2 ms short of B, the seek taken a millisecond after it is sent: the
    // head wraps before the receipt is read, so the receipt's lap is one past
    // the lap the run began in, and the run goes one lap back.
    c.core.seekDelayMs = 1
    const nearEnd = B - 96
    await c.h.client.seek(nearEnd / 48_000)
    c.core.dues.push({ at: Date.now() + 3, state: 'playing', frame: A, lap: true })
    const fold = (frame: number): number => (frame >= B ? A + (frame - B) : frame)
    await c.follow('a seek 2 ms short of the loop end, its receipt read after the wrap', 250,
      (dt) => fold(heard(nearEnd, c.perMs, c.lag)(dt - 1)))
    // A seek PAST the loop's end: the core lands it a second into the loop
    // and counts no lap, so the head sits below the target the facade asked
    // for without having wrapped. The run starts where the core put it.
    // The reads are 5 ms off the seek, so the ear passes the folded target
    // before a matured status says so: a floor left at the unfolded target
    // holds the bar there for those milliseconds.
    c.core.seekDelayMs = 0
    await c.h.client.seek((B + 48_000) / 48_000)
    const past = Date.now()
    vi.advanceTimersByTime(5)
    await c.follow('a seek past the loop end, folded into the loop', 250,
      () => heard(A + 48_000, c.perMs, c.lag)(Date.now() - past))
    c.verdict()
    await c.h.client.unload()
  })

  it('a seek still owed its receipt when a seam arms keeps its target across it: the bar neither goes back to where it was nor drops below the target', async () => {
    // The core carries the seek count across a seam (the replacement takes
    // the old transport's count over at the landing; every status before it
    // is the old transport's), so the receipt still arrives — and until it
    // does, only the seek knows where the song is going. Forgotten at the
    // seam, it cost two things. The bar drew the last status again: the spot
    // the singer had just left, until a read showed the seek applied (the
    // Loop button with the playhead past the selection seeks to its start,
    // then arms the loop, a seam). And the run crossed the seam with the lap
    // `seek()` read off the last poll, which only the receipt corrects: after
    // a wrap no status had shown, that lap was one behind, the floor was
    // dropped, and the bar drew BELOW the target for a whole latency — on a
    // 200 ms route, 71.807 s after a seek to 72 s.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(9600)
    const A = 70 * 48_000
    const B = A + 4 * 48_000
    c.core.frame = 80 * 48_000
    expect(await c.h.client.prepareAndStart({ ...countInRequest(80), countIn: false })).toBe(true)
    c.stopPolling()
    await c.follow('Play at 80 s', 250, heard(80 * 48_000, c.perMs, c.lag))

    // The Loop button, playing past the selection: a seek back to its start
    // that the core takes 5 ms after it is sent, and the loop armed behind it.
    c.core.seekDelayMs = 5
    await c.h.client.seek(A / 48_000)
    const back = Date.now()
    await c.h.client.reconfigure({ loop: { start: 70, end: 74 } })
    c.core.loop = { start: A, end: B }
    await c.follow('the loop armed right behind a seek back to its start', 250,
      () => heard(A, c.perMs, c.lag)(Date.now() - back - 5))

    // A wrap nobody read, then a mid-loop seek and a seam before its receipt.
    c.core.dues.push({ at: back + 5 + 4000, state: 'playing', frame: A, lap: true })
    vi.advanceTimersByTime(back + 5 + 4020 - Date.now())
    const mid = A + 2 * 48_000
    await c.h.client.seek(mid / 48_000)
    const seeked = Date.now()
    await c.h.client.reconfigure({ metronome: { ...countInRequest(60).metronome, click: true } })
    await c.follow('a mid-loop seek after an unread wrap, a seam before its receipt', 250,
      () => heard(mid, c.perMs, c.lag)(Date.now() - seeked - 5))
    c.verdict()
    await c.h.client.unload()
  })

  it('a seek the core never acknowledges gives the bar back to the core\'s clock, loop laps and all', async () => {
    // The target is dropped after PENDING_SEEK_MAX_MS, and the run with it,
    // which also loses the lap the ear was known to be in. The next matured
    // status places the ear again, so the loop's next wrap still waits for
    // the ear rather than wrapping a latency early.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(540)
    const A = 70 * 48_000
    const B = A + 2 * 48_000
    const start = A + 9600
    c.core.frame = start
    c.core.loop = { start: A, end: B }
    expect(await c.h.client.prepareAndStart({ ...countInRequest(start / 48_000), countIn: false })).toBe(true)
    c.stopPolling()
    const started = Date.now()
    await c.follow('Play inside the loop', 99, heard(start, c.perMs, c.lag))
    const seekMock = c.h.api.seekDesktopPlayback as unknown as ReturnType<typeof vi.fn>
    seekMock.mockImplementationOnce(async (value: string) => result(value, 'running'))
    const target = A + 60_000
    await c.h.client.seek(target / 48_000)
    const seeked = Date.now()
    // The head reaches B 1800 ms after Play, the target long expired by then.
    c.core.dues.push({ at: started + 1800, state: 'playing', frame: A, lap: true })
    const lap = (t: number): number => {
      const frame = start + (t - started) * 48 - 540
      return frame >= B ? A + (frame - B) : frame
    }
    await c.follow('a seek the core never took, then a lap', 1900 - (seeked - started),
      () => (Date.now() - seeked < PENDING_SEEK_MAX_MS ? target : lap(Date.now())))
    c.verdict()
    await c.h.client.unload()
  })

  it('a seek while the song plays is watched every edge period until its receipt, so the bar leaves the target with the ear instead of a steady poll later', async () => {
    // seek() read one status back and left the next look to the poll already
    // armed: a steady 200 ms one while a song simply plays. The read-back
    // lands before the callback takes the seek, so the bar held the target
    // until that poll while the song played on from it, then jumped forward:
    // holds of 30-185 ms and forward steps of 50-170 ms, measured on the Mac.
    // The poller runs here, as it does in the app; the core takes the seek
    // at its next callback, 4 ms after it arrives.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(540)
    c.core.frame = 60 * 48_000
    expect(await c.h.client.prepareAndStart({ ...countInRequest(60), countIn: false })).toBe(true)
    const reads = (): number => (c.h.api.desktopPlaybackStatus as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    // Past the burst, into the steady cadence, and 20 ms after a steady poll.
    await vi.advanceTimersByTimeAsync(POLL_BURST_MS + 600)
    const steady = reads()
    while (reads() === steady) await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(20)
    c.core.seekDelayMs = 4
    const target = 70 * 48_000
    await c.h.client.seek(70)
    const seeked = Date.now()
    const atSeek = reads()
    const misses: string[] = []
    for (let t = 0; t <= 300; t++) {
      const bar = c.h.client.audibleSeconds()!
      const ear = Math.max(target, target + (Date.now() - seeked - 4) * 48 - 540) / 48_000
      if (Math.abs(bar - ear) > 1e-9) misses.push(`${t} ms after the seek: the bar at ${bar.toFixed(6)} s, the ear at ${ear.toFixed(6)} s`)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(misses.slice(0, 6), `${misses.length} of 301 samples away from the ear`).toEqual([])
    // And the edge cadence ends with the projection's maturity: two edge
    // looks, then the burst, not 10 ms reads for the whole POLL_EDGE_MAX_MS.
    expect(reads() - atSeek).toBeLessThanOrEqual(10)
    ;(c.h.client as unknown as { stopPolling: () => void }).stopPolling()
    await c.h.client.unload()
  })

  it('a seam inside a run\'s first latency keeps the run: the bar holds on its start until the ear gets there', async () => {
    // Turning Loop on seeks to the selection and then seams. On a long route
    // the seam lands well inside the seek's first latency, and forgetting the
    // run there dropped the bar below the spot the run began on and walked it
    // back up. The core hands the clock and the lap count across a seam, so
    // the run goes across with them.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(9600)
    c.core.frame = 60 * 48_000
    expect(await c.h.client.prepareAndStart({ ...countInRequest(60), countIn: false })).toBe(true)
    c.stopPolling()
    await c.follow('Play from 60 s', 250, heard(60 * 48_000, c.perMs, c.lag))
    await c.h.client.seek(70)
    const seeked = Date.now()
    const run = heard(70 * 48_000, c.perMs, c.lag)
    await c.follow('a seek to 70 s', 50, run)
    await c.h.client.reconfigure({ metronome: { ...countInRequest(60).metronome, click: true } })
    expect(c.h.client.status?.transportGeneration).toBe('2')
    const offset = Date.now() - seeked
    await c.follow('a seam 51 ms into the run', 250, (dt) => run(offset + dt))
    c.verdict()
    await c.h.client.unload()
  })

  it('after a count-in the bar holds on the landing until the ear gets there, and at a non-unity rate the ear trails by the latency in song frames', async () => {
    // The landing re-anchors the projection as well: the head stood in, a
    // latency past the landing, while the last clicks were still sounding.
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    const c = continuousCore(540)
    const landing = 3 * 48_000
    c.core.frame = -4_800
    expect(await c.h.client.prepareAndStart(countInRequest(3))).toBe(true)
    c.stopPolling()
    c.core.dues.push({ at: Date.now() + 100, state: 'playing', frame: landing, lap: false })
    await c.follow('a count-in to 3 s', 140, (dt) => (dt < 100 ? landing : heard(landing, c.perMs, c.lag)(dt - 100)))
    c.verdict()
    await c.h.client.unload()
    // At 0.75x the song moves 36 frames a millisecond and the ear trails the
    // head by 405 of them: the latency is output frames, scaled by the rate
    // exactly as the core scales it.
    const slow = continuousCore(540, 0.75)
    slow.core.frame = 60 * 48_000
    expect(await slow.h.client.prepareAndStart({ ...countInRequest(60), countIn: false, playbackRate: 0.75 })).toBe(true)
    slow.stopPolling()
    await slow.follow('Play from 60 s at 0.75x', 40, heard(60 * 48_000, slow.perMs, slow.lag))
    slow.verdict()
    await slow.h.client.unload()
  })

  it('countInHeard scales the output latency by the playback rate, as the core projects it', async () => {
    // The latency is output frames; the runway is project frames. At 0.5×
    // the ear is 64 project frames behind a 128-frame route, not 128.
    const current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48064',
      presentationLatencyFrames: '128', playbackRate: 0.5, preRollFrames: '96000',
      countInEventCount: 4, countInBeatsPerBar: 4
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart({ ...countInRequest(3), playbackRate: 0.5 })).toBe(true)
    expect(h.client.countInHeard()).toMatchObject({ secondsToLanding: -(48_000 + 64) / 48_000, landingSeconds: 3 })
    await h.client.unload()
  })

  it('countInHeard projects the render head between polls, so a last click inside one poll of the landing still lights its dot', async () => {
    // The dots are drawn every frame and the status arrives every 50 ms.
    // Read raw, a last click 20 ms before the landing was heard inside ONE
    // poll interval: the last pre-roll status heard the ear just short of it
    // and the next was already past the tail — three dots of four, measured
    // on the Mac. Only the clock moves below (setSystemTime fires no poll),
    // exactly the time between two statuses.
    const t0 = Date.parse('2026-09-17T00:00:00Z')
    vi.setSystemTime(t0)
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-2400', audibleProjectFrame: '-2528',
      presentationLatencyFrames: '128', preRollFrames: '96000', countInEventCount: 4, countInBeatsPerBar: 4
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(3))).toBe(true)
    expect(h.client.countInHeard()?.secondsToLanding).toBe(-(2400 + 128) / 48_000)
    // 30 ms later, no new status: the ear has moved 1440 frames on.
    vi.setSystemTime(t0 + 30)
    expect(h.client.countInHeard()?.secondsToLanding).toBe(-(960 + 128) / 48_000)
    // 60 ms: projected past the landing the core has not reported yet — the
    // row stays, full, capped AT the landing, never past it.
    vi.setSystemTime(t0 + 60)
    expect(h.client.countInHeard()?.secondsToLanding).toBe(0)
    // Landed 64 frames ago per the status; the tail's last 64 frames run out
    // on the clock alone, and the row is over for good.
    current = { ...current, transportState: 'playing', renderedProjectFrame: '144064', audibleProjectFrame: '143936' }
    await h.client.setMasterGain(0.5)
    expect(h.client.countInHeard()?.secondsToLanding).toBe(-64 / 48_000)
    vi.setSystemTime(Date.now() + 1)
    expect(h.client.countInHeard()?.secondsToLanding).toBe(-16 / 48_000)
    vi.setSystemTime(Date.now() + 1)
    expect(h.client.countInHeard()).toBeNull()
    await h.client.unload()

    // Bounded: a stalled read projects at most COUNT_IN_PROJECTION_MAX_MS, so
    // the dots freeze rather than run ahead of the clicks.
    vi.setSystemTime(t0)
    current = {
      transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48128',
      presentationLatencyFrames: '128', preRollFrames: '96000', countInEventCount: 4, countInBeatsPerBar: 4
    }
    const stalled = seamHarness((generation) => playing(generation, current))
    expect(await stalled.client.prepareAndStart(countInRequest(3))).toBe(true)
    vi.setSystemTime(t0 + 5000)
    const bound = Math.round((COUNT_IN_PROJECTION_MAX_MS / 1000) * 48_000)
    expect(stalled.client.countInHeard()?.secondsToLanding).toBe(-(48_000 - bound + 128) / 48_000)
    // Paused inside the count-in: nothing is advancing, nothing is projected.
    current = { ...current, transportState: 'paused' }
    await stalled.client.pause()
    vi.setSystemTime(Date.now() + 100)
    expect(stalled.client.countInHeard()?.secondsToLanding).toBe(-(48_000 + 128) / 48_000)
    await stalled.client.unload()
  })

  it('a structural change INSIDE a count-in is a rebuild anchored at the landing — never a seam, never the pre-roll frame carried across', async () => {
    // Measured on the real app: the click turned on during a count-in from
    // 60 s brought the song in at 0.01 s (the seam handed the old pre-roll
    // clock to a plan with no anchor, whose landing is the entry), and a
    // control touched while PAUSED inside one moved the bar to 0 and the
    // next Play counted in to the top (the rebuild carried the negative
    // frame as its signed start, again with no anchor).
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(3))).toBe(true)
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...countInRequest(3).metronome, click: true } })
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[1]).not.toHaveProperty('swapFromGeneration')
    expect(h.prepared[1]).not.toHaveProperty('preparedStartProjectFrame')
    expect(h.prepared[1].playback.transport).toMatchObject({ entrySeconds: 0, countInAnchorSeconds: 3 })
    expect(h.prepared[1].initialTransport).toEqual({ state: 'playing' })
    expect(h.client.audibleSeconds()).toBe(3)
    // Paused inside it: the rebuild is parked at the top of its pre-roll,
    // still anchored, and the bar still holds at the landing.
    current = { transportState: 'paused', renderedProjectFrame: '-48000', audibleProjectFrame: '-48000' }
    await h.client.pause()
    h.calls.length = 0
    await h.client.reconfigure({ playbackRate: 1.1 })
    expect(h.calls).toEqual(['stop:2', 'unload:2', 'prepare:3', 'open:3', 'start:3'])
    expect(h.prepared[2]).not.toHaveProperty('preparedStartProjectFrame')
    expect(h.prepared[2].playback.transport).toMatchObject({ countInAnchorSeconds: 3 })
    expect(h.prepared[2].initialTransport).toEqual({ state: 'paused' })
    expect(h.client.audibleSeconds()).toBe(3)
    // Turning the count-in OFF inside one starts flat AT the landing: no
    // anchor, a signed start there — where the singer asked to be.
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...countInRequest(3).metronome, countInBars: 0 } })
    expect(h.prepared[3]).toMatchObject({ preparedStartProjectFrame: 144_000 })
    expect(h.prepared[3].playback.transport).not.toHaveProperty('countInAnchorSeconds')
    expect(h.client.countInHeard()).toBeNull()
    // Once the song has LANDED a control change seams at the signed frame,
    // exactly as before.
    current = { transportState: 'playing', renderedProjectFrame: '200000', audibleProjectFrame: '199872' }
    await h.client.resume()
    h.calls.length = 0
    await h.client.reconfigure({ playbackRate: 1.2 })
    expect(h.calls[0]).toBe('prepare:5:swap-from-4')
    expect(h.prepared[4]).toMatchObject({ preparedStartProjectFrame: 200_000 })
    await h.client.unload()
  })

  it('a second Play inside the first restart adopts it: one stop, one build, one count-in', async () => {
    // A double press, or the second press inside one 5 Hz status poll the
    // transport-race driver reproduces. The second restart queues behind the
    // first and finds a generation already started with the intent to play —
    // the restart it asked for. Without the guard it stopped and unloaded
    // that generation and built another: the count-in began twice.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'playing', renderedProjectFrame: '240000', audibleProjectFrame: '239872'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(0))).toBe(true)
    current = { transportState: 'paused', renderedProjectFrame: '240000', audibleProjectFrame: '240000' }
    await h.client.pause()
    h.calls.length = 0
    // The first snapshot of a started generation reads 'stopped' for ~80 ms.
    current = { transportState: 'stopped', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128' }
    const first = h.client.restartWithCountIn(countInRequest(5))
    const second = h.client.restartWithCountIn(countInRequest(5))
    await Promise.all([first, second])
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.client.transportActive).toBe(false) // 'stopped' is not yet running…
    expect(h.client.audibleSeconds()).toBe(5) // …but the bar already holds at the landing
    // A song that RAN OUT is still restartable: that is the end-of-song path.
    current = { transportState: 'completed', renderedProjectFrame: '480000', audibleProjectFrame: '480000' }
    await h.client.setMasterGain(0.5)
    h.calls.length = 0
    current = { transportState: 'pre-roll', renderedProjectFrame: '-96000', audibleProjectFrame: '-96128' }
    await h.client.restartWithCountIn(countInRequest(0))
    expect(h.calls).toEqual(['stop:2', 'unload:2', 'prepare:3', 'open:3', 'start:3'])
    await h.client.unload()
  })

  it('paused inside a count-in at the TOP, a change that shortens the pre-roll rebuilds at the new plan\'s own start — never at the old negative frame', async () => {
    // The commonest count-in of all, paused, then the count-in turned off by
    // a singer annoyed by it. Carrying the paused pre-roll frame as the
    // signed start hands the core a start below the NEW plan's pre-roll (0
    // with the count-in off), which it refuses — after the old generation is
    // already unloaded: a playback error, Chromium's sink not restored until
    // the next Play retries.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48128'
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(0))).toBe(true)
    current = { transportState: 'paused', renderedProjectFrame: '-48000', audibleProjectFrame: '-48000' }
    await h.client.pause()
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...countInRequest(0).metronome, countInBars: 0 } })
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    // Flat at the top, parked: a signed start of 0, no anchor, no pre-roll.
    expect(h.prepared[1]).toMatchObject({ preparedStartProjectFrame: 0, initialTransport: { state: 'paused' } })
    expect(h.prepared[1].playback.transport).not.toHaveProperty('countInAnchorSeconds')
    expect(h.prepared[1].playback.cues.countInBars).toBe(0)
    // And with the count-in KEPT (a different bar count), the rebuild is
    // pre-rolled from the new plan's own start — no signed frame at all.
    await h.client.unload()
    current = { transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48128' }
    const kept = seamHarness((generation) => playing(generation, current))
    expect(await kept.client.prepareAndStart(countInRequest(0))).toBe(true)
    current = { transportState: 'paused', renderedProjectFrame: '-48000', audibleProjectFrame: '-48000' }
    await kept.client.pause()
    kept.calls.length = 0
    await kept.client.reconfigure({ metronome: { ...countInRequest(0).metronome, countInBars: 2 } })
    expect(kept.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(kept.prepared[1]).not.toHaveProperty('preparedStartProjectFrame')
    expect(kept.prepared[1].playback.transport).not.toHaveProperty('countInAnchorSeconds')
    expect(kept.prepared[1].initialTransport).toEqual({ state: 'paused' })
    expect(kept.client.audibleSeconds()).toBe(0)
    await kept.client.unload()
  })

  it('a seam inside a count-in at the top keeps the dots counting the clicks still to come', async () => {
    // The one seam still allowed inside a count-in: playing, landing 0. The
    // core carries the pre-roll clock across; the new generation's landing
    // is 0 too, so the dots keep reporting instead of vanishing.
    let current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48128',
      presentationLatencyFrames: '128', preRollFrames: '96000', countInEventCount: 4, countInBeatsPerBar: 4
    }
    const h = seamHarness((generation) => playing(generation, current))
    expect(await h.client.prepareAndStart(countInRequest(0))).toBe(true)
    expect(h.client.countInHeard()).toMatchObject({ landingSeconds: 0, total: 4 })
    h.calls.length = 0
    await h.client.reconfigure({ metronome: { ...countInRequest(0).metronome, click: true } })
    expect(h.calls[0]).toBe('prepare:2:swap-from-1')
    expect(h.prepared[1]).toMatchObject({ preparedStartProjectFrame: 0 })
    current = { ...current, renderedProjectFrame: '-24000', audibleProjectFrame: '-24128' }
    await h.client.setMasterGain(0.5)
    expect(h.client.countInHeard()).toMatchObject({
      landingSeconds: 0, secondsToLanding: -(24_000 + 128) / 48_000, total: 4
    })
    expect(h.client.audibleSeconds()).toBe(0)
    await h.client.unload()
  })

  it('PLAYING inside a count-in at the top, a change no seam takes — a route change, or one behind a seam that never landed — is rebuilt anchored at the landing, never at the negative frame', async () => {
    // Only the seam may carry a pre-roll clock across. A rebuild handed the
    // negative frame as its signed start gets no anchor — the dots vanished —
    // and the core refuses a start below a NEW plan's shorter pre-roll after
    // the old generation is gone.
    // The candidate `as`, armed over `from`'s transport for good.
    let seam: { as: string; from: string } | null = null
    const current: Partial<DesktopPlaybackStatus> = {
      transportState: 'pre-roll', renderedProjectFrame: '-48000', audibleProjectFrame: '-48128',
      presentationLatencyFrames: '128', preRollFrames: '96000', countInEventCount: 4, countInBeatsPerBar: 4
    }
    const h = seamHarness((generation) => {
      const armed = seam !== null && seam.as === generation
      return playing(generation, {
        ...current,
        transportGeneration: armed ? seam!.from : generation,
        swapPendingGeneration: armed ? seam!.from : '0'
      })
    })
    expect(await h.client.prepareAndStart(countInRequest(0))).toBe(true)
    // A route change: the forced rebuild.
    h.calls.length = 0
    await h.client.reconfigure({}, { force: true })
    expect(h.calls).toEqual(['stop:1', 'unload:1', 'prepare:2', 'open:2', 'start:2'])
    expect(h.prepared[1]).not.toHaveProperty('preparedStartProjectFrame')
    expect(h.prepared[1].initialTransport).toEqual({ state: 'playing' })
    expect(h.client.countInHeard()).toMatchObject({ landingSeconds: 0, total: 4 })
    // The click turned on is a seam that never lands; the change behind it
    // is the rebuild, and the same shape.
    seam = { as: '3', from: '2' }
    await h.client.reconfigure({ metronome: { ...countInRequest(0).metronome, click: true } })
    expect(h.client.status).toMatchObject({ generation: '3', transportGeneration: '2' })
    h.calls.length = 0
    const next = h.client.reconfigure({ playbackRate: 1.1 })
    await vi.advanceTimersByTimeAsync(SEAM_LANDING_WAIT_MS + 100)
    await next
    expect(h.calls).toEqual(['stop:3', 'unload:3', 'prepare:4', 'open:4', 'start:4'])
    expect(h.prepared[3]).not.toHaveProperty('preparedStartProjectFrame')
    expect(h.prepared[3].initialTransport).toEqual({ state: 'playing' })
    expect(h.client.countInHeard()).toMatchObject({ landingSeconds: 0, total: 4 })
    await h.client.unload()
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

  it('adopts a running core rather than commanding it, but never adopts across a pause it has issued', () => {
    // performPlay's guard, read from the source the way the sibling test
    // above reads the completion rule: the snapshot alone lags a queued
    // pause, so the facade's intent-aware `transportParked` has to agree.
    const source = readFileSync('src/renderer/src/audio/engine.ts', 'utf8')
    const play = source.indexOf('private async performPlay(')
    expect(play).toBeGreaterThan(-1)
    const guard = source.indexOf('const live = this.nativePlayback.status?.transportState', play)
    const resume = source.indexOf('await this.nativePlayback.resume()', play)
    expect(guard).toBeGreaterThan(play)
    expect(guard).toBeLessThan(resume)
    expect(source.slice(guard, resume)).toContain('!this.nativePlayback.transportParked')
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
