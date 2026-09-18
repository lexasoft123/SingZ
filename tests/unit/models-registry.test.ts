import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelManager, registryEntryFor } from '../../src/main/models'
import { net } from './electron-stub'

// Registry ids repeat across platform flavors; resolving over the raw list
// handed Windows the Apple-Silicon torch aligner (1.26 GB, unusable, and the
// tile stayed "not installed"). Installs must resolve per-platform.
describe('registryEntryFor', () => {
  it('gives Windows and Intel Macs the ONNX aligner', () => {
    expect(registryEntryFor('aligner', 'win32-x64')?.url).toContain('mms-fa.onnx')
    expect(registryEntryFor('aligner', 'darwin-x64')?.url).toContain('mms-fa.onnx')
  })

  it('gives Apple Silicon the torch aligner', () => {
    expect(registryEntryFor('aligner', 'darwin-arm64')?.url).toContain(
      'dl.fbaipublicfiles.com'
    )
    expect(registryEntryFor('aligner', 'darwin-arm64')?.file).toContain('model.pt')
  })

  it('resolves the splitter pack everywhere it exists', () => {
    for (const here of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
      expect(registryEntryFor('gpu-splitter', here)?.id).toBe('gpu-splitter')
    }
  })

  it('whisper is platform-neutral', () => {
    expect(registryEntryFor('whisper', 'win32-x64')?.file).toBe('ggml-large-v3-turbo.bin')
  })

  /**
   * Two entries may share an id only when their platforms are disjoint (the
   * torch and ONNX aligners are one tile on different machines). Two that
   * both apply here means the wizard draws two identical tiles under one
   * React key and `downloadModels` fetches the same file twice — which is
   * exactly what a careless insert did to the qwen aligner.
   */
  it('never offers this platform two tiles with the same id', async () => {
    const before = process.env.SINGZ_ASR
    const dir = await mkdtemp(join(tmpdir(), 'singz-models-dup-'))
    process.env.SINGZ_MODELS_DIR = dir
    process.env.SINGZ_ASR = 'qwen'
    try {
      // status() is what the wizard renders, so it is where a duplicate shows
      const rows = await new ModelManager().status(true)
      const seen = new Map<string, number>()
      for (const r of rows) seen.set(r.id, (seen.get(r.id) ?? 0) + 1)
      for (const [id, n] of seen) expect(`${id} ×${n}`).toBe(`${id} ×1`)
      expect(rows.some((r) => r.id === 'qwen-aligner')).toBe(true)
    } finally {
      delete process.env.SINGZ_MODELS_DIR
      if (before === undefined) delete process.env.SINGZ_ASR
      else process.env.SINGZ_ASR = before
      await rm(dir, { recursive: true, force: true })
    }
  })

  /**
   * The sung-lyrics model is 2.5 GB whose engine no shipped build can run yet
   * (llama-server is not packaged, and only SINGZ_ASR=qwen selects it). Offered
   * anyway it would sit beside the near-identically named whisper tile and
   * take a singer's download for nothing — so the gate is the whole safety of
   * shipping this half-finished, and it is one line.
   */
  it('offers the sung-lyrics model only where its engine can be selected', () => {
    const before = process.env.SINGZ_ASR
    try {
      delete process.env.SINGZ_ASR
      for (const here of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
        expect(registryEntryFor('qwen-asr', here)).toBeUndefined()
      }
      process.env.SINGZ_ASR = 'qwen'
      expect(registryEntryFor('qwen-asr', 'darwin-arm64')?.parts).toHaveLength(2)
      // and the other tiles are unaffected either way
      expect(registryEntryFor('whisper', 'darwin-arm64')?.id).toBe('whisper')
    } finally {
      if (before === undefined) delete process.env.SINGZ_ASR
      else process.env.SINGZ_ASR = before
    }
  })
})

/**
 * A model that is more than one file must resume. The first version of this
 * keyed "is this a reinstall?" off the `ids` argument, which the wizard sends
 * on every path — so the guard never ran and a 2.1 GB part was re-fetched
 * after every failure on the 356 MB one.
 */
describe('multi-part model installs', () => {
  let dir = ''
  let asked: string[] = []
  const fetched = (): string[] => asked.map((u) => u.split('/').pop() as string)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'singz-models-test-'))
    process.env.SINGZ_MODELS_DIR = dir
    process.env.SINGZ_ASR = 'qwen'
    asked = []
    vi.spyOn(net, 'fetch').mockImplementation((async (url: string) => {
      asked.push(url)
      return {
        ok: true,
        headers: { get: (): string => '1000' },
        body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) }
      }
    }) as unknown as typeof net.fetch)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.SINGZ_MODELS_DIR
    delete process.env.SINGZ_ASR
    await rm(dir, { recursive: true, force: true })
  })

  it('fetches every part of a fresh install', async () => {
    const res = await new ModelManager().downloadModels(true, () => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(fetched()).toEqual(['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'])
  })

  it('resumes: a part already on disk is not downloaded again', async () => {
    await writeFile(join(dir, 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'the 2.1 GB part that already arrived')
    const res = await new ModelManager().downloadModels(true, () => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(fetched()).toEqual(['mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'])
  })

  it('reinstall refetches everything, because the tile already read installed', async () => {
    await writeFile(join(dir, 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'weights')
    await writeFile(join(dir, 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'), 'encoder')
    const res = await new ModelManager().downloadModels(true, () => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(fetched()).toEqual(['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'])
  })

  it('reports one bar that only goes forward across the parts', async () => {
    const seen: number[] = []
    await new ModelManager().downloadModels(true, (p) => seen.push(p.percent), ['qwen-asr'])
    expect(seen[seen.length - 1]).toBe(100)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})
