import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs'

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
