/**
 * Analysis of a phone-library project: the beat grid, the key and the melody
 * line, detected by the desktop's own code on the analysis host and written
 * into the project's project.json — the phone's half of what the desktop does
 * on every open. Nothing here is UI: the caller decides when to run it and
 * what to do with the answer on screen.
 *
 * The desktop's rules, ported rather than approximated:
 *
 *  - WHAT to (re)detect is decided from the stored doc exactly as App.tsx
 *    decides it: a grid is detected when there is none, or when it is an
 *    'auto' grid stamped by an older detector — a hand-made ('manual') grid
 *    is never touched, and hand-placed bar lines (`userBars`) are re-folded
 *    onto a fresh grid with the desktop's applyUserBars so a corrected song
 *    keeps its corrections. A melody is re-tracked when its stamp is old or
 *    when its length says it belongs to another song (`melodyFitsSong`). A
 *    key is re-read under a new stamp; the melody-histogram fallback is
 *    never STORED under the stems detector's stamp. A detector's NEGATIVE
 *    answer (no grid in these drums, a silent harmonic bed) is stored too,
 *    under its stamp (`settings.analysisNone`, phone-only, ignored by every
 *    reader) — otherwise a drumless song would be re-decoded and re-tracked
 *    on every open, forever; a newer detector asks once more.
 *  - Results land by re-read → merge → write of the doc ON DISK: another
 *    writer (a save, a lyrics retry, an adoption) may have moved it while the
 *    detectors ran, and only the analysis fields are ours to touch. Absent
 *    results never delete existing ones.
 *  - A late answer must not land in the wrong song. The write goes to the
 *    project the analysis was STARTED for (the dir is fixed by argument), but
 *    the stems it read are re-checked against the doc on disk first: a
 *    project re-split or replaced meanwhile has different stemHashes, and
 *    the answer is dropped rather than written over a song it was not
 *    computed from. Which song is on SCREEN is the caller's jobSeq business.
 *  - Order is beats → key → melody, and the doc is written after beats+key
 *    and again after melody: the grid is what the phone itself plays
 *    (metronome, count-in) and it is cheap; the melody is a minute of pYIN,
 *    and a process killed in that minute still leaves the useful half saved.
 *
 * Memory: the grid's and the key's stems reach the worklet host one at a
 * time as mono float32 and the local copy is dropped as each lands (host.ts
 * explains the crossing); every stem is loaded through `loadMono`, which
 * decodes at 44.1 kHz — the detectors' own rate, so the far side resamples
 * nothing and copies nothing. The melody crosses NOTHING: the core's own
 * tracker (native/core/melody.cpp — the desktop's pyin, bit-identical) reads
 * the stem file itself, on a native thread, in about a second.
 */
import {
  BEAT_DETECT_VERSION,
  KEY_DETECT_VERSION,
  PITCH_DETECT_VERSION,
  decodeMelody,
  melodyFitsSong
} from '../gen/analysis-lib'
import type { MlGrid, StoredBeatInfo } from '../gen/analysis-lib'
import type { BeatInfo, KeyInfo, LyricLine, MelodyInfo, ProjectDoc } from '../model'
import { log } from '../log'
import type { MonoStem } from './host'

/** What one project needs, judged from its doc alone. */
export interface AnalysisPlan {
  beat: boolean
  key: boolean
  melody: boolean
}

export interface AnalysisResult {
  beat?: BeatInfo
  key?: KeyInfo
  melody?: MelodyInfo
  /** Detectors that answered "nothing here" this run, by stamp — a write too. */
  none?: { beat?: number; beatMl?: boolean; key?: number }
  /** Where the time went, ms — for the log. */
  ms: { load: number; ml: number; beat: number; key: number; melody: number }
}

/** The host surface the pipeline drives — host.ts in the app, a fake in jest. */
export interface AnalysisHost {
  putStem(id: string, stem: MonoStem): Promise<void>
  clearStems(): Promise<void>
  detectBeats(args: {
    drums: string
    bass?: string
    vocals?: string
    inst?: string[]
    lineStarts?: number[] | null
    words?: { s: number; e: number }[] | null
    ml?: MlGrid | null
  }): Promise<{
    beats: number[]
    bpm: number
    beatsPerBar: number
    downbeat: number
    downbeats?: number[]
    suspectAt?: number[]
  } | null>
  /** Can the neural beat lattice run at all — the from-stems binding in the
   *  installed native AND both models on this phone? A stat, never a
   *  download; the planner asks it to decide whether an old "no grid here"
   *  verdict should be re-asked now that better ears are available. */
  mlAvailable(): Promise<boolean>
  /** The lattice off the project's stems ON DISK (the core sums and
   *  decimates them itself — the desktop's fetchMlGrid mix, natively).
   *  Null is a legitimate answer, never a failure: models absent, stems the
   *  core cannot read (FLAC), or a failed run — the grid then comes from
   *  the homegrown path alone, exactly like a packless desktop. */
  mlGrid(project: string, stemRels: string[]): Promise<MlGrid | null>
  /** The key off the harmonic stems ON DISK — the core reads them itself
   *  (analysis.cpp), so nothing crosses a runtime for this one either. */
  estimateKeyFromStems(
    project: string,
    instRel: string[],
    bassRel?: string
  ): Promise<{ pc: number; minor: boolean } | null>
  /** The melody line of a stem ON DISK — the core's tracker (melody.cpp)
   *  reads the file itself; nothing crosses a runtime for this one. */
  trackMelody(
    project: string,
    relPath: string,
    onProgress?: (p: number) => void
  ): Promise<{ f0: Float32Array; hopSec: number; durationSec: number }>
  /** A stem's length in seconds, off its header — no decode. */
  audioDuration(project: string, relPath: string): Promise<number>
  encodeMelody(f0: Float32Array, hopSec: number): Promise<MelodyInfo>
  applyUserBars(info: StoredBeatInfo): Promise<StoredBeatInfo>
}

export interface AnalysisDeps {
  readText(project: string, file: string): Promise<string>
  writeText(project: string, file: string, text: string): Promise<boolean>
  /** One stem as mono float32 at 44.1 kHz; the implementation decodes,
   *  folds channels and frees the decoded buffer before returning. */
  loadMono(project: string, relPath: string): Promise<MonoStem>
  host: AnalysisHost
  now(): string
}

/** Stem ids that form the harmonic bed for the key and the beat aux (App.tsx:660). */
const INST = ['guitar', 'piano', 'other'] as const

/**
 * The desktop's re-analysis triggers, read off the stored doc. `stems` is
 * what the folder actually holds (id → format), because a detector without
 * its stem is not stale, it is impossible: no drums, no grid — as on the
 * desktop, which detects nothing pre-split.
 */
export function planAnalysis(
  doc: ProjectDoc,
  stems: Record<string, string>,
  durationSec: number | null,
  /** Could the neural lattice run on THIS project right now (models here,
   *  binding here, stems the core reads)? Decides only whether an old
   *  negative verdict still binds — see below. */
  mlNow = false
): AnalysisPlan {
  const s = doc.settings ?? ({} as ProjectDoc['settings'])
  const none = s.analysisNone ?? {}
  const beatStored = s.beat
  const beatStale = !!beatStored && beatStored.source === 'auto' && beatStored.detVersion !== BEAT_DETECT_VERSION
  // A negative verdict from THIS detector counts as an answer — a drumless
  // song is not asked again on every open; a newer detector asks once more.
  // The verdict carries a SUB-STAMP, beatMl: whether the neural lattice was
  // heard when "no grid" was decided. BEAT_DETECT_VERSION alone cannot say —
  // the desktop ships ml and no-ml grids under the same detVersion (a
  // packless desktop's grid is legitimate) — so when the beat models arrive
  // on a phone AFTER a song was declared gridless, the version matches, the
  // verdict predates the evidence, and without this line it would bind
  // forever. Re-ask exactly once, with the better ears.
  const noneBeatBinds = none.beat === BEAT_DETECT_VERSION && (none.beatMl === true || !mlNow)
  const beat = !!stems.drums && (!beatStored || beatStale) && !noneBeatBinds

  const keyStored = s.key
  const key =
    (INST.some((id) => stems[id]) || !!stems.bass) &&
    (!keyStored || keyStored.detVersion !== KEY_DETECT_VERSION) &&
    none.key !== KEY_DETECT_VERSION

  let melody = false
  if (stems.vocals) {
    const m = s.melody
    if (!m || m.detVersion !== PITCH_DETECT_VERSION) melody = true
    else if (durationSec != null) {
      // A stored line whose coverage is another song's length is disowned
      // and re-tracked — the rule that healed the two field projects that
      // caught a neighbour's line.
      const dec = decodeMelody(m)
      melody = !dec || !melodyFitsSong(dec.f0, dec.info.hopSec, durationSec)
    }
  }
  return { beat, key, melody }
}

/**
 * Merge freshly detected analyses into the doc ON DISK. Only the analysis
 * fields move; everything else is whatever the disk says now. Absent results
 * leave the stored field alone (the desktop's keep-rule).
 */
export interface FreshAnalysis {
  beat?: BeatInfo
  key?: KeyInfo
  melody?: MelodyInfo
  /** Detectors that answered "nothing here" this run, by stamp. `beatMl`
   *  is the beat verdict's sub-stamp: true when the neural lattice was
   *  heard on the way to "no grid". */
  none?: { beat?: number; beatMl?: boolean; key?: number }
}

export function mergeAnalysis(onDisk: ProjectDoc, fresh: FreshAnalysis, now: string): ProjectDoc {
  // A positive answer retires the negative verdict for that detector; a
  // negative one is recorded under its stamp. Untouched detectors keep
  // whatever the disk says.
  const prevNone = onDisk.settings?.analysisNone ?? {}
  const none: { beat?: number; beatMl?: boolean; key?: number } = { ...prevNone, ...(fresh.none ?? {}) }
  // The beat verdict moves as a UNIT: a fresh "no grid" replaces the old
  // sub-stamp too, so a verdict reached without the models cannot keep
  // wearing an older run's beatMl.
  if (fresh.none?.beat !== undefined && fresh.none.beatMl === undefined) delete none.beatMl
  if (fresh.beat) {
    delete none.beat
    delete none.beatMl
  }
  if (fresh.key) delete none.key
  const hasNone = none.beat !== undefined || none.key !== undefined
  return {
    ...onDisk,
    savedAt: now,
    settings: {
      ...onDisk.settings,
      ...(fresh.beat ? { beat: fresh.beat } : {}),
      ...(fresh.key ? { key: fresh.key } : {}),
      ...(fresh.melody ? { melody: fresh.melody } : {}),
      ...(hasNone ? { analysisNone: none } : { analysisNone: undefined })
    }
  }
}

/** The stems a re-detection was computed from, as the doc names them. */
const hashesOf = (doc: ProjectDoc, files: string[]): string =>
  files.map((f) => `${f}:${doc.stemHashes?.[f]?.md5 ?? '?'}:${doc.stemHashes?.[f]?.size ?? '?'}`).join('|')

/**
 * Detect what the project lacks and write it into its project.json. Returns
 * what was detected (for the caller to apply on screen when the song is still
 * the one open) — or null when nothing was needed. Throws on a doc that
 * cannot be read or a host that fails; a project whose stems changed under
 * the run drops its answer silently (logged) rather than writing it.
 */
export async function analyzeProject(
  project: string,
  stems: Record<string, string>,
  opts: {
    lyrics?: { lines: LyricLine[] } | null
    onStep?: (msg: string, frac: number) => void
    /** Called after each write lands — the grid is on disk a minute before
     *  the melody is, and a player showing the song should not wait. */
    onCommit?: (fresh: FreshAnalysis) => void
    deps: AnalysisDeps
  }
): Promise<AnalysisResult | null> {
  const { deps } = opts
  const step = opts.onStep ?? (() => {})
  const doc0 = JSON.parse(await deps.readText(project, 'project.json')) as ProjectDoc
  const rel = (id: string) => `stems/${id}.${stems[id]}`

  // The vocals' length is the song's length for the melody-fit rule — read
  // off the file's header, no decode.
  const t0 = Date.now()
  const host = deps.host
  let durationSec: number | null = null
  if (stems.vocals) {
    try {
      durationSec = await host.audioDuration(project, rel('vocals'))
    } catch {
      durationSec = null // an unreadable stem: the plan judges by stamps alone
    }
  }
  // Could the lattice run HERE? Models + binding + every mix stem readable
  // by the core (WAV — the split's own output; a copied desktop project's
  // FLAC simply has no phone-ml, like a packless desktop). Decided before
  // planning, because an old "no grid" verdict binds or not by this.
  const mixIds = ['drums', 'bass', 'vocals', ...INST].filter((id) => stems[id])
  const mlNow =
    mixIds.length > 0 && mixIds.every((id) => /\.wav$/i.test(rel(id))) && (await host.mlAvailable())
  const plan = planAnalysis(doc0, stems, durationSec, mlNow)
  if (!plan.beat && !plan.key && !plan.melody) {
    log('analysis', `${project}: nothing to detect — grid, key and melody are current`)
    return null
  }
  log(
    'analysis',
    `${project}: detecting ${[plan.beat && 'beat', plan.key && 'key', plan.melody && 'melody']
      .filter(Boolean)
      .join(', ')} · stems ${Object.keys(stems).join(',')}`
  )
  const usedFiles = new Set<string>()
  const ms = { load: 0, ml: 0, beat: 0, key: 0, melody: 0 }
  const put = async (id: string): Promise<boolean> => {
    if (!stems[id]) return false
    const stem = await deps.loadMono(project, rel(id))
    await host.putStem(id, stem)
    usedFiles.add(`${id}.${stems[id]}`)
    return true
  }
  try {
    // The neural lattice FIRST, and off the worklet host entirely: the core
    // reads, sums and decimates the stems itself, so running it before put()
    // keeps the two memory peaks apart — the ORT session's ~700 MB (measured,
    // docs/PHONE-STANDALONE.md) and the worklet's six decoded stems never
    // coexist. Null is the packless-desktop answer, not a failure; the mix's
    // files join the stamp because the grid that comes out depends on them.
    let ml: MlGrid | null = null
    if (plan.beat && mlNow) {
      step('Listening for the beat…', 0.01)
      const t = Date.now()
      ml = await host.mlGrid(project, mixIds.map(rel))
      ms.ml = Date.now() - t
      if (ml) for (const id of mixIds) usedFiles.add(`${id}.${stems[id]}`)
    }
    const tLoad = Date.now() // `load` is the stems crossing, not the lattice — reported apart

    // The grid's stems, one at a time. The vocals cross only as its aux; the
    // melody and the key read their own files.
    const wantAudio = plan.beat
    const have = { drums: false, bass: false, vocals: false, inst: [] as string[] }
    if (plan.beat && stems.vocals) {
      step('Reading the vocals…', 0.02)
      have.vocals = await put('vocals')
    }
    // The key reads its own files now (the core); only the grid's aux still
    // crosses to the worklet runtime. Its stems therefore never pass through
    // put(), so they must be added to the stamp BY HAND — without this a
    // key-only run (a stale key stamp over a current grid) compares an empty
    // file list against an empty file list, which can never fail, and a key
    // computed from stems that were replaced mid-run is written into the doc
    // that now names different ones. The melody has the same shape at its
    // own stage; the guard is only as good as what it is told to watch.
    const keyInst = INST.filter((id) => stems[id])
    if (plan.key) {
      for (const id of keyInst) usedFiles.add(`${id}.${stems[id]}`)
      if (stems.bass) usedFiles.add(`bass.${stems.bass}`)
    }
    if (wantAudio) {
      let i = 0
      const load = plan.beat ? ['drums', 'bass', ...INST].filter((id) => stems[id]) : []
      for (const id of load) {
        step(`Reading the ${id}…`, 0.05 + (0.2 * i++) / Math.max(1, load.length))
        const ok = await put(id)
        if (!ok) continue
        if (id === 'drums') have.drums = true
        else if (id === 'bass') have.bass = true
        else have.inst.push(id)
      }
    }
    ms.load = Date.now() - tLoad
    // The stems this answer is computed from — compared against the doc on
    // disk before every write.
    const used = [...usedFiles]
    const stampAtStart = hashesOf(doc0, used)

    const fresh: FreshAnalysis = {}

    if (plan.beat && have.drums) {
      step('Finding the beat…', 0.3)
      const t = Date.now()
      const lines = opts.lyrics?.lines ?? null
      const det = await host.detectBeats({
        drums: 'drums',
        bass: have.bass ? 'bass' : undefined,
        vocals: have.vocals ? 'vocals' : undefined,
        inst: have.inst,
        lineStarts: lines ? lines.map((l) => l.words[0]?.s ?? l.start) : null,
        words: lines ? lines.flatMap((l) => l.words.map((w) => ({ s: w.s, e: w.e }))) : null,
        ml
      })
      ms.beat = Date.now() - t
      if (det) {
        const prev = doc0.settings?.beat
        const auto = det.downbeats ?? undefined
        const grid: StoredBeatInfo = {
          beats: det.beats,
          bpm: det.bpm,
          beatsPerBar: det.beatsPerBar,
          downbeat: det.downbeat,
          ...(auto ? { downbeats: auto, autoDownbeats: auto } : {}),
          ...(det.suspectAt ? { suspectAt: det.suspectAt } : {}),
          ...(prev?.userBars ? { userBars: prev.userBars } : {}),
          source: 'auto',
          detVersion: BEAT_DETECT_VERSION
        }
        // Hand-placed bar lines re-folded onto the fresh grid — the desktop's
        // own fold, so a corrected song keeps receiving detector work.
        fresh.beat = (prev?.userBars?.length ? await host.applyUserBars(grid) : grid) as BeatInfo
      } else {
        // No grid in these drums (the desktop's own verdict for a drumless or
        // rubato song) — written down under the stamp, or every open would
        // decode six stems to hear the same silence. beatMl records whether
        // the lattice was HEARD on the way to this verdict: models arriving
        // later make a no-ml verdict worth asking once more (planAnalysis),
        // and an attempted-but-failed run stays un-stamped for the same
        // reason a missing model does — no evidence was heard.
        fresh.none = { ...fresh.none, beat: BEAT_DETECT_VERSION, ...(ml ? { beatMl: true } : {}) }
      }
    }

    // The grid is done with the far side: give the memory back before the key
    // and the melody, both of which may fall back to putting stems there
    // themselves (a FLAC project, or JS newer than the installed binary) —
    // and the melody stage often overlaps a player holding the same song
    // decoded for playback. The finally clears again, harmlessly.
    if (wantAudio) await host.clearStems()

    if (plan.key && (keyInst.length > 0 || stems.bass)) {
      step('Reading the key…', 0.45)
      const t = Date.now()
      const k = await host.estimateKeyFromStems(
        project,
        keyInst.map(rel),
        stems.bass ? rel('bass') : undefined
      )
      ms.key = Date.now() - t
      if (k) fresh.key = { pc: k.pc, minor: k.minor, detVersion: KEY_DETECT_VERSION }
      else fresh.none = { ...fresh.none, key: KEY_DETECT_VERSION } // a silent bed, on record
    }

    // The stems this answer is computed from — the melody's too, though it
    // reads the file itself rather than crossing.
    if (plan.melody && stems.vocals) usedFiles.add(`vocals.${stems.vocals}`)
    const usedAll = [...usedFiles]
    const stampAll = hashesOf(doc0, usedAll)

    if (fresh.beat || fresh.key || fresh.none) {
      if (await commit(project, deps, fresh, used, stampAtStart)) opts.onCommit?.(fresh)
    }

    if (plan.melody && stems.vocals) {
      step('Tracking the melody…', 0.5)
      const t = Date.now()
      const m = await host.trackMelody(project, rel('vocals'), (p) =>
        step(`Tracking the melody · ${Math.round(p * 100)}%`, 0.5 + 0.5 * p)
      )
      ms.melody = Date.now() - t
      // Tracked from THIS project's vocals, so it fits by construction — the
      // check guards the stored-line path (planAnalysis), not this one.
      const info = await host.encodeMelody(m.f0, m.hopSec)
      fresh.melody = info
      if (await commit(project, deps, { melody: info }, usedAll, stampAll)) opts.onCommit?.({ melody: info })
    }

    log(
      'analysis',
      `${project}: done — ` +
        `${fresh.beat ? `${fresh.beat.beats.length} beats at ${fresh.beat.bpm.toFixed(1)} bpm` : fresh.none?.beat ? 'no grid in these drums' : 'grid kept'}, ` +
        `${fresh.key ? `key ${fresh.key.pc}${fresh.key.minor ? 'm' : ''}` : fresh.none?.key ? 'harmonic bed silent, no key' : 'key kept'}, ` +
        `${fresh.melody ? 'melody tracked' : 'melody kept'} · ` +
        `load ${ms.load} ms, ml ${ms.ml} ms, beat ${ms.beat} ms, key ${ms.key} ms, melody ${ms.melody} ms`
    )
    return { ...fresh, ms } // fresh carries beat/key/melody and none
  } finally {
    await host.clearStems()
  }
}

/**
 * Re-read → merge → write, guarded: the stems this answer came from must
 * still be the ones the doc on disk names. Throws when the doc is gone (the
 * project was deleted under the run) — the caller's problem, not a silent
 * success. A stems mismatch is dropped and logged, not thrown: the run did
 * nothing wrong, the song simply moved on.
 */
async function commit(
  project: string,
  deps: AnalysisDeps,
  fresh: FreshAnalysis,
  used: string[],
  stampAtStart: string
): Promise<boolean> {
  const onDisk = JSON.parse(await deps.readText(project, 'project.json')) as ProjectDoc
  if (hashesOf(onDisk, used) !== stampAtStart) {
    log('analysis', `${project}: stems changed while detecting — result dropped, not written`, 'warn')
    return false
  }
  await deps.writeText(project, 'project.json', JSON.stringify(mergeAnalysis(onDisk, fresh, deps.now()), null, 2))
  return true
}
