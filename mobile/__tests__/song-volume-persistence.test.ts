import { SongVolumePersistence, SONG_VOLUME_KEY } from '../src/playback/song-volume-persistence'
import type { ProjectDoc } from '../src/model'

const doc = (gain = 1): ProjectDoc => ({ version: 2, name: 'Song', songFile: 'song.flac', savedAt: '', settings: { transpose: 2, tracks: {}, masterVolume: gain } })
function harness() {
  const preferences = new Map<string, string>()
  const projects = new Map<string, ProjectDoc>([['a', doc()], ['b', doc()]])
  const api = {
    getPreference: jest.fn(async (key: string) => preferences.get(key) ?? null),
    setPreference: jest.fn(async (key: string, text: string) => { preferences.set(key, text) }),
    readText: jest.fn(async (dir: string) => JSON.stringify(projects.get(dir))),
    writeText: jest.fn(async (dir: string, _file: string, text: string) => { projects.set(dir, JSON.parse(text)); return true })
  }
  return { preferences, projects, api, store: new SongVolumePersistence(api) }
}
describe('per-song output durability', () => {
  it('re-reads a completed phone save instead of adopting a pre-save catalog snapshot', async () => {
    const h = harness()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = h.api.writeText.getMockImplementation()!
    h.api.writeText.mockImplementationOnce(async (...args) => { await gate; return original(...args) })
    const writing = h.store.save({ source: 'phone', dir: 'a' }, 2)
    const opening = h.store.resolve({ source: 'phone', dir: 'a' }, doc(1))
    release()
    await writing
    expect((await opening).settings.masterVolume).toBe(2)
  })

  it('writes boosted and muted gains independently and preserves unrelated song settings', async () => {
    const h = harness()
    await Promise.all([h.store.save({ source: 'phone', dir: 'a' }, 10 ** .6), h.store.save({ source: 'phone', dir: 'b' }, 0)])
    expect(h.projects.get('a')?.settings).toEqual({ transpose: 2, tracks: {}, masterVolume: 10 ** .6 })
    expect(h.projects.get('b')?.settings.masterVolume).toBe(0)
    expect(JSON.parse(h.preferences.get(SONG_VOLUME_KEY)!).entries).toEqual({})
  })
  it('journals a refused phone write, replays it after a fresh instance, and keeps the song playable', async () => {
    const h = harness()
    h.api.writeText.mockResolvedValue(false)
    await expect(h.store.save({ source: 'phone', dir: 'a' }, 2)).rejects.toThrow()
    const reopened = new SongVolumePersistence(h.api)
    const resolved = await reopened.resolve({ source: 'phone', dir: 'a' }, doc())
    expect(resolved.settings.masterVolume).toBe(2)
    expect(h.preferences.get(SONG_VOLUME_KEY)).toContain('"gain":2')
  })
  it('scopes read-only overrides by Drive account and picked root, without writing their documents', async () => {
    const h = harness()
    h.preferences.set('singz.gdrive.email', 'a@example.com')
    await h.store.save({ source: 'gdrive', dir: 'same' }, 2)
    h.preferences.set('singz.gdrive.email', 'b@example.com')
    expect((await h.store.resolve({ source: 'gdrive', dir: 'same' }, doc(.5))).settings.masterVolume).toBe(.5)
    await h.store.resolve({ source: 'picked', root: 'first', dir: 'same' }, doc())
    await h.store.save({ source: 'picked', root: 'first', dir: 'same' }, 0)
    expect((await h.store.resolve({ source: 'picked', root: 'second', dir: 'same' }, doc())).settings.masterVolume).toBe(1)
    expect((await h.store.resolve({ source: 'picked', root: 'first', dir: 'same' }, doc())).settings.masterVolume).toBe(0)
    expect(h.api.writeText).not.toHaveBeenCalled()
  })
  it('adopts a changed desktop gain over a phone override and retains it after restart', async () => {
    const h = harness()
    h.preferences.set('singz.gdrive.email', 'a@example.com')
    const ref = { source: 'gdrive' as const, dir: 'The Music Of The Night' }
    await h.store.resolve(ref, doc(1))
    await h.store.save(ref, .5)
    expect((await h.store.resolve(ref, doc(1))).settings.masterVolume).toBe(.5)
    expect((await h.store.resolve(ref, doc(2))).settings.masterVolume).toBe(2)
    expect((await h.store.resolve(ref, doc(2))).settings.masterVolume).toBe(2)
    expect((await new SongVolumePersistence(h.api).resolve(ref, doc(2))).settings.masterVolume).toBe(2)
    expect(h.api.writeText).not.toHaveBeenCalled()
  })
  it('migrates old phone overrides when an explicit desktop gain arrives', async () => {
    const h = harness()
    h.preferences.set('singz.gdrive.email', 'a@example.com')
    const ref = { source: 'gdrive' as const, dir: 'song' }
    const key = JSON.stringify(['gdrive', 'a@example.com', 'song'])
    h.preferences.set(SONG_VOLUME_KEY, JSON.stringify({ version: 1, entries: { [key]: { gain: .5, at: 1 } } }))
    const old = doc(); delete old.settings.masterVolume
    expect((await h.store.resolve(ref, old)).settings.masterVolume).toBe(.5)
    expect((await h.store.resolve(ref, doc(2))).settings.masterVolume).toBe(2)
    expect((await h.store.resolve(ref, doc(2))).settings.masterVolume).toBe(2)
  })
  it('does not alias unidentified folders into another song override', async () => {
    const h = harness()
    await expect(h.store.save({ source: 'readonly', dir: 'a' }, 2)).rejects.toThrow()
    await expect(h.store.save({ source: 'picked', dir: 'a' }, 2)).rejects.toThrow()
    expect(h.api.setPreference).not.toHaveBeenCalled()
  })
  it('keeps future preference formats intact and rejects edits instead of erasing them', async () => {
    const h = harness()
    const future = JSON.stringify({ version: 42, entries: { future: true } })
    h.preferences.set(SONG_VOLUME_KEY, future)
    expect((await h.store.resolve({ source: 'picked', root: 'r', dir: 'a' }, doc(.7))).settings.masterVolume).toBe(.7)
    await expect(h.store.save({ source: 'picked', root: 'r', dir: 'a' }, 0)).rejects.toThrow()
    expect(h.preferences.get(SONG_VOLUME_KEY)).toBe(future)
  })
})
