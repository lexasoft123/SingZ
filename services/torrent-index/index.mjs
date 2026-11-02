import { DatabaseSync } from 'node:sqlite'

const ID = /^[1-9][0-9]{0,11}$/
const AUDIO = /\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|aif|aiff)$/i
const fold = (value) => value.normalize('NFKC').toLowerCase()
const integer = (value) => Number.isSafeInteger(value) && value >= 0
export class FilenameIndex {
  constructor(path) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, size INTEGER NOT NULL,
        seeders INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        rowid INTEGER PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
        file_index INTEGER NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
        size INTEGER NOT NULL, folded TEXT NOT NULL, UNIQUE(release_id,file_index)
      );
      CREATE INDEX IF NOT EXISTS files_release ON files(release_id);
      CREATE TABLE IF NOT EXISTS expected_releases(id TEXT PRIMARY KEY, imported INTEGER NOT NULL DEFAULT 0);
      CREATE VIRTUAL TABLE IF NOT EXISTS names USING fts5(folded, content='files', content_rowid='rowid', tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS files_insert AFTER INSERT ON files BEGIN
        INSERT INTO names(rowid,folded) VALUES(new.rowid,new.folded);
      END;
      CREATE TRIGGER IF NOT EXISTS files_delete AFTER DELETE ON files BEGIN
        INSERT INTO names(names,rowid,folded) VALUES('delete',old.rowid,old.folded);
      END;
      CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), expected INTEGER, source TEXT NOT NULL, imported_at TEXT);
      INSERT OR IGNORE INTO catalog VALUES(1,NULL,'Not populated',NULL);`)
  }
  close() {
    this.db.close()
  }
  /** Import only verified metadata, never announcement URLs or passkeys. */
  put(release, listing) {
    if (
      !release ||
      !ID.test(release.id) ||
      typeof release.title !== 'string' ||
      !release.title.trim() ||
      release.title.length > 2000 ||
      !integer(release.seeders)
    )
      throw new Error('Invalid release record')
    if (
      !listing ||
      !integer(listing.total) ||
      !Array.isArray(listing.files) ||
      listing.files.length > 25000
    )
      throw new Error('Invalid file listing')
    const seen = new Set()
    for (const f of listing.files) {
      if (
        !f ||
        !integer(f.index) ||
        f.index >= 25000 ||
        seen.has(f.index) ||
        typeof f.name !== 'string' ||
        !f.name ||
        f.name.length > 1024 ||
        typeof f.path !== 'string' ||
        !f.path ||
        f.path.length > 8192 ||
        !integer(f.size)
      )
        throw new Error('Invalid file record')
      seen.add(f.index)
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM releases WHERE id=?').run(release.id)
      this.db
        .prepare('INSERT INTO releases VALUES(?,?,?,?,?)')
        .run(release.id, release.title, listing.total, release.seeders, new Date().toISOString())
      const insert = this.db.prepare(
        'INSERT INTO files(release_id,file_index,name,path,size,folded) VALUES(?,?,?,?,?,?)'
      )
      for (const f of listing.files)
        if (AUDIO.test(f.name))
          insert.run(release.id, f.index, f.name, f.path, f.size, fold(f.name))
      this.db.prepare('UPDATE expected_releases SET imported=1 WHERE id=?').run(release.id)
      this.db.prepare('UPDATE catalog SET imported_at=? WHERE id=1').run(new Date().toISOString())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  /** State scope explicitly: a missing release must never silently count as searched. */
  setCatalog(source, ids) {
    if (
      typeof source !== 'string' ||
      !source.trim() ||
      source.length > 500 ||
      (ids !== null && !Array.isArray(ids))
    )
      throw new Error('Invalid catalog description')
    if (ids?.some((id) => !ID.test(id)) || (ids && new Set(ids).size !== ids.length))
      throw new Error('Invalid catalog membership')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM expected_releases')
      const insert = this.db.prepare('INSERT INTO expected_releases(id) VALUES(?)')
      for (const id of ids ?? []) insert.run(id)
      this.db
        .prepare('UPDATE catalog SET source=?,expected=? WHERE id=1')
        .run(source, ids?.length ?? null)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  coverage() {
    const row = this.db.prepare('SELECT * FROM catalog WHERE id=1').get()
    const scope =
      row.expected === null
        ? ''
        : 'WHERE r.id IN (SELECT id FROM expected_releases WHERE imported=1)'
    const indexed = this.db.prepare('SELECT COUNT(*) AS count FROM releases r ' + scope).get().count
    const files = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM files f JOIN releases r ON r.id=f.release_id ' + scope
      )
      .get().count
    return {
      indexedTorrents: indexed,
      indexedFiles: files,
      expectedTorrents: row.expected,
      source: row.source,
      updatedAt: row.imported_at,
      complete: row.expected !== null && indexed === row.expected
    }
  }
  search(query, offset = 0, limit = 50) {
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.length > 200 ||
      !integer(offset) ||
      offset > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error('Invalid filename search')
    const terms = fold(query).trim().split(/\s+/u)
    const indexedTerms = terms.filter((term) => [...term].length >= 3)
    if (!indexedTerms.length)
      throw new Error('Use at least one search word with 3 or more characters')
    const expression = indexedTerms
      .map((term) => '"' + term.replaceAll('"', '""') + '"')
      .join(' AND ')
    const filters = terms.map(() => "f.folded LIKE ? ESCAPE '\\'").join(' AND ')
    const args = [expression, ...terms.map((term) => '%' + term.replace(/[\\%_]/g, '\\$&') + '%')]
    const from = `FROM names JOIN files f ON f.rowid=names.rowid JOIN releases r ON r.id=f.release_id WHERE names MATCH ? AND ${filters} AND ((SELECT expected FROM catalog WHERE id=1) IS NULL OR r.id IN (SELECT id FROM expected_releases WHERE imported=1))`
    const rows = this.db
      .prepare(
        `SELECT r.*,COUNT(*) AS match_count ${from} GROUP BY r.id ORDER BY r.seeders DESC,r.id ASC LIMIT ? OFFSET ?`
      )
      .all(...args, limit + 1, offset)
    const matches = this.db.prepare(
      `SELECT f.file_index AS 'index',f.name,f.path,f.size ${from} AND r.id=? ORDER BY f.file_index LIMIT 5`
    )
    return {
      releases: rows.slice(0, limit).map((r) => ({
        id: r.id,
        title: r.title,
        size: r.size,
        seeders: r.seeders,
        seedersUpdatedAt: r.updated_at,
        matchCount: r.match_count,
        matches: matches.all(...args, r.id)
      })),
      nextOffset: offset + limit,
      hasMore: rows.length > limit,
      coverage: this.coverage()
    }
  }
}
