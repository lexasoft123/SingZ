import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectProject, importProject, renameProject, saveProject } from '../../src/main/projects'
import { writeSettings } from '../../src/main/settings'
import type { CustomTrack } from '../../src/shared/types'

/**
 * Custom tracks: audio files the singer adds as extra lanes. They live in the
 * project's stems/ folder under a "custom-" prefix (that folder is what Drive
 * syncs), project.json stores them project-relative, and everything in memory
 * is absolute.
 */

const STEMS_6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

async function makeLibrary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'singz-custom-lib-'))
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

/** An audio file lying around outside any project — what the singer picks. */
async function looseTrack(name: string, body = `audio-${name}`): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'singz-picked-')), name)
  await writeFile(path, body)
  return path
}

function track(id: string, file: string, label = id): CustomTrack {
  return { id, label, color: '#8fd3ff', file }
}

async function gone(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

async function metaOf(dir: string): Promise<{ settings: { custom?: CustomTrack[] } }> {
  return JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
}

describe('saving custom tracks', () => {
  it('copies the picked file into stems/ and stores it project-relative', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const picked = await looseTrack('Harmony Take 2.mp3', 'my-harmony')

    const res = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-harmony-take-2', picked, 'Harmony take 2')],
      tracks: { 'custom-harmony-take-2': { muted: false, solo: false, volume: 0.7 } }
    })

    expect(res.ok).toBe(true)
    const stored = join(dir, 'stems', 'custom-harmony-take-2.mp3')
    expect(await readFile(stored, 'utf8')).toBe('my-harmony')
    // the file the singer picked is untouched where it was
    expect(await readFile(picked, 'utf8')).toBe('my-harmony')

    const meta = await metaOf(dir)
    expect(meta.settings.custom).toEqual([
      {
        id: 'custom-harmony-take-2',
        label: 'Harmony take 2',
        color: '#8fd3ff',
        file: join('stems', 'custom-harmony-take-2.mp3')
      }
    ])
    // and the renderer gets absolute paths back to keep playing from
    if (res.ok) expect(res.custom).toEqual([expect.objectContaining({ file: stored })])
  })

  it('re-saving is a no-op — the project copy is its own source by then', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const picked = await looseTrack('click.wav', 'tick-tick')

    const first = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-click', picked)],
      tracks: {}
    })
    if (!first.ok) throw new Error('first save failed')
    // the singer's own file is gone (moved, unplugged drive) — the project copy
    // is what the session now points at, so saving again must still work
    await rm(picked, { force: true })

    const again = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: first.custom,
      tracks: {}
    })
    expect(again.ok).toBe(true)
    expect(await readFile(join(dir, 'stems', 'custom-click.wav'), 'utf8')).toBe('tick-tick')
  })

  it('keeps a stem of the same name out of harm’s way', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const picked = await looseTrack('vocals.flac', 'my-own-vocals')

    await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-vocals', picked, 'Vocals')],
      tracks: {}
    })

    expect(await readFile(join(dir, 'stems', 'vocals.flac'), 'utf8')).toBe('fLaC-vocals')
    expect(await readFile(join(dir, 'stems', 'custom-vocals.flac'), 'utf8')).toBe('my-own-vocals')
  })

  it('drops a track whose file vanished, saving everything else', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const here = await looseTrack('kept.mp3')
    const gone1 = join(await mkdtemp(join(tmpdir(), 'singz-picked-')), 'never-written.mp3')

    const res = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-kept', here), track('custom-lost', gone1)],
      tracks: {}
    })

    expect(res.ok).toBe(true)
    if (res.ok) expect(res.custom?.map((c) => c.id)).toEqual(['custom-kept'])
    expect((await metaOf(dir)).settings.custom?.map((c) => c.id)).toEqual(['custom-kept'])
  })

  it('prunes the copy of a track the singer removed', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const a = await looseTrack('a.mp3')
    const b = await looseTrack('b.mp3')

    await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-a', a), track('custom-b', b)],
      tracks: {}
    })
    const stored = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-a', join(dir, 'stems', 'custom-a.mp3'))],
      tracks: {}
    })

    expect(stored.ok).toBe(true)
    expect(await gone(join(dir, 'stems', 'custom-b.mp3'))).toBe(true)
    expect(await gone(join(dir, 'stems', 'custom-a.mp3'))).toBe(false)
    // removing the last one clears the folder and the metadata
    await saveProject(join(dir, 'song.mp3'), 'My Song', { transpose: 0, custom: [], tracks: {} })
    expect((await readdir(join(dir, 'stems'))).filter((f) => f.startsWith('custom-'))).toEqual([])
    expect((await metaOf(dir)).settings.custom).toBeUndefined()
  })

  it('renaming a track is a label change — the audio stays exactly where it is', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const picked = await looseTrack('take 3.mp3', 'the-take')

    const first = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-take-3', picked, 'Take 3')],
      tracks: {}
    })
    if (!first.ok) throw new Error('first save failed')
    const stored = join(dir, 'stems', 'custom-take-3.mp3')

    // the singer renames the lane to "Second voice" and saves again
    const renamed = await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [{ ...first.custom![0], label: 'Second voice' }],
      tracks: {}
    })

    expect(renamed.ok).toBe(true)
    expect((await metaOf(dir)).settings.custom).toEqual([
      {
        id: 'custom-take-3',
        label: 'Second voice',
        color: '#8fd3ff',
        file: join('stems', 'custom-take-3.mp3')
      }
    ])
    // the file keeps its name and its bytes: nothing to re-upload to Drive,
    // nothing for the phones to download again
    expect(await readFile(stored, 'utf8')).toBe('the-take')
    expect((await readdir(join(dir, 'stems'))).filter((f) => f.startsWith('custom-'))).toEqual([
      'custom-take-3.mp3'
    ])
  })

  it('never writes outside the project folder, whatever the id says', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const picked = await looseTrack('sneaky.mp3')

    await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('../../escaped', picked)],
      tracks: {}
    })

    const written = (await readdir(join(dir, 'stems'))).filter((f) => f.startsWith('custom-'))
    expect(written).toEqual(['custom-escaped.mp3'])
    expect(await gone(join(root, 'escaped.mp3'))).toBe(true)
  })
})

describe('reading custom tracks back', () => {
  it('detectProject resolves them to absolute paths', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const picked = await looseTrack('harmony.mp3')
    await saveProject(join(dir, 'song.mp3'), 'My Song', {
      transpose: 0,
      custom: [track('custom-harmony', picked, 'Harmony')],
      tracks: {}
    })

    const proj = await detectProject(join(dir, 'song.mp3'))
    expect(proj?.settings.custom).toEqual([
      {
        id: 'custom-harmony',
        label: 'Harmony',
        color: '#8fd3ff',
        file: join(dir, 'stems', 'custom-harmony.mp3')
      }
    ])
  })

  it('drops entries whose file is missing or points outside the folder', async () => {
    const root = await makeLibrary()
    const dir = await makeProject(root, 'My Song')
    const meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    meta.settings.custom = [
      track('custom-missing', join('stems', 'custom-missing.mp3')),
      track('custom-escape', join('..', '..', 'etc', 'passwd'))
    ]
    await writeFile(join(dir, 'project.json'), JSON.stringify(meta))

    expect((await detectProject(join(dir, 'song.mp3')))?.settings.custom).toBeUndefined()
  })

  it('rename and import hand back paths in the folder’s new home', async () => {
    const root = await makeLibrary()
    const outside = await mkdtemp(join(tmpdir(), 'singz-elsewhere-'))
    const dir = await makeProject(outside, 'Shared Song')
    const picked = await looseTrack('harmony.mp3')
    await saveProject(join(dir, 'song.mp3'), 'Shared Song', {
      transpose: 0,
      custom: [track('custom-harmony', picked)],
      tracks: {}
    })

    const renamed = await renameProject(join(dir, 'song.mp3'), 'Better Name')
    if (!renamed.ok) throw new Error(renamed.error)
    expect(renamed.custom?.[0].file).toBe(
      join(outside, 'Better Name', 'stems', 'custom-harmony.mp3')
    )

    const imported = await importProject(renamed.songPath, 'copy')
    if (!imported.ok) throw new Error(imported.error)
    expect(imported.custom?.[0].file).toBe(
      join(root, 'Better Name', 'stems', 'custom-harmony.mp3')
    )
  })
})
