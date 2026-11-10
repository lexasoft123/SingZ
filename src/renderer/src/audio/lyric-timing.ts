import type { LyricLine, LyricWord } from '../../../shared/types'

export const WORD_BRIDGE_S = 0.35
export const MIN_WORD_S = 0.05

export function sweepEnds(lines: LyricLine[]): number[][] {
  return lines.map(line =>
    line.words.map((word, index) => {
      const to = index + 1 < line.words.length ? line.words[index + 1].s : line.end
      const gap = to - word.e
      return Math.max(gap > 0 && gap < WORD_BRIDGE_S ? to : word.e, word.s + MIN_WORD_S)
    })
  )
}

export function lyricSweepProgress(word: LyricWord, end: number, position: number): number {
  return Math.min(1, Math.max(0, (position - word.s) / (end - word.s)))
}
