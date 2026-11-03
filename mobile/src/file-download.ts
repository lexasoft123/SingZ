/** Per-file transfer state. Native owns bytes and verification; JS owns the
 * bounded retry policy and a request-scoped watchdog/cancel button. */
export interface FileProgress {
  phase: 'checking' | 'downloading' | 'verifying' | 'retrying'
  got: number
  total: number
  attempt: number
  attempts: number
  bytesPerSecond: number
}
export interface FileDownloadOptions {
  signal?: AbortSignal
  onProgress?: (progress: FileProgress) => void
}
export interface FileDownloadNative {
  fetchToCache(project: string, file: string, url: string, auth: string, md5: string, bytes: number): Promise<{ path: string; downloaded: boolean }>
  fetchToCacheTracked?(project: string, file: string, url: string, auth: string, md5: string, bytes: number, request: string): Promise<{ path: string; downloaded: boolean }>
  driveFetchProgress?(request: string): Promise<{ got: number; total: number; verifying?: boolean } | null>
  cancelDriveFetch?(request: string): Promise<boolean>
}
export class FileDownloadError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'FileDownloadError' }
}
const codeOf = (e: unknown): string => String((e as { code?: string })?.code ??
  (/damaged|checksum|incomplete/i.test(String(e)) ? 'integrity' : 'fetch'))
export const downloadCancelled = (): FileDownloadError => new FileDownloadError('cancelled', 'Download cancelled')
function check(signal?: AbortSignal): void { if (signal?.aborted) throw downloadCancelled() }
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  check(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(downloadCancelled()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
const retryable = (code: string): boolean =>
  ['fetch', 'timeout', 'integrity', 'http408', 'http429'].includes(code) || /^http5\d\d$/.test(code)
let sequence = 0

export async function downloadFile(
  native: FileDownloadNative,
  request: { project: string; file: string; url: string; md5: string; bytes: number },
  authorize: (renew: boolean, signal?: AbortSignal) => Promise<string>,
  options: FileDownloadOptions = {},
  report?: (message: string) => void
): Promise<{ path: string; downloaded: boolean }> {
  const { project, file, url, md5, bytes } = request
  const { signal, onProgress } = options
  const attempts = 3
  check(signal)
  onProgress?.({ phase: 'checking', got: 0, total: bytes, attempt: 1, attempts, bytesPerSecond: 0 })
  try {
    const local = await native.fetchToCache(project, file, '', '', md5, bytes)
    check(signal)
    return local
  } catch (e) {
    check(signal)
    if (codeOf(e) !== 'cacheMiss') throw e
  }
  let renew = false
  for (let attempt = 1; attempt <= attempts; attempt++) {
    check(signal)
    if (attempt > 1) {
      onProgress?.({ phase: 'retrying', got: 0, total: bytes, attempt, attempts, bytesPerSecond: 0 })
      await pause(1000 * (attempt - 1), signal)
    }
    const id = `drive-${Date.now()}-${++sequence}`
    const attemptAbort = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    let polling = false
    let done = false
    let cancel = () => {}
    const started = Date.now()
    let advancedAt = started
    let got = 0
    let phase: FileProgress['phase'] = 'downloading'
    try {
      // Authorization is bounded too: a pending token renewal must not leave
      // the song frozen before the native downloader has even started.
      const deadline = new Promise<never>((_, reject) => {
        cancel = () => {
          reject(downloadCancelled())
          attemptAbort.abort()
          void native.cancelDriveFetch?.(id).catch(() => {})
        }
        signal?.addEventListener('abort', cancel, { once: true })
        timer = setInterval(() => {
          if (Date.now() - advancedAt > 25_000) {
            reject(new FileDownloadError('timeout', 'No download progress for 25 seconds'))
            attemptAbort.abort()
            void native.cancelDriveFetch?.(id).catch(() => {})
          }
          if (!native.driveFetchProgress || polling) return
          polling = true
          void native.driveFetchProgress(id).then(p => {
            if (done || !p) return
            const nextPhase = p.verifying ? 'verifying' : 'downloading'
            if (p.got !== got || phase !== nextPhase) advancedAt = Date.now()
            got = Math.max(0, p.got)
            phase = nextPhase
            onProgress?.({ phase, got, total: p.total > 0 ? p.total : bytes, attempt, attempts,
              bytesPerSecond: got / Math.max(1, (Date.now() - started) / 1000) })
          }).catch(() => {}).finally(() => { polling = false })
        }, 300)
      })
      const work = (async () => {
        const auth = await authorize(renew, attemptAbort.signal)
        check(signal)
        if (done) throw downloadCancelled()
        onProgress?.({ phase: 'downloading', got: 0, total: bytes, attempt, attempts, bytesPerSecond: 0 })
        return native.fetchToCacheTracked
          ? native.fetchToCacheTracked(project, file, url, auth, md5, bytes, id)
          : native.fetchToCache(project, file, url, auth, md5, bytes)
      })()
      const result = await Promise.race([work, deadline])
      check(signal)
      return result
    } catch (e) {
      check(signal)
      const code = codeOf(e)
      report?.(`${file}: attempt ${attempt}/${attempts} failed (${code}): ${String(e)}`)
      if (code === 'http401' && !renew) renew = true
      else if (!retryable(code) || attempt === attempts) throw new FileDownloadError(code, String(e))
      if (attempt === attempts) throw new FileDownloadError(code, String(e))
    } finally {
      done = true
      attemptAbort.abort()
      if (timer) clearInterval(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
  throw new FileDownloadError('fetch', 'Download failed')
}
