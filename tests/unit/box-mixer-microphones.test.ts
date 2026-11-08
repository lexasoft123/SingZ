import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { setLocale } from '../../src/shared/i18n/core'
import { Mixer, MixerMicrophoneRow } from '../../src/renderer/src/box/Mixer'
import type { MicrophoneSnapshot } from '../../src/renderer/src/box/microphones'

function snapshot(): MicrophoneSnapshot {
  return { phase: 'running', capability: 'available', devices: [], inventoryError: null, error: null,
    selection: { uid: 'alsa:flow8', channel: 7 },
    active: { uid: 'alsa:flow8', channel: 7, channels: 10, generation: '11', label: 'FLOW 8' },
    levels: { generation: '11', receivedAt: Date.now(), peak: [0.25, 0.5, ...Array(8).fill(0.9)], rms: Array(10).fill(0.1) }, pitch: null }
}
const row = (value: MicrophoneSnapshot | undefined, id: 'mic1' | 'mic2' = 'mic1'): string => renderToStaticMarkup(createElement(MixerMicrophoneRow, { id, snapshot: value }))
beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(1000); await prepareBoxLocale('en') })
afterEach(() => { vi.useRealTimers(); setLocale('en') })

describe('mixer private microphone input observation', () => {
  it('wires the same snapshot through the full mixer to physical channels0/1, not the selected pitch channel', () => {
    const noop = vi.fn()
    const html = renderToStaticMarkup(createElement(Mixer, { microphoneSnapshot: snapshot(), tab: 'main', tracks: [], masterVolume: 1, playing: true, canPlay: true,
      onTab: noop, onVolume: noop, onMuted: noop, onSolo: noop, onMasterVolume: noop, onToggle: noop, onClose: noop }))
    expect(html).toContain('data-mix-meter="mic1"'); expect(html).toContain('data-mix-meter="mic2"')
    expect(html).toContain('aria-valuenow="0.25"'); expect(html).toContain('aria-valuenow="0.5"')
    expect(html).not.toContain('aria-valuenow="0.9"')
    expect(noop).not.toHaveBeenCalled()
  })
  it('keeps mic gain/mute/solo unavailable while clearly labeling real analysis input levels', () => {
    const html = row(snapshot())
    expect(html).toContain('role="meter"'); expect(html).toContain('-12.0 dBFS')
    expect(html).toContain('Hardware monitoring'); expect(html).toContain('On the mixer'); expect(html).toContain('Analysis input level')
    expect(html).not.toContain('<input'); expect(html).not.toContain('<button'); expect(html).not.toContain('No meter available')
  })
  it.each(['absent', 'stale', 'generation', 'starting', 'invalid-level'] as const)('shows unavailable instead of fabricated silence for %s', bad => {
    const value = snapshot()
    if (bad === 'absent') value.levels = null
    if (bad === 'stale') value.levels!.receivedAt = Date.now() - 1000
    if (bad === 'generation') value.levels!.generation = '9'
    if (bad === 'starting') value.phase = 'starting'
    if (bad === 'invalid-level') value.levels!.peak[0] = Number.NaN
    const html = row(value)
    expect(html).not.toContain('role="meter"'); expect(html).toContain('Unavailable'); expect(html).toContain('No meter available')
  })
  it('shows one valid input only for a mono device, and treats measured zero as real silence', () => {
    const value = snapshot(); value.active!.channels = 1; value.levels!.peak = [0]; value.levels!.rms = [0]
    expect(row(value)).toContain('aria-valuenow="0"'); expect(row(value)).toContain('−∞ dBFS')
    expect(row(value, 'mic2')).not.toContain('role="meter"')
    expect(row(undefined)).not.toContain('role="meter"')
  })
  it.each([['ru', 'Аппаратный мониторинг', 'На микшере', 'Уровень входа для анализа'], ['zh-CN', '硬件监听', '请在调音台调整', '分析输入电平']] as const)('localizes observation versus hardware controls in %s', async (locale, body, hardware, input) => {
    await prepareBoxLocale(locale)
    const html = row(snapshot())
    expect(html).toContain(body); expect(html).toContain(hardware); expect(html).toContain(input)
    expect(html).not.toContain('Analysis input level')
  })
})
