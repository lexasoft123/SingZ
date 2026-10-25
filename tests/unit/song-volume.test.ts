import { describe, expect, it } from 'vitest'
import { formatSongVolume, sanitizeSongVolume, songVolumeFromDb, songVolumeToDb } from '../../src/renderer/src/audio/song-volume'

describe('per-song output gain', () => {
  it('defaults older or invalid song settings to unity and bounds boosted gains for native playback', () => {
    for (const value of [undefined, null, NaN, Infinity, '4']) expect(sanitizeSongVolume(value)).toBe(1)
    expect(sanitizeSongVolume(-1)).toBe(0)
    expect(songVolumeToDb(sanitizeSongVolume(100))).toBeCloseTo(12)
    expect(sanitizeSongVolume(100)).toBeLessThan(4)
  })
  it('round-trips attenuation and boost, with a silent slider endpoint', () => {
    for (const db of [-59.5, -12, 0, 6, 12]) expect(songVolumeToDb(songVolumeFromDb(db))).toBeCloseTo(db)
    expect(songVolumeFromDb(-60)).toBe(0)
    expect(formatSongVolume(0)).toBe('−∞ dB')
    expect(formatSongVolume(1)).toBe('0.0 dB')
    expect(formatSongVolume(songVolumeFromDb(12))).toBe('+12.0 dB')
  })
})
