import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'

export type WriteSyncLike = (fd: number, buffer: Uint8Array, offset: number, length: number) => number

/** Node may legally complete a synchronous write with fewer bytes than asked.
 * Keep advancing until the whole buffer is durable or fail without publishing. */
export function writeAllSync(fd: number, bytes: Uint8Array, write: WriteSyncLike = writeSync): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = write(fd, bytes, offset, bytes.byteLength - offset)
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset)
      throw new Error('File write made no progress.')
    offset += written
  }
}

/** Directory fsync is supported on macOS/Linux and unavailable on some Windows
 * filesystems. Unsupported errors are ignored; real I/O errors still surface. */
export function fsyncDirectorySync(
  dir: string,
  ops: { openSync: typeof openSync; fsyncSync: typeof fsyncSync; closeSync: typeof closeSync } =
    { openSync, fsyncSync, closeSync }
): void {
  let fd: number | undefined
  try {
    fd = ops.openSync(dir, 'r')
    ops.fsyncSync(fd)
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally {
    if (fd !== undefined) ops.closeSync(fd)
  }
}

const sharingViolation = (error: unknown): boolean =>
  ['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

export interface AtomicWriteOptions {
  mode?: number
  /** How long a rename may keep retrying a Windows sharing violation (a scanner
   *  or indexer holding the destination). Never unlinks the destination. */
  renameRetryMs?: number
  sleep?: (ms: number) => void
  now?: () => number
  /** Fsync the directory after the rename (default). Hot-path callers pass false
   *  and leave the fsync to the backup publisher's later directory fsync. */
  syncDirectory?: boolean
}

function renameWithRetry(temp: string, target: string, options: AtomicWriteOptions): void {
  const { renameRetryMs = 2000, sleep = sleepSync, now = Date.now } = options
  const deadline = now() + renameRetryMs
  for (let wait = 5; ; wait = Math.min(wait * 2, 200)) {
    try {
      renameSync(temp, target)
      return
    } catch (error) {
      if (!sharingViolation(error) || now() + wait > deadline) throw error
      sleep(wait)
    }
  }
}

/** Publish `bytes` at `target` atomically: a private temp file in the same
 * directory, fsynced, one rename, then a directory fsync. A crash leaves the old
 * file or the whole new one. Throws on any failure; before the rename the temp
 * is removed and the old file is untouched. A failure of the final directory
 * fsync is thrown too, though the rename has by then already published. */
export function writeFileAtomicSync(target: string, bytes: Uint8Array, options: AtomicWriteOptions = {}): void {
  const { mode = 0o600, syncDirectory = true } = options
  const temp = `${target}.${randomBytes(8).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', mode)
    writeAllSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameWithRetry(temp, target, options)
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd) } catch { /* already failing */ }
    try { unlinkSync(temp) } catch { /* never created or already renamed */ }
    throw error
  }
  if (syncDirectory) fsyncDirectorySync(dirname(target))
}

/** The slow half of an atomic write, on the libuv threadpool: write `bytes` to
 * `temp` and fsync it. Nothing is published; `publishStagedSync` does that, on
 * the caller's thread, once it has decided the bytes are still wanted. On failure
 * the temp is removed. */
export async function stageFile(temp: string, bytes: Uint8Array, mode = 0o600): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, 'wx', mode)
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error('File write made no progress.')
      offset += bytesWritten
    }
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    try { await handle?.close() } catch { /* already failing */ }
    try { await unlink(temp) } catch { /* never created */ }
    throw error
  }
}

/** Synchronous publish of a staged temp: rename (bounded retry on a Windows
 * sharing violation, never unlinking the destination) then directory fsync. No
 * await sits between a caller's last check and the rename, so on one JS thread
 * nothing can interleave. A failed rename removes the temp. */
export function publishStagedSync(temp: string, target: string, options: AtomicWriteOptions = {}): void {
  try {
    renameWithRetry(temp, target, options)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* already gone */ }
    throw error
  }
  fsyncDirectorySync(dirname(target))
}
