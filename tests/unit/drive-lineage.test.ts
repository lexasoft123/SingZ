import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** One injected disk failure, on the lineage's temp file only. */
const { fail } = vi.hoisted(() => ({ fail: { fsync: false } }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    fsyncSync: ((fd: number) => {
      if (fail.fsync) {
        fail.fsync = false
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
      }
      return real.fsyncSync(fd)
    }) as typeof real.fsyncSync
  }
})

const userData = async (): Promise<string> => (await import('electron')).app.getPath('userData')
const record = async (): Promise<string> => join(await userData(), 'drive-lineage.json')
const temps = async (): Promise<string[]> => (await readdir(await userData())).filter((n) => n.startsWith('drive-lineage.json.'))

describe('the Drive lineage record on disk', () => {
  afterEach(() => { fail.fsync = false })

  it('a failed write refuses the grant, keeps the previous record and leaves no temp file', async () => {
    const { driveLineage } = await import('../../src/main/drive-lineage')
    const root = await mkdtemp(join(tmpdir(), 'singz-lineage-disk-'))
    driveLineage('acct', 'singz', root).grant('folder-1')
    const before = await readFile(await record(), 'utf8')

    const lineage = driveLineage('acct', 'singz', root)
    fail.fsync = true
    expect(() => lineage.grant('folder-2')).toThrow('injected EIO')
    expect(await readFile(await record(), 'utf8')).toBe(before)
    expect(await temps()).toEqual([])
    // and a fresh read still holds exactly what was durable
    const reread = driveLineage('acct', 'singz', root)
    expect(reread.owns('folder-1')).toBe(true)
    expect(reread.owns('folder-2')).toBe(false)
  })

  it('a crash before the rename leaves the previous record authoritative', async () => {
    const { driveLineage } = await import('../../src/main/drive-lineage')
    const root = await mkdtemp(join(tmpdir(), 'singz-lineage-crash-'))
    driveLineage('acct', 'singz', root).grant('folder-1')
    // what a process killed between write and rename leaves behind
    await writeFile(`${await record()}.99999.tmp`, '{"format":2,"bindings":{"torn')
    const reread = driveLineage('acct', 'singz', root)
    expect(reread.owns('folder-1')).toBe(true)
    reread.grant('folder-2')
    expect(driveLineage('acct', 'singz', root).owns('folder-2')).toBe(true)
  })
})
