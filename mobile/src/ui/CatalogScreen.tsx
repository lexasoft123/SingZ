import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  DeviceEventEmitter,
  Image,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { decodeAudioData } from 'react-native-audio-api'
import { useFocusEffect, useIsFocused } from '@react-navigation/native'
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
import Swipeable from 'react-native-gesture-handler/ReanimatedSwipeable'
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { C, FolderGlyph, LyricsGlyph, PhoneGlyph, RedetectGlyph, SearchGlyph, Seg, splitSongName, StemTile, STEM_TILE_COLORS, TrashGlyph, white } from './bits'
import { TEST } from './testhooks'
import type { AddSongRequest } from './AddSongSheet'
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

/** Songs from which the library gets a search box. Below this the list is
 *  shorter than the screen and the box is clutter over something already
 *  readable; above it, finding a song by scrolling stops working. */
const SEARCH_FROM = 8

interface Loading {
  dir: string
  msg: string
  frac: number
}

/**
 * Sizes as a SINGER reads them, which is why this is not `fmtBytes` from the
 * log. That one goes down to kB because a log line wants the real number;
 * this one floors at 1 MB, so a small song is never offered for deletion as
 * "0 MB". Two formatters on purpose — the log and the screen are different
 * audiences.
 */
/** One optional card action, living in the swipe — icon, not word. */
export interface CardSwipeAction {
  key: string
  label: string
  icon: React.ReactNode
  danger?: boolean
  onPress: () => void
}

/**
 * The revealed swipe actions. A component rather than inline JSX because it
 * needs a hook: at REST the actions must be fully invisible — Android's
 * renderer let the block's rounded corner bleed a 1px rim around the card
 * face's own corner arc, so every card wore an outline it had not earned
 * (measured on the API 36 emulator). Opacity keyed to the swipe progress
 * kills the bleed without touching the geometry. Callers wrap each onPress
 * with the Swipeable's close() so the card snaps shut when an action is
 * taken — a cancelled confirm otherwise left it hanging open.
 */
function SwipeActions({
  progress,
  actions
}: {
  progress: SharedValue<number>
  actions: CardSwipeAction[]
}): React.JSX.Element {
  const style = useAnimatedStyle(() => ({ opacity: progress.value > 0.02 ? 1 : 0 }))
  return (
    <Reanimated.View style={[style, s.swipeActionsRow]}>
      {actions.map((a, i) => (
        <Pressable
          key={a.key}
          onPress={a.onPress}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          style={[
            s.swipeAction,
            a.danger === true && s.swipeActionDanger,
            i === actions.length - 1 && s.swipeActionLast
          ]}
        >
          {a.icon}
        </Pressable>
      ))}
    </Reanimated.View>
  )
}

const fmtSize = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`

/** The card's key · tempo line — singers pick songs by key, and both numbers
 *  are already saved in project.json. Same spelling as the Song sheet's Key
 *  row, compacted to card size. Null when the song has neither. */
const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const keyTempoOf = (doc: ProjectDoc): string | null => {
  const k = doc.settings?.key
  const bpm = doc.settings?.beat?.bpm
  const parts: string[] = []
  if (k) parts.push(`${KEY_NAMES[k.pc % 12]} ${k.minor ? 'min' : 'maj'}`)
  if (typeof bpm === 'number' && bpm > 0) parts.push(`${Math.round(bpm)} bpm`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * The shelf this screen showed last, kept at MODULE scope on purpose.
 *
 * `projects` starts null on every mount and the screen renders a spinner
 * until the listing lands — measured at 75 ms on the sim with four phone
 * projects, more on a real phone — so returning from a song flashed a
 * spinner over an interface the singer had just been looking at ("Catalog
 * page flickering when swiping back from player"). Seeding from the last
 * list paints the shelf immediately and lets the refresh below replace it
 * quietly: the same stale-while-revalidate the Drive path already does
 * deliberately, applied to the mount.
 *
 * Carries its mode, because a folder library's list says nothing about the
 * phone's — and the mode state seeds from it too, so the header and the rows
 * cannot disagree for a frame. What it costs is the entries staying alive —
 * project docs and stem metadata, no audio: the buffers are the player's
 * and `releaseProject` frees those on the way out.
 */
let lastShelf: {
  mode: 'gdrive' | 'folder' | 'phone'
  items: ProjectEntry[]
  /** What each project holds on disk — what the ✓ and the cloud badge read. */
  usage: Record<string, CacheUsage>
  driveOn: boolean
  driveEmail: string | null
} | null = null

export default function CatalogScreen({
  active = true,
  sampleRate,
  onLoaded,
  onOpenLog,
  onOpenAddSong,
  onCloseAddSong
}: {
  active?: boolean
  sampleRate: number
  onLoaded: (p: LoadedProject) => void
  onOpenLog: () => void
  onOpenAddSong: (request: AddSongRequest) => void
  onCloseAddSong: () => void
}): React.JSX.Element {
  const isFocused = useIsFocused()
  const insets = useSafeAreaInsets()
  const [root, setRoot] = useState<RootInfo | null>(null)
  const [projects, setProjects] = useState<ProjectEntry[] | null>(lastShelf?.items ?? null)
  const [loading, setLoading] = useState<Loading | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** What the app was doing when it died last time, if it did.
   *
   *  Kept apart from `error` on purpose. That one slot was carrying six
   *  unrelated things — a crash report, a rejected file pick, a folder-picker
   *  failure, a listing failure, a sign-in failure and a song-load failure —
   *  so whichever spoke last silenced the rest, and nothing cleared it but the
   *  next action that happened to. This one is durable, is the only one worth
   *  acting on, and unlike the others it has somewhere to go: the Log. */
  const [crashNote, setCrashNote] = useState<string | null>(null)
  /** Library source: Drive API / picked folder (SAF, iCloud) / on-device. */
  /* Seeded from the same cache as the shelf, so the source the header names
     and the rows underneath it agree on the very first frame. Within a
     session the last mode IS the mode; the pref read below still runs and
     still wins, it just usually agrees. */
  const [mode, setMode] = useState<'gdrive' | 'folder' | 'phone'>(lastShelf?.mode ?? 'phone')
  /* Seeded with the rows, because they are read TOGETHER: a signed-in Drive
     library remounting with driveOn false renders its own "Sign in to see
     it" banner over the songs for a frame (photographed on the phone). */
  const [driveEmail, setDriveEmail] = useState<string | null>(lastShelf?.driveEmail ?? null)
  const [driveOn, setDriveOn] = useState(lastShelf?.driveOn ?? false)
  const [pulling, setPulling] = useState(false)
  /** What each project holds on this phone: total bytes and the size of every
   *  file present, which is what the ✓ compares against project.json. */
  const [usage, setUsage] = useState<Record<string, CacheUsage>>(lastShelf?.usage ?? {})
  /** The listing on screen is the stored one; the refresh behind it failed. */
  const [offline, setOffline] = useState(false)
  /** The add-a-song sheet (phone library only). The pick happens BEFORE the
   *  native route exists, and that order is the
   *  whole point: iOS presents one view controller at a time, so a sheet that
   *  opened its own picker put two presentations in flight from one commit —
   *  UIKit kept the picker ("waiting for a delayed presention to complete")
   *  and silently refused the sheet, which then ran its whole flow invisibly.
  *  One presentation at a time makes that unrepresentable. */
  const [addOpen, setAddOpen] = useState(false)
  const refreshRef = useRef<(() => Promise<void>) | null>(null)
  const presentAddRef = useRef<(src: PickedFile) => void>(() => {})
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
  /* Which library the newest listing was asked for. The cache below pairs
     items with THIS, not with whatever `mode` happens to be current when the
     items land: a mode switch renders before its refresh resolves, so the
     current value there would file the old library's rows under the new
     library's name. Set by the listing that wins `listSeq`, so an overtaken
     refresh cannot claim the pairing either. */
  const modeOfList = useRef<'gdrive' | 'folder' | 'phone'>(lastShelf?.mode ?? 'phone')

  /** What the singer typed into the library search box (see `shown`). */
  const [query, setQuery] = useState('')

  /** The song's own name, which is what the singer searches and sorts by. */
  const titleOf = (p: ProjectEntry): string => p.doc.name ?? p.dir

  /** The library in a fixed, findable order.
   *
   *  `listProjects` returns whatever the filesystem or Drive handed back, so
   *  the same library came out in a different order on each source and the
   *  same card moved between refreshes. Sorted by name, numeric so "Take 2"
   *  sorts before "Take 10", and case- and accent-insensitive so a lowercase
   *  title does not sink to the bottom. */
  const sorted = useMemo(
    () =>
      (projects ?? [])
        .slice()
        .sort(
          (a, b) =>
            titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true, sensitivity: 'base' }) ||
            // 'base' calls "Ballad" and "ballad" EQUAL, and a stable sort then
            // falls back to whatever order the listing arrived in — which is
            // the one thing this memo exists to stop. The folder name is
            // unique, so it makes the order total.
            a.dir.localeCompare(b.dir)
        ),
    [projects]
  )

  /** What the list actually renders: the sorted library, narrowed to what the
   *  singer is looking for. */
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => (q ? sorted.filter((p) => titleOf(p).toLowerCase().includes(q)) : sorted), [sorted, q])

  /** The floating search bar rides above the keyboard on iOS (Android's
   *  adjustResize moves the whole window, so the absolute bar rises free).
   *  Same measurement AddSongSheet trusts. */
  const [kbInset, setKbInset] = useState(0)
  useEffect(() => {
    if (Platform.OS !== 'ios') return
    const onShow = Keyboard.addListener('keyboardWillChangeFrame', (e) =>
      setKbInset(Math.max(0, e?.endCoordinates?.height ?? 0))
    )
    const onHide = Keyboard.addListener('keyboardWillHide', () => setKbInset(0))
    return () => {
      onShow.remove()
      onHide.remove()
    }
  }, [])

  /* Ready or not — the library's one question: can you sing this now? A
   * split song is ready; an unsplit one states its next step. The groups
   * render headers only when BOTH exist, so a library that is all one thing
   * (every Drive library — the desktop splits before it syncs) stays the
   * flat alphabetical list it always was. Deliberately NOT connectivity-
   * aware: a cloud song counts as ready even offline, because a list that
   * reorders itself when the wifi drops is churn, not honesty — the ☁ and
   * the ✓ already carry the download fact. */
  const isSplit = (p: ProjectEntry): boolean => Object.keys(p.stems).length > 0
  const readyShown = shown.filter(isSplit)
  const pendingShown = shown.filter((p) => !isSplit(p))

  /** The bundled sample is a song in this list like any other, so it answers
   *  to the search too — left unfiltered it sat under two matches looking
   *  like a third. */
  const sampleTitle = `Sample — ${SAMPLE_PROJECT.name}`
  const sampleShown = !q || sampleTitle.toLowerCase().includes(q)

  /** A project's name for the cards that only know its directory. The split
   *  and analysis cards were titling themselves with the folder slug while
   *  every other surface said `doc.name` — during the longest wait in the app,
   *  the song stopped being called by its name. */
  const nameOf = useCallback(
    (dir: string): string => (projects ?? []).find((p) => p.dir === dir)?.doc?.name ?? dir,
    [projects]
  )

  /** `seq` is a listing's `listSeq` ticket: an overtaken refresh must not
   *  write usage, because usage rides in the shelf cache and would be filed
   *  against the winning listing's mode. The delete paths pass nothing —
   *  they answer to a tap, not to a listing. */
  const loadUsage = useCallback(async (seq?: number) => {
    const rows = await cacheUsage()
    if (seq != null && seq !== listSeq.current) return
    const map: Record<string, CacheUsage> = {}
    for (const r of rows) map[r.project] = r
    setUsage(map)
  }, [])

  /** Add a song: the system picker first, the sheet only once a file is in
   *  hand (presenting both at once loses the sheet). Cancelling
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
    presentAddRef.current(picked)
  }, [addOpen])

  const refresh = useCallback(
    async (force = false) => {
      const my = ++listSeq.current
      modeOfList.current = mode
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
          /* Guarded like the setProjects around it, and for a sharper reason
             since the shelf cache existed: these are cache WRITERS now, so an
             overtaken refresh landing one of them would file the library it
             was listing under the name of the library that overtook it. */
          if (my !== listSeq.current) return
          setDriveOn(signed)
          if (!signed) {
            setProjects([])
            return
          }
          const email = await driveAccountEmail()
          if (my !== listSeq.current) return
          setDriveEmail(email)
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
        void loadUsage(my)
      } catch (e) {
        if (my === listSeq.current) {
          setError(String(e instanceof Error ? e.message : e))
          setProjects([])
        }
      }
    },
    [mode, loadUsage]
  )

  refreshRef.current = () => refresh()
  const presentAdd = useCallback(
    (src: PickedFile): void => {
      if (TEST) TEST.addSheetShown = false
      setAddOpen(true)
      onOpenAddSong({
        src,
        sampleRate,
        onShown: () => {
          log('song', 'add-song sheet: on screen')
          if (TEST) TEST.addSheetShown = true
        },
        onStep: (k, seconds) => {
          if (TEST) {
            TEST.addSheetStep = k
            TEST.addSheetSecs = seconds
          }
        },
        onClose: addedDir => {
          setAddOpen(false)
          if (TEST) TEST.addSheetShown = false
          if (addedDir) void refreshRef.current?.()
        }
      })
    },
    [onOpenAddSong, sampleRate]
  )
  presentAddRef.current = presentAdd

  /* Native-stack keeps the catalog mounted underneath the player so the iOS
     back gesture can reveal the real shelf. Re-read it whenever that shelf
     becomes current; the old conditional router got the same refresh from a
     full remount after every song. */
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh])
  )

  /* One writer for the cache above, so no listing path can forget it. The
     four facts are cached together because they are READ together: rows with
     no usage draw every song as a cloud to download, and a signed-in library
     with driveOn false draws a sign-in banner over songs it already has. A
     shelf seeded from three of the four is still a flicker, just a subtler
     one. `offline` deliberately stays out: it is a fact about this second's
     network, and the header would claim "no signal" before anything looked. */
  useEffect(() => {
    if (projects != null)
      lastShelf = { mode: modeOfList.current, items: projects, usage, driveOn, driveEmail }
  }, [projects, usage, driveOn, driveEmail])

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
        setCrashNote(c)
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
          // a query typed against the phone library means nothing against Drive
          setQuery('')
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
      const msg = String(e instanceof Error ? e.message : e)
      // Backing out of the consent screen is a completed choice, not a fault.
      // It was being reported back as red error text ("Google sign-in was
      // cancelled"), telling the singer their own tap had gone wrong. Same
      // idiom as the split and the model download.
      if (!msg.toLowerCase().includes('cancel')) setError(msg)
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
          // plan.compact alone re-queues a v1 WAV project whose detectors
          // are all current — the phone-died-during-the-encode case. The
          // runner re-checks the native probe and does nothing on a build
          // that cannot encode, same cost as any other no-op plan.
          if (plan.beat || plan.key || plan.melody || plan.compact)
            startAnalysis(entry.dir, entry.stems, loaded.lyrics)
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
  useEffect(() => active ? subscribeAnalysis(setAnalysisUi) : undefined, [active])
  // A landed analysis changed a doc on disk; the listing must say so, or the
  // next open of that song would ask for the same analysis again off a stale
  // entry.doc.
  useEffect(() => {
    if (!active) return
    const sub = DeviceEventEmitter.addListener(ANALYSIS_EVENT, (e: AnalysisDone) => {
      if (e.changed) void refresh()
    })
    return () => sub.remove()
  }, [active, refresh])
  const kickAnalysis = useCallback(
    async (dir: string, stems: Record<string, string>, force = false) => {
      let lyrics: LyricsDoc | null = null
      try {
        lyrics = JSON.parse(await readProjectText(dir, 'lyrics.json')) as LyricsDoc
      } catch {
        lyrics = null // no lyrics yet — the grid does without the line cues
      }
      /* `force` belongs to the swipe's redetect ONLY: unforced runs honour
         every stamp and stored no-grid verdict, so on a song with a current
         grid — the normal state — an unforced "detect again" plans nothing
         and shows nothing, the exact silent no-op this file outlawed. */
      startAnalysis(dir, stems, lyrics, force)
    },
    []
  )

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
    if (!active) return
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
  }, [active, mode, projects])
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
  /** 87 MB started from a bare text link, while deleting one song took a
   *  long-press, a menu, a destructive item and a second dialog — the ceremony
   *  ran opposite to the consequence. This is the cheaper half to put right. */
  const confirmBeatModels = useCallback(() => {
    Alert.alert(
      'Download the beat models?',
      `${BEAT_MODELS_MB} MB, once. Every song analysed afterwards uses them.`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Download', onPress: () => void fetchBeatModels() }
      ]
    )
  }, [fetchBeatModels])

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

  // One subscription while this retained scene is visible: events only flow
  // while the service lives, and every terminal state is re-checked against
  // the durable file when the scene becomes active again.
  useEffect(() => {
    if (!active) return
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
  }, [active, adoptDone, showFailed])

  // Liveness while the card claims "running": the service heartbeats
  // job.json at every stage, so a file frozen past 90 s means the :split
  // process died without a verdict — a relaunch seconds after a kill sees
  // fresh timestamps and would otherwise show progress forever.
  useEffect(() => {
    if (!active) return
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
  }, [active, splitUi?.phase, cancelPending, adoptDone, showFailed])

  // The durable handoff: a job finished (or died) while the app was away.
  useEffect(() => {
    if (!active) return
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
    // Recheck whenever this retained scene becomes visible again; while
    // hidden it owns no polling timer or event subscription.
  }, [active, adoptDone, showFailed])

  const startSplitFor = useCallback(async (
    dir: string,
    resume: boolean,
    watchdogCapMs = 0 // test seam, threaded through to the service
  ): Promise<void> => {
    try {
      const gate = await splitGate()
      if (!gate.ok) {
        // Not "needs a bigger phone": the device is not the singer's fault and
        // they cannot act on it. Say what cannot happen and why.
        Alert.alert('This song is too big to split here', gate.reason)
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
      mode === 'phone' && splitAvailable() && Object.keys(p.stems).length === 0,
    [mode]
  )
  /** Whether a split is running for anyone BUT this card: the running card
   *  shows no chip at all (see the card's `action`), so this is what dims
   *  the others with a reason. */
  const splitBusyElsewhere = useCallback(
    (dir: string): boolean => splitUi !== null && splitUi.project !== dir,
    [splitUi]
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
  /** The delete confirm, shared by the ••• menu and the card's swipe —
   *  one dialog, two doors, so the swipe cannot drift a different wording
   *  or a different deletion path over time. */
  const confirmDelete = useCallback(
    (p: ProjectEntry) => {
      Alert.alert(
        'Delete this song?',
        `"${p.doc.name ?? p.dir}" and its files go away.`,
        /* cancel-first, like every other confirm in this file
           (confirmForgetAll, offerSplit, confirmBeatModels). iOS renders
           either order the same, but Android maps a two-button confirm by
           position, and mirroring just this one would put Cancel where the
           others put the action. */
        [
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
        ],
        { cancelable: true }
      )
    },
    [refresh]
  )

  useEffect(() => {
    /* The catalog stays mounted behind Player now. Its background job events
       can still render it, but they must not tell device drivers that the
       visible route changed. useIsFocused flips on the navigation state, not
       on whether a native transition happened to finish painting. The root
       tab can hide the entire Songs navigator while this route remains
       focused, so `active` is the second half of visible ownership. */
    if (!TEST || !isFocused || !active) return
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
    TEST.projects = sorted.map((p) => p.dir)
    TEST.listError = error
    TEST.busy = loading?.msg ?? null
    TEST.loadingFrac = loading?.frac ?? null
    TEST.usage = usage
    TEST.offline = offline
    TEST.forget = forget
    TEST.addOpen = addOpen
    TEST.setAddOpen = (open: boolean) => {
      if (!open && addOpen) onCloseAddSong()
    }
    /** Open the real sheet on a seeded file — everything beginAdd does once
     *  the picker has answered (the picker itself needs a finger). Paired
     *  with addSheetShown, this is how a driver proves the sheet is ON SCREEN
     *  and not merely open in state. */
    TEST.openAddSheet = (path: string, name: string, size = 0) => {
      presentAdd({ path, name, size })
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

  /** Open-row handles by card key: a row that starts LOADING is snapped
   *  shut. `enabled={false}` alone froze an already-open row — a live
   *  Remove beside the cancel ✕ for the whole decode, reachable by
   *  swipe-open-then-tap-the-face. */
  const swipeRefs = useRef<Record<string, { close: () => void } | null>>({})
  useEffect(() => {
    if (loading?.dir != null) swipeRefs.current[loading.dir]?.close()
  }, [loading?.dir])

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
    /** The artist half of an "Artist — Title" name, on its own line — the
     *  one-line title kept eating the song ("Cat Stevens — Fat…"). */
    artist?: string | null
    /** The card's key · tempo line, on the fixed right rail. */
    keyLine?: string | null
    /** All-neutral tile lanes — an unsplit song has no stem colours yet. */
    tileNeutral?: boolean
    /** Ready-tile halo hue (iOS; see StemTile). */
    tileGlow?: string
    /** The card's OPTIONAL actions, all of them, revealed by swipe-left —
     *  required actions are visible buttons on the card (Split), optional
     *  ones live here (delete, redetect, lyrics). The ••• and the long-press
     *  menu are gone: the ••• sat where the swipe's delete lives and read as
     *  one control wearing two meanings on the phone. Screen readers reach
     *  the same actions through accessibilityActions on the card. */
    swipeActions?: CardSwipeAction[] | null
  }): React.JSX.Element => {
    const isLoading = loading?.dir === opts.dir
    const acts = opts.swipeActions ?? []
    const body = (
      <Pressable
        key={opts.key}
        onPress={opts.onPress}
        accessibilityRole="button"
        /* Deliberately NO accessibilityLabel: a Pressable is already the
           accessibility element for the whole card, and an explicit label
           REPLACES the string RN composes from the children — title, meta and
           the ✓/☁ status would all vanish behind the title alone. */
        accessibilityHint="Opens the song."
        /* The swipe's actions, spoken: a screen reader cannot discover a
           swipe-reveal, so every optional action is also a rotor action on
           the card itself. */
        accessibilityActions={acts.map((a) => ({ name: a.key, label: a.label }))}
        onAccessibilityAction={(e) => {
          acts.find((a) => a.key === e.nativeEvent.actionName)?.onPress()
        }}
        style={({ pressed }) => [
          s.card,
          opts.sample && s.cardSample,
          /* A swiped card slides over the action behind it, so its face must
             be OPAQUE — the usual white-alpha fill would show the red
             through. The literal is white(0.045) composited over C.bg. */
          acts.length > 0 && { backgroundColor: '#1f1b17', marginBottom: 0 },
          isLoading && s.cardLoading,
          pressed && { transform: [{ scale: 0.98 }] }
        ]}
      >
        <StemTile hue={opts.hue} size={56} neutral={opts.tileNeutral} glow={opts.tileGlow} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.cardTitle} numberOfLines={1}>
            {opts.title}
          </Text>
          {opts.artist != null && (
            <Text style={s.cardArtist} numberOfLines={1}>
              {opts.artist}
            </Text>
          )}
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
          <Pressable
            hitSlop={10}
            onPress={cancelLoad}
            style={s.cancelBtn}
            accessibilityRole="button"
            accessibilityLabel="Stop opening this song"
          >
            <Text style={{ color: white(0.75), fontSize: 13, fontWeight: '700' }}>✕</Text>
          </Pressable>
        ) : (
          <>
            {/* The right rail is FIXED width and the actions slot below is
                always reserved, so a state fills the card without reshaping
                it — statuses and ••• line up down the whole list. */}
            <View style={s.rail}>
              {opts.right}
              {opts.action}
              {opts.keyLine != null && opts.keyLine !== '' && (
                <Text style={s.keyLine} numberOfLines={1}>
                  {opts.keyLine}
                </Text>
              )}
            </View>
          </>
        )}
        {isLoading && (
          <View style={s.progressRail}>
            <View style={[s.progressFill, { width: `${Math.round(loading.frac * 100)}%` }]} />
          </View>
        )}
      </Pressable>
    )
    if (acts.length === 0) return body
    return (
      <Swipeable
        key={opts.key}
        ref={(m) => {
          swipeRefs.current[opts.key] = m
        }}
        /* A LOADING card must not swipe: the revealed actions landed under
           the cancel ✕ (photographed on the user's phone mid-decode), and
           deleting a song while its stems decode is not a state anyone
           meant. */
        enabled={!isLoading}
        /* Default activation is 10px — inside a real finger's tap jitter, so
           on the phone a plain TAP could fling the row open (the simulator's
           mouse taps are pixel-perfect, which is why it never showed there).
           24px demands a deliberate pull and costs an intentional swipe
           nothing. */
        dragOffsetFromRight={-24}
        overshootRight={false}
        containerStyle={s.swipeRow}
        renderRightActions={(progress, _translation, methods) => (
          <SwipeActions
            progress={progress}
            actions={acts.map((a) => ({
              ...a,
              onPress: () => {
                methods.close()
                a.onPress()
              }
            }))}
          />
        )}
      >
        {body}
      </Swipeable>
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
          <Pressable
            hitSlop={10}
            style={{ marginLeft: 'auto' }}
            onPress={onOpenLog}
            accessibilityRole="button"
            accessibilityLabel="Open the log"
          >
            <Text style={s.ctxLink}>Log</Text>
          </Pressable>
        </View>
        <Seg
          segments={[
            ...(driveAvailable() ? [{ key: 'gdrive', label: 'Drive', icon: GDRIVE_ICON }] : []),
            /* Drawn glyphs, not emoji — the app has already refused emoji
               icons twice (MicGlyph, the ••• gear) for the same reason: an
               emoji in a row of tabs is a colour sticker in a row of icons.
               The Drive mark stays an image: it is a logo, not an emoji. */
            { key: 'folder', label: 'Folder', glyph: (c: string) => <FolderGlyph color={c} /> },
            {
              key: 'phone',
              label: Platform.OS === 'ios' ? 'This iPhone' : 'This phone',
              glyph: (c: string) => <PhoneGlyph color={c} />
            }
          ]}
          active={mode}
          // Every segment just switches segment. Drive used to sign in from
          // here, so tapping a TAB — next to two other tabs, to see what was
          // there — put a Google consent dialog on screen unasked, and the
          // choice was already persisted by the time it was refused. The
          // signed-out Drive view says "Sign in above" and carries its own
          // Sign in link; that is where signing in belongs.
          onSelect={(k) => selectMode(k as 'gdrive' | 'folder' | 'phone')}
        />
        {/* When a source is empty or signed out, the one-line context grows a
            title saying what this source IS — the moment the explanation
            earns its space. Any other time it stays the one-liner; the three
            tabs are three separate libraries, and this is where that is said. */}
        {((): React.JSX.Element => {
          const srcTitle =
            mode === 'gdrive' && !driveOn
              ? 'Your desktop’s library, synced through Drive'
              : mode === 'folder' && root?.kind !== 'picked'
                ? 'A shared folder this phone can read'
                : mode === 'phone' && projects !== null && projects.length === 0
                  ? Platform.OS === 'ios'
                    ? 'Songs added on this iPhone'
                    : 'Songs added on this phone'
                  : null
          const inner = (
            <>
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
                  accessibilityRole="button"
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
                  {/* The line renders under the srcCard title whenever Drive
                      is signed out, so it says the next step, not the title's
                      message again. */}
                  Sign in to see it
                </Text>
                <Text style={s.ctxDot}>·</Text>
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void driveSignInFlow()}>
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
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void changeFolder()}>
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
              <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void beginAdd()}>
                <Text style={s.ctxLink}>Add a song</Text>
              </Pressable>
            </>
          )}
            </>
          )
          return srcTitle != null ? (
            <View style={s.srcCard}>
              <Text style={s.srcTitle}>{srcTitle}</Text>
              <View style={s.ctxIn}>{inner}</View>
            </View>
          ) : (
            <View style={s.ctx}>{inner}</View>
          )
        })()}
        {/* The crash notice, which is durable and actionable, and therefore
            not in the same slot as the transient errors below it. It is the
            most important sentence the app ever writes — it used to render as
            the last child of the ScrollView, below every song and below the
            sample card, and it used to end "please report this" with nowhere
            to report it. Reporting means the Log, so that is what the button
            opens. */}
        {crashNote && (
          <View style={[s.errBox, s.noteBox]}>
            <Text style={[s.err, { color: C.text }]}>
              The last open crashed while {crashNote}.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open the log to report this"
              hitSlop={8}
              onPress={() => {
                onOpenLog()
                setCrashNote(null)
              }}
            >
              <Text style={s.ctxLink}>Report</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Dismiss the crash notice"
              hitSlop={4}
              onPress={() => setCrashNote(null)}
            >
              <Text style={[s.errX, { color: C.dim }]}>✕</Text>
            </Pressable>
          </View>
        )}
        {/* Transient errors sit ABOVE the list, next to the controls that
            cause them. They used to render as the last child of the
            ScrollView, so with a real library they were off-screen entirely.
            Tap to dismiss — nothing else clears them until the next action
            happens to. */}
        {error && (
          <Pressable
            style={s.errBox}
            onPress={() => setError(null)}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`${error}. Tap to dismiss.`}
          >
            <Text style={s.err}>{error}</Text>
            <Text style={s.errX}>✕</Text>
          </Pressable>
        )}
        <ScrollView
          style={{ flex: 1 }}
          /* The indicator drew ON the cards — the scroller sits inside the
             padded wrap, so its edge is the cards' edge, not the screen's
             (photographed on the user's phone). Hidden outright, per the
             user's call. */
          showsVerticalScrollIndicator={false}
          /* Belt and braces against RN's documented default. With a text
             field focused, `keyboardShouldPersistTaps` unset means 'never',
             and ScrollView.js:1487 says in as many words that the first tap
             "should be sent to the scroll view and dismiss the keyboard, then
             the second tap goes to the actual interior view" — i.e. the tap
             that opens the song you just searched for does nothing. It checks
             `TextInputState.currentlyFocusedInput()` GLOBALLY, so the field
             sitting ABOVE this list still arms it, and AddSongSheet.tsx:507
             already carries the same guard for the same reason.
             NOT reproduced here, and the A/B was a real one — API 36
             emulator, soft IME genuinely up, a visible marker in the same edit
             proving the bundle had landed: the first tap opened the song with
             the prop and without it. Kept anyway, because it is the correct
             default for a list under a field and costs nothing: `'handled'`
             only changes what happens to a tap a child DOES handle, so a tap
             on empty list area still dismisses the keyboard. The iOS half is
             simply unmeasured — the simulator boots with the Mac's hardware
             keyboard connected and shows no soft keyboard, and there is no
             `simctl` way to raise one (see CLAUDE.md for the ⌘K that is). */
          keyboardShouldPersistTaps="handled"
          /* The last card must clear the floating search dock as well as the
             home indicator, on both platforms. */
          contentContainerStyle={{ paddingBottom: 76 + insets.bottom }}
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
                {nameOf(splitUi.project)}
              </Text>
              {splitUi.phase === 'model' && (
                <>
                  <Text style={s.splitText}>
                    {/* Downloads are single-flight (models.ts): the splitter
                        waits if the beat models are already coming down, and
                        a bar at 0 that never moves is how a wait reads as a
                        hang. Say which it is. */}
                    {splitUi.gotMB === 0 && beatModelsUi?.phase === 'downloading'
                      ? `Waiting for the beat models to finish — then the splitter (${splitUi.totalMB} MB, once)`
                      : `Downloading the splitter — ${splitUi.gotMB} of ${splitUi.totalMB} MB, once`}
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
                    accessibilityRole="button"
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
                    <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void resumeSplit(splitUi.project)}>
                      <Text style={s.ctxLink}>Resume</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" hitSlop={8} onPress={discardSplit}>
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
                {nameOf(analysisUi.dir)}
              </Text>
              <Text style={s.splitText}>{analysisUi.text}</Text>
              <View style={s.splitBarBed}>
                <View style={[s.splitBar, { width: `${Math.round(analysisUi.frac * 100)}%` }]} />
              </View>
            </View>
          )}
          {/* In-flight work stays at the top, next to the split and
              analysis cards — that is where progress belongs. The OFFER does
              not: see below the library. */}
          {beatModelsUi?.phase === 'downloading' && (
            <View style={s.splitCard}>
              <Text style={s.splitTitle} numberOfLines={1}>
                Better beats
              </Text>
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
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => void cancelBeatModels()}>
                  <Text style={s.ctxLink}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
          {((): React.ReactNode => {
            const renderEntry = (p: ProjectEntry): React.JSX.Element => {
            const downloaded = isDownloaded(p, usage[p.dir])
            const added = addedTracks(p.doc?.settings).length
            const split = isSplit(p)
            const hue = Math.abs(p.dir.length * 7 + p.dir.charCodeAt(0)) % 3
            return card({
              key: p.dir,
              dir: p.dir,
              hue,
              /* A ready song is lit; an unsplit one has no stem colours yet.
                 The tile carrying the state is a colour the meta line does
                 not have to spend words on. */
              tileNeutral: !split,
              tileGlow: split ? STEM_TILE_COLORS[hue][0] : undefined,
              keyLine: split ? keyTempoOf(p.doc) : null,
              title: splitSongName(p.doc.name ?? p.dir).title,
              artist: splitSongName(p.doc.name ?? p.dir).artist,
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
                <Text
                  style={[s.status, downloaded && s.statusHave]}
                  /* A bare glyph carrying the one fact the singer most needs
                     offline: is this song actually on the phone. */
                  accessibilityLabel={
                    downloaded
                      ? 'On this phone'
                      : p.bytes > 0
                        ? `Not downloaded, ${fmtSize(p.bytes)}`
                        : 'Not downloaded'
                  }
                >
                  {downloaded ? '✓' : p.bytes > 0 ? `☁ ${fmtSize(p.bytes)}` : '☁'}
                </Text>
              ),
              // The whole point of an added song is splitting it, so the offer
              // belongs on the card. hitSlop keeps the tap target honest at
              // this text size, and the press must not also open the song.
              /* Nothing at all on the card whose split is RUNNING — not a
                 disabled chip, no chip. `!splitUi` used to live inside
                 canSplit and was doing double duty as the busy guard;
                 splitting that out left this card's chip live, and tapping it
                 restarts the flow: the progress card repaints to "Downloading
                 the splitter — 0 of 136 MB", the liveness poll is torn down,
                 both natives refuse the second job without telling JS, and a
                 job at 70% ends up reading "Starting…" at zero. The progress
                 card above it is already saying everything there is to say. */
              action: canSplit(p) && splitUi?.project !== p.dir ? (
                <Pressable
                  hitSlop={10}
                  disabled={splitBusyElsewhere(p.dir)}
                  onPress={(e) => {
                    e.stopPropagation()
                    offerSplit(p)
                  }}
                  style={[s.splitChip, splitBusyElsewhere(p.dir) && { opacity: 0.4 }]}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: splitBusyElsewhere(p.dir) }}
                  /* Not "while another song is being split": splitUi also sits
                     in its failed phase until Resume or Discard, when nothing
                     is running at all. Word it against what has to happen. */
                  accessibilityLabel={
                    splitBusyElsewhere(p.dir)
                      ? 'Split — unavailable until the current split finishes or is discarded'
                      : `Split ${p.doc.name ?? p.dir} into stems`
                  }
                >
                  <Text style={s.splitChipText}>Split</Text>
                </Pressable>
              ) : null,
              onPress: () => void openEntry(p),
              /* Nothing to offer, nothing offered. A Drive or folder song with
                 nothing downloaded used to take a long-press and return at
                 `if (have <= 0) return` — a gesture with no feedback and no
                 result. Now there is no ••• and no long-press on that card. */
              /* Every OPTIONAL action, in the swipe; a card with none does
                 not swipe at all (a Drive song with nothing downloaded).
                 Order: least destructive nearest the card, the trash at the
                 far edge. The trash still opens the same confirms — the
                 icons are doors, never a second deletion path. */
              swipeActions: ((): CardSwipeAction[] | null => {
                const title = p.doc.name ?? p.dir
                const acts: CardSwipeAction[] = []
                if (mode === 'phone') {
                  if (split) {
                    acts.push({
                      key: 'redetect',
                      label: `Detect the beat again for ${title}`,
                      icon: <RedetectGlyph color={white(0.85)} />,
                      onPress: () => void kickAnalysis(p.dir, p.stems, true)
                    })
                  }
                  if (!p.hasLyrics) {
                    acts.push({
                      key: 'lyrics',
                      label: `Find lyrics for ${title}`,
                      icon: <LyricsGlyph color={white(0.85)} />,
                      onPress: () => void findLyricsFor(p)
                    })
                  }
                  acts.push({
                    key: 'delete',
                    label: `Delete ${title} from this phone`,
                    danger: true,
                    icon: <TrashGlyph color="#1d0f0d" />,
                    onPress: () => confirmDelete(p)
                  })
                } else if ((usage[p.dir]?.bytes ?? 0) > 0) {
                  acts.push({
                    key: 'forget',
                    label: `Remove ${title}'s downloaded files`,
                    danger: true,
                    icon: <TrashGlyph color="#1d0f0d" />,
                    onPress: () => confirmForget(p)
                  })
                }
                return acts.length > 0 ? acts : null
              })()
            })
            }
            /* Headers only when both groups exist — a library that is all
               one thing stays the flat list it always was. The sample joins
               READY: it is bundled, split, and always singable. */
            const grouped = pendingShown.length > 0 && (readyShown.length > 0 || sampleShown)
            return (
              <>
                {grouped && <Text style={s.grp}>Ready</Text>}
                {readyShown.map(renderEntry)}
                {sampleShown &&
                  card({
                    key: SAMPLE_DIR,
                    dir: SAMPLE_DIR,
                    hue: 0,
                    tileGlow: STEM_TILE_COLORS[0][0],
                    /* NOT split: "Sample — Sing with me" would grow a fake
                       artist called Sample. */
                    title: sampleTitle,
                    meta: 'bundled · always available',
                    right: <Text style={s.status}>✓</Text>,
                    sample: true,
                    onPress: () => void openSample()
                  })}
                {grouped && <Text style={s.grp}>Not ready yet</Text>}
                {pendingShown.map(renderEntry)}
              </>
            )
          })()}
          {projects === null && (
            <View style={{ alignItems: 'center', paddingVertical: 36 }}>
              <ActivityIndicator color={C.amber} />
              <Text style={[s.empty, { marginTop: 12 }]}>
                {mode === 'gdrive' ? 'Loading your library from Google Drive…' : 'Loading…'}
              </Text>
            </View>
          )}
          {projects !== null && shown.length === 0 && !sampleShown && (
            <Text style={s.empty}>No song here is called “{query.trim()}”.</Text>
          )}
          {projects !== null && projects.length === 0 && q === '' && (
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
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => confirmForgetAll(total)}>
                  <Text style={s.ctxLink}>Free up space</Text>
                </Pressable>
              </View>
            )
          })()}
          {/* The offer sits BELOW the library. It used to open the screen:
              a heading, six lines of prose and two actions taking the top
              third, above every song the singer owns — on a library of one or
              two songs it WAS the screen. It is a suggestion about a future
              song, so it ranks under the songs that already exist. Copy cut to
              the two facts that decide it; the long version lives in the Song
              sheet, where someone is already asking about the beat. */}
          {beatModelsUi?.phase === 'offer' && (
            <View style={[s.splitCard, { marginTop: 14 }]}>
              <Text style={s.splitTitle} numberOfLines={1}>
                Better beats
              </Text>
              <Text style={s.splitText}>
                An {BEAT_MODELS_MB} MB download, once, that hears the beat through quiet intros and
                rubato the drums alone lose. Songs that already have a grid keep it.
              </Text>
              <View style={s.splitActions}>
                <Pressable accessibilityRole="button" hitSlop={8} onPress={confirmBeatModels}>
                  <Text style={s.ctxLink}>Download</Text>
                </Pressable>
                <Pressable accessibilityRole="button" hitSlop={8} onPress={dismissBeatModels}>
                  <Text style={[s.ctxLink, { color: C.dim }]}>Not now</Text>
                </Pressable>
              </View>
            </View>
          )}
        </ScrollView>
        {/* The search dock: bottom-anchored, floating over the list — the
            modern place for search, and the thumb's shortest reach. Shown
            past SEARCH_FROM songs, but ALWAYS while a query is live:
            deleting a song below the threshold must not take the box away
            with the filter still applied. Real
            glass wants a native blur the app does not carry; a translucent
            raised surface over this wash reads as the material. Rises with
            the keyboard on iOS; Android's adjustResize lifts it for free. */}
        {(sorted.length >= SEARCH_FROM || q !== '') && (
          <View style={[s.searchDock, { bottom: Math.max(insets.bottom, 12) + kbInset }]}>
            <SearchGlyph color={C.dim} />
            <TextInput
              style={s.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Find a song"
              placeholderTextColor={C.dim}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              clearButtonMode="while-editing"
              accessibilityLabel="Find a song by name"
            />
            {/* iOS draws its own clear button inside the field; Android has
                none, and a query with no way out strands the library. */}
            {Platform.OS === 'android' && query.length > 0 && (
              <Pressable
                hitSlop={10}
                onPress={() => setQuery('')}
                accessibilityRole="button"
                accessibilityLabel="Clear the search"
              >
                <Text style={s.searchX}>✕</Text>
              </Pressable>
            )}
          </View>
        )}
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
  splitChipText: { color: C.amberInk, fontSize: 12, fontWeight: '700' },
  splitActions: { flexDirection: 'row', gap: 18 },
  logSheet: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 20, paddingTop: 60 },
  logHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  logTitle: { color: C.text, fontSize: 20, fontWeight: '700' },
  logRow: { paddingVertical: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
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
  cardArtist: { color: white(0.68), fontSize: 13, fontWeight: '600', marginTop: 1 },
  cardMeta: { color: white(0.5), fontSize: 12.5, marginTop: 3 },
  status: { color: C.dim, fontSize: 12, fontWeight: '600' },
  /* The fixed right rail: a state fills the card, it never reshapes it, so
     ✓/☁/Split and the key line line up down the whole list. (The ••• slot
     this once shared the edge with is gone — its width went back to the
     title.) */
  rail: { width: 86, alignItems: 'flex-end', gap: 3 },
  keyLine: {
    color: C.dim,
    fontSize: 10.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums']
  },
  /* Ready / Not ready yet group headers — same voice as the sheets' section
     labels. */
  grp: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 3,
    marginBottom: 10,
    paddingHorizontal: 2
  },
  /* The swipe row: the action paints BEHIND the card and the card slides
     over it — one block, native-style, not a detached button. The container
     carries the card's bottom margin so the revealed red is exactly card
     height. */
  swipeRow: { marginBottom: 11 },
  swipeActionsRow: { flexDirection: 'row', alignItems: 'stretch' },
  swipeAction: {
    width: 64,
    backgroundColor: white(0.14),
    alignItems: 'center',
    justifyContent: 'center'
  },
  swipeActionDanger: { backgroundColor: C.red },
  swipeActionLast: { borderTopRightRadius: 17, borderBottomRightRadius: 17 },
  /* The source descriptor — the one-line context grown a title, on the
     raised surface the sheets use. */
  srcCard: {
    backgroundColor: C.sheet,
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.hairline,
    marginTop: 9,
    marginBottom: 12
  },
  srcTitle: { color: C.text, fontSize: 13.5, fontWeight: '700', marginBottom: 6 },
  ctxIn: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  searchDock: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    borderRadius: 26,
    paddingHorizontal: 18,
    backgroundColor: 'rgba(30,26,21,0.93)',
    borderWidth: 1,
    borderColor: white(0.12),
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
  searchInput: { flex: 1, color: C.text, fontSize: 15, height: '100%' },
  searchX: { color: C.dim, fontSize: 15, fontWeight: '700' },
  statusHave: { color: white(0.62) },
  storage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 6,
    paddingHorizontal: 2
  },
  storageText: { color: C.dim, fontSize: 12, flexShrink: 1 },
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
  empty: { color: C.dim, fontSize: 14, lineHeight: 20, marginVertical: 12 },
  /* The crash notice reads as information rather than alarm — it is about a
     previous session, and the singer has already lived through it. */
  /* gap 18 against Report's hitSlop 8 and the ✕'s 4: without the extra room
     their touch areas overlapped and the ✕, being the later sibling, took a
     near-miss on Report — dismissing the notice instead of opening the Log,
     with the crumb already cleared so it never came back. */
  noteBox: {
    borderColor: C.hairline,
    backgroundColor: white(0.05),
    alignItems: 'center',
    gap: 18
  },
  errBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 10,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,122,92,0.35)',
    backgroundColor: 'rgba(255,122,92,0.10)'
  },
  err: { color: C.red, fontSize: 13, flex: 1, lineHeight: 18 },
  errX: { color: C.red, fontSize: 13, fontWeight: '700' }
})
