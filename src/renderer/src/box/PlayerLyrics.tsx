import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LyricLine } from '../../../shared/types'
import { sweepEnds, lyricSweepProgress } from '../audio/lyric-timing'
import { lyricLineAt } from './remote'
import { lyricInkGeometry, lyricPaintPosition, shapedWordWidth, setLyricSinging, singingCountdown, type SingingCountdown } from './player-lyrics-model'
import { t } from './i18n'
import { lyricPaintAllowed, watchLyricPaint, watchLyricTransform } from './player-lyrics-loop'

export function PlayerLyrics({ lines, position, playing, rate }: {
  lines: LyricLine[]; position: number; playing: boolean; rate: number
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const sample = useRef({ position, playing, rate, at: 0 })
  const [current, setCurrent] = useState(() => lyricLineAt(lines, position))
  const [countdown, setCountdown] = useState<SingingCountdown>(() => singingCountdown(lines, position, playing, true))
  const ends = useMemo(() => sweepEnds(lines), [lines])
  const widths = useRef(new WeakMap<HTMLElement, { width: number; pixels: number }>())
  const paint = useCallback((time: number): void => {
    if (!lyricPaintAllowed()) return
    const value = sample.current
    const pos = lyricPaintPosition(value.position, value.at, time, value.playing, value.rate)
    const line = lyricLineAt(lines, pos)
    setCurrent(previous => previous === line ? previous : line)
    const next = singingCountdown(lines, pos, value.playing, true)
    setCountdown(previous => previous?.target === next?.target && previous?.dots === next?.dots && previous?.seconds === next?.seconds ? previous : next)
    root.current?.querySelectorAll<HTMLElement>('[data-lyric-word]').forEach(element => {
      const lineIndex = Number(element.dataset.line), index = Number(element.dataset.lyricWord)
      const word = lines[lineIndex]?.words[index]
      if (!word) return
      const p = Math.round(lyricSweepProgress(word, ends[lineIndex][index], pos + .15) * 200) / 200
      const singing = pos + .15 >= word.s && pos + .15 < word.e
      const measured = widths.current.get(element)
      // Activity must retire even when wrapping makes single-run geometry unavailable.
      setLyricSinging(element, singing, measured !== undefined)
      if (measured === undefined) return
      const geometry = lyricInkGeometry(measured.width, p)
      const edge = Math.round(geometry.edge * measured.pixels) / measured.pixels
      const pen = Math.round(geometry.pen * measured.pixels) / measured.pixels
      const key = `${edge}:${pen}:${singing}`
      if (element.dataset.paint === key) return
      element.dataset.paint = key
      element.style.setProperty('--lyric-edge', `${edge}px`)
      element.style.setProperty('--lyric-pen', `${pen}px`)
    })
  }, [lines, ends])

  // Range measures the actual shaped glyph run, excluding the following space.
  // Normalize the outer TV transform using the enclosing local layout width.
  const measure = useCallback((): void => {
    if (!lyricPaintAllowed()) return
    root.current?.querySelectorAll<HTMLElement>('[data-lyric-word]').forEach(element => {
      const width = shapedWordWidth(element)
      element.dataset.multiline = String(width === null)
      if (width === null) widths.current.delete(element)
      else {
        const local = Number.parseFloat(getComputedStyle(element).width)
        const scale = element.getBoundingClientRect().width / local
        widths.current.set(element, { width, pixels: Math.max(.01, scale * (window.devicePixelRatio || 1)) })
      }
      delete element.dataset.paint
    })
    paint(performance.now())
  }, [paint])

  useLayoutEffect(() => {
    sample.current = { position, playing, rate, at: performance.now() }
    paint(sample.current.at)
  }, [position, playing, rate, paint])
  useLayoutEffect(() => {
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    root.current?.querySelectorAll<HTMLElement>('[data-lyric-word]').forEach(element => observer?.observe(element))
    document.fonts?.addEventListener('loadingdone', measure)
    window.addEventListener('resize', measure)
    const stopTransform = watchLyricTransform(root.current, measure)
    return () => { stopTransform(); observer?.disconnect(); document.fonts?.removeEventListener('loadingdone', measure); window.removeEventListener('resize', measure) }
  }, [current, measure])
  useEffect(() => watchLyricPaint(root.current, playing, paint, measure), [playing, paint, measure])

  return <div ref={root} className="player-lyrics" aria-label={t('box.player.lyrics')}>
    {[-1, 0, 1].map(offset => {
      const index = current + offset, line = lines[index]
      return <div key={`${index}-${line?.start ?? 'blank'}`} className="player-lyric-slot" data-lyric-line={index}>
        {countdown?.target === index && <div className="player-singing-countdown" aria-hidden="true" data-countdown-target={countdown.target}>
          {countdown.seconds > 0 ? <span>{countdown.seconds} s</span> : [0, 1, 2].map(dot => <i key={dot} data-lit={dot < countdown.dots} />)}
        </div>}
        <p className={`player-lyric ${offset === 0 ? 'current' : offset < 0 ? 'past' : 'up-next'}`} aria-hidden="true">
        {line ? offset === 0 && line.words.length > 0 ? line.words.map((word, wordIndex) => <span key={wordIndex} className="player-shaped-word" data-line={index} data-lyric-word={wordIndex}>
          <span className="lyric-ink-glow" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-base">{word.w}</span>
          <span className="lyric-ink-amber" aria-hidden="true">{word.w}</span>
          <span className="lyric-ink-core" aria-hidden="true">{word.w}</span>
          {wordIndex < line.words.length - 1 && <span className="lyric-word-space"> </span>}
        </span>) : line.text : '\u00a0'}
        </p>
      </div>
    })}
    <div className="player-sr" aria-live="polite">{lines[current]?.text ?? ''}</div>
  </div>
}
