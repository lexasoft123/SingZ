import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import DspGraphVisualization from '../../src/renderer/src/components/DspGraphVisualization'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  type DesktopPlaybackGraphSnapshot,
  type DesktopPlaybackStatus
} from '../../src/shared/types'

const renderGraph = (overrides: Record<string, unknown> = {}): string => renderToStaticMarkup(
  createElement(DspGraphVisualization, {
    phase: 'idle',
    routeReady: true,
    inputLabel: 'Studio USB',
    inputChannel: 2,
    inputChannelLabel: 'IN 3 · Mic 3',
    outputLabel: 'Studio USB',
    outputChannels: [0, 1],
    outputChannelLabels: ['OUT 1 · Phones L', 'OUT 2 · Phones R'],
    gainDb: -12,
    preDb: -24,
    postDb: -18,
    plannedSampleRate: 48000,
    plannedBufferFrames: 128,
    status: null,
    ...overrides
  })
)

type SnapshotNode = DesktopPlaybackGraphSnapshot['nodes'][number]
type SnapshotConnection = DesktopPlaybackGraphSnapshot['connections'][number]

const snapshotNode = (
  id: string,
  label: string,
  kind: SnapshotNode['kind'],
  inputBusChannels: number[],
  outputBusChannels: number[],
  arrivalLatencyFrames = 0,
  intrinsicLatencyFrames = 0,
  role: SnapshotNode['role'] = 'processor'
): SnapshotNode => ({
  id,
  label,
  role,
  kind,
  typeHigh: kind === 'signalsmith-time-pitch' ? '6' : '1',
  typeLow: id,
  schemaVersion: 1,
  flags: 0,
  inputBusCount: inputBusChannels.length,
  outputBusCount: outputBusChannels.length,
  inputBusChannels,
  outputBusChannels,
  intrinsicLatencyFrames,
  arrivalLatencyFrames,
  outputLatencyFrames: arrivalLatencyFrames + intrinsicLatencyFrames
})

const snapshotConnection = (
  sourceNodeId: string,
  destinationNodeId: string,
  destinationBus: number,
  sourceOutputLatencyFrames: number,
  destinationArrivalLatencyFrames: number,
  channels = 2
): SnapshotConnection => ({
  sourceNodeId,
  sourceBus: 0,
  sourceChannels: channels,
  destinationNodeId,
  destinationBus,
  destinationChannels: channels,
  sourceOutputLatencyFrames,
  destinationArrivalLatencyFrames,
  compensationFrames: destinationArrivalLatencyFrames - sourceOutputLatencyFrames,
  latencyCompensated: destinationArrivalLatencyFrames !== sourceOutputLatencyFrames
})

const referenceSnapshot = (): DesktopPlaybackGraphSnapshot => ({
  generation: '7',
  formatVersion: 1,
  sampleRate: 48_000,
  maximumFrames: 512,
  outputLatencyFrames: 64,
  latencyCompensatedConnectionCount: 1,
  nodes: [
    snapshotNode('100', 'Snapshot vocals', 'decoded-source', [], [2]),
    snapshotNode('1300', 'Snapshot vocal training', 'scheduled-gain', [2], [2]),
    snapshotNode('1002', 'Snapshot Signalsmith', 'signalsmith-time-pitch', [2], [2], 0, 64),
    snapshotNode('1100', 'Snapshot cue source', 'scheduled-cue-source', [], [1]),
    snapshotNode('1101', 'Snapshot reference map', 'channel-map', [1], [2]),
    snapshotNode('1102', 'Snapshot reference gain', 'gain', [2], [2]),
    snapshotNode('1200', 'Snapshot output mix', 'mix', [2, 2], [2], 64),
    snapshotNode('1004', 'Snapshot limiter', 'safety-limiter', [2], [2], 64),
    snapshotNode('1005', 'Snapshot output', 'physical-output', [2], [], 64, 0, 'output')
  ],
  connections: [
    snapshotConnection('100', '1300', 0, 0, 0),
    snapshotConnection('1300', '1002', 0, 0, 0),
    snapshotConnection('1002', '1200', 0, 64, 64),
    snapshotConnection('1100', '1101', 0, 0, 0, 1),
    snapshotConnection('1101', '1102', 0, 0, 0),
    snapshotConnection('1102', '1200', 1, 0, 64),
    snapshotConnection('1200', '1004', 0, 64, 64),
    snapshotConnection('1004', '1005', 0, 64, 64)
  ]
})

const noReferenceSnapshot = (): DesktopPlaybackGraphSnapshot => {
  const graph = referenceSnapshot()
  graph.nodes = graph.nodes.filter((node) =>
    !['1100', '1101', '1102', '1200'].includes(node.id))
  graph.connections = [
    snapshotConnection('100', '1300', 0, 0, 0),
    snapshotConnection('1300', '1002', 0, 0, 0),
    snapshotConnection('1002', '1004', 0, 64, 64),
    snapshotConnection('1004', '1005', 0, 64, 64)
  ]
  graph.latencyCompensatedConnectionCount = 0
  return graph
}

const playbackStatus = (graph: DesktopPlaybackGraphSnapshot): DesktopPlaybackStatus => ({
  capability: DESKTOP_PLAYBACK_CAPABILITY,
  generation: graph.generation,
  state: 'running',
  transportState: 'playing',
  graphLatencyFrames: String(graph.outputLatencyFrames),
  graphNodeCount: graph.nodes.length,
  graphConnectionCount: graph.connections.length,
  latencyCompensatedEdgeCount: graph.latencyCompensatedConnectionCount,
  graphSnapshot: graph,
  topology: 'Invented legacy topology must not render',
  referenceGain: 1,
  masterGain: 1,
  lanes: [{ id: 'Invented legacy lane', cursorFrames: '0', totalFrames: '1', gain: 1, muted: false, solo: false }],
  format: { sampleRate: 44_100, maximumFrames: 4096, nominalBufferFrames: 128, inputChannels: 0, outputChannels: 2 },
  latency: { inputDeviceFrames: 0, outputDeviceFrames: 0, bufferFrames: 128, externalRouteFrames: 0 }
} as DesktopPlaybackStatus)

describe('DSP graph visualization', () => {
  it('renders the real native monitor modules in signal order', () => {
    const html = renderGraph()
    const labels = ['Input', 'Pre meter', 'Gain', 'Channel map', 'Limiter', 'Post meter', 'Output']
    let cursor = -1
    for (const label of labels) {
      const next = html.indexOf(`aria-label="${label}:`)
      expect(next).toBeGreaterThan(cursor)
      cursor = next
    }
    expect(html).toContain('Runtime graph')
    expect(html).toContain('IN 3')
    expect(html).toContain('OUT 1·2')
    expect(html).toContain('Mic 3')
    expect(html).toContain('Phones L')
    expect(html).toContain('Phones R')
    expect(html).toContain('−1 dB')
  })

  it('shows the planned float format and accessible pre/post meters', () => {
    const html = renderGraph()
    expect(html).toContain('48 kHz')
    expect(html).toContain('128 frames')
    expect(html).toContain('32-bit float')
    expect(html.match(/role="meter"/g)).toHaveLength(2)
    expect(html).toContain('aria-label="DSP graph pre-processing level"')
    expect(html).toContain('aria-label="DSP graph post-limiter level"')
    expect(html).toContain('-24 dBFS')
    expect(html).toContain('-18 dBFS')
  })

  it('distinguishes a running graph from a blocked route without motion dependence', () => {
    expect(renderGraph({ phase: 'active' })).toContain('dsp-graph--running')
    expect(renderGraph({ phase: 'active' })).toContain('Running')
    const blocked = renderGraph({ routeReady: false, inputLabel: undefined, outputLabel: undefined })
    expect(blocked).toContain('dsp-graph--blocked')
    expect(blocked).toContain('Route blocked')

    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(css).toContain('.dsp-graph-node.live:not(:last-child)::after')
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dsp-graph-node-meter > span/)
    expect(css).not.toMatch(/@keyframes dsp-/)
  })

  it('keeps configured devices blocked when their native graph config is invalid', () => {
    const html = renderGraph({ routeReady: false })
    expect(html).toContain('dsp-graph--blocked')
    expect(html).toContain('Route blocked')
    expect(html).toContain('IN 3')
    expect(html).toContain('OUT 1·2')
    expect(html).not.toContain('>Ready<')
  })

  it('renders every native song node and connection solely from the structured snapshot', () => {
    const graph = referenceSnapshot()
    const html = renderGraph({ playbackStatus: playbackStatus(graph) })
    for (const node of graph.nodes) {
      expect(html).toContain(node.label)
      expect(html).toContain(node.kind)
    }
    expect(html.match(/aria-label="Connection [0-9]+:/g)).toHaveLength(graph.connections.length)
    expect(html).toContain('Snapshot vocal training')
    expect(html).toContain('scheduled-gain')
    expect(html).toContain('Snapshot Signalsmith')
    expect(html).toContain('signalsmith-time-pitch')
    expect(html).toContain('Snapshot cue source')
    expect(html).toContain('Snapshot reference gain')
    expect(html).toContain('64 compensation frames')
    expect(html).toContain('0 in (none) · 1 out (1 ch)')
    expect(html).not.toContain('Invented legacy lane')
    expect(html).not.toContain('Invented legacy topology')
    expect(html).not.toContain('Metronome and count-in')
    expect(html).not.toContain('Song mixer')
  })

  it('renders a no-reference graph exactly as supplied without inventing cue or mixer nodes', () => {
    const graph = noReferenceSnapshot()
    const html = renderGraph({ playbackStatus: playbackStatus(graph) })
    expect(html.match(/aria-label="Connection [0-9]+:/g)).toHaveLength(4)
    expect(html).toContain('Snapshot vocal training')
    expect(html).toContain('Snapshot Signalsmith')
    expect(html).toContain('Snapshot limiter')
    expect(html).toContain('Snapshot output')
    expect(html).not.toContain('Snapshot cue source')
    expect(html).not.toContain('Snapshot reference map')
    expect(html).not.toContain('Snapshot reference gain')
    expect(html).not.toContain('Snapshot output mix')
  })

  it('fails closed when native playback supplies a malformed snapshot', () => {
    const graph = referenceSnapshot()
    graph.connections[5].compensationFrames = 0
    const html = renderGraph({ playbackStatus: playbackStatus(graph) })
    expect(html).toContain('Structured graph unavailable')
    expect(html).toContain('did not provide a valid bounded composition snapshot')
    expect(html).not.toContain('Snapshot Signalsmith')
    expect(html).not.toContain('Song mixer')
  })
})
