import { describe, expect, it } from 'vitest'
import type { LyricLine, LyricsResult } from '../../src/shared/types'
import {
  lyricsJobProgressed,
  lyricsJobSettled,
  lyricsJobStarted,
  type LyricsState
} from '../../src/renderer/src/lyrics-state'

const lines = (n: number): LyricLine[] =>
  Array.from({ length: n }, (_, i) => ({
    start: i,
    end: i + 1,
    text: `line ${i}`,
    words: [{ w: `line`, s: i, e: i + 0.5 }, { w: `${i}`, s: i + 0.5, e: i + 1 }]
  }))

const showing = (n: number, over: Partial<Extract<LyricsState, { status: 'ready' }>> = {}) =>
  ({ status: 'ready', lines: lines(n), source: 'lrclib', credit: 'Some Band — A Song', ...over }) as LyricsState

const cancelled: LyricsResult = { ok: false, cancelled: true, error: 'Cancelled.' }

describe('cancelling a lyrics job leaves the panel as it was', () => {
  it('puts back the exact lines, source and credit the job started over', () => {
    const before = showing(36)
    const loading = lyricsJobStarted(before)
    expect(loading.status).toBe('loading')

    const after = lyricsJobSettled(loading, cancelled)
    // The same words, not merely as many: a restored panel that re-derived
    // its lines would be a different bug wearing this one's passing test.
    expect(after).toEqual(before)
  })

  it('keeps an alignment verdict and the aligned flag across the cancel', () => {
    const before = showing(4, {
      source: 'edited',
      aligned: true,
      check: { verdict: 'ok', matchedPct: 91, heardPct: 88, method: 'ctc' }
    })
    expect(lyricsJobSettled(lyricsJobStarted(before), cancelled)).toEqual(before)
  })

  it('remembers across progress reports, which is where the job actually spends its time', () => {
    const before = showing(36)
    let state = lyricsJobStarted(before)
    for (const p of [
      { stage: 'preparing', percent: 0 },
      { stage: 'searching', percent: 10 },
      { stage: 'transcribing', percent: 64 }
    ] as const) {
      state = lyricsJobProgressed(state, p)
      expect(state.status).toBe('loading')
    }
    expect(lyricsJobSettled(state, cancelled)).toEqual(before)
  })

  it('carries the memory through a second job started over the first', () => {
    // Check & align pressed while a lookup is still running: what the panel
    // owes on cancel is still the singer's lines, never the progress bar.
    const before = showing(36)
    const first = lyricsJobStarted(before)
    const second = lyricsJobStarted(lyricsJobProgressed(first, { stage: 'searching', percent: 30 }))
    expect(lyricsJobSettled(second, cancelled)).toEqual(before)
  })

  it('survives the model-download prompt and its own Cancel', () => {
    // Check & align on a machine with no speech model answers needsModel in
    // milliseconds — the panel reaches the consent prompt before a Cancel
    // button has ever existed. Saying yes and then stopping the download is
    // still a cancel, and still owes the singer their words.
    const before = showing(36)
    const consent = lyricsJobSettled(lyricsJobStarted(before), {
      ok: false,
      needsModel: { sizeMb: 900, what: 'speech' },
      error: 'need model'
    })
    expect(consent.status).toBe('consent')

    const downloading = lyricsJobStarted(consent) // "Download model & continue"
    const stopped = lyricsJobSettled(
      lyricsJobProgressed(downloading, { stage: 'downloading-model', percent: 42 }),
      cancelled
    )
    expect(stopped).toEqual(before)
  })

  it('goes to idle when there was nothing on screen to put back', () => {
    // A song opened without cached lyrics: cancelling the first lookup has
    // nothing to restore, and the panel offers the ladder again.
    expect(lyricsJobSettled(lyricsJobStarted({ status: 'idle' }), cancelled)).toEqual({ status: 'idle' })
    expect(lyricsJobSettled(lyricsJobStarted({ status: 'error', error: 'no' }), cancelled)).toEqual({
      status: 'idle'
    })
  })
})

describe('every other answer is a verdict and replaces what was showing', () => {
  const before = showing(36)

  it('replaces the lines with the ones a finished job found', () => {
    const res: LyricsResult = { ok: true, cached: false, lines: lines(12), source: 'whisper' }
    expect(lyricsJobSettled(lyricsJobStarted(before), res)).toEqual({
      status: 'ready',
      lines: lines(12),
      source: 'whisper',
      credit: undefined,
      aligned: undefined,
      check: undefined
    })
  })

  it('asks for the model download rather than restoring', () => {
    const res: LyricsResult = { ok: false, needsModel: { sizeMb: 900, what: 'speech' }, error: 'need model' }
    expect(lyricsJobSettled(lyricsJobStarted(before), res)).toEqual({
      status: 'consent',
      sizeMb: 900,
      what: 'speech',
      prev: before // the prompt replaces the lines on screen but remembers them
    })
  })

  it('shows a real failure rather than restoring', () => {
    const res: LyricsResult = { ok: false, error: 'The vocals stem could not be read.' }
    expect(lyricsJobSettled(lyricsJobStarted(before), res)).toEqual({
      status: 'error',
      error: 'The vocals stem could not be read.'
    })
  })

  it('calls an empty transcription a failure, not a restore', () => {
    const res: LyricsResult = { ok: true, cached: false, lines: [], source: 'whisper' }
    expect(lyricsJobSettled(lyricsJobStarted(before), res)).toEqual({
      status: 'error',
      error: 'No words were detected in the vocals.'
    })
  })
})

describe('progress cannot reopen a job that has already answered', () => {
  it('leaves a settled state alone', () => {
    const ready = showing(36)
    expect(lyricsJobProgressed(ready, { stage: 'transcribing', percent: 50 })).toEqual(ready)
    const consent: LyricsState = { status: 'consent', sizeMb: 900 }
    expect(lyricsJobProgressed(consent, { stage: 'preparing', percent: 0 })).toEqual(consent)
  })
})
