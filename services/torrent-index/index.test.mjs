import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FilenameIndex } from './index.mjs'
import { createIndexServer } from './server.mjs'
const file = (index, name, path = name) => ({ index, name, path, size: 1000 })
const release = (id, title, seeders) => ({ id, title, seeders })
test('finds Sonne inside unrelated titles, sorted only by seeders, grouping matching filenames', () => {
  const db = new FilenameIndex(':memory:')
  try {
    db.setCatalog('Fixture snapshot', ['101', '102', '103', '104'])
    db.put(release('101', 'Mutter', 10), {
      total: 2000,
      files: [file(0, '05 - Sonne.flac'), file(1, 'Ich will.flac')]
    })
    db.put(release('102', 'Complete Discography', 90), {
      total: 3000,
      files: [
        file(0, 'Sonne.mp3', '2001/Sonne.mp3'),
        file(1, 'Sonne live.flac'),
        file(2, 'Mutter.flac')
      ]
    })
    db.put(release('103', 'Sonne', 999), {
      total: 1000,
      files: [file(0, 'Unrelated.flac')]
    })
    db.put(release('104', 'Folder match only', 800), {
      total: 1000,
      files: [file(0, 'Other.flac', 'Sonne/Other.flac')]
    })
    const data = db.search('SONNE')
    assert.deepEqual(
      data.releases.map((r) => r.id),
      ['102', '101']
    )
    assert.equal(data.releases[0].matchCount, 2)
    assert.equal(data.releases[0].matches[0].path, '2001/Sonne.mp3')
    assert.equal(data.coverage.complete, true)
    assert.equal(data.coverage.indexedTorrents, 4)
    db.setCatalog('Next snapshot', ['101', '102', '103', '105'])
    assert.equal(db.coverage().complete, false)
    assert.equal(db.coverage().indexedTorrents, 0)
  } finally {
    db.close()
  }
})
test('updates replace obsolete file entries atomically and reject bad records without losing indexed data', () => {
  const db = new FilenameIndex(':memory:')
  try {
    db.put(release('1', 'Album', 1), {
      total: 1000,
      files: [file(0, 'Sonne.flac')]
    })
    assert.throws(() =>
      db.put(release('1', 'Album', 1), {
        total: 1000,
        files: [file(0, 'x.flac'), file(0, 'y.flac')]
      })
    )
    assert.equal(db.search('Sonne').releases.length, 1)
    db.put(release('1', 'Album', 2), {
      total: 1000,
      files: [file(0, 'Another.flac')]
    })
    assert.equal(db.search('Sonne').releases.length, 0)
  } finally {
    db.close()
  }
})
test('unicode names, short words alongside indexed words, literal wildcards and paging', () => {
  const db = new FilenameIndex(':memory:')
  try {
    db.put(release('1', 'Album', 1), {
      total: 1000,
      files: [file(0, 'Группа Крови.flac')]
    })
    db.put(release('2', 'Other album', 2), {
      total: 1000,
      files: [file(0, 'Du Hast.flac')]
    })
    db.put(release('3', 'Live album', 3), {
      total: 1000,
      files: [file(0, 'Sonne 100%.flac')]
    })
    assert.equal(db.search('крови').releases[0].id, '1')
    assert.equal(db.search('du hast').releases[0].id, '2')
    assert.equal(db.search('100%').releases[0].id, '3')
    assert.equal(db.search('100_').releases.length, 0)
    assert.throws(() => db.search('du'))
    assert.throws(() => db.search('sonne', -1))
    assert.equal(db.search('flac', 0, 1).hasMore, true)
    assert.equal(db.search('flac', 1, 1).releases[0].id, '2')
  } finally {
    db.close()
  }
})
test('real HTTP API returns metadata matches and reports unpopulated coverage explicitly', async () => {
  const db = new FilenameIndex(':memory:'),
    server = createIndexServer(db)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    let response = await fetch(base + '/v1/search?query=Sonne')
    assert.equal(response.status, 503)
    db.put(release('1', 'Mutter', 3), {
      total: 1000,
      files: [file(0, 'Sonne.flac')]
    })
    response = await fetch(base + '/v1/search?query=Sonne')
    const json = await response.json()
    assert.equal(json.data.releases[0].title, 'Mutter')
    assert.equal(json.data.releases[0].matches[0].name, 'Sonne.flac')
    assert.equal((await fetch(base + '/v1/search?query=du')).status, 400)
    assert.equal((await fetch(base + '/v1/status', { method: 'POST' })).status, 405)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    db.close()
  }
})
