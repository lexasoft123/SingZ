import { app, BrowserWindow, dialog } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LogEntry, LogLevel } from '../shared/types'

/**
 * In-app diagnostic log: a ring buffer in the main process, streamed to the
 * renderer's log panel and saveable to a text file. Engines and downloads log
 * here so failures on user machines are diagnosable without a dev setup.
 */
const MAX_ENTRIES = 4000
const buf: LogEntry[] = []

export function log(source: string, line: string, level: LogLevel = 'info'): void {
  const entry: LogEntry = { t: Date.now(), level, source, line: line.slice(0, 2000) }
  buf.push(entry)
  if (buf.length > MAX_ENTRIES) buf.splice(0, buf.length - MAX_ENTRIES)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('log:line', entry)
  }
}

/** Log every non-empty line of child-process output, skipping progress spam. */
export function logChunk(source: string, chunk: string, skip?: RegExp): void {
  for (const raw of chunk.split(/\r?\n|\r/)) {
    const line = raw.trim()
    if (!line || (skip && skip.test(line))) continue
    log(source, line)
  }
}

export function logEntries(): LogEntry[] {
  return buf.slice()
}

function formatLog(): string {
  const head = `SingZ ${app.getVersion()} — ${process.platform}-${process.arch}\n`
  const lines = buf.map(
    (e) => `${new Date(e.t).toISOString()} [${e.level}] ${e.source}: ${e.line}`
  )
  return head + lines.join('\n') + '\n'
}

/** Save the log to a file; without an explicit path, ask where (test hook: path). */
export async function saveLog(
  explicitPath?: string
): Promise<{ ok: true; path: string } | { ok: false; cancelled?: boolean; error: string }> {
  try {
    let dest = explicitPath
    if (!dest) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const res = await dialog.showSaveDialog(win, {
        title: 'Save log',
        defaultPath: join(app.getPath('desktop'), `SingZ-log-${stamp}.txt`)
      })
      if (res.canceled || !res.filePath) return { ok: false, cancelled: true, error: 'Cancelled.' }
      dest = res.filePath
    }
    await writeFile(dest, formatLog(), 'utf8')
    log('app', `log saved to ${dest}`)
    return { ok: true, path: dest }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
