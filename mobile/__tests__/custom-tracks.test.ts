/**
 * Tracks the singer added on the desktop, as the phone sees them: what counts
 * as a trustworthy entry in project.json, and how loadProject turns them into
 * lanes. Playing them is verified on a real simulator
 * (mobile/tests/custom-track.cjs) — here it is the loading logic around it.
 */
import { customTracks, type ProjectSettings } from '../src/model'

const base = (custom: unknown): ProjectSettings =>
  ({ transpose: 0, tracks: {}, custom } as unknown as ProjectSettings)

describe('which added tracks a phone will trust', () => {
  it('takes a normal desktop-written entry', () => {
    expect(
      customTracks(
        base([{ id: 'custom-harmony', label: 'Harmony', color: '#c7e06a', file: 'stems/custom-harmony.mp3' }])
      )
    ).toEqual([
      { id: 'custom-harmony', label: 'Harmony', color: '#c7e06a', file: 'stems/custom-harmony.mp3' }
    ])
  })

  it('has none when the project has none', () => {
    expect(customTracks(base(undefined))).toEqual([])
    expect(customTracks(undefined)).toEqual([])
    expect(customTracks(base('not-a-list'))).toEqual([])
  })

  it('refuses anything that is not a plain file in stems/', () => {
    const rejected = [
      // the desktop's in-memory form — an absolute path on someone's computer
      '/Users/singer/Documents/SingZ/Song/stems/custom-harmony.mp3',
      'C:\\Users\\singer\\stems\\custom-harmony.mp3',
      '../../../etc/passwd',
      'stems/../project.json',
      'stems/sub/custom-harmony.mp3',
      'custom-harmony.mp3',
      'stems/',
      ''
    ]
    for (const file of rejected) {
      expect(customTracks(base([{ id: 'custom-harmony', label: 'H', color: '#fff', file }]))).toEqual([])
    }
  })

  it('never lets an added lane shadow a stem, or itself', () => {
    expect(
      customTracks(
        base([
          { id: 'vocals', label: 'Not the vocals', color: '#fff', file: 'stems/custom-x.mp3' },
          { id: 'custom-a', label: 'A', color: '#fff', file: 'stems/custom-a.mp3' },
          { id: 'custom-a', label: 'A again', color: '#fff', file: 'stems/custom-a2.mp3' }
        ])
      ).map((t) => [t.id, t.label])
    ).toEqual([['custom-a', 'A']])
  })

  it('fills in a label and colour when they are missing or junk', () => {
    const [t] = customTracks(
      base([{ id: 'custom-click', file: 'stems/custom-click.wav', color: 'red; drop table' }])
    )
    expect(t.label).toBe('custom-click')
    expect(t.color).toMatch(/^#[0-9a-f]{6}$/i)
  })
})

describe('loadProject builds the lanes', () => {
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

  /** A folder project: six stems on disk plus whatever project.json declares. */
  function setup(custom: unknown, opts: { failing?: string[] } = {}): {
    fetched: string[]
    load: () => Promise<import('../src/projects').LoadedProject>
  } {
    jest.resetModules()
    const fetched: string[] = []
    const { NativeModules } = require('react-native')
    NativeModules.FolderAccess = {
      localFile: async (_p: string, file: string) => {
        fetched.push(file)
        if (opts.failing?.includes(file)) throw new Error(`${file} is not on this phone`)
        return `/cache/${file}`
      },
      readText: async () => '{"lines":[]}'
    }
    jest.doMock('react-native-audio-api', () => ({
      // one second of 48k stereo per lane — enough for the byte accounting
      decodeAudioData: jest.fn(async () => ({ length: 48000, numberOfChannels: 2 })),
      AudioBuffer: jest.fn()
    }))
    const projects = require('../src/projects') as typeof import('../src/projects')
    const entry = {
      dir: 'Song One',
      doc: {
        version: 2,
        name: 'Song One',
        songFile: 'song.mp3',
        savedAt: '2026-01-01T00:00:00.000Z',
        settings: { transpose: 0, tracks: {}, custom }
      },
      stems: { vocals: 'flac', drums: 'flac' },
      cached: true,
      bytes: 0,
      hasLyrics: false
    } as unknown as import('../src/projects').ProjectEntry
    return { fetched, load: () => projects.loadProject(entry, 48000, () => {}) }
  }

  it('adds them after the stems, with their desktop name and colour', async () => {
    const { fetched, load } = setup([
      { id: 'custom-harmony', label: 'Harmony', color: '#ff9ad5', file: 'stems/custom-harmony.mp3' }
    ])
    const p = await load()
    await flush()
    expect(p.stems.map((l) => l.id)).toEqual(['vocals', 'drums', 'custom-harmony'])
    expect(fetched).toEqual(['stems/vocals.flac', 'stems/drums.flac', 'stems/custom-harmony.mp3'])
    expect(p.stems[2]).toMatchObject({ label: 'Harmony', color: '#ff9ad5', custom: true })
    // stems keep their own identity — the UI reads TRACK_META for those
    expect(p.stems[0].custom).toBeUndefined()
  })

  it('skips an added track it cannot fetch, and still plays the song', async () => {
    const { load } = setup(
      [
        { id: 'custom-gone', label: 'Gone', color: '#fff', file: 'stems/custom-gone.mp3' },
        { id: 'custom-here', label: 'Here', color: '#fff', file: 'stems/custom-here.mp3' }
      ],
      { failing: ['stems/custom-gone.mp3'] }
    )
    const p = await load()
    expect(p.stems.map((l) => l.id)).toEqual(['vocals', 'drums', 'custom-here'])
  })
})
