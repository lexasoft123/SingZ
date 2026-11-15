import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { setLocale } from '../../src/shared/i18n/core'
import { Mixer, MixerMicrophoneRow } from '../../src/renderer/src/box/Mixer'
import type { MicrophoneSnapshot } from '../../src/renderer/src/box/microphones'

function snapshot(): MicrophoneSnapshot {
  const all = Array.from({ length: 10 }, (_, i) => i)
  return { phase: 'running', reason: '', detail: '', revision: '3', origin: 'user', epoch: 'e', device: 'alsa:flow8', pending: false, error: null,
    enabledChannelsByDevice: { 'alsa:flow8': all },
    active: { uid: 'alsa:flow8', channels: 10, generation: '11', label: 'FLOW 8', enabledChannels: all, analysisChannel: 7 },
    levels: { generation: '11', receivedAt: Date.now(), channelIndices: all, peak: [0.25, 0.5, ...Array(8).fill(0.9)], rms: Array(10).fill(0.1) }, pitch: null }
}
const row = (value: MicrophoneSnapshot | undefined, id: 'mic1' | 'mic2' = 'mic1'): string => renderToStaticMarkup(createElement(MixerMicrophoneRow, { id, snapshot: value }))
beforeEach(async () => { vi.useFakeTimers(); vi.setSystemTime(1000); await prepareBoxLocale('en') })
afterEach(() => { vi.useRealTimers(); setLocale('en') })

describe('mixer private microphone input observation', () => {
  it('wires the same snapshot through the full mixer to physical channels0/1, not the selected pitch channel', () => {
    const noop = vi.fn()
    const html = renderToStaticMarkup(createElement(Mixer, { microphoneSnapshot: snapshot(), tab: 'main', tracks: [], masterVolume: 1, playing: true, status: 'playing', canPlay: true,
      onTab: noop, onVolume: noop, onMuted: noop, onSolo: noop, onMasterVolume: noop, onToggle: noop, onClose: noop }))
    expect(html).toContain('data-mix-meter="mic1"'); expect(html).toContain('data-mix-meter="mic2"')
    expect(html).toContain('data-mic-db="-12.0"'); expect(html).toContain('data-mic-db="-6.0"')
    expect(html).not.toContain('data-mic-db="-0.9"')
    expect(noop).not.toHaveBeenCalled()
  })
  it('maps the TV microphone slots to the selected noncontiguous physical inputs', () => {
    const value = snapshot()
    value.active!.channels = 10
    value.active!.enabledChannels = [2, 7]
    value.enabledChannelsByDevice[value.active!.uid] = [2, 7]
    value.levels!.channelIndices = [2, 7]
    value.levels!.peak = [0.25, 0.5]
    value.levels!.rms = [0.1, 0.2]
    expect(row(value, 'mic1')).toContain('data-mic-db="-12.0"')
    expect(row(value, 'mic2')).toContain('data-mic-db="-6.0"')
  })
  it('keeps mic gain/mute/solo unavailable while clearly labeling real analysis input levels', () => {
    const html = row(snapshot())
    expect(html).toContain('data-mic-status="level"'); expect(html).toContain('>Singing<')
    // Plain words, not engineering text, on the TV.
    for (const jargon of ['dBFS', 'Hardware monitoring', 'On the mixer', 'Analysis input level']) expect(html).not.toContain(jargon)
    expect(html).not.toContain('<input'); expect(html).not.toContain('<button')
  })
  it.each(['absent', 'stale', 'generation', 'invalid-level', 'error'] as const)('shows unavailable instead of fabricated silence for %s', bad => {
    const value = snapshot()
    if (bad === 'absent') value.levels = null
    if (bad === 'stale') value.levels!.receivedAt = Date.now() - 1000
    if (bad === 'generation') value.levels!.generation = '9'
    if (bad === 'invalid-level') value.levels!.peak[0] = Number.NaN
    if (bad === 'error') { value.phase = 'error'; value.reason = 'internal' }
    const html = row(value)
    expect(html).not.toContain('data-mic-status="level"'); expect(html).toContain('>Unavailable<')
  })
  it.each([
    ['off', { phase: 'off' as const, device: null, active: null, levels: null }, 'Off'],
    ['starting', { phase: 'starting' as const, active: null, levels: null }, 'Starting…'],
    ['waiting', { phase: 'waiting' as const, reason: 'no-device' as const, active: null, levels: null }, 'Not connected']
  ])('says %s instead of Unavailable when nothing is wrong', (_name, patch, text) => {
    const html = row({ ...snapshot(), ...patch })
    expect(html).not.toContain('data-mic-status="level"'); expect(html).toContain(`>${text}<`); expect(html).not.toContain('Unavailable')
  })
  it('with one input enabled, Mic 1 meters and Mic 2 is Off', () => {
    const value = snapshot(); value.enabledChannelsByDevice['alsa:flow8'] = [7]
    value.active = { ...value.active!, enabledChannels: [7] }; value.levels = { ...value.levels!, channelIndices: [7], peak: [0.4], rms: [0.1] }
    expect(row(value, 'mic1')).toContain('data-mic-db="-8.0"')
    expect(row(value, 'mic2')).toContain('>Off<')
  })
  it('shows one valid input only for a mono device, and treats measured zero as real silence', () => {
    const value = snapshot(); value.active!.channels = 1; value.active!.enabledChannels = [0]; value.enabledChannelsByDevice['alsa:flow8'] = [0]; value.levels!.channelIndices = [0]; value.levels!.peak = [0]; value.levels!.rms = [0]
    expect(row(value)).toContain('data-mic-db="-inf"'); expect(row(value)).toContain('>Quiet<');
    expect(row(value, 'mic2')).not.toContain('data-mic-status="level"')
    expect(row(undefined)).not.toContain('data-mic-status="level"')
  })
  it.each([['ru', 'Поёте', 'Микрофон 1'], ['zh-CN', '正在演唱', '麦克风 1']] as const)('localizes the plain meter state in %s', async (locale, state, name) => {
    await prepareBoxLocale(locale)
    const html = row(snapshot())
    expect(html).toContain(`>${state}<`); expect(html).toContain(name)
    expect(html).not.toContain('Singing')
  })
})
