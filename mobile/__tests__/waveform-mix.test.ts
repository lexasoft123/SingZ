import { mergeWaveformLanes, mixWaveformEnvelope, type NativeLaneEnvelope } from '../src/waveform-cache'

const lane = (id: string, value: number) => ({ id, peaksValid: true, peaks: new Array<number>(96).fill(value) })
const envelope = (...lanes: NativeLaneEnvelope['lanes']): NativeLaneEnvelope => ({ bucketCount: 96, lanes })
const colors = (id: string) => id

describe('native waveforms on the song timeline', () => {
  it('draws valid native lanes even without a cacheable hash, and keeps polling subsets', () => {
    const ids = new Set(['vocals', 'custom-short'])
    const first = mergeWaveformLanes(new Map(), envelope(lane('vocals', 0.5)), ids)
    expect(first.size).toBe(1)
    const next = mergeWaveformLanes(first, envelope(lane('custom-short', 0.25), lane('foreign', 1)), ids)
    expect([...next.keys()]).toEqual(['vocals', 'custom-short'])
    // A hash-gated merge loses the custom lane; counting foreign lanes can
    // freeze the bar before the actual prepared set is complete.
    expect(first.size).toBe(1)
  })

  it('preserves equal-length levels exactly', () => {
    const mixed = mixWaveformEnvelope(envelope(lane('vocals', 0.5)), new Map([['vocals', 96]]), colors, 'none')
    expect(mixed).toEqual(Array.from({ length: 96 }, () => ({ level: 0.5, color: 'vocals' })))
  })

  it('pads a shorter custom lane with silence instead of stretching it', () => {
    const mixed = mixWaveformEnvelope(envelope(lane('song', 0.2), lane('custom-short', 0.8)),
      new Map([['song', 96], ['custom-short', 48]]), colors, 'none')
    for (const point of mixed.slice(0, 48)) {
      expect(point.level).toBeCloseTo(Math.hypot(0.2, 0.8), 12)
      expect(point.color).toBe('custom-short')
    }
    for (const point of mixed.slice(48)) {
      expect(point.level).toBe(0.2)
      expect(point.color).toBe('song')
    }
    // Using the same bucket index for every lane makes all 96 points custom.
  })

  it('weights a partly silent end bucket by energy, not amplitude', () => {
    const mixed = mixWaveformEnvelope(envelope(lane('song', 0), lane('short', 1)),
      new Map([['song', 96], ['short', 1.5]]), colors, 'none')
    expect(mixed[0].level).toBe(1)
    expect(mixed[1].level).toBeCloseTo(Math.SQRT1_2, 12)
    expect(mixed.slice(2).every(point => point.level === 0 && point.color === 'none')).toBe(true)
  })
})
