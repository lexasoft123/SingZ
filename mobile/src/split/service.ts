import { DeviceEventEmitter, NativeModules } from 'react-native'
import { log } from '../log'

/**
 * The production split-job surface (docs/PHONE-STANDALONE.md). Android runs
 * the job in the :split-process foreground service; iOS lands with Phase 3.
 * job.json in the service's dir is the durable truth — events cover the
 * live session, splitStatus() covers a relaunch (the app may have been
 * killed while the split kept going, or the :split process may have died
 * while the app kept playing; both sides re-meet at the file).
 */

export interface SplitProgress {
  /** decode | resample | load-model | split | chunk */
  stage: string
  frac: number
  done: number
  total: number
}

export interface SplitState {
  /** decoding | splitting | done | cancelled | failed | busy */
  state: string
  error?: string
}

export interface SplitJobStatus {
  state: 'decoding' | 'splitting' | 'done' | 'cancelled' | 'failed'
  srcPath: string
  projectDir: string
  srcRate: number
  chunksDone: number
  totalChunks: number
  error?: string
  updatedAtMs: number
  /** Where the finished stems live — the adoption moves them out of here. */
  jobDir: string
}

interface SplitNative {
  startSplit(
    srcPath: string,
    modelPath: string,
    projectDir: string,
    resume: boolean,
    watchdogCapMs: number
  ): Promise<boolean>
  cancelSplit(): Promise<boolean>
  splitStatus(): Promise<SplitJobStatus | null>
  attachSplitEvents(): Promise<boolean>
  clearJob(): Promise<boolean>
}

const native = (): SplitNative => NativeModules.SingzSplit as SplitNative

/**
 * Whether THIS build's native carries the split-job surface. iOS ships only
 * ortProbe until Phase 3 — every entry point below no-ops or answers null
 * there, so the catalog can mount (and hide the offer) instead of dying on
 * a missing method. Named probe, not key enumeration: the bridgeless
 * interop proxy materializes methods lazily.
 */
export function splitAvailable(): boolean {
  const m = NativeModules.SingzSplit as Record<string, unknown> | undefined
  return typeof m?.startSplit === 'function'
}

export async function startSplit(opts: {
  srcPath: string
  modelPath: string
  projectDir: string
  resume?: boolean
  /** Test seam: shrink the watchdog's first-chunk cap. 0 = the real 5 min. */
  watchdogCapMs?: number
}): Promise<void> {
  if (!splitAvailable()) throw new Error('Splitting is not on this phone yet')
  log('split', `start ${opts.resume ? 'resume' : 'fresh'} ${opts.srcPath}`)
  await native().startSplit(
    opts.srcPath,
    opts.modelPath,
    opts.projectDir,
    !!opts.resume,
    opts.watchdogCapMs ?? 0
  )
}

export async function cancelSplit(): Promise<void> {
  if (!splitAvailable()) return
  log('split', 'cancel requested')
  await native().cancelSplit()
}

/** The job record, or null when there is none (or no split surface yet). */
export function splitStatus(): Promise<SplitJobStatus | null> {
  if (!splitAvailable()) return Promise.resolve(null)
  return native().splitStatus()
}

/** Discard the job dir. Cancel first when the job is live. */
export async function clearSplitJob(): Promise<void> {
  if (!splitAvailable()) return
  log('split', 'job discarded')
  await native().clearJob()
}

/**
 * Follow a live job. Terminal states go through the persisted log — on a
 * release build that line is the only evidence of how a split ended.
 */
export function subscribeSplit(
  onProgress: (p: SplitProgress) => void,
  onState: (s: SplitState) => void
): () => void {
  if (!splitAvailable()) return () => {}
  const prog = DeviceEventEmitter.addListener('singzSplitProgress', (v) =>
    onProgress(v as SplitProgress)
  )
  const state = DeviceEventEmitter.addListener('singzSplitState', (v) => {
    const s = v as SplitState
    log('split', `state ${s.state}${s.error ? ` — ${s.error}` : ''}`)
    onState(s)
  })
  void native().attachSplitEvents()
  return () => {
    prog.remove()
    state.remove()
  }
}
