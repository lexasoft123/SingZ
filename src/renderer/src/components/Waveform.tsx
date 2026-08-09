/*
 * The waveform lives in @singz/ui now — it never had any SingZ in it: peaks,
 * a buffer, a colour and a visible window. Re-exported rather than having
 * every call site rewritten, because TrackLane's import is the only one.
 */
export { Waveform as default } from '@singz/ui'
