import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NATIVE_PRE_ROLL_POLL_MS,
  NATIVE_TELEMETRY_POLL_MS,
  NATIVE_TELEMETRY_PROJECTION_LIMIT_SEC
} from '../src/playback/native'

/*
 * The telemetry poll interval is ONE decision, and it is read in three places
 * that cannot import each other.
 *
 * `projected()` in backend.ts bounds its forward projection at two missed
 * polls; that bound used to be a hardcoded 0.4 s under a comment claiming it
 * tracked the interval, which was true only while the interval was 200 ms.
 * The player-session driver sizes its re-anchor-echo window from the same
 * number, and ITS literal was a fixed 300 ms — wider than the correction's
 * arrival at a 200 ms poll and narrower than it the moment the interval
 * moved, which would have had a quarter of seeks measuring a confident zero
 * while the suite printed green.
 *
 * backend.ts now derives its bound from the export, so it cannot drift. The
 * driver runs in node against a device rather than inside the bundle and so
 * cannot import at all — it mirrors the value instead, and a mirror with only
 * a "keep in step" comment behind it is the same trap one level up. This is
 * the enforcement.
 */
const driver = readFileSync(
  join(__dirname, '..', 'tests', 'player-session', 'scenario.cjs'),
  'utf8'
)

describe('the telemetry poll interval is written down once', () => {
  it('is mirrored exactly by the player-session driver', () => {
    const mirrored = /^const POLL_MS = (\d+)$/m.exec(driver)
    expect(mirrored).not.toBeNull()
    expect(Number(mirrored![1])).toBe(NATIVE_TELEMETRY_POLL_MS)
  })

  it('leaves no bare re-statement of the interval in the driver', () => {
    // The windows must be DERIVED from POLL_MS. A literal that happens to
    // equal today's interval is exactly what this test exists to catch, so
    // the sampling lines are required to mention the constant.
    // The expression itself, not a mention of it: `[^\n]+` swallowed trailing
    // comments, so `const echoWindowMs = 300 // was POLL_MS + 100` passed a
    // toContain check while being exactly the drift this guards against.
    const echo = /const echoWindowMs = ([^\n/]+)/.exec(driver)
    expect(echo).not.toBeNull()
    expect(echo![1]).toMatch(/\bPOLL_MS\b\s*[+-]/)
    expect(driver).toMatch(/holdAfterHitMs: POLL_MS \+/)
  })

  it('bounds projection at two missed polls of the SLOWER rate', () => {
    // Pre-roll polls faster, so the widest gap the projection must cover is
    // still the ordinary interval's.
    expect(NATIVE_PRE_ROLL_POLL_MS).toBeLessThanOrEqual(NATIVE_TELEMETRY_POLL_MS)
    expect(NATIVE_TELEMETRY_PROJECTION_LIMIT_SEC).toBeCloseTo(
      (2 * NATIVE_TELEMETRY_POLL_MS) / 1000,
      6
    )
  })
})
