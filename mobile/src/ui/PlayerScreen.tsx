import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
import Animated, {
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  type SharedValue
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
import { TEST } from './testhooks'

const BG = require('../../assets/bg/player.png')
const SCRIM_TOP = require('../../assets/bg/scrim-top.png')
const SCRIM_BOTTOM = require('../../assets/bg/scrim-bottom.png')

/**
 * Karaoke anticipates: words light a breath BEFORE they are sung so the
 * singer can catch the entry (marking on/after onset reads as lagging).
 */
const LEAD_S = 0.15

/** Space between words, in place of the ' ' that used to ride inside them. */
const WORD_GAP = 8
/**
 * Width of one step of the soft edge, in px. Desktop feathers the sweep over
 * 0.4em with a real gradient; RN has no gradient without a native dep, so the
 * edge is approximated by clipped copies at falling opacity. Four steps of
 * 5px ≈ a 20px ramp — about desktop's 0.8em gradient span at this font size.
 */
const FEATHER = 5
/** Number of soft-edge steps; the animated clip overshoots by this many. */
const FEATHER_STEPS = 4

/**
 * Pure math for the sweep — top-level worklets that take plain numbers and
 * capture NO shared values, so they are safe to call from any style body
 * (the .value reads stay in the caller, where the capture analysis sees them).
 */
function fillWidth(t: number, w: number, start: number, end: number, step: number): number {
  'worklet'
  const p = Math.min(1, Math.max(0, (t - start) / (end - start)))
  if (p <= 0) return 0
  // Deliberately NOT clamped to w: the nested steps each give back FEATHER
  // from the right, so the outer clip has to overshoot the word by exactly
  // what they take. Clamping it cost the last step*FEATHER px of every word —
  // a fully sung word kept an unlit last letter.
  return p * w + step * FEATHER
}

function glowEnv(t: number, start: number, end: number): number {
  'worklet'
  const p = Math.min(1, Math.max(0, (t - start) / (end - start)))
  if (p <= 0 || p >= 1) return 0
  const env = 0.45 + 0.55 * (1 - Math.abs(2 * p - 1))
  // Quantized: every opacity write re-renders the shadow stack offscreen;
  // sixteen levels still read as breathing at a fraction of the writes.
  return Math.round(env * 16) / 16
}

/**
 * One word of the line being sung, filling left to right as it is sung.
 *
 * The bright copy sits on top of the dim one and is revealed by a clip whose
 * width reanimated drives on the UI thread, so the fill runs at display rate
 * instead of the 100ms position poll — the poll only has to keep the clock
 * honest. The clip is a percentage of the word's own box, which is why none
 * of this needs the word measured. The halo goes on the dim layer underneath:
 * on the bright copy the clip would slice it off mid-word.
 */
const SweepWord = React.memo(function SweepWord({
  word,
  start,
  end,
  lead,
  lit,
  dark,
  clock
}: {
  word: string
  start: number
  end: number
  lead: number
  lit: string
  dark: string
  clock: SharedValue<number>
}): React.JSX.Element {
  // measured once per line activation; the feather is in px, not percent
  const boxW = useSharedValue(0)
  // EVERY style below reads clock.value and boxW.value in its own body, then
  // hands plain numbers to the pure helpers. Do NOT factor the .value reads
  // into a shared helper worklet: reanimated's dependency capture loses a
  // shared value read behind an indirection, the mapper never re-fires, and
  // the fill freezes at whatever the mount frame held. That shipped once —
  // first word lit, nothing moved — and it passed review because per-word
  // React commits had been re-creating the styles and faking motion at poll
  // rate the whole time.
  // ONE mapper drives the whole feather. Creating and destroying a
  // useAnimatedStyle costs ~26ms per line change across a line's words
  // (measured: 1 mapper/word 52ms, 2 → 80, 3 → 106, 5 → 148), and a line
  // change churns every word at once — that was the 218ms stall on device.
  // So the steps are NESTED instead of stacked: each inner clip is inset
  // FEATHER px from its parent's right edge, so all five edges track the one
  // animated width for free.
  const fill = useAnimatedStyle(() => ({
    width: fillWidth(clock.value + lead, boxW.value, start, end, FEATHER_STEPS)
  }))
  // The bloom breathes with the word — live only while the sweep is inside it,
  // decided HERE on the UI thread. Deciding it in React was the phone's jerk:
  // every word onset committed, re-rendered the line and remounted these
  // layers, stalling the very frame the singer is watching. Now nothing
  // mounts at word boundaries; opacity just moves.
  const breathe = useAnimatedStyle(() => ({
    // Yoga caps an absolute child at its parent's width, and the padded twin
    // is wider than the word — without an explicit width the text WRAPS and a
    // glowing fragment renders on a phantom second line. boxW is measured, so
    // the width rides along in this worklet (4px slack against rounding).
    width: boxW.value + 2 * 18 + 4,
    opacity: glowEnv(clock.value + lead, start, end)
  }))
  return (
    <View
      style={{ marginRight: WORD_GAP }}
      onLayout={(e) => {
        boxW.value = e.nativeEvent.layout.width
      }}
    >
      <Text style={[s.line, { color: dark }]}>{word}</Text>
      {/* Glyph-shaped glow. RN clips textShadow to the Text frame — but the
          frame is the border box, so padding buys the blur runway to fade out
          BEFORE the edge (negative offsets put the glyphs back in place).
          A twin of the word carries the shadow; its opacity breathes on the
          UI thread. Rasterized: without it the shadow re-renders offscreen
          whenever an animated sibling repaints the region. */}
      <Animated.View style={[s.glowWrap, breathe]} pointerEvents="none">
        <Text style={[s.line, s.glowTwin, { color: dark }]}>{word}</Text>
      </Animated.View>
      {/* Soft edge, nested: the animated clip reaches FEATHER_STEPS*FEATHER
          past the sung point, and each level trims one FEATHER off its
          parent's right edge (left:0 + right:FEATHER tracks an animated
          parent for free). Faintest outermost, opaque innermost — the same
          ramp the flat stack drew, from a single animated style.
          numberOfLines/clip: an absolute child is width-capped by its parent,
          so inside a narrowing clip the text would otherwise wrap. */}
      <Animated.View style={[s.sweepClip, fill]} pointerEvents="none">
        <Text style={[s.line, s.sweepText, s.fade4, { color: lit }]} numberOfLines={1} ellipsizeMode="clip">{word}</Text>
        <View style={s.sweepStep}>
          <Text style={[s.line, s.sweepText, s.fade3, { color: lit }]} numberOfLines={1} ellipsizeMode="clip">{word}</Text>
          <View style={s.sweepStep}>
            <Text style={[s.line, s.sweepText, s.fade2, { color: lit }]} numberOfLines={1} ellipsizeMode="clip">{word}</Text>
            <View style={s.sweepStep}>
              <Text style={[s.line, s.sweepText, s.fade1, { color: lit }]} numberOfLines={1} ellipsizeMode="clip">{word}</Text>
              <View style={s.sweepStep}>
                <Text style={[s.line, s.sweepText, { color: lit }]} numberOfLines={1} ellipsizeMode="clip">{word}</Text>
              </View>
            </View>
          </View>
        </View>
      </Animated.View>
    </View>
  )
})

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

  perf.commit()

  const lines = useMemo(() => project.lyrics?.lines ?? [], [project])
  const wordEnds = useMemo(() => sweepEnds(lines), [lines])

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

  const scrollRef = useRef<ScrollView>(null)
  const lineYs = useRef<number[]>([])
  useEffect(() => {
    const y = lineYs.current[currentLine]
    if (currentLine >= 0 && y !== undefined) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 250), animated: true })
    }
  }, [currentLine])

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

      {/* lyrics */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 250, paddingBottom: 300, paddingHorizontal: 26 }}
      >
        {lines.map((ln, i) => {
          const isCurrent = i === currentLine
          const isSing = mask?.[i] === true
          // count-in dots during the last 3s of a long gap before this line
          // (desktop parity: gap >= 3s, dots = ceil(seconds left)). The FIRST
          // line always counts in when there is any runway — the singer just
          // pressed play and needs orientation even on a quick start.
          const gapStart = i === 0 ? 0 : lines[i - 1].end
          const dt = ln.start - pos
          const gapOk = i === 0 ? ln.start >= 1.2 : ln.start - gapStart >= 3
          const countIn = gapOk && dt > 0 && dt <= 3 ? Math.min(3, Math.ceil(dt)) : 0
          // long instrumental pause: tick the seconds down until the dots
          // engage at 3 s (only for the gap the playhead is actually in)
          const longGap = (i === 0 ? ln.start : ln.start - gapStart) > 5
          const waitSec =
            longGap && dt > 3 && (i === 0 || pos >= gapStart) ? Math.ceil(dt) : 0
          return (
            <Pressable
              key={i}
              onPress={() => engine.seek(ln.start)}
              onLayout={(e) => {
                lineYs.current[i] = e.nativeEvent.layout.y
              }}
              style={({ pressed }) => [
                { marginBottom: 28 },
                isCurrent && { transform: [{ scale: 1.03 }] },
                pressed && { opacity: 0.6 }
              ]}
            >
              {countIn > 0 && (
                <Text style={s.countIn}>{Array(countIn).fill('●').join(' ')}</Text>
              )}
              {waitSec > 0 && (
                <Text style={[s.countIn, { letterSpacing: 1 }]}>{waitSec} s</Text>
              )}
              {/* Every line is a wrapping row of word boxes, not one Text with
                  inline children: RN can only clip a View, so a word has to be
                  a box of its own for the sweep. All lines are built this way,
                  current or not — mixing the two made a line re-wrap the
                  moment it lit up. */}
              <View style={s.lineRow}>
                {isSing && <Text style={[s.line, { fontSize: 19 }]}>🎤</Text>}
                {ln.words.length === 0 ? (
                  <Text style={[s.line, { color: lineColor(i, isSing) }]}>{ln.text}</Text>
                ) : (
                  ln.words.map((w, j) =>
                    isCurrent ? (
                      <SweepWord
                        key={j}
                        word={w.w}
                        start={w.s}
                        end={wordEnds[i][j]}
                        lead={LEAD_S}
                        lit={isSing ? '#ffd97a' : C.amber}
                        dark="rgba(255,255,255,0.40)"
                        clock={clock}
                      />
                    ) : (
                      <Text
                        key={j}
                        style={[s.line, { color: lineColor(i, isSing), marginRight: WORD_GAP }]}
                      >
                        {w.w}
                      </Text>
                    )
                  )
                )}
              </View>
            </Pressable>
          )
        })}
        {lines.length === 0 && <Text style={s.noLyrics}>No lyrics in this project yet.</Text>}
      </ScrollView>

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

  line: { fontSize: 30, lineHeight: 37, fontWeight: '800', letterSpacing: -0.4 },
  /* one lyric line = a row of word boxes that wraps like text used to */
  lineRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' },
  /* the reveal: width is animated on the UI thread, 0%..100% of the word */
  sweepClip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  /* one step of the nested soft edge: inset FEATHER from the parent's right */
  sweepStep: { position: 'absolute', left: 0, top: 0, bottom: 0, right: FEATHER, overflow: 'hidden' },
  /* absolute so the narrowing clip can never re-wrap or squeeze the glyphs */
  sweepText: { position: 'absolute', left: 0, top: 0 },
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
  /* Desktop's .now halo: an amber text-shadow shaped like the glyphs. The
     18px of padding is the blur's runway — a 12px radius is ~3% intensity by
     the time it reaches the frame edge, so the clip never shows. */
  glowWrap: {
    position: 'absolute',
    left: -18,
    top: -18
  },
  glowTwin: {
    padding: 18,
    textShadowColor: 'rgba(255,160,40,0.85)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12
  },
  /* the intermediate steps of the soft sweep edge */
  fade1: { opacity: 0.78 },
  fade2: { opacity: 0.55 },
  fade3: { opacity: 0.34 },
  fade4: { opacity: 0.16 },
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
