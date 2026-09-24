/**
 * The desktop keeps each launch's log on disk, newest ten, because the
 * in-memory log dies with the process — and restarting is exactly what a
 * singer does when playback stops working, taking the evidence with it.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { log, logSessions, readLogSession, startSessionLog } from '../../src/main/log'

describe('the desktop session logs', () => {
  it('writes this launch, keeps the newest ten and reads a past one back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'singz-session-logs-'))
    // twelve earlier launches, a stray file that is not ours, and one
    // older-than-all name to prove the order is by stamp, not by chance
    for (let i = 0; i < 12; i++) {
      const day = String(i + 1).padStart(2, '0')
      writeFileSync(
        join(dir, `session-2026-09-${day}T10-00-00-000Z-${100 + i}.log`),
        `SingZ 0.23.1 — win32-x64\n2026-09-${day}T10:00:01.000Z [warn] dsp: launch ${i}\n`
      )
    }
    writeFileSync(join(dir, 'notes.txt'), 'not a log')
    log('app', 'logged before the file existed')
    startSessionLog(dir, 10)
    log('dsp', 'unload failed · generation 3 · teardown-uncertain', 'warn')

    const kept = readdirSync(dir).filter((n) => n.startsWith('session-'))
    expect(kept).toHaveLength(10)
    expect(readdirSync(dir)).toContain('notes.txt')
    // the three oldest went: launches 0, 1 and 2
    expect(kept.some((n) => n.includes('2026-09-01T'))).toBe(false)
    expect(kept.some((n) => n.includes('2026-09-03T'))).toBe(false)
    expect(kept.some((n) => n.includes('2026-09-04T'))).toBe(true)

    const sessions = logSessions(dir)
    expect(sessions[0].current).toBe(true)
    expect(sessions.filter((s) => s.current)).toHaveLength(1)
    expect(sessions[1].name).toContain('2026-09-12T')
    expect(sessions[1].startedAt).toBe(Date.parse('2026-09-12T10:00:00.000Z'))

    // this launch's file already holds both lines — the one logged before it
    // started, and the warning, which is written without waiting for a flush
    const mine = readLogSession(sessions[0].name, dir) ?? ''
    expect(mine).toContain('logged before the file existed')
    expect(mine).toContain('[warn] dsp: unload failed · generation 3 · teardown-uncertain')

    expect(readLogSession(sessions[1].name, dir)).toContain('launch 11')
    // only our own names are readable
    expect(readLogSession('../sync-log.jsonl', dir)).toBeNull()
    expect(readLogSession('notes.txt', dir)).toBeNull()
  })
})
