import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, rename, rm } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { setTimeout as delay } from 'node:timers/promises'

export interface DownloadFile {
  id: string
  name: string
  md5Checksum?: string
  size?: string
}
export interface DownloadProgress {
  phase: 'checking' | 'downloading' | 'verifying' | 'retrying'
  bytes: number
  total: number
  bytesPerSecond: number
  attempt: number
}
class DownloadFailure extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message) }
}

/** Verified files survive a failed sync. Partial bytes never replace one. */
export async function downloadDriveFile(file: DownloadFile, out: string, opts: {
  url: string
  token: (renew: boolean, signal: AbortSignal) => Promise<string>
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
  stallMs?: number
  retryMs?: number
}): Promise<{ md5: string; size: number }> {
  const total = Number(file.size ?? 0)
  const signal = opts.signal
  signal?.throwIfAborted()
  const emit = (phase: DownloadProgress['phase'], bytes: number, attempt: number, bytesPerSecond = 0): void => {
    opts.onProgress?.({ phase, bytes, total, attempt, bytesPerSecond })
  }
  emit('checking', 0, 1)
  // A size alone cannot establish that a previous attempt belongs to this revision.
  try {
    const info = await lstat(out)
    if (info.isFile() && file.md5Checksum && (file.size === undefined || info.size === total)) {
      const hash = createHash('md5')
      for await (const chunk of createReadStream(out, { signal })) hash.update(chunk)
      const md5 = hash.digest('hex')
      if (md5 === file.md5Checksum) {
        emit('checking', info.size, 1)
        return { md5, size: info.size }
      }
    }
  } catch (err) {
    signal?.throwIfAborted()
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }

  let renew = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, opts.stallMs ?? 25_000)
      timer.unref?.()
    }
    const part = `${out}.${randomUUID()}.part`
    try {
      arm()
      emit('downloading', 0, attempt)
      const token = await opts.token(renew, controller.signal)
      controller.signal.throwIfAborted()
      const res = await fetch(opts.url, {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal
      })
      if (!res.ok || !res.body) {
        await res.body?.cancel()
        renew = res.status === 401
        throw new DownloadFailure(`Drive API ${res.status} downloading ${file.name}`,
          renew || res.status === 408 || res.status === 429 || res.status >= 500)
      }
      const hash = createHash('md5')
      let size = 0
      let lastEmit = 0
      const started = Date.now()
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        new Transform({ transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk)
          size += chunk.length
          arm()
          const now = Date.now()
          if (now - lastEmit >= 200) {
            lastEmit = now
            emit('downloading', size, attempt, size * 1000 / Math.max(1, now - started))
          }
          done(null, chunk)
        } }),
        createWriteStream(part, { flags: 'wx' }),
        { signal: controller.signal }
      )
      controller.signal.throwIfAborted()
      emit('verifying', size, attempt)
      const md5 = hash.digest('hex')
      if ((file.md5Checksum && md5 !== file.md5Checksum) || (file.size !== undefined && total !== size)) {
        throw new DownloadFailure(`Drive download integrity check failed for ${file.name}`, true)
      }
      await rename(part, out)
      return { md5, size }
    } catch (err) {
      signal?.throwIfAborted()
      const code = (err as NodeJS.ErrnoException).code
      // Filesystem and permanent HTTP failures need a person; network errors can heal.
      const permanentDisk = typeof code === 'string' && /^(EACCES|EPERM|ENOSPC|EROFS|EISDIR|ENOTDIR|EMFILE|EBUSY|EXDEV)$/.test(code)
      const authFailed = err instanceof Error && /not configured|not signed in|sign in again/i.test(err.message)
      const canRetry = !authFailed && !permanentDisk && (!(err instanceof DownloadFailure) || err.retryable)
      if (!canRetry || attempt === 3) {
        if (timedOut) throw new Error(`Drive download timeout for ${file.name}`)
        throw err
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      await rm(part, { force: true })
    }
    emit('retrying', 0, attempt + 1)
    await delay((opts.retryMs ?? 1000) * attempt, undefined, { signal })
  }
  throw new Error('Drive download failed')
}
