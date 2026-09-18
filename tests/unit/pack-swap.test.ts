import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { restoreInterruptedPackSwap, swapInVerifiedPack } from '../../src/main/models'

async function installed(root: string, marker = 'working'): Promise<string> {
  const dir = join(root, 'gpu-splitter')
  await mkdir(join(dir, 'python'), { recursive: true })
  await writeFile(join(dir, 'python', 'pack.json'), marker)
  return dir
}

const contents = async (dir: string): Promise<string> =>
  readFile(join(dir, 'python', 'pack.json'), 'utf8')

/**
 * A pack replace used to delete the working pack before checking what
 * replaced it, so a truncated download or a pack this build judges too old
 * left the machine with no splitter and nothing to fall back to. Bumping
 * PACK_FORMAT_REQUIRED makes every existing install take that path at once,
 * and this repo has already published a tag whose pack assets were missing —
 * which answers a mandatory re-download with the very pack that fails.
 */
describe('swapInVerifiedPack', () => {
  it('replaces the pack when the incoming one verifies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await swapInVerifiedPack(
      dir,
      async (staging) => {
        await mkdir(join(staging, 'python'), { recursive: true })
        await writeFile(join(staging, 'python', 'pack.json'), 'fresh')
      },
      async () => true
    )
    expect(await contents(dir)).toBe('fresh')
    // no staging debris beside it
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })

  it('KEEPS the working pack when the incoming one fails verification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await expect(swapInVerifiedPack(
      dir,
      async (staging) => {
        await mkdir(join(staging, 'python'), { recursive: true })
        await writeFile(join(staging, 'python', 'pack.json'), 'too old')
      },
      async () => false
    )).rejects.toThrow(/not one this version can use.*left alone/)
    expect(await contents(dir)).toBe('working')
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })

  it('KEEPS the working pack when the download itself throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await expect(swapInVerifiedPack(
      dir,
      async () => { throw new Error('connection reset') },
      async () => true
    )).rejects.toThrow('connection reset')
    expect(await contents(dir)).toBe('working')
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })

  it('verifies the incoming copy, never the installed one', async () => {
    // The old code checked packDir() after overwriting it, so "is it good?"
    // was asked of the replacement only by accident of timing. Verification
    // must be handed the staging path.
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    const judged: string[] = []
    await swapInVerifiedPack(
      dir,
      async (staging) => { await mkdir(join(staging, 'python'), { recursive: true }); await writeFile(join(staging, 'python', 'pack.json'), 'fresh') },
      async (staging) => { judged.push(staging); return true }
    )
    expect(judged).toEqual([`${dir}.incoming`])
    await rm(root, { recursive: true, force: true })
  })

  it('installs cleanly when there is no pack yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = join(root, 'gpu-splitter')
    await swapInVerifiedPack(
      dir,
      async (staging) => { await mkdir(join(staging, 'python'), { recursive: true }); await writeFile(join(staging, 'python', 'pack.json'), 'first') },
      async () => true
    )
    expect(await contents(dir)).toBe('first')
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })

  it('leaves no staging directory behind after a failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await expect(swapInVerifiedPack(dir, async () => {}, async () => false)).rejects.toThrow()
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })
})

describe('restoreInterruptedPackSwap', () => {
  it('puts back the only good pack when a kill landed between the two renames', async () => {
    // dir gone, previous holding the working copy: without this the app reads
    // "not installed", and the next download's leading rm(previous) deletes
    // the one pack on the machine.
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await rename(dir, `${dir}.previous`)
    await restoreInterruptedPackSwap(dir)
    expect(await contents(dir)).toBe('working')
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })

  it('leaves a staging directory alone — it may be another instance mid-unpack', async () => {
    // packDir() is shared by every userData identity on the machine, so a
    // launching app must not rm -rf a download another one is unpacking.
    // swapInVerifiedPack clears .incoming before its own fill, which reclaims
    // a genuinely stale one without racing anybody.
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await mkdir(join(`${dir}.incoming`, 'python'), { recursive: true })
    await restoreInterruptedPackSwap(dir)
    expect(await contents(dir)).toBe('working')
    expect((await readdir(root)).sort()).toEqual(['gpu-splitter', 'gpu-splitter.incoming'])
    await rm(root, { recursive: true, force: true })
  })

  it('never lets a failure to settle cost the window', async () => {
    // It runs before createWindow, so a throw here is an app that never
    // opens — firing exactly after a crash during an update.
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = join(root, 'gpu-splitter')
    // previous is a FILE, so the rename into place cannot succeed
    await writeFile(`${dir}.previous`, 'not a directory')
    await expect(restoreInterruptedPackSwap(dir)).resolves.toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it('prefers the installed pack when both it and a superseded copy exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root, 'current')
    await mkdir(join(`${dir}.previous`, 'python'), { recursive: true })
    await writeFile(join(`${dir}.previous`, 'python', 'pack.json'), 'stale')
    await restoreInterruptedPackSwap(dir)
    expect(await contents(dir)).toBe('current')
    expect(await readdir(root)).toEqual(['gpu-splitter'])
    await rm(root, { recursive: true, force: true })
  })

  it('does nothing when there is nothing to settle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    const dir = await installed(root)
    await restoreInterruptedPackSwap(dir)
    expect(await contents(dir)).toBe('working')
    await rm(root, { recursive: true, force: true })
  })
})

/**
 * The swap is only worth anything if the download actually goes through it,
 * and if verification is aimed at the incoming copy. Neither is reachable
 * from a unit test — downloadModels needs the network and packComplete is
 * module-local — so they are pinned at the source, which is also where a
 * revert would show up.
 */
describe('the real install routes through the swap', () => {
  it('has no delete-before-verify left in the archive path', async () => {
    const source = await readFile(new URL('../../src/main/models.ts', import.meta.url), 'utf8')
    expect(source).toContain('await swapInVerifiedPack(')
    // the shape that cost a working pack: packDir() removed, then filled,
    // then judged.
    expect(source).not.toContain('await rm(packDir(), { recursive: true, force: true })')
    expect(source).not.toContain('await untar(archive, packDir())')
  })

  it('judges the incoming pack, not the installed one', async () => {
    const source = await readFile(new URL('../../src/main/models.ts', import.meta.url), 'utf8')
    // every probe packComplete makes has to take the root it was handed
    for (const probe of ['packPython(root)', 'packFormatVersion(root)', 'packVocalModel(root)', 'packOnnxModel(root)']) {
      expect(source, probe).toContain(probe)
    }
    expect(source).toContain('async function packComplete(root = packDir())')
  })

  it('settles an interrupted swap before anything asks what is installed', async () => {
    const main = await readFile(new URL('../../src/main/index.ts', import.meta.url), 'utf8')
    const recover = main.indexOf('restoreInterruptedPackSwap()')
    const cleanup = main.indexOf('cleanupObsoleteModels()')
    expect(recover).toBeGreaterThan(-1)
    expect(recover).toBeLessThan(cleanup)
  })
})
