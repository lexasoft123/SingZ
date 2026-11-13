import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MultitrackEngine } from '../../src/renderer/src/audio/engine'

const hooks = vi.hoisted(() => ({ refs: [] as Array<{ current: unknown }>, effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (current: unknown) => { const ref = { current }; hooks.refs.push(ref); return ref },
  useState: (value: unknown) => [value, () => {}],
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect) }
}))
vi.mock('@singz/ui', () => ({ Button: () => null }))
vi.mock('../../src/renderer/src/model', () => ({ modalCoversApp: () => false }))
vi.mock('../../src/renderer/src/i18n', () => ({ t: (key: string) => key }))

import SongOutput from '../../src/renderer/src/components/SongOutput'
import { MultitrackEngine as Engine } from '../../src/renderer/src/audio/engine'

describe('song output clip polling', () => {
  beforeEach(() => { hooks.refs = []; hooks.effects = [] })
  afterEach(() => vi.unstubAllGlobals())

  function mount() {
    hooks.refs = []; hooks.effects = []
    let poll!: () => void
    vi.stubGlobal('window', { setInterval: (callback: () => void) => { poll = callback; return 1 }, clearInterval: () => {} })
    const status = { generation: '1', transportGeneration: '1', outputPeak: 0.4, outputClippedBlocks: 0 }
    const engine = Object.assign(Object.create(Engine.prototype), {
      nativePlayback: { active: true, status }, _playing: true
    }) as MultitrackEngine
    SongOutput({ engine, volume: 1, onVolume: () => {} })
    const toggle = vi.fn()
    hooks.refs[0].current = { classList: { toggle }, querySelectorAll: () => [], querySelector: () => null }
    const cleanup = hooks.effects[0]()
    return { status, poll: () => poll(), clipped: () => toggle.mock.lastCall?.[1],
      stop: () => Object.assign(engine, { _playing: false }), cleanup }
  }

  it('keeps a clean next song clear through stop, unload and idle bus activity', () => {
    const songA = mount()
    songA.status.outputClippedBlocks = 3
    songA.poll()
    expect(songA.clipped()).toBe(true)
    songA.cleanup?.()

    // App keys SongOutput by song path, so song B gets a fresh clip latch.
    const songB = mount()
    songB.status.generation = songB.status.transportGeneration = '2'
    songB.poll()
    expect(songB.clipped()).toBe(false)
    songB.stop()
    songB.poll()
    expect(songB.clipped()).toBe(false)
    songB.status.generation = songB.status.transportGeneration = '0'
    // Idle training/monitoring can change peak, while the song counter is zero.
    songB.status.outputPeak = 0.891250938
    songB.poll()
    expect(songB.clipped()).toBe(false)
    songB.cleanup?.()
    const songC = mount()
    songC.poll()
    expect(songC.clipped()).toBe(false)
    songC.cleanup?.()
  })

  it('negative control: the old lifetime count relights a clean stopped song', () => {
    const song = mount()
    song.poll()
    expect(song.clipped()).toBe(false)
    song.stop()
    song.status.generation = song.status.transportGeneration = '0'
    song.status.outputClippedBlocks = 3
    song.poll()
    expect(song.clipped()).toBe(true)
    song.cleanup?.()
  })
})
