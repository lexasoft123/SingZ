import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAllowed } from '../../src/main/media'
import { registerSource } from '../../src/main/source'

const STEMS_6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

/**
 * A project folder in its own temp dir — i.e. nowhere near projectsRoot(),
 * which is what a copied, shared or cloud-library project looks like.
 */
async function makeProjectOutsideRoot(): Promise<{ dir: string; song: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'singz-elsewhere-'))
  await mkdir(join(dir, 'stems'), { recursive: true })
  await writeFile(
    join(dir, 'project.json'),
    JSON.stringify({
      version: 2,
      name: 'Shared Song',
      songFile: 'song.mp3',
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: { transpose: 0, tracks: {} }
    })
  )
  const song = join(dir, 'song.mp3')
  await writeFile(song, '')
  for (const s of STEMS_6) await writeFile(join(dir, 'stems', `${s}.flac`), '')
  await writeFile(join(dir, 'lyrics.json'), '{}')
  return { dir, song }
}

describe('registerSource (media allowlist for the detected project)', () => {
  it('opens a project stored outside the library root: stems and lyrics are readable', async () => {
    const { dir, song } = await makeProjectOutsideRoot()
    const res = await registerSource(song)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.name).toBe('Shared Song')
    expect(res.project?.dir).toBe(dir)

    // every path the renderer will hand back to media:read must pass isAllowed,
    // or the load dies as "Could not decode that audio file."
    expect(isAllowed(song)).toBe(true)
    for (const p of Object.values(res.project?.stems ?? {})) expect(isAllowed(p)).toBe(true)
    expect(isAllowed(join(dir, 'lyrics.json'))).toBe(true)
    // project:upgrade registers the folder itself, and writes new files into it
    expect(isAllowed(dir)).toBe(true)
    expect(isAllowed(join(dir, 'stems', 'vocals.wav'))).toBe(true)
  })

  it('a loose song grants access to itself only, not to its folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-loose-'))
    const song = join(dir, 'demo.mp3')
    await writeFile(song, '')
    await writeFile(join(dir, 'tax-return.mp3'), '')

    const res = await registerSource(song)
    expect(res.ok).toBe(true)
    expect(isAllowed(song)).toBe(true)
    expect(isAllowed(join(dir, 'tax-return.mp3'))).toBe(false)
    expect(isAllowed(dir)).toBe(false)
  })

  it('turns down non-audio and missing files with a result object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-reject-'))
    const doc = join(dir, 'notes.txt')
    await writeFile(doc, 'hi')

    expect(await registerSource(doc)).toEqual({
      ok: false,
      error: "Can't use .txt — drop an MP3, WAV, FLAC or M4A."
    })
    expect(await registerSource(join(dir, 'gone.mp3'))).toEqual({
      ok: false,
      error: 'Could not read that file.'
    })
    expect(await registerSource(dir)).toEqual({
      ok: false,
      error: "Can't use that file — drop an MP3, WAV, FLAC or M4A."
    })
    expect(isAllowed(doc)).toBe(false)
  })
})
