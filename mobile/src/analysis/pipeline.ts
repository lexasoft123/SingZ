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
 * Memory: NOTHING crosses a JS runtime here any more. The grid, the key and
 * the melody all read their own stem files in top-level zcore —
 * detectBeats, estimateKeyFromStems and the pyin tracker, each bit-identical
 * to the desktop's), on a native thread. Where the core cannot read a stem —
 * a copied desktop project's FLAC, or an older native beside newer JS —
 * deps.ts falls back to the worklet host and does its own loading there,
 * dropping each stem as it lands and clearing on the way out; the pipeline
 * never holds one. What the pipeline still owes, because put() used to do it
 * as a side effect, is naming those stems in the STAMP.
 */
import {
  BEAT_DETECT_VERSION,
  KEY_DETECT_VERSION,
  PITCH_DETECT_VERSION,
  analysisIsStale,
  decodeMelody,
  melodyFitsSong
} from '../gen/analysis-lib'
import type { MlGrid, StoredBeatInfo } from '../gen/analysis-lib'
import type { BeatInfo, KeyInfo, LyricLine, MelodyInfo, ProjectDoc } from '../model'
import { log } from '../log'
import type { MonoStem } from './host'

/** Which detector a progress line is about. The line itself is written for
 *  the singer ("Reading the key…"), so it says nothing about WHICH row of the
 *  song sheet it belongs under — and a project-wide line shown under `Beat`
 *  claimed the beat was still being looked for while the key ran, wiping a
 *  hand-tuned grid off the screen along with its promise never to re-detect
 *  over it. The stage travels with the line so each row can show its own. */
export type AnalysisStage = 'start' | 'beat' | 'key' | 'melody' | 'compact'

/** What one project needs, judged from its doc alone. */
export interface AnalysisPlan {
  beat: boolean
  key: boolean
  melody: boolean
  /** The project is v1 with WAV stems — a phone-split song not yet
   *  compacted. WHETHER this build can act on it is the runner's question
   *  (the native probe answers at run time, like mlNow); this only says the
   *  project is in the state the upgrade exists for. Planned, not only
   *  ridden: a phone killed during the encode leaves every detector stamp
   *  current, and a tail that only rode analysis jobs would never run
   *  again — the stranding hole review caught. */
  compact: boolean
}

export interface AnalysisResult {
  beat?: BeatInfo
  key?: KeyInfo
  melody?: MelodyInfo
  /** Detectors that answered "nothing here" this run, by stamp — a write too. */
  none?: { beat?: number; beatMl?: boolean; key?: number }
  /** Stems converted wav->flac this run (the v1->v2 upgrade riding the same
   *  job). A write: listeners re-list on it — entry.stems changed. */
  compacted?: number
  /** Where the time went, ms — for the log. */
  ms: { load: number; ml: number; beat: number; key: number; melody: number }
}

/** The host surface the pipeline drives — host.ts in the app, a fake in jest. */
export interface AnalysisHost {
  /** Hand one stem to the worklet runtime under a name the TS detectors ask
   *  for later. The pipeline no longer calls either of these — the fallbacks
   *  inside deps.ts do, for themselves — but they stay on the interface
   *  because that is what a fallback IS, and because `clearStems` in the
   *  pipeline's `finally` is the last guarantee that nothing is left pinned. */
  putStem(id: string, stem: MonoStem): Promise<void>
  clearStems(): Promise<void>
  /** Would `detectBeats` take the core, or the worklet fallback, for this
   *  build? The pipeline asks only to word the wait honestly — the fallback
   *  decodes six stems inside the call and takes minutes where the core takes
   *  seconds. Absent on the jest fake, where the question does not arise. */
  beatsAreNative?(): boolean
  /** The grid off the project's stems. Paths are project-RELATIVE, like the
   *  key and the melody: the core reads them itself, and the worklet fallback
   *  (FLAC, or an older native) does its own loading inside deps.ts. The
   *  pipeline no longer crosses these stems to any runtime — which is also
   *  why it must add them to the stamp by hand. */
  detectBeats(
    project: string,
    args: {
      drums: string
      bass?: string
      vocals?: string
      inst?: string[]
      lineStarts?: number[] | null
      words?: { s: number; e: number }[] | null
      ml?: MlGrid | null
    }
  ): Promise<{
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
  /** Does the INSTALLED binary read (and write) FLAC? Absent on the jest
   *  fake and on an older native beside newer JS — both mean "treat FLAC as
   *  the worklet's problem and never plan a compact". */
  flacIsNative?(): boolean
  /** One stem of the v1->v2 upgrade, in the core: encode wav->flac (verify
   *  on, .part rename, wav deleted on success; idempotent when the flac is
   *  already there). Rejects on failure — the wav is then untouched. */
  compactStem?(project: string, wavRel: string, flacRel: string): Promise<{ bytes: number; skipped: boolean }>
}

export interface AnalysisDeps {
  readText(project: string, file: string): Promise<string>
  writeText(project: string, file: string, text: string): Promise<boolean>
  /** md5+size+mtime of a project file (the native's memoized hash) — what
   *  stemHashes is made of. Optional: absent means compacting cannot update
   *  the doc and is therefore not attempted. */
  statFile?(project: string, relPath: string): Promise<{ md5: string; size: number; mtimeMs: number }>
  /** One stem as mono float32 at 44.1 kHz; the implementation decodes, folds
   *  channels and frees the decoded buffer before returning.
   *
   *  Nothing in this file calls it any more — the detectors read their own
   *  files in the core, and the worklet fallbacks behind `host` import
   *  `loadMono44k` directly rather than coming back through here. It stays on
   *  the interface because the jest world supplies it and a fake host built
   *  against this shape is how the pipeline's own tests load a stem; a reader
   *  looking for its call site inside this file will not find one. */
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
  mlNow = false,
  /** The singer asked for it. Every stamp and every stored verdict is set
   *  aside and each detector runs on whatever stems exist — which is the
   *  whole point of a "detect again" button: the stamps say nothing needs
   *  doing, and the singer disagrees. Hand-placed bar lines are NOT lost;
   *  analyzeProject folds them back onto the fresh grid the way the desktop
   *  does.
   *
   *  A hand-made ('manual') GRID is the one thing force does not override.
   *  The rule at the top of this file has no exception for it, and the phone
   *  has no beat editor: a desktop project whose grid was halved, shifted or
   *  re-metered by hand and then dropped into "On My iPhone" through Files
   *  looks exactly like any other phone-library song to the sheet, and one
   *  tap would replace work the singer cannot redo here. The desktop's own
   *  Re-detect does overwrite it — beside a "hand-tuned" label and an editor
   *  to put it back. */
  force = false
): AnalysisPlan {
  const s = doc.settings ?? ({} as ProjectDoc['settings'])
  const none = s.analysisNone ?? {}
  const beatStored = s.beat
  const beatStale =
    !!beatStored && beatStored.source === 'auto' && analysisIsStale(beatStored.detVersion, BEAT_DETECT_VERSION)
  // A negative verdict from THIS detector counts as an answer — a drumless
  // song is not asked again on every open; a newer detector asks once more.
  // The verdict carries a SUB-STAMP, beatMl: whether the neural lattice was
  // heard when "no grid" was decided. BEAT_DETECT_VERSION alone cannot say —
  // the desktop ships ml and no-ml grids under the same detVersion (a
  // packless desktop's grid is legitimate) — so when the beat models arrive
  // on a phone AFTER a song was declared gridless, the version matches, the
  // verdict predates the evidence, and without this line it would bind
  // forever. Re-ask exactly once, with the better ears.
  const noneBeatBinds = !analysisIsStale(none.beat, BEAT_DETECT_VERSION) && (none.beatMl === true || !mlNow)
  const beatManual = beatStored?.source === 'manual'
  const beat =
    !!stems.drums && !beatManual && (force || ((!beatStored || beatStale) && !noneBeatBinds))

  const keyStored = s.key
  const key =
    (INST.some((id) => stems[id]) || !!stems.bass) &&
    (force ||
      ((!keyStored || analysisIsStale(keyStored.detVersion, KEY_DETECT_VERSION)) &&
        analysisIsStale(none.key, KEY_DETECT_VERSION)))

  let melody = false
  if (stems.vocals) {
    const m = s.melody
    if (force) melody = true
    else if (!m || analysisIsStale(m.detVersion, PITCH_DETECT_VERSION)) melody = true
    else if (durationSec != null) {
      // A stored line whose coverage is another song's length is disowned
      // and re-tracked — the rule that healed the two field projects that
      // caught a neighbour's line.
      const dec = decodeMelody(m)
      melody = !dec || !melodyFitsSong(dec.f0, dec.info.hopSec, durationSec)
    }
  }
  // v1 + WAV stems = the state the upgrade exists for. Not gated on force:
  // a forced re-detect of an already-compacted project has nothing to
  // compact, and an uncompacted one wants it regardless of why it ran.
  //
  // The second clause is the KILLED-MIDDLE rescue (review caught it as the
  // last member of the stranding family): a phone that dies inside the
  // compact loop — after some per-stem unlinks, before the single doc
  // write — leaves mixed stems under an all-wav doc. All-wav is then false
  // forever, and the probe alone cannot tell that state from a FAILED stem,
  // whose doc write landed. The DOC tells them apart: a failed run named
  // its flacs, a killed one did not — so a probed .flac stem with no
  // `${id}.flac` entry in stemHashes is a conversion the doc never heard
  // about, and the project plans until the doc catches up.
  const ids = Object.keys(stems)
  const compact =
    (doc.version ?? 1) < 2 &&
    ids.length > 0 &&
    (ids.every((id) => /^wav$/i.test(stems[id])) ||
      ids.some((id) => /^flac$/i.test(stems[id]) && !doc.stemHashes?.[`${id}.flac`]))

  return { beat, key, melody, compact }
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
    onStep?: (msg: string, frac: number, stage: AnalysisStage) => void
    /** Called after each write lands — the grid is on disk a minute before
     *  the melody is, and a player showing the song should not wait. */
    onCommit?: (fresh: FreshAnalysis) => void
    /** The singer asked for it — see planAnalysis. Sets every stamp and
     *  every stored verdict aside and runs each detector the stems allow. */
    force?: boolean
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
  // "Readable by the core" is wav — or flac on a build whose native carries
  // the FLAC reader (Phase 5). The probe asks the INSTALLED binary; absent
  // (jest, an older native under newer JS) keeps the wav-only answer.
  const coreExt = (r: string): boolean =>
    /\.wav$/i.test(r) || (/\.flac$/i.test(r) && host.flacIsNative?.() === true)
  const mlNow = mixIds.length > 0 && mixIds.every((id) => coreExt(rel(id))) && (await host.mlAvailable())
  const plan = planAnalysis(doc0, stems, durationSec, mlNow, opts.force === true)
  // Compacting needs all three of: the state (plan), the binary (probe) and
  // the doc machinery (statFile). Decided once, here, so the early exit and
  // the phase below cannot disagree.
  const canCompact =
    plan.compact && host.flacIsNative?.() === true && host.compactStem != null && deps.statFile != null
  if (!plan.beat && !plan.key && !plan.melody && !canCompact) {
    log('analysis', `${project}: nothing to detect — grid, key and melody are current`)
    return null
  }
  log(
    'analysis',
    `${project}: ${(() => {
      const det = [plan.beat && 'beat', plan.key && 'key', plan.melody && 'melody'].filter(Boolean)
      // An encode-only run (the stranded-tail rescue) detects nothing — the
      // first live one logged "detecting  ·" with an empty list.
      if (det.length === 0) return 'compacting stems'
      return `detecting ${det.join(', ')}${canCompact ? ', then compacting' : ''}`
    })()} · stems ${Object.keys(stems).join(',')}`
  )
  const usedFiles = new Set<string>()
  const ms = { load: 0, ml: 0, beat: 0, key: 0, melody: 0 }
  try {
    // The neural lattice FIRST, and off the worklet host entirely: the core
    // reads, sums and decimates the stems itself, so running it before put()
    // keeps the two memory peaks apart — the ORT session's ~700 MB (measured,
    // docs/PHONE-STANDALONE.md) and the worklet's six decoded stems never
    // coexist. Null is the packless-desktop answer, not a failure; the mix's
    // files join the stamp because the grid that comes out depends on them.
    let ml: MlGrid | null = null
    if (plan.beat && mlNow) {
      step('Listening for the beat…', 0.01, 'beat')
      const t = Date.now()
      ml = await host.mlGrid(project, mixIds.map(rel))
      ms.ml = Date.now() - t
      if (ml) for (const id of mixIds) usedFiles.add(`${id}.${stems[id]}`)
    }
    const tLoad = Date.now() // `load` is the stems crossing, not the lattice — reported apart

    // NOTHING crosses a JS runtime here any more. The grid, the key and the
    // melody all read their own files in the core; the worklet fallbacks
    // (FLAC stems, or an older native beside newer JS) do their own loading
    // inside deps.ts, where the stem can be dropped the moment it is used.
    //
    // Which means every one of these stems must be added to the stamp BY HAND
    // — put() used to do it as a side effect. Without it a run compares an
    // empty file list against an empty file list, which can never fail, and an
    // answer computed from stems that were replaced mid-run is written into a
    // doc that now names different ones. The guard is only as good as what it
    // is told to watch.
    const beatStems = plan.beat ? ['drums', 'bass', 'vocals', ...INST].filter((id) => stems[id]) : []
    for (const id of beatStems) usedFiles.add(`${id}.${stems[id]}`)
    const keyInst = INST.filter((id) => stems[id])
    if (plan.key) {
      for (const id of keyInst) usedFiles.add(`${id}.${stems[id]}`)
      if (stems.bass) usedFiles.add(`bass.${stems.bass}`)
    }
    const have = {
      drums: beatStems.includes('drums'),
      bass: beatStems.includes('bass'),
      vocals: beatStems.includes('vocals'),
      inst: INST.filter((id) => beatStems.includes(id))
    }
    // Kept at 0 rather than deleted: the log line is read across releases and
    // a load time that has become zero says the stems stopped crossing, where
    // a missing field says only that someone edited the log.
    ms.load = Date.now() - tLoad
    // The stems this answer is computed from — compared against the doc on
    // disk before every write.
    const used = [...usedFiles]
    const stampAtStart = hashesOf(doc0, used)

    const fresh: FreshAnalysis = {}

    if (plan.beat && have.drums) {
      // The core reads the stems itself and answers in seconds, so one message
      // covers it. The FALLBACK does not: a copied desktop project's six FLAC
      // stems decode inside this call, measured at 51 s on a simulator against
      // the native's 8.5, and the "Reading the …" steps that used to move
      // during that decode went with put(). Naming the wait is the honest
      // minimum until the fallback reports its own progress.
      // Decided from the PATHS, not just the build: `beatsAreNative` answers
      // "does the installed binary have the method", which is true on every
      // current build — including for the copied desktop project whose six
      // FLAC stems decode inside this call, which is the case the honest
      // wording exists for.
      const beatsFast =
        beatStems.every((id) => coreExt(rel(id))) && deps.host.beatsAreNative?.() !== false
      step(beatsFast ? 'Finding the beat…' : 'Reading the stems…', 0.3, 'beat')
      const t = Date.now()
      const lines = opts.lyrics?.lines ?? null
      const det = await host.detectBeats(project, {
        drums: rel('drums'),
        bass: have.bass ? rel('bass') : undefined,
        vocals: have.vocals ? rel('vocals') : undefined,
        inst: have.inst.map(rel),
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

    // Nothing this stage put anything on the far side any more — every
    // fallback that does (a FLAC project, or JS newer than the installed
    // binary) clears up after itself inside deps.ts, on the spot. The clear
    // in the finally below is what still guarantees it.

    if (plan.key && (keyInst.length > 0 || stems.bass)) {
      step('Reading the key…', 0.45, 'key')
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
      step('Tracking the melody…', 0.5, 'melody')
      const t = Date.now()
      const m = await host.trackMelody(project, rel('vocals'), (p) =>
        step(`Tracking the melody · ${Math.round(p * 100)}%`, 0.5 + 0.5 * p, 'melody')
      )
      ms.melody = Date.now() - t
      // Tracked from THIS project's vocals, so it fits by construction — the
      // check guards the stored-line path (planAnalysis), not this one.
      const info = await host.encodeMelody(m.f0, m.hopSec)
      fresh.melody = info
      if (await commit(project, deps, { melody: info }, usedAll, stampAll)) opts.onCommit?.({ melody: info })
    }

    // ---- the v1->v2 upgrade, riding the tail of the job that owns the
    // stems (docs/PHONE-STANDALONE.md, Phase 5). AFTER the detectors: a
    // phone-split song is born WAV, the fast format, and its first full
    // analysis is guaranteed ahead of it — encoding first would put the
    // decode penalty in front of the one analysis certain to happen. And
    // PLANNED, not only ridden: plan.compact re-queues a v1 project whose
    // detectors are current, so a phone killed mid-encode converges on the
    // next open instead of stranding v1 forever.
    let compacted = 0
    if (canCompact && host.compactStem && deps.statFile) {
      const ids = Object.keys(stems)
      const hashes: Record<string, { md5: string; size: number; mtimeMs: number }> = {}
      let allFlac = true
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i]
        step(`Compacting stems · ${i + 1} of ${ids.length}`, 0.97, 'compact')
        if (/^flac$/i.test(stems[id])) {
          // Already converted on disk — the killed-middle rescue, or simply
          // a stem an interrupted run finished. Two jobs, neither an encode:
          // clean a leftover wav if the kill landed in the rename→unlink
          // micro-window (compactStem's skip-heal does exactly that — and
          // its wav resolution REJECTING because there is no wav to clean is
          // the ordinary healed state, not an error), then state the flac in
          // the doc, which is the half the kill lost.
          try {
            await host.compactStem(project, `stems/${id}.wav`, `stems/${id}.flac`)
          } catch {
            /* no leftover wav — the usual case */
          }
          try {
            hashes[`${id}.flac`] = await deps.statFile(project, `stems/${id}.flac`)
            compacted++
          } catch (e) {
            log('analysis', `${project}: stem ${id} unreadable while healing — ${String(e instanceof Error ? e.message : e)}`, 'warn')
            allFlac = false
          }
          continue
        }
        try {
          // Idempotent and crash-safe in the core: encode to .part (verify
          // on), rename, delete the wav — a kill at any instant leaves the
          // wav, or a verified flac, or briefly both, and a re-run heals.
          await host.compactStem(project, `stems/${id}.wav`, `stems/${id}.flac`)
          hashes[`${id}.flac`] = await deps.statFile(project, `stems/${id}.flac`)
          compacted++
        } catch (e) {
          // The failed stem keeps its wav and the doc keeps naming it — the
          // desktop's own rule (a project is v2 only when EVERY stem
          // converted; src/main/projects.ts convertStemsToFlac).
          log('analysis', `${project}: stem ${id} kept as wav — ${String(e instanceof Error ? e.message : e)}`, 'warn')
          allFlac = false
        }
      }
      if (compacted > 0) {
        // Re-read → merge → write, like every other landing: another writer
        // may have moved the doc while the encoder ran. stemHashes entries
        // move wav->flac per converted stem; version flips only on a full
        // set, and savedAt moves because the project's files changed.
        const onDisk = JSON.parse(await deps.readText(project, 'project.json')) as ProjectDoc
        const nextHashes: Record<string, { md5: string; size: number; mtimeMs: number }> = {
          ...(onDisk.stemHashes ?? {})
        }
        for (const id of ids) {
          if (hashes[`${id}.flac`]) {
            delete nextHashes[`${id}.wav`]
            nextHashes[`${id}.flac`] = hashes[`${id}.flac`]
          }
        }
        const next: ProjectDoc = {
          ...onDisk,
          version: allFlac ? Math.max(2, onDisk.version ?? 1) : onDisk.version,
          stemHashes: nextHashes,
          savedAt: deps.now()
        }
        await deps.writeText(project, 'project.json', JSON.stringify(next, null, 2))
        log(
          'analysis',
          `${project}: compacted ${compacted} stem(s) to flac${allFlac ? ' — project is v2' : ' — some kept wav, still v1'}`
        )
      }
    }

    log(
      'analysis',
      `${project}: done — ` +
        `${fresh.beat ? `${fresh.beat.beats.length} beats at ${fresh.beat.bpm.toFixed(1)} bpm` : fresh.none?.beat ? 'no grid in these drums' : 'grid kept'}, ` +
        `${fresh.key ? `key ${fresh.key.pc}${fresh.key.minor ? 'm' : ''}` : fresh.none?.key ? 'harmonic bed silent, no key' : 'key kept'}, ` +
        `${fresh.melody ? 'melody tracked' : 'melody kept'} · ` +
        `load ${ms.load} ms, ml ${ms.ml} ms, beat ${ms.beat} ms, key ${ms.key} ms, melody ${ms.melody} ms`
    )
    return { ...fresh, ms, ...(compacted > 0 ? { compacted } : {}) }
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
