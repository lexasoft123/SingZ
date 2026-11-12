import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { NATIVE_HANDOVER_FILE, NATIVE_HANDOVER_MAX_BYTES, buildNativeHandover, type NativeHandoverReport } from '../shared/native-handover'
import { fsyncDirectorySync, writeAllSync } from './atomic-file'

export type NativeHandoverWriteResult = { ok: true; path: string } | { ok: false; error: string }

/** Publish `<dir>/native-handover.json` atomically: a private temp file in the
 * same directory, fsynced, then one rename, so native's importer sees the old
 * file or the whole new one and never a half-written one. Electron's own profile
 * only; nothing is read back and no native state is touched. */
export function writeNativeHandover(dir: string, report: NativeHandoverReport): NativeHandoverWriteResult {
  const target = join(dir, NATIVE_HANDOVER_FILE)
  const temp = join(dir, `${NATIVE_HANDOVER_FILE}.${randomBytes(8).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    const bytes = Buffer.from(`${JSON.stringify(buildNativeHandover(report), null, 2)}\n`)
    if (bytes.byteLength > NATIVE_HANDOVER_MAX_BYTES) throw new Error('Handover export is too large.')
    mkdirSync(dir, { recursive: true })
    fd = openSync(temp, 'wx', 0o600)
    writeAllSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, target)
    fsyncDirectorySync(dir)
    return { ok: true, path: target }
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd) } catch { /* already failing */ }
    try { unlinkSync(temp) } catch { /* never created or already renamed */ }
    return { ok: false, error: String(error) }
  }
}
