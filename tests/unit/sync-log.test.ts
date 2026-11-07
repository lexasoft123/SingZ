/**
 * The sync log answers "why is my phone showing yesterday's mix?" — a question
 * about what happened before the last launch, which the in-memory log panel
 * cannot answer because it dies with the process.
 */
import { describe, expect, it } from 'vitest'
import { replaySyncLog, syncLog, syncLogEntries } from '../../src/main/sync-log'
import { logEntries } from '../../src/main/log'

describe('the desktop sync log', () => {
  it('keeps what happened, newest first, across reads', () => {
    syncLog('run', 'done — 2 songs, 1 uploaded, 5 unchanged')
    syncLog('upload', 'Mr Crowley/stems/vocals.flac → Drive (replaced)')
    const entries = syncLogEntries()
    expect(entries[0].msg).toContain('vocals.flac')
    expect(entries[0].kind).toBe('upload')
    expect(entries[1].msg).toContain('1 uploaded')
    expect(entries[0].at).toBeGreaterThan(0)
  })

  it('survives a line torn by a kill mid-write', async () => {
    const { app } = await import('electron')
    const { appendFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    syncLog('run', 'a good line')
    // a real kill lands mid-append, and every append starts with the newline,
    // so the fragment carries one — that is what keeps the previous record intact
    appendFileSync(join(app.getPath('userData'), 'sync-log.jsonl'), '\n{"at":1,"kin')
    expect(() => syncLogEntries()).not.toThrow()
    expect(syncLogEntries().some((e) => e.msg === 'a good line')).toBe(true)
  })

  it('records a failure as one', () => {
    syncLog('error', 'sync failed: Drive API 503')
    expect(syncLogEntries()[0].kind).toBe('error')
  })

  it('reports the number actually replayed rather than the larger retained history', () => {
    for (let index = 0; index < 160; ++index) syncLog('run', `replay-count-${index}`)
    const kept = syncLogEntries().length
    const before = logEntries().length
    replaySyncLog()
    const replay = logEntries().slice(before).filter(entry => entry.source === 'gdrive')
    expect(replay).toHaveLength(121)
    expect(replay.slice(0, -1).every(entry => entry.line.includes('replay-count-'))).toBe(true)
    expect(replay.at(-1)?.line).toBe(`— 120 earlier sync entries above (${kept} kept) —`)
  })
})
