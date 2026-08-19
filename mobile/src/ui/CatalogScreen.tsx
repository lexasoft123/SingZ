import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  DeviceEventEmitter,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'
import { decodeAudioData } from 'react-native-audio-api'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  driveAccountEmail,
  driveAvailable,
  driveListProjects,
  driveSignedIn,
  driveSignIn,
  driveSignOut,
  driveStoredProjects
} from '../gdrive'
import { getCrumb, getStoredText, setCrumb, setStoredText } from '../latency'
import { fmtBytes, fmtMs, log } from '../log'
import LogPanel from './LogPanel'
import { addedTracks, STEM_ORDER_ALL, type LyricsDoc, type ProjectDoc } from '../model'
import {
  cacheUsage,
  clearCache,
  clearRoot,
  getRoot,
  isDownloaded,
  decodedBytes,
  listProjects,
  loadProject,
  pickFolder,
  localProjectFile,
  readProjectText,
  releaseProject,
  releaseStems,
  type CacheUsage,
  type LoadedProject,
  type ProjectEntry,
  type RootInfo
} from '../projects'
import { C, Seg, StemTile, white } from './bits'
import { TEST } from './testhooks'
import AddSongSheet from './AddSongSheet'
import { addSongHeadless, findLyrics, readSongFacts } from '../addflow'
import { deleteProject, pickAudioFile, writeLyrics, type PickedFile } from '../writer'
import {
  cancelSplit,
  clearSplitJob,
  splitAvailable,
  splitStatus,
  subscribeSplit,
  type SplitJobStatus
} from '../split/service'
import {
  KEEPS_FAILING_COPY,
  finishSplit,
  recordFailure,
  splitGate,
  startProjectSplit
} from '../split/flow'
import { BEAT_MODELS_MB, SPLIT_MODEL, beatModelsStatus, cancelBeatModels, cancelModelDownload, ensureBeatModels } from '../analysis/models'
import { nativeMlGridAvailable } from '../analysis/native'
import { planAnalysis } from '../analysis/pipeline'
import { ANALYSIS_EVENT, startAnalysis, subscribeAnalysis, type AnalysisDone, type AnalysisProgress } from '../analysis/run'
import { SPLIT_STEMS } from '../split/adopt'

const BG = require('../../assets/bg/catalog.png')
const GDRIVE_ICON = require('../../assets/gdrive.png')
const SAMPLE_PROJECT = require('../../assets/sample/project.json') as ProjectDoc
const SAMPLE_LYRICS = require('../../assets/sample/lyrics.json') as LyricsDoc
const SAMPLE_STEMS: Record<string, number> = {
  vocals: require('../../assets/sample/stems/vocals.flac'),
  drums: require('../../assets/sample/stems/drums.flac'),
  bass: require('../../assets/sample/stems/bass.flac'),
  guitar: require('../../assets/sample/stems/guitar.flac'),
  piano: require('../../assets/sample/stems/piano.flac'),
  other: require('../../assets/sample/stems/other.flac')
}
const SAMPLE_DIR = '~sample'

interface Loading {
  dir: string
  msg: string
  frac: number
}

const fmtSize = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`

export default function CatalogScreen({
  sampleRate,
  onLoaded
}: {
  sampleRate: number
  onLoaded: (p: LoadedProject) => void
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const [root, setRoot] = useState<RootInfo | null>(null)
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null)
  const [loading, setLoading] = useState<Loading | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Library source: Drive API / picked folder (SAF, iCloud) / on-device. */
  const [mode, setMode] = useState<'gdrive' | 'folder' | 'phone'>('phone')
  const [driveEmail, setDriveEmail] = useState<string | null>(null)
  const [driveOn, setDriveOn] = useState(false)
  const [pulling, setPulling] = useState(false)
  /** What each project holds on this phone: total bytes and the size of every
   *  file present, which is what the ✓ compares against project.json. */
  const [usage, setUsage] = useState<Record<string, CacheUsage>>({})
  /** The listing on screen is the stored one; the refresh behind it failed. */
  const [offline, setOffline] = useState(false)
  /** The diagnostic log — the only evidence a release build leaves behind. */
  const [logOpen, setLogOpen] = useState(false)
  /** The add-a-song sheet (phone library only), and the file it was opened
   *  for. The pick happens BEFORE the sheet exists, and that order is the
   *  whole point: iOS presents one view controller at a time, so a sheet that
   *  opened its own picker put two presentations in flight from one commit —
   *  UIKit kept the picker ("waiting for a delayed presention to complete")
   *  and silently refused the sheet, which then ran its whole flow invisibly.
   *  One presentation at a time makes that unrepresentable. */
  const [addOpen, setAddOpen] = useState(false)
  const [addSrc, setAddSrc] = useState<PickedFile | null>(null)
  /** A pick is on screen: no sheet exists yet to hold that state. */
  const picking = useRef(false)
  /** A cancel during the model load has to wait for ORT's blocking load to
   *  return — the engine only checks between chunks. Saying nothing makes the
   *  button look broken (it did, in the field), so the card says what it is
   *  doing and the tap still lands. */
  const [cancelPending, setCancelPending] = useState(false)
  /** Bumping this token abandons any in-flight load (switch or cancel). */
  const token = useRef(0)
  /** Bumping this drops a superseded listing (mode switched mid-flight). */
  const listSeq = useRef(0)

  const loadUsage = useCallback(async () => {
    const rows = await cacheUsage()
    const map: Record<string, CacheUsage> = {}
    for (const r of rows) map[r.project] = r
    setUsage(map)
  }, [])

  /** Add a song: the system picker first, the sheet only once a file is in
   *  hand (see addSrc — presenting both at once loses the sheet). Cancelling
   *  the picker leaves nothing open, which is what cancelling should do. */
  const beginAdd = useCallback(async () => {
    // A pick in flight has no sheet to speak for it, so the second tap is
    // stopped here rather than by the natives' "busy" reject (which would
    // shout an error at the singer for what is a double tap).
    if (addOpen || picking.current) return
    picking.current = true
    log('song', 'add-song: opening the picker')
    let picked: PickedFile | null = null
    try {
      setError(null)
      picked = await pickAudioFile()
    } catch (e) {
      // With the pick out here, this catch IS the error UI — a rejected pick
      // used to reach the sheet and say so; silence would read as the app
      // ignoring the tap.
      const msg = String(e instanceof Error ? e.message : e)
      log('song', `add-song: the picker failed — ${msg}`, 'error')
      setError(`That file couldn't be opened (${msg})`)
      return
    } finally {
      picking.current = false
    }
    if (!picked) {
      log('song', 'add-song: picker cancelled')
      return
    }
    log('song', `add-song: picked ${picked.name} (${fmtBytes(picked.size)})`)
    if (TEST) TEST.addSheetShown = false
    setAddSrc(picked)
    setAddOpen(true)
  }, [addOpen])

  const refresh = useCallback(
    async (force = false) => {
      const my = ++listSeq.current
      try {
        setError(null)
        if (mode === 'gdrive') {
          setRoot({ kind: 'picked', path: 'gdrive', name: 'Google Drive' })
          // Stale-while-revalidate, and the stale copy outlives the process:
          // whatever listing we have shows INSTANTLY (a song outlives the
          // freshness window, and a spinner on every exit reads as the
          // library re-downloading), then the network replaces it quietly.
          // The full-screen spinner is ONLY for an empty screen — on
          // pull-to-refresh the pull indicator is already spinning.
          // The catalog goes up BEFORE the sign-in probes: those are pref
          // reads too, and holding a ready catalog behind three bridge hops
          // is a visible "loading from Google Drive" flash on a cold start.
          const cached = await driveStoredProjects()
          if (my !== listSeq.current) return
          setProjects(cached?.length ? cached : null)
          const signed = await driveSignedIn()
          setDriveOn(signed)
          if (!signed) {
            if (my === listSeq.current) setProjects([])
            return
          }
          setDriveEmail(await driveAccountEmail())
          try {
            const fresh = await driveListProjects(force)
            if (my === listSeq.current) {
              setProjects(fresh)
              setOffline(false)
            }
          } catch (e) {
            // No signal is not an error when the phone already knows the
            // library — say so quietly rather than replacing a working
            // catalog with red text.
            if (!cached?.length) throw e
            if (my === listSeq.current) setOffline(true)
          }
        } else {
          const r = await getRoot()
          const list = await listProjects()
          if (my === listSeq.current) {
            setRoot(r)
            setProjects(list)
          }
        }
        void loadUsage()
      } catch (e) {
        if (my === listSeq.current) {
          setError(String(e instanceof Error ? e.message : e))
          setProjects([])
        }
      }
    },
    [mode, loadUsage]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    void getStoredText('singz.libMode').then((m) => {
      if (m === 'gdrive' && driveAvailable()) setMode('gdrive')
      else if (m === 'folder') setMode('folder')
      else {
        // no stored choice: land on the folder root if one was picked
        void getRoot().then((r) => setMode(r.kind === 'picked' ? 'folder' : 'phone'))
      }
    })
    void getCrumb().then((c) => {
      if (c) {
        setError(`The last open crashed while ${c} — please report this.`)
        void setCrumb('')
      }
    })
  }, [])

  const selectMode = useCallback(
    (next: 'gdrive' | 'folder' | 'phone'): void => {
      void (async () => {
        try {
          setError(null)
          if (next === 'phone') await clearRoot()
          if (next === 'folder') {
            const r = await getRoot()
            if (r.kind !== 'picked') {
              const picked = await pickFolder()
              if (!picked) return // kept the current source
            }
          }
          setMode(next)
          void setStoredText('singz.libMode', next)
        } catch (e) {
          setError(String(e instanceof Error ? e.message : e))
        }
      })()
    },
    [mode, root]
  )

  const driveSignInFlow = useCallback(async () => {
    try {
      setError(null)
      await driveSignIn()
      setDriveOn(true)
      await refresh()
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    }
  }, [refresh])

  const openDrive = useCallback(async () => {
    setMode('gdrive')
    void setStoredText('singz.libMode', 'gdrive')
    if (!(await driveSignedIn())) await driveSignInFlow()
  }, [driveSignInFlow])

  const cancelLoad = useCallback(() => {
    token.current++
    setLoading(null)
  }, [])

  const forget = useCallback(
    async (project: string) => {
      try {
        await clearCache(project)
        await loadUsage()
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e))
      }
    },
    [loadUsage]
  )

  /** Long-press a downloaded song: drop its files, keep it in the library. */
  const confirmForget = useCallback(
    (entry: ProjectEntry) => {
      const have = usage[entry.dir]?.bytes ?? 0
      if (have <= 0) return
      Alert.alert(
        entry.doc.name ?? entry.dir,
        `Remove ${fmtSize(have)} from this phone? The song stays in your library — ` +
          'opening it again downloads it back.',
        [
          { text: 'Keep it', style: 'cancel' },
          { text: 'Remove', style: 'destructive', onPress: () => void forget(entry.dir) }
        ]
      )
    },
    [forget, usage]
  )

  const confirmForgetAll = useCallback(
    (total: number) => {
      Alert.alert(
        'Free up space',
        `Delete ${fmtSize(total)} of downloaded songs? They stay in your library — ` +
          'you can download them again whenever you have signal.',
        [
          { text: 'Keep them', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => void forget('') }
        ]
      )
    },
    [forget]
  )

  const openEntry = useCallback(
    async (entry: ProjectEntry) => {
      const tok = ++token.current
      setError(null)
      setLoading({ dir: entry.dir, msg: 'Opening…', frac: 0 })
      try {
        const loaded = await loadProject(
          entry,
          sampleRate,
          (msg, frac) => {
            if (tok === token.current) setLoading({ dir: entry.dir, msg, frac })
          },
          setCrumb
        )
        if (tok !== token.current) {
          releaseProject(loaded) // superseded by another tap — don't strand its stems
          return
        }
        await setCrumb('')
        setLoading(null)
        onLoaded({ ...loaded, library: mode })
        // A phone-library song missing its grid (or carrying an older
        // detector's) is analysed now, behind the player — the desktop's
        // on-open rule. Only the phone's own library: a picked folder or
        // Drive is the desktop's to write. The vocals' length is unknown here
        // (null), so the length rule for a stored melody is not judged from
        // this trigger — it is applied inside a run started for any other
        // reason; a phone-split song's line was tracked from its own vocals,
        // so nothing is lost. A song still waiting for its split has no
        // drums/vocals stems yet, so the plan asks for nothing there.
        if (mode === 'phone') {
          // mlNow=true here is the OPTIMISTIC question — "would the models,
          // if present, change the answer?" — so a song declared gridless
          // before the beat models arrived is handed to the runner, which
          // asks the real question (models on disk, stems the core reads)
          // and plans again; when they are not, it finds nothing to do and
          // costs one stat. Asking pessimistically would leave that song
          // gridless forever after the download.
          const plan = planAnalysis(entry.doc, entry.stems, null, true)
          if (plan.beat || plan.key || plan.melody) startAnalysis(entry.dir, entry.stems, loaded.lyrics)
        }
      } catch (e) {
        await setCrumb('')
        if (tok === token.current) {
          setLoading(null)
          setError(String(e instanceof Error ? e.message : e))
        }
      }
    },
    [onLoaded, sampleRate, mode]
  )

  const openSample = useCallback(async () => {
    const tok = ++token.current
    setError(null)
    try {
      const ids = STEM_ORDER_ALL.filter((s) => s in SAMPLE_STEMS)
      const stems: LoadedProject['stems'] = []
      // The sample decodes from bundled assets, so it never touches
      // loadProject and used to leave no trace at all — which is the worst
      // possible gap, because a tester with no library of their own has
      // nothing else to open.
      log('song', `opening the bundled sample · ${ids.length} lanes`)
      const openedAt = Date.now()
      const spent: string[] = []
      for (let i = 0; i < ids.length; i++) {
        if (tok !== token.current) return releaseStems(stems)
        setLoading({ dir: SAMPLE_DIR, msg: `Decoding ${ids[i]} · ${i + 1}/${ids.length}`, frac: i / ids.length })
        const t0 = Date.now()
        stems.push({ id: ids[i], buffer: await decodeAudioData(SAMPLE_STEMS[ids[i]], sampleRate) })
        spent.push(`${ids[i]} ${fmtMs(Date.now() - t0)}`)
      }
      if (tok !== token.current) return
      setLoading(null)
      log(
        'song',
        `opened the bundled sample — ${stems.length} lanes in ${fmtMs(Date.now() - openedAt)} · ` +
          `${fmtBytes(decodedBytes(stems))} decoded · decode ${spent.join(', ')}`
      )
      onLoaded({ name: SAMPLE_PROJECT.name, doc: SAMPLE_PROJECT, lyrics: SAMPLE_LYRICS, stems })
    } catch (e) {
      if (tok === token.current) {
        setLoading(null)
        const msg = String(e instanceof Error ? e.message : e)
        log('song', `the bundled sample failed to open — ${msg}`, 'error')
        setError(msg)
      }
    }
  }, [onLoaded, sampleRate])

  const changeFolder = useCallback(async () => {
    try {
      const picked = await pickFolder()
      if (picked) {
        await refresh()
        setTimeout(() => void refresh(), 1500)
      }
    } catch (e) {
      setError(`Folder picker: ${String(e instanceof Error ? e.message : e)}`)
    }
  }, [refresh])

  /** Find synced lyrics later, from the card — the down-verdict path. */
  const findLyricsFor = useCallback(
    async (p: ProjectEntry) => {
      try {
        setLoading({ dir: p.dir, msg: 'Looking for lyrics…', frac: 0.5 })
        const docJson = await readProjectText(p.dir, 'project.json')
        const doc = JSON.parse(docJson) as ProjectDoc
        // real duration (LRCLIB match tolerance) + the file's own artist tag;
        // the confirmed project name outranks whatever the tag title says
        const songPath = await localProjectFile(p.dir, doc.songFile)
        const facts = await readSongFacts(songPath, doc.songFile, sampleRate)
        const outcome = await findLyrics({
          title: doc.name,
          artist: facts.artist,
          durationSec: facts.durationSec
        })
        if (typeof outcome === 'object') {
          // Re-read the doc NOW: the lookup took seconds, and a project
          // deleted meanwhile must fail here (readText throws) rather than
          // be resurrected as a folder holding only its lyrics.
          const freshDoc = await readProjectText(p.dir, 'project.json')
          await writeLyrics(p.dir, freshDoc, outcome.hit)
          setLoading(null)
          await refresh()
        } else {
          setLoading(null)
          Alert.alert(
            'No lyrics yet',
            outcome === 'down'
              ? "The lyrics service didn't answer — try again later."
              : 'Nothing matched this title. Lyrics can also be added on the computer.'
          )
        }
      } catch (e) {
        setLoading(null)
        setError(String(e instanceof Error ? e.message : e))
      }
    },
    [refresh, sampleRate]
  )

  /**
   * The split job's card state. job.json (via splitStatus) is the truth —
   * this state is a viewer over it plus the live event stream; a relaunch
   * mid-split reconstructs the card from the file alone.
   */
  type SplitUi =
    | null
    | { phase: 'model'; project: string; gotMB: number; totalMB: number }
    | {
        phase: 'run'
        project: string
        text: string
        frac: number
        /** Whether the job has been heard from at all — a progress event or
         *  job.json. A card still waiting for its first sign of life when the
         *  liveness poll finds no file is a start that never happened, not a
         *  job that cleaned up after itself. */
        started: boolean
      }
    | { phase: 'adopting'; project: string }
    | { phase: 'failed'; project: string; error: string; attempts: number }
  const [splitUi, setSplitUi] = useState<SplitUi>(null)
  // The latest card, for the liveness poll: its timer closes over the render
  // that armed it, and `started` flips inside a run without re-arming.
  const splitUiRef = useRef<SplitUi>(null)
  useEffect(() => {
    splitUiRef.current = splitUi
  }, [splitUi])
  const adoptingRef = useRef(false)

  /* Beat / key / melody for a phone-library project (Phase 4). One queue
   * app-wide (analysis/run.ts); the card below is a viewer over its progress. */
  const [analysisUi, setAnalysisUi] = useState<AnalysisProgress | null>(null)
  useEffect(() => subscribeAnalysis(setAnalysisUi), [])
  // A landed analysis changed a doc on disk; the listing must say so, or the
  // next open of that song would ask for the same analysis again off a stale
  // entry.doc.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener(ANALYSIS_EVENT, (e: AnalysisDone) => {
      if (e.changed) void refresh()
    })
    return () => sub.remove()
  }, [refresh])
  const kickAnalysis = useCallback(async (dir: string, stems: Record<string, string>) => {
    let lyrics: LyricsDoc | null = null
    try {
      lyrics = JSON.parse(await readProjectText(dir, 'lyrics.json')) as LyricsDoc
    } catch {
      lyrics = null // no lyrics yet — the grid does without the line cues
    }
    startAnalysis(dir, stems, lyrics)
  }, [])

  /* The "better beats" offer (Phase 4b): the Beat This! models are an
   * optional 87 MB extra — the neural lattice the desktop's packs carry,
   * which holds a grid through drumless intros and rubato the drums-first
   * tracker loses. Offered in the phone library only when the installed
   * native can use them AND the library holds at least one song with stems
   * to hear them on — an empty library, or one of unsplit songs, has
   * nothing the models would change yet, so it is not asked. Dismissing
   * keeps it away (one pref). Never started on anyone's behalf — 87 MB is a
   * tap, not a side effect. What the download changes is stated on the
   * card: songs the detector has not heard yet, and any it found no grid
   * in; a song already holding a current grid keeps it (desktop semantics —
   * there is no re-analyse here either). */
  type BeatModelsUi = null | { phase: 'offer' } | { phase: 'downloading'; gotMB: number; totalMB: number }
  const [beatModelsUi, setBeatModelsUi] = useState<BeatModelsUi>(null)
  const BEAT_MODELS_DISMISSED = 'singz.beatModels.dismissed'
  // Keyed on `projects` (a new array every refresh), not on a derived
  // boolean: the models are a fact about the DISK, and whether they are
  // there is re-asked whenever the library is re-read — the way the ✓ on a
  // song is re-asked of its files. A boolean that happened not to flip
  // would have frozen the first answer for the session (measured: the
  // offer stayed hidden after the files were gone, because the effect had
  // no reason to look again).
  useEffect(() => {
    const anyStemmed = (projects ?? []).some((p) => Object.keys(p.stems).length > 0)
    if (mode !== 'phone' || !nativeMlGridAvailable() || !anyStemmed) {
      setBeatModelsUi((cur) => (cur?.phase === 'downloading' ? cur : null))
      return
    }
    let alive = true
    void (async () => {
      if ((await getStoredText(BEAT_MODELS_DISMISSED)) === '1') return
      const st = await beatModelsStatus()
      if (!alive) return
      // The disk is the truth both ways: present → no offer (and not while
      // a download is in flight, which is its own card state).
      setBeatModelsUi((cur) => (cur?.phase === 'downloading' ? cur : st.have ? null : { phase: 'offer' }))
    })()
    return () => {
      alive = false
    }
  }, [mode, projects])
  const fetchBeatModels = useCallback(async () => {
    setBeatModelsUi({ phase: 'downloading', gotMB: 0, totalMB: BEAT_MODELS_MB })
    try {
      await ensureBeatModels((got, total) =>
        setBeatModelsUi({ phase: 'downloading', gotMB: Math.round(got / 1e6), totalMB: Math.round(total / 1e6) })
      )
      setBeatModelsUi(null)
      // Songs already declared gridless before the models were here are
      // asked once more — the runner re-plans with the real answer. The
      // catalog's next open does this per song anyway; this just does not
      // make the singer reopen every one.
      for (const p of projects ?? []) {
        if (p.doc && Object.keys(p.stems).length > 0) {
          const plan = planAnalysis(p.doc, p.stems, null, true)
          if (plan.beat) void kickAnalysis(p.dir, p.stems)
        }
      }
    } catch (e) {
      setBeatModelsUi({ phase: 'offer' })
      const msg = String(e instanceof Error ? e.message : e)
      if (!msg.includes('cancelled')) Alert.alert('Could not download the beat models', msg)
    }
  }, [projects, kickAnalysis])
  const dismissBeatModels = useCallback(() => {
    setBeatModelsUi(null)
    void setStoredText(BEAT_MODELS_DISMISSED, '1')
  }, [])


  const adoptDone = useCallback(
    async (status: SplitJobStatus): Promise<void> => {
      if (adoptingRef.current) return
      adoptingRef.current = true
      setSplitUi({ phase: 'adopting', project: status.projectDir })
      try {
        await finishSplit(status.projectDir, status.jobDir)
        setSplitUi(null)
        await refresh()
        // Six stems in place — now the beat, the key and the melody, the way
        // the desktop would on its first open. Off the tap's critical path:
        // the card below tracks it, and a song opened meanwhile picks the
        // grid up when it lands.
        void kickAnalysis(status.projectDir, Object.fromEntries(SPLIT_STEMS.map((id) => [id, 'wav'])))
      } catch (e) {
        setSplitUi({
          phase: 'failed',
          project: status.projectDir,
          error: String(e instanceof Error ? e.message : e),
          attempts: 0
        })
      } finally {
        adoptingRef.current = false
      }
    },
    [refresh, kickAnalysis]
  )

  const showFailed = useCallback(async (status: SplitJobStatus, fallbackError: string) => {
    const attempts = await recordFailure(status.srcPath, status.updatedAtMs)
    setSplitUi({
      phase: 'failed',
      project: status.projectDir,
      error: status.error ?? fallbackError,
      attempts
    })
  }, [])

  // One subscription for the screen's life: events only flow while the
  // service lives, and every terminal state is re-checked against the file.
  useEffect(() => {
    const unsubscribe = subscribeSplit(
      (p) => {
        setSplitUi((cur) => {
          if (!cur || (cur.phase !== 'run' && cur.phase !== 'model')) return cur
          const project = cur.project
          if (p.stage === 'decode') {
            return { phase: 'run', project, text: 'Reading the song…', frac: p.frac * 0.05, started: true }
          }
          if (p.stage === 'resample' || p.stage === 'load-model') {
            return { phase: 'run', project, text: 'Warming up…', frac: 0.06, started: true }
          }
          if (p.stage === 'chunk' && p.total > 0) {
            return {
              phase: 'run',
              project,
              text: `Splitting into stems — chunk ${p.done} of ${p.total}`,
              frac: 0.08 + 0.92 * (p.done / p.total),
              started: true
            }
          }
          return cur
        })
      },
      (st) => {
        if (st.state === 'done' || st.state === 'failed') {
          void splitStatus().then((status) => {
            if (!status) return
            if (status.state === 'done') void adoptDone(status)
            else if (status.state === 'failed') void showFailed(status, 'The split failed')
          })
        } else if (st.state === 'cancelled') {
          setSplitUi(null)
        }
      }
    )
    return unsubscribe
  }, [adoptDone, showFailed])

  // Liveness while the card claims "running": the service heartbeats
  // job.json at every stage, so a file frozen past 90 s means the :split
  // process died without a verdict — a relaunch seconds after a kill sees
  // fresh timestamps and would otherwise show progress forever.
  useEffect(() => {
    if (splitUi?.phase !== 'run') return
    const timer = setInterval(() => {
      void splitStatus().then((status) => {
        if (!status) {
          // No job.json at all. A job that was heard from and then left no
          // file cleaned up after itself (a cancel) — the card goes. One
          // never heard from is a start that silently never happened: an
          // Android 15 phone refuses the mediaProcessing service while the
          // app is not visible, and :split died right there before writing
          // a line, leaving "Starting…" for this poll to clear in silence
          // (the first device pass). Say so — the singer asked for a split
          // and did not get one. A Cancel they pressed themselves wins.
          const cur = splitUiRef.current
          if (cur?.phase !== 'run') return
          if (cur.started || cancelPending) {
            setSplitUi((c) => (c?.phase === 'run' ? null : c))
            return
          }
          // The one verdict no event carries — write it down, or a release
          // build's log ends at "start fresh …" and says nothing more.
          log('split', `never started — no job.json since the kick (${cur.project})`, 'warn')
          setSplitUi((c) =>
            c?.phase === 'run'
              ? {
                  phase: 'failed',
                  project: c.project,
                  error: 'The split never started — try again',
                  attempts: 0
                }
              : c
          )
          return
        }
        if (status.state === 'done') void adoptDone(status)
        else if (status.state === 'failed') void showFailed(status, 'The split failed')
        else if (Date.now() - status.updatedAtMs > 90_000) {
          void showFailed(status, 'The split was interrupted')
        } else {
          // A live record is the job's existence, whether or not its events
          // reached us — a later vanished file is then a cancel, not a
          // start that never happened.
          setSplitUi((c) => (c?.phase === 'run' && !c.started ? { ...c, started: true } : c))
        }
      })
    }, 20_000)
    return () => clearInterval(timer)
  }, [splitUi?.phase, cancelPending, adoptDone, showFailed])

  // The durable handoff: a job finished (or died) while the app was away.
  useEffect(() => {
    void splitStatus().then((status) => {
      if (!status) return
      if (status.state === 'done') {
        void adoptDone(status)
      } else if (status.state === 'failed') {
        void showFailed(status, 'The split failed')
      } else if (status.state === 'decoding' || status.state === 'splitting') {
        const fresh = Date.now() - status.updatedAtMs < 90_000
        if (fresh) {
          setSplitUi({
            phase: 'run',
            project: status.projectDir,
            text:
              status.totalChunks > 0
                ? `Splitting into stems — chunk ${status.chunksDone} of ${status.totalChunks}`
                : 'Splitting into stems…',
            frac:
              status.totalChunks > 0 ? 0.08 + 0.92 * (status.chunksDone / status.totalChunks) : 0,
            started: true
          })
        } else {
          // The service died without a verdict (battery pull, lmkd) — the
          // tail makes Resume safe.
          void showFailed(status, 'The split was interrupted')
        }
      }
    })
    // Once, at mount: later states arrive over the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const startSplitFor = useCallback(async (
    dir: string,
    resume: boolean,
    watchdogCapMs = 0 // test seam, threaded through to the service
  ): Promise<void> => {
    try {
      const gate = await splitGate()
      if (!gate.ok) {
        Alert.alert('Splitting needs a bigger phone', gate.reason)
        return
      }
      setCancelPending(false)
      setSplitUi({ phase: 'model', project: dir, gotMB: 0, totalMB: 136 })
      await startProjectSplit(dir, {
        resume,
        watchdogCapMs,
        onModelProgress: (got, total) =>
          setSplitUi((cur) =>
            cur?.phase === 'model'
              ? {
                  phase: 'model',
                  project: dir,
                  gotMB: Math.round(got / 1e6),
                  totalMB: Math.round(total / 1e6)
                }
              : cur
          )
      })
      // The service has the intent; nothing has come back yet. `started`
      // flips on the first event or file — see the liveness poll.
      setSplitUi({ phase: 'run', project: dir, text: 'Starting…', frac: 0, started: false })
    } catch (e) {
      setSplitUi(null)
      const msg = String(e instanceof Error ? e.message : e)
      if (!msg.includes('cancelled')) {
        Alert.alert('Could not start the split', msg)
      }
    }
  }, [])

  /** Can this song be split right now? PHONE LIBRARY ONLY — the adoption
   *  writes through docDirFor, which is the app's own documents root on both
   *  platforms, so splitting a picked-folder song would leave the folder song
   *  untouched and drop a duplicate half-project into This-phone. The offer
   *  used to be confined by living in the phone-only long-press menu; now
   *  that a card renders it, the confinement has to be stated.
   *  Six stems means it already is split; a job in flight owns the engine; a
   *  build without the natives never offers. */
  const canSplit = useCallback(
    (p: ProjectEntry): boolean =>
      mode === 'phone' && splitAvailable() && Object.keys(p.stems).length === 0 && !splitUi,
    [mode, splitUi]
  )

  /** The one place the offer is worded. The card button and the long-press
   *  menu both come here, so they cannot drift apart. */
  const offerSplit = useCallback(
    (p: ProjectEntry) => {
      Alert.alert(
        'Split this song?',
        'The phone separates it into vocals, drums, bass and more — a few minutes of ' +
          'work, and a one-time 136 MB download the first time.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Split', onPress: () => void startSplitFor(p.dir, false) }
        ]
      )
    },
    [startSplitFor]
  )

  const discardSplit = useCallback(() => {
    void cancelSplit()
      .then(() => clearSplitJob())
      .then(() => setSplitUi(null))
      .catch(() => setSplitUi(null))
  }, [])

  // Resume must first ask the file what actually failed: a job that reached
  // DONE and then died during ADOPTION only needs the adoption re-run —
  // handing it back to the service would wipe six finished stems and split
  // from scratch.
  const resumeSplit = useCallback(
    async (project: string): Promise<void> => {
      const status = await splitStatus()
      if (status?.state === 'done') void adoptDone(status)
      else void startSplitFor(project, true)
    },
    [adoptDone, startSplitFor]
  )

  /** Phone-library long-press: this phone owns these projects. */
  const phoneCardMenu = useCallback(
    (p: ProjectEntry) => {
      const buttons: Parameters<typeof Alert.alert>[2] = [
        { text: 'Cancel', style: 'cancel' }
      ]
      if (!p.hasLyrics) {
        buttons.unshift({ text: 'Find lyrics', onPress: () => void findLyricsFor(p) })
      }
      // Six real stems end the offer; a running job means the card owns it;
      // a build without the split natives (iOS until P3) never offers.
      if (canSplit(p)) {
        buttons.unshift({ text: 'Split into stems', onPress: () => offerSplit(p) })
      }
      buttons.unshift({
        text: 'Delete from this phone',
        style: 'destructive',
        onPress: () => {
          Alert.alert('Delete this song?', `"${p.doc.name ?? p.dir}" and its files go away.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Delete',
              style: 'destructive',
              onPress: () => {
                void deleteProject(p.dir)
                  .then(() => refresh())
                  .catch((e) => setError(String(e instanceof Error ? e.message : e)))
              }
            }
          ])
        }
      })
      Alert.alert(p.doc.name ?? p.dir, undefined, buttons)
    },
    [canSplit, findLyricsFor, offerSplit, refresh]
  )

  useEffect(() => {
    if (!TEST) return
    TEST.screen = 'catalog'
    TEST.refresh = refresh
    TEST.openSample = openSample
    TEST.openProject = (dir: string) => {
      const entry = (projects ?? []).find((p) => p.dir === dir)
      return entry ? openEntry(entry) : Promise.reject(new Error(`no project ${dir}`))
    }
    TEST.cancelLoad = cancelLoad
    TEST.openDrive = openDrive
    TEST.selectMode = selectMode
    TEST.libMode = mode
    TEST.setPref = setStoredText
    TEST.getPref = getStoredText
    TEST.projects = (projects ?? []).map((p) => p.dir)
    TEST.listError = error
    TEST.busy = loading?.msg ?? null
    TEST.loadingFrac = loading?.frac ?? null
    TEST.usage = usage
    TEST.offline = offline
    TEST.forget = forget
    TEST.addOpen = addOpen
    TEST.setAddOpen = setAddOpen
    /** Open the real sheet on a seeded file — everything beginAdd does once
     *  the picker has answered (the picker itself needs a finger). Paired
     *  with addSheetShown, this is how a driver proves the sheet is ON SCREEN
     *  and not merely open in state. */
    TEST.openAddSheet = (path: string, name: string, size = 0) => {
      if (TEST) TEST.addSheetShown = false
      setAddSrc({ path, name, size })
      setAddOpen(true)
    }
    TEST.addSongFrom = (path: string, name: string) =>
      addSongHeadless(path, name, sampleRate).then(async (r) => {
        await refresh()
        return r
      })
    TEST.deletePhoneProject = (dir: string) => deleteProject(dir).then(() => refresh())
    TEST.findLyricsFor = (dir: string) => {
      const p = (projects ?? []).find((x) => x.dir === dir)
      return p ? findLyricsFor(p) : Promise.reject(new Error(`no project ${dir}`))
    }
    // Split flow, headless: the same path the card drives. Poll splitUi for
    // phase (never await the whole split over CDP).
    TEST.splitProject = (dir: string, watchdogCapMs = 0) =>
      void startSplitFor(dir, false, watchdogCapMs)
    TEST.resumeSplit = (dir: string) => void resumeSplit(dir)
    TEST.discardSplit = discardSplit
    TEST.splitUi = splitUi
    TEST.analysisUi = analysisUi
    // Phase 4: run the detectors over a phone-library project by hand (the
    // stems as listed) — the on-open path without an open.
    TEST.analyzeProject = (dir: string) => {
      const p = (projects ?? []).find((x) => x.dir === dir)
      if (!p) return false
      void kickAnalysis(dir, p.stems)
      return true
    }
    // Phase 4b: the "better beats" card and its two actions, for the driver
    // that proves the offer appears only when it should and that the
    // download actually wires the models in.
    TEST.beatModelsUi = beatModelsUi
    TEST.fetchBeatModels = () => void fetchBeatModels()
    TEST.dismissBeatModels = dismissBeatModels
  })

  const card = (opts: {
    key: string
    dir: string
    hue: number
    title: string
    meta: React.ReactNode
    right: React.ReactNode
    /** A primary action for this song, shown under the status. Splitting used
     *  to live only in the long-press menu, which is not a place a singer
     *  finds a feature. */
    action?: React.ReactNode
    sample?: boolean
    onPress: () => void
    onLongPress?: () => void
  }): React.JSX.Element => {
    const isLoading = loading?.dir === opts.dir
    return (
      <Pressable
        key={opts.key}
        onPress={opts.onPress}
        onLongPress={opts.onLongPress}
        style={({ pressed }) => [
          s.card,
          opts.sample && s.cardSample,
          isLoading && s.cardLoading,
          pressed && { transform: [{ scale: 0.98 }] }
        ]}
      >
        <StemTile hue={opts.hue} size={56} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle} numberOfLines={1}>
            {opts.title}
          </Text>
          {isLoading ? (
            <Text style={[s.cardMeta, { color: C.amber }]} numberOfLines={1}>
              {loading.msg}
            </Text>
          ) : (
            <Text style={s.cardMeta} numberOfLines={1}>
              {opts.meta}
            </Text>
          )}
        </View>
        {isLoading ? (
          <Pressable hitSlop={10} onPress={cancelLoad} style={s.cancelBtn}>
            <Text style={{ color: white(0.75), fontSize: 13, fontWeight: '700' }}>✕</Text>
          </Pressable>
        ) : (
          <View style={{ alignItems: 'flex-end' }}>
            {opts.right}
            {opts.action}
          </View>
        )}
        {isLoading && (
          <View style={s.progressRail}>
            <View style={[s.progressFill, { width: `${Math.round(loading.frac * 100)}%` }]} />
          </View>
        )}
      </Pressable>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Image source={BG} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <View style={[s.wrap, { paddingTop: insets.top + 6 }]}>
        {/* eyebrow brand row: logo + wordmark tucked beside the cutout */}
        <View style={s.brandRow}>
          <StemTile hue={0} size={26} />
          <Text style={s.brand}>SingZ</Text>
          {/* where the desktop keeps it: in the header, always reachable —
              a log you can only open when things are going well is no use */}
          <Pressable hitSlop={10} style={{ marginLeft: 'auto' }} onPress={() => setLogOpen(true)}>
            <Text style={s.ctxLink}>Log</Text>
          </Pressable>
        </View>
        <Seg
          segments={[
            ...(driveAvailable() ? [{ key: 'gdrive', label: 'Drive', icon: GDRIVE_ICON }] : []),
            { key: 'folder', label: 'Folder', emoji: '📁' },
            {
              key: 'phone',
              label: Platform.OS === 'ios' ? 'This iPhone' : 'This phone',
              emoji: '📱'
            }
          ]}
          active={mode}
          onSelect={(k) => {
            if (k === 'gdrive') void openDrive()
            else selectMode(k as 'folder' | 'phone')
          }}
        />
        <View style={s.ctx}>
          {mode === 'gdrive' &&
            (driveOn ? (
              <>
                <Text style={s.ctxWho} numberOfLines={1}>
                  {offline
                    ? 'No signal — showing your last sync'
                    : (driveEmail ?? 'Signed in to Google Drive')}
                </Text>
                <Text style={s.ctxDot}>·</Text>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    void driveSignOut().then(() => {
                      setDriveOn(false)
                      setDriveEmail(null)
                      void refresh()
                    })
                  }}
                >
                  <Text style={s.ctxLink}>Sign out</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={s.ctxWho} numberOfLines={1}>
                  Your projects, synced from the desktop
                </Text>
                <Text style={s.ctxDot}>·</Text>
                <Pressable hitSlop={8} onPress={() => void driveSignInFlow()}>
                  <Text style={s.ctxLink}>Sign in</Text>
                </Pressable>
              </>
            ))}
          {mode === 'folder' && (
            <>
              <Text style={s.ctxWho} numberOfLines={1}>
                {root?.kind === 'picked' ? root.name : 'No folder picked yet'}
              </Text>
              <Text style={s.ctxDot}>·</Text>
              <Pressable hitSlop={8} onPress={() => void changeFolder()}>
                <Text style={s.ctxLink}>Change…</Text>
              </Pressable>
            </>
          )}
          {mode === 'phone' && (
            <>
              <Text style={s.ctxWho} numberOfLines={1}>
                {Platform.OS === 'ios'
                  ? 'Files you copied onto this iPhone'
                  : 'Files you copied onto this phone'}
              </Text>
              <Text style={s.ctxDot}>·</Text>
              <Pressable hitSlop={8} onPress={() => void beginAdd()}>
                <Text style={s.ctxLink}>Add a song</Text>
              </Pressable>
            </>
          )}
        </View>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 40 + (Platform.OS === 'android' ? insets.bottom : 0) }}
          refreshControl={
            <RefreshControl
              refreshing={pulling}
              tintColor={C.amber}
              colors={[C.amber]}
              onRefresh={() => {
                setPulling(true)
                void refresh(true).finally(() => setPulling(false))
              }}
            />
          }
        >
          {splitUi && (
            <View style={s.splitCard}>
              <Text style={s.splitTitle} numberOfLines={1}>
                {splitUi.project}
              </Text>
              {splitUi.phase === 'model' && (
                <>
                  <Text style={s.splitText}>
                    Downloading the splitter — {splitUi.gotMB} of {splitUi.totalMB} MB, once
                  </Text>
                  <View style={s.splitBarBed}>
                    <View
                      style={[
                        s.splitBar,
                        { width: `${Math.min(100, (splitUi.gotMB / Math.max(1, splitUi.totalMB)) * 100)}%` }
                      ]}
                    />
                  </View>
                </>
              )}
              {splitUi.phase === 'run' && (
                <>
                  <Text style={s.splitText}>{splitUi.text}</Text>
                  <View style={s.splitBarBed}>
                    <View style={[s.splitBar, { width: `${Math.round(splitUi.frac * 100)}%` }]} />
                  </View>
                </>
              )}
              {splitUi.phase === 'adopting' && <Text style={s.splitText}>Finishing up…</Text>}
              {splitUi.phase === 'failed' && (
                <Text style={s.splitText}>
                  {splitUi.attempts >= 2 ? KEEPS_FAILING_COPY : splitUi.error}
                </Text>
              )}
              <View style={s.splitActions}>
                {(splitUi.phase === 'model' || splitUi.phase === 'run') && (
                  <Pressable
                    hitSlop={8}
                    onPress={() =>
                      // No job exists yet in the model phase — the download
                      // is the thing to stop (its reject resets the card).
                      splitUi.phase === 'model'
                        ? void cancelModelDownload(SPLIT_MODEL.file)
                        : (setCancelPending(true), void cancelSplit())
                    }
                  >
                    <Text style={s.ctxLink}>{cancelPending ? 'Stopping…' : 'Cancel'}</Text>
                  </Pressable>
                )}
                {splitUi.phase === 'failed' && (
                  <>
                    <Pressable hitSlop={8} onPress={() => void resumeSplit(splitUi.project)}>
                      <Text style={s.ctxLink}>Resume</Text>
                    </Pressable>
                    <Pressable hitSlop={8} onPress={discardSplit}>
                      <Text style={[s.ctxLink, { color: C.dim }]}>Discard</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </View>
          )}
          {analysisUi && (
            <View style={s.splitCard}>
              <Text style={s.splitTitle} numberOfLines={1}>
                {analysisUi.dir}
              </Text>
              <Text style={s.splitText}>{analysisUi.text}</Text>
              <View style={s.splitBarBed}>
                <View style={[s.splitBar, { width: `${Math.round(analysisUi.frac * 100)}%` }]} />
              </View>
            </View>
          )}
          {beatModelsUi && (
            <View style={s.splitCard}>
              <Text style={s.splitTitle} numberOfLines={1}>
                Better beats
              </Text>
              {beatModelsUi.phase === 'offer' ? (
                <>
                  <Text style={s.splitText}>
                    Download the beat models ({BEAT_MODELS_MB} MB, once) and songs analysed from now on — and any
                    the detector found no beat in — get a grid that holds through quiet intros and rubato the
                    drums alone lose. Songs that already have a grid keep it.
                  </Text>
                  <View style={s.splitActions}>
                    <Pressable hitSlop={8} onPress={() => void fetchBeatModels()}>
                      <Text style={s.ctxLink}>Download</Text>
                    </Pressable>
                    <Pressable hitSlop={8} onPress={dismissBeatModels}>
                      <Text style={[s.ctxLink, { color: C.dim }]}>Not now</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <>
                  <Text style={s.splitText}>
                    Downloading the beat models — {beatModelsUi.gotMB} of {beatModelsUi.totalMB} MB
                  </Text>
                  <View style={s.splitBarBed}>
                    <View
                      style={[
                        s.splitBar,
                        { width: `${Math.min(100, (beatModelsUi.gotMB / Math.max(1, beatModelsUi.totalMB)) * 100)}%` }
                      ]}
                    />
                  </View>
                  <View style={s.splitActions}>
                    <Pressable hitSlop={8} onPress={() => void cancelBeatModels()}>
                      <Text style={s.ctxLink}>Cancel</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </View>
          )}
          {(projects ?? []).map((p) => {
            const downloaded = isDownloaded(p, usage[p.dir])
            const added = addedTracks(p.doc?.settings).length
            return card({
              key: p.dir,
              dir: p.dir,
              hue: Math.abs(p.dir.length * 7 + p.dir.charCodeAt(0)) % 3,
              title: p.doc.name ?? p.dir,
              meta: (
                <>
                  {Object.keys(p.stems).length > 0
                    ? `${Object.keys(p.stems).length} stems`
                    : 'not split yet'}
                  {added > 0 ? ` · ${added} added` : ''}
                  {p.hasLyrics ? ' · lyrics' : ''}
                  {/* The badge means "this is an old WAV project the desktop
                      can shrink". A song this phone split is also WAV — the
                      phone cannot write FLAC yet — and telling the singer to
                      redo it on a computer is the worst possible reward for a
                      five-minute split, so phone-made projects are exempt. */}
                  {mode !== 'phone' && Object.values(p.stems).some((f) => f === 'wav') ? (
                    <Text style={{ color: C.amber }}> · update on desktop</Text>
                  ) : null}
                </>
              ),
              right: (
                <Text style={[s.status, downloaded && s.statusHave]}>
                  {downloaded ? '✓' : p.bytes > 0 ? `☁ ${fmtSize(p.bytes)}` : '☁'}
                </Text>
              ),
              // The whole point of an added song is splitting it, so the offer
              // belongs on the card. hitSlop keeps the tap target honest at
              // this text size, and the press must not also open the song.
              action: canSplit(p) ? (
                <Pressable
                  hitSlop={10}
                  onPress={(e) => {
                    e.stopPropagation()
                    offerSplit(p)
                  }}
                  style={s.splitChip}
                >
                  <Text style={s.splitChipText}>Split</Text>
                </Pressable>
              ) : null,
              onPress: () => void openEntry(p),
              onLongPress: () => (mode === 'phone' ? phoneCardMenu(p) : confirmForget(p))
            })
          })}
          {projects === null && (
            <View style={{ alignItems: 'center', paddingVertical: 36 }}>
              <ActivityIndicator color={C.amber} />
              <Text style={[s.empty, { marginTop: 12 }]}>
                {mode === 'gdrive' ? 'Loading your library from Google Drive…' : 'Loading…'}
              </Text>
            </View>
          )}
          {projects !== null && projects.length === 0 && (
            // Whichever library is open has its OWN next step — and phone mode
            // is where the app starts, so the folder advice was the first
            // thing every new singer read, one line under the Add link that
            // was the actual answer.
            <Text style={s.empty}>
              {mode === 'phone'
                ? Platform.OS === 'ios'
                  ? 'No songs on this iPhone yet. Add one above — it plays straight away, and can be split into stems here.'
                  : 'No songs on this phone yet. Add one above — it plays straight away, and can be split into stems here.'
                : mode === 'gdrive'
                  ? driveOn
                    ? 'Nothing in your Google Drive library yet. Save a song on your computer and it syncs over.'
                    : 'Sign in above to see the songs your computer put in Google Drive.'
                  : Platform.OS === 'ios'
                    ? 'No projects in this folder. Save one on your computer into the shared folder (iCloud Drive/SingZ), or pick a different folder above.'
                    : 'No projects in this folder. Copy project folders from your computer onto this phone, or pick a synced folder above.'}
            </Text>
          )}
          {card({
            key: SAMPLE_DIR,
            dir: SAMPLE_DIR,
            hue: 0,
            title: `Sample — ${SAMPLE_PROJECT.name}`,
            meta: 'bundled · always available',
            right: <Text style={s.status}>✓</Text>,
            sample: true,
            onPress: () => void openSample()
          })}
          {(() => {
            const dirs = Object.keys(usage).filter((d) => usage[d].bytes > 0)
            const total = dirs.reduce((n, d) => n + usage[d].bytes, 0)
            if (total <= 0) return null
            return (
              <View style={s.storage}>
                <Text style={s.storageText}>
                  {dirs.length} song{dirs.length > 1 ? 's' : ''} on this phone · {fmtSize(total)} —
                  playable without internet
                </Text>
                <Pressable hitSlop={8} onPress={() => confirmForgetAll(total)}>
                  <Text style={s.ctxLink}>Free up space</Text>
                </Pressable>
              </View>
            )
          })()}
          {error && <Text style={s.err}>{error}</Text>}
        </ScrollView>
        <LogPanel visible={logOpen} onClose={() => setLogOpen(false)} />
        <AddSongSheet
          visible={addOpen}
          src={addSrc}
          sampleRate={sampleRate}
          // Presented-for-real, and how far it walked: drivers only, written
          // where onStep writes so release pays no render for either. Cleared
          // on close, so no opener can hand a driver a stale true.
          onShown={() => {
            if (TEST) TEST.addSheetShown = true
          }}
          onStep={(k, seconds) => {
            if (TEST) {
              TEST.addSheetStep = k
              TEST.addSheetSecs = seconds
            }
          }}
          onClose={(added) => {
            setAddOpen(false)
            setAddSrc(null)
            if (TEST) TEST.addSheetShown = false
            if (added) void refresh()
          }}
        />
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, paddingHorizontal: 20 },
  splitCard: {
    backgroundColor: C.sheet,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.hairline
  },
  splitTitle: { color: C.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  splitText: { color: C.dim, fontSize: 13, marginBottom: 8 },
  splitBarBed: {
    height: 4,
    borderRadius: 2,
    backgroundColor: white(0.12),
    overflow: 'hidden',
    marginBottom: 8
  },
  splitBar: { height: 4, borderRadius: 2, backgroundColor: C.amber },
  splitChip: {
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: C.amber
  },
  splitChipText: { color: '#1d1204', fontSize: 12, fontWeight: '700' },
  splitActions: { flexDirection: 'row', gap: 18 },
  logSheet: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 20, paddingTop: 60 },
  logHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  logTitle: { color: C.text, fontSize: 20, fontWeight: '700' },
  logRow: { paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ffffff14' },
  logWhen: { color: C.dim, fontSize: 11, marginBottom: 2 },
  logMsg: { color: C.text, fontSize: 13 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 14 },
  brand: { color: C.amber, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  ctx: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 30,
    marginTop: 9,
    marginBottom: 12,
    paddingHorizontal: 2
  },
  ctxWho: { color: white(0.6), fontSize: 12.5, flexShrink: 1 },
  ctxDot: { color: white(0.3), fontSize: 12.5 },
  ctxLink: { color: C.amber, fontSize: 12.5, fontWeight: '800' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 12,
    backgroundColor: white(0.045),
    borderWidth: 1,
    borderColor: white(0.05),
    borderRadius: 17,
    marginBottom: 11,
    overflow: 'hidden'
  },
  cardSample: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: white(0.14)
  },
  cardLoading: { backgroundColor: 'rgba(242,193,78,0.07)', borderColor: 'rgba(242,193,78,0.25)' },
  cardTitle: { color: C.bright, fontSize: 16.5, fontWeight: '800', letterSpacing: -0.2 },
  cardMeta: { color: white(0.42), fontSize: 12.5, marginTop: 3 },
  status: { color: C.faint, fontSize: 12, fontWeight: '600' },
  statusHave: { color: white(0.62) },
  storage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 6,
    paddingHorizontal: 2
  },
  storageText: { color: C.faint, fontSize: 12, flexShrink: 1 },
  cancelBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.btnBg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  progressRail: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: white(0.08)
  },
  progressFill: { height: 3, backgroundColor: C.amber, borderTopRightRadius: 2, borderBottomRightRadius: 2 },
  empty: { color: C.faint, fontSize: 14, lineHeight: 20, marginVertical: 12 },
  err: { color: C.red, fontSize: 13, marginTop: 10 }
})
