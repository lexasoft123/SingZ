import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zh } from '../../src/shared/i18n/zh-CN/box'
import { clampTranspose, createKeyChanger, stepTranspose, TRANSPOSE_MAX, TRANSPOSE_MIN } from '../../src/renderer/src/box/key-change'
import { MICROPHONE_SINGING_PEAK, microphoneMeterFill, microphoneMeterState, microphoneSlotStatus } from '../../src/renderer/src/box/microphones'
import { SongDetails } from '../../src/renderer/src/box/SongDetails'
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
/** The pre-fix App callback: cleanup compares dir and value, not request identity. */
function oldKeyChanger(deps: { dirOf(e: { dir: string }): string; save(): Promise<{ ok: true }>; refresh(): Promise<void>; setDraft(u: (c: { dir: string; value: number } | null) => { dir: string; value: number } | null): void; setError(m: string | null): void }) {
  return async (entry: { dir: string }, value: number): Promise<void> => {
    deps.setDraft(() => ({ dir: entry.dir, value }))
    await deps.save(); await deps.refresh()
    deps.setDraft(current => current?.dir === entry.dir && current.value === value ? null : current)
  }
}

const css = readFileSync('src/renderer/src/box/styles.css', 'utf8')
const settingsCss = readFileSync('src/renderer/src/box/settings.css', 'utf8')
const rule = (selector: string): string => {
  const line = css.split('\n').reverse().find(entry => entry.startsWith(`${selector} {`))
  if (!line) throw new Error(`missing CSS rule ${selector}`)
  return line
}
const px = (line: string, property: string): number => Number(new RegExp(`(?:^|[ {;])${property}: (\\d+)px`).exec(line)?.[1])

beforeAll(async () => { await prepareBoxLocale('en') })

describe('player microphone meter readability', () => {
  it('keeps two couch-readable meter rows inside the transport bar without later shrink overrides', () => {
    expect(settingsCss).not.toMatch(/\.player-meters > \.player-microphone-row|\.player-microphone-row > span:first-child|\.player-microphone-level/)
    expect(px(rule('.player-microphone-name'), 'font-size')).toBeGreaterThanOrEqual(18)
    expect(px(rule('.player-meters .mic-meter-state'), 'font-size')).toBeGreaterThanOrEqual(18)
    expect(px(rule('.player-meters .mic-meter-bar'), 'height')).toBeGreaterThanOrEqual(16)
    const rowsHeight = 2 * px(rule('.player-microphone-name'), 'line-height') + px(rule('.player-meters'), 'gap')
    expect(rowsHeight).toBeLessThanOrEqual(px(rule('.player-transport'), 'height'))
  })
})

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
  it('submits only the latest of stacked presses (ABA 1,2,1) and scopes late errors to the selection', async () => {
    const gates = [deferred<{ ok: true }>(), deferred<{ ok: true }>(), deferred<{ ok: true }>()]
    let call = 0
    let draft: { dir: string; value: number } | null = null
    const errors: (string | null)[] = []
    const make = (clearByValue: boolean) => {
      call = 0; draft = null
      const deps = { dirOf: (entry: { dir: string }) => entry.dir, save: () => gates[call++].promise, refresh: async () => undefined,
        setDraft: (update: (current: typeof draft) => typeof draft) => { draft = update(draft) }, setError: (message: string | null) => errors.push(message), selectedDir: () => '/a' }
      return clearByValue ? oldKeyChanger(deps) : createKeyChanger<{ dir: string }>(deps)
    }
    const press = async (change: (entry: { dir: string }, value: number) => Promise<void>) => {
      const runs = [change({ dir: '/a' }, 1), change({ dir: '/a' }, 2), change({ dir: '/a' }, 1)]
      gates[0].resolve({ ok: true }); await new Promise(resolve => setTimeout(resolve, 0))
      return runs
    }
    // Negative control: the previous value-compare cleanup clears the draft while request 3 is outstanding.
    await press(make(true))
    expect(draft).toBeNull()
    const runs = await press(make(false))
    expect(draft).toEqual({ dir: '/a', value: 1 })
    gates[1].resolve({ ok: true }); await new Promise(resolve => setTimeout(resolve, 0))
    expect(draft).toEqual({ dir: '/a', value: 1 })
    gates[2].resolve({ ok: true }); await Promise.all(runs)
    expect(draft).toBeNull()
  })
  it('refreshes once the latest settles even when only a superseded request saved', async () => {
    type Result = { ok: true } | { ok: false; error: string }
    const gates = [deferred<Result>(), deferred<Result>()]
    let call = 0, refreshed = 0
    const change = createKeyChanger<{ dir: string }>({ dirOf: entry => entry.dir, save: () => gates[call++].promise, refresh: async () => { refreshed++ },
      setDraft: () => undefined, setError: () => undefined, selectedDir: () => '/a' })
    const runs = [change({ dir: '/a' }, 1), change({ dir: '/a' }, 2)]
    gates[0].resolve({ ok: true }); gates[1].resolve({ ok: false, error: 'x' }); await Promise.all(runs)
    expect(refreshed).toBe(1)
  })
  it('does not publish a late error after the selection moved', async () => {
    const gate = deferred<{ ok: false; error: string }>()
    const errors: (string | null)[] = []
    let selected = '/a'
    const change = createKeyChanger<{ dir: string }>({ dirOf: entry => entry.dir, save: () => gate.promise, refresh: async () => undefined,
      setDraft: () => undefined, setError: message => errors.push(message), selectedDir: () => selected })
    const run = change({ dir: '/a' }, 1)
    selected = '/b'
    gate.resolve({ ok: false, error: 'disk full' }); await run
    expect(errors).toEqual([null])
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
  it('connects Sing and Add to queue vertically to the key controls and back', () => {
    const html = render(2)
    expect(html.match(/data-key-control="true"/g)).toHaveLength(2)
    expect(html).toContain('data-remote-up="[data-key-control]"')
    expect(html).toContain('data-remote-down="[data-detail-primary]"')
  })
  it('uses the singular for one semitone', () => {
    expect(render(1)).toContain('>+1 semitone</span>')
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
