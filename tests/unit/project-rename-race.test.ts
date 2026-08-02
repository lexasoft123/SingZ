import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renameProject, saveProject } from '../../src/main/projects'
import { writeSettings } from '../../src/main/settings'

/**
 * Renaming a project and saving it are one folder seen from two sides, and
 * both are slow: a save runs six stems through the FLAC encoder while a rename
 * moves the whole folder. Let them interleave and the library grows a project
 * nobody asked for — the save's mkdir recreates the folder the rename just
 * moved away, and the rest of the save fills the ghost from the splitter
 * cache. So they queue: whoever asked first goes first, and the one behind
 * decides what to do with the folder as it is by then.
 *
 * This is the on-disk half of a real "renaming leaves a duplicate" report. The
 * other half was in the renderer, which applied a finished save's PATH to
 * whichever song was on screen by the time it landed — so a rename typed for
 * one song moved a different song's folder (loadSeq guards it in App.tsx).
 */

const STEMS_6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

async function makeLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'singz-race-'))
  writeSettings({ projectsRoot: root })
  return root
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
  return dir
}

describe('a save and a rename of one project never fork it', () => {
  it('finishes the save that got there first, then renames what it wrote', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Old Name')

    const saving = saveProject(join(dir, 'song.mp3'), 'Old Name', { transpose: 5, tracks: {} })
    const renaming = renameProject(join(dir, 'song.mp3'), 'New Name')

    expect(await saving).toMatchObject({ ok: true, dir })
    expect(await renaming).toMatchObject({ ok: true, dir: join(root, 'New Name') })
    expect(await readdir(root)).toEqual(['New Name'])

    // the rename carried that save's work over rather than racing past it
    const meta = JSON.parse(await readFile(join(root, 'New Name', 'project.json'), 'utf8'))
    expect(meta.name).toBe('New Name')
    expect(meta.settings.transpose).toBe(5)
  })

  it('makes a save stand down when a rename got there first', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Old Name')

    const renaming = renameProject(join(dir, 'song.mp3'), 'New Name')
    const saving = saveProject(join(dir, 'song.mp3'), 'Old Name', { transpose: 5, tracks: {} })

    expect(await renaming).toMatchObject({ ok: true, dir: join(root, 'New Name') })
    const saved = await saving
    expect(saved.ok).toBe(false)
    if (!saved.ok) expect(saved.error).toContain('no longer where it was')
    // the point of the whole exercise: no second folder under the old name
    expect(await readdir(root)).toEqual(['New Name'])
  })

  it('keeps saving in place after a rename', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'First Name')

    expect(await renameProject(join(dir, 'song.mp3'), 'Second Name')).toMatchObject({ ok: true })
    const after = await saveProject(join(root, 'Second Name', 'song.mp3'), 'Second Name', {
      transpose: 2,
      tracks: {}
    })
    expect(after).toMatchObject({ ok: true, dir: join(root, 'Second Name') })
    expect(await readdir(root)).toEqual(['Second Name'])
  })

  it('refuses to save a song that is no longer there, rather than forking a copy', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'Gone Song')
    await rm(dir, { recursive: true, force: true })

    const res = await saveProject(join(dir, 'song.mp3'), 'Gone Song', { transpose: 0, tracks: {} })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('no longer where it was')
    // no folder conjured out of the splitter cache under the old name
    expect(await readdir(root)).toEqual([])
  })
})
