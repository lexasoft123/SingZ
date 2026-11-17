import { mkdtempSync, mkdirSync, existsSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
  session: { fromPartition: vi.fn() }
}))
vi.mock('../../src/main/media', () => ({ allowFile: vi.fn() }))
vi.mock('../../src/main/log', () => ({ log: vi.fn() }))

import { pruneImportCopies } from '../../src/main/torrent'

describe('torrent import copies', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  it('removes copies older than a day and keeps fresh ones', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-imports-'))
    roots.push(root)
    const stale = join(root, 'stale'), fresh = join(root, 'fresh')
    mkdirSync(stale)
    mkdirSync(fresh)
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    utimesSync(stale, old, old)
    await pruneImportCopies(root)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })
  it('ignores a missing imports folder', async () => {
    await expect(pruneImportCopies(join(tmpdir(), 'singz-no-such-imports'))).resolves.toBeUndefined()
  })
})
