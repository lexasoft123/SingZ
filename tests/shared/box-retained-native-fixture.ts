import type { BoxRetainedPlaybackRecovery, BoxRetainedPlaybackRestore } from '../../src/shared/box-contract'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CODEC_NATIVE_TAG,
  DESKTOP_PLAYBACK_CONTRACT_VERSION,
  type DesktopPlaybackStatus,
  type LyricLine,
  type ProjectInfo,
  type ProjectListItem
} from '../../src/shared/types'

export function retainedStatus(
  generation = '7',
  transportState: DesktopPlaybackStatus['transportState'] = 'playing',
  overrides: Partial<DesktopPlaybackStatus> = {}
): DesktopPlaybackStatus {
  const status: DesktopPlaybackStatus = {
    capability: DESKTOP_PLAYBACK_CAPABILITY,
    generation,
    state: 'running',
    hostState: 'running',
    terminalReason: 'none',
    terminalOrdinal: '0',
    transportGeneration: generation,
    transportState,
    transportTelemetryQuality: 'current',
    lastTransportBoundary: 'start',
    renderedProjectFrame: '96000',
    audibleProjectFrame: '96000',
    audibleProjectionQuality: 'current',
    continuousFrame: '96000',
    durationFrames: '480000',
    remainingPreRollFrames: '0',
    cueEventsCompleted: 0,
    nextCueEventIndex: 0,
    presentationLatencyFrames: '0',
    graphLatencyFrames: '0',
    devicePresentationLatencyFrames: '0',
    totalPresentationLatencyFrames: '0',
    renderedFrames: '96000',
    audibleFrames: '96000',
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
    playbackRate: 1.25,
    transposeSemitones: 2,
    timePitchAnchorsPrepared: '1',
    timePitchAnchorsPublished: '1',
    timePitchAnchorMisses: '0',
    timePitchReplacementReady: true,
    timePitchLoopPriming: false,
    preparedStartProjectFrame: '96000',
    retainedBytes: '1024',
    graphArenaBytes: '512',
    parkedLaneBytes: '0',
    parkedLaneCount: 0,
    swapPendingGeneration: '0',
    retiringSwapGeneration: '0',
    swapLandings: 0,
    swapLateLandings: 0,
    swapPrimeNs: '0',
    swapLandingFrames: '0',
    masterGain: 0.4,
    referenceGain: 1,
    trainingEnabled: false,
    trainingLanes: [],
    preRollFrames: '0',
    cueEventCount: 0,
    countInEventCount: 0,
    countInBeatsPerBar: 4,
    previewClicksEnqueued: '0',
    previewClicksStarted: '0',
    previewClicksCompleted: '0',
    previewClicksPending: 0,
    laneDecodeFallback: '',
    topology: 'source→mix→output',
    graphNodeCount: 2,
    graphConnectionCount: 1,
    latencyCompensatedEdgeCount: 0,
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
    format: {
      sampleRate: 48000,
      maximumFrames: 4096,
      nominalBufferFrames: 256,
      inputChannels: 0,
      outputChannels: 2
    },
    latency: { inputDeviceFrames: 0, outputDeviceFrames: 0, bufferFrames: 256, externalRouteFrames: 0 },
    lanes: [{
      id: 'vocals', cursorFrames: '96000', totalFrames: '480000', gain: 0.35,
      muted: true, solo: false, streamed: true, starvedBlocks: '0'
    }],
    mediaCodecTag: DESKTOP_PLAYBACK_CODEC_NATIVE_TAG
  }
  return { ...status, ...overrides }
}

export function retainedRecovery(status = retainedStatus()): BoxRetainedPlaybackRecovery {
  return {
    generation: status.generation,
    descriptor: {
      version: 1,
      project: {
        dir: '/song', songPath: '/song/original.wav', name: 'Song',
        metadataHash: `sha256:${'a'.repeat(64)}`,
        lyricsHash: `sha256:${'b'.repeat(64)}`,
        graphHash: null,
        media: [{ id: 'vocals', path: '/song/vocals.flac', size: '1', mtimeMs: 1 }]
      },
      config: {
        capability: DESKTOP_PLAYBACK_CAPABILITY,
        provider: 'alsa', accessMode: 'exclusive', outputDeviceUid: 'hw:Song',
        outputChannels: [0, 1], sampleRate: 48000, bufferFrames: 256, maximumFrames: 4096,
        masterGain: 0.9,
        playback: {
          version: DESKTOP_PLAYBACK_CONTRACT_VERSION,
          transport: { entrySeconds: 0, durationSeconds: 10, playbackRate: 0.8, transposeSemitones: -4 },
          cues: { click: false, countInBars: 0, volume: 0.7, accent: true }
        },
        streamLanes: true
      },
      lanes: [{ id: 'vocals', path: '/song/vocals.flac', gain: 0.9, muted: false, solo: false }]
    },
    status
  }
}

export const retainedItem: ProjectListItem = {
  dir: '/song', songPath: '/song/original.wav', name: 'Song', savedAt: '',
  hasStems: true, stemCount: 1, hasLyrics: true, bytes: 1
}
export const retainedProject: ProjectInfo = {
  dir: retainedItem.dir, name: retainedItem.name, formatVersion: 2,
  settings: {
    transpose: -2, tempo: 0.8, masterVolume: 0.9,
    tracks: { vocals: { volume: 0.9, muted: false, solo: false } }
  },
  stems: { vocals: '/song/vocals.flac' }, hasLyrics: true, inLibrary: true
}
export const retainedLyrics: LyricLine[] = [
  { start: 0, end: 2, text: 'Lyric', words: [{ w: 'Lyric', s: 0, e: 2 }] }
]

export function retainedRestore(generation = '7', epoch = 'epoch'): BoxRetainedPlaybackRestore {
  return {
    epoch,
    recovery: retainedRecovery(retainedStatus(generation)),
    item: retainedItem,
    project: retainedProject,
    lyrics: retainedLyrics,
    graph: null
  }
}
