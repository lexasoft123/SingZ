import { adoptSplit, SPLIT_STEMS, type AdoptDeps } from '../src/split/adopt'
import type { ProjectDoc } from '../src/model'

/** The doc a P1 add wrote: original lane + its hash, lyrics on record. */
const baseDoc = (): ProjectDoc => ({
  version: 1,
  name: 'Driver test song',
  songFile: 'song.wav',
  savedAt: '2026-08-14T00:00:00.000Z',
  settings: {
    transpose: 0,
    tracks: {},
    custom: [
      { id: 'custom-original', label: 'Original', color: '#d08f2c', file: 'stems/custom-original.wav' }
    ]
  },
  stemHashes: {
    'custom-original.wav': { md5: 'aa', size: 10, mtimeMs: 1 }
  },
  lyricsHash: { md5: 'bb', size: 20, mtimeMs: 2 }
})

interface Trace {
  ops: string[]
  written: ProjectDoc | null
  deps: AdoptDeps
}

function fakeDeps(opts?: { moveFails?: boolean; statFails?: boolean }): Trace {
  const t: Trace = { ops: [], written: null, deps: null as unknown as AdoptDeps }
  t.deps = {
    readText: async () => JSON.stringify(baseDoc()),
    writeText: async (_p, file, text) => {
      t.ops.push(`write:${file}`)
      if (file === 'project.json') t.written = JSON.parse(text) as ProjectDoc
      return true
    },
    moveIntoProject: async (_p, rel) => {
      if (opts?.moveFails) throw new Error('Not a file this app owns')
      t.ops.push(`move:${rel}`)
      return true
    },
    statFile: async (_p, rel) => {
      if (opts?.statFails) throw new Error('missing')
      t.ops.push(`stat:${rel}`)
      return { md5: `md5-${rel}`, size: 100, mtimeMs: 5 }
    },
    deleteFile: async (_p, rel) => {
      t.ops.push(`delete:${rel}`)
      return true
    },
    clearJob: async () => {
      t.ops.push('clearJob')
    }
  }
  return t
}

describe('adoptSplit', () => {
  it('moves six stems, rewrites the doc LAST, then retires the original lane', async () => {
    const t = fakeDeps()
    const r = await adoptSplit('My song', '/job', t.deps)
    expect(r.lanes).toEqual([...SPLIT_STEMS])

    for (const stem of SPLIT_STEMS) {
      expect(t.ops).toContain(`move:stems/${stem}.wav`)
    }
    // Ordering: every move happens before the doc write; the lane file dies
    // only after the doc stops naming it; the job dir goes last.
    const docAt = t.ops.indexOf('write:project.json')
    const lastMove = Math.max(...t.ops.map((o, i) => (o.startsWith('move:') ? i : -1)))
    expect(lastMove).toBeLessThan(docAt)
    expect(t.ops.indexOf('delete:stems/custom-original.wav')).toBeGreaterThan(docAt)
    expect(t.ops.indexOf('clearJob')).toBe(t.ops.length - 1)

    const doc = t.written!
    for (const stem of SPLIT_STEMS) {
      expect(doc.stemHashes![`${stem}.wav`]).toEqual({
        md5: `md5-stems/${stem}.wav`,
        size: 100,
        mtimeMs: 5
      })
    }
    expect(doc.stemHashes!['custom-original.wav']).toBeUndefined()
    expect(doc.settings.custom).toBeUndefined()
    // Untouched facts stay: the adoption edits lanes, not identity.
    expect(doc.name).toBe('Driver test song')
    expect(doc.songFile).toBe('song.wav')
    expect(doc.lyricsHash).toEqual({ md5: 'bb', size: 20, mtimeMs: 2 })
  })

  it('converges when a crashed earlier run already moved the stems', async () => {
    const t = fakeDeps({ moveFails: true })
    const r = await adoptSplit('My song', '/job', t.deps)
    expect(r.lanes).toHaveLength(6)
    expect(t.written).not.toBeNull()
    expect(t.ops.indexOf('clearJob')).toBe(t.ops.length - 1)
  })

  it('still deletes the lane file when settings already lost it (orphan rule)', async () => {
    // A kill between last run's doc write and its delete: settings.custom is
    // gone, but stems/custom-original.wav is still on disk. The name derives
    // from songFile, so the re-run cleans it up anyway.
    const t = fakeDeps()
    const noCustom = { ...baseDoc(), settings: { transpose: 0, tracks: {} } }
    t.deps.readText = async () => JSON.stringify(noCustom)
    await adoptSplit('My song', '/job', t.deps)
    expect(t.ops).toContain('delete:stems/custom-original.wav')
  })

  it('fails honestly when a stem is missing on both sides', async () => {
    const t = fakeDeps({ moveFails: true, statFails: true })
    await expect(adoptSplit('My song', '/job', t.deps)).rejects.toThrow(/drums/)
    expect(t.written).toBeNull()
    expect(t.ops).not.toContain('clearJob')
  })
})
