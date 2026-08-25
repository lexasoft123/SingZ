import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DeviceEventEmitter, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
  type NativeStackNavigationOptions
} from '@react-navigation/native-stack'
import { AudioManager } from 'react-native-audio-api'
import Animated, {
  runOnUI,
  scrollTo,
  useAnimatedRef,
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
import {
  b,
  Bar,
  C,
  Chip,
  HeadphonesGlyph,
  MicGlyph,
  MixGlyph,
  PlayPauseGlyph,
  RoundBtn,
  Seg,
  Sheet,
  SpeakerGlyph,
  splitSongName,
  StemTile,
  Stepper,
  ToStartGlyph,
  white
} from './bits'
import { KIT } from './tokens'
import { Canvas, LinearGradient as SkLinearGradient, RadialGradient, Rect, vec } from '@shopify/react-native-skia'
import { perf } from './perf'
import SkiaLyrics, {
  layoutColumn,
  useLyricFonts,
  type LyricsCue,
  type SkWord
} from './SkiaLyrics'
import { sheetRowState } from './song-sheet-copy'
import { TEST } from './testhooks'

const SCRIM_TOP = require('../../assets/bg/scrim-top.png')
const SCRIM_BOTTOM = require('../../assets/bg/scrim-bottom.png')

type PlayerStackParamList = {
  Stage: undefined
  Mixer: undefined
  Song: undefined
  Practice: undefined
}

const PlayerStack = createNativeStackNavigator<PlayerStackParamList>()
const PLAYER_SHEET_ROUTES = {
  mixer: 'Mixer',
  song: 'Song',
  practice: 'Practice'
} as const
const PLAYER_SHEET_OPTIONS: NativeStackNavigationOptions = {
  presentation: 'formSheet',
  headerShown: false,
  gestureEnabled: true,
  sheetAllowedDetents: [0.55, 0.93],
  sheetInitialDetentIndex: 1,
  sheetGrabberVisible: true,
  contentStyle: { backgroundColor: C.sheet }
}
const MIXER_SHEET_OPTIONS: NativeStackNavigationOptions = {
  ...PLAYER_SHEET_OPTIONS,
  sheetInitialDetentIndex: 0
}

/** Native-stack can remove a popped screen before delivering `blur`. Route
 *  content unmount is the reliable completion signal for both a system swipe
 *  and a navigator pop, so sheet state is released from here. */
function PlayerSheetRoute({
  onDismiss,
  children
}: {
  onDismiss: () => void
  children: React.ReactNode
}): React.JSX.Element {
  useEffect(() => () => onDismiss(), [onDismiss])
  return <>{children}</>
}

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
  /** The fader being dragged right now, for the value bubble — set on every
   *  move, cleared on commit (Bar fires commit on release AND on the
   *  scroller stealing an engaged drag, so the bubble cannot strand). */
  const [dragVol, setDragVol] = useState<{ id: string; v: number } | null>(null)
  const [ducked, setDucked] = useState<string[]>([])
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [training, setTraining] = useState(false)
  const [trainCfg, setTrainCfg] = useState<TrainingConfig>(TRAIN_DEFAULTS)
  const [route, setRoute] = useState<RouteLatency | null>(null)
  const [trimMs, setTrim] = useState(0)
  const [sheet, setSheetState] = useState<'none' | 'mixer' | 'practice' | 'song'>('none')
  const sheetRef = useRef(sheet)
  sheetRef.current = sheet
  const sheetNavigation = useRef<NativeStackNavigationProp<PlayerStackParamList> | null>(null)
  const setSheet = useCallback((next: 'none' | 'mixer' | 'practice' | 'song'): void => {
    if (sheetRef.current === next) return
    sheetRef.current = next
    setSheetState(next)
    const navigation = sheetNavigation.current
    if (next === 'none') {
      if (navigation?.canGoBack()) navigation.goBack()
    } else {
      navigation?.navigate(PLAYER_SHEET_ROUTES[next])
    }
  }, [])
  const sheetDismissed = useCallback((): void => {
    sheetRef.current = 'none'
    setSheetState('none')
  }, [])
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
  const sheetPad = Platform.OS === 'android' ? { paddingBottom: Math.max(34, insets.bottom + 18) } : null
  const [dragPos, setDragPos] = useState<number | null>(null)
  /**
   * A-B repeat, the thing a singer actually does with a hard bar: mark where
   * it starts, mark where it ends, and go round until it is right. The engine
   * has had the whole mechanism since the desktop needed it — setRegion wraps
   * every stem natively at the region edges, on the same sample — and nothing
   * on the phone reached it.
   *
   * SESSION-ONLY, and that is load-bearing rather than laziness: a saved
   * desktop selection playing on the phone was a field bug (Jul 2026), and an
   * armed region surviving engine.load() let one song's loop bound the next.
   * So nothing is read from doc.settings.selection and nothing is written
   * back; load() clears the engine's region and the effect below clears these
   * marks with it. tests/loop-region.cjs is the guard.
   */
  const [loopA, setLoopA] = useState<number | null>(null)
  const [loopB, setLoopB] = useState<number | null>(null)
  /* The marks again as refs, because cycleLoop is a THREE-STATE machine whose
     next move depends on both: reading them from the closure makes two calls
     inside one tick both take the first branch, which is exactly what a driver
     tapping through the cycle does. */
  const loopARef = useRef<number | null>(null)
  const loopBRef = useRef<number | null>(null)
  const markLoop = useCallback((a: number | null, b: number | null) => {
    loopARef.current = a
    loopBRef.current = b
    setLoopA(a)
    setLoopB(b)
  }, [])
  useEffect(() => {
    markLoop(null, null)
  }, [project, markLoop])

  /** Off -> A marked -> looping -> off. One button, the order a singer works in. */
  const cycleLoop = useCallback(() => {
    const at = engine.audioPosition
    const a0 = loopARef.current
    if (a0 === null) {
      markLoop(at, null)
      return
    }
    if (loopBRef.current === null) {
      const a = Math.min(a0, at)
      const b = Math.max(a0, at)
      // The engine will not loop a region shorter than 0.05s, and a region
      // that short is a mis-tap anyway — treat it as re-marking A instead of
      // arming something that silently does nothing.
      if (b - a < 0.4) {
        markLoop(at, null)
        return
      }
      // No seek here: setRegion re-anchors the clock and puts the playhead
      // inside the region itself, which it has to do anyway for the internal
      // restart path the UI cannot reach.
      engine.setRegion({ start: a, end: b }, true)
      /* Read the region BACK rather than assuming the marks were taken.
         setRegion may cap `end` to the song's length, and may reject the
         span outright once capped — leaving the button lit and a band drawn
         over a loop that was never armed. The engine owns the region; the UI
         draws what the engine owns, which keeps this honest for any clamp
         added inside setRegion later. */
      const armed = engine.regionState
      markLoop(armed?.start ?? null, armed?.end ?? null)
      return
    }
    markLoop(null, null)
    engine.setRegion(null, false)
  }, [engine, markLoop])
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
  /* Live window size for the tint washes — Android rotates and split-screens
     and the iPad target allows all four orientations, so a module-load
     capture would strand portrait extents on a landscape canvas. Still
     nothing on the clock: the Canvas repaints only when these actually
     change. */
  const winDims = useWindowDimensions()
  /* The same hue the catalog gave this song's card, so the artwork carries
     over from the shelf to the stage (the sample and dir-less loads take 0,
     matching their cards). */
  const tileHue =
    project.dir != null ? Math.abs(project.dir.length * 7 + project.dir.charCodeAt(0)) % 3 : 0
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
  /**
   * The seek bar's waveform: one bucket per sliver, each carrying the mix's
   * level and the hue of the loudest lane at that moment — red where the
   * voice leads, so a stretch with no vocal red is a stretch with nothing to
   * sing. Computed ONCE per song from small windowed reads
   * (copyFromChannel), never whole-lane copies — a lane is ~46 MB a minute
   * and getChannelData would copy it (the jetsam rule). Deferred a tick so
   * it never lands inside the load path, and cancelled on unmount: the
   * buffers are released the moment the song closes, and a read after that
   * is the analysis-outliving-the-song bug in miniature.
   */
  const [wave, setWave] = useState<{ h: number; color: string }[] | null>(null)
  useEffect(() => {
    let cancelled = false
    setWave(null)
    const stems = project.stems
    if (stems.length === 0) return
    const N = 96
    const WIN = 2048
    const t = setTimeout(() => {
      try {
        const frames = Math.max(...stems.map((st) => st.buffer.length))
        const scratch = new Float32Array(WIN)
        const raw: { level: number; color: string }[] = []
        for (let i = 0; i < N; i++) {
          if (cancelled) return
          const start = Math.floor((i / N) * frames)
          let total = 0
          let bestRms = 0
          let bestColor: string = C.dim
          for (const st of stems) {
            const b0 = st.buffer
            // A lane shorter than the song (a custom track) is silent past
            // its own end, not a repeat of its tail.
            if (start >= b0.length) continue
            b0.copyFromChannel(scratch, 0, Math.min(start, Math.max(0, b0.length - WIN)))
            let sum = 0
            for (let k = 0; k < WIN; k += 4) sum += scratch[k] * scratch[k]
            const rms = Math.sqrt(sum / (WIN / 4))
            total += rms * rms
            if (rms > bestRms) {
              bestRms = rms
              bestColor = laneMeta[st.id]?.color ?? C.dim
            }
          }
          raw.push({ level: Math.sqrt(total), color: bestColor })
        }
        const peak = Math.max(0.0001, ...raw.map((r) => r.level))
        if (!cancelled)
          setWave(raw.map((r) => ({ h: Math.max(0.1, Math.min(1, r.level / peak)), color: r.color })))
      } catch {
        // A released buffer mid-read: the song is gone; nothing to draw.
      }
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [project, laneMeta])
  /** Measured band width, for the played-clip's inner copy. */
  const [bandW, setBandW] = useState(0)

  /* Mixer presets — one tap for the thing the app exists to do. They act on
   * mute/solo ONLY, never volumes: the volumes are the singer's mix. A chip
   * lights only when the lanes exactly match it; any hand-set state lights
   * nothing, so the chips never claim a mix they did not make. */
  const hasVocals = tracks.some((t) => t.id === 'vocals')
  const mutedIds = tracks.filter((t) => t.muted).map((t) => t.id)
  const soloIds = tracks.filter((t) => t.solo).map((t) => t.id)
  const mixPreset: 'full' | 'novocals' | 'vocalsonly' | null =
    soloIds.length === 0 && mutedIds.length === 0
      ? 'full'
      : soloIds.length === 0 && mutedIds.length === 1 && mutedIds[0] === 'vocals'
        ? 'novocals'
        : mutedIds.length === 0 && soloIds.length === 1 && soloIds[0] === 'vocals'
          ? 'vocalsonly'
          : null
  const applyMixPreset = useCallback(
    (p: 'full' | 'novocals' | 'vocalsonly'): void => {
      for (const t of engine.getTrackStates()) {
        engine.setMuted(t.id, p === 'novocals' && t.id === 'vocals')
        engine.setSolo(t.id, p === 'vocalsonly' && t.id === 'vocals')
      }
    },
    [engine]
  )

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
    engine.load(project.stems.map(({ id, buffer, custom }) => ({ id, buffer, custom })))
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
    return `${KEY_NAMES[k.pc % 12]} ${k.minor ? 'minor' : 'major'}`
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
            /* micW alone put the first glyph ON the mic's right edge — an
               emoji's ink fills its whole advance, and the sweep's edge
               bloom blurs a further few px LEFT of the first glyph, so on
               the phone the lit line's text visibly painted over the mark.
               The +10 is the emoji's breathing room plus the bloom's
               spread. */
            indents: mask ? mask.map((m) => (m ? micW + 10 : 0)) : undefined
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
    /* A-B repeat through the button's own path, not engine.setRegion — the
       engine has always been drivable; what needed a hook is the three-state
       cycle and the marks the UI holds. loopMarks is what the band draws. */
    TEST.cycleLoop = cycleLoop
    TEST.loopMarks = { a: loopA, b: loopB }
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
  /* Name the destination, not the arithmetic: a singer transposing wants to
     know the key they will sing in. Falls back to the semitone count when
     the song's key is unknown. */
  if (ktPitch !== 0) {
    const k = settings?.key
    ktBadge.push(
      k != null
        ? `${KEY_NAMES[k.pc % 12]} → ${KEY_NAMES[(k.pc + ((ktPitch % 12) + 12)) % 12]}`
        : ktPitch > 0
          ? `+${ktPitch}♯`
          : `${ktPitch}♭`
    )
  }
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
  /**
   * How bright each line sits against the sung one.
   *
   * Reading AHEAD is the whole act of singing from a screen, and the upcoming
   * lines were dimmer than the ones already behind you deserved to be: 0.34
   * for the next and 0.25 for everything past it, over a brown ground and
   * under a 360px scrim, which put the third line down at the edge of
   * legibility and lost the fourth entirely.
   *
   * C.bright here is only what a line with no word timings gets. A line the
   * sweep is running through is drawn by SkiaLyrics instead, which lights the
   * swept part and holds the rest at its own `dark` — so that constant, not
   * this one, is what the next line has to stay under. Raising these without
   * it put the words about to be sung BELOW the whole line after them.
   *
   * Lines already sung stay the quietest thing on screen; they are the only
   * ones the singer has no further use for.
   */
  const lineColor = (i: number, _isSing: boolean): string => {
    /* Sing-to-train lines used to wear their own gold — 55% of the very hue
       the current line's sweep lights up in, so "yours, later" was nearly
       the same colour as "NOW" (photographed on the phone: four gold lines
       around one gold sweep). The 🎤 mark carries the training meaning by
       itself; the lines take the ordinary position ladder. */
    if (i === currentLine) return C.bright
    if (i < currentLine) return white(0.22)
    return Math.abs(i - currentLine) === 1 ? white(0.52) : white(0.4)
  }

  return (
    <PlayerStack.Navigator
      initialRouteName="Stage"
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}
    >
      <PlayerStack.Screen name="Stage">
        {({ navigation }) => {
          sheetNavigation.current = navigation
          return (
            <Animated.View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* The stage: a dusk room, fully out of focus — chosen from the design
          canvas against the user's references. A defocused photograph of warm
          light rather than a drawn pattern: a golden window glow upper-left,
          soft amber air on the right, dark masses in the lower corners, and a
          vignette. Nothing is in focus, so nothing competes with the lyrics.
          ONE static Skia surface, painted once, nothing on the clock — a
          radial gradient falling to transparent IS the defocused blob, no
          blur filter needed. Same look for every song on purpose: the room
          is the app's, the song shows in the stem tile and the seek bar. */}
      <Canvas pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Rect x={0} y={0} width={winDims.width} height={winDims.height}>
          <SkLinearGradient
            start={vec(winDims.width * 0.15, 0)}
            end={vec(winDims.width * 0.85, winDims.height)}
            colors={['#3a2517', '#2a1c12', '#1c130d', '#120c09']}
            positions={[0, 0.3, 0.58, 1]}
          />
        </Rect>
        <Rect x={0} y={0} width={winDims.width} height={winDims.height}>
          <RadialGradient
            c={vec(winDims.width * 0.25, winDims.height * 0.16)}
            r={winDims.width * 0.62}
            colors={['rgba(236,164,84,0.55)', 'rgba(210,130,60,0.22)', 'rgba(210,130,60,0)']}
            positions={[0, 0.55, 1]}
          />
        </Rect>
        <Rect x={0} y={0} width={winDims.width} height={winDims.height}>
          <RadialGradient
            c={vec(winDims.width * 0.86, winDims.height * 0.34)}
            r={winDims.width * 0.5}
            colors={['rgba(190,120,60,0.3)', 'rgba(190,120,60,0)']}
          />
        </Rect>
        <Rect x={0} y={0} width={winDims.width} height={winDims.height}>
          <RadialGradient
            c={vec(winDims.width * 0.28, winDims.height * 0.93)}
            r={winDims.width * 0.55}
            colors={['rgba(28,16,10,0.85)', 'rgba(28,16,10,0)']}
          />
        </Rect>
        <Rect x={0} y={0} width={winDims.width} height={winDims.height}>
          <RadialGradient
            c={vec(winDims.width * 0.9, winDims.height * 0.9)}
            r={winDims.width * 0.45}
            colors={['rgba(52,28,14,0.75)', 'rgba(52,28,14,0)']}
          />
        </Rect>
        <Rect x={0} y={0} width={winDims.width} height={winDims.height}>
          <RadialGradient
            c={vec(winDims.width * 0.5, winDims.height * 0.46)}
            r={winDims.width * 1.1}
            colors={['rgba(10,7,5,0)', 'rgba(10,7,5,0)', 'rgba(10,7,5,0.5)']}
            positions={[0, 0.42, 1]}
          />
        </Rect>
      </Canvas>

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

      {/* header: a dark glass pill floating on the room (the references'
          card material — charcoal translucency, hairline rim, warm light
          bleeding around it). The scrim is shorter and softer than the old
          full-bleed black: it only fades scrolled lyrics before they reach
          the status bar, without flattening the window glow. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 140, opacity: 0.8 }}
      >
        <Image source={SCRIM_TOP} style={{ width: '100%', height: '100%' }} resizeMode="stretch" />
      </View>
      <View pointerEvents="none" style={s.hdrGlass} />
      <View style={s.hdr} pointerEvents="box-none">
        <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back to library">
          <Text style={s.back}>‹</Text>
        </Pressable>
        <StemTile hue={tileHue} size={46} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.hTitle} numberOfLines={1}>
            {splitSongName(project.name).title}
          </Text>
          {/* "SingZ project" used to lead here, spending the most prominent
              line under the title telling the singer that this app's song is
              this app's song. What is left is what varies between songs. */}
          <Text style={s.hSub} numberOfLines={1}>
            {splitSongName(project.name).artist != null
              ? `${splitSongName(project.name).artist} · `
              : ''}
            {originalOnly ? 'Not split yet' : `${stemIds.length - addedCount} stems`}
            {addedCount > 0 ? ` · ${addedCount} added` : ''}
            {beatInfo ? ` · ${Math.round(beatInfo.bpm)} bpm` : ''}
            {settings?.key != null
              ? ` · ${KEY_NAMES[settings.key.pc % 12]} ${settings.key.minor ? 'min' : 'maj'}`
              : ''}
          </Text>
        </View>
        {ktBadge.length > 0 && (
          <View style={s.ktBadge}>
            <Text style={s.ktBadgeText}>{ktBadge.join(' · ')}</Text>
          </View>
        )}
        {training && ducked.length > 0 && (
          <View style={s.youChip}>
            {/* The one colour emoji left in the header, and deliberately. It is
                not an icon in a row of icons — it is a QUOTE of the 🎤 that
                marks the lines you sing, and this badge exists to announce
                exactly those. Matching the drawn transport glyph here would
                break the only thing it is for. */}
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

      {/* footer: the transport rides ONE floating dark glass dock — the
          same card material as the header pill. A scrim still lives under
          it, shorter and softer than the old 360px black: real glass blurs
          what is behind it, and without a live blur the coming lines read
          straight through the fill (photographed on the sim: three lines
          legible through and BELOW the dock). The fade does the blur's job
          of quieting them before they reach the glass. */}
      <View
        pointerEvents="none"
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 340 }}
      >
        <Image source={SCRIM_BOTTOM} style={{ width: '100%', height: '100%' }} resizeMode="stretch" />
      </View>
      <View style={[s.foot, { bottom: Math.max(12, insets.bottom + 2) }]}>
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
        {/* The seek bar is the player's primary control, and the layout says
            so: full screen width, thumb height, drawn as the song's waveform
            — scrub by shape, see the chorus coming. The gesture, the touch
            strip and the screen-reader surface are still Bar's; only the
            painting changed. */}
        <View style={s.waveWrap}>
          <Bar
            value={dragPos ?? (engine.duration > 0 ? pos / engine.duration : 0)}
            onChange={setDragPos}
            onCommit={(v) => {
              setDragPos(null)
              engine.seek(v * engine.duration)
            }}
            color="rgba(255,255,255,0.85)"
            height={40}
            label="Position"
            valueText={(v) => fmtTime(v * engine.duration)}
            rail={(pct) => (
              <View
                style={s.waveBand}
                onLayout={(e) => setBandW(Math.round(e.nativeEvent.layout.width))}
              >
                {wave != null && bandW > 0 ? (
                  <>
                    {/* Unplayed: every sliver in its loudest lane's hue, dim.
                        Played: the same slivers bright, revealed by a clip
                        whose width is the position — two static rows, no
                        per-sliver recolouring on the clock. */}
                    <View pointerEvents="none" style={s.waveRow}>
                      {wave.map((w, i) => (
                        <View
                          key={i}
                          style={[
                            s.waveBar,
                            { height: `${Math.round(w.h * 100)}%`, backgroundColor: w.color, opacity: 0.35 }
                          ]}
                        />
                      ))}
                    </View>
                    <View pointerEvents="none" style={[s.waveClip, { width: bandW * pct }]}>
                      <View style={[s.waveRow, { width: bandW }]}>
                        {wave.map((w, i) => (
                          <View
                            key={i}
                            style={[
                              s.waveBar,
                              { height: `${Math.round(w.h * 100)}%`, backgroundColor: w.color }
                            ]}
                          />
                        ))}
                      </View>
                    </View>
                  </>
                ) : (
                  /* Buckets still computing: a plain fill, same geometry. */
                  <View pointerEvents="none" style={[s.waveFill, { width: `${pct * 100}%` }]} />
                )}
                <View pointerEvents="none" style={[s.wavePlayhead, { left: `${pct * 100}%` }]} />
              </View>
            )}
          />
          {/* The loop draws INSIDE the band — an amber underline with edge
              handles. pointerEvents none so it never takes the drag away
              from the scrubber. */}
          {loopA !== null && engine.duration > 0 && (
            <View pointerEvents="none" style={s.loopLayer}>
              {loopB !== null && (
                <View
                  style={[
                    s.loopUnderline,
                    {
                      left: `${(loopA / engine.duration) * 100}%`,
                      right: `${100 - (loopB / engine.duration) * 100}%`
                    }
                  ]}
                />
              )}
              <View style={[s.loopEdge, { left: `${(loopA / engine.duration) * 100}%` }]} />
              {loopB !== null && (
                <View style={[s.loopEdge, { left: `${(loopB / engine.duration) * 100}%` }]} />
              )}
            </View>
          )}
        </View>
        {/* Times and the loop button on their own row beneath the band —
            elapsed left, loop centre, total right. */}
        <View style={s.timeRow}>
          <Text style={s.tm}>{fmtTime(dragPos !== null ? dragPos * engine.duration : pos)}</Text>
          <Pressable
            onPress={cycleLoop}
            hitSlop={8}
            style={[s.loopBtn, loopA !== null && s.loopBtnOn]}
            accessibilityRole="button"
            accessibilityLabel={
              loopA === null
                ? 'Loop a section. Marks the start here.'
                : loopB === null
                  ? `Loop start marked at ${fmtTime(loopA)}. Marks the end here.`
                  : `Looping ${fmtTime(loopA)} to ${fmtTime(loopB)}. Clears the loop.`
            }
          >
            <Text style={[s.loopBtnText, loopA !== null && s.loopBtnTextOn]}>
              {loopA !== null && loopB === null ? 'A' : 'A–B'}
            </Text>
          </Pressable>
          <Text style={[s.tm, { textAlign: 'right' }]}>{fmtTime(engine.duration)}</Text>
        </View>
        <View style={s.btnRow}>
          <RoundBtn onPress={() => setSheet('mixer')} label="Mixer">
            <MixGlyph />
          </RoundBtn>
          <RoundBtn onPress={() => engine.seek(0)} label="Back to start">
            {/* Drawn, like MicGlyph — Android faces render text glyphs at
                whatever weight they please. */}
            <ToStartGlyph color={white(0.85)} />
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
            <PlayPauseGlyph playing={playing} color="#17110a" />
          </Pressable>
          <RoundBtn onPress={() => engine.seekBy(5)} label="Forward 5 seconds">
            <Text style={s.skipText}>+5s</Text>
          </RoundBtn>
          <RoundBtn onPress={() => setSheet('practice')} label="Practice">
            <MicGlyph />
          </RoundBtn>
        </View>
      </View>

            </Animated.View>
          )
        }}
      </PlayerStack.Screen>

      {/* ---------- Mixer sheet ---------- */}
      <PlayerStack.Screen
        name="Mixer"
        options={MIXER_SHEET_OPTIONS}
      >
        {() => (
          <PlayerSheetRoute onDismiss={sheetDismissed}>
            <Sheet title="Mixer" onClose={() => setSheet('none')} pad={sheetPad}>
            {/* One tap for the thing the app exists to do. Only offered when
                the song has a vocal lane — an unsplit song has nothing to
                mute. */}
            {hasVocals && (
              <View style={[b.segs, { marginBottom: 6 }]}>
                <Chip label="Full mix" active={mixPreset === 'full'} onPress={() => applyMixPreset('full')} />
                <Chip
                  label="No vocals"
                  active={mixPreset === 'novocals'}
                  onPress={() => applyMixPreset('novocals')}
                />
                <Chip
                  label="Vocals only"
                  active={mixPreset === 'vocalsonly'}
                  onPress={() => applyMixPreset('vocalsonly')}
                />
              </View>
            )}
            {/* The lane rows had no scroll container at all, so past roughly a
                dozen lanes they clipped with no way to reach them — and the
                44 pt fader targets below bring that cliff closer. */}
            <ScrollView
              style={b.sheetScroll}
              contentContainerStyle={b.sheetScrollContent}
              contentInsetAdjustmentBehavior="never"
              showsVerticalScrollIndicator={false}
            >
            {tracks.map((t, i) => {
              const meta = laneMeta[t.id] ?? TRACK_META[t.id] ?? { label: t.id, color: C.dim }
              const isDucked = ducked.includes(t.id)
              /* The six stems are the song; everything after them is the
                 singer's own. The header lands before the FIRST added lane
                 (they sit together at the end of the track list). The
                 pre-split original lane is the app's, not the singer's —
                 the same exemption addedCount makes — or an unsplit song
                 would render an "Added" header over its own audio. */
              const isCustom = !(t.id in TRACK_META) && t.id !== ORIGINAL_LANE_ID
              const firstCustom = isCustom && (i === 0 || tracks[i - 1].id in TRACK_META)
              return (
                <React.Fragment key={t.id}>
                  {firstCustom && (
                    <View style={s.addedRule}>
                      <Text style={s.addedLab}>Added</Text>
                    </View>
                  )}
                  <View style={s.mixRow}>
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
                      onChange={(v) => {
                        engine.setVolume(t.id, v)
                        setDragVol({ id: t.id, v })
                      }}
                      onCommit={() => setDragVol(null)}
                      color={meta.color}
                      height={22}
                      track="rgba(255,255,255,0.14)"
                      label={`${meta.label} volume`}
                    />
                    {/* The value while a finger drags; at rest, nothing. */}
                    {dragVol?.id === t.id && (
                      <View pointerEvents="none" style={[s.volWrap, { left: `${dragVol.v * 100}%` }]}>
                        <View style={s.volBubble}>
                          <Text style={s.volBubbleText}>{Math.round(dragVol.v * 100)}%</Text>
                        </View>
                        <View style={s.volCaret} />
                      </View>
                    )}
                  </View>
                  <Pressable
                    hitSlop={4}
                    onPress={() => engine.setMuted(t.id, !t.muted)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mute ${meta.label}`}
                    accessibilityState={{ selected: t.muted }}
                    style={[s.msBtn, t.muted && { backgroundColor: C.red, borderColor: C.red }]}
                  >
                    {/* Drawn, not "M" — mixing-desk initials say nothing to a
                        singer; a crossed speaker says what happened to the
                        sound. */}
                    <SpeakerGlyph color={t.muted ? '#1d0f0d' : white(0.55)} slashed={t.muted} />
                  </Pressable>
                  <Pressable
                    hitSlop={4}
                    onPress={() => engine.setSolo(t.id, !t.solo)}
                    accessibilityRole="button"
                    accessibilityLabel={`Solo ${meta.label}`}
                    accessibilityState={{ selected: t.solo }}
                    style={[s.msBtn, t.solo && { backgroundColor: C.amber, borderColor: C.amber }]}
                  >
                    <HeadphonesGlyph color={t.solo ? C.amberInk : white(0.55)} />
                  </Pressable>
                  </View>
                </React.Fragment>
              )
            })}
            </ScrollView>
            </Sheet>
          </PlayerSheetRoute>
        )}
      </PlayerStack.Screen>

      {/* ---------- Song sheet: what is known about this song ---------- */}
      <PlayerStack.Screen
        name="Song"
        options={PLAYER_SHEET_OPTIONS}
      >
        {() => (
          <PlayerSheetRoute onDismiss={sheetDismissed}>
            <Sheet title={project.name} onClose={() => setSheet('none')} pad={sheetPad}>
            <ScrollView
              style={b.sheetScroll}
              contentContainerStyle={b.sheetScrollContent}
              contentInsetAdjustmentBehavior="never"
              showsVerticalScrollIndicator={false}
            >
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
                {/* The record behind the row: which detector wrote this grid,
                    and what rides on it. Dim — it is provenance, not news. */}
                {beatRow === 'grid' && settings?.beat != null && (
                  <Text style={s.songMeta}>
                    {settings.beat.source === 'manual'
                      ? 'hand-made on the computer'
                      : `detector v${settings.beat.detVersion ?? '?'}`}
                    {settings.beat.userBars?.length
                      ? ` · ${settings.beat.userBars.length} hand-set bar${settings.beat.userBars.length > 1 ? 's' : ''}`
                      : ''}
                  </Text>
                )}
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
                {keyRow === 'grid' && settings?.key != null && (
                  <Text style={s.songMeta}>detector v{settings.key.detVersion}</Text>
                )}
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
                {melodyRow === 'grid' && settings?.melody != null && (
                  <Text style={s.songMeta}>
                    detector v{settings.melody.detVersion} · one frame every{' '}
                    {(settings.melody.hopSec * 1000).toFixed(1)} ms
                  </Text>
                )}
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
                {project.doc.lyricsHash != null && (
                  <Text style={s.songMeta}>{fmtInfoSize(project.doc.lyricsHash.size)}</Text>
                )}
              </View>

              {/* ---------- The full record: every lane, every byte -------- */}
              <View style={b.sec}>
                <Text style={b.secLab}>Stems</Text>
                {project.stems.map((st) => {
                  const meta = laneMeta[st.id] ?? { label: st.id, color: C.dim }
                  const file = stemFileInfo(project.doc, st.id)
                  return (
                    <View key={st.id} style={s.stemRow}>
                      <View style={[s.dot, { backgroundColor: meta.color }]} />
                      <Text style={s.stemName} numberOfLines={1}>
                        {meta.label}
                      </Text>
                      <Text style={s.stemInfo}>
                        {file != null ? `${file.ext} · ${fmtInfoSize(file.size)}` : '—'}
                      </Text>
                    </View>
                  )
                })}
                <Text style={s.songMeta}>
                  {((): string => {
                    const total = Object.values(project.doc.stemHashes ?? {}).reduce(
                      (n, h) => n + h.size,
                      0
                    )
                    /* The decoded buffer's rate is the decode TARGET — the
                       device rate every stem is resampled to on open — not
                       the rate the files carry (the doc doesn't record that
                       one). Label it as what it is; an unlabelled "48.0 kHz"
                       here would print the exact file-rate-vs-device-rate
                       confusion the v22/v2 detector bumps were about. */
                    const sr = project.stems[0]?.buffer.sampleRate
                    const parts: string[] = []
                    if (total > 0) parts.push(`${fmtInfoSize(total)} on disk`)
                    if (sr != null) parts.push(`plays at ${(sr / 1000).toFixed(1)} kHz`)
                    parts.push(fmtTime(engine.duration))
                    return parts.join(' · ')
                  })()}
                </Text>
              </View>

              <View style={b.sec}>
                <Text style={b.secLab}>Project</Text>
                <Text style={s.songVal}>
                  {`Format v${project.doc.version}` +
                    (project.doc.version >= 2 ? ' · FLAC stems' : ' · WAV stems')}
                </Text>
                <Text style={s.songMeta}>
                  {[
                    project.doc.savedAt
                      ? `saved ${new Date(project.doc.savedAt).toLocaleDateString()}`
                      : null,
                    project.library === 'gdrive'
                      ? 'from Google Drive'
                      : project.library === 'folder'
                        ? 'from a folder'
                        : project.library === 'phone'
                          ? 'on this phone'
                          : 'bundled sample'
                  ]
                    .filter((x) => x != null)
                    .join(' · ')}
                </Text>
              </View>
            </ScrollView>
            </Sheet>
          </PlayerSheetRoute>
        )}
      </PlayerStack.Screen>

      {/* ---------- Practice sheet ---------- */}
      <PlayerStack.Screen
        name="Practice"
        options={PLAYER_SHEET_OPTIONS}
      >
        {() => (
          <PlayerSheetRoute onDismiss={sheetDismissed}>
            <Sheet title="Practice" onClose={() => setSheet('none')} pad={sheetPad}>
            <ScrollView
              style={b.sheetScroll}
              contentContainerStyle={b.sheetScrollContent}
              bounces={false}
              contentInsetAdjustmentBehavior="never"
              showsVerticalScrollIndicator={false}
            >

              <View style={[b.sec, b.secFirst]}>
                {/* Reset lives on the header row — a control row it used to
                    cost is a control row the sheet gets back. The hint went
                    with it: the suffixes below say what pitch and tempo DO
                    better than a sentence did. */}
                <View style={s.secHead}>
                  <Text style={[b.secLab, s.secHeadLab]}>Key & speed</Text>
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
                <Stepper
                  label="Pitch"
                  valueText={`${ktPitch > 0 ? '+' : ''}${ktPitch} st`}
                  onStep={(d) => setKtPitch((v) => Math.max(-12, Math.min(12, v + d)))}
                  /* The consequence, not the arithmetic: the key you will
                     actually sing in. Unknown key or no shift, no suffix. */
                  suffix={
                    settings?.key != null && ktPitch !== 0
                      ? `→ ${KEY_NAMES[(settings.key.pc + ((ktPitch % 12) + 12)) % 12]} ${settings.key.minor ? 'min' : 'maj'}`
                      : undefined
                  }
                />
                <Stepper
                  label="Tempo"
                  valueText={`${ktTempo}%`}
                  onStep={(d) => setKtTempo((v) => Math.max(50, Math.min(150, v + d * 5)))}
                  suffix={
                    beatInfo != null && ktTempo !== 100
                      ? `→ ${Math.round((beatInfo.bpm * ktTempo) / 100)} bpm`
                      : undefined
                  }
                />
              </View>

              <View style={b.sec}>
                <View style={s.secHead}>
                  <Text style={[b.secLab, s.secHeadLab]}>Metronome</Text>
                  {/* The fact the old hint led with, in five words on the
                      header row instead of a sentence under the controls. */}
                  {beatInfo != null && (
                    <Text style={s.secFact}>{Math.round(beatInfo.bpm)} bpm, from the song</Text>
                  )}
                </View>
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
                {beatInfo == null && (
                <Text style={b.hint}>
                  {stepAt('beat')
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
                )}
              </View>

              <View style={b.sec}>
                {/* Same split as the metronome. "Off · By time · By lyric
                    lines" read as one three-way choice, so with training OFF
                    and the mode set to lines the sheet lit "By lyric lines" —
                    which says the opposite of the truth. The switch is a
                    toggle and stands alone, on the header row; the mode is a
                    picker. */}
                <View style={s.secHead}>
                  <Text style={[b.secLab, s.secHeadLab]}>Vocal training</Text>
                  <Chip label="Training" active={training} onPress={armTraining} />
                </View>
                <Seg
                  segments={[
                    { key: 'time', label: 'By time' },
                    { key: 'lines', label: 'By lyric lines' }
                  ]}
                  active={trainCfg.mode}
                  onSelect={(k) => setTrainCfg((c) => ({ ...c, mode: k as 'time' | 'lines' }))}
                />
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
                  /* Hear and Sing share a row at full control size — the
                     sheet gets a row back without a single target shrinking
                     below its shipped 33pt. */
                  <View style={s.hearSingRow}>
                    <Text style={s.hearSingLab}>Hear</Text>
                    <Pressable
                      style={b.stepBtn}
                      hitSlop={6}
                      onPress={() => setTrainCfg((c) => ({ ...c, hear: Math.max(1, c.hear - 1) }))}
                      accessibilityRole="button"
                      accessibilityLabel="Decrease Hear"
                    >
                      <Text style={b.stepBtnText}>−</Text>
                    </Pressable>
                    <Text style={s.hearSingVal} accessibilityLabel={`Hear, ${trainCfg.hear}`}>
                      {trainCfg.hear}
                    </Text>
                    <Pressable
                      style={b.stepBtn}
                      hitSlop={6}
                      onPress={() => setTrainCfg((c) => ({ ...c, hear: Math.min(8, c.hear + 1) }))}
                      accessibilityRole="button"
                      accessibilityLabel="Increase Hear"
                    >
                      <Text style={b.stepBtnText}>+</Text>
                    </Pressable>
                    <View style={{ width: 8 }} />
                    <Text style={s.hearSingLab}>Sing</Text>
                    <Pressable
                      style={b.stepBtn}
                      hitSlop={6}
                      onPress={() => setTrainCfg((c) => ({ ...c, sing: Math.max(1, c.sing - 1) }))}
                      accessibilityRole="button"
                      accessibilityLabel="Decrease Sing"
                    >
                      <Text style={b.stepBtnText}>−</Text>
                    </Pressable>
                    <Text style={s.hearSingVal} accessibilityLabel={`Sing, ${trainCfg.sing}`}>
                      {trainCfg.sing}
                    </Text>
                    <Pressable
                      style={b.stepBtn}
                      hitSlop={6}
                      onPress={() => setTrainCfg((c) => ({ ...c, sing: Math.min(8, c.sing + 1) }))}
                      accessibilityRole="button"
                      accessibilityLabel="Increase Sing"
                    >
                      <Text style={b.stepBtnText}>+</Text>
                    </Pressable>
                  </View>
                )}
                {/* The schedule the numbers describe, as a strip instead of a
                    sentence: dim blocks with the singer, amber blocks yours.
                    Lines mode draws the hear/sing pattern twice; time mode
                    alternates equal periods. */}
                <View
                  style={s.schedStrip}
                  accessible
                  accessibilityLabel={
                    trainCfg.mode === 'time'
                      ? `With the singer ${trainCfg.periodSec} seconds, then your turn ${trainCfg.periodSec} seconds, repeating`
                      : `Hear ${trainCfg.hear} line${trainCfg.hear > 1 ? 's' : ''} with the singer, then sing ${trainCfg.sing} on your own, repeating — marked 🎤 in the lyrics`
                  }
                >
                  {(trainCfg.mode === 'time'
                    ? [false, true, false, true, false, true]
                    : Array.from({ length: 2 * (trainCfg.hear + trainCfg.sing) }, (_, i) => {
                        const k = i % (trainCfg.hear + trainCfg.sing)
                        return k >= trainCfg.hear
                      })
                  ).map((sing, i) => (
                    <View
                      key={i}
                      style={[s.schedBlock, { backgroundColor: sing ? C.amber : white(0.18) }]}
                    />
                  ))}
                </View>
                <View style={s.schedCaps}>
                  <Text style={s.schedCapDim}>with the singer</Text>
                  <Text style={s.schedCapYou}>
                    {trainCfg.mode === 'lines' ? 'your turn 🎤' : 'your turn'}
                  </Text>
                </View>
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
            </Sheet>
          </PlayerSheetRoute>
        )}
      </PlayerStack.Screen>
    </PlayerStack.Navigator>
  )
}

/** Sizes for the Song sheet's record — down to kB, unlike the catalog's
 *  singer-facing formatter, because this sheet IS the fine print. */
const fmtInfoSize = (bytes: number): string =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`

/** A lane's on-disk record, matched by stem name against the doc's
 *  stemHashes (keys are filenames — 'vocals.flac', 'custom-x.m4a'). */
const stemFileInfo = (
  doc: { stemHashes?: Record<string, { size: number }> },
  laneId: string
): { ext: string; size: number } | null => {
  for (const [name, h] of Object.entries(doc.stemHashes ?? {})) {
    const dot = name.lastIndexOf('.')
    if (dot > 0 && name.slice(0, dot) === laneId) {
      return { ext: name.slice(dot + 1).toUpperCase(), size: h.size }
    }
  }
  return null
}

/** One spelling for pitch classes, shared by the Song sheet's Key row and
 *  the Practice sheet's transpose suffix. */
const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']

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
  songMeta: { color: C.dim, fontSize: 12, marginTop: 4, fontVariant: ['tabular-nums'] },
  stemRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 4 },
  stemName: { color: C.text, fontSize: 13.5, flexShrink: 1 },
  stemInfo: {
    color: C.dim,
    fontSize: 12,
    marginLeft: 'auto',
    fontVariant: ['tabular-nums']
  },
  /* The dark glass the references are built from: charcoal translucency
     over the warm room, a faint all-round border with a brighter top edge
     standing in for the inset specular rim CSS would draw. No live blur —
     the backdrop is static, so fill + rim reads identically and costs
     nothing per frame. */
  /* Radii follow iOS 26's concentric rule: a floating element's corner
     radius is the display corner radius (~55pt on the Pro phones) minus its
     inset from the edge, capped at a capsule. Pill: capsule (62/2). Dock:
     55 − 10 inset ≈ 44, continuous curve. Waveband: concentric would be
     44 − 12 padding = 32, capped at its own capsule (40/2). */
  hdrGlass: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 54,
    height: 62,
    borderRadius: 31,
    borderCurve: 'continuous',
    backgroundColor: 'rgba(24,20,17,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,240,220,0.05)',
    borderTopColor: 'rgba(255,240,220,0.14)',
    ...(Platform.OS === 'ios'
      ? { shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 10 } }
      : null)
  },
  hdr: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 63,
    paddingHorizontal: 26,
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
    paddingHorizontal: 22,
    fontSize: 13,
    letterSpacing: 6,
    textAlign: 'center',
    marginBottom: 8,
    textShadowColor: 'rgba(255,160,40,0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 10
  },
  noLyrics: { color: C.dim, fontSize: 15, marginTop: 40 },

  foot: {
    position: 'absolute',
    left: 10,
    right: 10,
    /* bottom set inline from the safe-area inset */
    borderRadius: 44,
    borderCurve: 'continuous',
    backgroundColor: 'rgba(24,20,17,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,240,220,0.05)',
    borderTopColor: 'rgba(255,240,220,0.14)',
    ...(Platform.OS === 'ios'
      ? { shadowColor: '#000', shadowOpacity: 0.42, shadowRadius: 15, shadowOffset: { width: 0, height: 12 } }
      : null),
    /* The seek bar still owns (almost) the full width: the dock's 10+12 a
       side is the cost of the card material the user chose over the old
       edge-to-edge band. */
    paddingTop: 14,
    paddingHorizontal: 12,
    paddingBottom: 16
  },
  waveWrap: {},
  waveBand: {
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.28)',
    overflow: 'hidden'
  },
  waveRow: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1.5,
    paddingHorizontal: 4,
    paddingVertical: 5
  },
  waveBar: { flex: 1, borderRadius: 1 },
  waveClip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  waveFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: white(0.22) },
  wavePlayhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 3,
    marginLeft: -1.5,
    backgroundColor: '#ffffff'
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 10
  },
  tm: { color: white(0.5), fontSize: 11.5, fontVariant: ['tabular-nums'], width: 36 },
  loopBtn: {
    width: 40,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: white(0.2),
    alignItems: 'center',
    justifyContent: 'center'
  },
  loopBtnOn: { backgroundColor: C.amber, borderColor: C.amber },
  loopBtnText: { color: white(0.6), fontSize: 11.5, fontWeight: '800' },
  loopBtnTextOn: { color: C.amberInk },
  /* Overlays the band Bar draws (40pt centred in its 44pt touch strip). */
  loopLayer: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  loopUnderline: {
    position: 'absolute',
    bottom: 4,
    height: 3,
    borderRadius: 2,
    backgroundColor: C.amber
  },
  loopEdge: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    width: 3,
    borderRadius: 1.5,
    marginLeft: -1.5,
    backgroundColor: C.amber
  },
  btnRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6
  },
  skipText: { color: white(0.85), fontSize: 12.5, fontWeight: '700' },
  play: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: C.bright,
    alignItems: 'center',
    justifyContent: 'center'
  },
  /* The near-black inks stay literals, riding the glyphs inline now: the
     crossed speaker's '#1d0f0d' is tinted toward the danger fill it sits on,
     and the play triangle's '#17110a' is the palette's warm near-black on a
     white button (the StemTile well's value, for a different reason). There
     is no token for ink on an arbitrary fill because the fill belongs to the
     state, not the palette; C.amberInk already covers ink on the accent. */

  mixRow: { flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 9 },
  /* Section header rows: the label plus the control that used to cost its
     own row (Reset, Training, the bpm fact). minHeight keeps headers level
     whether or not the right side is present. */
  secHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 32,
    marginBottom: 9
  },
  secHeadLab: { marginBottom: 0 },
  secFact: { color: C.dim, fontSize: 12 },
  hearSingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  hearSingLab: { color: C.text, fontSize: 14.5, width: 40 },
  hearSingVal: {
    color: C.text,
    fontSize: 16,
    fontWeight: '700',
    minWidth: 26,
    textAlign: 'center',
    fontVariant: ['tabular-nums']
  },
  schedStrip: { flexDirection: 'row', gap: 4, marginTop: 14 },
  schedBlock: { flex: 1, height: 10, borderRadius: 3 },
  schedCaps: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  schedCapDim: { color: C.dim, fontSize: 11 },
  schedCapYou: { color: C.amber, fontSize: 11, fontWeight: '700' },
  /* The added-lanes divider: the six stems are the song, the rest is the
     singer's own. Same voice as the sheets' section labels. */
  addedRule: { borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 12, marginTop: 4 },
  addedLab: {
    color: C.dim,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8
  },
  /* The drag value bubble, centred over the knob with a caret pointing at
     it. pointerEvents none — it must never take the drag. */
  volWrap: { position: 'absolute', top: -16, marginLeft: -21, width: 42, alignItems: 'center' },
  volBubble: {
    backgroundColor: KIT.panelDeep,
    borderWidth: 1,
    borderColor: KIT.lineStrong,
    borderRadius: 7,
    paddingHorizontal: 7,
    paddingVertical: 1
  },
  volBubbleText: { color: C.text, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  volCaret: {
    width: 6,
    height: 6,
    marginTop: -3,
    backgroundColor: KIT.panelDeep,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: KIT.lineStrong,
    transform: [{ rotate: '45deg' }]
  },
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
  youPill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  youPillText: { color: '#191510', fontSize: 10, fontWeight: '800' }
})
