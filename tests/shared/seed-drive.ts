import { createHash } from 'node:crypto'
import { FOLDER, putFile, type FakeDriveStore, type FakeFile } from './fake-drive'
import type { Scenario, ScenarioProject } from './scenarios'

/**
 * A Drive store shaped exactly like one the desktop has synced: a SingZ folder,
 * a folder per project holding project.json + lyrics.json + stems/, and a
 * format-2 catalog.json naming each project.json and lyrics.json with the md5s
 * of their real bytes.
 *
 * Kept separate from the desktop's own sync so the mobile suite can set up a
 * library without an Electron main process — the genuine round trip (real
 * gdriveSync writing this same shape) lives in tests/roundtrip.
 */

export interface SeededProject {
  dir: string
  folderId: string
  stemsId: string
  doc: FakeFile
  lyrics?: FakeFile
  stems: Map<string, FakeFile>
}

export interface SeededDrive {
  rootId: string
  catalog: FakeFile
  projects: Map<string, SeededProject>
  /** Rebuild catalog.json from the store's current state — call after any edit
   *  that a desktop sync would have followed with a catalog write. */
  rewriteCatalog(): void
}

const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v))

const md5Of = (b?: Buffer): string => createHash('md5').update(b ?? Buffer.alloc(0)).digest('hex')

/** project.json as the desktop leaves it: hashes for every file in stems/,
 *  plus lyricsHash, so the doc names everything the project is made of. */
function docBytes(p: ScenarioProject, stems: Map<string, FakeFile>, lyrics?: FakeFile): Buffer {
  const stemHashes: Record<string, { md5: string; size: number; mtimeMs: number }> = {}
  let t = 1
  for (const [name, f] of stems) {
    stemHashes[name] = {
      md5: md5Of(f.bytes),
      size: f.bytes?.length ?? 0,
      mtimeMs: t++
    }
  }
  const lyricsHash = lyrics?.bytes
    ? {
        md5: md5Of(lyrics.bytes),
        size: lyrics.bytes.length,
        mtimeMs: t++
      }
    : undefined
  return json({
    version: 2,
    name: p.name,
    songFile: 'song.mp3',
    savedAt: p.savedAt,
    settings: { transpose: 0, tracks: {}, custom: p.custom ?? null, ...p.settings },
    stemHashes,
    ...(lyricsHash ? { lyricsHash } : {})
  })
}

export function seedDrive(store: FakeDriveStore, scenario: Scenario): SeededDrive {
  const rootId = putFile(store, { name: 'SingZ', mimeType: FOLDER, parents: ['drive-root'] }).id
  const projects = new Map<string, SeededProject>()

  for (const p of scenario.projects) {
    const folderId = putFile(store, { name: p.dir, mimeType: FOLDER, parents: [rootId] }).id
    const stemsId = putFile(store, { name: 'stems', mimeType: FOLDER, parents: [folderId] }).id
    const stems = new Map<string, FakeFile>()
    let lyrics: FakeFile | undefined
    for (const f of p.files) {
      const bytes = Buffer.from(f.body)
      if (f.path.startsWith('stems/')) {
        const name = f.path.slice('stems/'.length)
        stems.set(name, putFile(store, { name, mimeType: 'audio/flac', parents: [stemsId], bytes }))
      } else if (f.path === 'lyrics.json') {
        lyrics = putFile(store, { name: 'lyrics.json', mimeType: 'application/json', parents: [folderId], bytes })
      }
    }
    const doc = putFile(store, {
      name: 'project.json',
      mimeType: 'application/json',
      parents: [folderId],
      bytes: docBytes(p, stems, lyrics)
    })
    projects.set(p.dir, { dir: p.dir, folderId, stemsId, doc, lyrics, stems })
  }

  const catalog = putFile(store, {
    name: 'catalog.json',
    mimeType: 'application/json',
    parents: [rootId],
    bytes: Buffer.alloc(0)
  })
  const seeded: SeededDrive = {
    rootId,
    catalog,
    projects,
    rewriteCatalog: () => {
      catalog.bytes = json({
        format: 2,
        projects: [...projects.values()].map((p) => ({
          dir: p.dir,
          files: [
            { id: p.doc.id, name: 'project.json', size: String(p.doc.bytes?.length ?? 0), md5Checksum: md5Of(p.doc.bytes) },
            ...(p.lyrics
              ? [
                  {
                    id: p.lyrics.id,
                    name: 'lyrics.json',
                    size: String(p.lyrics.bytes?.length ?? 0),
                    md5Checksum: md5Of(p.lyrics.bytes)
                  }
                ]
              : [])
          ]
        }))
      })
    }
  }
  seeded.rewriteCatalog()
  return seeded
}
