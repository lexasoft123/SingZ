/**
 * The project's waveform cache: what may be drawn from it, and what must not.
 *
 * The point of the cache is that a streamed song draws its seek bar without
 * anyone paying to read every sample again. The point of the HASH is that it
 * stops doing so the moment the stems change — a bar drawn from the wrong
 * audio is worse than no bar, because nothing about it looks wrong.
 */
import type { ProjectDoc } from '../src/model'
import { cachedWaveform, laneHashes, waveformCacheFor } from '../src/ui/PlayerScreen'

const doc = (over: Partial<ProjectDoc> = {}): ProjectDoc =>
  ({
    version: 1,
    name: 'song',
    songFile: 'song.flac',
    savedAt: '',
    settings: {},
    stemHashes: {
      'vocals.flac': { md5: 'aaa', size: 1, mtimeMs: 1 },
      'drums.flac': { md5: 'bbb', size: 1, mtimeMs: 1 },
    },
    ...over,
  }) as ProjectDoc

const peaks = (value: number): number[] => new Array(96).fill(value)

describe('the project waveform cache', () => {
  it('maps stem files to lane ids, which is how the two halves meet', () => {
    expect(laneHashes(doc())).toEqual({ vocals: 'aaa', drums: 'bbb' })
  })

  it('draws from the cache when every lane matches the stems on disk', () => {
    const cached = cachedWaveform(
      doc({
        waveforms: {
          vocals: { md5: 'aaa', peaks: peaks(0.5) },
          drums: { md5: 'bbb', peaks: peaks(0.25) },
        },
      }),
      laneHashes(doc())
    )
    expect(cached).not.toBeNull()
    expect(cached?.bucketCount).toBe(96)
    expect(cached?.lanes.map(l => l.id).sort()).toEqual(['drums', 'vocals'])
    expect(cached?.lanes.every(l => l.peaksValid)).toBe(true)
  })

  it('refuses the WHOLE cache when one lane was measured from other bytes', () => {
    // Half a bar from the previous split is the failure this exists to stop:
    // it draws, it looks fine, and it is wrong.
    const cached = cachedWaveform(
      doc({
        waveforms: {
          vocals: { md5: 'aaa', peaks: peaks(0.5) },
          drums: { md5: 'STALE', peaks: peaks(0.25) },
        },
      }),
      laneHashes(doc())
    )
    expect(cached).toBeNull()
  })

  it('refuses a cache that is missing a lane entirely', () => {
    expect(
      cachedWaveform(doc({ waveforms: { vocals: { md5: 'aaa', peaks: peaks(0.5) } } }), laneHashes(doc()))
    ).toBeNull()
  })

  it('stores only lanes whose bytes can be named, so every entry can go stale', () => {
    const kept = waveformCacheFor(
      {
        bucketCount: 96,
        lanes: [
          { id: 'vocals', peaksValid: true, peaks: peaks(0.5) },
          // No stemHashes entry: nothing could ever invalidate it.
          { id: 'guitar', peaksValid: true, peaks: peaks(0.5) },
          // Measured but not usable.
          { id: 'drums', peaksValid: false, peaks: peaks(0) },
        ],
      },
      laneHashes(doc())
    )
    expect(Object.keys(kept)).toEqual(['vocals'])
    expect(kept.vocals.md5).toBe('aaa')
  })

  it('has nothing to say about a project with no recorded stem hashes', () => {
    expect(cachedWaveform(doc({ stemHashes: undefined }), {})).toBeNull()
  })
})
