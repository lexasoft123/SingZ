import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateProjectToV2 } from '../../src/main/projects'
import { makeWav } from './wav-fixture'

const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

/** A float WAV: what the lead/backing split writes, and what never compacts. */
function floatWav(): Buffer {
  const data = Buffer.alloc(44 + 64 * 8)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(3, 20); data.writeUInt16LE(2, 22)
  data.writeUInt32LE(44100, 24); data.writeUInt32LE(44100 * 8, 28)
  data.writeUInt16LE(8, 32); data.writeUInt16LE(32, 34); data.write('data', 36)
  data.writeUInt32LE(data.length - 44, 40)
  data.writeFloatLE(1.25, 44)
  return data
}

async function makeV1Project(opts: { corrupt?: string[]; float?: string[] } = {}): Promise<string> {
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
      : opts.float?.includes(s)
        ? floatWav()
        : makeWav({ frames: 2205, sampleRate: 44100 }).buffer
    await writeFile(join(dir, 'stems', `${s}.wav`), body)
  }
  return dir
}

describe('migrateProjectToV2 (v1 WAV -> v2 FLAC, crash-safe)', () => {
  it('leaves project.json describing the files it just wrote', async () => {
    // the upgrade deletes the WAVs; a doc still naming them describes files
    // that no longer exist, and a phone reading it asks Drive for them
    const dir = await makeV1Project()
    await migrateProjectToV2(dir)
    const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8')) as {
      stemHashes?: Record<string, { md5: string; size: number }>
    }
    expect(Object.keys(doc.stemHashes ?? {}).sort()).toEqual(STEMS.map((s) => `${s}.flac`).sort())
    for (const [name, h] of Object.entries(doc.stemHashes ?? {})) {
      const bytes = await readFile(join(dir, 'stems', name))
      expect(h.size).toBe(bytes.length)
    }
  })

  it('converts every stem, deletes WAVs, flips version last', async () => {
    const dir = await makeV1Project()
    const res = await migrateProjectToV2(dir)
    expect(res).toEqual({
      ok: true, converted: true,
      compacted: ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
    })

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
    expect(again).toEqual({ ok: true, converted: false, compacted: [] })
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

  it('stamps a float lead lane v2 instead of upgrading it for ever', async () => {
    // A lead/backing split leaves vocals.wav as float, which no build will
    // ever compact. Counting that as unfinished pinned the project at v1, and
    // every open then took the project lock and ran an upgrade that could not
    // succeed — silently, since the renderer only acts on ok && converted.
    const dir = await makeV1Project({ float: ['vocals'] })
    const res = await migrateProjectToV2(dir)
    expect(res.ok).toBe(true)
    // The five convertible stems moved; the float lane did not, and is NOT in
    // `compacted` — the renderer repoints only what this names, or it would
    // point vocals at a .flac nobody wrote.
    expect(res).toEqual({
      ok: true, converted: true,
      compacted: ['drums', 'bass', 'guitar', 'piano', 'other']
    })

    const files = await readdir(join(dir, 'stems'))
    expect(files).toContain('vocals.wav')
    expect(files).not.toContain('vocals.flac')
    expect(files).toContain('drums.flac')

    const meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(meta.version).toBe(2)
    // …and the next open does nothing at all, which is the whole point.
    expect(await migrateProjectToV2(dir)).toEqual({ ok: true, converted: false, compacted: [] })
  })

  it('still retries a project whose stem failed for a fixable reason', async () => {
    // The distinction that makes the case above safe: a corrupt stem is worth
    // coming back to, a float one is not.
    const dir = await makeV1Project({ corrupt: ['drums'], float: ['vocals'] })
    expect((await migrateProjectToV2(dir)).ok).toBe(false)
    const meta = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(meta.version).toBe(1)
  })

  it('rejects a non-project folder with a result object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-empty-'))
    const res = await migrateProjectToV2(dir)
    expect(res).toEqual({ ok: false, error: 'not a project folder' })
  })
})
