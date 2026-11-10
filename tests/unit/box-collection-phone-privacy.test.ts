import { describe, expect, it } from 'vitest'
import type { ProjectInfo, ProjectListItem } from '../../src/shared/types'
import { BoxPhoneProjection, sanitizeControllerCommand } from '../../src/renderer/src/box/collection/phone'
import type { CollectionEntry } from '../../src/renderer/src/box/collection/types'
import type { BoxActiveSong, BoxTransportSnapshot } from '../../src/renderer/src/box/transport'

const item = (dir: string): ProjectListItem => ({
  dir, name: 'Song', songPath: `${dir}/song.wav`, savedAt: '', hasStems: true, stemCount: 1, hasLyrics: true, bytes: 1
})
const active = (dir: string, trackId: string): BoxActiveSong => ({
  item: item(dir),
  project: {
    dir, name: 'Song', settings: { transpose: 0, tracks: {} }, stems: { vocals: `${dir}/vocals.flac` }, hasLyrics: true, inLibrary: true
  } as ProjectInfo,
  metadata: { artist: null, key: null, bpm: null, range: null, duration: 10 },
  lyrics: { status: 'ready', lines: [{ start: 0, end: 1, text: 'Line', words: [] }] }
})
const snapshot = (dir: string, trackId: string): BoxTransportSnapshot => ({
  active: active(dir, trackId), loadingName: null, committing: false, lastError: null, saveError: null,
  position: 0, duration: 10, playing: false, starting: false,
  tracks: [{ id: trackId, volume: 1, muted: false, solo: false }], masterVolume: 1,
  transpose: 0, tempo: 1, playbackError: null, appliedOutputUid: null, applyingOutput: false,
  outputError: null, routingBlocked: false, restartRequired: false
})
const entries = (dirs: string[]): CollectionEntry[] => dirs.map(dir => ({ id: `local:${dir}`, remoteId: null, name: 'Song', local: item(dir) }))

describe('phone snapshot privacy and bounds', () => {
  it('never exposes a path-bearing custom stem id and rejects its old public id after a song change', () => {
    const projection = new BoxPhoneProjection()
    const privateId = '/Users/private/somefile'
    const first = projection.snapshot(entries(['/a']), [], {}, snapshot('/a', privateId))
    const publicId = first.stems[0].id
    expect(publicId).toMatch(/^stem-/)
    expect(first.stems[0].label).toBe('Track')
    expect(JSON.stringify(first)).not.toContain('/Users/private')
    expect(projection.stemTarget('/a', publicId)).toBe(privateId)

    projection.snapshot(entries(['/b']), [], {}, snapshot('/b', 'vocals'))
    expect(projection.stemTarget('/b', publicId)).toBeNull()
    expect(JSON.stringify(first)).not.toContain(privateId)
  })

  it('keeps active and queued songs when truncating a large public catalog', () => {
    const projection = new BoxPhoneProjection()
    const many = Array.from({ length: 2005 }, (_, index) => `/song-${index}`)
    const refs = [{ kind: 'local' as const, dir: '/song-2004' }]
    projection.update(refs, true)
    const result = projection.snapshot(entries(many), refs, {}, snapshot('/song-2003', 'vocals'))
    expect(result.songs.length).toBe(2000)
    expect(result.queue.length).toBe(1)
    expect(result.songs.some(song => song.id === result.activeProjectId)).toBe(true)
    expect(result.songs.some(song => song.id === result.queue[0].projectId)).toBe(true)
  })

  it('preserves the shared +12 dB master gain while clamping stems to unity', () => {
    const master = sanitizeControllerCommand({ type: 'volume', target: 'master', value: 100 })
    const stem = sanitizeControllerCommand({ type: 'volume', target: 'stem-1', value: 100 })
    expect(master).toEqual({ type: 'volume', target: 'master', value: 10 ** 0.6 })
    expect(stem).toEqual({ type: 'volume', target: 'stem-1', value: 1 })
  })
})
