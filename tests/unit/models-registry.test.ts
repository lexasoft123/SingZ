import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  downloadQwen,
  ModelManager,
  qwenInstalled,
  qwenMissingMb,
  qwenModelMb,
  registryEntryFor,
  removeWhisperIfQwenReady,
  whisperModelOnDisk
} from '../../src/main/models'
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

  /**
   * Qwen3-ASR replaced whisper as the lyrics engine, and its aligner rides in
   * the same tile: the recogniser hears words but tells no time, so a singer
   * holding one without the other could use neither. One id, three parts, on
   * every platform — and no whisper tile anywhere.
   */
  it('offers the lyrics speech model everywhere, as one tile of three parts, and no whisper', () => {
    for (const here of ['win32-x64', 'darwin-arm64', 'darwin-x64']) {
      const entry = registryEntryFor('qwen-asr', here)
      expect(entry?.parts?.map((p) => p.file)).toEqual([
        'Qwen3-ASR-1.7B-Q8_0.gguf',
        'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
        'qwen3-forced-aligner-0.6b-q8_0.gguf'
      ])
      expect(entry?.sizeMb).toBe(qwenModelMb())
      expect(entry?.optional).toBe(true)
      expect(registryEntryFor('whisper' as never, here)).toBeUndefined()
      expect(registryEntryFor('qwen-aligner' as never, here)).toBeUndefined()
    }
  })

  /**
   * Two entries may share an id only when their platforms are disjoint (the
   * torch and ONNX aligners are one tile on different machines). Two that
   * both apply here means the wizard draws two identical tiles under one
   * React key and `downloadModels` fetches the same file twice — which is
   * exactly what a careless insert did to the qwen aligner.
   */
  it('never offers this platform two tiles with the same id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'singz-models-dup-'))
    process.env.SINGZ_MODELS_DIR = dir
    try {
      // status() is what the wizard renders, so it is where a duplicate shows
      const rows = await new ModelManager().status()
      const seen = new Map<string, number>()
      for (const r of rows) seen.set(r.id, (seen.get(r.id) ?? 0) + 1)
      for (const [id, n] of seen) expect(`${id} ×${n}`).toBe(`${id} ×1`)
      expect(rows.some((r) => r.id === 'qwen-asr')).toBe(true)
    } finally {
      delete process.env.SINGZ_MODELS_DIR
      await rm(dir, { recursive: true, force: true })
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
  const DECLARED = 1000
  let served = DECLARED
  const fetched = (): string[] => asked.map((u) => u.split('/').pop() as string)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'singz-models-test-'))
    process.env.SINGZ_MODELS_DIR = dir
    asked = []
    served = DECLARED
    // A server that promises 1000 bytes has to hand over 1000 bytes: the old
    // stub declared them and delivered none, which is precisely the failure
    // downloadFile now refuses, so every test here rode on it.
    vi.spyOn(net, 'fetch').mockImplementation((async (url: string) => {
      asked.push(url)
      let sent = false
      return {
        ok: true,
        headers: { get: (): string => String(DECLARED) },
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: new Uint8Array(served) }
            }
          })
        }
      }
    }) as unknown as typeof net.fetch)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.SINGZ_MODELS_DIR
    await rm(dir, { recursive: true, force: true })
  })

  it('fetches every part of a fresh install', async () => {
    const res = await new ModelManager().downloadModels(() => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(fetched()).toEqual(['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', 'qwen3-forced-aligner-0.6b-q8_0.gguf'])
  })

  it('resumes: a part already on disk is not downloaded again', async () => {
    await writeFile(join(dir, 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'the 2.1 GB part that already arrived')
    const res = await new ModelManager().downloadModels(() => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(fetched()).toEqual(['mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', 'qwen3-forced-aligner-0.6b-q8_0.gguf'])
  })

  it('reinstall refetches everything, because the tile already read installed', async () => {
    await writeFile(join(dir, 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'weights')
    await writeFile(join(dir, 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'), 'encoder')
    await writeFile(join(dir, 'qwen3-forced-aligner-0.6b-q8_0.gguf'), 'aligner')
    const res = await new ModelManager().downloadModels(() => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(fetched()).toEqual(['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf', 'qwen3-forced-aligner-0.6b-q8_0.gguf'])
  })

  /**
   * A connection that drops mid-file ends the stream without an error, and
   * the half file used to be renamed over the model: the tile read
   * "installed", llama-server exited 1 on every run, and nothing said why.
   * Measured against the real thing — a 2.5 GB model whose 356 MB encoder
   * was truncated to 80% ran, failed, and fell back to whisper in silence;
   * with whisper gone there is not even that.
   */
  it('refuses a body that stops early, and leaves no model behind', async () => {
    served = 600
    const res = await new ModelManager().downloadModels(() => {}, ['qwen-asr'])
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toContain('stopped short')
    // neither the model nor the .part it was written through
    expect(await readdir(dir)).toEqual([])
    const rows = await new ModelManager().status()
    expect(rows.find((r) => r.id === 'qwen-asr')?.present).toBe(false)
  })

  it('prices Get at the parts still missing, not the whole model', async () => {
    const rows = async () => (await new ModelManager().status()).find((r) => r.id === 'qwen-asr')
    expect((await rows())?.downloadMb).toBe(qwenModelMb())
    await writeFile(join(dir, 'Qwen3-ASR-1.7B-Q8_0.gguf'), 'weights')
    await writeFile(join(dir, 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'), 'encoder')
    expect((await rows())?.downloadMb).toBe(990)
    expect((await rows())?.sizeMb).toBe(qwenModelMb())
  })

  it('reports one bar that only goes forward across the parts', async () => {
    const seen: number[] = []
    await new ModelManager().downloadModels((p) => seen.push(p.percent), ['qwen-asr'])
    expect(seen[seen.length - 1]).toBe(100)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})

/**
 * Whisper's model is 1.6 GB that no build since Qwen replaced it can use. It
 * goes the moment Qwen is complete on disk — and NOT before: a singer who
 * postponed the new download has lost nothing, and a half-arrived Qwen is
 * not a replacement for anything.
 */
describe('removing the whisper model once Qwen is installed', () => {
  let dir = ''
  const QWEN = [
    'Qwen3-ASR-1.7B-Q8_0.gguf',
    'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
    'qwen3-forced-aligner-0.6b-q8_0.gguf'
  ]

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'singz-whisper-gone-'))
    process.env.SINGZ_MODELS_DIR = dir
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.SINGZ_MODELS_DIR
    await rm(dir, { recursive: true, force: true })
  })

  it('keeps it while any part of Qwen is missing', async () => {
    await writeFile(join(dir, 'ggml-large-v3-turbo.bin'), 'whisper')
    await writeFile(join(dir, QWEN[0]), 'weights')
    await writeFile(join(dir, QWEN[1]), 'encoder')
    expect(await qwenInstalled()).toBe(false)
    expect(await qwenMissingMb()).toBe(990)
    await removeWhisperIfQwenReady()
    expect(await whisperModelOnDisk()).toBe(true)
  })

  it('removes every whisper size and partial once Qwen is complete, and nothing else', async () => {
    for (const f of ['ggml-large-v3-turbo.bin', 'ggml-large-v3.bin', 'ggml-small.bin', 'ggml-medium.bin.part', 'mms-fa.onnx'])
      await writeFile(join(dir, f), 'x')
    for (const f of QWEN) await writeFile(join(dir, f), 'x')
    expect(await qwenInstalled()).toBe(true)
    expect(await qwenMissingMb()).toBe(0)
    await removeWhisperIfQwenReady()
    expect(await whisperModelOnDisk()).toBe(false)
    expect((await readdir(dir)).sort()).toEqual([...QWEN, 'mms-fa.onnx'].sort())
  })

  // One caller runs at startup before the window exists: a whisper file that
  // cannot be deleted (Windows, held open by an older build) must cost a
  // warning, never the launch.
  it.skipIf(process.platform === 'win32')('never throws when a whisper file cannot be removed', async () => {
    await writeFile(join(dir, 'ggml-large-v3-turbo.bin'), 'whisper')
    for (const f of QWEN) await writeFile(join(dir, f), 'x')
    await chmod(dir, 0o555)
    try {
      await expect(removeWhisperIfQwenReady()).resolves.toBeUndefined()
      expect(await whisperModelOnDisk()).toBe(true)
    } finally {
      await chmod(dir, 0o755)
    }
    await removeWhisperIfQwenReady()
    expect(await whisperModelOnDisk()).toBe(false)
  })

  it('happens as soon as the in-lyrics download lands', async () => {
    await writeFile(join(dir, 'ggml-large-v3-turbo.bin'), 'whisper')
    vi.spyOn(net, 'fetch').mockImplementation((async () => {
      let sent = false
      return {
        ok: true,
        headers: { get: (): string => '4' },
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: new Uint8Array(4) }
            }
          })
        }
      }
    }) as unknown as typeof net.fetch)
    await downloadQwen(() => {}, new AbortController().signal)
    expect(await qwenInstalled()).toBe(true)
    expect(await whisperModelOnDisk()).toBe(false)
  })

  it('happens after a model-manager install too', async () => {
    await writeFile(join(dir, 'ggml-large-v3-turbo.bin'), 'whisper')
    for (const f of QWEN.slice(0, 2)) await writeFile(join(dir, f), 'x')
    vi.spyOn(net, 'fetch').mockImplementation((async () => {
      let sent = false
      return {
        ok: true,
        headers: { get: (): string => '4' },
        body: {
          getReader: () => ({
            read: async () => {
              if (sent) return { done: true, value: undefined }
              sent = true
              return { done: false, value: new Uint8Array(4) }
            }
          })
        }
      }
    }) as unknown as typeof net.fetch)
    const res = await new ModelManager().downloadModels(() => {}, ['qwen-asr'])
    expect(res.ok).toBe(true)
    expect(await whisperModelOnDisk()).toBe(false)
  })
})
