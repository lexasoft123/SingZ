import { describe, expect, it } from 'vitest'
import { lyricLineAt, RemoteKeyGate, shouldHideControls } from '../../src/renderer/src/box/remote'

describe('Box remote wake chord', () => {
  it('consumes the first keydown, every repeat, overlapping keys and all matching releases', () => {
    const gate = new RemoteKeyGate()
    const first = gate.keyDown('Enter', false, true)
    expect(first).toEqual({ consumed: true, wake: true, allowAction: false })
    expect(gate.keyDown('Enter', true, false).allowAction).toBe(false)
    expect(gate.keyDown('ArrowDown', false, false).allowAction).toBe(false)
    expect(gate.keyDown('ArrowDown', true, false).allowAction).toBe(false)
    expect(gate.keyUp('Escape')).toBe(true)
    expect(gate.keyUp('Enter')).toBe(true)
    expect(gate.keyDown('ArrowDown', false, false).allowAction).toBe(false)
    expect(gate.keyUp('ArrowDown')).toBe(true)
    expect(gate.keyDown('Enter', false, false)).toEqual({ consumed: true, wake: false, allowAction: true })
  })

  it('blocks stale repeats and held chords across route and visibility recovery', () => {
    const gate = new RemoteKeyGate()
    expect(gate.keyDown('Backspace', false, true).allowAction).toBe(false)
    gate.recover()
    expect(gate.heldCount).toBe(1)
    expect(gate.keyDown('Backspace', true, false).allowAction).toBe(false)
    expect(gate.keyDown('Enter', false, false).allowAction).toBe(false)
    gate.keyUp('Backspace')
    gate.keyUp('Enter')
    expect(gate.heldCount).toBe(0)
    expect(gate.keyDown('Enter', false, false).allowAction).toBe(true)
    expect(gate.keyDown('MediaPlayPause', true, false).allowAction).toBe(false)
  })

  it('does not hide while paused, held, covered, missing lyrics or before five seconds', () => {
    const base = { playing: true, visible: true, playerActive: true, overlayOpen: false, hasLyrics: true, documentVisible: true }
    expect(shouldHideControls(base, 0, 9999, 5000)).toBe(false)
    expect(shouldHideControls(base, 0, 10000, 5000)).toBe(true)
    expect(shouldHideControls(base, 1, 10000, 5000)).toBe(false)
    expect(shouldHideControls({ ...base, overlayOpen: true }, 0, 10000, 5000)).toBe(false)
    expect(shouldHideControls({ ...base, hasLyrics: false }, 0, 10000, 5000)).toBe(false)
    expect(shouldHideControls({ ...base, playing: false }, 0, 10000, 5000)).toBe(false)
  })

  it('uses real line and word boundaries rather than a mock lyric clock', () => {
    const lines = [{ start: 1, end: 2 }, { start: 3, end: 5 }]
    expect(lyricLineAt(lines, 0)).toBe(0)
    expect(lyricLineAt(lines, 1.1)).toBe(0)
    expect(lyricLineAt(lines, 2.5)).toBe(0)
    expect(lyricLineAt(lines, 3)).toBe(1)
    expect(lyricLineAt(lines, 6)).toBe(1)
  })
})


describe('focus loss with a missing keyup', () => {
  it('allows a fresh direction but not a stale repeat after recovery', () => {
    const gate = new RemoteKeyGate()
    expect(gate.keyDown('Enter', false, false).allowAction).toBe(true)
    gate.recoverFromFocusLoss()
    expect(gate.heldCount).toBe(0)
    expect(gate.keyDown('ArrowDown', false, false).allowAction).toBe(true)
    gate.keyUp('ArrowDown')
    expect(gate.keyDown('Enter', true, false).allowAction).toBe(false)
    expect(gate.keyUp('Enter')).toBe(true)
    expect(gate.keyDown('Enter', false, false).allowAction).toBe(true)
  })
})
