import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retainedProjectDescriptor } from '../../src/shared/box-retained-playback'
import { STEMS_6, type DesktopPlaybackPrepareConfig } from '../../src/shared/types'
import { validateBoxRetainedProject } from '../../src/main/box-audio/retained-project'

const config = (): DesktopPlaybackPrepareConfig => ({
  masterGain: 0.8,
  playback: { transport: { playbackRate: 1, transposeSemitones: 0 } }
} as DesktopPlaybackPrepareConfig)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'box-retained-project-'))
  const libraryRoot = join(root, 'library')
  const driveProjectsRoot = join(root, 'drive')
  const dir = join(libraryRoot, 'song')
  await mkdir(join(dir, 'stems'), { recursive: true })
  await mkdir(driveProjectsRoot, { recursive: true })
  const songPath = join(dir, 'source.flac')
  await writeFile(songPath, 'source')
  const stemHashes: Record<string, { size: number; md5: string; mtimeMs: number }> = {}
  for (const id of STEMS_6) {
    await writeFile(join(dir, 'stems', `${id}.flac`), 'x')
    stemHashes[`${id}.flac`] = { size: 1, md5: '0'.repeat(32), mtimeMs: 0 }
  }
  const meta = {
    version: 2, name: 'Song', songFile: 'source.flac', savedAt: 'before', stemHashes,
    settings: { transpose: 0, tempo: 1, masterVolume: 0.8, tracks: {}, custom: [] }
  }
  const save = async (): Promise<void> => { await writeFile(join(dir, 'project.json'), JSON.stringify(meta)) }
  await save()
  await writeFile(join(dir, 'lyrics.json'), '{"lines":[]}')
  await writeFile(join(dir, 'graph.json'), '{"nodes":[]}')
  const lanes = STEMS_6.map(id => ({ id, path: join(dir, 'stems', `${id}.flac`), gain: 0.5, muted: false, solo: false }))
  const request = () => ({ dir, songPath, libraryRoot, driveProjectsRoot, config: config(), lanes })
  return { root, dir, songPath, meta, save, lanes, request }
}

describe.skipIf(process.platform === 'win32')('retained project identity', () => {
  it('keeps identity across settings saves but binds actual lyrics and media stamps', async () => {
    const f = await fixture()
    try {
      const first = await validateBoxRetainedProject(f.request())
      f.meta.savedAt = 'after'
      f.meta.settings = { transpose: 4, tempo: 1.25, masterVolume: 0.2,
        tracks: { vocals: { volume: 0.1, muted: true, solo: false } }, custom: [] }
      await f.save()
      const lanes = f.lanes.map(lane => ({ ...lane, gain: 0.1, muted: lane.id === 'vocals' }))
      const second = await validateBoxRetainedProject({ ...f.request(), lanes, expected: first })
      expect(second.project.metadataHash).toBe(first.project.metadataHash)
      expect(second.project.lyricsHash).toBe(first.project.lyricsHash)
      expect(second.project.graphHash).toBe(first.project.graphHash)
      expect(second.lanes[0].gain).toBe(0.1)

      await writeFile(join(f.dir, 'lyrics.json'), '{"lines":[{"text":"changed"}]}')
      await expect(validateBoxRetainedProject({ ...f.request(), expected: first })).rejects.toThrow('changed on disk')
      await writeFile(join(f.dir, 'lyrics.json'), '{"lines":[]}')
      await utimes(f.lanes[0].path, new Date(), new Date('2030-01-01T00:00:00Z'))
      const restamped = await validateBoxRetainedProject(f.request())
      expect(restamped.project.metadataHash).toBe(first.project.metadataHash)
      await expect(validateBoxRetainedProject({ ...f.request(), expected: first })).rejects.toThrow('changed on disk')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects deleted, corrupt, escaped and mismatched project inputs', async () => {
    const f = await fixture()
    try {
      const wrongId = f.lanes.map((lane, index) => index === 0 ? { ...lane, id: 'wrong' } : lane)
      await expect(validateBoxRetainedProject({ ...f.request(), lanes: wrongId })).rejects.toThrow('lanes')
      const wrongPath = f.lanes.map((lane, index) => index === 0 ? { ...lane, path: f.songPath } : lane)
      await expect(validateBoxRetainedProject({ ...f.request(), lanes: wrongPath })).rejects.toThrow('lanes')
      await expect(validateBoxRetainedProject({ ...f.request(), dir: f.root })).rejects.toThrow('outside')
      await rm(join(f.dir, 'project.json'))
      await expect(validateBoxRetainedProject(f.request())).rejects.toThrow()
      await writeFile(join(f.dir, 'project.json'), '{bad')
      await expect(validateBoxRetainedProject(f.request())).rejects.toThrow('corrupt')
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('rejects a symlinked lane escape and allows a stems-only project with no original source', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside.flac')
    try {
      await writeFile(outside, 'x')
      await rm(f.lanes[0].path)
      await symlink(outside, f.lanes[0].path)
      await expect(validateBoxRetainedProject(f.request())).rejects.toThrow('escape')
      await rm(f.lanes[0].path)
      await writeFile(f.lanes[0].path, 'x')
      await rm(f.songPath)
      const descriptor = await validateBoxRetainedProject(f.request())
      expect(descriptor.project.songPath).toBe(join(descriptor.project.dir, 'source.flac'))
    } finally { await rm(f.root, { recursive: true, force: true }) }
  })

  it('validates shared descriptors when Buffer is undefined', async () => {
    const f = await fixture()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')
    try {
      const first = await validateBoxRetainedProject(f.request())
      const before = await readFile(f.lanes[0].path)
      Object.defineProperty(globalThis, 'Buffer', { value: undefined, configurable: true, writable: true })
      expect(retainedProjectDescriptor(first)).toEqual(first)
      expect(await readFile(f.lanes[0].path)).toEqual(before)
    } finally {
      if (original) Object.defineProperty(globalThis, 'Buffer', original)
      await rm(f.root, { recursive: true, force: true })
    }
  })
})
