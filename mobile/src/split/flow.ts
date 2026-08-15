import { PermissionsAndroid, Platform } from 'react-native'
import { getStoredText, setStoredText } from '../latency'
import { appInfo, log } from '../log'
import type { ProjectDoc } from '../model'
import { localProjectFile, readProjectText } from '../projects'
import { ensureSplitModel, splitCapability } from '../analysis/models'
import { splitVitals, startSplit } from './service'
import { adoptSplit } from './adopt'

/**
 * The split flow around the :split service, shared by the catalog card and
 * the headless test driver: capability gate, model fetch, kick-off, and the
 * adoption of a finished job. State lives in job.json (the service's) and
 * one attempts counter here — the UI is a viewer.
 */

/** Can this phone split? Honest copy when it cannot. */
export async function splitGate(force = false): Promise<{ ok: true } | { ok: false; reason: string }> {
  const info = await appInfo()
  return splitCapability(info?.totalMemMB, force)
}

/**
 * Android 13+ denies POST_NOTIFICATIONS until it is asked for, and the
 * manifest entry alone does nothing. A foreground service whose notification
 * is suppressed is a split that VANISHES the moment the singer leaves the
 * app: no progress anywhere, and the Cancel action unreachable, while the
 * work carries on invisibly. (Measured on a clean 0.16.0 install: granted=
 * false, importance=NONE, nothing in the shade during an active split.)
 *
 * Asked here, at the tap, where the reason is self-evident — never at launch.
 * The answer is NOT a gate: someone who says no still gets their stems, they
 * just only see progress on this screen.
 */
async function askToShowProgress(): Promise<void> {
  if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return
  const perm = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
  try {
    if (await PermissionsAndroid.check(perm)) return
    const res = await PermissionsAndroid.request(perm)
    log(
      'split',
      res === PermissionsAndroid.RESULTS.GRANTED
        ? 'notifications allowed — progress shows while you are in other apps'
        : 'notifications declined — splitting still runs, but only this screen shows it'
    )
  } catch (e) {
    // Never let the permission plumbing cost someone their split.
    log('split', `could not ask about notifications — ${String(e instanceof Error ? e.message : e)}`, 'warn')
  }
}

/**
 * Gate passed: resolve the song file, make sure the model is here (136 MB,
 * once), and hand the job to the service. Resolves when the service has the
 * job — progress from here on arrives over subscribeSplit/splitStatus.
 */
export async function startProjectSplit(
  project: string,
  opts?: {
    resume?: boolean
    onModelProgress?: (gotBytes: number, totalBytes: number) => void
    watchdogCapMs?: number
  }
): Promise<void> {
  // Ahead of the model fetch so the dialog lands on the tap that caused it,
  // rather than interrupting a 136 MB download minutes later.
  await askToShowProgress()
  const doc = JSON.parse(await readProjectText(project, 'project.json')) as ProjectDoc
  const srcPath = await localProjectFile(project, doc.songFile)
  const modelPath = await ensureSplitModel(opts?.onModelProgress)
  // The budget this phone is working inside, recorded before a single sample
  // is decoded: a split that is killed leaves no note, so its allowance has to
  // be in the log already.
  const vitals = await splitVitals()
  if (vitals) {
    log(
      'split',
      `this phone allows ${Math.round(vitals.freeMb)} MB more for SingZ · using ${Math.round(vitals.memMb)} MB now`
    )
  }
  await startSplit({
    srcPath,
    modelPath,
    projectDir: project,
    resume: opts?.resume,
    watchdogCapMs: opts?.watchdogCapMs
  })
}

/** A DONE job's stems become the project's; the job dir goes away. */
export async function finishSplit(project: string, jobDir: string): Promise<void> {
  await adoptSplit(project, jobDir)
  clearFailures()
}

// --- the two-dead-resumes rule -------------------------------------------
// A song that keeps dying gets the same honest copy as a gated phone. The
// counter is per source path, persisted so a relaunch cannot reset it.

const ATTEMPTS_KEY = 'singz.split.attempts'

interface Attempts {
  src: string
  n: number
  /** job.json's updatedAtMs when last counted — one failure counts once,
   *  however many times the card re-renders or the app relaunches into it. */
  lastMs: number
}

async function readAttempts(): Promise<Attempts | null> {
  try {
    const raw = await getStoredText(ATTEMPTS_KEY)
    return raw ? (JSON.parse(raw) as Attempts) : null
  } catch {
    return null
  }
}

export async function failureCount(srcPath: string): Promise<number> {
  const v = await readAttempts()
  return v && v.src === srcPath ? v.n : 0
}

export async function recordFailure(srcPath: string, atMs: number): Promise<number> {
  const prev = await readAttempts()
  if (prev && prev.src === srcPath && prev.lastMs === atMs) return prev.n
  const n = (prev && prev.src === srcPath ? prev.n : 0) + 1
  try {
    await setStoredText(ATTEMPTS_KEY, JSON.stringify({ src: srcPath, n, lastMs: atMs }))
  } catch {
    // an uncounted failure only softens copy, never blocks
  }
  log('split', `failure ${n} for ${srcPath}`)
  return n
}

export function clearFailures(): void {
  void setStoredText(ATTEMPTS_KEY, '')
}

export const KEEPS_FAILING_COPY =
  'This song keeps failing on this phone. Add it on your computer instead — it will sync over ready to sing.'
