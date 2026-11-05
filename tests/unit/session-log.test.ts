/**
 * The desktop keeps each launch's log on disk, current launch and ten previous, because the
 * in-memory log dies with the process — and restarting is exactly what a
 * singer does when playback stops working, taking the evidence with it.
 */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { attachRendererLogs, log, logEntries, logSessions, readLogSession, startSessionLog } from '../../src/main/log'

describe('the desktop session logs', () => {
  it('persists renderer failures with severity and source, without console chatter or URL credentials', () => {
    const contents = new EventEmitter()
    attachRendererLogs(contents as unknown as Electron.WebContents)
    const before = logEntries().length
    contents.emit('console-message', { level: 'info', message: 'ordinary console chatter' })
    contents.emit('console-message', {
      level: 'warning', message: 'Audio fallback selected', lineNumber: 42,
      sourceId: 'https://user:password@example.test/assets/player.js?token=secret#private'
    })
    contents.emit('console-message', { level: 'error', message: 'Song open failed', lineNumber: 12, sourceId: 'file:///app/player.js' })
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 })
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 9 })
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'file:///old-page', true)
    contents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///missing', true)
    contents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'file:///image', false)
    const entries = logEntries().slice(before)
    expect(entries.map(e => [e.level, e.source, e.line])).toEqual([
      ['warn', 'renderer', 'Audio fallback selected · player.js:42'],
      ['error', 'renderer', 'Song open failed · player.js:12'],
      ['error', 'renderer', 'process exited unexpectedly · oom · exit code 9'],
      ['error', 'renderer', 'page load failed · ERR_FAILED (-2)']
    ])
    expect(JSON.stringify(entries)).not.toMatch(/password|token=secret|private|ordinary console/)
  })

  it('keeps a diagnostic and reaches surviving windows when another renderer closes during delivery', () => {
    const delivered = vi.fn()
    const closing = { isDestroyed: () => false, webContents: {
      isDestroyed: () => false, send: () => { throw new Error('Object has been destroyed') }
    } }
    const healthy = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: delivered } }
    const windows = vi.spyOn(BrowserWindow, 'getAllWindows').mockReturnValue([closing, healthy] as unknown as BrowserWindow[])
    try {
      expect(() => log('dsp', 'shutdown diagnostic remains available', 'warn')).not.toThrow()
      expect(delivered).toHaveBeenCalledWith('log:line', expect.objectContaining({
        source: 'dsp', line: 'shutdown diagnostic remains available', level: 'warn'
      }))
    } finally { windows.mockRestore() }
  })

  it('writes this launch, keeps the current launch and ten previous and reads a past one back', () => {
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
    startSessionLog(dir)
    log('dsp', 'unload failed · generation 3 · teardown-uncertain', 'warn')

    const kept = readdirSync(dir).filter((n) => n.startsWith('session-'))
    expect(kept).toHaveLength(11)
    expect(readdirSync(dir)).toContain('notes.txt')
    // The two oldest went: launches 0 and 1.
    expect(kept.some((n) => n.includes('2026-09-01T'))).toBe(false)
    expect(kept.some((n) => n.includes('2026-09-03T'))).toBe(true)
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
