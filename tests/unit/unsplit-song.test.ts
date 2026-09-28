import { describe, expect, it } from 'vitest'
import { filesOfProject } from '../../mobile/src/current'
import { isDownloaded } from '../../mobile/src/projects'
import { audioSignature } from '../../mobile/src/publish'
import type { ProjectDoc } from '../../mobile/src/model'
import type { ProjectEntry } from '../../mobile/src/projects'

const hash = (md5: string, size: number): { md5: string; size: number; mtimeMs: number } => ({
  md5,
  size,
  mtimeMs: 0
})

/** A song as the phone stores it. `songFile` is the track the singer added. */
const doc = (over: Partial<ProjectDoc>): ProjectDoc =>
  ({
    version: 2,
    name: 'a song',
    songFile: 'song.mp3',
    savedAt: '2026-09-27T00:00:00.000Z',
    settings: {},
    ...over
  }) as ProjectDoc

const split = doc({
  stemHashes: { 'vocals.flac': hash('v', 10), 'drums.flac': hash('d', 20) },
  songHash: hash('src', 999)
})
const unsplit = doc({ songHash: hash('src', 999) })

// Some tracks are meant to be sung over whole — a vocal exercise is not a song
// to separate — so a project with no stems is not an unfinished one. Its SOURCE
// track is its audio. Everything here exists because the Drive half of that
// case used to be impossible: the move was refused, and had it not been, both
// listing constructors returned null for a stemless folder and the song would
// have gone up and then been invisible.
describe('a song with no stems', () => {
  it('is made of its source track', () => {
    expect(filesOfProject(unsplit).map((f) => f.path)).toEqual(['song.mp3'])
  })

  it('states that track at the size and md5 the doc names', () => {
    expect(filesOfProject(unsplit)[0]).toMatchObject({ path: 'song.mp3', size: 999, md5: 'src' })
  })

  it('has an identity of its own, so a second copy is recognised', () => {
    // Without this a stemless song signed as '' — falsy — and every caller
    // reads that as "no duplicate known", so the same song would be uploaded
    // again on every offer.
    expect(audioSignature(unsplit)).toBe('song:src')
    expect(audioSignature(unsplit)).not.toBe('')
  })

  it('counts as downloaded from Drive once its source track is there', () => {
    const entry = {
      dir: 'd',
      doc: unsplit,
      stems: {},
      cached: false,
      expect: { 'song.mp3': 999 },
      bytes: 999,
      hasLyrics: false,
      source: 'gdrive'
    } as ProjectEntry
    expect(isDownloaded(entry, { project: 'd', bytes: 999, files: 1, sizes: { 'song.mp3': 999 } })).toBe(true)
    expect(isDownloaded(entry, { project: 'd', bytes: 0, files: 0, sizes: {} })).toBe(false)
  })
})

describe('a split song is unchanged by any of it', () => {
  it('is made of its stems, and does NOT want the source track', () => {
    // The doc states songHash for every project, but a phone only needs the
    // source when it is the audio. Claiming it here would tell every phone
    // that every song it already holds is incomplete and send the whole
    // library back to Drive for files it will never play.
    expect(filesOfProject(split).map((f) => f.path).sort()).toEqual([
      'stems/drums.flac',
      'stems/vocals.flac'
    ])
  })

  it('still signs by its stems', () => {
    expect(audioSignature(split)).toBe('d,v')
  })
})

// What the singer actually has on the phone. "Add a song" writes the original
// TWICE on purpose — song.<ext> is the desktop's contract, and
// stems/custom-original.<ext> is the lane that plays before any split — so a
// track the library calls "not split yet" already has playable audio named in
// stemHashes. It is stemless only in the SIX-stem sense the listing uses.
describe('a song added on the phone and never split', () => {
  const added = doc({
    stemHashes: { 'custom-original.mp3': hash('orig', 500) },
    songHash: hash('src', 500),
    settings: { custom: [{ id: 'custom-original', label: 'Original', file: 'stems/custom-original.mp3' }] }
  } as Partial<ProjectDoc>)

  it('is made of its lane, NOT of the source track as well', () => {
    // Both files hold the same audio. Wanting both would make the phone
    // download this song twice over.
    expect(filesOfProject(added).map((f) => f.path)).toEqual(['stems/custom-original.mp3'])
  })

  it('signs by that lane, so a second copy is still recognised', () => {
    expect(audioSignature(added)).toBe('orig')
  })
})

describe('a doc that states nothing', () => {
  it('is made of no files and cannot be signed', () => {
    const bare = doc({})
    expect(filesOfProject(bare)).toEqual([])
    expect(audioSignature(bare)).toBe('')
  })
})
