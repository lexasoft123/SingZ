import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { setLocale } from '../../src/shared/i18n/core'
import { prepareBoxLocale, t } from '../../src/renderer/src/box/i18n'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zhCN } from '../../src/shared/i18n/zh-CN/box'
import { focusPrimaryNavigation, seekKeepsFocus, sideExit, SEEK_KEY_GRACE_MS } from '../../src/renderer/src/box/focus'
import { routeAfterFailedOpen, routeWhileOpening } from '../../src/renderer/src/box/settings-navigation'
import { acquireJourneyFocus, findJourneyFocus } from '../../src/renderer/src/box/journeys/focus'
import { audioReadyText } from '../../src/renderer/src/box/journeys/format'
import { initialJourney, journeyBack, journeyReducer, settingsSetupEntry } from '../../src/renderer/src/box/journeys/model'
import { journeyChinese, journeyEnglish, journeyRussian, tJourney } from '../../src/renderer/src/box/journeys/i18n'
import { SetupPage } from '../../src/renderer/src/box/journeys/SetupPage'
import { Queue } from '../../src/renderer/src/box/Queue'

const source = (file: string): string => readFileSync(resolve(__dirname, '../..', file), 'utf8')
const app = source('src/renderer/src/box/App.tsx')

/** Selector-keyed element double: only what each helper under test asks for. */
class El {
  focused = false
  dataset: Record<string, string> = {}
  constructor(private readonly matching: string[] = [], private readonly lookups: Record<string, El | null> = {}) {}
  matches(selector: string): boolean { return this.matching.includes(selector) }
  querySelector(selector: string): El | null { return this.lookups[selector] ?? null }
  focus(): void { this.focused = true }
  scrollIntoView(): void {}
  isConnected = true
  getClientRects(): unknown[] { return [{}] }
  closest(): null { return null }
}

afterEach(() => setLocale('en'))

describe('PR #152 TV fix 1: audio count plurals', () => {
  beforeAll(async () => { await prepareBoxLocale('en') })
  const cases: Array<[string, 'en' | 'ru' | 'zh-CN', number, number, string]> = [
    ['en 1/2', 'en', 1, 2, '1 output and 2 inputs found'],
    ['en 2/1', 'en', 2, 1, '2 outputs and 1 input found'],
    ['ru 1/2', 'ru', 1, 2, 'Найдено: 1 выход, 2 входа'],
    ['ru 5/21', 'ru', 5, 21, 'Найдено: 5 выходов, 21 вход'],
    ['ru 22/11', 'ru', 22, 11, 'Найдено: 22 выхода, 11 входов'],
    ['zh 1/2', 'zh-CN', 1, 2, '找到1个输出和2个输入']
  ]
  it.each(cases)('%s', async (_name, locale, outputs, inputs, expected) => {
    await prepareBoxLocale(locale)
    expect(audioReadyText({ outputs, inputs })).toBe(expected)
  })
  it('negative control: the old flat template said "1 outputs"', () => {
    setLocale('en')
    expect(audioReadyText({ outputs: 1, inputs: 2 })).not.toMatch(/\b1 outputs\b/)
    expect(tJourney('journey.setup.audioReady', { outputs: '1 output', inputs: '2 inputs' })).toBe('1 output and 2 inputs found')
  })
  it('every locale defines the plural stems it needs; Russian has few and many', () => {
    for (const stem of ['journey.audio.outputs', 'journey.audio.inputs']) {
      for (const dict of [journeyEnglish, journeyRussian, journeyChinese] as Array<Record<string, string>>) expect(dict[`${stem}_one`]).toContain('{n}')
      for (const form of ['few', 'many']) expect((journeyRussian as Record<string, string>)[`${stem}_${form}`]).toContain('{n}')
    }
  })
})

describe('PR #152 TV fix 2: catalog Back focuses the top navigation', () => {
  it('focuses the current navigation section, else the first navigation button', () => {
    const current = new El()
    const first = new El()
    expect(focusPrimaryNavigation(new El([], { '.box-navigation button.on': current }) as never)).toBe(true)
    expect(current.focused).toBe(true)
    expect(focusPrimaryNavigation(new El([], { '.box-navigation button, [data-surface="navigation"] button': first }) as never)).toBe(true)
    expect(first.focused).toBe(true)
    expect(focusPrimaryNavigation(new El() as never)).toBe(false)
  })
  it('the catalog Back branch moves focus without bumping focusVersion (that re-runs the effect and refocuses the row)', () => {
    const back = app.slice(app.indexOf('const back = useCallback'), app.indexOf('const actionsRef'))
    const branch = back.slice(back.indexOf('} else if (tvRef.current) {'))
    expect(branch).toContain('focusPrimaryNavigation(tvRef.current)')
    expect(branch).not.toContain('setFocusVersion')
    // negative control: the old branch bumped focusVersion before focusing
    expect(back).not.toMatch(/setFocusVersion\(version => version \+ 1\)\s*tvRef\.current\?\.querySelector/)
  })
})

describe('PR #152 TV fix 3: Back from a Settings sub-page restores the originating row', () => {
  const rows = (): { setup: El; first: El; scope: El } => {
    const setup = new El()
    const first = new El()
    const scope = new El([], {
      '.journey-page-layer [data-focus="journey-setup"]:not(:disabled)': setup,
      '.journey-page-layer [data-journey-primary]:not(:disabled)': first
    })
    return { setup, first, scope }
  }
  it('prefers the remembered row, falls back to the first row', () => {
    const { setup, first, scope } = rows()
    expect(findJourneyFocus(scope as never, true, 'journey-setup')).toBe(setup)
    expect(findJourneyFocus(scope as never, true, null)).toBe(first) // old behaviour = negative control
    expect(findJourneyFocus(scope as never, true, 'journey-gone')).toBe(first)
  })
  it('acquires focus on the remembered row after the page revision changes', () => {
    const { setup, first, scope } = rows()
    const body = new El()
    expect(acquireJourneyFocus(scope as never, body as never, body as never, 3, 2, null, 'journey-setup')).toBe(3)
    expect(setup.focused).toBe(true)
    expect(first.focused).toBe(false)
  })
  it('the hub remembers rows as they are focused and clears the memory on a fresh entry', () => {
    const hub = source('src/renderer/src/box/journeys/JourneyHub.tsx')
    expect(hub).toContain("matches('.journey-row')")
    expect(hub).toContain("state.current.page === 'home' ? homeRow.current : null")
    expect(hub).toContain("if (destination === 'home') homeRow.current = null")
  })
})

describe('PR #152 TV fix 4: "Setup, remote & display" opens where its subtitle says', () => {
  const props = {
    box: null, platform: null, audio: null, drive: null, loading: false, error: null, finishing: false,
    onStage: () => {}, onStep: () => {}, onNetwork: () => {}, onRetry: () => {}, onAudio: () => {}, onCollection: () => {},
    onSafeArea: () => {}, onLanguage: () => {}, onFinish: () => {}, onBack: () => {}
  }
  it('a finished owner enters at the language step (2 of 7), not Remote & display', () => {
    const entry = settingsSetupEntry(true)
    expect(entry).toBe('welcome') // old entry was 'remote' (step 3)
    const opened = journeyReducer(initialJourney('home'), { type: 'open-setup', stage: entry })
    expect(opened.setupStage).toBe('welcome')
    expect(journeyBack(opened).state.page).toBe('home')
    expect(settingsSetupEntry(false)).toBeUndefined()
  })
  it('the entry step actually offers language, and the next step the remote and safe area the row names', () => {
    expect(journeyEnglish['journey.home.setupHelp']).toBe('Language, remote checks and TV safe area')
    const welcome = renderToStaticMarkup(createElement(SetupPage, { ...props, stage: 'welcome' }))
    expect(welcome).toContain('Русский')
    expect(welcome).toContain('Step 2 of 7')
    const remote = renderToStaticMarkup(createElement(SetupPage, { ...props, stage: 'remote' }))
    expect(remote).toContain('data-remote-check')
  })
})

describe('PR #152 TV fix 5: the pre-lyrics countdown is one tight token', () => {
  it.each([
    ['en', en, '9 s'],
    ['ru', ru, '9 с'],
    ['zh-CN', zhCN, '9秒']
  ] as const)('%s', async (locale, dictionary, expected) => {
    await prepareBoxLocale(locale)
    expect(t('box.player.countdownSeconds', { seconds: 9 })).toBe(expected)
    expect(dictionary['box.player.countdownSeconds']).not.toMatch(/ /) // no regular space: it renders full-width in the mono face
  })
  it('PlayerLyrics renders it through the key, not "{seconds} s"', () => {
    const lyrics = source('src/renderer/src/box/PlayerLyrics.tsx')
    expect(lyrics).toContain("t('box.player.countdownSeconds', { seconds: countdown.seconds })")
    expect(lyrics).not.toContain('{countdown.seconds} s')
  })
})

describe('PR #152 TV fix 6: queue row actions are reachable and announced', () => {
  const group = new El(['[data-remote-right]'])
  const select = new El(["[data-queue-action='select']"])
  select.dataset.queueAction = 'select'
  const row = new El()
  ;(group as unknown as { contains(e: unknown): boolean }).contains = element => element === row
  ;(row as unknown as { closest(s: string): El | null }).closest = selector => selector === '[data-remote-right]' ? group : null
  ;(group as unknown as { getAttribute(a: string): string | null }).getAttribute = () => "[data-queue-action='select']"
  const scope = { contains: (element: unknown) => element === group || element === row || element === select }

  it('Right from a queued row hands over to the first action; no side exit is declared elsewhere', () => {
    expect(sideExit(scope as never, row as never, [row, select] as never, 'ArrowRight')).toBe(select)
    expect(sideExit(scope as never, row as never, [row, select] as never, 'ArrowLeft')).toBeNull()
  })
  const render = (count: number): string => renderToStaticMarkup(createElement(Queue, {
    items: Array.from({ length: count }, (_, index) => ({ dir: `/s${index}`, name: `Band - Song ${index}`, songPath: '', hasStems: false })) as never,
    rows: {}, selectedDir: count ? '/s0' : null, active: null, position: 0, playing: false, status: 'idle' as never,
    onRemember: () => {}, onChoose: () => {}, onMove: () => {}, onRemove: () => {}, onBrowse: () => {}, onClose: () => {}, onToggle: () => {}
  }))
  it.each([['en', 'Actions'], ['ru', 'Действия'], ['zh-CN', '操作']] as const)('the list declares the hand-over and the footer says "→ %s"', async (locale, word) => {
    await prepareBoxLocale(locale)
    const html = render(2)
    expect(html).toContain("data-remote-right=\"[data-queue-action=&#x27;select&#x27;]\"")
    expect(html).toContain(`<b>→</b>${word}`)
    expect(render(0)).not.toContain('<b>→</b>') // empty queue: nothing to act on
  })
})

describe('PR #152 TV fix 7: seeking never leaves the slider at its ends', () => {
  const slider = { matches: (selector: string) => selector === '[data-control="seek"]' }
  const other = { matches: () => false }
  it('the end-of-song focus repair is withheld while the slider is being keyed', () => {
    expect(seekKeepsFocus(slider, 1000, 1000 + SEEK_KEY_GRACE_MS)).toBe(true)
    expect(seekKeepsFocus(slider, 1000, 1000 + SEEK_KEY_GRACE_MS + 1)).toBe(false) // a natural end later still restores Play (NAV-09)
    expect(seekKeepsFocus(slider, null, 1000)).toBe(false)
    expect(seekKeepsFocus(other, 1000, 1001)).toBe(false)
    expect(seekKeepsFocus(null, 1000, 1001)).toBe(false)
  })
  it('App records seek keys and consults the guard before refocusing the player', () => {
    expect(app).toContain("target?.matches('[data-control=\"seek\"]') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) lastSeekKeyAt.current")
    expect(app).toContain("route === 'player' && !mixOpen && !pendingSwitch && seekKeepsFocus(document.activeElement, lastSeekKeyAt.current, performance.now())")
  })
})

describe('PR #152 TV fix 8: opening from the player keeps the player on screen', () => {
  it('only the player is kept; other origins show details; a failed open lands on details', () => {
    expect(routeWhileOpening('player')).toBe('player') // old code: always 'details'
    for (const route of ['catalog', 'queue', 'details', 'home', 'account', 'settings'] as const) expect(routeWhileOpening(route)).toBe('details')
    expect(routeAfterFailedOpen('player')).toBe('details')
    expect(routeAfterFailedOpen('queue')).toBe('queue')
  })
  it('openNow routes through the helpers and only reaches the player after a successful open', () => {
    const open = app.slice(app.indexOf('const openNow = useCallback'), app.indexOf('const requestSing'))
    expect(open).toContain('setRoute(routeWhileOpening(latest.current.route))')
    expect(open).not.toMatch(/setRoute\('details'\)\s*\n\s*let reachedPlayer/)
    expect(open).toContain('if (!reachedPlayer) setRoute(routeAfterFailedOpen(latest.current.route))')
  })
})
