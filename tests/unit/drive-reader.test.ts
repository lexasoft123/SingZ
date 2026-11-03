import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { startMockDrive, putFile, FOLDER, type MockDrive } from './mock-drive'
import { writeSettings } from '../../src/main/settings'
import { driveProjectsRoot } from '../../src/main/drive-storage'
let mock: MockDrive
beforeAll(async () => {
  mock = await startMockDrive()
  process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify({ clientId: 'test-client', clientSecret: 'secret', apiBase: `http://127.0.0.1:${mock.port}` })
  writeSettings({ gdriveDirty: undefined, projectsRoot: await mkdtemp(join(tmpdir(), 'singz-reader-writer-')), gdrive: { access: 'mock-access', refresh: 'refresh', expiresAt: Date.now() + 3600000 } })
})
afterAll(async () => { await mock.close(); await rm(driveProjectsRoot(), { recursive: true, force: true }) })
function seed(name: string, corrupt = false): string {
  let root = [...mock.files.values()].find(f => f.name === 'SingZ')
  root ??= putFile(mock.store, { name: 'SingZ', mimeType: FOLDER, parents: [] })
  const project = putFile(mock.store, { name, mimeType: FOLDER, parents: [root.id] })
  const stems = putFile(mock.store, { name: 'stems', mimeType: FOLDER, parents: [project.id] })
  const hashes: Record<string, { md5: string; size: number }> = {}
  for (const stem of ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano', 'custom-test']) {
    const bytes = Buffer.from('fLaC-' + stem)
    hashes[stem + '.flac'] = { md5: createHash('md5').update(bytes).digest('hex'), size: bytes.length }
    putFile(mock.store, { name: stem + '.flac', mimeType: 'audio/flac', parents: [stems.id], bytes, md5Override: corrupt && stem === 'vocals' ? '0'.repeat(32) : undefined })
  }
  putFile(mock.store, { name: 'lyrics.json', mimeType: 'application/json', parents: [project.id], bytes: Buffer.from(JSON.stringify({ source: 'lrclib', lines: [{ start: 1, end: 2, text: 'Test', words: [{ w: 'Test', s: 1, e: 2 }] }] })) })
  putFile(mock.store, { name: 'project.json', mimeType: 'application/json', parents: [project.id], bytes: Buffer.from(JSON.stringify({ version: 2, name, songFile: 'song.flac', settings: { transpose: 0, tracks: {} }, stemHashes: hashes })) })
  return project.id
}
describe('Drive reader collection', () => {
  it('downloads, lists, opens and saves a split project with no source; never writes to Drive or dirties uploads', async () => {
    const { gdriveProjects, gdriveDownload } = await import('../../src/main/gdrive')
    const { registerSource } = await import('../../src/main/source')
    const { listProjects, saveProject } = await import('../../src/main/projects')
    const { isDirty } = await import('../../src/main/sync-dirty')
    const id = seed('Stems only')
    expect((await gdriveProjects()).projects.some(p => p.id === id && !p.songPath)).toBe(true)
    const result = await gdriveDownload(id, () => {})
    expect(result.ok, result.error).toBe(true)
    const source = result.songPath!
    expect(await stat(source).catch(() => null)).toBeNull()
    expect(await registerSource(source)).toMatchObject({ ok: true, project: { sourceMissing: true, hasLyrics: true, inLibrary: false } })
    expect(await registerSource(join(driveProjectsRoot(), id, 'wrong.mp3'))).toMatchObject({ ok: false })
    expect((await listProjects()).projects.some(p => p.songPath === source && p.hasStems)).toBe(true)
    expect(await saveProject(source, 'Stems only', { transpose: 2, tracks: {} })).toMatchObject({ ok: true })
    expect(JSON.parse(await readFile(join(driveProjectsRoot(), id, 'project.json'), 'utf8')).songFile).toBe('song.flac')
    expect(isDirty()).toBe(false)
    const { Transcriber } = await import('../../src/main/lyrics')
    expect(await new Transcriber().resolve(source, 10, false, 'auto', () => {})).toMatchObject({ ok: true, cached: true, source: 'lrclib' })
    expect(mock.hits.every(h => h.startsWith('GET '))).toBe(true)
    expect((await gdriveProjects()).projects.find(p => p.id === id)?.songPath).toBe(source)
  })
  it('rejects inconsistent hashes before publishing any local project', async () => {
    const { gdriveDownload } = await import('../../src/main/gdrive')
    const id = seed('Corrupt', true)
    expect(await gdriveDownload(id, () => {})).toMatchObject({ ok: false })
    expect(await stat(join(driveProjectsRoot(), id)).catch(() => null)).toBeNull()
  })
  it('cancels without publishing and resumes verified files without touching the writer library', async () => {
    const { gdriveDownload, gdriveCancelDownload } = await import('../../src/main/gdrive')
    const id = seed('Cancelled')
    const result = await gdriveDownload(id, msg => { if (msg.includes('stems/')) gdriveCancelDownload() })
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(await stat(join(driveProjectsRoot(), id)).catch(() => null)).toBeNull()
    expect(await gdriveDownload(id, () => {})).toMatchObject({ ok: true })
    expect(mock.hits.every(h => h.startsWith('GET '))).toBe(true)
  })
  it('rejects a file id outside the user’s SingZ folder and path traversal', async () => {
    const { gdriveDownload } = await import('../../src/main/gdrive')
    expect(await gdriveDownload('../outside', () => {})).toMatchObject({ ok: false })
    expect(await gdriveDownload('unrelated-id', () => {})).toMatchObject({ ok: false })
  })
})
