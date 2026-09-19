import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkOfEachWord, readHeard, writeHeard } from '../../src/main/lyrics'

/**
 * What Qwen3-ASR heard in a song's vocals is cached beside the song, so a
 * re-align goes straight to the aligner and the Precise tier has a text check.
 * The cache is only as good as its key: separating backing vocals REWRITES the
 * vocals file, and a listen to the old combined vocal would check new lyrics
 * against a voice that is no longer in it. So it is keyed to the file's size
 * and mtime, and to the language the listen was told.
 */
describe('the heard-words cache', () => {
  let dir = ''
  let vocals = ''
  const chunks = [
    { start: 1.5, end: 9.25, text: 'hello darkness my old friend', label: 'English' },
    { start: 12, end: 20, text: "I've come to talk with you again", label: 'English' }
  ]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'singz-heard-'))
    vocals = join(dir, 'vocals.wav')
    await writeFile(vocals, 'the combined vocal')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads back what was written for the same vocals and language', async () => {
    await writeHeard(dir, vocals, 'English', chunks)
    expect(await readHeard(dir, vocals, 'English')).toEqual(chunks)
    // undefined asks for any language — the Precise tier's text check
    expect(await readHeard(dir, vocals)).toEqual(chunks)
  })

  it('a listen told another language is not reused for this one', async () => {
    await writeHeard(dir, vocals, 'English', chunks)
    expect(await readHeard(dir, vocals, 'German')).toBeNull()
    expect(await readHeard(dir, vocals, null)).toBeNull()
  })

  it('a rewritten vocals file invalidates it — size', async () => {
    await writeHeard(dir, vocals, null, chunks)
    await writeFile(vocals, 'the separated lead vocal, which is longer')
    expect(await readHeard(dir, vocals, null)).toBeNull()
  })

  it('a rewritten vocals file invalidates it — same size, new mtime', async () => {
    await writeHeard(dir, vocals, null, chunks)
    await writeFile(vocals, 'the separated vocal')
    const later = new Date(Date.now() + 60_000)
    await utimes(vocals, later, later)
    expect(await readHeard(dir, vocals, null)).toBeNull()
  })

  it('nothing cached, or a cache from another engine or listening version, reads as nothing', async () => {
    expect(await readHeard(dir, vocals)).toBeNull()
    await writeHeard(dir, vocals, null, chunks)
    const good = JSON.parse(await readFile(join(dir, 'heard-words.json'), 'utf8'))
    expect(await readHeard(dir, vocals)).toEqual(chunks)
    await writeFile(join(dir, 'heard-words.json'), JSON.stringify({ ...good, engine: 'whisper-large-v3-turbo' }))
    expect(await readHeard(dir, vocals)).toBeNull()
    // a listen made before the pipeline's stamp moved is not this pipeline's answer
    await writeFile(join(dir, 'heard-words.json'), JSON.stringify({ ...good, version: good.version + 1 }))
    expect(await readHeard(dir, vocals)).toBeNull()
    const { version: _dropped, ...unstamped } = good
    await writeFile(join(dir, 'heard-words.json'), JSON.stringify(unstamped))
    expect(await readHeard(dir, vocals)).toBeNull()
  })
})

describe('chunkOfEachWord', () => {
  it('puts every word in the chunk its provisional start falls in', () => {
    const lines = [
      { start: 1.5, end: 4, text: 'a b', words: [{ w: 'a', s: 1.5, e: 2 }, { w: 'b', s: 3, e: 4 }] },
      { start: 12, end: 14, text: 'c', words: [{ w: 'c', s: 12, e: 14 }] },
      { start: 30, end: 31, text: 'd', words: [{ w: 'd', s: 30, e: 31 }] }
    ]
    expect(chunkOfEachWord(lines, [{ start: 1.5 }, { start: 12 }, { start: 29 }])).toEqual([0, 0, 1, 2])
  })
})
