import { describe, expect, it } from 'vitest'
import {
  placeGuide,
  type GuideRect,
  type GuideViewport
} from '../../src/shared/quick-start/placement'

describe('guide balloons beside real controls', () => {
  const cases: { name: string; viewport: GuideViewport; target: GuideRect; height: number }[] = [
    {
      name: 'desktop file picker',
      viewport: { width: 1240, height: 800 },
      target: { left: 550, top: 385, width: 140, height: 45 },
      height: 250
    },
    {
      name: 'desktop bottom transport',
      viewport: { width: 1240, height: 800 },
      target: { left: 20, top: 740, width: 44, height: 44 },
      height: 250
    },
    {
      name: 'phone source tabs',
      viewport: { width: 390, height: 844, top: 59, bottom: 34 },
      target: { left: 20, top: 120, width: 350, height: 44 },
      height: 270
    },
    {
      name: 'phone training tab',
      viewport: { width: 390, height: 844, top: 59, bottom: 34 },
      target: { left: 200, top: 720, width: 170, height: 60 },
      height: 290
    },
    {
      name: 'phone lyrics with large text',
      viewport: { width: 390, height: 844, top: 59, bottom: 34 },
      target: { left: 30, top: 310, width: 330, height: 110 },
      height: 440
    },
    {
      name: 'landscape phone',
      viewport: { width: 844, height: 390, top: 0, bottom: 21 },
      target: { left: 14, top: 100, width: 44, height: 44 },
      height: 280
    }
  ]
  it.each(cases)(
    '$name stays visible without covering the highlighted control',
    ({ viewport, target, height }) => {
      const balloon = placeGuide(target, viewport, height)
      const visibleHeight = Math.min(height, balloon.maxHeight)
      expect(balloon.left).toBeGreaterThanOrEqual(0)
      expect(balloon.top).toBeGreaterThanOrEqual(viewport.top ?? 0)
      expect(balloon.left + balloon.width).toBeLessThanOrEqual(viewport.width)
      expect(balloon.top + visibleHeight).toBeLessThanOrEqual(
        viewport.height - (viewport.bottom ?? 0)
      )
      const overlapX =
        Math.min(balloon.left + balloon.width, target.left + target.width) >
        Math.max(balloon.left, target.left)
      const overlapY =
        Math.min(balloon.top + visibleHeight, target.top + target.height) >
        Math.max(balloon.top, target.top)
      expect(overlapX && overlapY).toBe(false)
      expect(balloon.side).not.toBe('none')
    }
  )
})
