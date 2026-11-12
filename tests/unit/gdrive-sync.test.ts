import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { putFile, startMockDrive, type MockDrive } from './mock-drive'
import graphCases from '../shared/graph-document-cases.json'

/** Every fs read of a stem file — the whole point of stored stem hashes is
 *  that a clean sync performs none (hashing evicted iCloud stems downloads
 *  them, which read as "sync re-uploads my library"). */
const { stemReads, failures } = vi.hoisted(() => ({ stemReads: { count: 0 }, failures: { stat: '', noInode: '' } }))
/** A filesystem with no stable directory identity (ino 0) at failures.noInode. */
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    statSync: ((...a: Parameters<typeof real.statSync>) => {
      const info = real.statSync(...a)
      if (!info || String(a[0]) !== failures.noInode) return info
      return new Proxy(info, {
        get: (target, key) => {
          if (key === 'ino') return typeof target.ino === 'bigint' ? 0n : 0
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
    }) as typeof real.statSync
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...real,
    stat: ((...a: Parameters<typeof real.stat>) => {
      if (String(a[0]) === failures.stat) throw new Error('injected recovery stat failure')
      return real.stat(...a)
    }) as typeof real.stat,
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

  it('publishes the exact graph before its project reference and removes only the managed stale graph', async () => {
    const { readSettings } = await import('../../src/main/settings')
    const root = (readSettings() as { projectsRoot: string }).projectsRoot
    const dir = join(root, 'Mock Song')
    const graph = JSON.stringify(graphCases.base)
    await writeFile(join(dir, 'graph.json'), graph)
    const st = await stat(join(dir, 'graph.json'))
    const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    doc.graphHash = {
      format: 1,
      md5: createHash('md5').update(graph).digest('hex'),
      size: Buffer.byteLength(graph),
      mtimeMs: st.mtimeMs
    }
    await writeFile(join(dir, 'project.json'), JSON.stringify(doc, null, 2))

    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync()).toMatchObject({ ok: true, uploaded: 2 })
    const liveGraph = [...mock.files.values()].find((f) => f.name === 'graph.json' && !f.trashed)
    expect(liveGraph?.bytes?.toString()).toBe(graph)
    const catalogFile = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)
    const manifest = JSON.parse(catalogFile!.bytes!.toString())
    expect(manifest.projects[0].files.map((f: { name: string }) => f.name)).toContain('graph.json')

    delete doc.graphHash
    await unlink(join(dir, 'graph.json'))
    await writeFile(join(dir, 'project.json'), JSON.stringify(doc, null, 2))
    expect(await gdriveSync()).toMatchObject({ ok: true, uploaded: 1 })
    expect(liveGraph?.trashed).toBe(true)
  })

  it('skips a project whose document names mismatched graph bytes and keeps syncing the rest', async () => {
    const { readSettings } = await import('../../src/main/settings')
    const root = (readSettings() as { projectsRoot: string }).projectsRoot
    const dir = join(root, 'Mock Song')
    const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    doc.graphHash = { format: 1, md5: '0'.repeat(32), size: 2, mtimeMs: 1 }
    await writeFile(join(dir, 'graph.json'), '{}')
    await writeFile(join(dir, 'project.json'), JSON.stringify(doc, null, 2))
    const { gdriveSync } = await import('../../src/main/gdrive')
    const { syncLogEntries } = await import('../../src/main/sync-log')
    const startedAt = Date.now()
    // One broken reference costs that project, never the run: the library
    // keeps syncing and the catalog stops naming the project until it is fixed.
    expect(await gdriveSync()).toMatchObject({ ok: true })
    expect(syncLogEntries().filter((e) => e.at >= startedAt).some((e) =>
      e.kind === 'error' && e.msg.includes('graph.json does not match graphHash'))).toBe(true)
    const catalogFile = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)
    const catalog = JSON.parse(catalogFile!.bytes!.toString())
    expect(catalog.projects.map((p: { dir: string }) => p.dir)).not.toContain('Mock Song')
    delete doc.graphHash
    await unlink(join(dir, 'graph.json'))
    await writeFile(join(dir, 'project.json'), JSON.stringify(doc, null, 2))
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
    // Earlier tests' folders belong to other libraries now, and are kept.
    mock.files.clear()
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
    // Earlier tests' folders belong to other libraries now, and are kept.
    mock.files.clear()
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

async function recoveryInventory(dir: string, names: string[]): Promise<Record<string, { size: number; sha256: string }>> {
  return Object.fromEntries(await Promise.all(names.map(async name => {
    const bytes = await readFile(join(dir, name))
    return [name, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }]
  })))
}

describe('native empty Drive compatibility', () => {
  it('publishes a native empty arrangement without reading or deleting retained audio', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-native-empty-'))
    const dir = join(root, 'Empty Song')
    await mkdir(join(dir, 'stems'), { recursive: true })
    const retained = Buffer.from('retained audio for native recovery')
    const retainedGraph = JSON.stringify(graphCases.base)
    await writeFile(join(dir, 'stems/vocals.wav'), retained)
    await utimes(join(dir, 'stems/vocals.wav'), 1, 1)
    await writeFile(join(dir, 'original.wav'), retained)
    await utimes(join(dir, 'original.wav'), 1, 1)
    await writeFile(join(dir, 'graph.json'), retainedGraph)
    await writeFile(join(dir, 'project.json'), JSON.stringify({
      version: 2, name: 'Empty Song', songFile: 'original.wav', savedAt: new Date().toISOString(),
      stemHashes: {},
      graphHash: { format: 1, md5: createHash('md5').update(retainedGraph).digest('hex'), size: Buffer.byteLength(retainedGraph), mtimeMs: 0 },
      settings: { nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [], loop: true }
    }))
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
    const { gdriveSync } = await import('../../src/main/gdrive')
    stemReads.count = 0
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1, uploaded: 1 })
    const folder = [...mock.files.values()].find(f => f.name === 'Empty Song' && !f.trashed)!
    const files = [...mock.files.values()].filter(f => f.parents.includes(folder.id) && !f.trashed)
    expect(files.map(f => f.name)).toEqual(['project.json'])
    const doc = JSON.parse(files[0].bytes!.toString())
    expect(doc.stemHashes).toEqual({})
    expect(doc.songFile).toBeUndefined()
    expect(doc.songHash).toBeUndefined()
    expect(doc.graphHash).toBeUndefined()
    expect(doc.settings.loop).toBeUndefined()
    expect(stemReads.count).toBe(0)
    expect(await readFile(join(dir, 'stems/vocals.wav'))).toEqual(retained)
    expect(await readFile(join(dir, 'original.wav'))).toEqual(retained)
    expect(await readFile(join(dir, 'graph.json'), 'utf8')).toBe(retainedGraph)
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 0 })
  })
})


describe('stale native empty markers', () => {
  it.each(['custom', 'new stem', 'new song'])('publishes real audio with %s', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'singz-stale-empty-'))
    const dir = join(root, `Returned ${kind}`)
    await mkdir(join(dir, 'stems'), { recursive: true })
    const audio = Buffer.from('returned audio')
    const file = kind === 'custom' ? 'custom-returned.mp3' : 'vocals.flac'
    await writeFile(join(dir, 'stems', file), audio)
    // Content inventory, rather than mtime, proves an external media edit.
    await utimes(join(dir, 'stems', file), 1, kind === 'new stem' ? 2 : 1)
    if (kind === 'new song') {
      await writeFile(join(dir, 'song.mp3'), 'replaced original')
      await utimes(join(dir, 'song.mp3'), 2, 2)
    }
    const nativeRecoveryInventory = kind === 'new stem' ? {} : kind === 'new song'
      ? await recoveryInventory(dir, [`stems/${file}`]) : undefined
    await writeFile(join(dir, 'project.json'), JSON.stringify({
      ...(kind === 'new song' ? { songFile: 'song.mp3' } : {}),
      version: 2, name: `Returned ${kind}`, savedAt: new Date(1500).toISOString(), stemHashes: {},
      nativeRecoveryInventory,
      settings: { nativeEmptyTracks: true, nativeOriginalDisabled: true,
        custom: kind === 'custom' ? [{ id: 'custom-returned', file: `stems/${file}` }] : [] }
    }))
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1, uploaded: 2 })
    const folder = [...mock.files.values()].find(f => f.name === `Returned ${kind}` && !f.trashed)!
    const members = [...mock.files.values()].filter(f => f.parents.includes(folder.id) && !f.trashed)
    const stems = members.find(f => f.name === 'stems')!
    expect([...mock.files.values()].find(f => f.parents.includes(stems.id) && f.name === file)?.bytes).toEqual(audio)
    const published = JSON.parse(members.find(f => f.name === 'project.json')!.bytes!.toString())
    expect(published.stemHashes[file]).toMatchObject({ size: audio.length })
    expect(published.settings.nativeEmptyTracks).toBeUndefined()
    expect(published.settings.nativeOriginalDisabled).toBe(true)
  })

  it('readds custom audio without reviving the retired original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-save-empty-'))
    const dir = join(root, 'Saved')
    await mkdir(join(dir, 'stems'), { recursive: true })
    await writeFile(join(dir, 'song.mp3'), 'source')
    await utimes(join(dir, 'song.mp3'), 1, 1)
    await writeFile(join(dir, 'stems/vocals.flac'), 'retained stem')
    await utimes(join(dir, 'stems/vocals.flac'), 1, 1)
    const extra = join(root, 'custom.mp3')
    await writeFile(extra, 'custom audio')
    await writeFile(join(dir, 'stems/custom-recovery.mp3'), 'retained custom')
    await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 2, name: 'Saved', songFile: 'song.mp3', savedAt: new Date(2000).toISOString(), stemHashes: {},
      settings: { nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [] } }))
    const { saveProject } = await import('../../src/main/projects')
    const result = await saveProject(join(dir, 'song.mp3'), 'Saved', { transpose: 0, tracks: {},
      custom: [{ id: 'custom-returned', label: 'Returned', color: '#ffffff', file: extra }] })
    expect(result.ok).toBe(true)
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(saved.settings.nativeEmptyTracks).toBeUndefined()
    expect(saved.settings.nativeOriginalDisabled).toBe(true)
    expect(saved.settings.custom).toHaveLength(1)
    expect(await readFile(join(dir, 'stems/custom-recovery.mp3'), 'utf8')).toBe('retained custom')
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 4 })
    const folder = [...mock.files.values()].find(f => f.name === 'Saved' && !f.trashed)!
    const members = [...mock.files.values()].filter(f => f.parents.includes(folder.id) && !f.trashed)
    expect(members.map(f => f.name).sort()).toEqual(['project.json', 'stems'])
    expect(JSON.parse(members.find(f => f.name === 'project.json')!.bytes!.toString()).settings.nativeOriginalDisabled).toBe(true)
    const stems = members.find(f => f.name === 'stems')!
    expect([...mock.files.values()].find(f => f.parents.includes(stems.id) && f.name === 'custom-returned.mp3')?.bytes?.toString()).toBe('custom audio')
  })

  it.each(['legacy', 'inventoried'])('keeps an empty arrangement after a touch and settings-only save (%s)', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'singz-empty-settings-'))
    const dir = join(root, 'Settings only')
    await mkdir(join(dir, 'stems'), { recursive: true })
    for (const file of ['song.mp3', 'stems/vocals.flac', 'stems/custom-retained.mp3']) {
      await writeFile(join(dir, file), `recovery ${file}`)
      await utimes(join(dir, file), 1, 1)
    }
    const { saveProject } = await import('../../src/main/projects')
    const inventory = await recoveryInventory(dir, ['song.mp3', 'stems/vocals.flac', 'stems/custom-retained.mp3'])
    await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 2, name: 'Settings only',
      songFile: 'song.mp3', savedAt: new Date(2000).toISOString(), stemHashes: {},
      ...(kind === 'inventoried' ? { nativeRecoveryInventory: inventory } : {}),
      settings: { nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [] } }))
    await utimes(join(dir, 'stems/vocals.flac'), 3, 3)
    await utimes(join(dir, 'song.mp3'), 3, 3)
    const { writeSettings: tokens } = await import('../../src/main/settings')
    tokens({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
    const { gdriveSync: syncTouched } = await import('../../src/main/gdrive')
    expect(await syncTouched({ root })).toMatchObject({ ok: true, uploaded: 1 })
    expect(await syncTouched({ root })).toMatchObject({ ok: true, uploaded: 0 })
    expect((await saveProject(join(dir, 'song.mp3'), 'Renamed only',
      { transpose: 0, tracks: {}, custom: [], masterVolume: 0.4, loop: true })).ok).toBe(true)
    const { saveProjectSongVolume } = await import('../../src/main/projects')
    expect(await saveProjectSongVolume(join(dir, 'song.mp3'), 0.5)).toEqual({ ok: true })
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(saved.settings).toMatchObject({ nativeEmptyTracks: true, nativeOriginalDisabled: true, masterVolume: 0.5, loop: true })
    expect(saved.savedAt).toBe(new Date(2000).toISOString())
    expect(saved.nativeRecoveryInventory).toEqual(kind === 'inventoried' ? inventory : undefined)
    expect(saved.stemHashes).toEqual({})
    for (const file of ['song.mp3', 'stems/vocals.flac', 'stems/custom-retained.mp3']) {
      expect(await readFile(join(dir, file), 'utf8')).toBe(`recovery ${file}`)
    }
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 1 })
    const folder = [...mock.files.values()].find(f => f.name === 'Settings only' && !f.trashed)!
    const members = [...mock.files.values()].filter(f => f.parents.includes(folder.id) && !f.trashed)
    expect(members.map(f => f.name)).toEqual(['project.json'])
    const published = JSON.parse(members[0].bytes!.toString())
    expect(published.settings).toMatchObject({ nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [] })
    expect(published.songFile).toBeUndefined()
    expect(published.stemHashes).toEqual({})
  })

  it.each(['removed', 'replaced', 'replaced on sync'])('ends the empty mix when a recorded stem is %s', async (change) => {
    const root = await mkdtemp(join(tmpdir(), 'singz-empty-stem-edit-'))
    const dir = join(root, 'Stem edit')
    await mkdir(join(dir, 'stems'), { recursive: true })
    await writeFile(join(dir, 'song.mp3'), 'retired original')
    await utimes(join(dir, 'song.mp3'), 1, 1)
    for (const name of ['vocals.flac', 'drums.flac']) {
      await writeFile(join(dir, 'stems', name), name)
      await utimes(join(dir, 'stems', name), 1, 1)
    }
    const { saveProject } = await import('../../src/main/projects')
    const nativeRecoveryInventory = await recoveryInventory(dir, ['song.mp3', 'stems/vocals.flac', 'stems/drums.flac'])
    await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 2, name: 'Stem edit',
      songFile: 'song.mp3', savedAt: new Date(2000).toISOString(), stemHashes: {}, nativeRecoveryInventory,
      settings: { nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [] } }))
    if (change === 'removed') await unlink(join(dir, 'stems/vocals.flac'))
    else {
      // Same size and restored mtime: only the content receipt proves this edit.
      await writeFile(join(dir, 'stems/vocals.flac'), 'VOCALS.FLAC')
      await utimes(join(dir, 'stems/vocals.flac'), 1, 1)
    }
    if (change === 'replaced on sync') {
      const { writeSettings } = await import('../../src/main/settings')
      writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
      const { gdriveSync } = await import('../../src/main/gdrive')
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 3 })
    } else expect((await saveProject(join(dir, 'song.mp3'), 'Stem edit', { transpose: 0, tracks: {}, custom: [] })).ok).toBe(true)
    const saved = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(saved.settings.nativeEmptyTracks).toBeUndefined()
    expect(saved.settings.nativeOriginalDisabled).toBe(true)
    expect(saved.nativeRecoveryInventory).toBeUndefined()
    expect(Object.keys(saved.stemHashes)).toEqual(change === 'removed' ? ['drums.flac'] : ['drums.flac', 'vocals.flac'])
  })

  it.each(['legacy hashes without inventory', 'malformed inventory behind legacy hashes', 'missing original-disabled flag', 'symlinked song'])
    ('skips an empty marker with %s instead of publishing recovery media', async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'singz-unproven-empty-'))
      const dir = join(root, `Unproven ${kind}`)
      await mkdir(join(dir, 'stems'), { recursive: true })
      await writeFile(join(dir, 'stems/vocals.flac'), 'retained recovery stem')
      const hashes = kind.includes('hashes') ? { 'vocals.flac': {
        md5: createHash('md5').update('retained recovery stem').digest('hex'), size: 22, mtimeMs: 0
      } } : {}
      let nativeRecoveryInventory: unknown
      if (kind === 'malformed inventory behind legacy hashes') nativeRecoveryInventory = 'not an inventory'
      if (kind === 'symlinked song') {
        await writeFile(join(dir, 'song.mp3'), 'retired original')
        nativeRecoveryInventory = await recoveryInventory(dir, ['song.mp3', 'stems/vocals.flac'])
        const outside = join(root, 'outside.mp3')
        await writeFile(outside, 'different outside media')
        await unlink(join(dir, 'song.mp3'))
        await symlink(outside, join(dir, 'song.mp3'))
      }
      const before = JSON.stringify({ version: 2, name: `Unproven ${kind}`,
        savedAt: new Date(2000).toISOString(), stemHashes: hashes, nativeRecoveryInventory,
        ...(kind === 'symlinked song' ? { songFile: 'song.mp3' } : {}),
        settings: { nativeEmptyTracks: true, custom: [],
          ...(kind === 'missing original-disabled flag' ? {} : { nativeOriginalDisabled: true }) } })
      await writeFile(join(dir, 'project.json'), before)
      const { writeSettings } = await import('../../src/main/settings')
      writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
      const { gdriveSync } = await import('../../src/main/gdrive')
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 0 })
      expect([...mock.files.values()].filter(f => !f.trashed && f.name === `Unproven ${kind}`)).toEqual([])
      expect(await readFile(join(dir, 'project.json'), 'utf8')).toBe(before)
      expect(await readFile(join(dir, 'stems/vocals.flac'), 'utf8')).toBe('retained recovery stem')
    })

  it.each(['rawJSON', 'reviver source', 'stat error'])('skips an empty project on %s', async (missing) => {
    const root = await mkdtemp(join(tmpdir(), 'singz-json-feature-'))
    const dir = join(root, `Feature ${missing}`)
    await mkdir(join(dir, 'stems'), { recursive: true })
    await writeFile(join(dir, 'stems/vocals.flac'), 'retained audio')
    await utimes(join(dir, 'stems/vocals.flac'), 1, 1)
    await writeFile(join(dir, 'project.json'), JSON.stringify({ version: 2, name: `Feature ${missing}`,
      savedAt: new Date(2000).toISOString(), stemHashes: {},
      nativeRecoveryInventory: await recoveryInventory(dir, ['stems/vocals.flac']),
      settings: { nativeEmptyTracks: true, nativeOriginalDisabled: true, custom: [] } }))
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
    const { gdriveSync } = await import('../../src/main/gdrive')
    const before = await readFile(join(dir, 'project.json'), 'utf8')
    const parse = JSON.parse
    const descriptor = Object.getOwnPropertyDescriptor(JSON, 'rawJSON')!
    try {
      if (missing === 'rawJSON') Object.defineProperty(JSON, 'rawJSON', { ...descriptor, value: undefined })
      else if (missing === 'stat error') failures.stat = join(dir, 'stems/vocals.flac')
      else vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => parse(text, reviver
        ? function (key, value) { return reviver.call(this, key, value) } : undefined))
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 0 })
      expect([...mock.files.values()].filter(f => !f.trashed && f.name === `Feature ${missing}`)).toEqual([])
      expect(await readFile(join(dir, 'project.json'), 'utf8')).toBe(before)
    } finally {
      Object.defineProperty(JSON, 'rawJSON', descriptor)
      failures.stat = ''
      vi.restoreAllMocks()
    }
  })
})

/** Every install shares one OAuth client, so a sync sees every desktop's and
 *  every library's folders. Only folders this install put THIS library into
 *  may be trashed; the catalog keeps everyone else's rows. */
describe('remote folders this install never synced', () => {
  const library = async (prefix: string, names: string[]): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), `singz-lineage-${prefix}-`))
    for (const name of names) await seedProject(root, name)
    return root
  }
  const signIn = async (): Promise<void> => {
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 } })
  }
  /** No lineage on disk: a fresh profile, or one upgraded from before it existed. */
  const forgetLineage = async (): Promise<void> => {
    const { app } = await import('electron')
    await unlink(join(app.getPath('userData'), 'drive-lineage.json')).catch(() => {})
  }
  const trashedFolders = (): string[] =>
    [...mock.files.values()].filter((f) => f.trashed && f.mimeType === FOLDER_MIME).map((f) => f.name).sort()
  const catalogDirs = (): string[] => {
    const cat = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)
    return JSON.parse(cat!.bytes!.toString()).projects.map((p: { dir: string }) => p.dir)
  }
  const FOLDER_MIME = 'application/vnd.google-apps.folder'
  const OTHERS = ['Other A', 'Other B', 'Other C']

  it('a fresh profile with a small library trashes nothing and keeps every catalog row', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    // Another desktop's library, already on Drive with its catalog.
    expect(await gdriveSync({ root: await library('other', OTHERS) })).toMatchObject({ ok: true, projects: 3 })
    await forgetLineage()

    const root = await library('fresh', ['Mine 1', 'Mine 2'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 2 })
    expect(trashedFolders()).toEqual([])
    expect(catalogDirs()).toEqual(['Mine 1', 'Mine 2', ...OTHERS])
    // a second run is stable
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 0 })
    expect(trashedFolders()).toEqual([])
    expect(catalogDirs()).toEqual(['Mine 1', 'Mine 2', ...OTHERS])

    // A real delete of a project this install synced still reaches Drive.
    await rm(join(root, 'Mine 2'), { recursive: true })
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
    expect(trashedFolders()).toEqual(['Mine 2'])
    expect(catalogDirs()).toEqual(['Mine 1', ...OTHERS])
  })

  it('a library switch keeps the previous library on Drive and in the catalog', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync({ root: await library('before', OTHERS) })).toMatchObject({ ok: true, projects: 3 })
    expect(await gdriveSync({ root: await library('after', ['Mine 1', 'Mine 2']) })).toMatchObject({ ok: true, projects: 2 })
    expect(trashedFolders()).toEqual([])
    expect(catalogDirs()).toEqual(['Mine 1', 'Mine 2', ...OTHERS])
  })

  const lineagePath = async (): Promise<string> => join((await import('electron')).app.getPath('userData'), 'drive-lineage.json')
  const folderNamed = (name: string) => [...mock.files.values()].find((f) => f.name === name && f.mimeType === FOLDER_MIME && !f.trashed)
  const singzFolder = () => folderNamed('SingZ')!
  const editStem = (root: string, name: string) =>
    writeFile(join(root, name, 'stems', 'vocals.flac'), Buffer.from(`fLaC-edited-${Math.random()}`))

  it.each(['missing', 'corrupt'])('a %s lineage seeds nothing by name, and a partial republish proves nothing', async (damage) => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library(`damage-${damage}`, ['Kept', 'Deleted before proof', 'Deleted after proof'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 3 })
    if (damage === 'missing') await forgetLineage()
    else await writeFile(await lineagePath(), '{"format":2,"bindings":')
    // a clean run against same-named folders proves nothing about who made them
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 0 })
    await rm(join(root, 'Deleted before proof'), { recursive: true })
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 2 })
    expect(trashedFolders()).toEqual([])
    expect(catalogDirs()).toEqual(['Deleted after proof', 'Deleted before proof', 'Kept'])
    // republishing two of its files leaves members this run did not write:
    // the folder stays pending, and on Drive, for good
    await editStem(root, 'Deleted after proof')
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, uploaded: 2 })
    await rm(join(root, 'Deleted after proof'), { recursive: true })
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
    expect(trashedFolders()).toEqual([])
    expect(catalogDirs()).toEqual(['Deleted after proof', 'Deleted before proof', 'Kept'])
  })

  it('a run that writes every member of a same-named folder, and verifies it, owns it', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('proof', ['Zed'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true })
    const theirs = putFile(mock.store, { name: 'Song', mimeType: FOLDER_MIME, parents: [singzFolder().id] })
    putFile(mock.store, { name: 'project.json', mimeType: 'application/json', parents: [theirs.id], bytes: Buffer.from('{}') })
    await seedProject(root, 'Song')
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 2 })
    expect(folderNamed('Song')?.id).toBe(theirs.id)
    await rm(join(root, 'Song'), { recursive: true })
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
    expect(trashedFolders()).toEqual(['Song'])
  })

  it.each(['plain', 'with a foreign stems/Private folder'])(
    'a failed upload, an undo and a clean sync never prove another desktop\'s folder (%s)', async (variant) => {
      mock.files.clear()
      await signIn()
      const { gdriveSync } = await import('../../src/main/gdrive')
      const { cp, stat: statFile } = await import('node:fs/promises')
      const a = await library(`undo-a-${variant.length}`, ['Song', 'Zed'])
      expect(await gdriveSync({ root: a })).toMatchObject({ ok: true })
      if (variant !== 'plain') {
        const stemsDir = [...mock.files.values()].find((f) => f.name === 'stems' && f.parents.includes(folderNamed('Song')!.id))!
        const priv = putFile(mock.store, { name: 'Private', mimeType: FOLDER_MIME, parents: [stemsDir.id] })
        putFile(mock.store, { name: 'take.wav', mimeType: 'audio/wav', parents: [priv.id], bytes: Buffer.from('A only') })
      }
      // Desktop B holds A's exact bytes (a copied library, timestamps kept).
      const b = await mkdtemp(join(tmpdir(), 'singz-lineage-undo-b-'))
      await cp(a, b, { recursive: true, preserveTimestamps: true })
      const keep = async (rel: string) => ({ rel, bytes: await readFile(join(b, rel)), at: (await statFile(join(b, rel))).mtime })
      const saved = [await keep('Song/project.json'), await keep('Song/stems/vocals.flac')]
      // B edits; its upload fails before any byte lands on Drive
      await editStem(b, 'Song')
      mock.store.faults.push({ match: /^(POST|PATCH|PUT) \/upload/, status: 500, times: Infinity })
      try {
        expect(await gdriveSync({ root: b })).toMatchObject({ ok: false })
      } finally {
        mock.store.faults.length = 0
      }
      // ...then undoes the edit, back to A's exact bytes
      for (const f of saved) {
        await writeFile(join(b, f.rel), f.bytes)
        await utimes(join(b, f.rel), f.at, f.at)
      }
      expect(await gdriveSync({ root: b })).toMatchObject({ ok: true, uploaded: 0 })
      await rm(join(b, 'Song'), { recursive: true })
      expect(await gdriveSync({ root: b })).toMatchObject({ ok: true, projects: 1 })
      expect(trashedFolders()).toEqual([])
      if (variant !== 'plain') expect([...mock.files.values()].some((f) => f.name === 'take.wav' && !f.trashed)).toBe(true)
    })

  it('a same-named publication by another desktop during this run keeps its row', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('shared', ['Mine', 'Shared'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true })
    await editStem(root, 'Mine')
    const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex')
    let native: { id: string; name: string; size: string; md5Checksum: string } | null = null
    // While this run uploads Mine, native publishes a new generation of
    // Shared — the same song this library holds, unchanged here.
    const interleave = (): void => {
      const folder = folderNamed('Shared')!
      const doc = [...mock.files.values()].find((f) => f.name === 'project.json' && f.parents.includes(folder.id) && !f.trashed)!
      doc.bytes = Buffer.from('{"name":"Shared","savedAt":"native"}')
      native = { id: doc.id, name: 'project.json', size: String(doc.bytes.length), md5Checksum: md5(doc.bytes) }
      const catalog = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)!
      const cat = JSON.parse(catalog.bytes!.toString())
      const row = cat.projects.find((p: { dir: string }) => p.dir === 'Shared')
      row.files = row.files.map((f: { name: string }) => (f.name === 'project.json' ? native : f))
      catalog.bytes = Buffer.from(JSON.stringify(cat))
    }
    expect(await gdriveSync({ root, onProgress: (msg) => { if (!native && msg.startsWith('Uploading Mine/')) interleave() } }))
      .toMatchObject({ ok: true, uploaded: 2 })
    expect(native).not.toBeNull()
    const cat = JSON.parse([...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)!.bytes!.toString())
    expect(cat.projects.map((p: { dir: string }) => p.dir)).toEqual(['Mine', 'Shared'])
    expect(cat.projects.find((p: { dir: string }) => p.dir === 'Shared').files.find((f: { name: string }) => f.name === 'project.json'))
      .toEqual(native)
  })

  it('an unreadable lineage stops the run before anything is published or removed', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('unreadable', ['Song', 'Zed'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true })
    await rm(join(root, 'Song'), { recursive: true })
    await editStem(root, 'Zed')
    const path = await lineagePath()
    await rm(path, { force: true })
    await mkdir(path) // EISDIR on read
    try {
      mock.hits.length = 0
      expect(await gdriveSync({ root })).toMatchObject({ ok: false })
      expect(mock.hits.some((h) => h.includes('uploadType') || h.startsWith('PATCH'))).toBe(false)
      expect(trashedFolders()).toEqual([])
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  })

  it('a failed first upload into another desktop\'s same-named folder never makes that folder ours', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    // Desktop A owns "Song" on Drive, and keeps a file of its own beside it.
    expect(await gdriveSync({ root: await library('desktop-a', ['Song', 'Other']) })).toMatchObject({ ok: true })
    const theirs = folderNamed('Song')!
    putFile(mock.store, { name: 'notes.txt', mimeType: 'text/plain', parents: [theirs.id], bytes: Buffer.from('A only') })

    // Desktop B has a different "Song". Its first upload into A's folder fails.
    const b = await library('desktop-b', ['Song', 'Zed'])
    await editStem(b, 'Song')
    mock.store.faults.push({ match: /^PUT \/upload/, status: 500, times: Infinity })
    try {
      expect(await gdriveSync({ root: b })).toMatchObject({ ok: false })
    } finally {
      mock.store.faults.length = 0
    }
    await rm(join(b, 'Song'), { recursive: true })
    expect(await gdriveSync({ root: b })).toMatchObject({ ok: true, projects: 1 })
    expect(trashedFolders()).toEqual([])

    // Desktop C's "Song" is pushed into A's folder in full — but the folder
    // still holds A's unmanaged file, so C cannot prove it is its own.
    const c = await library('desktop-c', ['Song', 'Zed'])
    expect(await gdriveSync({ root: c })).toMatchObject({ ok: true })
    await rm(join(c, 'Song'), { recursive: true })
    expect(await gdriveSync({ root: c })).toMatchObject({ ok: true, projects: 1 })
    expect(trashedFolders()).toEqual([])
    expect(folderNamed('Song')?.id).toBe(theirs.id)
    expect([...mock.files.values()].some((f) => f.name === 'notes.txt' && f.parents.includes(theirs.id) && !f.trashed)).toBe(true)
  })

  it('a different library folder put at the same path has no deletion authority', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('replaced', ['Song', 'Zed'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true })
    // restored from a backup, or another volume mounted there: same path, new directory
    const { rename } = await import('node:fs/promises')
    await rename(root, `${root}.old`)
    await mkdir(root)
    await seedProject(root, 'Zed')
    expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
    expect(trashedFolders()).toEqual([])
    expect(catalogDirs()).toEqual(['Song', 'Zed'])
  })

  it('another Google account in the same Drive namespace has no deletion authority', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('account', ['Song', 'Zed'])
    mock.store.permissionId = 'account-one'
    try {
      expect(await gdriveSync({ root })).toMatchObject({ ok: true })
      const { writeSettings } = await import('../../src/main/settings')
      writeSettings({ gdrive: { access: 'mock-access-2', refresh: 'mock-refresh-2', expiresAt: Date.now() + 3600_000 } })
      mock.store.permissionId = 'account-two'
      await rm(join(root, 'Song'), { recursive: true })
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
      expect(trashedFolders()).toEqual([])
    } finally {
      delete mock.store.permissionId
    }
  })

  it('when Drive will not name the account, the run syncs but removes and claims nothing', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('no-account', ['Song', 'Zed'])
    const { writeSettings } = await import('../../src/main/settings')
    writeSettings({ gdrive: { access: 'mock-access', refresh: 'mock-refresh-anon', expiresAt: Date.now() + 3600_000 } })
    mock.store.faults.push({ match: /^GET \/drive\/v3\/about/, status: 500, times: Infinity })
    try {
      // folders created while the account is unknown are never claimed
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 2 })
      await rm(join(root, 'Song'), { recursive: true })
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
      expect(trashedFolders()).toEqual([])
      expect(catalogDirs()).toEqual(['Song', 'Zed'])
    } finally {
      mock.store.faults.length = 0
    }
    // Drive answers again: those folders still were never proven ours
    expect(await gdriveSync({ root })).toMatchObject({ ok: true })
    expect(trashedFolders()).toEqual([])
  })

  it('merges what another desktop publishes, updates and retires while this run uploads', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    expect(await gdriveSync({ root: await library('native', ['Kept Gone', 'Kept Upd']) })).toMatchObject({ ok: true })
    const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex')
    const row = (doc: { id: string; bytes?: Buffer }) => ({ id: doc.id, name: 'project.json', size: String(doc.bytes!.length), md5Checksum: md5(doc.bytes!) })
    let interleaved = false
    const interleave = (): void => {
      interleaved = true
      const catalog = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)!
      const doc = JSON.parse(catalog.bytes!.toString())
      // addition: a new folder and its row
      const added = putFile(mock.store, { name: 'Added', mimeType: FOLDER_MIME, parents: [singzFolder().id] })
      const addedDoc = putFile(mock.store, { name: 'project.json', mimeType: 'application/json', parents: [added.id], bytes: Buffer.from('{"name":"Added"}') })
      doc.projects.push({ dir: 'Added', files: [row(addedDoc)] })
      // update: a new document generation, and its row
      const upd = folderNamed('Kept Upd')!
      const updDoc = [...mock.files.values()].find((f) => f.name === 'project.json' && f.parents.includes(upd.id) && !f.trashed)!
      updDoc.bytes = Buffer.from('{"name":"Kept Upd","savedAt":"later"}')
      const updRow = doc.projects.find((p: { dir: string }) => p.dir === 'Kept Upd')
      updRow.files = updRow.files.map((f: { name: string }) => (f.name === 'project.json' ? row(updDoc) : f))
      // retirement: the folder goes; its writer has not rewritten the catalog yet
      folderNamed('Kept Gone')!.trashed = true
      catalog.bytes = Buffer.from(JSON.stringify(doc))
    }
    const root = await library('mine', ['Mine'])
    expect(await gdriveSync({ root, onProgress: (msg) => { if (!interleaved && msg.startsWith('Uploading Mine/')) interleave() } }))
      .toMatchObject({ ok: true })
    expect(interleaved).toBe(true)
    expect(catalogDirs()).toEqual(['Added', 'Kept Upd', 'Mine'])
    const cat = JSON.parse([...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)!.bytes!.toString())
    const upd = folderNamed('Kept Upd')!
    const updDoc = [...mock.files.values()].find((f) => f.name === 'project.json' && f.parents.includes(upd.id) && !f.trashed)!
    expect(cat.projects.find((p: { dir: string }) => p.dir === 'Kept Upd').files.find((f: { name: string }) => f.name === 'project.json'))
      .toEqual(row(updDoc))
  })

  it('a library folder with no stable identity still syncs, and claims and removes nothing', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const { realpathSync } = await import('node:fs')
    const root = await library('no-inode', ['Song', 'Zed'])
    failures.noInode = realpathSync(root)
    try {
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 2 })
      expect(catalogDirs()).toEqual(['Song', 'Zed'])
      await rm(join(root, 'Song'), { recursive: true })
      expect(await gdriveSync({ root })).toMatchObject({ ok: true, projects: 1 })
      expect(trashedFolders()).toEqual([])
      expect(catalogDirs()).toEqual(['Song', 'Zed'])
    } finally {
      failures.noInode = ''
    }
  })

  it('a song renamed away and replaced under its name during this run keeps the new folder\'s row', async () => {
    mock.files.clear()
    await signIn()
    const { gdriveSync } = await import('../../src/main/gdrive')
    const root = await library('replace-name', ['Mine', 'Shared'])
    expect(await gdriveSync({ root })).toMatchObject({ ok: true })
    await editStem(root, 'Mine')
    const md5 = (bytes: Buffer): string => createHash('md5').update(bytes).digest('hex')
    let replacement: { id: string; name: string; size: string; md5Checksum: string } | null = null
    // Another writer renames Shared to Moved, then publishes a new Shared.
    const interleave = (): void => {
      const old = folderNamed('Shared')!
      old.name = 'Moved'
      const fresh = putFile(mock.store, { name: 'Shared', mimeType: FOLDER_MIME, parents: [singzFolder().id] })
      const doc = putFile(mock.store, { name: 'project.json', mimeType: 'application/json', parents: [fresh.id], bytes: Buffer.from('{"name":"Shared","by":"native"}') })
      replacement = { id: doc.id, name: 'project.json', size: String(doc.bytes!.length), md5Checksum: md5(doc.bytes!) }
      const catalog = [...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)!
      const cat = JSON.parse(catalog.bytes!.toString())
      const moved = cat.projects.find((p: { dir: string }) => p.dir === 'Shared')
      moved.dir = 'Moved'
      cat.projects.push({ dir: 'Shared', files: [replacement] })
      catalog.bytes = Buffer.from(JSON.stringify(cat))
    }
    expect(await gdriveSync({ root, onProgress: (msg) => { if (!replacement && msg.startsWith('Uploading Mine/')) interleave() } }))
      .toMatchObject({ ok: true, uploaded: 2 })
    expect(replacement).not.toBeNull()
    const cat = JSON.parse([...mock.files.values()].find((f) => f.name === 'catalog.json' && !f.trashed)!.bytes!.toString())
    expect(cat.projects.map((p: { dir: string }) => p.dir)).toEqual(['Mine', 'Moved', 'Shared'])
    expect(cat.projects.find((p: { dir: string }) => p.dir === 'Shared').files).toEqual([replacement])
  })
})
