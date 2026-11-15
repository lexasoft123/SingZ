import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveSpatialFocus, pickMixerFocusId, rangeOwnsArrow } from '../../src/renderer/src/box/focus'
import { playbackStatus } from '../../src/renderer/src/box/playback-status'
import { BoxSettingsNavigator, accountReturnFromHub, overlayReturnRoute, type BoxRoute } from '../../src/renderer/src/box/settings-navigation'
import { initialJourney, journeyBack, journeyReducer } from '../../src/renderer/src/box/journeys/model'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zhCN } from '../../src/shared/i18n/zh-CN/box'
import { boxSettings as enSettings } from '../../src/shared/i18n/en/box-settings'

type Rect = { left: number; top: number; width: number; height: number }
let activeElement: Fake | null = null

/** Minimal element double: attribute selectors only, which is all focus.ts asks for. */
class Fake {
  readonly children: Fake[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  parent: Fake | null = null
  disabled = false
  value = '0'
  max = '0'
  constructor(readonly tagName: string, readonly name: string, private readonly rect: Rect) {}
  append(...children: Fake[]): this { for (const child of children) { child.parent = this; this.children.push(child) } return this }
  private all(): Fake[] { return this.children.flatMap(child => [child, ...child.all()]) }
  private attr(key: string): string | undefined {
    if (key.startsWith('data-')) {
      const dataKey = key.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
      return this.dataset[dataKey]
    }
    return this.attributes[key]
  }
  getAttribute(key: string): string | null { return this.attr(key) ?? null }
  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled
    if (selector === '[inert]') return false
    if (selector === 'input[type="range"]') return this.tagName === 'input' && this.attributes.type === 'range'
    if (selector === '[data-mix-row]') return this.dataset.mixRow !== undefined
    if (['[data-remote-down]', '[data-remote-up]', '[data-remote-right]', '[data-remote-left]'].includes(selector)) return this.attr(selector.slice(1, -1)) !== undefined
    const bare = /^\[(data-[a-z-]+)\]$/.exec(selector)
    if (bare) return this.attr(bare[1]) !== undefined
    const exact = /^\[(data-[a-z-]+)="([^"]+)"\]$/.exec(selector)
    if (exact) return this.attr(exact[1]) === exact[2]
    const text = /^\[data-control='?([a-z]+)'?\]$/.exec(selector)
    if (text) return this.dataset.control === text[1]
    if (selector === '.mode-seg button[aria-pressed="true"]') return false
    throw new Error(`Unsupported selector: ${selector}`)
  }
  closest(selector: string): Fake | null {
    for (let node: Fake | null = this; node; node = node.parent) if (node.matches(selector)) return node
    return null
  }
  contains(other: Fake): boolean { return other === this || this.all().includes(other) }
  querySelectorAll(selector: string): Fake[] {
    if (selector === '[data-mix-row]') return this.all().filter(element => element.dataset.mixRow !== undefined)
    return this.all().filter(element => (element.tagName === 'button' || (element.tagName === 'input' && element.attributes.type === 'range')) && !element.disabled)
  }
  querySelector(selector: string): Fake | null { return this.all().find(element => element.matches(selector)) ?? null }
  getClientRects(): Rect[] { return [this.rect] }
  getBoundingClientRect(): Rect & { right: number; bottom: number } { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height } }
  focus(): void { activeElement = this }
  scrollIntoView(): void {}
}
const as = (element: Fake): HTMLElement => element as unknown as HTMLElement
const el = (tag: string, name: string, left: number, top: number, width = 60, height = 40): Fake => new Fake(tag, name, { left, top, width, height })

beforeEach(() => {
  activeElement = null
  vi.stubGlobal('HTMLElement', Fake)
  vi.stubGlobal('document', { get activeElement() { return activeElement } })
})
afterEach(() => vi.unstubAllGlobals())

function playerRow(): { scope: Fake; header: Fake; back5: Fake; play: Fake; forward5: Fake; mix: Fake; seek: Fake } {
  const scope = el('div', 'player', 0, 0, 1920, 1080)
  const header = el('button', 'header:settings', 1500, 20)
  const row = el('div', 'transport', 0, 900, 1920, 80)
  const group = el('div', 'buttons', 840, 900, 400, 80)
  group.dataset.remoteUp = "[data-control='seek']"
  const seek = el('input', 'seek', 200, 920, 600)
  seek.attributes.type = 'range'
  seek.dataset.control = 'seek'
  seek.dataset.remoteAxis = 'vertical'
  const back5 = el('button', 'back5', 860, 920)
  const play = el('button', 'play', 940, 920)
  play.dataset.control = 'play'
  const forward5 = el('button', 'forward5', 1020, 920)
  const mix = el('button', 'mix', 1100, 920)
  seek.dataset.remoteDown = "[data-control='play']"
  group.append(back5, play, forward5, mix)
  row.append(seek, group)
  scope.append(header, row)
  return { scope, header, back5, play, forward5, mix, seek }
}

describe('item 12: player seek is not in the Left/Right chain', () => {
  it('Left from Back 5 s does not land on the seek slider', () => {
    const { scope, back5, seek } = playerRow()
    back5.focus()
    moveSpatialFocus(as(scope), 'ArrowLeft')
    expect(activeElement).not.toBe(seek)
  })
  it('Up from the transport row reaches the slider deliberately', () => {
    const { scope, play, seek } = playerRow()
    play.focus()
    moveSpatialFocus(as(scope), 'ArrowUp')
    expect(activeElement).toBe(seek)
  })
  it('Down from the slider leaves it for Play, and Left/Right do not move focus off it', () => {
    const { scope, play, seek } = playerRow()
    seek.focus()
    expect(moveSpatialFocus(as(scope), 'ArrowLeft')).toBe(false)
    expect(moveSpatialFocus(as(scope), 'ArrowRight')).toBe(false)
    expect(activeElement).toBe(seek)
    moveSpatialFocus(as(scope), 'ArrowDown')
    expect(activeElement).toBe(play)
  })
})

describe('player bar: From the start sits first in the Left/Right order', () => {
  it('Left from Back 5 s reaches From the start, and Right walks back through Back 5 s to Play', () => {
    const { scope, back5, play } = playerRow()
    const fromStart = el('button', 'from-start', 780, 920)
    fromStart.dataset.control = 'from-start'
    scope.append(fromStart)
    back5.focus()
    moveSpatialFocus(as(scope), 'ArrowLeft')
    expect(activeElement).toBe(fromStart)
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(back5)
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(play)
  })
})

describe('step 6: Song details key controls stay on the vertical remote path', () => {
  it('moves Sing/Add to queue Up to a key button, Down to Sing, and Up again to the header', () => {
    const scope = el('main', 'details', 0, 0, 1600, 900)
    const header = el('button', 'header', 1000, 40)
    const keys = el('div', 'key controls', 850, 400, 400, 100)
    keys.dataset.remoteDown = '[data-detail-primary]'
    const lower = el('button', 'lower', 900, 430)
    const higher = el('button', 'higher', 1100, 430)
    lower.dataset.keyControl = ''; higher.dataset.keyControl = ''
    keys.append(lower, higher)
    const actions = el('div', 'actions', 40, 700, 500, 100)
    actions.dataset.remoteUp = '[data-key-control]'
    const sing = el('button', 'Sing', 60, 730)
    sing.dataset.detailPrimary = ''
    const queue = el('button', 'Add to queue', 260, 730)
    actions.append(sing, queue)
    scope.append(header, keys, actions)

    sing.focus(); moveSpatialFocus(as(scope), 'ArrowUp')
    expect(activeElement).toBe(lower)
    higher.focus(); moveSpatialFocus(as(scope), 'ArrowDown')
    expect(activeElement).toBe(sing)
    queue.focus(); moveSpatialFocus(as(scope), 'ArrowUp')
    expect(activeElement).toBe(lower)
    moveSpatialFocus(as(scope), 'ArrowUp')
    expect(activeElement).toBe(header)
  })
})

describe('item 13: mixer Mute/Solo reachable by direction', () => {
  function row(max: number): { scope: Fake; level: Fake; mute: Fake; solo: Fake; next: Fake } {
    const scope = el('div', 'mix', 0, 0, 1440, 500)
    scope.dataset.surface = 'mix'
    const r1 = el('div', 'row:vocals', 40, 100, 1360, 60); r1.dataset.mixRow = 'vocals'
    const level = el('input', 'level:vocals', 340, 110, 700); level.attributes.type = 'range'; level.dataset.mixLevel = 'vocals'; level.max = String(max)
    const mute = el('button', 'mute', 1080, 107, 44, 34); const solo = el('button', 'solo', 1134, 107, 44, 34)
    r1.append(level, mute, solo)
    const r2 = el('div', 'row:drums', 40, 170, 1360, 60); r2.dataset.mixRow = 'drums'
    const next = el('input', 'level:drums', 340, 180, 700); next.attributes.type = 'range'; next.dataset.mixLevel = 'drums'
    r2.append(next)
    scope.append(r1, r2)
    return { scope, level, mute, solo, next }
  }
  it('Left/Right adjust the slider except Right at its maximum, which moves to Mute', () => {
    const { level } = row(0)
    level.value = '-10'
    expect(rangeOwnsArrow(as(level), 'ArrowRight')).toBe(true)
    expect(rangeOwnsArrow(as(level), 'ArrowLeft')).toBe(true)
    level.value = '0'
    expect(rangeOwnsArrow(as(level), 'ArrowLeft')).toBe(true)
    expect(rangeOwnsArrow(as(level), 'ArrowRight')).toBe(false)
  })
  it('Right at the maximum reaches M then S; Left returns; Up/Down still change channel', () => {
    const { scope, level, mute, solo, next } = row(0)
    level.value = '0'
    level.focus()
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(mute)
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(solo)
    moveSpatialFocus(as(scope), 'ArrowLeft')
    expect(activeElement).toBe(mute)
    moveSpatialFocus(as(scope), 'ArrowDown')
    expect(activeElement).toBe(next)
  })
  it('the mixer opens on the remembered channel, else the first level', () => {
    expect(pickMixerFocusId(['master', 'vocals'], 'vocals')).toBe('vocals')
    expect(pickMixerFocusId(['master', 'vocals'], 'drums')).toBe('master')
    expect(pickMixerFocusId(['master', 'vocals'], null)).toBe('master')
  })
})

describe('item 2: one status derivation', () => {
  const base = { playing: false, position: 0, duration: 200, playbackError: null, outputError: null, saveError: null }
  it('reports ended at the end of the song, not paused', () => {
    expect(playbackStatus({ ...base, position: 200 })).toBe('ended')
    expect(playbackStatus({ ...base, position: 12 })).toBe('paused')
    expect(playbackStatus({ ...base, playing: true, position: 12 })).toBe('playing')
    expect(playbackStatus({ ...base, outputError: 'x' })).toBe('error')
  })
})

describe('item 1/3: copy matches behaviour in every locale', () => {
  for (const [name, dictionary] of [['en', en], ['ru', ru], ['zh-CN', zhCN]] as const) {
    it(`${name}: Sing no longer claims to open paused`, () => {
      const d = dictionary as Record<string, string>
      expect(d['box.details.opensPaused']).not.toMatch(/paus|пауз|暂停/i)
      expect(d['box.details.readyBody']).not.toMatch(/paus|пауз|暂停/i)
      expect(d['box.player.paused']).not.toMatch(/OK/)
    })
  }
  it('en: microphone copy no longer says external mixer is the only option or that inputs are only read', () => {
    const d = en as Record<string, string>
    expect(d['box.mix.noMicrophones']).toMatch(/software route/i)
    expect((enSettings as Record<string, string>)['box.settings.inputsHelp']).not.toMatch(/^Read-only/)
  })
})

describe('item 14: Settings/Account return to the originating route', () => {
  it('keeps the screen the overlay was opened from', () => {
    for (const origin of ['player', 'queue', 'catalog', 'details'] as BoxRoute[]) {
      expect(overlayReturnRoute(origin, 'catalog', 'home')).toBe(origin)
    }
    expect(overlayReturnRoute('home', 'player', 'home')).toBe('player')
    expect(overlayReturnRoute('account', 'queue', 'account')).toBe('queue')
  })
  it('Queue -> Account -> Settings -> Account -> Back -> Back ends on the queue, with no cycle', () => {
    let route: BoxRoute = 'queue'
    let hubReturn: BoxRoute = 'catalog'
    let accountReturn: BoxRoute = 'catalog'
    const goAccount = (): void => {
      accountReturn = route === 'home' ? accountReturnFromHub(hubReturn, accountReturn) : overlayReturnRoute(route, accountReturn, 'account')
      route = 'account'
    }
    const goHub = (): void => { hubReturn = overlayReturnRoute(route, hubReturn, 'home'); route = 'home' }
    goAccount(); goHub(); goAccount()
    route = accountReturn // Back from Account
    expect(route).toBe('queue')
  })
  it('Sound settings Back returns to the Settings home, then the origin', () => {
    const routes: BoxRoute[] = []
    const nav = new BoxSettingsNavigator(() => ({ applyingOutput: false, hasCurrent: true, settingsReturn: 'home' }), route => routes.push(route))
    nav.backFromSettings()
    expect(routes).toEqual(['home'])
  })
})

describe('item 15: setup opened from Settings', () => {
  const home = { ...initialJourney('home') }
  it('Back from the entry step returns to Settings, not an earlier step', () => {
    const opened = journeyReducer(home, { type: 'open-setup', stage: 'remote' })
    expect(opened.setupStage).toBe('remote')
    const back = journeyBack(opened)
    expect(back.state.page).toBe('home')
    expect(back.effect).toBe('consumed')
  })
  it('first-run setup still walks back step by step', () => {
    const first = { ...initialJourney('setup'), setupStage: 'remote' as const }
    expect(journeyBack(first).state.setupStage).toBe('welcome')
  })
})
