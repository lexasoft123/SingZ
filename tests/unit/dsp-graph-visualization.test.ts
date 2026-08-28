import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import DspGraphVisualization from '../../src/renderer/src/components/DspGraphVisualization'

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
})
