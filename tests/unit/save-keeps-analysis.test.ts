import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { saveProject } from '../../src/main/projects'
import { writeSettings } from '../../src/main/settings'

/**
 * A save must never remove an analysis the project already had.
 *
 * The renderer serialises `beat` and `melody` out of its own state, and that
 * state is null while a song is still loading or still being analysed. A save
 * landing in that window used to write a project with no grid — Dreamer and
 * Nothing Else Matters both lost theirs during a library-wide pass, minutes
 * of pYIN and beat tracking gone with nothing in the file to say why.
 *
 * Nothing in the app deletes a grid on purpose, so absent always means "not
 * there yet". These tests hold the line at the only place the file is
 * actually overwritten.
 */

const STEMS_6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

const BEAT = {
  beats: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
  bpm: 120,
  beatsPerBar: 4,
  downbeat: 0,
  downbeats: [0, 4],
  source: 'auto' as const,
  detVersion: 18
}
const MELODY = { hopSec: 0.01, f0: 'x40' }
const KEY = { pc: 7, minor: true, detVersion: 2 }

async function project(withAnalysis: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'singz-keep-'))
  writeSettings({ projectsRoot: root })
  const dir = join(root, 'Song')
  await mkdir(join(dir, 'stems'), { recursive: true })
  await writeFile(
    join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      name: 'Song',
      songFile: 'song.mp3',
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: {
        transpose: 0,
        tracks: {},
        ...(withAnalysis ? { beat: BEAT, melody: MELODY, key: KEY } : {})
      }
    })
  )
  await writeFile(join(dir, 'song.mp3'), 'pretend-audio')
  for (const s of STEMS_6) await writeFile(join(dir, 'stems', `${s}.flac`), `fLaC-${s}`)
  return dir
}

const read = async (dir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))

const bare = { transpose: 0, tracks: {}, custom: [] } as never

describe('saveProject never drops an analysis it already had', () => {
  it('keeps the beat grid when the save carries none', async () => {
    const dir = await project(true)
    const res = await saveProject(join(dir, 'song.mp3'), 'Song', bare)
    expect(res.ok).toBe(true)
    const doc = await read(dir)
    const s = (doc.settings as Record<string, unknown>)
    expect(s.beat).toBeDefined()
    expect((s.beat as typeof BEAT).downbeats).toEqual([0, 4])
    expect((s.beat as typeof BEAT).detVersion).toBe(18)
  })

  it('keeps the melody line too — it costs the same minutes to recompute', async () => {
    const dir = await project(true)
    await saveProject(join(dir, 'song.mp3'), 'Song', bare)
    const s = (await read(dir)).settings as Record<string, unknown>
    expect(s.melody).toEqual(MELODY)
  })

  it('keeps the stored key — a save mid-estimation must not delete it', async () => {
    const dir = await project(true)
    await saveProject(join(dir, 'song.mp3'), 'Song', bare)
    const s = (await read(dir)).settings as Record<string, unknown>
    expect(s.key).toEqual(KEY)
  })

  it('still lets a real grid overwrite the stored one', async () => {
    const dir = await project(true)
    const next = { ...BEAT, bpm: 90, downbeats: [0, 3, 6] }
    await saveProject(join(dir, 'song.mp3'), 'Song', { ...bare, beat: next } as never)
    const s = (await read(dir)).settings as Record<string, unknown>
    expect((s.beat as typeof BEAT).bpm).toBe(90)
    expect((s.beat as typeof BEAT).downbeats).toEqual([0, 3, 6])
  })

  it('writes no grid when there was none to keep — a reject stays a reject', async () => {
    const dir = await project(false)
    await saveProject(join(dir, 'song.mp3'), 'Song', bare)
    const s = (await read(dir)).settings as Record<string, unknown>
    expect(s.beat).toBeUndefined()
  })
})
