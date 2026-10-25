/** The native playback graph admits gains up to 4; +12 dB stays inside it. */
export const SONG_VOLUME_MAX_DB = 12
export const SONG_VOLUME_MIN_DB = -60
export const songVolumeToDb = (gain: number): number => gain > 0 ? 20 * Math.log10(gain) : -Infinity
export const songVolumeFromDb = (db: number): number => db <= SONG_VOLUME_MIN_DB ? 0 : 10 ** (db / 20)
export function sanitizeSongVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(10 ** (SONG_VOLUME_MAX_DB / 20), value)) : 1
}
export function formatSongVolume(gain: number): string {
  const db = songVolumeToDb(gain)
  return Number.isFinite(db) ? `${db > 0.05 ? '+' : ''}${Math.abs(db) < 0.05 ? '0.0' : db.toFixed(1)} dB` : '−∞ dB'
}
