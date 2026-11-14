import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AudioBufferSettings } from '../../src/renderer/src/components/AudioBufferSettings'
import type { DesktopAudioHostDevice, DesktopAudioHostInventoryResult } from '../../src/shared/types'

const inventory = (minimum: number, maximum: number): DesktopAudioHostInventoryResult => ({
  ok: true, platform: 'darwin', provider: 'coreaudio', defaultInputUid: 'in', defaultOutputUid: 'out',
  devices: ['in', 'out'].map(uid => ({ uid, nominalSampleRate: 48000,
    bufferFrames: { minimumFrames: minimum, maximumFrames: maximum, preferredFrames: 512, fundamentalFrames: 1 }
  } as DesktopAudioHostDevice))
})
describe('audio buffer settings control', () => {
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
