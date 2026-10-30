import { useModalLock } from '@singz/ui'
import { useLayoutEffect, useRef, useState } from 'react'
import { useLocale } from '../i18n'
import { quickStartCopy } from '../../../shared/quick-start'
import { placeGuide, type GuideRect } from '../../../shared/quick-start/placement'
import './quick-start.css'

interface Step {
  target: string
  title: string
  body: string
}
function visibleTarget(selector: string): Element | undefined {
  return Array.from(document.querySelectorAll(selector)).find((node) => {
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0
  })
}

export default function QuickStart({
  welcome = false,
  onClose
}: {
  welcome?: boolean
  onClose: () => void
}): React.JSX.Element {
  useModalLock()
  const locale = useLocale()
  const copy = quickStartCopy(locale)
  const ru = locale === 'ru'
  const [index, setIndex] = useState(welcome ? -1 : 0)
  const dialog = useRef<HTMLDialogElement>(null)
  const card = useRef<HTMLElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [steps] = useState(() => {
    const candidates: Step[] = [
      { target: '.browse', title: copy.steps.library[0], body: copy.steps.library[1] },
      {
        target: '.lib .src-row:first-child, .lib-head',
        title: ru ? 'Ваша библиотека' : 'Your saved songs',
        body: ru
          ? 'Здесь находятся сохранённые проекты. Выберите песню, чтобы открыть её. После открытия повторите гид кнопкой «?», чтобы познакомиться с управлением песней.'
          : 'Your saved projects live here. Choose a song to open it. Once it opens, replay this guide with ? to explore the player controls.'
      },
      {
        target: '.split-control > button.primary',
        title: copy.steps.split[0],
        body: copy.steps.split[1]
      },
      { target: '.lane-controls', title: copy.steps.stems[0], body: copy.steps.stems[1] },
      {
        target: '.lyrics-panel .lp-header',
        title: copy.steps.lyrics[0],
        body: copy.steps.lyrics[1]
      },
      {
        target: '.transport .karaoke',
        title: ru ? 'Режим караоке' : 'Show the lyrics',
        body: ru
          ? 'Включите караоке этой кнопкой: рядом с дорожками появятся текст песни и индикатор высоты голоса.'
          : 'Turn on Karaoke here to show synced lyrics and the pitch display alongside your tracks.'
      },
      {
        target: '.transport .loop',
        title: copy.steps.practice[0],
        body: ru
          ? 'Выделите фрагмент на волне и включите повтор этой кнопкой, чтобы разучить сложное место.'
          : 'Select a passage on the waveform, then enable Loop here to practise that section repeatedly.'
      },
      {
        target: '.transport-right',
        title: ru ? 'Удобный темп и тональность' : 'Find your tempo and key',
        body: copy.steps.practice[1]
      },
      {
        target: '[data-guide="training"]',
        title: copy.steps.training[0],
        body: copy.steps.training[1]
      },
      { target: '.src-row.sub', title: copy.steps.sync[0], body: copy.steps.sync[1] },
      {
        target: '[data-guide="settings"]',
        title: copy.steps.settings[0],
        body: copy.steps.settings[1]
      }
    ]
    return candidates.filter((step) => visibleTarget(step.target))
  })
  const step = steps[Math.max(0, index)]
  const [layout, setLayout] = useState<{
    rect: GuideRect | null
    placement: ReturnType<typeof placeGuide>
  }>(() => ({
    rect: null,
    placement: placeGuide(null, { width: innerWidth, height: innerHeight }, 260)
  }))

  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const element = dialog.current!
    element.showModal()
    return () => {
      element.close()
      const focus =
        previous?.isConnected && previous !== document.body
          ? previous
          : document.querySelector<HTMLElement>('[data-guide="help"]')
      focus?.focus()
    }
  }, [])

  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true })
    const target = index < 0 || !step ? undefined : visibleTarget(step.target)
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const bounds = target?.getBoundingClientRect()
        const left = Math.max(4, (bounds?.left ?? 0) - 5)
        const top = Math.max(4, (bounds?.top ?? 0) - 5)
        const right = Math.min(innerWidth - 4, (bounds?.right ?? 0) + 5)
        const bottom = Math.min(innerHeight - 4, (bounds?.bottom ?? 0) + 5)
        const rect =
          bounds && right > left && bottom > top
            ? { left, top, width: right - left, height: bottom - top }
            : null
        setLayout({
          rect,
          placement: placeGuide(
            rect,
            { width: innerWidth, height: innerHeight },
            card.current?.scrollHeight ?? 260
          )
        })
      })
    }
    const observer = new ResizeObserver(measure)
    if (target) observer.observe(target)
    if (card.current) observer.observe(card.current)
    addEventListener('resize', measure)
    addEventListener('scroll', measure, true)
    measure()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      removeEventListener('resize', measure)
      removeEventListener('scroll', measure, true)
    }
  }, [index, step, locale])
  const { rect, placement } = layout
  return (
    <dialog
      ref={dialog}
      className="quick-start-overlay"
      aria-labelledby="quick-start-title"
      aria-describedby="quick-start-body"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const buttons = Array.from(
          dialog.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
        )
        const first = buttons[0],
          last = buttons.at(-1)
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === heading.current)
        ) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
    >
      <svg className="quick-start-shade" width="100%" height="100%" aria-hidden="true">
        <defs>
          <mask id="singz-guide-mask">
            <rect width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left}
                y={rect.top}
                width={rect.width}
                height={rect.height}
                rx="8"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,.7)" mask="url(#singz-guide-mask)" />
        {rect && (
          <rect
            data-guide-highlight
            x={rect.left}
            y={rect.top}
            width={rect.width}
            height={rect.height}
            rx="8"
            fill="none"
            stroke="#ffa028"
            strokeWidth="2"
          />
        )}
      </svg>
      <section
        ref={card}
        className="quick-start-balloon"
        style={{
          left: placement.left,
          top: placement.top,
          width: placement.width,
          maxHeight: placement.maxHeight
        }}
      >
        {rect && (
          <span
            className={`quick-start-arrow ${placement.side}`}
            style={
              placement.side === 'top' || placement.side === 'bottom'
                ? { left: placement.arrow }
                : { top: placement.arrow }
            }
          />
        )}
        <div className="quick-start-scroll">
          <div className="quick-start-eyebrow">
            {copy.title}
            {index >= 0 && ` · ${index + 1} / ${steps.length}`}
          </div>
          <h2 id="quick-start-title" ref={heading} tabIndex={-1}>
            {index < 0 ? copy.welcome : step?.title}
          </h2>
          <p id="quick-start-body">
            {index < 0
              ? ru
                ? 'Подсказки покажут настоящие кнопки и панели на этом экране. Гид можно повторить в настройках или кнопкой «?».'
                : 'Follow the balloons beside the controls on this screen. Replay the guide from Settings or with ? at any time.'
              : step?.body}
          </p>
          <div className="quick-start-actions">
            <button type="button" className="pill ghost small" onClick={onClose}>
              {index < 0 ? copy.later : copy.skip}
            </button>
            <div>
              {index > 0 && (
                <button
                  type="button"
                  className="pill ghost small"
                  onClick={() => setIndex(index - 1)}
                >
                  {copy.back}
                </button>
              )}
              <button
                type="button"
                className="pill primary small"
                onClick={() => (index === steps.length - 1 ? onClose() : setIndex(index + 1))}
              >
                {index < 0 ? copy.start : index === steps.length - 1 ? copy.done : copy.next}
              </button>
            </div>
          </div>
        </div>
      </section>
    </dialog>
  )
}
