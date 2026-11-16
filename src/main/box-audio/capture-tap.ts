import type { BoxAudioClient } from './client'
import { chmod, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { captureTapRequest, type BoxCaptureTapResult } from '../../shared/box-audio-diagnostics'
export interface NativeDiagnosticCapture {
  boxCaptureTapStart(json: string): string
  boxCaptureTapStatus(): string
  boxAudioDiagnostics(): string
}
/** Paths are host-generated in a private data directory; renderer/RPC input
 * cannot choose a destination. Native writes exclusive float WAVs off RT. */
export class BoxCaptureTap {
  private receipts = new Map<string, BoxCaptureTapResult>()
  private starting = false
  constructor(private readonly dataDir: string, private readonly native: () => NativeDiagnosticCapture) {}
  status(id: string): BoxCaptureTapResult {
    const current = JSON.parse(this.native().boxCaptureTapStatus()) as BoxCaptureTapResult
    if (current.complete) {
      this.receipts.set(current.id, current)
      while (this.receipts.size > 16) this.receipts.delete(this.receipts.keys().next().value!)
    }
    const result = current.id === id ? current : this.receipts.get(id)
    if (!result) throw new Error('Diagnostic capture receipt is unavailable')
    return result
  }
  async start(value: unknown): Promise<BoxCaptureTapResult> {
    const request = captureTapRequest(value)
    if (this.starting) throw new Error('Diagnostic capture is already starting')
    this.starting = true
    let directory: string | undefined
    try {
      const native = this.native()
      const previous = JSON.parse(native.boxCaptureTapStatus()) as BoxCaptureTapResult
      if (previous.active) throw new Error('A diagnostic capture is already active')
      if (previous.complete) this.status(previous.id)
      const root = join(this.dataDir, 'audio-diagnostics')
      await mkdir(root, { recursive: true, mode: 0o700 })
      const stat = await lstat(root)
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        throw new Error('Diagnostic directory must be private and owned by this user')
      directory = await mkdtemp(join(root, 'capture-'))
      await chmod(directory, 0o700)
      return JSON.parse(native.boxCaptureTapStart(JSON.stringify({ ...request, directory }))) as BoxCaptureTapResult
    } catch (error) {
      if (directory) await rm(directory, { recursive: true, force: true })
      throw error
    } finally { this.starting = false }
  }
}

/** Start once and fence every observation by the host epoch as well as its
 * process-local capture id. A restarted host may reuse an id. */
export async function recordBoxCaptureTap(client: Pick<BoxAudioClient, 'callStamped'>, value: unknown): Promise<BoxCaptureTapResult> {
  const request = captureTapRequest(value)
  const started = await client.callStamped<BoxCaptureTapResult>('service', 'captureTap', [request])
  let result = started.value
  const id = result.id
  const deadline = performance.now() + (request.seconds + 7) * 1000
  while (result.active && performance.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    const observed = await client.callStamped<BoxCaptureTapResult>('service', 'captureTapStatus', [id])
    if (observed.epoch !== started.epoch || observed.value.id !== id) throw new Error('Diagnostic capture host or identity changed')
    result = observed.value
  }
  if (!result.complete || !result.ok) throw new Error(result.error || 'Diagnostic capture did not complete')
  return result
}
