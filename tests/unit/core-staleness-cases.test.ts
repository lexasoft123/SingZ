/**
 * The TypeScript end of tests/shared/core/staleness-cases.json. The native desktop
 * runs the same rows in experiments/gpui-player/src/core_case_tables_tests.rs, so
 * "when must a stored analysis be re-derived" has one statement, not two.
 */
import { describe, expect, it } from 'vitest'
import table from '../shared/core/staleness-cases.json'
import { analysisIsStale, BEAT_DETECT_VERSION, KEY_DETECT_VERSION } from '../../src/renderer/src/audio/analysis-contract'
import { PITCH_DETECT_VERSION } from '../../src/renderer/src/audio/melody'

const current = table.detectors as Record<string, number>

describe('analysisIsStale — the shared case table', () => {
  it('the table names the detector versions the code stamps', () => {
    expect(current).toEqual({ beat: BEAT_DETECT_VERSION, key: KEY_DETECT_VERSION, pitch: PITCH_DETECT_VERSION })
  })

  it.each(table.cases)('$name', (c) => {
    const stamp = 'stamp' in c ? c.stamp : undefined
    expect(analysisIsStale(stamp as number | undefined, current[c.kind])).toBe(c.stale)
  })

  // JSON cannot carry these; the TypeScript rule still treats them as nonsense.
  it.each([NaN, Infinity, -Infinity])('non-finite stamp %s re-derives', (stamp) => {
    expect(analysisIsStale(stamp, 2)).toBe(true)
  })
})
