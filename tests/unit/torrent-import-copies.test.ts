import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'singz-userdata-'))
vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: class {},
  ipcMain: { handle: vi.fn() },
  session: { fromPartition: vi.fn() }
}))
vi.mock('../../src/main/media', () => ({ allowFile: vi.fn() }))
vi.mock('../../src/main/log', () => ({ log: vi.fn() }))

import { shutdownTorrent } from '../../src/main/torrent'

describe('torrent import copies', () => {
  afterEach(() => rmSync(userData, { recursive: true, force: true }))
  it('clears the hand-off copies when the app quits', () => {
    const copies = join(userData, 'torrent-imports', 'a-copy')
    mkdirSync(copies, { recursive: true })
    shutdownTorrent()
    expect(existsSync(join(userData, 'torrent-imports'))).toBe(false)
  })
  it('does not fail when there is nothing to clear', () => {
    expect(() => shutdownTorrent()).not.toThrow()
  })
})
