import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const writes = vi.hoisted(() => ({
  target: '',
  active: 0,
  maximum: 0
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const delayedWrite = (async (...args: Parameters<typeof actual.writeFile>) => {
    if (String(args[0]) !== writes.target) return (actual.writeFile as any)(...args)
    writes.active++
    writes.maximum = Math.max(writes.maximum, writes.active)
    // Keep the first project.json.part open long enough for an unlocked save
    // from a different source directory to reach the same destination.
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    try {
      return await (actual.writeFile as any)(...args)
    } finally {
      writes.active--
    }
  }) as typeof actual.writeFile
  return { ...actual, writeFile: delayedWrite }
})

import { saveProject } from '../../src/main/projects'
import { writeSettings } from '../../src/main/settings'

describe('loose-song destination serialization', () => {
  it('never shares project.json.part between concurrent same-name saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-destination-lock-'))
    writeSettings({ projectsRoot: root })
    const firstRoot = await mkdtemp(join(tmpdir(), 'singz-loose-first-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'singz-loose-second-'))
    const firstSong = join(firstRoot, 'first.mp3')
    const secondSong = join(secondRoot, 'second.mp3')
    await Promise.all([
      writeFile(firstSong, 'first-audio'),
      writeFile(secondSong, 'second-audio')
    ])

    const destination = join(root, 'Same Name')
    writes.target = join(destination, 'project.json.part')
    writes.active = 0
    writes.maximum = 0

    const [first, second] = await Promise.all([
      saveProject(firstSong, 'Same Name', { transpose: 1, tracks: {} }),
      saveProject(secondSong, 'Same Name', { transpose: 2, tracks: {} })
    ])

    expect(first).toMatchObject({ ok: true, dir: destination })
    expect(second).toMatchObject({ ok: true, dir: destination })
    expect(writes.maximum).toBe(1)
    await expect(readFile(writes.target)).rejects.toThrow()
    expect(JSON.parse(await readFile(join(destination, 'project.json'), 'utf8'))).toMatchObject({
      name: 'Same Name'
    })
  })

  it('does not re-enter the lock when a loose song already sits in its destination directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-destination-self-'))
    writeSettings({ projectsRoot: root })
    const destination = join(root, 'Already There')
    await mkdir(destination)
    const song = join(destination, 'song.mp3')
    await writeFile(song, 'audio')
    writes.target = join(destination, 'project.json.part')
    writes.active = 0
    writes.maximum = 0

    await expect(
      saveProject(song, 'Already There', { transpose: 0, tracks: {} })
    ).resolves.toMatchObject({ ok: true, dir: destination })
    expect(writes.maximum).toBe(1)
  })
})
