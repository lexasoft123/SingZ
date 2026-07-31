import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startMockDrive, type MockDrive } from './mock-drive'

/** Every fs read of a stem file — the whole point of stored stem hashes is
 *  that a clean sync performs none (hashing evicted iCloud stems downloads
 *  them, which read as "sync re-uploads my library"). */
const { stemReads } = vi.hoisted(() => ({ stemReads: { count: 0 } }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    readFile: (async (...a: Parameters<typeof real.readFile>) => {
      if (/stems[/\\]/.test(String(a[0]))) stemReads.count++
      return real.readFile(...a)
    }) as typeof real.readFile
  }
})

let mock: MockDrive

beforeAll(async () => {
  mock = await startMockDrive()
  const base = `http://127.0.0.1:${mock.port}`
  process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    authBase: base,
    apiBase: base,
    uploadBase: base
  })
})

afterAll(async () => {
  await mock.close()
})

async function seedProject(root: string, name: string): Promise<void> {
  await mkdir(join(root, name, 'stems'), { recursive: true })
  await writeFile(
    join(root, name, 'project.json'),
    JSON.stringify({
      version: 2,
      name,
      savedAt: '2026-07-30T00:00:00.000Z',
      settings: {
        transpose: 1,
        tracks: { vocals: { gain: 0.5 } },
        beat: { beats: [0.5, 1.0, 1.5], beatsPerBar: 4, downbeat: 0 },
        custom: [{ id: 'custom-x', label: 'X', color: '#ffffff', file: 'stems/custom-x.mp3' }]
      }
    })
  )
  await writeFile(join(root, name, 'lyrics.json'), JSON.stringify({ lines: [] }))
  await writeFile(join(root, name, 'stems', 'vocals.flac'), Buffer.from('fLaC-fake-vocals'))
  await writeFile(join(root, name, 'stems', 'drums.flac'), Buffer.from('fLaC-fake-drums'))
}

describe('gdriveSync (against the mock Drive)', () => {
  it('pushes projects, then re-runs as a no-op via md5 diff', async () => {
    // settings/tokens live under the electron-stub userData
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    const root = await mkdtemp(join(tmpdir(), 'singz-gdrive-'))
    await seedProject(root, 'Mock Song')
    const s = readSettings() as Record<string, unknown>
    s.projectsRoot = root
    s.gdrive = { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 }
    writeSettings(s)

    const { gdriveSync, gdriveConfigured, gdriveSignedIn } = await import('../../src/main/gdrive')
    expect(gdriveConfigured()).toBe(true)
    expect(gdriveSignedIn()).toBe(true)

    const first = await gdriveSync()
    expect(first).toMatchObject({ ok: true, projects: 1, uploaded: 4 })

    const names = [...mock.files.values()].map((f) => f.name).sort()
    expect(names).toEqual(
      ['Mock Song', 'SingZ', 'catalog.json', 'drums.flac', 'lyrics.json', 'project.json', 'stems', 'vocals.flac'].sort()
    )
    const vocals = [...mock.files.values()].find((f) => f.name === 'vocals.flac')
    expect(vocals?.bytes?.toString()).toBe('fLaC-fake-vocals')

    // the phone-facing manifest: whole library, with the ids/sizes/md5s the
    // phone needs to list and stream without walking the folders
    const cat = [...mock.files.values()].find((f) => f.name === 'catalog.json')
    const manifest = JSON.parse(cat!.bytes!.toString())
    expect(manifest.format).toBe(1)
    expect(manifest.projects).toHaveLength(1)
    expect(manifest.projects[0].dir).toBe('Mock Song')
    expect(manifest.projects[0].doc.name).toBe('Mock Song')
    const mVocals = manifest.projects[0].stems.find((f: { name: string }) => f.name === 'vocals.flac')
    expect(mVocals).toMatchObject({
      id: vocals!.id,
      size: String(Buffer.from('fLaC-fake-vocals').length),
      md5Checksum: createHash('md5').update('fLaC-fake-vocals').digest('hex')
    })
    expect(manifest.projects[0].files.map((f: { name: string }) => f.name).sort()).toEqual([
      'lyrics.json',
      'project.json'
    ])
    // the doc is a listing summary — player state (beat grids alone were two
    // thirds of the manifest) stays in each project's own project.json
    expect(manifest.projects[0].doc.savedAt).toBe('2026-07-30T00:00:00.000Z')
    expect(manifest.projects[0].doc.settings.custom).toHaveLength(1)
    expect(manifest.projects[0].doc.settings.beat).toBeUndefined()
    expect(manifest.projects[0].doc.settings.tracks).toBeUndefined()
    expect(manifest.projects[0].doc.version).toBeUndefined()

    // the first sync hashed the stems once and folded the hashes into
    // project.json (uploaded in the same run)
    const saved = JSON.parse(await readFile(join(root, 'Mock Song', 'project.json'), 'utf8'))
    expect(Object.keys(saved.stemHashes).sort()).toEqual(['drums.flac', 'vocals.flac'])
    const remoteMeta = [...mock.files.values()].find((f) => f.name === 'project.json')
    expect(JSON.parse(remoteMeta!.bytes!.toString()).stemHashes).toEqual(saved.stemHashes)

    stemReads.count = 0
    const second = await gdriveSync()
    expect(second).toMatchObject({ ok: true, uploaded: 0, unchanged: 4 })
    // identical library => identical manifest bytes => the rewrite is skipped
    expect([...mock.files.values()].find((f) => f.name === 'catalog.json')!.bytes).toBe(cat!.bytes)
    // ...and a clean sync opened no stem file at all
    expect(stemReads.count).toBe(0)
  })

  it('re-uploads only what changed', async () => {
    const { readSettings } = await import('../../src/main/settings')
    const root = (readSettings() as { projectsRoot: string }).projectsRoot
    await writeFile(join(root, 'Mock Song', 'stems', 'vocals.flac'), Buffer.from('fLaC-new-take'))
    const { gdriveSync } = await import('../../src/main/gdrive')
    const rep = await gdriveSync()
    // two uploads: the new take, and the project.json now carrying its hash
    expect(rep).toMatchObject({ ok: true, uploaded: 2, unchanged: 2 })
    const vocals = [...mock.files.values()].find((f) => f.name === 'vocals.flac')
    expect(vocals?.bytes?.toString()).toBe('fLaC-new-take')
    // the manifest follows: phones compare its md5s to decide re-downloads
    const cat = [...mock.files.values()].find((f) => f.name === 'catalog.json')
    const manifest = JSON.parse(cat!.bytes!.toString())
    expect(manifest.projects[0].stems.find((f: { name: string }) => f.name === 'vocals.flac').md5Checksum).toBe(
      createHash('md5').update('fLaC-new-take').digest('hex')
    )

    // same length, different audio — the re-split WAV trap: the stored-hash
    // shortcut must not trust size alone (mtime moves, so it re-hashes)
    await writeFile(join(root, 'Mock Song', 'stems', 'vocals.flac'), Buffer.from('fLaC-mew-take'))
    const again = await gdriveSync()
    expect(again).toMatchObject({ ok: true, uploaded: 2, unchanged: 2 })
    const cat2 = [...mock.files.values()].find((f) => f.name === 'catalog.json')
    expect(
      JSON.parse(cat2!.bytes!.toString()).projects[0].stems.find(
        (f: { name: string }) => f.name === 'vocals.flac'
      ).md5Checksum
    ).toBe(createHash('md5').update('fLaC-mew-take').digest('hex'))
  })
})

describe('planSync', () => {
  it('trashes remote folders for renamed or deleted local projects', async () => {
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    const { rename } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 'singz-gdrive-'))
    await seedProject(root, 'Ozzy Osbourne — Mr')
    const s = readSettings() as Record<string, unknown>
    s.projectsRoot = root
    s.gdrive = { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 }
    writeSettings(s)

    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync()).toMatchObject({ ok: true, projects: 1 })

    // the rename-pencil flow: local folder moves, then the next sync runs
    await rename(join(root, 'Ozzy Osbourne — Mr'), join(root, 'Mr Crowley'))
    expect(await gdriveSync()).toMatchObject({ ok: true, projects: 1 })

    const live = [...mock.files.values()].filter((f) => !f.trashed).map((f) => f.name)
    expect(live).toContain('Mr Crowley')
    expect(live).not.toContain('Ozzy Osbourne — Mr')
    // trashed, never hard-deleted — recoverable from Drive trash
    const ghost = [...mock.files.values()].find((f) => f.name === 'Ozzy Osbourne — Mr')
    expect(ghost?.trashed).toBe(true)
    // the manifest is written after the reconcile, so the ghost is not in it
    const cat = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)
    const manifest = JSON.parse(cat!.bytes!.toString())
    expect(manifest.projects.map((p: { dir: string }) => p.dir)).toEqual(['Mr Crowley'])
  })

  it('diffs by md5, treating missing remotes as uploads', async () => {
    const { planSync } = await import('../../src/main/gdrive')
    const plan = planSync(
      [
        { name: 'a', md5: '111' },
        { name: 'b', md5: '222' },
        { name: 'c', md5: '333' }
      ],
      [
        { name: 'a', md5Checksum: '111' },
        { name: 'b', md5Checksum: 'OLD' }
      ]
    )
    expect(plan.upload.sort()).toEqual(['b', 'c'])
    expect(plan.unchanged).toEqual(['a'])
  })
})
