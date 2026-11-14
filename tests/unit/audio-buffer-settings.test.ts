import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AudioBufferSettings, AudioBufferResult } from '../../src/renderer/src/components/AudioBufferSettings'
import type { AudioBufferStatus } from '../../src/shared/audio-buffer'
import type { DesktopAudioHostDevice, DesktopAudioHostInventoryResult } from '../../src/shared/types'

const inventory = (minimum: number, maximum: number): DesktopAudioHostInventoryResult => ({
  ok: true, platform: 'darwin', provider: 'coreaudio', defaultInputUid: 'in', defaultOutputUid: 'out',
  devices: ['in', 'out'].map(uid => ({ uid, nominalSampleRate: 48000,
    bufferFrames: { minimumFrames: minimum, maximumFrames: maximum, preferredFrames: 512, fundamentalFrames: 1 }
  } as DesktopAudioHostDevice))
})
describe('audio buffer settings control', () => {
  const applied: AudioBufferStatus = { ok: true, pending: false, preferences: { out: 64 }, outputUid: 'out',
    requestedFrames: 64, obtainedFrames: 64, inputUid: 'in', inputRequestedFrames: 64, inputObtainedFrames: 64 }
  it('shows immediate requested/obtained telemetry without a stop notice for normal active owners', () => {
    const html = renderToStaticMarkup(createElement(AudioBufferResult, { status: applied }))
    expect(html).toContain('Output: requested 64, obtained 64 frames')
    expect(html).toContain('Input: requested 64, obtained 64 frames')
    expect(html).not.toContain('Saved.')
  })
  it('shows the pending notice only for a recording take', () => {
    const html = renderToStaticMarkup(createElement(AudioBufferResult, { status: { ...applied, pending: true, reason: 'take-recording' } }))
    expect(html).toContain('as soon as this take recording stops')
    expect(html).not.toContain('playback, monitoring')
  })
  it('shows a rollback error with the restored obtained size', () => {
    const html = renderToStaticMarkup(createElement(AudioBufferResult, { status: { ...applied, ok: false, error: 'Injected input failure' } }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('Injected input failure')
    expect(html).not.toContain('Saved.')
  })
  it('renders one select with the supported choices, the 128 default and the CPU hint', () => {
    const html = renderToStaticMarkup(createElement(AudioBufferSettings, { inventory: inventory(64, 256) }))
    expect(html.match(/<select/g)).toHaveLength(1)
    expect(html).toContain('<option value="128" selected="">128 frames · 2.67 ms</option>')
    expect(html).toContain('64 frames · 1.33 ms')
    expect(html).toContain('256 frames · 5.33 ms')
    expect(html).not.toContain('value="32"')
    expect(html).toContain('use more CPU')
  })
  it('keeps the default visible as unavailable when device metadata cannot support it', () => {
    const html = renderToStaticMarkup(createElement(AudioBufferSettings, { inventory: inventory(256, 512) }))
    expect(html).toContain('128 frames (saved, unavailable)')
    expect(html).toMatch(/<option value="128" disabled="" selected="">/)
  })
})
