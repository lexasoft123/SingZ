import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
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
  fmtTime,
  MET_DEFAULTS,
  sanitizeBeatInfo,
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
import type { LoadedProject } from '../projects'
import { b, Bar, C, Chip, MixGlyph, RoundBtn, StemTile, Stepper } from './bits'
import { perf } from './perf'
import SkiaLyrics, {
  layoutColumn,
  lyricFont,
  type LyricsCue,
  type SkWord
} from './SkiaLyrics'
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
  const [sheet, setSheet] = useState<'none' | 'mixer' | 'practice'>('none')
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
  const addedCount = useMemo(() => project.stems.filter((st) => st.custom).length, [project])

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
  const column = useMemo(
    () =>
      lyrW > 0
        ? layoutColumn(wordSpecs, lyricFont(), lyrW, {
            top: LYR_TOP,
            indents: mask ? mask.map((m) => (m ? micW : 0)) : undefined
          })
        : { boxes: [], height: 0 },
    [wordSpecs, lyrW, micW, mask]
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
    if (i < currentLine) return 'rgba(255,255,255,0.18)'
    return Math.abs(i - currentLine) === 1 ? 'rgba(255,255,255,0.34)' : 'rgba(255,255,255,0.25)'
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
        <SkiaLyrics
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
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={s.back}>‹</Text>
        </Pressable>
        <StemTile hue={0} size={46} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={s.hTitle} numberOfLines={1}>
            {project.name}
          </Text>
          <Text style={s.hSub}>
            SingZ project · {stemIds.length - addedCount} stems
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
          <Text style={s.countInFoot}>
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
            />
          </View>
          <Text style={[s.tm, { textAlign: 'right' }]}>{fmtTime(engine.duration)}</Text>
        </View>
        <View style={s.btnRow}>
          <RoundBtn onPress={() => setSheet('mixer')}>
            <MixGlyph />
          </RoundBtn>
          <RoundBtn onPress={() => engine.seek(0)}>
            {/* ︎ keeps the glyph monochrome (no emoji rendering) */}
            <Text style={s.toStartText}>{'⏮︎'}</Text>
          </RoundBtn>
          <RoundBtn onPress={() => engine.seekBy(-5)}>
            <Text style={s.skipText}>−5s</Text>
          </RoundBtn>
          <Pressable onPress={() => engine.toggle()} style={s.play}>
            <Text style={s.playText}>{playing ? '❚❚' : '▶'}</Text>
          </Pressable>
          <RoundBtn onPress={() => engine.seekBy(5)}>
            <Text style={s.skipText}>+5s</Text>
          </RoundBtn>
          <RoundBtn onPress={() => setSheet('practice')}>
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
        <Pressable style={b.sheetWrap} onPress={() => setSheet('none')}>
          <Pressable style={[b.sheet, sheetPad]} onPress={() => {}}>
            <View style={b.grab} />
            <Text style={b.sheetTitle}>Mixer</Text>
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
                    />
                  </View>
                  <Pressable
                    hitSlop={4}
                    onPress={() => engine.setMuted(t.id, !t.muted)}
                    style={[s.msBtn, t.muted && { backgroundColor: C.red, borderColor: C.red }]}
                  >
                    <Text style={[s.msText, t.muted && { color: '#1d0f0d' }]}>M</Text>
                  </Pressable>
                  <Pressable
                    hitSlop={4}
                    onPress={() => engine.setSolo(t.id, !t.solo)}
                    style={[s.msBtn, t.solo && { backgroundColor: C.amber, borderColor: C.amber }]}
                  >
                    <Text style={[s.msText, t.solo && { color: C.amberInk }]}>S</Text>
                  </Pressable>
                </View>
              )
            })}
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
        <Pressable style={b.sheetWrap} onPress={() => setSheet('none')}>
          <Pressable style={[b.sheet, sheetPad]} onPress={() => {}}>
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
                <View style={b.segs}>
                  {beatInfo != null && (
                    <Chip
                      label={met.click ? 'Click on' : 'Click off'}
                      active={met.click}
                      onPress={() => setMet((m) => ({ ...m, click: !m.click }))}
                    />
                  )}
                  <Chip
                    label="No count-in"
                    active={met.countInBars === 0}
                    onPress={() => setMet((m) => ({ ...m, countInBars: 0 }))}
                  />
                  <Chip
                    label={beatInfo ? '1 bar' : '3 s'}
                    active={met.countInBars === 1}
                    onPress={() => setMet((m) => ({ ...m, countInBars: 1 }))}
                  />
                  <Chip
                    label={beatInfo ? '2 bars' : '6 s'}
                    active={met.countInBars === 2}
                    onPress={() => setMet((m) => ({ ...m, countInBars: 2 }))}
                  />
                  <Chip
                    label={met.accent ? 'Accent on' : 'Accent off'}
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
                    : 'No beat track — the count-in ticks once a second before playback ' +
                      'starts. If the song has a steady beat, opening it on desktop reads ' +
                      'one from the drums.'}
                </Text>
              </View>

              <View style={b.sec}>
                <Text style={b.secLab}>Vocal training</Text>
                <View style={b.segs}>
                  <Chip label={training ? 'On' : 'Off'} active={training} onPress={armTraining} />
                  <Chip
                    label="By time"
                    active={trainCfg.mode === 'time'}
                    onPress={() => setTrainCfg((c) => ({ ...c, mode: 'time' }))}
                  />
                  <Chip
                    label="By lyric lines"
                    active={trainCfg.mode === 'lines'}
                    onPress={() => setTrainCfg((c) => ({ ...c, mode: 'lines' }))}
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
                <View style={[b.segs, { marginTop: 12 }]}>
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

const s = StyleSheet.create({
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
  back: { color: 'rgba(255,255,255,0.85)', fontSize: 30, fontWeight: '600', paddingRight: 4, marginTop: -4 },
  hTitle: { color: C.bright, fontSize: 15.5, fontWeight: '700' },
  hSub: { color: C.dim, fontSize: 12.5, marginTop: 1 },
  ktBadge: { backgroundColor: 'rgba(255,255,255,0.10)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  ktBadgeText: { color: 'rgba(255,255,255,0.8)', fontSize: 11.5, fontWeight: '800', letterSpacing: 0.2 },
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
  tm: { color: 'rgba(255,255,255,0.45)', fontSize: 11.5, fontVariant: ['tabular-nums'], width: 36 },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  skipText: { color: 'rgba(255,255,255,0.85)', fontSize: 12.5, fontWeight: '700' },
  toStartText: { color: 'rgba(255,255,255,0.85)', fontSize: 20, marginTop: -2 },
  play: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#fff',
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
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  msText: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '800' },
  youPill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  youPillText: { color: '#191510', fontSize: 10, fontWeight: '800' }
})
