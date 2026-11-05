import { describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '../../src/shared/types'
vi.mock('@singz/ui', () => ({ Modal: () => null }))
import { formatLogEntries } from '../../src/renderer/src/components/LogPanel'

describe('copied desktop log timestamps', () => {
  it('keeps date and UTC timezone across midnight and archived sessions', () => {
    const rows: LogEntry[] = [
      { t: Date.parse('2026-11-05T23:59:59.999Z'), source: 'dsp', level: 'info', line: 'before midnight' },
      { t: Date.parse('2026-11-06T00:00:00.001Z'), source: 'dsp', level: 'warn', line: 'after midnight' }
    ]
    expect(formatLogEntries(rows)).toBe(
      '2026-11-05T23:59:59.999Z [info] dsp: before midnight\n' +
      '2026-11-06T00:00:00.001Z [warn] dsp: after midnight'
    )
  })

  it('keeps unparsed archive headings copyable without inventing a timestamp', () => {
    expect(formatLogEntries([{ t: NaN, source: '', level: 'info', line: 'SingZ archive heading' }]))
      .toContain('SingZ archive heading')
  })
})
