import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { LyricLine } from '../../../shared/types'
import { sweepEnds, lyricSweepProgress } from '../audio/lyric-timing'
import { lyricLineAt } from './remote'
import { LYRIC_FEATHER, LYRIC_GLOW_PAD, LYRIC_GLOW_BLUR, lyricHighlightMasks, LYRIC_ROW_SCALE, type LyricGlide, lyricInkGeometry, lyricPaintPosition, lyricScrollShouldSnap, LYRIC_GLIDE, createLyricGlide, retargetLyricGlide, sampleLyricGlide, lyricWindow, shapedWordWidth, setLyricSinging, singingCountdown, type SingingCountdown } from './player-lyrics-model'
import { t } from './i18n'
import { deferLyricMeasure, lyricPaintAllowed, watchLyricPaint, watchLyricTransform } from './player-lyrics-loop'

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
  const [windowLine, setWindowLine] = useState(current)
  const active = useRef(current)
  const [countdown, setCountdown] = useState<SingingCountdown>(() => singingCountdown(lines, position, playing, true))
  const lastCountdown = useRef(countdown)
  const ends = useMemo(() => sweepEnds(lines), [lines])
  const widths = useRef(new WeakMap<HTMLElement, { width: number; pixels: number; paint?: string; band?: boolean }>())
  const geometryKeys = useRef(new WeakMap<HTMLElement, string>())
  const words = useRef<HTMLElement[]>([]), activeRow = useRef<HTMLElement | null>(null)
  const layout = useRef({ lines, heights: new Map<number, number>(), centers: new Map<number, number>(), line: current, viewport: 0 })
  const motion = useRef({ ...createLyricGlide(0), ready: false, snap: true, painted: NaN })
  const rows = useRef(new Map<number, { element: HTMLElement; scale: LyricGlide; opacity: LyricGlide; painted: string }>())
  const layoutDirty = useRef(true), requestMeasure = useRef<() => void>(() => {})
  const deferredRequired = useRef(false)
  const targetRows = useCallback((now: number, snap: boolean): void => {
    for (const [index, row] of rows.current) {
      const scale = index === active.current ? 1 : LYRIC_ROW_SCALE
      const opacity = index === active.current ? 1 : index < active.current ? .45 : .72
      if (snap || row.scale.target !== scale) retargetLyricGlide(row.scale, scale, now, snap)
      if (snap || row.opacity.target !== opacity) retargetLyricGlide(row.opacity, opacity, now, snap)
      if (snap) row.painted = '' // settled motion still needs its snapped DOM style applied
    }
  }, [])
  const moving = useCallback(() => {
    if (motion.current.offset !== motion.current.target) return true
    for (const row of rows.current.values()) if (row.scale.offset !== row.scale.target || row.opacity.offset !== row.opacity.target) return true
    return false
  }, [])
  const paint = useCallback((time: number): void => {
    if (!lyricPaintAllowed()) return
    const value = sample.current
    const pos = lyricPaintPosition(value.position, value.at, time, value.playing, value.rate)
    const line = lyricLineAt(lines, pos)
    if (active.current !== line) {
      active.current = line; setCurrent(line)
      if (lyricScrollShouldSnap(layout.current.line, line, motion.current.snap)) setWindowLine(line)
    }
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
      if (layout.current.line === line) {
        if (scroll.snap) { retargetLyricGlide(scroll, scroll.target, time, true); scroll.snap = false }
        if (scroll.offset !== scroll.target) sampleLyricGlide(scroll, time)
      }
      if (scroll.painted !== scroll.offset && track.current) {
        track.current.style.transform = `translateY(${-scroll.offset}px)`
        scroll.painted = scroll.offset
      }
    }
    for (const row of rows.current.values()) {
      if (row.painted && row.scale.offset === row.scale.target && row.opacity.offset === row.opacity.target) continue
      const scale = sampleLyricGlide(row.scale, time).offset, opacity = sampleLyricGlide(row.opacity, time).offset
      const key = `${scale}:${opacity}`
      if (row.painted !== key) {
        row.element.style.transform = `scale(${scale})`
        row.element.style.opacity = String(opacity)
        row.painted = key
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
    if (!lyricPaintAllowed() || !root.current) { layoutDirty.current = true; return }
    layoutDirty.current = false
    const state = layout.current, scroll = motion.current
    if (state.lines !== lines) {
      state.lines = lines; state.heights.clear(); state.centers.clear(); rows.current.clear(); scroll.ready = false
    }
    const slots = Array.from(root.current.querySelectorAll<HTMLElement>('[data-lyric-line]'))
    const oldCenter = state.centers.get(state.line)
    const paragraphHeights = new Map<number, number>()
    for (const slot of slots) {
      const index = Number(slot.dataset.lyricLine)
      state.heights.set(index, slot.offsetHeight + 28)
      paragraphHeights.set(index, slot.querySelector('p')?.offsetHeight ?? 82)
    }
    const mounted = new Set(slots.map(slot => Number(slot.dataset.lyricLine)))
    for (const index of rows.current.keys()) if (!mounted.has(index)) rows.current.delete(index)
    for (const slot of slots) {
      const index = Number(slot.dataset.lyricLine), element = slot.querySelector<HTMLElement>('.player-lyric-scale')!
      const existing = rows.current.get(index)
      if (existing && existing.element !== element) { existing.element = element; existing.painted = '' }
      if (!existing) rows.current.set(index, { element,
        scale: createLyricGlide(index === active.current ? 1 : LYRIC_ROW_SCALE),
        opacity: createLyricGlide(index === active.current ? 1 : index < active.current ? .45 : .72), painted: '' })
    }
    const snap = !scroll.ready || scroll.snap || lyricScrollShouldSnap(state.line, active.current, false)
    targetRows(performance.now(), snap)
    const viewport = root.current.clientHeight
    state.viewport = viewport
    const tops = new Map<number, number>()
    let top = 0
    for (let index = 0; index < lines.length; index++) {
      tops.set(index, top)
      state.centers.set(index, top + 40 + (paragraphHeights.get(index) ?? ((state.heights.get(index) ?? 150) - 68)) / 2)
      top += state.heights.get(index) ?? 150
    }
    // Removing an old window row must not move the overlapping rows on screen.
    if (scroll.ready && oldCenter !== undefined) {
      const delta = (state.centers.get(state.line) ?? oldCenter) - oldCenter
      scroll.offset += delta; scroll.from += delta; scroll.target += delta
    }
    const target = (state.centers.get(active.current) ?? viewport / 2) - viewport / 2
    if (target !== scroll.target || snap) retargetLyricGlide(scroll, target, performance.now(), snap)
    scroll.snap = false; scroll.ready = true; state.line = active.current
    activeRow.current = root.current.querySelector('.player-lyric.current')
    words.current = Array.from(root.current.querySelectorAll<HTMLElement>('.current [data-lyric-word]'))
    // Range measures the actual shaped glyph run, excluding the following space.
    // Normalize both the outer TV transform and the animated row scale.
    // The pixel grid is cached at full row size: the animated context scale is
    // divided out, so a row that grows into the current line keeps an exact grid
    // without reading animated bounds during the glide. Font/viewport/TV-transform
    // invalidation refreshes this cache.
    const available = root.current.clientWidth
    const rowFactors = new Map<HTMLElement, number>()
    for (const slot of slots) {
      const wrapper = slot.querySelector<HTMLElement>('.player-lyric-scale')
      if (!wrapper || !wrapper.offsetWidth || !slot.offsetWidth) continue
      const factor = (wrapper.getBoundingClientRect().width / wrapper.offsetWidth) / (slot.getBoundingClientRect().width / slot.offsetWidth)
      if (Number.isFinite(factor) && factor > 0) rowFactors.set(slot, factor)
    }
    for (const element of root.current.querySelectorAll<HTMLElement>('[data-lyric-word]')) {
      const key = `${available}:${element.textContent}`
      if (geometryKeys.current.get(element) === key) continue
      geometryKeys.current.set(element, key)
      const width = shapedWordWidth(element)
      element.dataset.multiline = String(width === null)
      if (width === null) widths.current.delete(element)
      else {
        const local = Number.parseFloat(getComputedStyle(element).width)
        const slot = element.closest<HTMLElement>('[data-lyric-line]')
        const scale = element.getBoundingClientRect().width / local / ((slot && rowFactors.get(slot)) || 1)
        const pixels = Math.max(.01, scale * (window.devicePixelRatio || 1)), cached = widths.current.get(element)
        if (!cached || cached.width !== width || cached.pixels !== pixels) widths.current.set(element, { width, pixels })
      }
    }
    for (const slot of slots) slot.style.top = `${tops.get(Number(slot.dataset.lyricLine)) ?? 0}px`
    paint(performance.now())
  }, [lines, paint, targetRows])

  useLayoutEffect(() => {
    const now = performance.now(), previous = sample.current
    if (previous.at && Math.abs(position - lyricPaintPosition(previous.position, previous.at, now, previous.playing, previous.rate)) > .5) { motion.current.snap = true; targetRows(now, true) }
    sample.current = { position, playing, rate, at: now }
    paint(now)
  }, [position, playing, rate, paint, targetRows])
  // Current changes use premeasured centers/words only. Newly mounted tail
  // geometry is measured after the first motion frame, never in this commit.
  useLayoutEffect(() => {
    const state = layout.current, scroll = motion.current, now = performance.now()
    deferredRequired.current = scroll.ready && state.lines === lines && !lyricScrollShouldSnap(state.line, current, scroll.snap)
    if (!deferredRequired.current) { measure(); return }
    activeRow.current = root.current?.querySelector('.player-lyric.current') ?? null
    words.current = Array.from(root.current?.querySelectorAll<HTMLElement>('.current [data-lyric-word]') ?? [])
    targetRows(now, lyricScrollShouldSnap(state.line, current, scroll.snap))
    retargetLyricGlide(scroll, (state.centers.get(current) ?? state.viewport / 2) - state.viewport / 2, now,
      lyricScrollShouldSnap(state.line, current, scroll.snap))
    scroll.snap = false; state.line = current
    paint(now)
  }, [current, lines, measure, paint, targetRows])
  useLayoutEffect(() => {
    if (deferredRequired.current && windowLine === active.current) { measure(); deferredRequired.current = false }
  }, [windowLine, measure])
  useLayoutEffect(() => {
    const deferred = deferLyricMeasure(() => {
      if (windowLine !== active.current) setWindowLine(active.current)
      else measure()
    }), defer = deferred.schedule
    requestMeasure.current = defer
    const invalidate = (): void => { layoutDirty.current = true; geometryKeys.current = new WeakMap(); defer() }
    if (deferredRequired.current) defer()
    let initialResize = true
    const resized = (): void => {
      // observe() reports existing boxes once; this commit already measured or
      // queued them. Later size changes (including wrapped text edits) matter.
      if (initialResize) { initialResize = false; return }
      layoutDirty.current = true; defer()
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resized)
    root.current?.querySelectorAll<HTMLElement>('[data-lyric-line]').forEach(element => observer?.observe(element))
    document.fonts?.addEventListener('loadingdone', invalidate)
    window.addEventListener('resize', invalidate)
    const stopTransform = watchLyricTransform(root.current, invalidate)
    return () => { deferred.stop(); stopTransform(); observer?.disconnect(); document.fonts?.removeEventListener('loadingdone', invalidate); window.removeEventListener('resize', invalidate) }
  }, [current, windowLine, measure])
  useEffect(() => watchLyricPaint(root.current, playing, paint, () => { if (layoutDirty.current) requestMeasure.current(); paint(performance.now()) }, moving), [playing, current, paint, moving])

  return <div ref={root} className="player-lyrics" style={{ '--lyric-glide-duration': `${LYRIC_GLIDE.duration}ms`, '--lyric-glide-curve': LYRIC_GLIDE.curve, '--lyric-glow-pad': `${LYRIC_GLOW_PAD}px`, '--lyric-glow-blur': `${LYRIC_GLOW_BLUR}px`, '--lyric-feather-start': `${-LYRIC_FEATHER}px` } as CSSProperties} aria-label={t('box.player.lyrics')}>
    <div ref={track} className="player-lyrics-track">
    {lyricWindow(windowLine, lines.length).map(index => {
      const line = lines[index], offset = index - current
      return <div key={`${index}-${line.start}`} className="player-lyric-slot" data-context={Math.abs(offset) > 1 ? 'outside' : 'visible'} data-lyric-line={index}>
        {countdown?.target === index && <div className="player-singing-countdown" aria-hidden="true" data-countdown-target={countdown.target}>
          {countdown.seconds > 0 ? <span>{countdown.seconds} s</span> : [0, 1, 2].map(dot => <i key={dot} data-lit={dot < countdown.dots} />)}
        </div>}
        <div key="visual" className="player-lyric-scale"><p key="text" data-line={index} className={`player-lyric ${offset === 0 ? 'current' : offset < 0 ? 'past' : 'up-next'}`} aria-hidden="true">
        {line.words.length > 0 ? line.words.map((word, wordIndex) => <span key={wordIndex} className="player-shaped-word" style={highlightStyle} data-line={index} data-lyric-word={wordIndex}>
          <span className="lyric-ink-halo" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-glow" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-base">{word.w}</span>
          <span className="lyric-ink-amber" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-core" aria-hidden="true">{word.w}</span>
          {wordIndex < line.words.length - 1 && <span className="lyric-word-space"> </span>}
        </span>) : line.text}
        </p></div>
      </div>
    })}
    </div>
    <div className="player-sr" aria-live="polite">{lines[current]?.text ?? ''}</div>
  </div>
}
