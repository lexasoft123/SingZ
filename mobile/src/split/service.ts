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
  /** What the phone is spending, sampled natively with each event: memory
   *  footprint, the headroom left before the OS kills this process, and CPU
   *  (100% = one core). Absent on platforms that do not sample yet. */
  memMb?: number
  freeMb?: number
  cpuPct?: number
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
  splitVitals?(): Promise<{ memMb: number; freeMb: number; cpuPct: number }>
  takeSplitTrail?(): Promise<string | null>
  attachSplitEvents(): Promise<boolean>
  clearJob(): Promise<boolean>
}

const native = (): SplitNative => NativeModules.SingzSplit as SplitNative

/**
 * Whether THIS build's native carries the split-job surface. Both platforms
 * do since Phase 3; a build that does not (an older app, a platform yet to
 * land) makes every entry point below no-op or answer null, so the catalog
 * mounts and hides the offer instead of dying on a missing method. Named
 * probe, not key enumeration: the bridgeless interop proxy materializes
 * methods lazily.
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

/**
 * What this process is spending, and what the OS still allows it. `freeMb` is
 * the allowance left before the app is killed outright — on iOS the split's
 * peak lands near that ceiling, and a kill is silent, so the number is worth
 * writing down BEFORE the work starts as well as during it.
 */
export async function splitVitals(): Promise<{
  memMb: number
  freeMb: number
  cpuPct: number
} | null> {
  if (!splitAvailable()) return null
  const probe = native().splitVitals
  if (typeof probe !== 'function') return null
  return probe.call(native()).catch(() => null)
}

/**
 * Replay what the last job wrote to disk, then forget it. The app log persists
 * on a debounce, so a process the system kills loses precisely the lines that
 * explain the kill — this trail is written natively and flushed per line, and
 * survives. Called once at launch: on a normal run it is empty.
 */
export async function replaySplitTrail(): Promise<void> {
  if (!splitAvailable()) return
  const take = native().takeSplitTrail
  if (typeof take !== 'function') return
  const trail = await take.call(native()).catch(() => null)
  if (!trail) return
  const lines = trail.split('\n').filter((l) => l.trim().length > 0)
  log('split', `--- the last split left ${lines.length} lines behind ---`, 'warn')
  for (const line of lines) log('split', line)
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
  // Every stage change is written down, and the running stages are sampled
  // every 15 s: a split killed by the OS leaves NOTHING behind except what
  // the log already holds, so the last line before the gap has to carry the
  // memory headroom that explains the kill (a real iPhone died five seconds
  // into every split with no other evidence anywhere).
  // Per-JOB, not per-subscription: CatalogScreen subscribes once for the
  // screen's life, so leaving these latched would give only the session's
  // FIRST split the dense decode/load-model window — and the second song a
  // 15 s gap exactly where the first one died.
  let lastStage = ''
  let lastVitalsAt = 0
  let chunksStarted = false
  const prog = DeviceEventEmitter.addListener('singzSplitProgress', (v) => {
    const p = v as SplitProgress
    const now = Date.now()
    if (p.stage === 'chunk') chunksStarted = true
    // decode/resample/load-model only ever lead a JOB, so their arrival means
    // a new one started and the dense window reopens. 'split' is NOT one of
    // them: the engine reports it immediately before every 'chunk', so
    // treating it as a job-leading stage cleared the flag on every chunk and
    // defeated both the suppression below and the 15 s pacing — 104 log lines
    // for a 52-chunk song instead of ~22.
    else if (p.stage !== 'alive' && p.stage !== 'split') chunksStarted = false
    // 'alive' is the runner's 2 s pulse, not a step. Before the first chunk it
    // is logged every time — decode and model load are where the phone died,
    // with three seconds of silence around it — and after that the ordinary
    // 15 s pacing takes over so a long split does not fill the log with it.
    const isPulse = p.stage === 'alive'
    // 'split' and 'chunk' arrive as a pair for every chunk and carry the same
    // news; the chunk count is the readable half, so the percentage is
    // dropped rather than burning two of the phone's 400 log lines per chunk.
    if (p.stage === 'split' && chunksStarted) {
      onProgress(p)
      return
    }
    const stageChanged = !isPulse && p.stage !== lastStage
    if (stageChanged || (isPulse && !chunksStarted) || now - lastVitalsAt > 15_000) {
      if (!isPulse) lastStage = p.stage
      lastVitalsAt = now
      const where =
        p.stage === 'chunk' && p.total > 0
          ? `chunk ${p.done}/${p.total}`
          : isPulse
            ? `still ${lastStage || 'working'}`
            : `${p.stage} ${Math.round(p.frac * 100)}%`
      const vitals =
        p.memMb !== undefined
          ? ` · ${Math.round(p.memMb)} MB used, ${Math.round(p.freeMb ?? 0)} MB before the limit · cpu ${Math.round(p.cpuPct ?? 0)}%`
          : ''
      log('split', `${where}${vitals}`)
    }
    onProgress(p)
  })
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
