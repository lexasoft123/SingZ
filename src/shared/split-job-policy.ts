/** Portable split-job rules. Native adapters supply records and OS evidence. */
export class SplitProgressGate {
  private lastStage = ''
  private lastSentAtMs = 0

  shouldSend(stage: string, frac: number, nowMs: number): boolean {
    if (stage === this.lastStage && frac < 1 && nowMs - this.lastSentAtMs <= 250) return false
    this.lastStage = stage
    this.lastSentAtMs = nowMs
    return true
  }
}

export interface SplitProcessExit {
  pid: number
  processName: string
  timestampMs: number
  reason: string
  status: number
  description?: string | null
  pssKb: number
  rssKb: number
}

export interface SplitJobEvidence {
  state: string
  error?: string
  updatedAtMs: number
  processPid?: number
  runStartedAtMs?: number
  stage?: string
  processName?: string
  exitPlatform?: string
  processExits?: SplitProcessExit[]
}

/** Derive a verdict without writing over the native worker's resume record. */
export function recoverSplitJob<T extends SplitJobEvidence>(job: T): T {
  if (job.state !== 'decoding' && job.state !== 'splitting') return job
  // Old documents and adapters without process evidence keep their heartbeat fallback.
  if (!job.processName || (job.processPid ?? 0) <= 0 || (job.runStartedAtMs ?? 0) <= 0) return job
  const since = Math.max(job.runStartedAtMs!, job.updatedAtMs)
  let exit: SplitProcessExit | undefined
  for (const candidate of job.processExits ?? []) {
    if (candidate.pid === job.processPid && candidate.processName === job.processName &&
        candidate.timestampMs >= since && (!exit || candidate.timestampMs > exit.timestampMs)) {
      exit = candidate
    }
  }
  if (!exit) return job
  const detail = exit.description?.trim() ? ` — ${exit.description}` : ''
  const error = `${job.exitPlatform ?? 'The system'} stopped the split during ${job.stage || job.state}: ` +
    `${exit.reason} (status ${exit.status}, PSS ${Math.floor(exit.pssKb / 1024)} MB, ` +
    `RSS ${Math.floor(exit.rssKb / 1024)} MB)${detail}`
  return { ...job, state: 'failed', error }
}
