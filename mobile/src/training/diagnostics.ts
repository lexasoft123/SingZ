/** End-to-end acoustic probe, including detector and bridge delay. This is
 * deliberately independent of the capture's startup timestamp anchor. */
export function detectedToneDelayMs(
  targetMidi: number,
  frequency: number,
  clarity: number,
  arrivalMs: number | null,
  scheduledMs: number
): number | null {
  if (!Number.isFinite(frequency) || frequency <= 0 || !Number.isFinite(clarity) || clarity < 0.8 ||
      arrivalMs === null || !Number.isFinite(arrivalMs) || !Number.isFinite(scheduledMs)) return null
  const cents = 1200 * Math.log2(frequency / (440 * 2 ** ((targetMidi - 69) / 12)))
  const delay = arrivalMs - scheduledMs
  return Math.abs(cents) <= 50 && delay >= 0 && delay <= 2500 ? delay : null
}

interface PitchDiagnosticFrame {
  harmonicCorrected?: boolean
  frequency: number; clarity: number; rms: number; sampleRate: number
  resetCount: string; timestampQuality: string; discontinuityReason: string
}

/** Every native frame contributes, even when the UI skips intermediate frames. */
export class PitchDiagnosticWindow {
  private corrected = 0
  private blocks = 0
  private voiced = 0
  private confident = 0
  private minHz = Infinity
  private maxHz = 0
  private minConfidence = Infinity
  private maxConfidence = 0
  private jumps = 0
  private previousHz = 0
  private maxGapMs = 0
  private previousAt: number | null = null
  private frame: PitchDiagnosticFrame | null = null

  add(frame: PitchDiagnosticFrame, now: number): void {
    this.blocks++
    if (frame.harmonicCorrected) this.corrected++
    if (this.previousAt !== null) this.maxGapMs = Math.max(this.maxGapMs, now - this.previousAt)
    this.previousAt = now
    this.frame = frame
    if (Number.isFinite(frame.clarity)) {
      this.minConfidence = Math.min(this.minConfidence, frame.clarity)
      this.maxConfidence = Math.max(this.maxConfidence, frame.clarity)
    }
    if (Number.isFinite(frame.frequency) && frame.frequency > 0) {
      this.voiced++
      if (frame.clarity >= 0.8) this.confident++
      this.minHz = Math.min(this.minHz, frame.frequency)
      this.maxHz = Math.max(this.maxHz, frame.frequency)
      if (this.previousHz > 0 && Math.abs(12 * Math.log2(frame.frequency / this.previousHz)) >= 10) this.jumps++
      this.previousHz = frame.frequency
    } else this.previousHz = 0
  }

  flush(): string | null {
    const f = this.frame
    if (!f || !this.blocks) return null
    const range = this.voiced ? `${this.minHz.toFixed(1)}–${this.maxHz.toFixed(1)} Hz` : 'no pitch'
    const confidence = Number.isFinite(this.minConfidence)
      ? `${this.minConfidence.toFixed(3)}–${this.maxConfidence.toFixed(3)}` : 'invalid'
    const line = `${this.blocks} blocks · ${this.voiced} pitched/${this.confident} confidence ≥0.8 · ` +
      `${range} · confidence ${confidence} · octave jumps ${this.jumps} · max delivery gap ${this.maxGapMs.toFixed(0)} ms · ` +
      `last ${f.frequency.toFixed(1)} Hz/${f.clarity.toFixed(3)} · ` +
      `${f.rms > 0 ? (20 * Math.log10(f.rms)).toFixed(1) : '-120'} dBFS · ` +
      `${f.sampleRate} Hz · ${f.timestampQuality} · resets ${f.resetCount} · ${f.discontinuityReason} · harmonic corrections ${this.corrected}`
    this.corrected = 0
    this.blocks = this.voiced = this.confident = this.jumps = this.maxGapMs = 0
    this.minHz = this.minConfidence = Infinity
    this.maxHz = this.maxConfidence = 0
    return line
  }
}
