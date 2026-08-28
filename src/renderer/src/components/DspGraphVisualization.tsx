import React from 'react'
import type { DesktopMonitorStatus } from '../../../shared/types'
import type { MonitorCoordinatorSnapshot } from '../audio/monitoring'

interface DspGraphVisualizationProps {
  phase: MonitorCoordinatorSnapshot['phase']
  routeReady: boolean
  inputLabel?: string
  inputChannel?: number
  outputLabel?: string
  outputChannels: number[]
  gainDb: number
  preDb: number
  postDb: number
  plannedSampleRate?: number
  plannedBufferFrames?: number
  status: DesktopMonitorStatus | null
}

interface GraphNodeProps {
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
  if (!sampleRate) return 'Float32 native path'
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`
}

function GraphNode({ kind, name, faceName, value, detail, configured, live, meter }: GraphNodeProps): React.JSX.Element {
  return (
    <li
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
    </li>
  )
}

function graphState(
  phase: MonitorCoordinatorSnapshot['phase'],
  routeReady: boolean,
  configured: boolean
): { className: string; label: string } {
  if (phase === 'active') return { className: 'running', label: 'Running' }
  if (phase === 'preparing' || phase === 'starting' || phase === 'stopping') {
    return { className: 'changing', label: 'Changing route' }
  }
  if (phase === 'error') return { className: 'fault', label: 'Stopped with an error' }
  if (routeReady && configured) return { className: 'ready', label: 'Ready' }
  return { className: 'blocked', label: 'Route blocked' }
}

export default function DspGraphVisualization({
  phase,
  routeReady,
  inputLabel,
  inputChannel,
  outputLabel,
  outputChannels,
  gainDb,
  preDb,
  postDb,
  plannedSampleRate,
  plannedBufferFrames,
  status
}: DspGraphVisualizationProps): React.JSX.Element {
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
          <span>Runtime graph</span>
          <h4 id="dsp-graph-heading">Native monitor chain</h4>
        </div>
        <div className="dsp-graph-format">
          <span>{formatSampleRate(sampleRate)}</span>
          {bufferFrames ? <span>{bufferFrames} frames</span> : <span>Buffer pending</span>}
          <span>32-bit float</span>
        </div>
        <output className="dsp-graph-state" aria-live="polite">
          <i aria-hidden="true" />{state.label}
        </output>
      </header>

      <div className="dsp-graph-viewport" role="region" aria-label="DSP graph modules" tabIndex={0}>
        <ol className="dsp-graph-flow">
          <GraphNode
            kind="Device"
            name="Input"
            value={inputValue}
            detail={inputLabel ?? 'Choose an input'}
            configured={Boolean(inputLabel)}
            live={live}
          />
          <GraphNode
            kind="Analyzer"
            name="Pre meter"
            faceName="Pre"
            value="RMS"
            detail="Before processing"
            configured={configured}
            live={live}
            meter={{ label: 'DSP graph pre-processing level', db: preDb }}
          />
          <GraphNode
            kind="Processor"
            name="Gain"
            value={`${gainDb}`}
            detail="dB · ramped"
            configured={configured}
            live={live}
          />
          <GraphNode
            kind="Router"
            name="Channel map"
            faceName="Map"
            value={mapValue}
            detail={`${inputValue} to ${outputValue}`}
            configured={configured}
            live={live}
          />
          <GraphNode
            kind="Processor"
            name="Limiter"
            faceName="Limit"
            value="−1 dB"
            detail="Output ceiling · dBFS"
            configured={configured}
            live={live}
          />
          <GraphNode
            kind="Analyzer"
            name="Post meter"
            faceName="Post"
            value="RMS"
            detail="After limiter"
            configured={configured}
            live={live}
            meter={{ label: 'DSP graph post-limiter level', db: postDb }}
          />
          <GraphNode
            kind="Device"
            name="Output"
            value={outputValue}
            detail={outputLabel ?? 'Choose an output'}
            configured={Boolean(outputLabel)}
            live={live}
          />
        </ol>
      </div>
    </section>
  )
}
