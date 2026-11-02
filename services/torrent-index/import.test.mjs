import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { importCatalog } from './import.mjs'
import { FilenameIndex } from './index.mjs'
const addonPath = resolve(
  process.env.SINGZ_TORRENT_ADDON ??
    `vendor/torrent/${process.platform}-${process.arch}/singz-torrent.node`
)
function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length + ':'), v])
  if (typeof v === 'string') return bencode(Buffer.from(v))
  if (typeof v === 'number') return Buffer.from('i' + v + 'e')
  if (Array.isArray(v))
    return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')])
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(v)
      .sort()
      .flatMap((k) => [bencode(k), bencode(v[k])]),
    Buffer.from('e')
  ])
}
test(
  'imports actual .torrent metadata through the C++ parser without retaining private tracker data',
  {
    skip:
      !existsSync(addonPath) && 'Build npm run torrent:addon to run the native importer integration'
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'singz-index-test-'))
    try {
      const privateTracker = 'https://tracker.invalid/private-passkey-should-not-be-indexed'
      const metadata = bencode({
        announce: privateTracker,
        info: {
          name: 'Mutter',
          files: [{ length: 1000, path: ['Sonne.flac'] }],
          'piece length': 16384,
          pieces: createHash('sha1').update(Buffer.alloc(1000)).digest()
        }
      })
      await writeFile(join(directory, '1.torrent'), metadata)
      await writeFile(
        join(directory, 'manifest.jsonl'),
        JSON.stringify({ id: '12345', title: 'Mutter', seeders: 11, metadataFile: '1.torrent' }) +
          '\n'
      )
      const dbPath = join(directory, 'index.sqlite')
      const result = await importCatalog({
        dbPath,
        manifestPath: join(directory, 'manifest.jsonl'),
        metadataDir: directory,
        addonPath,
        source: 'Fixture snapshot'
      })
      assert.equal(result.coverage.complete, true)
      const db = new FilenameIndex(dbPath)
      try {
        assert.equal(db.search('sonne').releases[0].title, 'Mutter')
        assert.equal(db.search('sonne').releases[0].matches[0].index, 0)
        assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1)
      } finally {
        db.close()
      }
      assert.equal((await readFile(dbPath)).includes(Buffer.from(privateTracker)), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
