import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Transcriber } from '../../src/main/lyrics'
import { lyricSweepProgress, MIN_WORD_S, sweepEnds } from '../../src/renderer/src/audio/lyric-timing'

const lines = [{ start: 1, end: 2, text: 'Real cached words', words: [{ w: 'Real', s: 1, e: 1.4 }, { w: 'cached', s: 1.45, e: 1.8 }, { w: 'words', s: 1.85, e: 2 }] }]

async function fixture(cache: unknown): Promise<{ song: string; lyrics: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'singz-box-lyrics-'))
  const song = join(dir, 'missing-original.wav')
  const lyrics = join(dir, 'lyrics.json')
  await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 2, name: 'Stem only', songFile: 'missing-original.wav', settings: { transpose: 0, tracks: {} } }))
  await writeFile(lyrics, JSON.stringify(cache))
  return { song, lyrics }
}

describe('cache-only Box lyrics', () => {
  it('reads a stem-only project cache without search, transcription, downloads or writes', async () => {
    const { song, lyrics } = await fixture({ source: 'edited', aligned: true, lines })
    const before = await readFile(lyrics, 'utf8')
    const transcriber = new Transcriber()
    const internal = transcriber as unknown as {
      searchOnline: () => Promise<unknown>
      ensureQwen: () => Promise<unknown>
      writeCache: () => Promise<unknown>
    }
    const search = vi.spyOn(internal, 'searchOnline').mockRejectedValue(new Error('search must not run'))
    const qwen = vi.spyOn(internal, 'ensureQwen').mockRejectedValue(new Error('transcription must not run'))
    const write = vi.spyOn(internal, 'writeCache').mockRejectedValue(new Error('write must not run'))
    const result = await transcriber.readCached(song)
    expect(result).toMatchObject({ ok: true, cached: true, source: 'edited', aligned: true, lines })
    expect(search).not.toHaveBeenCalled()
    expect(qwen).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(await readFile(lyrics, 'utf8')).toBe(before)
  })

  it('returns an explicit miss for absent or invalid caches', async () => {
    const empty = await fixture({ source: 'edited', lines: [] })
    expect(await new Transcriber().readCached(empty.song)).toEqual({ ok: true, cached: false })
    const invalid = await fixture('{not json')
    expect(await new Transcriber().readCached(invalid.song)).toEqual({ ok: true, cached: false })
  })

  it.each([{ source: 'future', lines }, 'invalid'])('never searches or overwrites an unparseable existing cache', async cache => {
    const { song, lyrics } = await fixture(cache)
    const before = await readFile(lyrics, 'utf8')
    const transcriber = new Transcriber()
    const search = vi.spyOn(transcriber as unknown as { searchOnline: () => Promise<unknown> }, 'searchOnline')
    const result = await transcriber.resolve(song, 12, false, 'auto', () => undefined)
    expect(result).toMatchObject({ ok: false })
    expect(result.ok ? '' : result.error).not.toBe('main.error.existingLyricsUnreadable')
    expect(search).not.toHaveBeenCalled()
    expect(await readFile(lyrics, 'utf8')).toBe(before)
  })

  it('treats a readable cache with no lines as a miss, as before', async () => {
    const { song } = await fixture({ source: 'edited', lines: [] })
    const transcriber = new Transcriber()
    const search = vi.spyOn(transcriber as unknown as { searchOnline: () => Promise<unknown> }, 'searchOnline')
      .mockRejectedValue(new Error('search reached'))
    const result = await transcriber.resolve(song, 12, false, 'auto', () => undefined).catch((error: Error) => error)
    expect(search).toHaveBeenCalled()
    expect(result instanceof Error ? result.message : result.ok ? '' : result.error).not.toMatch(/could not be read/)
  })

  it('preserves malformed JSON during automatic resolve', async () => {
    const { song, lyrics } = await fixture({})
    await writeFile(lyrics, '{invalid')
    const transcriber = new Transcriber()
    const search = vi.spyOn(transcriber as unknown as { searchOnline: () => Promise<unknown> }, 'searchOnline')
    expect(await transcriber.resolve(song, 12, false, 'auto', () => undefined)).toMatchObject({ ok: false })
    expect(search).not.toHaveBeenCalled()
    expect(await readFile(lyrics, 'utf8')).toBe('{invalid')
  })

  it('leaves Desktop resolve cache behavior intact', async () => {
    const { song } = await fixture({ source: 'edited', aligned: true, lines })
    const result = await new Transcriber().resolve(song, 12, false, 'auto', () => undefined)
    expect(result).toMatchObject({ ok: true, cached: true, source: 'edited', lines })
  })
})


describe('strict synchronized lyric timing', () => {
  it('accepts small rounding differences and preserves legacy zero spans without synthesizing timings', async () => {
    const cache = {
      source: 'edited',
      lines: [{ start: 1, end: 2, text: 'Hello', words: [{ w: 'Hello', s: 0.98, e: 0.98 }, { w: 'there', s: 1.1, e: 2.04 }] }]
    }
    const { song } = await fixture(cache)
    const result = await new Transcriber().readCached(song)
    expect(result).toMatchObject({ ok: true, cached: true, lines: [{ ...cache.lines[0], words: [{ w: 'Hello', s: 1, e: 1 }, { w: 'there', s: 1.1, e: 2 }] }] })
    if (!result.ok || !result.cached) return
    const ends = sweepEnds(result.lines)[0]
    expect(ends[0] - result.lines[0].words[0].s).toBeCloseTo(0.1)
    expect(ends[0] - result.lines[0].words[0].s).toBeGreaterThanOrEqual(MIN_WORD_S)
    expect(lyricSweepProgress(result.lines[0].words[0], ends[0], 1)).toBeCloseTo(0)
  })
})
