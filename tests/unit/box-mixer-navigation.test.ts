import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { moveSpatialFocus, type RemoteDirection } from '../../src/renderer/src/box/focus'
import { RemoteKeyGate } from '../../src/renderer/src/box/remote'

type Rect = { left: number; top: number; width: number; height: number }
type MixerView = 'main' | 'stems'

const remoteTargetSelector = 'button:not(:disabled), input[type="range"]:not(:disabled), [data-remote-focus]'

class FakeRemoteElement {
  readonly children: FakeRemoteElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes: Record<string, string> = {}
  parent: FakeRemoteElement | null = null
  className = ''
  disabled = false
  inert = false
  value = ''
  min = ''
  max = ''
  step = ''
  onClick?: () => void
  onNativeStep?: (value: number) => void

  constructor(readonly tagName: string, readonly name: string, private readonly rect: Rect) {}

  append(...children: FakeRemoteElement[]): void {
    for (const child of children) {
      child.parent = this
      this.children.push(child)
    }
  }

  replaceChildren(...children: FakeRemoteElement[]): void {
    for (const child of this.children) child.parent = null
    this.children.length = 0
    this.append(...children)
  }

  private descendants(): FakeRemoteElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()])
  }

  private isRemoteTarget(): boolean {
    return (this.tagName === 'button' || (this.tagName === 'input' && this.attributes.type === 'range') || this.dataset.remoteFocus !== undefined) &&
      !this.disabled && this.getClientRects().length > 0 && !this.closest('[inert]')
  }

  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled
    if (selector === 'input[type="range"]') return this.tagName === 'input' && this.attributes.type === 'range'
    if (selector === '[data-mix-row]') return this.dataset.mixRow !== undefined
    if (selector === '[inert]') return this.inert
    if (selector === '.mode-seg button[aria-pressed="true"]') {
      return this.tagName === 'button' && this.parent?.className === 'mode-seg' && this.attributes['aria-pressed'] === 'true'
    }
    if (selector === '[data-mix-play]') return this.dataset.mixPlay !== undefined
    if (selector === '[data-remote-down]' || selector === '[data-remote-up]' || selector === '[data-remote-right]' || selector === '[data-remote-left]') return this.attributes[selector.slice(1, -1)] !== undefined
    throw new Error(`Unsupported selector: ${selector}`)
  }

  closest(selector: string): FakeRemoteElement | null {
    let current: FakeRemoteElement | null = this
    while (current) {
      if (current.matches(selector)) return current
      current = current.parent
    }
    return null
  }

  querySelectorAll(selector: string): FakeRemoteElement[] {
    const descendants = this.descendants()
    if (selector === remoteTargetSelector) return descendants.filter(element => element.isRemoteTarget())
    if (selector === '[data-mix-row]') return descendants.filter(element => element.dataset.mixRow !== undefined)
    throw new Error(`Unsupported selector list: ${selector}`)
  }

  querySelector(selector: string): FakeRemoteElement | null {
    return this.descendants().find(element => element.matches(selector)) ?? null
  }

  getClientRects(): Rect[] {
    return [this.rect]
  }

  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }
  }

  focus(): void {
    activeElement = this
  }

  click(): void {
    if (!this.disabled) this.onClick?.()
  }

  scrollIntoView(): void {}

  nativeStep(direction: 'ArrowLeft' | 'ArrowRight'): void {
    const delta = Number(this.step) * (direction === 'ArrowLeft' ? -1 : 1)
    const value = Math.max(Number(this.min), Math.min(Number(this.max), Number(this.value) + delta))
    this.value = String(value)
    this.onNativeStep?.(value)
  }
}

let activeElement: FakeRemoteElement | null = null

function button(name: string, rect: Rect): FakeRemoteElement {
  return new FakeRemoteElement('button', name, rect)
}

function range(id: string, rect: Rect, maximum: number, onNativeStep: (value: number) => void): FakeRemoteElement {
  const input = new FakeRemoteElement('input', `level:${id}`, rect)
  input.attributes.type = 'range'
  input.dataset.mixLevel = id
  input.min = '-60'
  input.max = String(maximum)
  input.step = '1'
  input.value = '0'
  input.onNativeStep = onNativeStep
  return input
}

class MixerRemoteHarness {
  readonly root = new FakeRemoteElement('div', 'mixer', { left: 0, top: 0, width: 1440, height: 488 })
  readonly playerPlay = button('player:play', { left: 700, top: 800, width: 100, height: 40 })
  readonly gate = new RemoteKeyGate()
  readonly masterSteps: number[] = []
  readonly stemSteps: Record<string, number[]> = {}
  playing = true
  closed = false
  toggleCount = 0
  private readonly rows = new FakeRemoteElement('div', 'rows', { left: 40, top: 90, width: 1360, height: 300 })
  private readonly tabs: Record<MixerView, FakeRemoteElement>

  constructor(view: MixerView, private readonly availableStems: string[]) {
    this.root.dataset.surface = 'mix'
    this.root.dataset.view = view
    const tabGroup = new FakeRemoteElement('div', 'tabs', { left: 80, top: 20, width: 190, height: 38 })
    tabGroup.className = 'mode-seg'
    this.tabs = {
      main: button('tab:main', { left: 80, top: 20, width: 90, height: 38 }),
      stems: button('tab:stems', { left: 174, top: 20, width: 90, height: 38 })
    }
    this.tabs.main.onClick = () => this.setView('main')
    this.tabs.stems.onClick = () => this.setView('stems')
    tabGroup.append(this.tabs.main, this.tabs.stems)
    const play = button('mix:play', { left: 1120, top: 20, width: 90, height: 38 })
    play.dataset.mixPlay = ''
    play.onClick = () => {
      this.toggleCount++
      this.playing = !this.playing
    }
    const close = button('mix:close', { left: 1220, top: 20, width: 120, height: 38 })
    close.dataset.mixClose = ''
    close.onClick = () => this.close()
    this.root.append(tabGroup, play, close, this.rows)
    this.setView(view)
    this.root.querySelector('[data-mix-play]')!.focus()
  }

  get active(): string {
    return activeElement?.name ?? 'none'
  }

  private setView(view: MixerView): void {
    this.root.dataset.view = view
    for (const [name, tab] of Object.entries(this.tabs)) tab.attributes['aria-pressed'] = String(name === view)
    const ids = view === 'main' ? ['master', 'vocals', 'mic1', 'mic2'] : ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
    const rendered = ids.map((id, index) => {
      const top = 100 + index * (view === 'main' ? 70 : 48)
      const row = new FakeRemoteElement('div', `row:${id}`, { left: 40, top, width: 1360, height: view === 'main' ? 70 : 48 })
      row.dataset.mixRow = id
      const available = id === 'master' || this.availableStems.includes(id)
      if (available) {
        const input = range(id, { left: 340, top: top + 8, width: 700, height: 32 }, id === 'master' ? 12 : 0, value => {
          if (id === 'master') this.masterSteps.push(value)
          else (this.stemSteps[id] ??= []).push(value)
        })
        row.append(input)
        if (id !== 'master') {
          const mute = button(`mute:${id}`, { left: 1080, top: top + 7, width: 44, height: 34 })
          const solo = button(`solo:${id}`, { left: 1134, top: top + 7, width: 44, height: 34 })
          row.append(mute, solo)
        }
      }
      return row
    })
    this.rows.replaceChildren(...rendered)
  }

  press(key: string): void {
    const result = this.gate.keyDown(key, false, false)
    expect(result).toEqual({ consumed: true, wake: false, allowAction: true })
    try {
      const target = activeElement
      if (key === 'Backspace' || key === 'Escape') {
        this.close()
      } else if (key === 'Enter' || key === ' ') {
        if (target?.matches('input[type="range"]')) moveSpatialFocus(this.root as unknown as HTMLElement, 'ArrowRight')
        else target?.click()
      } else if (key === 'Tab') {
        moveSpatialFocus(this.root as unknown as HTMLElement, 'ArrowRight')
      } else if (key.startsWith('Arrow')) {
        const direction = key as RemoteDirection
        if (target?.matches('input[type="range"]') && (direction === 'ArrowLeft' || direction === 'ArrowRight')) target.nativeStep(direction)
        else moveSpatialFocus(this.root as unknown as HTMLElement, direction)
      }
    } finally {
      this.gate.keyUp(key)
    }
  }

  private close(): void {
    this.closed = true
    this.playerPlay.focus()
  }
}

beforeEach(() => {
  activeElement = null
  vi.stubGlobal('HTMLElement', FakeRemoteElement)
  vi.stubGlobal('document', { get activeElement() { return activeElement } })
})

afterEach(() => {
  activeElement = null
  vi.unstubAllGlobals()
})

describe('Box mixer physical remote navigation', () => {
  it('reaches Master from the actual Play entry focus, steps its native range, and skips unavailable microphones', () => {
    const mixer = new MixerRemoteHarness('main', ['vocals'])
    expect(mixer.active).toBe('mix:play')

    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:master')
    mixer.press('ArrowRight')
    mixer.press('ArrowLeft')
    expect(mixer.masterSteps).toEqual([1, 0])
    expect(mixer.active).toBe('level:master')

    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:vocals')
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:vocals')
    mixer.press('ArrowUp')
    expect(mixer.active).toBe('level:master')
    expect(mixer.playing).toBe(true)
    expect(mixer.toggleCount).toBe(0)
  })

  it('moves one stems row at a time and skips absent stems without wrapping', () => {
    const mixer = new MixerRemoteHarness('stems', ['vocals', 'drums', 'guitar'])
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:vocals')
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:drums')
    mixer.press('ArrowLeft')
    expect(mixer.stemSteps.drums).toEqual([-1])
    expect(mixer.active).toBe('level:drums')
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:guitar')
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:guitar')
    mixer.press('ArrowUp')
    expect(mixer.active).toBe('level:drums')
  })

  it('restores the selected tab on row exit and enters the current tab after each remote activation', () => {
    const mixer = new MixerRemoteHarness('main', ['vocals', 'drums'])
    mixer.press('ArrowDown')
    mixer.press('ArrowUp')
    expect(mixer.active).toBe('tab:main')

    mixer.press('ArrowRight')
    expect(mixer.active).toBe('tab:stems')
    mixer.press('Enter')
    expect(mixer.active).toBe('tab:stems')
    expect(mixer.root.dataset.view).toBe('stems')
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:vocals')
    mixer.press('ArrowUp')
    expect(mixer.active).toBe('tab:stems')

    mixer.press('ArrowLeft')
    mixer.press('Enter')
    expect(mixer.active).toBe('tab:main')
    expect(mixer.root.dataset.view).toBe('main')
    mixer.press('ArrowDown')
    expect(mixer.active).toBe('level:master')
  })

  it('keeps playback running and returns Back to the player Play focus after remote mixing', () => {
    const mixer = new MixerRemoteHarness('main', ['vocals'])
    mixer.press('ArrowDown')
    mixer.press('ArrowRight')
    mixer.press('Backspace')
    expect(mixer.closed).toBe(true)
    expect(mixer.active).toBe('player:play')
    expect(mixer.playing).toBe(true)
    expect(mixer.toggleCount).toBe(0)
  })

  it('preserves ordinary spatial navigation outside the mixer', () => {
    const settings = new FakeRemoteElement('div', 'settings', { left: 0, top: 0, width: 400, height: 200 })
    settings.dataset.surface = 'settings'
    const first = button('settings:first', { left: 100, top: 20, width: 100, height: 38 })
    const second = button('settings:second', { left: 100, top: 80, width: 100, height: 38 })
    settings.append(first, second)
    first.focus()

    moveSpatialFocus(settings as unknown as HTMLElement, 'ArrowDown')
    expect(activeElement?.name).toBe('settings:second')
  })
})
