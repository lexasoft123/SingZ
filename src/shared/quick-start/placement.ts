export interface GuideRect {
  left: number
  top: number
  width: number
  height: number
}
export interface GuideViewport {
  width: number
  height: number
  top?: number
  bottom?: number
}

/** Place a balloon beside its control, within the usable window on either platform. */
export function placeGuide(
  rect: GuideRect | null,
  viewport: GuideViewport,
  measuredHeight: number
) {
  const gap = 14
  const minY = (viewport.top ?? 0) + gap
  const maxY = viewport.height - (viewport.bottom ?? 0) - gap
  const width = Math.min(360, viewport.width - gap * 2)
  const height = Math.min(measuredHeight, maxY - minY)
  const clampX = (x: number) => Math.max(gap, Math.min(x, viewport.width - width - gap))
  if (!rect)
    return {
      left: clampX((viewport.width - width) / 2),
      top: Math.max(minY, (maxY + minY - height) / 2),
      width,
      maxHeight: maxY - minY,
      side: 'none' as const,
      arrow: 0
    }
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  let side: 'top' | 'bottom' | 'left' | 'right' = 'top'
  let left = clampX(centerX - width / 2)
  let top = rect.top + rect.height + gap
  if (top + height > maxY) {
    if (rect.top - gap - height >= minY) {
      top = rect.top - gap - height
      side = 'bottom'
    } else if (rect.left + rect.width + gap + width <= viewport.width - gap) {
      left = rect.left + rect.width + gap
      top = Math.max(minY, Math.min(centerY - height / 2, maxY - height))
      side = 'left'
    } else if (rect.left - gap - width >= gap) {
      left = rect.left - gap - width
      top = Math.max(minY, Math.min(centerY - height / 2, maxY - height))
      side = 'right'
    } else {
      // Short landscape windows keep a scrollable card on the roomier side.
      const below = maxY - rect.top - rect.height - gap
      const above = rect.top - gap - minY
      side = below >= above ? 'top' : 'bottom'
      const room = Math.max(48, below >= above ? below : above)
      top =
        side === 'top'
          ? rect.top + rect.height + gap
          : Math.max(minY, rect.top - gap - Math.min(height, room))
      return {
        left,
        top,
        width,
        maxHeight: room,
        side,
        arrow: Math.max(20, Math.min(centerX - left, width - 20))
      }
    }
  }
  return {
    left,
    top,
    width,
    maxHeight: maxY - top,
    side,
    arrow: Math.max(
      20,
      Math.min(
        side === 'top' || side === 'bottom' ? centerX - left : centerY - top,
        (side === 'top' || side === 'bottom' ? width : height) - 20
      )
    )
  }
}
