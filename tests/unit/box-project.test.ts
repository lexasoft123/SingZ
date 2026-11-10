import { describe, expect, it, vi } from 'vitest'
import type { ProjectInfo, ProjectListItem, RegisterResult, SingzApi } from '../../src/shared/types'
import { inspectBoxProject, inspectRegistration, projectMetadata } from '../../src/renderer/src/box/project'
import { queueAdd, queueMove, queueRemove } from '../../src/renderer/src/box/queue-model'
import { PITCH_DETECT_VERSION } from '../../src/renderer/src/audio/melody'
import { KEY_DETECT_VERSION } from '../../src/renderer/src/audio/analysis-contract'
import { keyText } from '../../src/renderer/src/box/metadata'

const stems = { vocals: '/p/vocals.flac', drums: '/p/drums.flac', bass: '/p/bass.flac', other: '/p/other.flac' }
const project = (overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  dir: '/p', name: 'Real song', sourceMissing: true, formatVersion: 2,
  settings: { transpose: 0, tracks: {} }, stems, hasLyrics: true, inLibrary: true,
  ...overrides
})
const registration = (value: ProjectInfo | null): RegisterResult => value
  ? { ok: true, path: '/p/song.mp3', name: value.name, size: 0, project: value }
  : { ok: true, path: '/p/song.mp3', name: 'Raw filename', size: 1 }

describe('Box project readiness and metadata', () => {
  it('accepts verified stems without the original recording', () => {
    const result = inspectRegistration(registration(project()))
    expect(result.readiness).toBe('ready')
    expect(result.project?.sourceMissing).toBe(true)
  })

  it('negative controls: partial, damaged and unverifiable projects never become ready', () => {
    expect(inspectRegistration(registration(project({ stems: undefined }))).readiness).toBe('unprepared')
    expect(inspectRegistration(registration(project({ damaged: ['vocals.flac'] }))).readiness).toBe('damaged')
    expect(inspectRegistration(registration(null)).readiness).toBe('unsupported')
    expect(inspectRegistration({ ok: false, error: 'read failed' }).readiness).toBe('error')
  })

  it('uses only current structured analysis and never guesses artist from a filename', () => {
    const melody = { detVersion: PITCH_DETECT_VERSION, hopSec: 0.1, f0: '0 1200 2400 1200 0' }
    const value = project({
      settings: {
        transpose: 0,
        tracks: {},
        key: { pc: 9, minor: true, detVersion: KEY_DETECT_VERSION },
        beat: { beats: [0, 0.5, 1], bpm: 120, beatsPerBar: 4, downbeat: 0, source: 'auto' },
        melody
      }
    })
    const metadata = projectMetadata(value, 12)
    expect(metadata.artist).toBeNull()
    expect(metadata.key?.pc).toBe(9)
    expect(keyText(metadata)).toBe('A minor')
    expect(keyText(metadata, 4)).toBe('C♯ minor')
    expect(metadata.bpm).toBe(120)
    expect(metadata.range).toEqual([33, 57])
    expect(metadata.duration).toBe(12)
    expect(projectMetadata(project()).artist).toBeNull()
  })
})

describe('Box queue model', () => {
  const item = (dir: string): ProjectListItem => ({ dir, name: dir, songPath: `${dir}/song.mp3`, savedAt: '', hasStems: true, stemCount: 4, hasLyrics: true, bytes: 1 })
  it('reorders and removes stable IDs without selecting or consuming the active song', () => {
    const a = item('a'), b = item('b'), c = item('c')
    const active = a
    let items = queueAdd(queueAdd(queueAdd([], a), b), c)
    items = queueMove(items, 'c', -1)
    expect(items.map(entry => entry.dir)).toEqual(['a', 'c', 'b'])
    const removed = queueRemove(items, active.dir)
    expect(removed.items.map(entry => entry.dir)).toEqual(['c', 'b'])
    expect(removed.focus).toBe('c')
    expect(active.dir).toBe('a')
    expect(queueAdd(removed.items, b)).toBe(removed.items)
    expect(queueMove(removed.items, 'c', -1)).toBe(removed.items)
  })
})


describe('authoritative catalog readiness', () => {
  const item: ProjectListItem = {
    dir: '/p', name: 'Stem only', songPath: '/p/missing.wav', savedAt: '',
    hasStems: true, stemCount: 4, hasLyrics: true, bytes: 1
  }
  const lyricLines = [{ start: 0, end: 1, text: 'Real', words: [{ w: 'Real', s: 0, e: 1 }] }]

  function apiWith(lyrics: unknown, value = project()): SingzApi {
    return {
      registerSource: vi.fn(async () => registration(value)),
      getCachedLyrics: vi.fn(async () => lyrics),
      getLyrics: vi.fn(async () => { throw new Error('Desktop resolver must not run') })
    } as unknown as SingzApi
  }

  it('accepts a valid stem-only project through the cache-only API', async () => {
    const api = apiWith({ ok: true, cached: true, source: 'edited', lines: lyricLines })
    const result = await inspectBoxProject(api, item)
    expect(result.inspection.readiness).toBe('ready')
    expect(result.inspection.project?.sourceMissing).toBe(true)
    expect(api.getCachedLyrics).toHaveBeenCalledOnce()
    expect(api.getLyrics).not.toHaveBeenCalled()
  })

  it('marks missing or malformed cached lyrics and empty stems as not ready', async () => {
    for (const lyrics of [{ ok: true, cached: false }, { ok: true, cached: true, source: 'edited', lines: [] }]) {
      const api = apiWith(lyrics)
      expect((await inspectBoxProject(api, item)).inspection.readiness).toBe('needs-lyrics')
      expect(api.getLyrics).not.toHaveBeenCalled()
    }
    const api = apiWith({ ok: true, cached: true, source: 'edited', lines: lyricLines }, project({ stems: {} }))
    expect((await inspectBoxProject(api, item)).inspection.readiness).toBe('unprepared')
    expect(api.getCachedLyrics).not.toHaveBeenCalled()
  })
})
