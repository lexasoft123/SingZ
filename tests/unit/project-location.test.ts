import { access, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deleteProject,
  detectProject,
  importProject,
  renameProject,
  saveProject
} from '../../src/main/projects'
import { writeSettings } from '../../src/main/settings'

const STEMS_6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

/** Point the library at a fresh empty folder and return it. */
async function makeLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'singz-lib-'))
  writeSettings({ projectsRoot: root })
  return root
}

/** Somewhere that is emphatically not the library: a shared or copied folder. */
async function makeElsewhere(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'singz-elsewhere-'))
}

async function makeProject(parent: string, name: string): Promise<string> {
  const dir = join(parent, name)
  await mkdir(join(dir, 'stems'), { recursive: true })
  await writeFile(
    join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      name,
      songFile: 'song.mp3',
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: { transpose: 0, tracks: {} }
    })
  )
  await writeFile(join(dir, 'song.mp3'), 'pretend-audio')
  for (const s of STEMS_6) await writeFile(join(dir, 'stems', `${s}.flac`), `fLaC-${s}`)
  await writeFile(join(dir, 'lyrics.json'), '{}')
  return dir
}

async function gone(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

describe('projects outside the library root stay put', () => {
  it('detectProject flags whether the folder is in the library', async () => {
    const root = await makeLibrary()
    const mine = await makeProject(root, 'My Song')
    const theirs = await makeProject(await makeElsewhere(), 'Their Song')

    expect((await detectProject(join(mine, 'song.mp3')))?.inLibrary).toBe(true)
    expect((await detectProject(join(theirs, 'song.mp3')))?.inLibrary).toBe(false)
  })

  it('saving an outside project updates it in place, forking nothing into the library', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(await makeElsewhere(), 'Shared Song')

    const res = await saveProject(join(dir, 'song.mp3'), 'Shared Song', {
      transpose: 3,
      tracks: {}
    })
    expect(res).toMatchObject({
      ok: true,
      dir,
      songPath: join(dir, 'song.mp3'),
      inLibrary: false
    })
    expect(await readdir(root)).toEqual([])

    const meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(meta.settings.transpose).toBe(3)
    // the song was not duplicated as song.mp3 alongside itself
    expect((await readdir(dir)).sort()).toEqual(['lyrics.json', 'project.json', 'song.mp3', 'stems'])
  })

  it('saving a loose song still creates a folder in the library', async () => {
    const root = await makeLibrary()
    const song = join(await makeElsewhere(), 'Some Song.mp3')
    await writeFile(song, 'pretend-audio')

    const res = await saveProject(song, 'Some Song', { transpose: 0, tracks: {} })
    expect(res).toMatchObject({ ok: true, dir: join(root, 'Some Song'), inLibrary: true })
    expect(await readdir(root)).toEqual(['Some Song'])
  })

  it('renaming an outside project renames it where it lives', async () => {
    const root = await makeLibrary()
    const elsewhere = await makeElsewhere()
    const dir = await makeProject(elsewhere, 'Shared Song')

    const res = await renameProject(join(dir, 'song.mp3'), 'Better Name')
    expect(res).toMatchObject({ ok: true, dir: join(elsewhere, 'Better Name') })
    expect(await readdir(root)).toEqual([])
    expect(await gone(dir)).toBe(true)
    if (res.ok) expect(res.stems?.vocals).toBe(join(elsewhere, 'Better Name', 'stems', 'vocals.flac'))
  })

  it('renaming a library project keeps it in the library', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Library Song')

    const res = await renameProject(join(dir, 'song.mp3'), 'Renamed')
    expect(res).toMatchObject({ ok: true, dir: join(root, 'Renamed') })
    expect(await readdir(root)).toEqual(['Renamed'])
  })
})

describe('deleteProject (the catalog ✕, with no undo behind it)', () => {
  it('erases a library project, folder and all', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Doomed Song')
    await makeProject(root, 'Innocent Song')

    expect(await deleteProject(dir)).toEqual({ ok: true, name: 'Doomed Song' })
    expect(await gone(dir)).toBe(true)
    expect(await readdir(root)).toEqual(['Innocent Song'])
  })

  it('refuses a project outside the library — not ours to erase', async () => {
    await makeLibrary()
    const dir = await makeProject(await makeElsewhere(), 'Shared Song')

    const res = await deleteProject(dir)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not a project in your library')
    expect(await gone(join(dir, 'song.mp3'))).toBe(false)
  })

  it('refuses the library root itself', async () => {
    const root = await makeLibrary()
    await makeProject(root, 'Keep Me')

    expect((await deleteProject(root)).ok).toBe(false)
    expect(await readdir(root)).toEqual(['Keep Me'])
  })

  it('refuses a folder that is not a project', async () => {
    const root = await makeLibrary()
    const dir = join(root, 'Just A Folder')
    await mkdir(join(dir, 'stems'), { recursive: true })
    await writeFile(join(dir, 'stems', 'vocals.flac'), 'fLaC')

    const res = await deleteProject(dir)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('not a saved project')
    expect(await gone(dir)).toBe(false)
  })

  it('waits for a save of that project rather than deleting under it', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Doomed Song')

    const saving = saveProject(join(dir, 'song.mp3'), 'Doomed Song', { transpose: 4, tracks: {} })
    const deleting = deleteProject(dir)

    expect(await saving).toMatchObject({ ok: true, dir })
    expect(await deleting).toMatchObject({ ok: true })
    // the save finished into a folder that is now gone — and stayed gone
    expect(await readdir(root)).toEqual([])
  })
})

describe('importProject (bring an outside project in)', () => {
  it('copies the folder in and leaves the original alone', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(await makeElsewhere(), 'Shared Song')

    const res = await importProject(join(dir, 'song.mp3'), 'copy')
    expect(res).toMatchObject({
      ok: true,
      dir: join(root, 'Shared Song'),
      songPath: join(root, 'Shared Song', 'song.mp3'),
      moved: false
    })
    if (res.ok) {
      expect(res.stems?.vocals).toBe(join(root, 'Shared Song', 'stems', 'vocals.flac'))
    }
    expect(await gone(join(dir, 'project.json'))).toBe(false)
    expect(await readFile(join(root, 'Shared Song', 'stems', 'vocals.flac'), 'utf8')).toBe(
      'fLaC-vocals'
    )
  })

  it('moves the folder in, leaving nothing behind', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(await makeElsewhere(), 'Shared Song')

    const res = await importProject(join(dir, 'song.mp3'), 'move')
    expect(res).toMatchObject({ ok: true, dir: join(root, 'Shared Song'), moved: true })
    expect(await gone(dir)).toBe(true)
    expect(await readdir(join(root, 'Shared Song', 'stems'))).toHaveLength(6)
  })

  it('turns down a project already in the library', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Library Song')

    expect(await importProject(join(dir, 'song.mp3'), 'copy')).toEqual({
      ok: false,
      error: 'This project is already in your library.'
    })
  })

  it('refuses to clobber a project of the same name', async () => {
    const root = await makeLibrary()
    await makeProject(root, 'Shared Song')
    const dir = await makeProject(await makeElsewhere(), 'Shared Song')

    const res = await importProject(join(dir, 'song.mp3'), 'move')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('already in your library')
    // the original is still there — a refused move must not have eaten it
    expect(await gone(join(dir, 'song.mp3'))).toBe(false)
  })

  it('turns down a folder that is not a project', async () => {
    await makeLibrary()
    const loose = join(await makeElsewhere(), 'song.mp3')
    await writeFile(loose, 'pretend-audio')

    expect(await importProject(loose, 'copy')).toEqual({
      ok: false,
      error: 'This song is not a saved project yet.'
    })
  })
})
