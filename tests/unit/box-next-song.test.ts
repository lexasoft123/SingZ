import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { endedFocusControl, nextNeedsConfirmation, nextQueued, nextSlot, queueAfterAdvance, songLine } from '../../src/renderer/src/box/next-song'
import { moveSpatialFocus } from '../../src/renderer/src/box/focus'
import { box as en } from '../../src/shared/i18n/en/box'

const q = (...dirs: string[]): { dir: string }[] => dirs.map(dir => ({ dir }))

describe('nextQueued', () => {
  it('returns the entry after the current song', () => {
    expect(nextQueued(q('a', 'b', 'c'), 'a')?.dir).toBe('b')
    expect(nextQueued(q('a', 'b', 'c'), 'b')?.dir).toBe('c')
  })
  it('returns the first entry when the current song is not queued or nothing is open', () => {
    expect(nextQueued(q('a', 'b'), 'z')?.dir).toBe('a')
    expect(nextQueued(q('a', 'b'), null)?.dir).toBe('a')
  })
  it('has no next after the last item or with an empty queue', () => {
    expect(nextQueued(q('a', 'b'), 'b')).toBeNull()
    expect(nextQueued([], 'a')).toBeNull()
    expect(nextQueued([], null)).toBeNull()
  })
  it('never offers the current song again when it is listed more than once', () => {
    expect(nextQueued(q('a', 'a', 'b'), 'a')?.dir).toBe('b')
    expect(nextQueued(q('a', 'a'), 'a')).toBeNull()
    expect(nextQueued(q('b', 'a', 'c', 'a'), 'a')?.dir).toBe('c')
  })
})

describe('confirmation and slot rules', () => {
  it('confirms mid-song (playing, paused, error) and starts directly once ended', () => {
    expect(nextNeedsConfirmation('playing')).toBe(true)
    expect(nextNeedsConfirmation('paused')).toBe(true)
    expect(nextNeedsConfirmation('error')).toBe(true)
    expect(nextNeedsConfirmation('ended')).toBe(false)
  })
  it('hides Next without a next song, except at the end where it offers a way to choose', () => {
    expect(nextSlot('playing', true)).toBe('next')
    expect(nextSlot('ended', true)).toBe('next')
    expect(nextSlot('playing', false)).toBe('hidden')
    expect(nextSlot('paused', false)).toBe('hidden')
    expect(nextSlot('ended', false)).toBe('choose')
  })
  it('moves focus to Next at the end only when a next song exists, else to Replay', () => {
    expect(endedFocusControl(true)).toBe('next-song')
    expect(endedFocusControl(false)).toBe('play')
  })
})

describe('queue semantics', () => {
  const [a, b, c] = ['a', 'b', 'c']
  it('removes only the song that just played, keeping the order of the rest', () => {
    expect(queueAfterAdvance([a, b, c], a)).toEqual([b, c])
    expect(queueAfterAdvance([a, b, c], b)).toEqual([a, c])
  })
  it('changes nothing when the played song was not queued', () => {
    expect(queueAfterAdvance([a, b], null)).toBeNull()
    expect(queueAfterAdvance([a, b], c)).toBeNull()
    expect(queueAfterAdvance([], a)).toBeNull()
  })
})

describe('copy', () => {
  it('shows the artist only when known', () => {
    expect(songLine('Song', null)).toBe('Song')
    expect(songLine('Song', undefined)).toBe('Song')
    expect(songLine('Song', 'Band')).toBe('Song — Band')
  })
  it('ended copy says what OK does, or that the queue is empty', () => {
    expect(en['box.player.endedNext']).toMatch(/next song/i)
    expect(en['box.player.ended']).toMatch(/queue is empty/i)
  })
})

type Rect = { left: number; top: number; width: number; height: number }
let activeElement: Fake | null = null
/** Element double: just what focus.ts asks of the DOM. */
class Fake {
  readonly children: Fake[] = []
  readonly dataset: Record<string, string> = {}
  parent: Fake | null = null
  disabled = false
  constructor(readonly tagName: string, readonly name: string, private readonly rect: Rect) {}
  append(...children: Fake[]): this { for (const child of children) { child.parent = this; this.children.push(child) } return this }
  private all(): Fake[] { return this.children.flatMap(child => [child, ...child.all()]) }
  getAttribute(): null { return null }
  matches(selector: string): boolean {
    if (selector === ':disabled') return this.disabled
    if (selector === '[inert]') return false
    if (selector === '[data-remote-down]' || selector === '[data-remote-up]') return false
    return false
  }
  closest(selector: string): Fake | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null }
  contains(other: Fake): boolean { return other === this || this.all().includes(other) }
  querySelectorAll(): Fake[] { return this.all().filter(element => element.tagName === 'button' && !element.disabled) }
  getClientRects(): Rect[] { return [this.rect] }
  getBoundingClientRect(): Rect { return { ...this.rect } }
  focus(): void { activeElement = this }
  scrollIntoView(): void {}
}
const as = (element: Fake): HTMLElement => element as unknown as HTMLElement
const button = (name: string, left: number): Fake => new Fake('button', name, { left, top: 900, width: 60, height: 40 })

beforeEach(() => {
  activeElement = null
  vi.stubGlobal('HTMLElement', Fake)
  vi.stubGlobal('document', { get activeElement() { return activeElement } })
})
afterEach(() => vi.unstubAllGlobals())

describe('remote reaches Next from the ended state', () => {
  // Player bar order: Back 5 · Replay(Play) · Forward 5 · Next · Mix · Queue
  function endedBar(): { scope: Fake; play: Fake; forward5: Fake; next: Fake; mix: Fake } {
    const scope = new Fake('div', 'player', { left: 0, top: 0, width: 1920, height: 1080 })
    const back5 = button('back5', 800), play = button('play', 880), forward5 = button('forward5', 960)
    const next = button('next-song', 1040), mix = button('mix', 1200), queue = button('queue', 1280)
    scope.append(back5, play, forward5, next, mix, queue)
    return { scope, play, forward5, next, mix }
  }
  it('Right from Replay passes Forward 5 and reaches Next; Left returns; Right continues to Mix', () => {
    const { scope, play, forward5, next, mix } = endedBar()
    play.focus()
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(forward5)
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(next)
    moveSpatialFocus(as(scope), 'ArrowLeft')
    expect(activeElement).toBe(forward5)
    moveSpatialFocus(as(scope), 'ArrowRight')
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(mix)
  })
  it('a disabled Next (no next song) is skipped, so focus never lands on it', () => {
    const { scope, forward5, next, mix } = endedBar()
    next.disabled = true
    forward5.focus()
    moveSpatialFocus(as(scope), 'ArrowRight')
    expect(activeElement).toBe(mix)
  })
})
