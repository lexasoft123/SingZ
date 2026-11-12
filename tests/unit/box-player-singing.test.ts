import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zh } from '../../src/shared/i18n/zh-CN/box'
import { clampTranspose, stepTranspose, TRANSPOSE_MAX, TRANSPOSE_MIN } from '../../src/renderer/src/box/key-change'
import { MICROPHONE_SINGING_PEAK, microphoneMeterFill, microphoneMeterState, microphoneSlotStatus } from '../../src/renderer/src/box/microphones'
import { SongDetails } from '../../src/renderer/src/box/SongDetails'
import { BoxTransport } from '../../src/renderer/src/box/transport'

const css = readFileSync('src/renderer/src/box/styles.css', 'utf8')
const rule = (selector: string): string => {
  const line = css.split('\n').reverse().find(entry => entry.startsWith(`${selector} {`))
  if (!line) throw new Error(`missing CSS rule ${selector}`)
  return line
}
const px = (line: string, property: string): number => Number(new RegExp(`(?:^|[ {;])${property}: (\\d+)px`).exec(line)?.[1])

beforeAll(async () => { await prepareBoxLocale('en') })

describe('mixer leaves the lyric rows visible', () => {
  it('stays a strip below the lyric viewport at the 1600x900 TV coordinate system', () => {
    const lyrics = rule('.player-lyrics')
    const lyricBottom = px(lyrics, 'top') + px(lyrics, 'height')
    const scrim = rule('.box-safe-surface > .modal-scrim:has(.box-mixer-card)')
    const card = rule('.box-mixer-card')
    const top = 900 - Number(/padding: 0 \d+px (\d+)px/.exec(scrim)?.[1]) - px(card, 'height')
    // Old layout: 488px card at the bottom => top 388, covering the active (centre ~405) and next row.
    expect(top).toBeGreaterThanOrEqual(lyricBottom - 12)
    expect(rule('.box-safe-surface > .modal-scrim:has(.box-mixer-card)')).toContain('background: transparent')
  })
  it('does not dim the lyrics behind it', () => {
    expect(rule('.box-safe-surface > .modal-scrim:has(.box-mixer-card)')).not.toMatch(/rgba\(0, 0, 0, \.42\)/)
  })
})

describe('microphone meter state', () => {
  const level = (value: number) => microphoneMeterState({ kind: 'level', level: value })
  it('maps levels and statuses to plain states', () => {
    expect(level(0)).toBe('quiet')
    expect(level(MICROPHONE_SINGING_PEAK / 2)).toBe('quiet')
    expect(level(MICROPHONE_SINGING_PEAK)).toBe('singing')
    expect(level(0.5)).toBe('singing')
    expect(level(1.2)).toBe('loud')
    for (const kind of ['off', 'starting', 'no-input', 'unavailable'] as const) expect(microphoneMeterState({ kind })).toBe(kind)
    expect(microphoneSlotStatus(undefined, 0).kind).toBe('unavailable')
  })
  it('fills the bar on a dB scale', () => {
    expect(microphoneMeterFill(0)).toBe(0)
    expect(microphoneMeterFill(1)).toBe(1)
    expect(microphoneMeterFill(0.01)).toBeCloseTo(0.2, 5)
    expect(microphoneMeterFill(1e-9)).toBe(0)
  })
})

describe('key change', () => {
  it('clamps to the engine range and never wraps', () => {
    expect(TRANSPOSE_MIN).toBe(-12); expect(TRANSPOSE_MAX).toBe(12)
    expect(stepTranspose(12, 1)).toBe(12)
    expect(stepTranspose(-12, -1)).toBe(-12)
    expect(stepTranspose(0, 1)).toBe(1)
    expect(stepTranspose(3, -1)).toBe(2)
    expect(clampTranspose(40)).toBe(12); expect(clampTranspose(-40)).toBe(-12)
    expect(clampTranspose(1.6)).toBe(2); expect(clampTranspose(Number.NaN)).toBe(0)
  })
  it('transport.setTranspose clamps and goes through the engine and project save path', async () => {
    const setTranspose = vi.fn(async () => undefined)
    const recordControl = vi.fn((accepted: () => Promise<void>) => accepted())
    const fake = { engine: { setTranspose }, recordControl }
    await (BoxTransport.prototype as unknown as { setTranspose(this: unknown, value: number): Promise<void> }).setTranspose.call(fake, 99)
    expect(setTranspose).toHaveBeenCalledWith(12)
    expect(recordControl).toHaveBeenCalledWith(expect.any(Function), true)
  })
  it('saves an unloaded song through saveProject with the new key and the rest of its settings', async () => {
    const saveProject = vi.fn(async () => ({ ok: true as const }))
    const fake = { active: null, api: { saveProject }, enqueueSave: <T,>(op: () => Promise<T>) => op() }
    const settings = { transpose: 2, tempo: 1.1 } as never
    const result = await (BoxTransport.prototype as unknown as { saveSongTranspose(this: unknown, item: unknown, settings: unknown, value: number): Promise<{ ok: boolean }> })
      .saveSongTranspose.call(fake, { dir: '/p', songPath: '/p/song.mp3', name: 'A - B' }, settings, -20)
    expect(result.ok).toBe(true)
    expect(saveProject).toHaveBeenCalledWith('/p/song.mp3', 'A - B', { transpose: -12, tempo: 1.1 })
  })
})

describe('song details key controls', () => {
  const props = {
    entry: { id: 'local:/p', name: 'Artist - Title', local: { dir: '/p', songPath: '/p/s.mp3', name: 'Artist - Title' }, remoteId: null, unavailable: false },
    inspection: { readiness: 'ready', project: { stems: { vocals: 'v.wav' }, hasLyrics: true, settings: {} }, message: null },
    metadata: { key: { pc: 0, minor: false }, bpm: 100, range: null, duration: 200 },
    queued: false, busy: false, error: null, actionError: null, download: null,
    onBack: vi.fn(), onSing: vi.fn(), onPrepare: vi.fn(), onVerify: vi.fn(), onCancelDownload: vi.fn(), onToggleQueue: vi.fn(), onTranspose: vi.fn()
  }
  const render = (transpose: number, extra: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(SongDetails, { ...props, transpose, ...extra } as never))
  it('shows the resulting key and reachable − / + buttons', () => {
    const html = render(2)
    expect(html).toContain('data-key-down'); expect(html).toContain('data-key-up')
    expect(html).toContain('+2 semitones')
    expect(html).toContain('<span>D major</span>')
  })
  it('disables the buttons at the range ends and while the song is not ready', () => {
    expect(render(12)).toMatch(/data-key-up="true"[^>]*disabled=""/)
    expect(render(-12)).toMatch(/data-key-down="true"[^>]*disabled=""/)
    expect(render(0, { inspection: { readiness: 'unprepared', project: null, message: null } })).toMatch(/data-key-up="true"[^>]*disabled=""/)
  })
})

describe('copy', () => {
  it('has the same new keys in EN, RU and zh-CN', () => {
    const keys = Object.keys(en).filter(key => /micSinging|micQuiet|micLoud|micNotConnected|details\.key/.test(key))
    expect(keys.length).toBeGreaterThanOrEqual(9)
    for (const key of keys) { expect(ru).toHaveProperty([key]); expect(zh).toHaveProperty([key]) }
  })
})
