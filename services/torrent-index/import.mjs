import { createReadStream } from 'node:fs'
import { readFile, mkdtemp, rm, realpath, stat, copyFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { FilenameIndex } from './index.mjs'

/** Manifest: one {id,title,seeders,metadataFile} record per RuTracker release.
 * The metadataFile is a local .torrent; it is never served or stored in SQLite.
 * Topic IDs must come from the catalog source, not guessed from an infohash. */
export async function importCatalog({ dbPath, manifestPath, metadataDir, addonPath, source }) {
  const native = createRequire(import.meta.url)(resolve(addonPath))
  const directory = await realpath(metadataDir)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'singz-index-import-'))
  let db
  try {
    // Import an immutable manifest snapshot, even if its producer replaces it.
    const snapshot = resolve(privateRoot, 'manifest.jsonl')
    await copyFile(manifestPath, snapshot)
    const ids = []
    async function* records() {
      const lines = createInterface({
        input: createReadStream(snapshot),
        crlfDelay: Infinity
      })
      for await (const line of lines) {
        if (!line.trim()) continue
        if (line.length > 16384) throw new Error('Manifest record too large')
        yield JSON.parse(line)
      }
    }
    for await (const record of records()) ids.push(record.id)
    db = new FilenameIndex(dbPath)
    db.setCatalog(source, ids)
    let imported = 0
    for await (const record of records()) {
      if (typeof record.metadataFile !== 'string') throw new Error('Missing torrent metadata file')
      const path = await realpath(resolve(directory, record.metadataFile))
      if (!path.startsWith(directory + sep)) throw new Error('Metadata path escapes its directory')
      if (!(await stat(path)).isFile() || (await stat(path)).size > 16777216)
        throw new Error('Torrent metadata too large or not a file')
      const metadata = await readFile(path)
      if (metadata.length > 16777216) throw new Error('Torrent metadata too large')
      const result = JSON.parse(
        await native.request(privateRoot, 'inspect', record.id, -1, metadata)
      )
      if (!result.ok) throw new Error('Invalid torrent metadata for topic ' + record.id)
      db.put(record, result.data)
      imported++
      // No cookie, passkey, original .torrent or announcement URL enters the index.
    }
    return { imported, coverage: db.coverage() }
  } finally {
    try {
      native.shutdown(privateRoot)
    } finally {
      try {
        db?.close()
      } finally {
        await rm(privateRoot, { recursive: true, force: true })
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [dbPath, manifestPath, metadataDir, addonPath, source] = process.argv.slice(2)
  if (!source)
    throw new Error(
      'Usage: node import.mjs <db> <manifest.jsonl> <metadata-dir> <addon.node> <catalog-source-label>'
    )
  console.log(
    JSON.stringify(
      await importCatalog({
        dbPath,
        manifestPath,
        metadataDir,
        addonPath,
        source
      })
    )
  )
}
