import type { ProjectDoc } from '../src/model'
import {
  MAX_WAVEFORM_LANES,
  WAVEFORM_CACHE_VERSION,
  WAVEFORM_POLICY,
  cachedWaveform,
  laneHashes,
  parsePersistedWaveform,
  waveformCacheFor,
  waveformSeedFor
} from '../src/waveform-cache'

const MD5 = {
  vocals: 'a'.repeat(32),
  drums: 'b'.repeat(32),
  custom: 'c'.repeat(32),
  other: 'd'.repeat(32)
}
const peaks = (value: number): number[] => new Array(96).fill(value)
const stamped = (md5: string, values = peaks(0.5)) => ({
  version: WAVEFORM_CACHE_VERSION,
  policy: WAVEFORM_POLICY,
  md5,
  peaks: values
})

const doc = (over: Partial<ProjectDoc> = {}): ProjectDoc =>
  ({
    version: 2,
    name: 'song',
    songFile: 'song.flac',
    savedAt: '',
    settings: { transpose: 0, tracks: {} },
    stemHashes: {
      'vocals.flac': { md5: MD5.vocals, size: 1, mtimeMs: 1 },
      'drums.flac': { md5: MD5.drums, size: 1, mtimeMs: 1 },
      'custom-take-7.mp3': { md5: MD5.custom, size: 1, mtimeMs: 1 }
    },
    ...over
  }) as ProjectDoc

const withCustom = (over: Partial<ProjectDoc> = {}): ProjectDoc => doc({
  settings: {
    transpose: 0,
    tracks: {},
    custom: [{
      id: 'custom-studio-id',
      label: 'Studio double',
      color: '#fff',
      file: 'stems/custom-take-7.mp3'
    }]
  },
  ...over
})

describe('the versioned project waveform cache', () => {
  it('maps custom lane IDs through their actual settings.custom file', () => {
    // Negative control: stripping "custom-take-7.mp3" would produce a lane the
    // mixer does not own and leave custom-studio-id without its valid seed.
    expect(laneHashes(withCustom())).toEqual({
      vocals: MD5.vocals,
      drums: MD5.drums,
      'custom-studio-id': MD5.custom
    })
  })

  it('uses measured content identity instead of a stale document MD5', () => {
    const wanted = laneHashes(doc(), { vocals: MD5.other })
    expect(wanted.vocals).toBe(MD5.other)
    expect(cachedWaveform(doc({
      waveforms: { vocals: stamped(MD5.other) }
    }), wanted)?.lanes.map(lane => lane.id)).toEqual(['vocals'])
  })

  it('accepts desktop legacy RMS96 only after normalization and validation', () => {
    expect(parsePersistedWaveform({ md5: MD5.vocals, peaks: peaks(0.25) })).toEqual(
      stamped(MD5.vocals, peaks(0.25))
    )
    expect(cachedWaveform(doc({
      waveforms: {
        vocals: { md5: MD5.vocals, peaks: peaks(0.5) },
        drums: { md5: MD5.drums, peaks: peaks(0.25) }
      }
    }), laneHashes(doc()))?.lanes).toHaveLength(2)
  })

  it('keeps healthy lanes when another is stale or missing', () => {
    // Negative control: the former all-or-nothing reader returns null here and
    // forces the valid vocals lane through another whole-file scan as well.
    const cached = cachedWaveform(doc({
      waveforms: {
        vocals: stamped(MD5.vocals),
        drums: stamped(MD5.other, peaks(0.25))
      }
    }), laneHashes(doc()))
    expect(cached?.lanes.map(lane => lane.id)).toEqual(['vocals'])
    expect(cachedWaveform(doc({
      waveforms: { vocals: stamped(MD5.vocals) }
    }), laneHashes(doc()))?.lanes.map(lane => lane.id)).toEqual(['vocals'])
  })

  it.each([
    ['95 buckets', peaks(0.2).slice(1)],
    ['97 buckets', [...peaks(0.2), 0.2]],
    ['sparse buckets', new Array<number>(96)],
    ['NaN', peaks(0.2).fill(Number.NaN, 40, 41)],
    ['positive infinity', peaks(0.2).fill(Number.POSITIVE_INFINITY, 40, 41)],
    ['negative infinity', peaks(0.2).fill(Number.NEGATIVE_INFINITY, 40, 41)],
    ['negative RMS', peaks(0.2).fill(-0.01, 40, 41)],
    ['RMS above one', peaks(0.2).fill(1.01, 40, 41)],
    ['non-number RMS', peaks(0.2).fill('0.2' as unknown as number, 40, 41)]
  ])('rejects only the corrupt lane: %s', (_name, corrupt) => {
    const cached = cachedWaveform(doc({
      waveforms: {
        vocals: stamped(MD5.vocals),
        drums: stamped(MD5.drums, corrupt)
      }
    }), laneHashes(doc()))
    expect(cached?.lanes.map(lane => lane.id)).toEqual(['vocals'])
  })

  it.each([
    ['future version', { ...stamped(MD5.drums), version: 2 }],
    ['wrong policy', { ...stamped(MD5.drums), policy: 'other-policy' }],
    ['incomplete stamp', { md5: MD5.drums, peaks: peaks(0.2), version: 1 }],
    ['uppercase MD5', { ...stamped(MD5.drums), md5: MD5.drums.toUpperCase() }],
    ['unknown key', { ...stamped(MD5.drums), extra: true }],
    ['non-record', []]
  ])('rejects malformed schema without poisoning valid lanes: %s', (_name, entry) => {
    const cached = cachedWaveform(doc({
      waveforms: {
        vocals: stamped(MD5.vocals),
        drums: entry as never
      }
    }), laneHashes(doc()))
    expect(cached?.lanes.map(lane => lane.id)).toEqual(['vocals'])
  })

  it('persists each newly measured valid lane with the current policy stamp', () => {
    const kept = waveformCacheFor({
      bucketCount: 96,
      lanes: [
        { id: 'vocals', peaksValid: true, peaks: peaks(0.5) },
        { id: 'drums', peaksValid: false, peaks: peaks(0) },
        { id: 'unknown', peaksValid: true, peaks: peaks(1) }
      ]
    }, laneHashes(doc()))
    expect(Object.keys(kept)).toEqual(['vocals'])
    expect(kept.vocals).toEqual(stamped(MD5.vocals))
  })

  it('emits a native seed only for the exact actual content MD5', () => {
    const project = withCustom({
      waveforms: { 'custom-studio-id': { md5: MD5.custom, peaks: peaks(0.4) } }
    })
    expect(waveformSeedFor(project, 'custom-studio-id', MD5.custom)).toEqual({
      version: 1,
      policy: WAVEFORM_POLICY,
      sourceMd5: MD5.custom,
      bucketCount: 96,
      peaks: peaks(0.4)
    })
    expect(waveformSeedFor(project, 'custom-studio-id', MD5.other)).toBeUndefined()
    expect(waveformSeedFor(project, 'custom-take-7', MD5.custom)).toBeUndefined()
  })

  it('bounds a saved set to the native lane limit', () => {
    const wanted = Object.fromEntries(
      Array.from({ length: MAX_WAVEFORM_LANES + 1 }, (_, index) => [
        `lane-${index}`, MD5.vocals
      ])
    )
    const cached = cachedWaveform(doc({
      waveforms: Object.fromEntries(
        Object.keys(wanted).map(id => [id, stamped(MD5.vocals)])
      )
    }), wanted)
    expect(cached?.lanes).toHaveLength(MAX_WAVEFORM_LANES)
  })
})
