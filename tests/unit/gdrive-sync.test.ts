import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
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

    // the phone-facing manifest: one row per project — its two judgeable
    // files with ids and md5s. Everything else lives in project.json.
    const cat = [...mock.files.values()].find((f) => f.name === 'catalog.json')
    const manifest = JSON.parse(cat!.bytes!.toString())
    expect(manifest.format).toBe(2)
    expect(manifest.projects).toHaveLength(1)
    expect(manifest.projects[0].dir).toBe('Mock Song')
    expect(manifest.projects[0].doc).toBeUndefined()
    expect(manifest.projects[0].stems).toBeUndefined()
    expect(manifest.projects[0].files.map((f: { name: string }) => f.name).sort()).toEqual([
      'lyrics.json',
      'project.json'
    ])
    for (const f of manifest.projects[0].files) {
      expect(f.id).toBeTruthy()
      expect(f.md5Checksum).toMatch(/^[0-9a-f]{32}$/)
    }

    // the first sync hashed the stems once and folded the hashes into
    // project.json (uploaded in the same run)
    const saved = JSON.parse(await readFile(join(root, 'Mock Song', 'project.json'), 'utf8'))
    expect(Object.keys(saved.stemHashes).sort()).toEqual(['drums.flac', 'vocals.flac'])
    const remoteMeta = [...mock.files.values()].find((f) => f.name === 'project.json')
    expect(JSON.parse(remoteMeta!.bytes!.toString()).stemHashes).toEqual(saved.stemHashes)

    stemReads.count = 0
    mock.hits.length = 0
    const second = await gdriveSync()
    expect(second).toMatchObject({ ok: true, uploaded: 0, unchanged: 4 })
    // identical library => identical manifest bytes => the rewrite is skipped
    expect([...mock.files.values()].find((f) => f.name === 'catalog.json')!.bytes).toBe(cat!.bytes)
    // ...and a clean sync opened no stem file at all
    expect(stemReads.count).toBe(0)
    // ...and asked Drive itself what it holds rather than trusting the catalog
    // it wrote last time: the SingZ folder, its children, then one batched
    // listing for the project folders and one for their stems/. Four requests
    // for a library of any size, and not a byte uploaded.
    expect(mock.hits).toHaveLength(4)
    expect(mock.hits.some((h) => h.includes('uploadType'))).toBe(false)
  })

  it('a lyrics-only change (the aligner) resyncs just that file', async () => {
    const { readSettings } = await import('../../src/main/settings')
    const root = (readSettings() as { projectsRoot: string }).projectsRoot
    await writeFile(
      join(root, 'Mock Song', 'lyrics.json'),
      JSON.stringify({ lines: [{ t: 1, text: 'realigned' }] })
    )
    const { gdriveSync } = await import('../../src/main/gdrive')
    // project.json states every file the project is made of, lyrics included,
    // so the aligner's rewrite moves the doc too: two uploads, and one
    // checksum in the catalog still tells the phones the whole story.
    const rep = await gdriveSync()
    expect(rep).toMatchObject({ ok: true, uploaded: 2, unchanged: 2 })
    const lyr = [...mock.files.values()].find((f) => f.name === 'lyrics.json')
    expect(lyr?.bytes?.toString()).toContain('realigned')
    const doc = JSON.parse(
      await readFile(join(root, 'Mock Song', 'project.json'), 'utf8')
    ) as { lyricsHash?: { md5: string; size: number } }
    expect(doc.lyricsHash?.md5).toBe(
      createHash('md5').update(lyr!.bytes as Buffer).digest('hex')
    )
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
    // phones decide re-downloads from project.json's stemHashes — the synced
    // copy must carry the new md5
    const meta = [...mock.files.values()].find((f) => f.name === 'project.json')
    expect(JSON.parse(meta!.bytes!.toString()).stemHashes['vocals.flac'].md5).toBe(
      createHash('md5').update('fLaC-new-take').digest('hex')
    )

    // same length, different audio — the re-split WAV trap: the stored-hash
    // shortcut must not trust size alone (mtime moves, so it re-hashes)
    await writeFile(join(root, 'Mock Song', 'stems', 'vocals.flac'), Buffer.from('fLaC-mew-take'))
    const again = await gdriveSync()
    expect(again).toMatchObject({ ok: true, uploaded: 2, unchanged: 2 })
    const meta2 = [...mock.files.values()].find((f) => f.name === 'project.json')
    expect(JSON.parse(meta2!.bytes!.toString()).stemHashes['vocals.flac'].md5).toBe(
      createHash('md5').update('fLaC-mew-take').digest('hex')
    )
  })
})

describe('refreshStemHashes', () => {
  it('tolerates iCloud rehydration mtime drift, re-hashes real changes', async () => {
    const { refreshStemHashes } = await import('../../src/main/projects')
    const dir = await mkdtemp(join(tmpdir(), 'singz-hash-'))
    await mkdir(join(dir, 'stems'), { recursive: true })
    await writeFile(join(dir, 'stems', 'vocals.flac'), Buffer.from('fLaC-x'))
    const st = await stat(join(dir, 'stems', 'vocals.flac'))
    // rehydrating an evicted iCloud file truncates mtime by ~300ns (measured
    // 2026-07-31 on APFS) — that must not invalidate the stored hash
    const drifted = { 'vocals.flac': { md5: 'sentinel', size: st.size, mtimeMs: st.mtimeMs + 0.5 } }
    expect((await refreshStemHashes(dir, drifted))['vocals.flac'].md5).toBe('sentinel')
    // a genuine write lands whole milliseconds away — that must re-hash
    const moved = { 'vocals.flac': { md5: 'sentinel', size: st.size, mtimeMs: st.mtimeMs + 5000 } }
    expect((await refreshStemHashes(dir, moved))['vocals.flac'].md5).not.toBe('sentinel')
  })
})

describe('the dirty ledger and the sync', () => {
  it('goes clean after a sync, and the sync\'s own writes do not re-dirty it', async () => {
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    const { clearDirty, dirtySeq, isDirty, markProjectDirty } = await import('../../src/main/sync-dirty')
    const root = await mkdtemp(join(tmpdir(), 'singz-dirty-sync-'))
    await seedProject(root, 'Dirty Song')
    const s = readSettings() as Record<string, unknown>
    s.projectsRoot = root
    s.gdriveDirty = undefined
    writeSettings(s)

    markProjectDirty(join(root, 'Dirty Song'), 'save')
    expect(isDirty()).toBe(true)

    // what the scheduler does: capture, run, clear only what the run covered
    const { gdriveSync } = await import('../../src/main/gdrive')
    const captured = dirtySeq()
    expect(await gdriveSync()).toMatchObject({ ok: true })
    clearDirty(captured)

    // the sync folded stemHashes + lyricsHash into project.json as it went;
    // if that write marked the project again the library would never be clean
    expect(isDirty()).toBe(false)
    const second = await gdriveSync()
    expect(second).toMatchObject({ ok: true, uploaded: 0 })
    expect(isDirty()).toBe(false)
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

  it('survives a project renamed out from under it mid-run', async () => {
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    const { renameSync } = await import('node:fs')
    const root = await mkdtemp(join(tmpdir(), 'singz-gdrive-'))
    await seedProject(root, 'Aardvark')
    await seedProject(root, 'Zebra')
    const s = readSettings() as Record<string, unknown>
    s.projectsRoot = root
    s.gdrive = { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 }
    writeSettings(s)

    // The singer renames a song while the sync is walking it — this is what
    // the rename pencil does, and it used to end the run on an unhandled
    // ENOENT ("waiting for you"), leaving the rest of the library unsynced.
    const { gdriveSync } = await import('../../src/main/gdrive')
    let moved = false
    const rep = await gdriveSync({
      onProgress: (msg) => {
        if (!moved && msg.startsWith('Uploading Aardvark/')) {
          moved = true
          renameSync(join(root, 'Aardvark'), join(root, 'Renamed'))
        }
      }
    })

    expect(moved).toBe(true)
    // the run stands, and every other project still went up
    expect(rep.ok).toBe(true)
    const live = [...mock.files.values()].filter((f) => !f.trashed).map((f) => f.name)
    expect(live).toContain('Zebra')
    // ...while the project that moved is left for the next run — and above all
    // is not in the catalog, which must never name a file Drive does not hold
    const cat = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)
    const manifest = JSON.parse(cat!.bytes!.toString())
    expect(manifest.projects.map((p: { dir: string }) => p.dir)).toEqual(['Zebra'])

    // the next run carries it under its new name, with nothing left behind
    expect(await gdriveSync()).toMatchObject({ ok: true })
    const after = [...mock.files.values()].filter((f) => !f.trashed).map((f) => f.name)
    expect(after).toContain('Renamed')
    const cat2 = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)
    expect(
      JSON.parse(cat2!.bytes!.toString()).projects.map((p: { dir: string }) => p.dir).sort()
    ).toEqual(['Renamed', 'Zebra'])
  })

  it('diffs by md5, treating missing remotes as uploads', async () => {
    const { planSync } = await import('../../src/main/sync-plan')
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
