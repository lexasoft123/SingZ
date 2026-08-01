/**
 * The ✓ in the library and the download on open must answer the same question
 * from the same facts. They did not: the ✓ added up bytes on disk while the
 * open compared checksums, so a song could sit there ticked and then download
 * itself — 100 MB a song, over mobile data, for a library already on the phone.
 */
import { isDownloaded, type CacheUsage, type ProjectEntry } from '../src/projects'

const entry = (expect_: Record<string, number>): ProjectEntry =>
  ({
    dir: 'Song One',
    doc: { name: 'Song One' },
    stems: { vocals: 'flac', drums: 'flac' },
    cached: false,
    expect: expect_,
    bytes: Object.values(expect_).reduce((n, s) => n + s, 0),
    hasLyrics: true,
    source: 'gdrive'
  }) as unknown as ProjectEntry

const onPhone = (sizes: Record<string, number>): CacheUsage => ({
  project: 'Song One',
  bytes: Object.values(sizes).reduce((n, s) => n + s, 0),
  files: Object.keys(sizes).length,
  sizes
})

const SONG = { 'stems/vocals.flac': 100, 'stems/drums.flac': 200 }

describe('the downloaded ✓', () => {
  it('lights up when every file the project names is here at its size', () => {
    expect(isDownloaded(entry(SONG), onPhone(SONG))).toBe(true)
  })

  it('stays a cloud when a stem is missing, however the bytes add up', () => {
    // the classic: an old stem left behind covers for one still in the cloud
    const have = onPhone({ 'stems/vocals.flac': 100, 'stems/old-mix.flac': 900 })
    expect(isDownloaded(entry(SONG), have)).toBe(false)
  })

  it('stays a cloud on a half-written file of the right name', () => {
    const have = onPhone({ 'stems/vocals.flac': 100, 'stems/drums.flac': 60 })
    expect(isDownloaded(entry(SONG), have)).toBe(false)
  })

  it('counts the tracks the singer added, not just the six stems', () => {
    const withTrack = { ...SONG, 'stems/custom-harmony.mp3': 50 }
    expect(isDownloaded(entry(withTrack), onPhone(SONG))).toBe(false)
    expect(isDownloaded(entry(withTrack), onPhone(withTrack))).toBe(true)
  })

  it('says no when nothing is on the phone at all', () => {
    expect(isDownloaded(entry(SONG), undefined)).toBe(false)
  })

  it('says no for a project that names no files — nothing to have', () => {
    expect(isDownloaded(entry({}), onPhone(SONG))).toBe(false)
  })

  it('lets a folder library answer for itself', () => {
    const local = { ...entry(SONG), source: undefined, cached: true, expect: undefined }
    expect(isDownloaded(local as ProjectEntry, undefined)).toBe(true)
  })
})
