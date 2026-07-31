import { describe, expect, it } from 'vitest'
import { registryEntryFor } from '../../src/main/models'

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
})
