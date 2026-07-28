import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateProjectToV2 } from '../../src/main/projects'
import { makeWav } from './wav-fixture'

const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

async function makeV1Project(opts: { corrupt?: string[] } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'singz-v1-'))
  await mkdir(join(dir, 'stems'), { recursive: true })
  await writeFile(
    join(dir, 'project.json'),
    JSON.stringify({
      version: 1,
      name: 'Test Song',
      songFile: 'test.mp3',
      savedAt: '2026-01-01T00:00:00.000Z',
      settings: { transpose: 0, tracks: {} }
    })
  )
  for (const s of STEMS) {
    const body = opts.corrupt?.includes(s)
      ? Buffer.from('RIFFgarbage-that-is-not-a-wave-file')
      : makeWav({ frames: 2205, sampleRate: 44100 }).buffer
    await writeFile(join(dir, 'stems', `${s}.wav`), body)
  }
  return dir
}

describe('migrateProjectToV2 (v1 WAV -> v2 FLAC, crash-safe)', () => {
  it('converts every stem, deletes WAVs, flips version last', async () => {
    const dir = await makeV1Project()
    const res = await migrateProjectToV2(dir)
    expect(res).toEqual({ ok: true, converted: true })

    const files = (await readdir(join(dir, 'stems'))).sort()
    expect(files).toEqual(STEMS.map((s) => `${s}.flac`).sort())
    for (const f of files) {
      const head = await readFile(join(dir, 'stems', f))
      expect(head.subarray(0, 4).toString('ascii')).toBe('fLaC')
    }
    const meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(meta.version).toBe(2)
  })

  it('is idempotent: a v2 project returns immediately, converted:false', async () => {
    const dir = await makeV1Project()
    await migrateProjectToV2(dir)
    const again = await migrateProjectToV2(dir)
    expect(again).toEqual({ ok: true, converted: false })
  })

  it('keeps the project playable when one stem cannot convert', async () => {
    const dir = await makeV1Project({ corrupt: ['drums'] })
    const res = await migrateProjectToV2(dir)
    expect(res.ok).toBe(false)

    const files = await readdir(join(dir, 'stems'))
    // good stems converted and their WAVs are gone…
    expect(files).toContain('vocals.flac')
    expect(files).not.toContain('vocals.wav')
    // …the bad stem keeps its WAV (still loadable), no bogus FLAC appears…
    expect(files).toContain('drums.wav')
    expect(files).not.toContain('drums.flac')
    // …and the version stays 1 so the next open retries the upgrade
    const meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(meta.version).toBe(1)
  })

  it('rejects a non-project folder with a result object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-empty-'))
    const res = await migrateProjectToV2(dir)
    expect(res).toEqual({ ok: false, error: 'not a project folder' })
  })
})
