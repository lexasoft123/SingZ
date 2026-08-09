import type { MelodyInfo } from '../../../shared/types'

/**
 * Stamp on every stored melody line. Bump it whenever the tracker's output
 * would change: pyin's parameters, priors or Viterbi (`pyin.ts`), the worker's
 * framing (decimation, window, hop) or its cleaner gates (`pitch.worker.ts`).
 * Stored lines carrying an older stamp are silently re-tracked when the song
 * opens, so a fix reaches saved projects — and, through Drive, the phones —
 * instead of only songs split from then on. Forget the bump and every project
 * in the library keeps drawing the old line forever.
 *
 * v1: first stored line — pYIN (Beta(2,18) threshold prior, banded Viterbi)
 * plus the RMS-gated cleaner (isolated-octave refold, quiet outlier-run drop).
 */
export const PITCH_DETECT_VERSION = 1

/** Encoding reference pitch (A1), the same one the worker's cleaner counts from. */
const REF_HZ = 55

/**
 * How far a stored line's coverage may sit from the song's own length before it
 * is disowned. The tracker's last window ends at the last sample, so a line of
 * this song covers `duration - WIN/sr` (~70 ms) — two seconds is slack, not
 * policy.
 */
const COVERAGE_SLACK_SEC = 2

/** ~83 minutes at a 25 ms hop — a garbage guard, not a policy. */
const MAX_FRAMES = 200000

/**
 * Pack a tracked melody into the `f0` token stream (see `MelodyInfo`): voiced
 * frames as integer cents above 55 Hz, unvoiced ones run-length collapsed.
 * Cents cost four digits where a Hz reading costs seven-plus, and songs are
 * unvoiced for most of their frames, so a four-minute line lands around 20 kB
 * of project.json — small next to the stems, and still readable in a text
 * editor. Half-cent rounding error is far under the semitone quantization the
 * pitch strip draws with.
 */
export function encodeMelody(f0: Float32Array, hopSec: number): MelodyInfo {
  const out: string[] = []
  let gap = 0
  const flush = (): void => {
    if (gap > 0) out.push(gap === 1 ? 'x' : `x${gap}`)
    gap = 0
  }
  for (let i = 0; i < f0.length; i++) {
    const f = f0[i]
    if (!(f > 0)) {
      gap++
      continue
    }
    flush()
    // Clamped at 0: sub-55 Hz would encode as a negative number, and the
    // token stream reserves nothing for one. The tracker floors at 65 Hz.
    out.push(String(Math.max(0, Math.round(1200 * Math.log2(f / REF_HZ)))))
  }
  flush()
  return {
    detVersion: PITCH_DETECT_VERSION,
    hopSec: Math.round(hopSec * 1e7) / 1e7,
    f0: out.join(' ')
  }
}

/**
 * Does this line describe THIS song? A line is a frame per hop from the first
 * sample to the last, so its coverage is the song's length — anything else is
 * some other song's line, and drawing it puts notes over silence and reads the
 * key off music the singer never sang. Two projects in the field were found
 * carrying a neighbour's line byte for byte (a melody worker that outlived the
 * song it was started for), and a stored line is adopted as-is forever once its
 * stamp is current, so the length is checked at adoption rather than trusted.
 */
export function melodyFitsSong(f0: Float32Array, hopSec: number, durationSec: number): boolean {
  return Math.abs(f0.length * hopSec - durationSec) <= COVERAGE_SLACK_SEC
}

/**
 * Unpack a stored melody line (null = absent or unusable — anything malformed
 * is dropped whole rather than half-trusted, like `sanitizeBeatInfo`). The
 * returned `info` is the sanitized record to save back; the caller decides
 * whether `detVersion` is current.
 */
export function decodeMelody(raw: unknown): { info: MelodyInfo; f0: Float32Array } | null {
  const r = (raw ?? {}) as Record<string, unknown>
  if (typeof r.f0 !== 'string') return null
  const hopSec = Number(r.hopSec)
  if (!(hopSec > 0.001 && hopSec < 0.5)) return null

  const vals: number[] = []
  for (const tok of r.f0.split(/\s+/)) {
    if (tok.length === 0) continue
    if (tok[0] === 'x') {
      const n = tok.length === 1 ? 1 : Number(tok.slice(1))
      if (!Number.isInteger(n) || n < 1 || vals.length + n > MAX_FRAMES) return null
      for (let i = 0; i < n; i++) vals.push(0)
      continue
    }
    const cents = Number(tok)
    if (!Number.isFinite(cents) || cents < 0 || cents > 8000) return null
    if (vals.length >= MAX_FRAMES) return null
    vals.push(REF_HZ * Math.pow(2, cents / 1200))
  }
  if (vals.length === 0) return null

  const dv = Number(r.detVersion)
  return {
    info: { detVersion: Number.isFinite(dv) ? dv : 0, hopSec, f0: r.f0 },
    f0: Float32Array.from(vals)
  }
}
