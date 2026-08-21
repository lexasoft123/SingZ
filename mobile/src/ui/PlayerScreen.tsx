import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeviceEventEmitter, Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import Animated, {
  runOnUI,
  scrollTo,
  useAnimatedRef,
  useDerivedValue,
  useFrameCallback,
  useScrollOffset,
  useSharedValue
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { MultitrackEngine, TrackState, TrainingSpec } from '../engine'
import { getRouteLatency, getTrimMs, setTrimMs, type RouteLatency } from '../latency'
import {
  ANALYSIS_EVENT,
  analysisPending,
  startAnalysis,
  subscribeAnalysis,
  type AnalysisDone,
  type AnalysisProgress
} from '../analysis/run'
import { BEAT_MODELS_MB, beatModelsStatus, cancelBeatModels, ensureBeatModels } from '../analysis/models'
import { nativeFlacAvailable, nativeMlGridAvailable } from '../analysis/native'
import type { AnalysisStage } from '../analysis/pipeline'
import {
  fmtTime,
  MET_DEFAULTS,
  sanitizeBeatInfo,
  ORIGINAL_LANE_ID,
  sanitizeMetronome,
  sanitizeTraining,
  singMask,
  sweepEnds,
  trainingWindows,
  TRACK_META,
  TRAIN_DEFAULTS,
  type BeatInfo,
  type MetronomeConfig,
  type TrainingConfig
} from '../model'
import { readProjectText, type LoadedProject } from '../projects'
import type { ProjectDoc } from '../model'
import { b, Bar, C, Chip, MixGlyph, RoundBtn, Seg, StemTile, Stepper, white } from './bits'
import { perf } from './perf'
import SkiaLyrics, {
  layoutColumn,
  useLyricFonts,
  type LyricsCue,
  type SkWord
} from './SkiaLyrics'
import { sheetRowState } from './song-sheet-copy'
import { TEST } from './testhooks'

const BG = require('../../assets/bg/player.png')
const SCRIM_TOP = require('../../assets/bg/scrim-top.png')
const SCRIM_BOTTOM = require('../../assets/bg/scrim-bottom.png')

/**
 * Karaoke anticipates: words light a breath BEFORE they are sung so the
 * singer can catch the entry (marking on/after onset reads as lagging).
 */
const LEAD_S = 0.15

/** Lyric column inset, and the runway above it the current line scrolls to. */
const LYR_PAD = 26
const LYR_TOP = 250
const LYR_BOTTOM = 300

export default function PlayerScreen({
  engine,
  project,
  onBack
}: {
  engine: MultitrackEngine
  project: LoadedProject
  onBack: () => void
}): React.JSX.Element {
  const [tracks, setTracks] = useState<TrackState[]>([])
  const [ducked, setDucked] = useState<string[]>([])
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [training, setTraining] = useState(false)
  const [trainCfg, setTrainCfg] = useState<TrainingConfig>(TRAIN_DEFAULTS)
  const [route, setRoute] = useState<RouteLatency | null>(null)
  const [trimMs, setTrim] = useState(0)
  const [sheet, setSheet] = useState<'none' | 'mixer' | 'practice' | 'song'>('none')
  /* ---- the Song sheet: what has been detected, and what can be asked for --
   *
   * The gap this closes: analysis runs invisibly. A song with no grid, a song
   * whose grid is being computed right now, and a song the detector listened
   * to and honestly found no beat in all look identical from the player — and
   * the third is a VERDICT the app stores and never revisits, which is the
   * one most worth being able to see. */
  /* The analysis fields as the DISK has them now, not as they were when this
   * song was opened. `null` until the first re-read; the sheet falls back to
   * the load-time doc, which is right for a song nothing has touched since. */
  const [freshSettings, setFreshSettings] = useState<ProjectDoc['settings'] | null>(null)
  const refreshDoc = useCallback(async () => {
    if (!project.dir) return
    try {
      const doc = JSON.parse(await readProjectText(project.dir, 'project.json')) as ProjectDoc
      setFreshSettings(doc.settings ?? {})
    } catch {
      // The project moved or was deleted under us — the rows keep what they
      // have rather than blanking, and the next open reads the truth.
    }
  }, [project.dir])
  const settings = freshSettings ?? project.doc.settings
  const [modelsHave, setModelsHave] = useState<boolean | null>(null)
  const [modelsGot, setModelsGot] = useState<{ mb: number; totalMb: number } | null>(null)
  /* The stems as the analysis runner wants them (id -> extension). The player
   * is handed decoded lanes, not the file list, so it reads the doc — which
   * names every file the project is made of. Custom lanes are the singer's
   * own audio and are not stems. */
  const stemFiles = useMemo(() => {
    const out: Record<string, string> = {}
    for (const f of Object.keys(project.doc.stemHashes ?? {})) {
      const dot = f.lastIndexOf('.')
      if (dot <= 0) continue
      const id = f.slice(0, dot)
      if (id.startsWith('custom-')) continue
      out[id] = f.slice(dot + 1).toLowerCase()
    }
    return out
  }, [project.doc.stemHashes])
  const insets = useSafeAreaInsets()
  /* Android 15 draws edge-to-edge: keep controls clear of the system bar.
   * iOS keeps its hand-tuned paddings. */
  const navPad = Platform.OS === 'android' ? { paddingBottom: Math.max(30, insets.bottom + 14) } : null
  const sheetPad = Platform.OS === 'android' ? { paddingBottom: Math.max(34, insets.bottom + 18) } : null
  const [dragPos, setDragPos] = useState<number | null>(null)
  /** Key & speed — UI + persistence-ready; audio lands with the pitch engine. */
  const [ktPitch, setKtPitch] = useState(0)
  const [ktTempo, setKtTempo] = useState(100)
  /** Beat track from the project (desktop-saved) + metronome session prefs. */
  const [beatInfo, setBeatInfo] = useState<BeatInfo | null>(null)
  const [met, setMet] = useState<MetronomeConfig>(MET_DEFAULTS)
  const [countInSt, setCountInSt] = useState<{ total: number; done: number; perBar: number } | null>(
    null
  )
  /** Lyric viewport — the canvas is this size and the column scrolls under it. */
  const [view, setView] = useState({ w: 0, h: 0 })
  const lyrW = Math.max(0, view.w - 2 * LYR_PAD)
  /** Width of the training mic, which shares the first row of a sung line. */
  const [micW, setMicW] = useState(0)

  perf.commit()

  const lines = useMemo(() => project.lyrics?.lines ?? [], [project])
  const wordEnds = useMemo(() => sweepEnds(lines), [lines])
  /**
   * Word + sweep window per line, built once. Skia's row layout and its edge
   * worklets key off this array's identity, so handing them a freshly mapped
   * one every commit would tear down and rebuild every mapper twice a second.
   */
  const wordSpecs = useMemo<SkWord[][]>(
    () =>
      lines.map((ln, i) => {
        if (ln.words.length > 0) {
          return ln.words.map((w, j) => ({ w: w.w, s: w.s, e: wordEnds[i][j] }))
        }
        // A line the aligner left without word times still has to wrap and
        // still has to sweep: split it and give each piece a share of the line
        // proportional to its length.
        const parts = ln.text.split(/\s+/).filter(Boolean)
        const chars = parts.reduce((n, p) => n + p.length, 0) || 1
        const span = Math.max(0.05, ln.end - ln.start)
        let t = ln.start
        return parts.map((p) => {
          const s0 = t
          t += (p.length / chars) * span
          return { w: p, s: s0, e: t }
        })
      }),
    [lines, wordEnds]
  )

  /**
   * Playback clock on the UI thread. The 100ms poll resyncs it; between polls
   * the frame callback extrapolates, so the word fill moves every frame while
   * React keeps committing at its own unhurried pace. The rate is derived from
   * consecutive samples rather than read off the engine, so tempo changes,
   * pitch shifting and stalls all land here without this knowing about them.
   */
  const clock = useSharedValue(0)
  const sample = useSharedValue({ seq: 0, pos: 0, rate: 0 })
  const seenSeq = useSharedValue(-1)
  const uiFrames = useSharedValue(0)
  const uiWrites = useSharedValue(0)
  const pendingMs = useSharedValue(0)
  const sinceSample = useSharedValue(0)
  const lastTs = useSharedValue(0)
  const lastSample = useRef({ t: 0, pos: 0 })
  const smoothRate = useRef(0)
  useFrameCallback((info) => {
    'worklet'
    uiFrames.value += 1
    const s0 = sample.value
    if (s0.seq !== seenSeq.value) {
      seenSeq.value = s0.seq
      sinceSample.value = 0
    }
    // dt comes from the timestamp delta, never from timeSincePreviousFrame:
    // that field reads null on some Android runtimes (measured on API 36),
    // and the old `?? 8` fallback then banked 8ms per callback while the real
    // interval was ~1.2ms — the clock ran ~7x fast and sat in the seek-jump
    // branch. Clamped so a stalled or first frame cannot lurch the sweep.
    const prev = lastTs.value
    lastTs.value = info.timestamp
    const frameMs = prev > 0 ? Math.min(100, Math.max(0, info.timestamp - prev)) : 0
    // Android fires this callback ~11x per display frame (measured 695/s on a
    // 60Hz panel) — writing the clock that often re-runs every word's animated
    // style for frames no one can see. Bank the time instead. The threshold is
    // half a 120Hz frame so ProMotion still gets a write every frame; it only
    // ever coalesces callbacks that outrun the display.
    pendingMs.value += frameMs
    if (pendingMs.value < 4) return
    const dt = pendingMs.value / 1000
    pendingMs.value = 0
    sinceSample.value += dt

    // Where the last poll says we should be by now. Snapping the clock onto
    // the raw sample was the bug: the clock free-runs ahead between polls, so
    // every poll yanked it back 20-80ms — a backwards jump ten times a second,
    // which is exactly what "not smooth" looks like on a word 350ms long.
    const want = s0.pos + sinceSample.value * s0.rate
    const err = want - clock.value
    if (err > 0.25 || err < -0.25) {
      clock.value = want // a seek, a stall, or the first sample: jump is right
    } else {
      clock.value += dt * s0.rate + err * 0.15 // otherwise close the gap gently
    }
    uiWrites.value += 1
  })

  /**
   * Everything the screen draws that moves with the playhead: which line is
   * current, which word wears the halo, the count-in tick, and a 2Hz pulse for
   * the clock readout and scrub bar. The word fill is deliberately absent — it
   * lives on the UI thread now, so React has no reason to commit for it.
   */
  const renderKey = useCallback(
    (p: number): string => {
      // No word index in here — word-level visuals are the UI thread's job
      // now, and committing per word was the audible-frame jerk on device.
      const lp = p + LEAD_S
      let li = -1
      for (let i = 0; i < lines.length; i++) if (lines[i].start <= lp + 0.05) li = i
      const next = li + 1 < lines.length ? lines[li + 1] : null
      const cue = next ? Math.ceil(Math.min(next.start - p, 60)) : 0
      return `${li}|${cue}|${Math.round(p * 2)}`
    },
    [lines]
  )
  const lastKey = useRef('')

  const pushPos = useCallback(
    (p: number): void => {
      const now = Date.now()
      const prev = lastSample.current
      const dt = (now - prev.t) / 1000
      let rate = 0
      if (engine.playing && dt > 0.02 && dt < 1) {
        const r = (p - prev.pos) / dt
        // a seek makes this meaningless for one sample — coast at 0 and let
        // the next sample pick the real rate back up
        if (r > 0.1 && r < 3) {
          // Date.now() jitter alone swings this ±6% sample to sample, and the
          // sweep speed rides on it directly — average it down.
          const prevRate = smoothRate.current
          rate = prevRate > 0 ? prevRate * 0.7 + r * 0.3 : r
          smoothRate.current = rate
        }
      }
      if (rate === 0) smoothRate.current = 0
      const jumped = Math.abs(p - prev.pos) > 0.4
      lastSample.current = { t: now, pos: p }
      // the clock always takes the fresh sample — that is what keeps it honest
      sample.value = { seq: sample.value.seq + 1, pos: p, rate }
      const k = renderKey(p)
      if (jumped || k !== lastKey.current) {
        lastKey.current = k
        setPos(p)
      }
    },
    [engine, sample, renderKey]
  )
  const stemIds = useMemo(() => project.stems.map((st) => st.id), [project])
  /**
   * Lane name + color by id. Split stems come from TRACK_META; tracks the
   * singer added on the desktop bring their own, so the mixer shows "Harmony"
   * in its own color rather than the raw `custom-harmony` id.
   */
  const laneMeta = useMemo(() => {
    const map: Record<string, { label: string; color: string }> = {}
    for (const st of project.stems) {
      const meta = TRACK_META[st.id]
      map[st.id] = {
        label: st.label ?? meta?.label ?? st.id,
        color: st.color ?? meta?.color ?? C.dim
      }
    }
    return map
  }, [project])
  // The pre-split original lane is the app's, not the singer's: counting it
  // made an unsplit song read "0 stems · 1 added".
  const addedCount = useMemo(
    () => project.stems.filter((st) => st.custom && st.id !== ORIGINAL_LANE_ID).length,
    [project]
  )
  const originalOnly = useMemo(
    () => project.stems.every((st) => st.custom) && project.stems.length > 0,
    [project]
  )

  /* Feed the engine + apply the project's saved settings. */
  useEffect(() => {
    engine.load(project.stems.map(({ id, buffer }) => ({ id, buffer })))
    const st = project.doc.settings
    if (st) {
      for (const [id, t] of Object.entries(st.tracks ?? {})) {
        engine.setMuted(id, t.muted)
        engine.setSolo(id, t.solo)
        engine.setVolume(id, t.volume)
      }
      const tn = st.training
      if (tn) {
        setTrainCfg(sanitizeTraining(tn))
        if (tn.on === true) setTraining(true)
      }
      setKtPitch(Math.round(st.transpose ?? 0))
      setKtTempo(Math.round((st.tempo ?? 1) * 100))
      setBeatInfo(sanitizeBeatInfo(st.beat))
      setMet(st.metronome ? sanitizeMetronome(st.metronome) : MET_DEFAULTS)
    }
    return () => {
      // unload, not pause: leaving the player must release the stems (see
      // MultitrackEngine.unload) — a paused engine still pins every buffer.
      engine.unload()
    }
  }, [engine, project])

  useEffect(() => {
    return engine.subscribe(() => {
      setTracks(engine.getTrackStates())
      setDucked(engine.duckedStems)
      setPlaying(engine.playing)
      pushPos(engine.position)
      setCountInSt(engine.countInStatus)
    })
  }, [engine, pushPos])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      pushPos(engine.position)
      setCountInSt(engine.countInStatus)
    }, 100)
    return () => clearInterval(t)
  }, [engine, playing, pushPos])

  /* Beat track + metronome prefs -> engine. */
  useEffect(() => {
    engine.setBeats(beatInfo)
  }, [engine, beatInfo])

  /* A grid detected while this song is open lights the metronome up without
   * a reopen — but only THIS song's: the event names the project dir, and a
   * result for a neighbour (queued earlier, landing now) is not ours to
   * apply. Only the phone's own library is ever analysed, and a dir name is
   * unique only within one library — the desktop's cloud-folder "Foo" opened
   * from a picked folder must not wear the phone's "Foo" grid — so the
   * library is checked too. The progress line shows only while it is our
   * song being read. */
  const [analysisAt, setAnalysisAt] = useState<{ text: string; stage: AnalysisStage } | null>(
    null
  )
  const analysisText = analysisAt?.text ?? null
  /** The progress line, but only against the detector it is about. A
   *  project-wide line under `Beat` said "Listening now…" while the KEY
   *  ran — over a hand-tuned grid, wiping both the grid and its promise
   *  that nothing here re-detects over it. */
  const stepAt = (stage: AnalysisStage): string | null =>
    analysisAt?.stage === stage ? analysisAt.text : null

  /* Are the beat models on this phone? Asked of the FILES every time the
   * sheet opens, never cached across opens: the models are a fact about the
   * disk, and a boolean that happened not to flip would freeze the first
   * answer for the session — the mistake the catalog's own offer made once. */
  useEffect(() => {
    if (sheet !== 'song' || !nativeMlGridAvailable()) return
    let alive = true
    void beatModelsStatus().then((st) => {
      if (alive) setModelsHave(st.have)
    })
    return () => {
      alive = false
    }
  }, [sheet])

  /* A hand-made grid is never re-detected (planAnalysis), and the phone has
   * no editor to rebuild one — so the sheet names it and does not offer the
   * button, rather than offering a button that quietly does nothing. */
  const beatManual = settings?.beat?.source === 'manual'
  /* Can the LATTICE run on this song at all? The models being installed is a
   * fact about the phone; this is a fact about the project. The core cannot
   * read FLAC, so a copied desktop project can never have a phone-ml grid —
   * and offering the 87 MB download beside "detect again to use it on this
   * one" would be a promise the pipeline refuses to keep (planAnalysis's
   * `mlNow` makes the same all-WAV test and would answer false forever). */
  const mlPossible =
    Object.keys(stemFiles).length > 0 &&
    Object.values(stemFiles).every((ext) => ext === 'wav' || (ext === 'flac' && nativeFlacAvailable()))
  const canAnalyse =
    project.library === 'phone' && !!project.dir && Object.keys(stemFiles).length > 0 && !beatManual
  /* The detector's own "no beat here" answer, stored under its stamp. Without
   * this the sheet cannot tell a song nothing has read from one that WAS read
   * and honestly came back empty — and the second is the state a singer is
   * most likely to be staring at, wondering why there is no click. */
  const noBeatVerdict = settings?.analysisNone?.beat !== undefined
  const busyHere = !!analysisText || (!!project.dir && analysisPending(project.dir))
  /* Which state the Beat row is in — one decision, so its value and its hint
   * cannot fall through to different leaves. See song-sheet-copy.ts for why
   * the busy case exists at all. */
  const beatRow = sheetRowState({
    step: stepAt('beat'),
    hasGrid: !!beatInfo,
    verdict: noBeatVerdict,
    busy: busyHere
  })
  const keyText = ((): string | null => {
    const k = settings?.key
    if (!k) return null
    const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
    return `${NAMES[k.pc % 12]} ${k.minor ? 'minor' : 'major'}`
  })()
  /* The Key row had the Beat row's bug exactly: the detector stores a "the
   * harmonic bed is silent, there is no key here" verdict, and the row read
   * "Not detected yet" over it — a stored answer displayed as a gap. Same
   * rule, same function. */
  const noKeyVerdict = settings?.analysisNone?.key !== undefined
  const keyRow = sheetRowState({
    step: stepAt('key'),
    hasGrid: !!keyText,
    verdict: noKeyVerdict,
    busy: busyHere
  })
  /* All three rows on one rule. `verdict` is hardcoded false because there is
   * no melody verdict to have: analysisNone is typed {beat, beatMl, key}
   * (model.ts) — the melody is tracked or it is not. So sheetRowState can
   * never return 'verdict' here, which is why the row renders no branch for
   * it; if a melody verdict is ever stored, THIS line is what changes and the
   * branch comes with it. Melody has no blind window either — it commits
   * straight after its own step — so only 'busy' is doing new work, and it is
   * the same 'busy' Key has: during the beat stage both are queued, and until
   * now they said different things about the identical situation. */
  const melodyRow = sheetRowState({
    step: stepAt('melody'),
    hasGrid: !!settings?.melody,
    verdict: false,
    busy: busyHere
  })
  const detectAgain = useCallback(() => {
    if (!project.dir) return
    // FORCED: every stamp says nothing needs doing — that is exactly why the
    // singer is pressing this. Hand-placed bar lines survive; analyzeProject
    // folds them back onto the fresh grid.
    startAnalysis(project.dir, stemFiles, project.lyrics, true)
    setAnalysisAt({ text: 'Getting ready…', stage: 'start' })
  }, [project.dir, project.lyrics, stemFiles])

  const fetchModels = useCallback(async () => {
    setModelsGot({ mb: 0, totalMb: BEAT_MODELS_MB })
    try {
      await ensureBeatModels((got, total) =>
        setModelsGot({ mb: Math.round(got / 1e6), totalMb: Math.round(total / 1e6) })
      )
      setModelsHave(true)
    } catch {
      // A cancel rejects with code "cancelled" and keeps the part-file; any
      // other failure is the same story from here — the card goes back to
      // offering, and the log carries the reason.
      setModelsHave(false)
    } finally {
      setModelsGot(null)
    }
  }, [])
  useEffect(() => {
    const dir = project.dir
    if (!dir || project.library !== 'phone') return
    const sub = DeviceEventEmitter.addListener(ANALYSIS_EVENT, (e: AnalysisDone) => {
      if (e.dir !== dir) return
      if (e.beat) setBeatInfo(sanitizeBeatInfo(e.beat))
      // The Song sheet reads the key, the melody and the "no beat here"
      // verdict off the project doc — which CatalogScreen set once, before
      // this player mounted, and which nothing refreshes while a song is
      // open. So an analysis that lands NOW is invisible to those rows: key
      // and melody sit at "not detected yet" while project.json names both,
      // and a run that came back empty leaves the verdict row saying
      // "not detected yet" instead of the answer the sheet exists to show.
      // The event cannot carry the verdict (AnalysisDone has no `none`), so
      // any write is a reason to re-read the doc.
      if (e.changed) void refreshDoc()
    })
    const unsub = subscribeAnalysis((p: AnalysisProgress | null) =>
      setAnalysisAt(p && p.dir === dir ? { text: p.text, stage: p.stage } : null)
    )
    return () => {
      sub.remove()
      unsub()
    }
  }, [project])

  useEffect(() => {
    engine.setMetronome(met)
  }, [engine, met])

  /* Route-latency compensation (auto + persisted per-route trim). */
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const r = await getRouteLatency()
        const t = await getTrimMs(r.key)
        if (!alive) return
        setRoute(r)
        setTrim(t)
        engine.setDisplayLatency(r.autoSec + t / 1000)
      } catch {
        // no native module — play uncompensated
      }
    }
    void load()
    const sub = AudioManager.addSystemEventListener('routeChange', () => {
      setTimeout(() => void load(), 400)
    })
    return () => {
      alive = false
      sub?.remove()
    }
  }, [engine])

  const applyTrim = useCallback(
    (ms: number) => {
      const clamped = Math.max(-2000, Math.min(2000, Math.round(ms)))
      setTrim(clamped)
      if (route) {
        void setTrimMs(route.key, clamped)
        engine.setDisplayLatency(route.autoSec + clamped / 1000)
      }
    },
    [engine, route]
  )

  /* Training schedule -> engine spec (same derivation as desktop). */
  useEffect(() => {
    if (!training) {
      engine.setTraining(null)
      return
    }
    let spec: TrainingSpec
    if (trainCfg.mode === 'lines' && lines.length > 0) {
      spec = {
        mode: 'windows',
        windows: trainingWindows(lines, trainCfg.hear, trainCfg.sing, engine.duration),
        stems: trainCfg.stems
      }
    } else {
      spec = { mode: 'period', periodSec: trainCfg.periodSec, stems: trainCfg.stems }
    }
    engine.setTraining(spec)
  }, [engine, training, trainCfg, lines])

  const mask = useMemo(
    () =>
      training && trainCfg.mode === 'lines'
        ? singMask(lines.length, trainCfg.hear, trainCfg.sing)
        : null,
    [training, trainCfg, lines.length]
  )

  const lpos = pos + LEAD_S
  const currentLine = useMemo(() => {
    let cur = -1
    for (let i = 0; i < lines.length; i++) if (lines[i].start <= lpos + 0.05) cur = i
    return cur
  }, [lines, lpos])

  /**
   * The whole column, laid out once per song (and per width / mic change).
   * Static by design: the canvas draws from it, the tap targets sit on it and
   * the auto-scroll aims at it, so a line change moves nothing.
   */
  const fonts = useLyricFonts()
  const column = useMemo(
    () =>
      lyrW > 0 && fonts
        ? layoutColumn(wordSpecs, fonts.line, lyrW, {
            top: LYR_TOP,
            indents: mask ? mask.map((m) => (m ? micW : 0)) : undefined
          })
        : { boxes: [], height: 0 },
    [wordSpecs, lyrW, micW, mask, fonts]
  )

  /**
   * An animated ref, and reanimated's own scrollTo. A plain ref on an
   * Animated.ScrollView is NOT the ScrollView — `.scrollTo` is simply absent on
   * it, so the auto-scroll became a silent no-op and the lyrics stopped
   * following the song. (It was cast to keep TypeScript quiet, which is what
   * hid it.)
   */
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  /**
   * Scroll offset on the UI thread — the canvas stays put and the column moves.
   *
   * useScrollOffset, NOT an onScroll handler: reanimated's scrollTo drives the
   * view natively and emits no scroll event, so a handler-fed offset went stale
   * the moment the song scrolled itself. The canvas then drew the column two
   * lines away from where the tap targets actually were — tapping a line seeked
   * to a different one, and the sung line appeared to climb out of its row.
   *
   * And it writes into a value WE own rather than returning its own: the value
   * it hands back does not keep its identity across the ref attaching, so the
   * canvas's mapper captured one nobody was updating any more and drew the
   * column at offset zero however far the song had scrolled.
   */
  const scrollY = useSharedValue(0)
  useScrollOffset(scrollRef, scrollY)
  /**
   * The offset the canvas draws the column at. React state, not the shared
   * value, because Skia does NOT apply a shared value handed to a Group's
   * `transform` — measured: with scrollT.value sitting at exactly
   * [{translateY:-239.64}] the canvas kept drawing at 0, while the same Group
   * takes a plain array fine and shader props take shared values fine. So the
   * offset rides a commit. It is affordable because every line that is not
   * being sung is a memoized node whose props do not change while scrolling —
   * only the group's transform does.
   */
  const [scrollTop, setScrollTop] = useState(0)
  useEffect(() => {
    const b = column.boxes[currentLine]
    if (currentLine >= 0 && b) {
      const to = Math.max(0, b.y - LYR_TOP)
      runOnUI(() => {
        'worklet'
        scrollTo(scrollRef, 0, to, true)
      })()
    }
  }, [currentLine, column])

  const toggleTrainStem = (id: string): void => {
    setTrainCfg((c) => {
      const has = c.stems.includes(id)
      if (has && c.stems.length === 1) return c
      return { ...c, stems: has ? c.stems.filter((x) => x !== id) : [...c.stems, id] }
    })
  }

  /** Mute states the singer had before arming — restored on disarm. */
  const preTrainMutes = useRef<Record<string, boolean> | null>(null)

  const armTraining = (): void => {
    if (!training) {
      // ducks need the train stems live, but remember what was muted
      preTrainMutes.current = Object.fromEntries(
        trainCfg.stems.map((id) => [id, tracks.find((t) => t.id === id)?.muted ?? false])
      )
      for (const id of trainCfg.stems) engine.setMuted(id, false)
    } else if (preTrainMutes.current) {
      for (const [id, m] of Object.entries(preTrainMutes.current)) engine.setMuted(id, m)
      preTrainMutes.current = null
    }
    setTraining(!training)
  }


  useEffect(() => {
    if (!TEST) return
    TEST.screen = 'player'
    TEST.project = project.name
    TEST.beatInfo = beatInfo
    /** PROJECT-WIDE: the line for whatever detector is running, whichever it
     *  is. Never show it, or assert it, against ONE row — doing exactly that
     *  is what put "Listening for the beat" under a hand-tuned grid while the
     *  key was being read. Per-row lines are `songSheet().beatRow` and friends. */
    TEST.analysisText = analysisText
    // The Song sheet, for a driver that wants to see what the singer sees:
    // open it, read the rows it would show, and press its one action.
    TEST.openSongSheet = () => setSheet('song')
    TEST.songSheet = () => ({
      open: sheet === 'song',
      beat: beatInfo
        ? { bpm: beatInfo.bpm, beatsPerBar: beatInfo.beatsPerBar, bars: beatInfo.downbeats?.length ?? 0 }
        : null,
      noBeatVerdict,
      busy: busyHere,
      /** Project-wide — see the warning on TEST.analysisText. A driver that
       *  wants "what does the Beat row say" wants `beatRow`. */
      analysisText,
      /** The detector that line is about, and the line as each row actually
       *  shows it: null on a row whose detector is not the one running. */
      analysisStage: analysisAt?.stage ?? null,
      beatRowState: beatRow,
      keyRowState: keyRow,
      melodyRowState: melodyRow,
      beatRow: stepAt('beat'),
      keyRow: stepAt('key'),
      melodyRow: stepAt('melody'),
      canAnalyse,
      beatManual,
      modelsHave,
      key: keyText,
      melody: !!settings?.melody,
      lyricLines: project.lyrics?.lines?.length ?? 0
    })
    TEST.detectAgain = () => {
      if (!canAnalyse || busyHere) return false
      detectAgain()
      return true
    }
    TEST.armTraining = armTraining
    TEST.trainingOn = training
    TEST.setTrainMode = (mode: 'time' | 'lines') => setTrainCfg((c) => ({ ...c, mode }))
    TEST.showTrainPanel = () => setSheet('practice')
    TEST.openMixer = () => setSheet('mixer')
    TEST.openPractice = () => setSheet('practice')
    TEST.closeSheets = () => setSheet('none')
    TEST.sheet = sheet
    TEST.tapLine = (i: number) => lines[i] && engine.seek(lines[i].start)
    TEST.back = onBack
    TEST.latency = () => ({
      route: route?.label ?? null,
      autoMs: route ? Math.round(route.autoSec * 1000) : null,
      trimMs,
      appliedMs: Math.round(engine.displayLatency * 1000)
    })
    TEST.setTrim = applyTrim
    TEST.showSyncPanel = () => setSheet('practice')
    TEST.perfStart = () => perf.start()
    TEST.perfStop = () => perf.stop()
    /** Column geometry vs where the ScrollView actually is — the canvas and the
     *  tap targets must agree, and only numbers can say whether they do. */
    TEST.lyrDiag = () => ({
      current: currentLine,
      scrollY: scrollY.value,
      lineY: column.boxes[currentLine]?.y ?? null,
      colH: column.height,
      view
    })
    /** Lines with their sweep windows — lets a driver aim at a mid-word instant. */
    TEST.lines = () =>
      lines.map((l, i) => ({
        start: l.start,
        end: l.end,
        words: l.words.map((w, j) => [w.w, w.s, wordEnds[i][j]] as [string, number, number])
      }))
    TEST.clockDiag = () => ({
      pos,
      playing,
      enginePlaying: engine.playing,
      clock: clock.value,
      sample: sample.value
    })
    /**
     * UI-thread frame callbacks since the last call, and how many of those
     * actually moved the clock — the gap is the work the frame gate skips.
     */
    TEST.uiFrames = () => {
      const n = uiFrames.value
      uiFrames.value = 0
      return n
    }
    TEST.uiWrites = () => {
      const n = uiWrites.value
      uiWrites.value = 0
      return n
    }
    /** Lane names/colors as the mixer shows them (added tracks bring their own). */
    TEST.lanes = () =>
      project.stems.map((st) => ({
        id: st.id,
        label: laneMeta[st.id]?.label ?? st.id,
        color: laneMeta[st.id]?.color ?? null,
        custom: st.custom === true,
        seconds: Math.round(st.buffer.duration * 10) / 10
      }))
  })

  /* Key & speed apply live: varispeed sources + master-bus stretch. */
  useEffect(() => {
    engine.setPitchTempo(ktPitch, ktTempo / 100)
  }, [engine, ktPitch, ktTempo])

  const ktBadge: string[] = []
  if (ktPitch !== 0) ktBadge.push(ktPitch > 0 ? `+${ktPitch}♯` : `${ktPitch}♭`)
  if (ktTempo !== 100) ktBadge.push(`${ktTempo}%`)

  /**
   * The count-in above the line the singer is waiting for: dots through the
   * last 3s of a long gap (desktop parity: gap >= 3s, dots = ceil(seconds
   * left)), and before that a plain countdown on a long instrumental. The FIRST
   * line always counts in when there is any runway — play was just pressed and
   * the singer needs orientation even on a quick start. Only one gap can be
   * live at a time, so the column carries one of these, not one per line.
   */
  const cue = useMemo<LyricsCue>(() => {
    for (let i = 0; i < lines.length; i++) {
      const gapStart = i === 0 ? 0 : lines[i - 1].end
      const dt = lines[i].start - pos
      const gapOk = i === 0 ? lines[i].start >= 1.2 : lines[i].start - gapStart >= 3
      const dots = gapOk && dt > 0 && dt <= 3 ? Math.min(3, Math.ceil(dt)) : 0
      const longGap = (i === 0 ? lines[i].start : lines[i].start - gapStart) > 5
      const wait = longGap && dt > 3 && (i === 0 || pos >= gapStart) ? Math.ceil(dt) : 0
      if (dots > 0 || wait > 0) return { line: i, dots, wait }
    }
    return { line: -1, dots: 0, wait: 0 }
  }, [lines, pos])

  /* ------- lyric line coloring ------- */
  const lineColor = (i: number, isSing: boolean): string => {
    if (i === currentLine) return C.bright
    if (isSing) return 'rgba(245,199,88,0.42)'
    if (i < currentLine) return white(0.18)
    return Math.abs(i - currentLine) === 1 ? white(0.34) : white(0.25)
  }

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Image source={BG} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Lyrics. The column is ONE canvas the size of the viewport, held
          still while a transform moves the lines under it — a canvas as tall as
          a real song would be a 13000px surface, past what plenty of these
          phones will allocate. What actually scrolls is a spacer carrying the
          tap targets, so the sweep costs no views at all. */}
      <View
        style={{ flex: 1 }}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout
          if (width !== view.w || height !== view.h)
            setView({ w: Math.round(width), h: Math.round(height) })
        }}
      >
        <Animated.ScrollView
          ref={scrollRef}
          scrollEventThrottle={16}
          onScroll={(e) => setScrollTop(e.nativeEvent.contentOffset.y)}
        >
          <View style={{ height: column.height + LYR_BOTTOM }}>
            {column.boxes.map((b, i) => (
              <Pressable
                key={i}
                onPress={() => engine.seek(lines[i].start)}
                /* The lyrics are painted on a Skia canvas, so there is no text
                   in the tree for a screen reader to find — the whole song's
                   words were silent. These invisible tap targets sit exactly
                   over each line, so they are the natural place to put them. */
                accessibilityRole="button"
                accessibilityLabel={
                  // The explicit label replaces the composed one, so the 🎤
                  // marker rendered inside this same Pressable has to be said
                  // here or it is lost.
                  mask?.[i] === true ? `${lines[i].text}. Your turn.` : lines[i].text
                }
                accessibilityHint="Jump to this line"
                style={{ position: 'absolute', left: LYR_PAD, right: LYR_PAD, top: b.y, height: b.height }}
              >
                {mask?.[i] === true && (
                  <Text
                    style={s.micMark}
                    onLayout={(e) => {
                      const w = Math.round(e.nativeEvent.layout.width)
                      if (w > 0 && w !== micW) setMicW(w)
                    }}
                  >
                    🎤
                  </Text>
                )}
              </Pressable>
            ))}
          </View>
        </Animated.ScrollView>
        {fonts && (
          <SkiaLyrics
            fonts={fonts}
            boxes={column.boxes}
            words={wordSpecs}
            current={currentLine}
            sing={mask}
            color={(i) => lineColor(i, mask?.[i] === true)}
            cue={cue}
            width={view.w}
            height={view.h}
            left={LYR_PAD}
            scrollTop={scrollTop}
            clock={clock}
            lead={LEAD_S}
          />
        )}
        {lines.length === 0 && <Text style={s.noLyrics}>No lyrics in this project yet.</Text>}
      </View>

      {/* header (scrim fades into the lyrics — no hard edge) */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 215 }}
      >
        <Image source={SCRIM_TOP} style={{ width: '100%', height: '100%' }} resizeMode="stretch" />
      </View>
      <View style={s.hdr} pointerEvents="box-none">
        <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to library">
          <Text style={s.back}>‹</Text>
        </Pressable>
        <StemTile hue={0} size={46} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.hTitle} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={s.hSub}>
            SingZ project
            {originalOnly ? ' · not split yet' : ` · ${stemIds.length - addedCount} stems`}
            {addedCount > 0 ? ` · ${addedCount} added` : ''}
          </Text>
        </View>
        {ktBadge.length > 0 && (
          <View style={s.ktBadge}>
            <Text style={s.ktBadgeText}>{ktBadge.join(' · ')}</Text>
          </View>
        )}
        {training && ducked.length > 0 && (
          <View style={s.youChip}>
            <Text style={s.youChipText}>YOU SING 🎤</Text>
          </View>
        )}
        {/* Song sheet. Three dots rather than a gear: a gear glyph has no
            guaranteed text presentation on Android and renders as a colour
            emoji next to a monochrome header. */}
        <Pressable
          onPress={() => setSheet('song')}
          hitSlop={12}
          style={s.songBtn}
          accessibilityRole="button"
          accessibilityLabel="About this song"
        >
          <Text style={s.songBtnText}>•••</Text>
        </Pressable>
      </View>

      {/* footer controls (scrim rises out of the lyrics) */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 360 }}
      >
        <Image source={SCRIM_BOTTOM} style={{ width: '100%', height: '100%' }} resizeMode="stretch" />
      </View>
      <View style={[s.foot, navPad]}>
        {countInSt && (
          <Text
            style={s.countInFoot}
            /* Rendered as a run of ● and ○ characters, which a screen reader
               reads out one bullet at a time. */
            accessibilityLabel={`Count-in, beat ${countInSt.done} of ${countInSt.total}`}
          >
            {Array.from({ length: countInSt.total }, (_, i) =>
              i < countInSt.done ? '●' : '○'
            ).reduce<string[]>((acc, d, i) => {
              if (i > 0 && i % countInSt.perBar === 0) acc.push(' ')
              acc.push(d)
              return acc
            }, []).join('')}
          </Text>
        )}
        <View style={s.scrubRow}>
          <Text style={s.tm}>{fmtTime(dragPos !== null ? dragPos * engine.duration : pos)}</Text>
          <View style={{ flex: 1 }}>
            <Bar
              value={dragPos ?? (engine.duration > 0 ? pos / engine.duration : 0)}
              onChange={setDragPos}
              onCommit={(v) => {
                setDragPos(null)
                engine.seek(v * engine.duration)
              }}
              color="rgba(255,255,255,0.85)"
              height={26}
              label="Position"
              valueText={(v) => fmtTime(v * engine.duration)}
            />
          </View>
          <Text style={[s.tm, { textAlign: 'right' }]}>{fmtTime(engine.duration)}</Text>
        </View>
        <View style={s.btnRow}>
          <RoundBtn onPress={() => setSheet('mixer')} label="Mixer">
            <MixGlyph />
          </RoundBtn>
          <RoundBtn onPress={() => engine.seek(0)} label="Back to start">
            {/* ︎ keeps the glyph monochrome (no emoji rendering) */}
            <Text style={s.toStartText}>{'⏮︎'}</Text>
          </RoundBtn>
          <RoundBtn onPress={() => engine.seekBy(-5)} label="Back 5 seconds">
            <Text style={s.skipText}>−5s</Text>
          </RoundBtn>
          <Pressable
            onPress={() => engine.toggle()}
            style={s.play}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}
          >
            <Text style={s.playText}>{playing ? '❚❚' : '▶'}</Text>
          </Pressable>
          <RoundBtn onPress={() => engine.seekBy(5)} label="Forward 5 seconds">
            <Text style={s.skipText}>+5s</Text>
          </RoundBtn>
          <RoundBtn onPress={() => setSheet('practice')} label="Practice">
            <Text style={{ fontSize: 19 }}>🎤</Text>
          </RoundBtn>
        </View>
      </View>

      {/* ---------- Mixer sheet ---------- */}
      <Modal
        visible={sheet === 'mixer'}
        transparent
        animationType="slide"
        onRequestClose={() => setSheet('none')}
      >
        <Pressable
          style={b.sheetWrap}
          onPress={() => setSheet('none')}
          /* Touch handler only. Left accessible it becomes ONE element over the
             whole modal reading "Close, button", and everything inside — the
             faders, the chips, the steppers — is unreachable behind it. The
             two-finger escape gesture below is the screen-reader way out. */
          accessible={false}
        >
          <Pressable
            style={[b.sheet, sheetPad]}
            onPress={() => {}}
            accessible={false}
            onAccessibilityEscape={() => setSheet('none')}
          >
            <View style={b.grab} />
            <Text style={b.sheetTitle}>Mixer</Text>
            {/* The lane rows had no scroll container at all, so past roughly a
                dozen lanes they clipped with no way to reach them — and the
                44 pt fader targets below bring that cliff closer. */}
            <ScrollView>
            {tracks.map((t) => {
              const meta = laneMeta[t.id] ?? TRACK_META[t.id] ?? { label: t.id, color: C.dim }
              const isDucked = ducked.includes(t.id)
              return (
                <View key={t.id} style={s.mixRow}>
                  <View style={[s.dot, { backgroundColor: meta.color }]} />
                  <Text style={s.mixName} numberOfLines={1}>
                    {meta.label}
                  </Text>
                  {isDucked && (
                    <View style={[s.youPill, { backgroundColor: meta.color }]}>
                      <Text style={s.youPillText}>your turn</Text>
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Bar
                      value={t.volume}
                      onChange={(v) => engine.setVolume(t.id, v)}
                      color={meta.color}
                      height={22}
                      track="rgba(255,255,255,0.14)"
                      label={`${meta.label} volume`}
                    />
                  </View>
                  <Pressable
                    hitSlop={4}
                    onPress={() => engine.setMuted(t.id, !t.muted)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mute ${meta.label}`}
                    accessibilityState={{ selected: t.muted }}
                    style={[s.msBtn, t.muted && { backgroundColor: C.red, borderColor: C.red }]}
                  >
                    <Text style={[s.msText, t.muted && { color: '#1d0f0d' }]}>M</Text>
                  </Pressable>
                  <Pressable
                    hitSlop={4}
                    onPress={() => engine.setSolo(t.id, !t.solo)}
                    accessibilityRole="button"
                    accessibilityLabel={`Solo ${meta.label}`}
                    accessibilityState={{ selected: t.solo }}
                    style={[s.msBtn, t.solo && { backgroundColor: C.amber, borderColor: C.amber }]}
                  >
                    <Text style={[s.msText, t.solo && { color: C.amberInk }]}>S</Text>
                  </Pressable>
                </View>
              )
            })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---------- Song sheet: what is known about this song ---------- */}
      <Modal
        visible={sheet === 'song'}
        transparent
        animationType="slide"
        onRequestClose={() => setSheet('none')}
      >
        <Pressable
          style={b.sheetWrap}
          onPress={() => setSheet('none')}
          /* Touch handler only. Left accessible it becomes ONE element over the
             whole modal reading "Close, button", and everything inside — the
             faders, the chips, the steppers — is unreachable behind it. The
             two-finger escape gesture below is the screen-reader way out. */
          accessible={false}
        >
          <Pressable
            style={[b.sheet, sheetPad]}
            onPress={() => {}}
            accessible={false}
            onAccessibilityEscape={() => setSheet('none')}
          >
            <View style={b.grab} />
            <Text style={b.sheetTitle}>{project.name}</Text>
            <ScrollView>
              <View style={[b.sec, b.secFirst]}>
                <Text style={b.secLab}>Beat</Text>
                <Text style={s.songVal}>
                  {beatRow === 'progress'
                    ? stepAt('beat')
                    : beatRow === 'grid' && beatInfo
                      ? `${Math.round(beatInfo.bpm)} bpm · ${meterName(beatInfo.beatsPerBar)} · ` +
                        `${beatInfo.downbeats?.length ?? 0} bars`
                      : beatRow === 'verdict'
                        ? 'No beat in these drums'
                        : beatRow === 'busy'
                          ? 'Reading the song…'
                          : 'Not detected yet'}
                </Text>
                <Text style={b.hint}>
                  {beatRow === 'progress'
                    ? 'Listening now — the click and the count-in pick the beat up the moment it is found.'
                    : beatRow === 'grid'
                      ? (beatManual
                          ? 'Hand-tuned on the computer — nothing here will re-detect over it. '
                          : settings?.beat?.userBars?.length
                            ? 'Your own bar lines are on this grid and stay on it. '
                            : '') +
                        'The click, the count-in and the bar lines all follow this.'
                      : beatRow === 'verdict'
                        ? 'The detector listened and found no steady beat it would put a click on — ' +
                          'a free-time or drumless song. That answer is remembered, so opening the song ' +
                          'again does not read the stems for nothing.' +
                          // Nothing positive can be said here. This state needs
                          // stepAt('beat') to be null, so the stage is 'start', 'key' or
                          // 'melody' — and on the two paths that actually reach it the
                          // beat is NOT being asked: a drumless song whose verdict was
                          // just stored mid-run (the melody still has a minute to go),
                          // and any later unforced run, where a bound verdict makes
                          // plan.beat false outright. Only drop the invitation, which is
                          // all that was wrong: the chip beside this already says
                          // "Detecting…".
                          (busyHere ? '' : ' Detect again to ask once more.')
                        : beatRow === 'busy'
                          ? 'Being read right now — the grid is written after the key is ' +
                            'read, so this row fills in a moment after the beat itself is found.'
                          : canAnalyse
                            ? 'Nothing has read the stems yet.'
                            : // Whether the song is SPLIT is a fact about its
                              // lanes, which is what the header says two lines
                              // up ("6 stems"). This asked stemFiles instead —
                              // derived from doc.stemHashes — and the bundled
                              // sample's project.json has no stemHashes at all,
                              // so the one song every new singer opens first
                              // announced "Not split yet" beside its own six
                              // lanes and its six-lane mixer. originalOnly is
                              // the signal the header already trusts.
                              originalOnly
                              ? 'Not split yet — the beat is read from the drums, so it waits for the split.'
                              : 'Songs from the computer arrive with their beat already in them.'}
                </Text>
                {canAnalyse && !busyHere && (
                  <Text style={b.hint}>
                    {mlPossible
                      ? 'Reading the stems takes a few seconds; the melody takes about a minute.'
                      : 'This song\'s stems are FLAC and this build reads them in JavaScript — ' +
                        'about a minute for the beat and another for the melody.'}
                  </Text>
                )}
                {canAnalyse && (
                  <View style={[b.segs, { marginTop: 12 }]}>
                    <Chip
                      label={busyHere ? 'Detecting…' : 'Detect again'}
                      active={busyHere}
                      onPress={() => {
                        if (!busyHere) detectAgain()
                      }}
                    />
                  </View>
                )}
              </View>

              {canAnalyse && mlPossible && nativeMlGridAvailable() && (
                <View style={b.sec}>
                  <Text style={b.secLab}>Better beats</Text>
                  <Text style={s.songVal}>
                    {modelsGot
                      ? `Downloading — ${modelsGot.mb} of ${modelsGot.totalMb} MB`
                      : modelsHave === true
                        ? 'On this phone'
                        : modelsHave === false
                          ? `Not downloaded — ${BEAT_MODELS_MB} MB`
                          : 'Checking…'}
                  </Text>
                  <Text style={b.hint}>
                    A neural model that hears the beat through drumless intros and rubato the
                    drums-first reader loses. Downloaded once, used by every song afterwards.
                    {modelsHave === true ? ' Detect again to use it on this one.' : ''}
                  </Text>
                  <View style={[b.segs, { marginTop: 12 }]}>
                    {modelsGot ? (
                      <Chip label="Cancel" active={false} onPress={() => void cancelBeatModels()} />
                    ) : modelsHave === false ? (
                      <Chip
                        label={`Download ${BEAT_MODELS_MB} MB`}
                        active={false}
                        onPress={() => void fetchModels()}
                      />
                    ) : null}
                  </View>
                </View>
              )}

              <View style={b.sec}>
                <Text style={b.secLab}>Key</Text>
                <Text style={s.songVal}>
                  {keyRow === 'progress'
                    ? stepAt('key')
                    : keyRow === 'grid'
                      ? keyText
                      : keyRow === 'verdict'
                        ? 'No key in these stems'
                        : keyRow === 'busy'
                          ? 'Reading the song…'
                          : 'Not detected yet'}
                </Text>
                {keyRow === 'verdict' && (
                  <Text style={b.hint}>
                    The harmony the key is read from — the guitar, piano and bass lanes —
                    is silent here, so there is nothing to read it off. That answer is
                    remembered rather than re-read on every open.
                  </Text>
                )}
              </View>
              <View style={b.sec}>
                <Text style={b.secLab}>Melody</Text>
                <Text style={s.songVal}>
                  {melodyRow === 'progress'
                    ? stepAt('melody')
                    : melodyRow === 'grid'
                      ? 'Tracked from the vocals'
                      : melodyRow === 'busy'
                        ? 'Reading the song…'
                        : 'Not tracked yet'}
                </Text>
                <Text style={b.hint}>
                  The sung line under the lyrics, and what the pitch strip draws.
                </Text>
              </View>
              <View style={b.sec}>
                <Text style={b.secLab}>Lyrics</Text>
                <Text style={s.songVal}>
                  {project.lyrics?.lines?.length
                    ? `${project.lyrics.lines.length} lines` +
                      (project.lyrics.lines.some((l) => (l.words?.length ?? 0) > 0)
                        ? ' · word timings'
                        : ' · line timings only')
                    : 'None'}
                </Text>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ---------- Practice sheet ---------- */}
      <Modal
        visible={sheet === 'practice'}
        transparent
        animationType="slide"
        onRequestClose={() => setSheet('none')}
      >
        <Pressable
          style={b.sheetWrap}
          onPress={() => setSheet('none')}
          /* Touch handler only. Left accessible it becomes ONE element over the
             whole modal reading "Close, button", and everything inside — the
             faders, the chips, the steppers — is unreachable behind it. The
             two-finger escape gesture below is the screen-reader way out. */
          accessible={false}
        >
          <Pressable
            style={[b.sheet, sheetPad]}
            onPress={() => {}}
            accessible={false}
            onAccessibilityEscape={() => setSheet('none')}
          >
            <ScrollView bounces={false}>
              <View style={b.grab} />
              <Text style={b.sheetTitle}>Practice</Text>

              <View style={[b.sec, b.secFirst]}>
                <Text style={b.secLab}>Key & speed</Text>
                <Stepper
                  label="Pitch"
                  valueText={`${ktPitch > 0 ? '+' : ''}${ktPitch} st`}
                  onStep={(d) => setKtPitch((v) => Math.max(-12, Math.min(12, v + d)))}
                />
                <Stepper
                  label="Tempo"
                  valueText={`${ktTempo}%`}
                  onStep={(d) => setKtTempo((v) => Math.max(50, Math.min(150, v + d * 5)))}
                />
                <View style={[b.segs, { marginTop: 12 }]}>
                  {(ktPitch !== 0 || ktTempo !== 100) && (
                    <Chip
                      label="Reset"
                      active={false}
                      onPress={() => {
                        setKtPitch(0)
                        setKtTempo(100)
                      }}
                    />
                  )}
                </View>
                <Text style={b.hint}>
                  Pitch shifts the key without changing speed; tempo changes speed without
                  changing pitch. Applied live to playback.
                </Text>
              </View>

              <View style={b.sec}>
                <Text style={b.secLab}>Metronome</Text>
                {/* Three different control semantics used to share one wrapping
                    row of identical amber pills: a Click toggle, a three-way
                    count-in choice, and an Accent toggle. Nothing told the
                    singer that tapping "1 bar" clears "No count-in" while
                    tapping "Accent on" clears nothing.

                    The exclusive choice is a Seg now — it already looks like a
                    picker with one winner. The toggles keep the pill shape and
                    sit on their own row, and they are named for the THING
                    rather than its state: a chip reading "Click off" while
                    unlit made the label and the highlight two answers to the
                    same question. Lit means on, everywhere on this sheet. */}
                <Seg
                  segments={[
                    { key: '0', label: 'No count-in' },
                    { key: '1', label: beatInfo ? '1 bar' : '3 s' },
                    { key: '2', label: beatInfo ? '2 bars' : '6 s' }
                  ]}
                  active={String(met.countInBars)}
                  onSelect={(k) => setMet((m) => ({ ...m, countInBars: Number(k) }))}
                />
                <View style={[b.segs, { marginTop: 10 }]}>
                  {beatInfo != null && (
                    <Chip
                      label="Click"
                      active={met.click}
                      onPress={() => setMet((m) => ({ ...m, click: !m.click }))}
                    />
                  )}
                  <Chip
                    label="Accent"
                    active={met.accent}
                    onPress={() => setMet((m) => ({ ...m, accent: !m.accent }))}
                  />
                </View>
                <Stepper
                  label="Loudness"
                  valueText={`${Math.round(met.volume * 100)}%`}
                  onStep={(d) => {
                    setMet((m) => ({
                      ...m,
                      volume: Math.max(0, Math.min(1, m.volume + d * 0.1))
                    }))
                    engine.previewClick(met.accent)
                  }}
                />
                <Text style={b.hint}>
                  {beatInfo
                    ? `${Math.round(beatInfo.bpm)} bpm from the project — clicks and the ` +
                      `count-in follow the song's own beat, drift and all.`
                    : stepAt('beat')
                      ? `${stepAt('beat')} — the click and the count-in pick the beat up ` +
                        'the moment it is found.'
                      : busyHere
                        ? 'The song is being read now — the click and the count-in pick the ' +
                          'beat up the moment it lands.'
                        : project.library === 'phone'
                          ? 'No beat track — the count-in ticks once a second before playback ' +
                            'starts. If the song has a steady beat, opening it here reads one ' +
                            'from the drums once it is split.'
                          : 'No beat track — the count-in ticks once a second before playback ' +
                            'starts. If the song has a steady beat, opening it on desktop reads ' +
                            'one from the drums.'}
                </Text>
              </View>

              <View style={b.sec}>
                <Text style={b.secLab}>Vocal training</Text>
                {/* Same split as the metronome. "Off · By time · By lyric
                    lines" read as one three-way choice, so with training OFF
                    and the mode set to lines the sheet lit "By lyric lines" —
                    which says the opposite of the truth. The switch is a
                    toggle and stands alone; the mode is a picker. */}
                <View style={b.segs}>
                  <Chip label="Training" active={training} onPress={armTraining} />
                </View>
                <View style={{ marginTop: 10 }}>
                  <Seg
                    segments={[
                      { key: 'time', label: 'By time' },
                      { key: 'lines', label: 'By lyric lines' }
                    ]}
                    active={trainCfg.mode}
                    onSelect={(k) => setTrainCfg((c) => ({ ...c, mode: k as 'time' | 'lines' }))}
                  />
                </View>
                {trainCfg.mode === 'time' ? (
                  <Stepper
                    label="Interval"
                    valueText={`${trainCfg.periodSec} s`}
                    onStep={(d) =>
                      setTrainCfg((c) => ({
                        ...c,
                        periodSec: Math.max(5, Math.min(60, c.periodSec + d * 5))
                      }))
                    }
                  />
                ) : (
                  <>
                    <Stepper
                      label="Hear"
                      valueText={String(trainCfg.hear)}
                      onStep={(d) =>
                        setTrainCfg((c) => ({ ...c, hear: Math.max(1, Math.min(8, c.hear + d)) }))
                      }
                    />
                    <Stepper
                      label="Sing"
                      valueText={String(trainCfg.sing)}
                      onStep={(d) =>
                        setTrainCfg((c) => ({ ...c, sing: Math.max(1, Math.min(8, c.sing + d)) }))
                      }
                    />
                  </>
                )}
                <Text style={b.hint}>
                  {trainCfg.mode === 'time'
                    ? `Guide plays ${trainCfg.periodSec} s, then you take the next ${trainCfg.periodSec} s.`
                    : `Hear ${trainCfg.hear} line${trainCfg.hear > 1 ? 's' : ''}, then sing ${trainCfg.sing} on your own — marked 🎤 in the lyrics.`}
                </Text>
                {/* These decide WHICH lanes drop out when it is your turn, and
                    they arrived with no label at all — a row of lane names
                    under a hint about line counts, which reads as decoration.
                    Multi-select toggles, so they stay pills. */}
                <Text style={[b.hint, { marginTop: 14, marginBottom: 2 }]}>
                  Lanes that drop out when you sing:
                </Text>
                <View style={[b.segs, { marginTop: 6 }]}>
                  {stemIds.map((id) => (
                    <Chip
                      key={id}
                      label={laneMeta[id]?.label ?? TRACK_META[id]?.label ?? id}
                      active={trainCfg.stems.includes(id)}
                      onPress={() => toggleTrainStem(id)}
                    />
                  ))}
                </View>
              </View>

              <View style={b.sec}>
                <Text style={b.secLab}>
                  Lyric timing{route ? ` · ${route.label}, auto ${Math.round(route.autoSec * 1000)} ms` : ''}
                </Text>
                <Stepper
                  label="Trim"
                  valueText={String(trimMs)}
                  suffix="ms"
                  onStep={(d) => applyTrim(trimMs + d * 25)}
                />
                <Text style={b.hint}>
                  Highlights are shifted {Math.round(engine.displayLatency * 1000)} ms to match what
                  you hear. If words light up before you hear them (car audio, Bluetooth), add more.
                </Text>
                {trimMs !== 0 && (
                  <View style={[b.segs, { marginTop: 10 }]}>
                    <Chip label="Reset" active={false} onPress={() => applyTrim(0)} />
                  </View>
                )}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  )
}

/** How the detector's `beatsPerBar` is written on a page. Six is the compound
 *  meter counted in six — 6/8, not 6/4 (analysis.ts:334); everything else is
 *  over a quarter note, which covers the 2/4-through-7/4 range the detector
 *  can emit. */
const meterName = (bpb: number): string => (bpb === 6 ? '6/8' : `${bpb}/4`)

const s = StyleSheet.create({
  songBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: white(0.2),
    alignItems: 'center',
    justifyContent: 'center'
  },
  // The dots sit optically low in the box; lift them rather than centre them.
  songBtnText: { color: white(0.72), fontSize: 15, fontWeight: '800', marginTop: -3 },
  songVal: { color: C.bright, fontSize: 16, fontWeight: '700' },
  hdr: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 58,
    paddingHorizontal: 18,
    paddingBottom: 14
  },
  back: { color: white(0.85), fontSize: 30, fontWeight: '600', paddingRight: 4, marginTop: -4 },
  hTitle: { color: C.bright, fontSize: 15.5, fontWeight: '700' },
  hSub: { color: C.dim, fontSize: 12.5, marginTop: 1 },
  ktBadge: { backgroundColor: C.btnBg, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  ktBadgeText: { color: white(0.8), fontSize: 11.5, fontWeight: '800', letterSpacing: 0.2 },
  youChip: { backgroundColor: C.amber, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 5 },
  youChipText: { color: C.amberInk, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.2 },

  /* the training mic, sharing the first row of a sung line with the canvas —
     the only lyric glyph left in RN, because a system face has no emoji */
  micMark: { position: 'absolute', left: 0, top: 0, fontSize: 19, lineHeight: 37 },
  /* metronome count-in: dots fill beat by beat above the scrubber */
  countInFoot: {
    color: C.amber,
    fontSize: 13,
    letterSpacing: 6,
    textAlign: 'center',
    marginBottom: 8,
    textShadowColor: 'rgba(255,160,40,0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10
  },
  countIn: {
    color: C.amber,
    fontSize: 11,
    letterSpacing: 5,
    marginBottom: 4,
    textShadowColor: 'rgba(255,160,40,0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10
  },
  noLyrics: { color: C.faint, fontSize: 15, marginTop: 40 },

  foot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 26,
    paddingHorizontal: 22,
    paddingBottom: 30
  },
  scrubRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  tm: { color: white(0.45), fontSize: 11.5, fontVariant: ['tabular-nums'], width: 36 },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skipText: { color: white(0.85), fontSize: 12.5, fontWeight: '700' },
  toStartText: { color: white(0.85), fontSize: 20, marginTop: -2 },
  play: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: C.bright,
    alignItems: 'center',
    justifyContent: 'center'
  },
  playText: { color: '#17110a', fontSize: 24, fontWeight: '800' },

  mixRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9 },
  dot: { width: 11, height: 11, borderRadius: 6 },
  mixName: { color: C.text, fontSize: 14.5, fontWeight: '600', width: 96 },
  msBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: white(0.18),
    alignItems: 'center',
    justifyContent: 'center'
  },
  msText: { color: white(0.55), fontSize: 12, fontWeight: '800' },
  youPill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  youPillText: { color: '#191510', fontSize: 10, fontWeight: '800' }
})
