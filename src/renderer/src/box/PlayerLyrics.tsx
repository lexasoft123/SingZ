import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { LyricLine } from '../../../shared/types'
import { sweepEnds, lyricSweepProgress } from '../audio/lyric-timing'
import { lyricLineAt } from './remote'
import { LYRIC_FEATHER, LYRIC_GLOW_PAD, LYRIC_GLOW_BLUR, lyricHighlightMasks, lyricInkGeometry, lyricPaintPosition, lyricScrollShouldSnap, lyricScrollStep, lyricWindow, shapedWordWidth, setLyricSinging, singingCountdown, type SingingCountdown } from './player-lyrics-model'
import { t } from './i18n'
import { lyricPaintAllowed, watchLyricPaint, watchLyricTransform } from './player-lyrics-loop'

const masks = lyricHighlightMasks()
const highlightStyle = {
  '--lyric-amber-mask': masks.amber, '--lyric-core-mask': masks.core,
  '--lyric-glow-mask': masks.glow
} as CSSProperties

export function PlayerLyrics({ lines, position, playing, rate }: {
  lines: LyricLine[]; position: number; playing: boolean; rate: number
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null)
  const sample = useRef({ position, playing, rate, at: 0 })
  const [current, setCurrent] = useState(() => lyricLineAt(lines, position))
  const active = useRef(current)
  const [countdown, setCountdown] = useState<SingingCountdown>(() => singingCountdown(lines, position, playing, true))
  const lastCountdown = useRef(countdown)
  const ends = useMemo(() => sweepEnds(lines), [lines])
  const widths = useRef(new WeakMap<HTMLElement, { width: number; pixels: number; paint?: string; band?: boolean }>())
  const words = useRef<HTMLElement[]>([]), activeRow = useRef<HTMLElement | null>(null)
  const layout = useRef({ lines, heights: new Map<number, number>(), centers: new Map<number, number>(), line: current })
  const motion = useRef({ offset: 0, target: 0, at: 0, ready: false, snap: true, painted: NaN })
  const moving = useCallback(() => motion.current.offset !== motion.current.target, [])
  const paint = useCallback((time: number): void => {
    if (!lyricPaintAllowed()) return
    const value = sample.current
    const pos = lyricPaintPosition(value.position, value.at, time, value.playing, value.rate)
    const line = lyricLineAt(lines, pos)
    if (active.current !== line) { active.current = line; setCurrent(line) }
    const next = singingCountdown(lines, pos, value.playing, true), previous = lastCountdown.current
    if (previous?.target !== next?.target || previous?.dots !== next?.dots || previous?.seconds !== next?.seconds) {
      lastCountdown.current = next; setCountdown(next)
    }
    if (activeRow.current) {
      const started = String(pos >= (lines[Number(activeRow.current.dataset.line)]?.start ?? Infinity))
      if (activeRow.current.dataset.started !== started) activeRow.current.dataset.started = started
    }
    const scroll = motion.current
    if (scroll.ready) {
      // A new active row commits its measured target in the layout effect. Keep
      // seek intent until then; elapsed time before that target is not easing time.
      if (layout.current.line === line) {
        scroll.offset = lyricScrollStep(scroll.offset, scroll.target, (time - scroll.at) / 1000, scroll.snap)
        scroll.snap = false
      }
      scroll.at = time
      if (scroll.painted !== scroll.offset && track.current) {
        track.current.style.transform = `translateY(${-scroll.offset}px)`
        scroll.painted = scroll.offset
      }
    }
    for (const element of words.current) {
      const lineIndex = Number(element.dataset.line), index = Number(element.dataset.lyricWord)
      const word = lines[lineIndex]?.words[index]
      if (!word) continue
      const p = Math.round(lyricSweepProgress(word, ends[lineIndex][index], pos + .15) * 200) / 200
      const singing = pos + .15 >= word.s && pos + .15 < word.e
      const measured = widths.current.get(element)
      // Activity must retire even when wrapping makes single-run geometry unavailable.
      setLyricSinging(element, singing, measured !== undefined)
      if (measured === undefined) continue
      if (measured.band !== (p > 0)) {
        measured.band = p > 0
        element.style.setProperty('--lyric-band-opacity', p > 0 ? '1' : '0')
      }
      const geometry = lyricInkGeometry(measured.width, p)
      const edge = Math.round(geometry.edge * measured.pixels) / measured.pixels
      const pen = Math.round(geometry.pen * measured.pixels) / measured.pixels
      const key = `${edge}:${pen}`
      if (measured.paint === key) continue
      measured.paint = key
      element.style.setProperty('--lyric-edge', `${edge}px`)
      element.style.setProperty('--lyric-pen', `${pen}px`)
    }
  }, [lines, ends])

  // All layout reads are confined here: line/window, font and viewport changes.
  // A fixed 68px layout lets CSS scale rows without invalidating shaped advances.
  const measure = useCallback((): void => {
    if (!lyricPaintAllowed() || !root.current) return
    const state = layout.current, scroll = motion.current
    if (state.lines !== lines) {
      state.lines = lines; state.heights.clear(); state.centers.clear(); scroll.ready = false
    }
    const slots = Array.from(root.current.querySelectorAll<HTMLElement>('[data-lyric-line]'))
    const oldCenter = state.centers.get(state.line)
    const paragraphHeights = new Map<number, number>()
    for (const slot of slots) {
      const index = Number(slot.dataset.lyricLine)
      state.heights.set(index, slot.offsetHeight + 28)
      paragraphHeights.set(index, slot.querySelector('p')?.offsetHeight ?? 82)
    }
    const viewport = root.current.clientHeight
    const tops = new Map<number, number>()
    let top = 0
    for (let index = 0; index < lines.length; index++) {
      tops.set(index, top)
      state.centers.set(index, top + 40 + (paragraphHeights.get(index) ?? ((state.heights.get(index) ?? 150) - 68)) / 2)
      top += state.heights.get(index) ?? 150
    }
    // Removing an old window row must not move the overlapping rows on screen.
    if (scroll.ready && oldCenter !== undefined) scroll.offset += (state.centers.get(state.line) ?? oldCenter) - oldCenter
    scroll.target = (state.centers.get(active.current) ?? viewport / 2) - viewport / 2
    scroll.snap ||= !scroll.ready || lyricScrollShouldSnap(state.line, active.current, false)
    scroll.ready = true; state.line = active.current
    activeRow.current = root.current.querySelector('.player-lyric.current')
    words.current = Array.from(root.current.querySelectorAll<HTMLElement>('.current [data-lyric-word]'))
    // Range measures the actual shaped glyph run, excluding the following space.
    // Normalize both the outer TV transform and the animated row scale.
    for (const element of words.current) {
      const width = shapedWordWidth(element)
      element.dataset.multiline = String(width === null)
      if (width === null) widths.current.delete(element)
      else {
        const local = Number.parseFloat(getComputedStyle(element).width)
        const scale = element.getBoundingClientRect().width / local
        widths.current.set(element, { width, pixels: Math.max(.01, scale * (window.devicePixelRatio || 1)) })
      }
    }
    for (const slot of slots) slot.style.top = `${tops.get(Number(slot.dataset.lyricLine)) ?? 0}px`
    paint(performance.now())
  }, [lines, paint])

  useLayoutEffect(() => {
    const now = performance.now(), previous = sample.current
    if (previous.at && Math.abs(position - lyricPaintPosition(previous.position, previous.at, now, previous.playing, previous.rate)) > .5) motion.current.snap = true
    sample.current = { position, playing, rate, at: now }
    paint(now)
  }, [position, playing, rate, paint])
  useLayoutEffect(() => {
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    root.current?.querySelectorAll<HTMLElement>('[data-lyric-line]').forEach(element => observer?.observe(element))
    document.fonts?.addEventListener('loadingdone', measure)
    window.addEventListener('resize', measure)
    const stopTransform = watchLyricTransform(root.current, measure)
    return () => { stopTransform(); observer?.disconnect(); document.fonts?.removeEventListener('loadingdone', measure); window.removeEventListener('resize', measure) }
  }, [current, measure])
  useEffect(() => watchLyricPaint(root.current, playing, paint, measure, moving), [playing, current, paint, measure, moving])

  return <div ref={root} className="player-lyrics" style={{ '--lyric-glow-pad': `${LYRIC_GLOW_PAD}px`, '--lyric-glow-blur': `${LYRIC_GLOW_BLUR}px`, '--lyric-feather-start': `${-LYRIC_FEATHER}px` } as CSSProperties} aria-label={t('box.player.lyrics')}>
    <div ref={track} className="player-lyrics-track">
    {lyricWindow(current, lines.length).map(index => {
      const line = lines[index], offset = index - current
      return <div key={`${index}-${line.start}`} className="player-lyric-slot" data-context={Math.abs(offset) > 1 ? 'outside' : 'visible'} data-lyric-line={index}>
        {countdown?.target === index && <div className="player-singing-countdown" aria-hidden="true" data-countdown-target={countdown.target}>
          {countdown.seconds > 0 ? <span>{countdown.seconds} s</span> : [0, 1, 2].map(dot => <i key={dot} data-lit={dot < countdown.dots} />)}
        </div>}
        <p key="text" data-line={index} className={`player-lyric ${offset === 0 ? 'current' : offset < 0 ? 'past' : 'up-next'}`} aria-hidden="true">
        {line.words.length > 0 ? line.words.map((word, wordIndex) => <span key={wordIndex} className="player-shaped-word" style={highlightStyle} data-line={index} data-lyric-word={wordIndex}>
          <span className="lyric-ink-halo" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-glow" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-base">{word.w}</span>
          <span className="lyric-ink-amber" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-core" aria-hidden="true">{word.w}</span>
          {wordIndex < line.words.length - 1 && <span className="lyric-word-space"> </span>}
        </span>) : line.text}
        </p>
      </div>
    })}
    </div>
    <div className="player-sr" aria-live="polite">{lines[current]?.text ?? ''}</div>
  </div>
}
