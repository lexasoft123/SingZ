import React from 'react'
import {
  DESKTOP_PLAYBACK_GRAPH_MAX_BUSES,
  DESKTOP_PLAYBACK_GRAPH_MAX_CONNECTIONS,
  DESKTOP_PLAYBACK_GRAPH_MAX_NODES,
  type DesktopMonitorStatus,
  type DesktopPlaybackGraphNodeKind,
  type DesktopPlaybackGraphNodeRole,
  type DesktopPlaybackGraphSnapshot,
  type DesktopPlaybackStatus
} from '../../../shared/types'
import type { MonitorCoordinatorSnapshot } from '../audio/monitoring'
import { t, type Key } from '../i18n'

interface DspGraphVisualizationProps {
  phase: MonitorCoordinatorSnapshot['phase']
  routeReady: boolean
  inputLabel?: string
  inputChannel?: number
  inputChannelLabel?: string
  outputLabel?: string
  outputChannels: number[]
  outputChannelLabels: string[]
  gainDb: number
  preDb: number
  postDb: number
  plannedSampleRate?: number
  plannedBufferFrames?: number
  status: DesktopMonitorStatus | null
  playbackStatus?: DesktopPlaybackStatus | null
}

interface GraphNodeProps {
  as?: 'li' | 'div'
  kind: string
  name: string
  faceName?: string
  value: string
  detail: string
  configured: boolean
  live: boolean
  meter?: { label: string; db: number }
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value))

const meterWidth = (db: number): number => clamp(((db + 72) / 72) * 100, 0, 100)

const formatDb = (db: number): string => db <= -72 ? '−∞ dBFS' : `${Math.round(db)} dBFS`

const formatSampleRate = (sampleRate: number | undefined): string => {
  if (!sampleRate) return t('player.dspGraph.floatNativePath')
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

function GraphNode({ as = 'li', kind, name, faceName, value, detail, configured, live, meter }: GraphNodeProps): React.JSX.Element {
  const Element = as
  return (
    <Element
      className={`dsp-graph-node${configured ? ' configured' : ''}${live ? ' live' : ''}`}
      aria-label={`${name}: ${value}. ${detail}`}
    >
      <span className="dsp-graph-node-kind">{kind}</span>
      <strong title={name}>{faceName ?? name}</strong>
      <span className="dsp-graph-node-value" title={value}>{value}</span>
      {meter ? (
        <div
          className="dsp-graph-node-meter"
          role="meter"
          aria-label={meter.label}
          aria-valuemin={-72}
          aria-valuemax={0}
          aria-valuenow={Math.round(meter.db)}
          aria-valuetext={formatDb(meter.db)}
        >
          <span style={{ width: `${meterWidth(meter.db)}%` }} />
          <output>{formatDb(meter.db)}</output>
        </div>
      ) : (
        <small title={detail}>{detail}</small>
      )}
    </Element>
  )
}

const graphNodeRoles = new Set<DesktopPlaybackGraphNodeRole>(['input', 'processor', 'output'])
const graphNodeKinds = new Set<DesktopPlaybackGraphNodeKind>([
  'unknown',
  'physical-output',
  'decoded-source',
  'channel-map',
  'gain',
  'mix',
  'scheduled-gain',
  'signalsmith-time-pitch',
  'scheduled-cue-source',
  'peak-rms',
  'tap',
  'oscillator',
  'safety-limiter',
  'unavailable-bypass',
  'unavailable-silence'
])
const decimalU64 = /^(?:0|[1-9][0-9]*)$/
const maximumU64 = (1n << 64n) - 1n

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isUint32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff

const isPositiveUint32 = (value: unknown): value is number => isUint32(value) && value > 0

const isDecimalU64 = (value: unknown, allowZero = true): value is string => {
  if (typeof value !== 'string' || !decimalU64.test(value) || (!allowZero && value === '0')) return false
  return BigInt(value) <= maximumU64
}

const boundedBusChannels = (value: unknown, count: number): value is number[] =>
  Array.isArray(value) && value.length === count &&
  value.every((channels) => isPositiveUint32(channels))

function validatedPlaybackGraph(status: DesktopPlaybackStatus): DesktopPlaybackGraphSnapshot | null {
  const value: unknown = status.graphSnapshot
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.connections) ||
      !isDecimalU64(value.generation) || value.generation !== status.generation ||
      !isPositiveUint32(value.formatVersion) ||
      typeof value.sampleRate !== 'number' || !Number.isFinite(value.sampleRate) || value.sampleRate <= 0 ||
      !isPositiveUint32(value.maximumFrames) || !isUint32(value.outputLatencyFrames) ||
      !isUint32(value.latencyCompensatedConnectionCount) ||
      value.nodes.length < 1 || value.nodes.length > DESKTOP_PLAYBACK_GRAPH_MAX_NODES ||
      value.connections.length > DESKTOP_PLAYBACK_GRAPH_MAX_CONNECTIONS ||
      value.nodes.length !== status.graphNodeCount ||
      value.connections.length !== status.graphConnectionCount ||
      value.latencyCompensatedConnectionCount !== status.latencyCompensatedEdgeCount ||
      String(value.outputLatencyFrames) !== status.graphLatencyFrames) return null

  const nodes = new Map<string, Record<string, unknown>>()
  for (const node of value.nodes) {
    if (!isRecord(node) || !isDecimalU64(node.id, false) || nodes.has(node.id) ||
        typeof node.label !== 'string' || node.label.length < 1 || node.label.length > 256 ||
        typeof node.role !== 'string' || !graphNodeRoles.has(node.role as DesktopPlaybackGraphNodeRole) ||
        typeof node.kind !== 'string' || !graphNodeKinds.has(node.kind as DesktopPlaybackGraphNodeKind) ||
        !isDecimalU64(node.typeHigh) || !isDecimalU64(node.typeLow) ||
        !isUint32(node.schemaVersion) || !isUint32(node.flags) ||
        !isUint32(node.inputBusCount) || node.inputBusCount > DESKTOP_PLAYBACK_GRAPH_MAX_BUSES ||
        !isUint32(node.outputBusCount) || node.outputBusCount > DESKTOP_PLAYBACK_GRAPH_MAX_BUSES ||
        !boundedBusChannels(node.inputBusChannels, node.inputBusCount) ||
        !boundedBusChannels(node.outputBusChannels, node.outputBusCount) ||
        !isUint32(node.intrinsicLatencyFrames) || !isUint32(node.arrivalLatencyFrames) ||
        !isUint32(node.outputLatencyFrames) ||
        node.arrivalLatencyFrames + node.intrinsicLatencyFrames !== node.outputLatencyFrames) return null
    nodes.set(node.id, node)
  }

  const inputBusTotal = [...nodes.values()].reduce(
    (total, node) => total + (node.inputBusCount as number), 0)
  if (inputBusTotal !== value.connections.length) return null
  let compensated = 0
  const destinations = new Set<string>()
  for (const connection of value.connections) {
    if (!isRecord(connection) || !isDecimalU64(connection.sourceNodeId, false) ||
        !isDecimalU64(connection.destinationNodeId, false) ||
        !isUint32(connection.sourceBus) || !isPositiveUint32(connection.sourceChannels) ||
        !isUint32(connection.destinationBus) || !isPositiveUint32(connection.destinationChannels) ||
        !isUint32(connection.sourceOutputLatencyFrames) ||
        !isUint32(connection.destinationArrivalLatencyFrames) ||
        !isUint32(connection.compensationFrames) || typeof connection.latencyCompensated !== 'boolean') return null
    const source = nodes.get(connection.sourceNodeId)
    const destination = nodes.get(connection.destinationNodeId)
    const destinationKey = `${connection.destinationNodeId}:${connection.destinationBus}`
    if (!source || !destination || connection.sourceBus >= (source.outputBusCount as number) ||
        destinations.has(destinationKey) ||
        connection.destinationBus >= (destination.inputBusCount as number) ||
        connection.sourceChannels !== (source.outputBusChannels as number[])[connection.sourceBus] ||
        connection.destinationChannels !== (destination.inputBusChannels as number[])[connection.destinationBus] ||
        connection.sourceChannels !== connection.destinationChannels ||
        connection.sourceOutputLatencyFrames !== source.outputLatencyFrames ||
        connection.destinationArrivalLatencyFrames < connection.sourceOutputLatencyFrames ||
        connection.compensationFrames !==
          connection.destinationArrivalLatencyFrames - connection.sourceOutputLatencyFrames ||
        connection.latencyCompensated !== (connection.compensationFrames !== 0)) return null
    const expectedArrival = destination.role === 'output'
      ? value.outputLatencyFrames
      : destination.arrivalLatencyFrames
    if (connection.destinationArrivalLatencyFrames !== expectedArrival) return null
    destinations.add(destinationKey)
    if (connection.latencyCompensated) compensated += 1
  }
  if (compensated !== value.latencyCompensatedConnectionCount) return null
  return value as unknown as DesktopPlaybackGraphSnapshot
}

const busFact = (channels: number[]): string =>
  channels.length ? channels.map((count) => `${count} ch`).join(' · ') : 'none'

function graphState(
  phase: MonitorCoordinatorSnapshot['phase'],
  routeReady: boolean,
  configured: boolean
): { className: string; label: string } {
  if (phase === 'active') return { className: 'running', label: t('player.dspGraph.stateRunning') }
  if (phase === 'preparing' || phase === 'starting' || phase === 'stopping') {
    return { className: 'changing', label: t('player.dspGraph.stateChangingRoute') }
  }
  if (phase === 'error') return { className: 'fault', label: t('player.dspGraph.stateFault') }
  if (routeReady && configured) return { className: 'ready', label: t('player.dspGraph.stateReady') }
  return { className: 'blocked', label: t('player.dspGraph.stateBlocked') }
}

export default function DspGraphVisualization({
  phase,
  routeReady,
  inputLabel,
  inputChannel,
  inputChannelLabel,
  outputLabel,
  outputChannels,
  outputChannelLabels,
  gainDb,
  preDb,
  postDb,
  plannedSampleRate,
  plannedBufferFrames,
  status,
  playbackStatus
}: DspGraphVisualizationProps): React.JSX.Element {
  const playbackLive = Boolean(playbackStatus && playbackStatus.generation !== '0' && playbackStatus.state !== 'unloaded')
  if (playbackLive && playbackStatus) {
    const live = playbackStatus.state === 'running'
    const stateClass = playbackStatus.state === 'terminal' || playbackStatus.state === 'quarantined'
      ? 'fault'
      : live ? 'running' : 'changing'
    const graph = validatedPlaybackGraph(playbackStatus)
    const labels = new Map(graph?.nodes.map((node) => [node.id, node.label]) ?? [])
    return (
      <section className={`dsp-graph dsp-graph--playback dsp-graph--${stateClass}`} aria-labelledby="dsp-graph-heading">
        <header className="dsp-graph-header">
          <div>
            <span>{t('player.dspGraph.runtimeGraph')}</span>
            <h4 id="dsp-graph-heading">{t('player.dspGraph.songAndReference')}</h4>
          </div>
          <div className="dsp-graph-format">
            {graph ? (
              <>
                <span>{formatSampleRate(graph.sampleRate)}</span>
                <span>{t('player.dspGraph.framesMaximum', { n: graph.maximumFrames })}</span>
                <span>{t('player.dspGraph.nodesLinks', { nodes: graph.nodes.length, links: graph.connections.length })}</span>
              </>
            ) : <span>{t('player.dspGraph.structuredUnavailable')}</span>}
          </div>
          <output className="dsp-graph-state" aria-live="polite">
            <i aria-hidden="true" />{t(`player.dspGraph.transport.${playbackStatus.transportState}` as Key)}
          </output>
        </header>
        {graph ? (
          <div className="dsp-graph-viewport" role="region" aria-label={t('player.dspGraph.activeModulesAriaLabel')} tabIndex={0}>
            <ol
              className="dsp-graph-flow"
              style={{ gridTemplateColumns: `repeat(${graph.nodes.length}, minmax(104px, 1fr))`, minWidth: `${graph.nodes.length * 114}px` }}
            >
              {graph.nodes.map((node) => (
                <li key={node.id}>
                  <GraphNode
                    as="div"
                    kind={node.kind}
                    name={node.label}
                    value={`${node.inputBusCount} in (${busFact(node.inputBusChannels)}) · ${node.outputBusCount} out (${busFact(node.outputBusChannels)})`}
                    detail={`${node.role} · type ${node.typeHigh}:${node.typeLow} v${node.schemaVersion} · latency ${node.arrivalLatencyFrames} + ${node.intrinsicLatencyFrames} = ${node.outputLatencyFrames} frames`}
                    configured
                    live={live}
                  />
                </li>
              ))}
            </ol>
            <div className="monitor-diagnostics" aria-label={t('player.dspGraph.activeConnectionsAriaLabel')}>
              {graph.connections.map((connection, index) => (
                <div
                  className="monitor-diagnostic-row"
                  key={`${connection.sourceNodeId}:${connection.sourceBus}-${connection.destinationNodeId}:${connection.destinationBus}`}
                  aria-label={`Connection ${index + 1}: ${labels.get(connection.sourceNodeId)} to ${labels.get(connection.destinationNodeId)}`}
                >
                  <strong>
                    {labels.get(connection.sourceNodeId)} OUT {connection.sourceBus + 1} ({connection.sourceChannels} ch)
                    {' → '}
                    {labels.get(connection.destinationNodeId)} IN {connection.destinationBus + 1} ({connection.destinationChannels} ch)
                  </strong>
                  <span>
                    {connection.sourceOutputLatencyFrames} → {connection.destinationArrivalLatencyFrames} frames
                    {' · '}{connection.compensationFrames} compensation frame{connection.compensationFrames === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="monitor-route-status warn" role="status">
            {t('player.dspGraph.unavailableExplain')}
          </p>
        )}
      </section>
    )
  }
  const configured = Boolean(inputLabel && outputLabel && inputChannel !== undefined && outputChannels.length)
  const live = phase === 'active'
  const state = graphState(phase, routeReady, configured)
  const sampleRate = status?.format.sampleRate || plannedSampleRate
  const bufferFrames = status?.latency.bufferFrames || plannedBufferFrames
  const inputValue = inputChannel === undefined ? 'IN —' : `IN ${inputChannel + 1}`
  const outputValue = outputChannels.length
    ? `OUT ${outputChannels.map((channel) => channel + 1).join('·')}`
    : 'OUT —'
  const mapValue = inputChannel === undefined || !outputChannels.length
    ? '— → —'
    : `1→${outputChannels.length}`

  return (
    <section className={`dsp-graph dsp-graph--${state.className}`} aria-labelledby="dsp-graph-heading">
      <header className="dsp-graph-header">
        <div>
          <span>{t('player.dspGraph.runtimeGraph')}</span>
          <h4 id="dsp-graph-heading">{t('player.dspGraph.monitorChain')}</h4>
        </div>
        <div className="dsp-graph-format">
          <span>{formatSampleRate(sampleRate)}</span>
          {bufferFrames ? <span>{bufferFrames} frames</span> : <span>{t('player.dspGraph.bufferPending')}</span>}
          <span>32-bit float</span>
        </div>
        <output className="dsp-graph-state" aria-live="polite">
          <i aria-hidden="true" />{state.label}
        </output>
      </header>

      <div className="dsp-graph-viewport" role="region" aria-label={t('player.dspGraph.modulesAriaLabel')} tabIndex={0}>
        <ol className="dsp-graph-flow">
          <GraphNode
            kind={t('player.dspGraph.deviceKind')}
            name={t('player.dspGraph.input')}
            value={inputValue}
            detail={inputChannelLabel ?? inputLabel ?? t('player.dspGraph.chooseInput')}
            configured={Boolean(inputLabel)}
            live={live}
          />
          <GraphNode
            kind={t('player.dspGraph.analyzerKind')}
            name={t('player.dspGraph.preMeter')}
            faceName={t('player.dspGraph.preFace')}
            value="RMS"
            detail={t('player.dspGraph.beforeProcessing')}
            configured={configured}
            live={live}
            meter={{ label: t('player.dspGraph.preLevelLabel'), db: preDb }}
          />
          <GraphNode
            kind={t('player.dspGraph.processorKind')}
            name={t('player.dspGraph.gain')}
            value={`${gainDb}`}
            detail="dB · ramped"
            configured={configured}
            live={live}
          />
          <GraphNode
            kind={t('player.dspGraph.routerKind')}
            name={t('player.dspGraph.channelMap')}
            faceName={t('player.dspGraph.mapFace')}
            value={mapValue}
            detail={`${inputChannelLabel ?? inputValue} to ${outputChannelLabels.join(' · ') || outputValue}`}
            configured={configured}
            live={live}
          />
          <GraphNode
            kind={t('player.dspGraph.processorKind')}
            name={t('player.dspGraph.limiter')}
            faceName={t('player.dspGraph.limitFace')}
            value="−1 dB"
            detail="Output ceiling · dBFS"
            configured={configured}
            live={live}
          />
          <GraphNode
            kind={t('player.dspGraph.analyzerKind')}
            name={t('player.dspGraph.postMeter')}
            faceName={t('player.dspGraph.postFace')}
            value="RMS"
            detail={t('player.dspGraph.afterLimiter')}
            configured={configured}
            live={live}
            meter={{ label: t('player.dspGraph.postLevelLabel'), db: postDb }}
          />
          <GraphNode
            kind={t('player.dspGraph.deviceKind')}
            name={t('player.dspGraph.output')}
            value={outputValue}
            detail={outputChannelLabels.join(' · ') || outputLabel || t('player.dspGraph.chooseOutput')}
            configured={Boolean(outputLabel)}
            live={live}
          />
        </ol>
      </div>
    </section>
  )
}
