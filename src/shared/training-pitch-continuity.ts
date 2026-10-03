/** Suppress transient harmonic aliases without folding a real wrong-register
 * note toward an exercise target. Confirmation is based only on capture time
 * and consecutive measurements; missing/weak evidence breaks confirmation. */
export class TrainingPitchContinuity {
  private previousHz: number | null = null
  private lastAcceptedAt: number | null = null
  private previousAt: number | null = null
  private candidate: { hz: number; since: number; frames: number } | null = null

  reset(): void {
    this.previousHz = null
    this.lastAcceptedAt = null
    this.previousAt = null
    this.candidate = null
  }

  update(atMs: number, hz: number, confidence: number, minConfidence = 0.75): number | null {
    if (!Number.isFinite(atMs)) {
      this.reset()
      return null
    }
    if (this.previousAt !== null && (atMs <= this.previousAt || atMs - this.previousAt > 300))
      this.reset()
    this.previousAt = atMs
    if (
      !Number.isFinite(hz) ||
      hz <= 0 ||
      !Number.isFinite(confidence) ||
      confidence < minConfidence
    ) {
      this.candidate = null
      if (this.lastAcceptedAt !== null && atMs - this.lastAcceptedAt > 300) this.previousHz = null
      return null
    }
    const harmonicJump = this.previousHz !== null && [2, 3, 4, 5, 6].some(
      harmonic => Math.abs(Math.abs(1200 * Math.log2(hz / this.previousHz!)) - 1200 * Math.log2(harmonic)) <= 80
    )
    if (harmonicJump) {
      if (!this.candidate || Math.abs(1200 * Math.log2(hz / this.candidate.hz)) > 80)
        this.candidate = { hz, since: atMs, frames: 1 }
      else this.candidate.frames++
      if (atMs - this.candidate.since < 180 || this.candidate.frames < 4) return null
    }
    this.previousHz = hz
    this.lastAcceptedAt = atMs
    this.candidate = null
    return hz
  }
}
