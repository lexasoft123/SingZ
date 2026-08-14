/**
 * The other direction of the contract: the REAL phone writer materializes a
 * phone-added song as a project folder, and the REAL desktop reader accepts
 * it. Nothing hand-built — the folder is whatever mobile/src/writer.ts
 * actually produced over the reference native, and the desktop side is
 * detectProject itself, so a drift on either side fails here rather than
 * after an adoption on a real machine (Phase 6 grows this into the full
 * publish → adopt loop).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeNativeWriter, type FakeNativeWriter } from '../shared/fake-native-cache'
import lrcFixture from '../shared/lrc-fixture.json'

let docs: string
let imports: string
let native: FakeNativeWriter

beforeEach(() => {
  docs = mkdtempSync(join(tmpdir(), 'singz-phone-docs-'))
  imports = mkdtempSync(join(tmpdir(), 'singz-imports-'))
  native = fakeNativeWriter(docs)
  vi.resetModules()
})

afterEach(() => {
  rmSync(docs, { recursive: true, force: true })
  rmSync(imports, { recursive: true, force: true })
})

/** The phone writer over the reference native. resetModules gives every test
 *  a fresh react-native stub, so the fake is injected into THAT instance —
 *  assigning from a top-level import would write into the stale one. */
async function phoneWriter(): Promise<typeof import('../../mobile/src/writer')> {
  const rn = await import('../shared/react-native-stub')
  ;(rn.NativeModules as Record<string, unknown>).FolderAccess = native
  return import('../../mobile/src/writer')
}

/** A phone add, exactly as the app would run it. */
async function phoneAdd(fileName = 'Sixteen Tons.mp3'): Promise<{
  dir: string
  doc: import('../../mobile/src/model').ProjectDoc
}> {
  const writer = await phoneWriter()
  const src = join(imports, fileName)
  writeFileSync(src, Buffer.from('ID3fake-mp3-bytes-for-the-writer-test'))
  return writer.createProject({
    srcPath: src,
    fileName,
    name: 'Sixteen Tons',
    durationSec: lrcFixture.duration,
    lyrics: { lines: lrcFixture.lines, credit: 'Merle Travis — Sixteen Tons' }
  })
}

describe('phone-created project → desktop reader', () => {
  it('detectProject accepts the folder the phone wrote', async () => {
    const { dir, doc } = await phoneAdd()
    expect(dir).toBe('Sixteen Tons')

    const { detectProject } = await import('../../src/main/projects')
    const info = await detectProject(join(docs, dir, doc.songFile))
    expect(info).not.toBeNull()
    expect(info!.formatVersion).toBe(1)
    expect(info!.hasLyrics).toBe(true)
    // the pre-split lane came through resolveCustom with an absolute path
    expect(info!.settings.custom).toHaveLength(1)
    expect(info!.settings.custom![0].id).toBe('custom-original')
    expect(existsSync(info!.settings.custom![0].file)).toBe(true)
  })

  it('the doc names every file it is made of, with true hashes', async () => {
    const { dir, doc } = await phoneAdd()
    // song kept for the desktop contract + the lane both exist
    expect(existsSync(join(docs, dir, doc.songFile))).toBe(true)
    for (const [name, h] of Object.entries(doc.stemHashes!)) {
      const bytes = readFileSync(join(docs, dir, 'stems', name))
      expect(bytes.length).toBe(h.size)
    }
    expect(doc.lyricsHash!.size).toBe(
      readFileSync(join(docs, dir, 'lyrics.json')).length
    )
    // the phone's own trust boundary accepts the lane it just wrote
    const { customTracks } = await import('../../mobile/src/model')
    expect(customTracks(doc.settings).map((t) => t.id)).toEqual(['custom-original'])
  })

  it('a colliding name gets its own folder, never a merge', async () => {
    const first = await phoneAdd()
    const second = await phoneAdd()
    expect(first.dir).toBe('Sixteen Tons')
    expect(second.dir).toBe('Sixteen Tons 2')
    expect(existsSync(join(docs, 'Sixteen Tons', 'project.json'))).toBe(true)
    expect(existsSync(join(docs, 'Sixteen Tons 2', 'project.json'))).toBe(true)
  })

  it('writeLyrics refreshes lyrics.json and its hash from the doc on disk', async () => {
    const { dir } = await phoneAdd()
    const writer = await phoneWriter()
    const before = readFileSync(join(docs, dir, 'project.json'), 'utf8')
    const next = await writer.writeLyrics(dir, before, {
      lines: lrcFixture.lines.slice(0, 2),
      credit: 'retry'
    })
    const onDisk = JSON.parse(readFileSync(join(docs, dir, 'lyrics.json'), 'utf8'))
    expect(onDisk.lines).toHaveLength(2)
    expect(next.lyricsHash!.size).toBe(readFileSync(join(docs, dir, 'lyrics.json')).length)
  })
})
