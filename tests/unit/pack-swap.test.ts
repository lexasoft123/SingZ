import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isOnnxPack, PACK_FORMAT_REQUIRED, packComplete, restoreInterruptedPackSwap, swapInVerifiedPack
} from '../../src/main/models'

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
  it('puts back the pack that was installed when a kill landed between the two renames', async () => {
    // dir gone, previous holding what was installed: without this the machine
    // is left with less than it had before the update began, and nothing would
    // ever put it back. (This fixture's pack is marked 'working' only so the
    // assertion can tell it apart — the restore makes no such claim.)
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
 * The swap is only worth anything if the download actually goes through it.
 * THAT is not reachable from a unit test — downloadModels needs the network —
 * so it is pinned at the source, which is where a revert would show up. The
 * other half, that verification is aimed at the incoming copy, is asserted
 * for real against the exported packComplete by `judges the root it is
 * handed` in this block — named, not counted, since a count goes stale.
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

  it('judges the root it is handed — behaviourally, not by matching source', async () => {
    // The textual pins below can drift under a reformat. This one cannot:
    // two staging roots, one complete and one too old, judged by the real
    // function.
    //
    // The ACCEPTANCE assertion is the one with teeth. Unthread `root` and
    // packComplete falls back to packDir(), which does not exist under the
    // unit stub — so the refusal passes for the wrong reason while the
    // acceptance goes red. Both are asserted on every platform, which is why
    // the ONNX fixture below bothers to exist.
    const root = await mkdtemp(join(tmpdir(), 'singz-pack-'))
    // Opened BEFORE the fixture, not just around the assertions: `good` writes
    // the 101 MB file and `old` is built after it, so a throw in between would
    // otherwise leak it on a filesystem that has no holes.
    try {
      const good = join(root, 'good')
      const old = join(root, 'old')
      const required = PACK_FORMAT_REQUIRED
      for (const [dir, version] of [[good, required], [old, required - 1]] as const) {
        const py = process.platform === 'win32'
          ? join(dir, 'python', 'python.exe')
          : join(dir, 'python', 'bin', 'python3')
        await mkdir(dirname(py), { recursive: true })
        await writeFile(py, '#!/bin/sh\n')
        await writeFile(join(dir, 'python', 'pack.json'), JSON.stringify({ formatVersion: version }))
        await mkdir(join(dir, 'python', 'models', 'uvr'), { recursive: true })
        await writeFile(join(dir, 'python', 'models', 'uvr', 'UVR_MDXNET_KARA_2.onnx'), 'x')
        // Those packs also resolve a splitter model out of a hub-style cache,
        // and the resolver's only size test is `> 100e6`, so a 101 MB file with
        // no contents satisfies it — which is what lets the acceptance be
        // asserted on the platforms where the refusal proves nothing.
        //
        // Only for `good`: `old` is refused at the version check and never
        // reaches that resolver, so a second one would be written and never
        // read. That matters because the file is free only where the
        // filesystem has holes — APFS and ext4 make none of it real, but NTFS
        // reserves the clusters, so this is ~101 MB of transient disk on the
        // Windows leg and doubling it buys nothing.
        if (isOnnxPack() && dir === good) {
          const snap = join(dir, 'python', 'model-cache',
            'models--StemSplitio--htdemucs-6s-onnx', 'snapshots', 'rev0')
          await mkdir(snap, { recursive: true })
          const handle = await open(join(snap, 'htdemucs_6s_fp16weights.onnx'), 'w')
          try { await handle.truncate(101e6) } finally { await handle.close() }
        }
      }
      expect(await packComplete(old), 'a pack older than this build must be refused').toBe(false)
      expect(await packComplete(good), 'a complete pack at a staging root must be accepted').toBe(true)
    } finally {
      // The other fixtures in this file are kilobytes and can rely on temp
      // being swept; this one cannot.
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hands verification the staging path', async () => {
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
