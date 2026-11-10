import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Mixer } from '../../src/renderer/src/box/Mixer'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'

function render(master: number, stem = 1) {
  const onMasterVolume = vi.fn(), onVolume = vi.fn(), noop = vi.fn()
  const html = renderToStaticMarkup(createElement(Mixer, { tab: 'main', tracks: [{ id: 'vocals', volume: stem, muted: false, solo: false }],
    masterVolume: master, playing: false, canPlay: true, onMasterVolume, onVolume,
    onMuted: noop, onSolo: noop, onTab: noop, onToggle: noop, onClose: noop }))
  return { html, onMasterVolume, onVolume }
}
function range(html: string, id: string) {
  const tag = html.match(new RegExp(`<input(?=[^>]*data-mix-level="${id}")[^>]*>`))?.[0]
  if (!tag) throw new Error(`Missing rendered range ${id}`)
  const attribute = (name: string): string => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? ''
  return { min: Number(attribute('min')), max: Number(attribute('max')), step: Number(attribute('step')), value: Number(attribute('value')), aria: attribute('aria-valuetext') }
}
function validStep(input: ReturnType<typeof range>): void {
  expect(input.step).toBe(1)
  expect(input.value).toBeGreaterThanOrEqual(input.min)
  expect(input.value).toBeLessThanOrEqual(input.max)
  expect(Number.isInteger((input.value - input.min) / input.step)).toBe(true)
}
beforeEach(async () => { await prepareBoxLocale('en') })

describe('rendered Box mixer dB ranges', () => {
  it('keeps every gain-to-dB round trip on the actual one-dB HTML step grid', () => {
    for (let db = -60; db <= 12; db++) {
      const gain = 10 ** (db / 20)
      const view = render(gain, gain)
      const master = range(view.html, 'master'), stem = range(view.html, 'vocals')
      validStep(master); validStep(stem)
      expect(master.value).toBe(db)
      expect(stem.value).toBe(Math.min(0, db))
      expect(view.onMasterVolume).not.toHaveBeenCalled(); expect(view.onVolume).not.toHaveBeenCalled()
    }
  })
  it('renders the problematic minus-six round trip as exactly minus-six', () => {
    const gain = 10 ** (-6 / 20)
    expect(20 * Math.log10(gain)).toBeLessThan(-6)
    const view = render(gain)
    expect(range(view.html, 'master').value).toBe(-6)
    validStep(range(view.html, 'master'))
  })
  it.each([[-4.5, '-4.5 dB'], [-6.5, '-6.5 dB'], [-12.3, '-12.3 dB'], [3.7, '+3.7 dB']] as const)('quantizes the thumb but preserves saved %sdB until user edit', (db, readout) => {
    const view = render(10 ** (db / 20))
    const input = range(view.html, 'master')
    validStep(input); expect(input.value).toBe(Math.round(db))
    expect(input.aria).toBe(readout)
    expect(view.html).toContain(`<output>${readout}</output>`)
    expect(view.onMasterVolume).not.toHaveBeenCalled()
  })
  it('clamps the master to+12, stem to0 and lower values to-60 while preserving the actual readout', () => {
    const high = render(10 ** (24 / 20), 10 ** (6 / 20))
    expect(range(high.html, 'master')).toMatchObject({ min: -60, max: 12, value: 12, aria: '+24.0 dB' })
    expect(range(high.html, 'vocals')).toMatchObject({ min: -60, max: 0, value: 0, aria: '+6.0 dB' })
    const low = render(0, 1e-8)
    expect(range(low.html, 'master')).toMatchObject({ value: -60, aria: '−∞ dB' })
    expect(range(low.html, 'vocals')).toMatchObject({ value: -60, aria: '-160.0 dB' })
    validStep(range(low.html, 'master')); validStep(range(low.html, 'vocals'))
  })
})
