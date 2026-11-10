/**
 * The TypeScript end of tests/shared/core/lrc-cases.json. The native desktop runs
 * the same rows against `parse_lrc` in experiments/gpui-player/src/lrclib.rs
 * (core_case_tables_tests.rs). tests/shared/lrc-fixture.json stays the larger
 * real-world fixture; this table pins the individual rules.
 */
import { describe, expect, it } from 'vitest'
import cases from '../shared/core/lrc-cases.json'
import { parseLrc } from '../../src/shared/lrclib-core'

describe('parseLrc — the shared case table', () => {
  it.each(cases)('$name', ({ lrc, duration, lines }) => {
    expect(parseLrc(lrc, duration)).toEqual(lines)
  })
})
