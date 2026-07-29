import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { AudioManager } from 'react-native-audio-api'
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
  const stemIds = useMemo(() => project.stems.map((st) => st.id), [project])

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
      setPos(engine.position)
      setCountInSt(engine.countInStatus)
    })
  }, [engine])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => {
      setPos(engine.position)
      setCountInSt(engine.countInStatus)
    }, 100)
    return () => clearInterval(t)
  }, [engine, playing])

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

  // Karaoke anticipates: words light a breath BEFORE they are sung so the
  // singer can catch the entry (marking on/after onset reads as lagging).
  const lpos = pos + 0.15
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
              <Text style={[s.line, { color: lineColor(i, isSing) }]}>
                {isSing ? <Text style={{ fontSize: 19 }}>🎤 </Text> : null}
                {isCurrent
                  ? ln.words.map((w, j) => (
                      <Text
                        key={j}
                        style={
                          lpos >= w.e
                            ? { color: isSing ? '#ffd97a' : C.amber }
                            : lpos >= w.s
                              ? [{ color: isSing ? '#ffd97a' : C.amber }, s.nowGlow]
                              : { color: 'rgba(255,255,255,0.40)' }
                        }
                      >
                        {w.w + (j < ln.words.length - 1 ? ' ' : '')}
                      </Text>
                    ))
                  : ln.text}
              </Text>
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
          <Text style={s.hSub}>SingZ project · {stemIds.length} stems</Text>
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
              const meta = TRACK_META[t.id] ?? { label: t.id, color: C.dim }
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
                {beatInfo ? (
                  <>
                    <View style={b.segs}>
                      <Chip
                        label={met.click ? 'Click on' : 'Click off'}
                        active={met.click}
                        onPress={() => setMet((m) => ({ ...m, click: !m.click }))}
                      />
                      <Chip
                        label="No count-in"
                        active={met.countInBars === 0}
                        onPress={() => setMet((m) => ({ ...m, countInBars: 0 }))}
                      />
                      <Chip
                        label="1 bar"
                        active={met.countInBars === 1}
                        onPress={() => setMet((m) => ({ ...m, countInBars: 1 }))}
                      />
                      <Chip
                        label="2 bars"
                        active={met.countInBars === 2}
                        onPress={() => setMet((m) => ({ ...m, countInBars: 2 }))}
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
                        engine.previewClick(true)
                      }}
                    />
                    <Text style={b.hint}>
                      {Math.round(beatInfo.bpm)} bpm from the project — clicks and the count-in
                      follow the song's own beat, drift and all.
                    </Text>
                  </>
                ) : (
                  <Text style={b.hint}>
                    No beat track in this project yet — open the song on desktop (it reads the
                    beat from the drums) and save the project again.
                  </Text>
                )}
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
                      label={TRACK_META[id]?.label ?? id}
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
  /* desktop karaoke halo: .lyr-line.current span.now */
  nowGlow: {
    textShadowColor: 'rgba(255,160,40,0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 7
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
