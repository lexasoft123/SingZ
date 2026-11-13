/** Live-monitor gain range, the single source for main, renderer and the UI.
 *  The native side mirrors it in native/playback/voice_monitor.h
 *  (kVoiceMonitorGainMinDb/MaxDb); tests/unit/voice-monitor-gain.test.ts pins them equal. */
export const VOICE_MONITOR_GAIN_MIN_DB = -60
export const VOICE_MONITOR_GAIN_MAX_DB = 36
/** First-use level: -12 dB was too quiet for a typical mic and interface gain. */
export const VOICE_MONITOR_GAIN_DEFAULT_DB = -6
/** Above this level the Track settings warn about feedback. */
export const VOICE_MONITOR_GAIN_HIGH_DB = 12
export const clampMonitorGainDb = (db: number): number => Math.max(VOICE_MONITOR_GAIN_MIN_DB, Math.min(VOICE_MONITOR_GAIN_MAX_DB, db))
