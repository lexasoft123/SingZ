export interface BoxCaptureTapRequest {
  seconds: number
  /** Explicit device UID and zero-based physical channel. */
  input: { uid: string; channel: number }
}
export interface BoxCaptureTapResult {
  id: string; active: boolean; complete: boolean; ok: boolean; error: string
  outputPath: string; inputPath: string; sampleRate: number
  outputFrames: string; inputFrames: string; targetFrames: string
  firstOutputHostNs: string; firstInputHostNs: string
  outputDiscontinuities: string; inputDiscontinuities: string
}
export function captureTapRequest(value: unknown): BoxCaptureTapRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid diagnostic capture request')
  const v = value as Record<string, unknown>
  if (Object.keys(v).length !== 2 || typeof v.seconds !== 'number' || !Number.isFinite(v.seconds) || v.seconds <= 0 || v.seconds > 30 ||
      !v.input || typeof v.input !== 'object' || Array.isArray(v.input)) throw new Error('Diagnostic capture requires 0 < seconds <= 30 and one input')
  const input = v.input as Record<string, unknown>
  if (Object.keys(input).length !== 2 || typeof input.uid !== 'string' || !input.uid || input.uid.length > 4096 || input.uid.includes('\0') ||
      !Number.isInteger(input.channel) || (input.channel as number) < 0 || (input.channel as number) >= 64) throw new Error('Invalid diagnostic input device or channel')
  return { seconds: v.seconds, input: { uid: input.uid, channel: input.channel as number } }
}
