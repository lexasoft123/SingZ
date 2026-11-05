jest.mock('../src/project-document', () => ({
  mutateProjectDocument: jest.fn()
}))

import { mutateProjectDocument } from '../src/project-document'
import type { ProjectDoc } from '../src/model'
import { writeProjectWaveform } from '../src/writer'
import {
  MAX_WAVEFORM_LANES,
  WAVEFORM_CACHE_VERSION,
  WAVEFORM_POLICY,
  waveformSeedFor
} from '../src/waveform-cache'

const mutate = mutateProjectDocument as jest.MockedFunction<
  typeof mutateProjectDocument
>
const hashes = {
  old: 'a'.repeat(32),
  current: 'b'.repeat(32),
  drums: 'c'.repeat(32),
  retired: 'd'.repeat(32)
}
const peaks = (value: number) => new Array(96).fill(value)
const current = (md5: string, values = peaks(0.5)) => ({
  version: WAVEFORM_CACHE_VERSION,
  policy: WAVEFORM_POLICY,
  md5,
  peaks: values
})
const project = (): ProjectDoc => ({
  version: 2,
  name: 'Song',
  songFile: 'song.flac',
  savedAt: 'before',
  settings: { transpose: 0, tracks: {} },
  stemHashes: {
    'vocals.flac': { md5: hashes.current, size: 1, mtimeMs: 1 },
    'drums.flac': { md5: hashes.drums, size: 1, mtimeMs: 1 }
  },
  waveforms: {
    vocals: { md5: hashes.old, peaks: peaks(0.2) },
    drums: current(hashes.drums, peaks(0.25)),
    retired: current(hashes.retired),
    corrupt: { md5: hashes.old, peaks: peaks(0.1).fill(Number.NaN, 4, 5) }
  }
})

beforeEach(() => mutate.mockReset())

describe('waveform persistence transaction', () => {
  it('drops an old-song write that waited behind another document transaction', async () => {
    const existing = project()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    mutate.mockImplementation(async (_dir, callback) => {
      await blocked
      return callback(existing)
    })
    let currentSong = true
    const pending = writeProjectWaveform('Song', { vocals: current(hashes.current) },
      ['vocals', 'drums'], () => currentSong)
    currentSong = false
    release()
    await expect(pending).resolves.toBeNull()
    expect(existing.savedAt).toBe('before')
    expect(existing.waveforms?.vocals.md5).toBe(hashes.old)
  })

  it('validates, stamps, prunes, and preserves healthy lanes on a partial write', async () => {
    const existing = project()
    mutate.mockImplementation(async (_dir, callback) => callback(existing))
    const next = await writeProjectWaveform(
      'Song',
      { vocals: current(hashes.current, peaks(0.6)) },
      ['vocals', 'drums']
    )
    expect(next?.waveforms).toEqual({
      vocals: current(hashes.current, peaks(0.6)),
      drums: current(hashes.drums, peaks(0.25))
    })
    // A late write remains bound to its measured bytes. It cannot become a hit
    // after replacement, even if the project mutation itself already landed.
    const late = await writeProjectWaveform(
      'Song',
      { vocals: current(hashes.old) },
      ['vocals', 'drums']
    )
    expect(waveformSeedFor(late!, 'vocals', hashes.current)).toBeUndefined()
  })

  it('does not open a project transaction for wholly corrupt input', async () => {
    const next = await writeProjectWaveform('Song', {
      vocals: current(hashes.current, peaks(0.5).fill(Number.POSITIVE_INFINITY, 8, 9))
    })
    expect(next).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('bounds persisted memory to sixteen RMS96 lanes', async () => {
    const existing = project()
    mutate.mockImplementation(async (_dir, callback) => callback(existing))
    const fresh = Object.fromEntries(
      Array.from({ length: MAX_WAVEFORM_LANES + 4 }, (_, index) => [
        `lane-${index}`, current(hashes.current)
      ])
    )
    const next = await writeProjectWaveform('Song', fresh)
    expect(Object.keys(next!.waveforms!)).toHaveLength(MAX_WAVEFORM_LANES)
  })
})
