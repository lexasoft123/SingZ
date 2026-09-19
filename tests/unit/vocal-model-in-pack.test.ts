import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { registryEntryFor } from '../../src/main/models'
import { VOCAL_MODEL_FILE, VOCAL_MODEL_SHA256 } from '../../src/main/vocal-model'

const read = (name: string): Promise<string> =>
  readFile(new URL(`../../${name}`, import.meta.url), 'utf8')

/**
 * Backing vocals are part of every split, so the UVR model ships inside the
 * splitter pack instead of being a second optional download. Three files have
 * to agree about that and none of them can see the others: the two pack
 * builders stage the model and stamp a format, and models.ts refuses anything
 * older. Bumping one and forgetting another is the exact drift that leaves
 * either a pack nobody accepts or an accepted pack that cannot separate.
 */
describe('the vocal model ships in the pack', () => {
  it('is no longer a downloadable model on any platform', async () => {
    for (const here of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
      expect(registryEntryFor('backing-vocals' as never, here)).toBeUndefined()
    }
    // …and nothing in the registry quietly points at it by file name either.
    expect(await read('src/main/models.ts')).not.toContain('VOCAL_MODEL_URL')
  })

  it('stages the model under the same sha both builders and the runner assert', async () => {
    for (const script of ['scripts/build-gpu-pack.sh', 'scripts/build-onnx-pack.sh']) {
      const source = await read(script)
      expect(source, script).toContain(`UVR_MODEL_SHA256="${VOCAL_MODEL_SHA256}"`)
      expect(source, script).toContain('mkdir -p "$WORK/python/models/uvr"')
      expect(source, script).toContain('cp "$UVR_MODEL" "$WORK/python/models/uvr/$UVR_MODEL_FILE"')
      // The licence travels with the weights, not with the app.
      expect(source, script).toContain('UVR-MDX-Karaoke-2.txt" "$WORK/python/models/uvr/LICENSE.txt"')
      // A staged model nobody ran is how a broken pack ships.
      expect(source, script).toContain('vocal_split_runner.py')
    }
    expect(await read('scripts/vocal_split_runner.py')).toContain(`MODEL_SHA256 = '${VOCAL_MODEL_SHA256}'`)
    expect(VOCAL_MODEL_FILE).toBe('UVR_MDXNET_KARA_2.onnx')
  })

  it('stamps exactly the pack format the app requires, per platform', async () => {
    const required = (await read('src/main/models.ts'))
      .match(/const PACK_FORMAT_REQUIRED = process\.platform === 'win32' \? (\d+) : (\d+)/)
    expect(required, 'PACK_FORMAT_REQUIRED shape changed').not.toBeNull()
    const [, onnx, torch] = required as RegExpMatchArray

    const gpu = (await read('scripts/build-gpu-pack.sh')).match(/"formatVersion": (\d+)/)
    expect(gpu?.[1], 'build-gpu-pack.sh stamp vs PACK_FORMAT_REQUIRED').toBe(torch)
    const onnxPack = (await read('scripts/build-onnx-pack.sh')).match(/"formatVersion": (\d+)/)
    expect(onnxPack?.[1], 'build-onnx-pack.sh stamp vs PACK_FORMAT_REQUIRED').toBe(onnx)
  })

  it('gives the Apple Silicon pack an onnxruntime to run the model with', async () => {
    // The torch pack carried no ORT at all: without this pin the model would
    // be staged into a pack whose Python cannot import onnxruntime.
    const source = await read('scripts/build-gpu-pack.sh')
    expect(source).toContain('ORT_PIN="onnxruntime==1.28.0"')
    expect(source).toContain('"$NUMPY_PIN" "$ORT_PIN"')
    expect(source).toContain('import demucs, torch, onnxruntime')
  })
})
