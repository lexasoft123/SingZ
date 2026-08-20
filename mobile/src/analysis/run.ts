/**
 * The app-level analysis runner: one queue, one job at a time, results
 * announced. Two things make it more than a call to analyzeProject —
 *
 *  - The host has ONE stem store, so two projects analysed at once would read
 *    each other's stems. Every request goes through a single queue; a request
 *    for a project already queued or running is the same request.
 *  - The result must reach whatever is on screen: the catalog card that was
 *    waiting on it, and the PLAYER, if the singer opened the song while the
 *    detectors ran — that is how a fresh grid lights the metronome up without
 *    a reopen. Both hear it through the same event; the player checks the dir
 *    is its own before touching state (the wrong-song rule).
 *
 * A failure is logged and dropped: the project is playable without analyses,
 * and the next open asks again.
 */
import { DeviceEventEmitter } from 'react-native'
import { log } from '../log'
import type { BeatInfo, KeyInfo, LyricLine, MelodyInfo } from '../model'
import { realAnalysisDeps } from './deps'
import { analyzeProject } from './pipeline'

export const ANALYSIS_EVENT = 'singzAnalysis'

/** What a listener hears when a project's analysis lands (or ends empty). */
export interface AnalysisDone {
  dir: string
  beat?: BeatInfo
  key?: KeyInfo
  melody?: MelodyInfo
  /** False when nothing was needed or the run failed — listeners keep what they have. */
  changed: boolean
  /** True while the job is still running — the grid landed, the melody has
   *  not; a final event follows. */
  partial?: boolean
}

export interface AnalysisProgress {
  dir: string
  text: string
  frac: number
}

type Listener = (p: AnalysisProgress | null) => void
const progressListeners = new Set<Listener>()
let current: AnalysisProgress | null = null

/** The running job's progress, live; null between jobs. */
export function subscribeAnalysis(cb: Listener): () => void {
  progressListeners.add(cb)
  cb(current)
  return () => {
    progressListeners.delete(cb)
  }
}

export const analysisProgress = (): AnalysisProgress | null => current

const setProgress = (p: AnalysisProgress | null): void => {
  current = p
  for (const l of progressListeners) l(p)
}

interface Job {
  dir: string
  stems: Record<string, string>
  lyrics: { lines: LyricLine[] } | null
  /** Asked for by hand rather than by a stale stamp. */
  force?: boolean
}

const queue: Job[] = []
let running: Job | null = null

/** Is this project queued or under the detectors right now? */
export const analysisPending = (dir: string): boolean =>
  running?.dir === dir || queue.some((j) => j.dir === dir)

/**
 * Ask for a project's analyses. Returns at once; the answer arrives as an
 * ANALYSIS_EVENT and, meanwhile, as progress. Duplicate asks collapse.
 */
export function startAnalysis(
  dir: string,
  stems: Record<string, string>,
  lyrics: { lines: LyricLine[] } | null,
  /** The singer pressed "detect again": ignore every stamp and verdict and
   *  run whatever the stems allow. Still single-flight — a forced run while
   *  one is already going for this project is the same answer arriving, not
   *  a reason to do it twice. */
  force = false
): void {
  if (analysisPending(dir)) return
  queue.push({ dir, stems, lyrics, force })
  void pump()
}

async function pump(): Promise<void> {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = job
  const { dir } = job
  try {
    setProgress({ dir, text: 'Getting ready…', frac: 0 })
    // What the partial events already delivered — the final event must not
    // carry it again: the player would set the same grid twice, and
    // engine.setBeats restarts a count-in that is running (a re-armed click
    // schedule is harmless mid-song; a count-in replayed from the top is
    // not). `changed` means a WRITE landed, negatives included — the
    // catalog re-lists on it, or the next tap would run again off a stale
    // entry.doc.
    const announced = { beat: false, key: false, melody: false }
    const res = await analyzeProject(dir, job.stems, {
      lyrics: job.lyrics,
      force: job.force === true,
      onStep: (text, frac) => setProgress({ dir, text, frac }),
      // The grid is on disk a minute before the melody: tell the player now,
      // so the metronome lights up when the beat is found, not when pYIN is
      // done with the vocals.
      onCommit: (fresh) => {
        announced.beat ||= !!fresh.beat
        announced.key ||= !!fresh.key
        announced.melody ||= !!fresh.melody
        DeviceEventEmitter.emit(ANALYSIS_EVENT, {
          dir,
          beat: fresh.beat,
          key: fresh.key,
          melody: fresh.melody,
          changed: !!(fresh.beat || fresh.key || fresh.melody || fresh.none),
          partial: true
        } satisfies AnalysisDone)
      },
      deps: realAnalysisDeps()
    })
    DeviceEventEmitter.emit(ANALYSIS_EVENT, {
      dir,
      beat: announced.beat ? undefined : res?.beat,
      key: announced.key ? undefined : res?.key,
      melody: announced.melody ? undefined : res?.melody,
      changed: !!(res?.beat || res?.key || res?.melody || res?.none)
    } satisfies AnalysisDone)
  } catch (e) {
    log('analysis', `${dir}: analysis failed — ${String(e instanceof Error ? e.message : e)}`, 'warn')
    DeviceEventEmitter.emit(ANALYSIS_EVENT, { dir, changed: false } satisfies AnalysisDone)
  } finally {
    running = null
    setProgress(null)
    void pump()
  }
}
