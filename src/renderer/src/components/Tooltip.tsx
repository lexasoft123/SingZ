import { cloneElement, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** How long the pointer rests on a control before its tooltip shows. Keyboard focus shows it at once. */
export const TIP_DELAY_MS = 400
const GAP = 8
const MARGIN = 6

export interface TipBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a tooltip of `tip` size goes for an anchor: above it when there is room, otherwise below, and
 * horizontally centred on the anchor but kept inside the viewport.
 */
export function placeTip(anchor: TipBox, tip: { width: number; height: number }, viewport: { width: number; height: number }): { left: number; top: number; side: 'above' | 'below' } {
  const above = anchor.top - tip.height - GAP >= MARGIN
  const top = above ? anchor.top - tip.height - GAP : Math.min(anchor.top + anchor.height + GAP, Math.max(MARGIN, viewport.height - tip.height - MARGIN))
  const centred = anchor.left + anchor.width / 2 - tip.width / 2
  const left = Math.max(MARGIN, Math.min(centred, viewport.width - tip.width - MARGIN))
  return { left, top, side: above ? 'above' : 'below' }
}

/**
 * The tooltip's show/hide rules, free of the DOM: a resting pointer shows it after TIP_DELAY_MS, keyboard
 * focus at once; leaving, blur, a press, Esc or a scroll hides it and cancels a pending show.
 */
export class TipController {
  private timer: ReturnType<typeof setTimeout> | null = null
  private hovering = false
  private focused = false
  visible = false
  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly delayMs = TIP_DELAY_MS
  ) {}
  private set(v: boolean): void {
    if (v === this.visible) return
    this.visible = v
    this.onChange(v)
  }
  private cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
  pointerEnter(): void {
    this.hovering = true
    if (this.visible || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.hovering) this.set(true)
    }, this.delayMs)
  }
  pointerLeave(): void {
    this.hovering = false
    this.cancel()
    if (!this.focused) this.set(false)
  }
  /** `keyboard` is false for the focus a mouse press gives: that one must not pop a tooltip over the press. */
  focus(keyboard: boolean): void {
    if (!keyboard) return
    this.focused = true
    this.cancel()
    this.set(true)
  }
  blur(): void {
    this.focused = false
    this.cancel()
    if (!this.hovering) this.set(false)
  }
  /** A press, Esc or a scroll: gone until the pointer or focus comes back. */
  dismiss(): void {
    this.cancel()
    this.set(false)
  }
  dispose(): void {
    this.cancel()
  }
}

/**
 * The app's own tooltip (native `title` tooltips do not show reliably in the packaged window).
 * Wraps one control: a wrapper receives the pointer, so a disabled button still shows its reason.
 * The control keeps its own aria-label; while shown the tooltip is its aria-describedby.
 */
export default function Tooltip({
  label,
  children,
  className = ''
}: {
  label: string
  children: React.ReactElement<{ 'aria-describedby'?: string }>
  /** Extra class on the wrapper (a flexing wrapper for a slider, say). */
  className?: string
}): React.JSX.Element {
  const id = useId()
  const wrap = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; side: 'above' | 'below'; arrow: number } | null>(null)
  const ctl = useRef<TipController | null>(null)
  if (ctl.current === null) ctl.current = new TipController(setVisible)

  useEffect(() => () => ctl.current?.dispose(), [])
  useEffect(() => {
    if (!visible) {
      setPos(null)
      return
    }
    const hide = (): void => ctl.current?.dismiss()
    // Tip-first Esc: a visible tip eats the key (the popup behind it stays open); the next Esc goes through.
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Escape') return
      e.stopPropagation()
      hide()
    }
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [visible])
  useLayoutEffect(() => {
    if (!visible || !wrap.current || !tipRef.current) return
    const a = (wrap.current.firstElementChild ?? wrap.current).getBoundingClientRect() // display: contents wrappers have no box
    const b = tipRef.current.getBoundingClientRect()
    const spot = placeTip({ left: a.left, top: a.top, width: a.width, height: a.height }, { width: b.width, height: b.height }, { width: window.innerWidth, height: window.innerHeight })
    const arrow = Math.max(10, Math.min(b.width - 10, a.left + a.width / 2 - spot.left)) // points at the control even when clamped
    setPos({ ...spot, arrow })
  }, [visible, label])

  const child = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': visible ? [children.props['aria-describedby'], id].filter(Boolean).join(' ') : children.props['aria-describedby'] })
    : children
  return (
    <span
      ref={wrap}
      className={`sz-tip-wrap ${className}`.trim()}
      onPointerEnter={(e) => {
        if (e.pointerType !== 'touch') ctl.current?.pointerEnter()
      }}
      onPointerLeave={() => ctl.current?.pointerLeave()}
      onFocus={(e) => {
        let keyboard = true
        try {
          keyboard = (e.target as Element).matches(':focus-visible')
        } catch {
          /* old engines: treat as keyboard */
        }
        ctl.current?.focus(keyboard)
      }}
      onBlur={() => ctl.current?.blur()}
    >
      {child}
      {visible &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className={`sz-tip${pos ? ` ${pos.side}` : ''}`}
            style={pos ? ({ left: pos.left, top: pos.top, ['--tip-arrow' as string]: `${pos.arrow}px` } as React.CSSProperties) : { left: 0, top: 0, visibility: 'hidden' }}
          >
            {label}
          </div>,
          document.body
        )}
    </span>
  )
}
