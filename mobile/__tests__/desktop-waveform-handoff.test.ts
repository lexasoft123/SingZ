/**
 * The seam: a project the DESKTOP actually saved, read by the code the phone
 * actually uses to decide whether to draw a bar.
 *
 * The fixture is not hand-written. It is `project.json` as the desktop wrote
 * it — Electron opened a six-lane project, measured every lane while decoding
 * it for playback, and its Save button wrote the result beside the stem hashes
 * (tests/unit/lane-envelope.test.ts pins that the statistic is the core's).
 * What is under test here is the HANDOVER, which neither side can check alone
 * and which is exactly where a shape mismatch would hide: the phone would
 * silently measure everything again and the desktop's work would buy nothing,
 * with nothing anywhere looking wrong.
 */
import doc from './fixtures/desktop-saved-project.json'
import type { ProjectDoc } from '../src/model'
import { cachedWaveform, laneHashes, waveformCacheFor } from '../src/ui/PlayerScreen'

const saved = doc as unknown as ProjectDoc

describe('a waveform the desktop saved', () => {
  it('names a lane for every stem the project hashes', () => {
    const wanted = laneHashes(saved)
    expect(Object.keys(wanted).sort()).toEqual([
      'bass',
      'drums',
      'guitar',
      'other',
      'piano',
      'vocals'
    ])
  })

  it('is accepted whole, so the phone draws before it decodes anything', () => {
    const envelope = cachedWaveform(saved, laneHashes(saved))
    expect(envelope).not.toBeNull()
    expect(envelope?.lanes).toHaveLength(6)
    expect(envelope?.bucketCount).toBe(96)
    expect(envelope?.lanes.every(l => l.peaksValid)).toBe(true)
    // Real audio, not a row of zeroes: an envelope of silence would satisfy
    // every structural check above and draw an empty bar.
    const loudest = Math.max(...envelope!.lanes.flatMap(l => [...l.peaks]))
    expect(loudest).toBeGreaterThan(0.1)
  })

  it('remeasures only the lane whose bytes changed', () => {
    // Negative control: all-or-nothing rejection would discard the five healthy
    // lanes too. A changed lane must be absent, never drawn from its old bytes.
    const restemmed = {
      ...saved,
      stemHashes: {
        ...saved.stemHashes,
        'vocals.flac': {
          ...saved.stemHashes!['vocals.flac'],
          md5: '00000000000000000000000000000000'
        }
      }
    } as ProjectDoc
    const cached = cachedWaveform(restemmed, laneHashes(restemmed))
    expect(cached?.lanes).toHaveLength(5)
    expect(cached?.lanes.some(lane => lane.id === 'vocals')).toBe(false)
  })

  it('round-trips: what the phone would store matches what the desktop wrote', () => {
    // Mobile adds the explicit policy stamp while preserving the desktop's
    // content identity and exact values, so both readers accept the result.
    const wanted = laneHashes(saved)
    const envelope = cachedWaveform(saved, wanted)!
    const restored = waveformCacheFor(envelope, wanted)
    expect(Object.keys(restored).sort()).toEqual(Object.keys(saved.waveforms!).sort())
    for (const id of Object.keys(restored)) {
      expect(restored[id].md5).toBe(saved.waveforms![id].md5)
      expect(restored[id].peaks).toEqual(saved.waveforms![id].peaks)
    }
  })
})
