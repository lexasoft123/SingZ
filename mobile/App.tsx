import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { AudioManager, decodeAudioData } from 'react-native-audio-api'
import { MultitrackEngine, type TrackState, type TrainingSpec } from './src/engine'
import {
  fmtTime,
  sanitizeTraining,
  singMask,
  trainingWindows,
  STEM_ORDER_ALL,
  TRACK_META,
  TRAIN_DEFAULTS,
  type LyricsDoc,
  type ProjectDoc,
  type ProjectSettings,
  type TrainingConfig
} from './src/model'
import {
  clearRoot,
  getRoot,
  listProjects,
  loadProject,
  pickFolder,
  type LoadedProject,
  type ProjectEntry,
  type RootInfo
} from './src/projects'
import { getRouteLatency, getTrimMs, setTrimMs, type RouteLatency } from './src/latency'

/* Bundled sample project — playable before any folder is set up. */
const SAMPLE_PROJECT = require('./assets/sample/project.json') as ProjectDoc
const SAMPLE_LYRICS = require('./assets/sample/lyrics.json') as LyricsDoc
const SAMPLE_STEMS: Record<string, number> = {
  vocals: require('./assets/sample/stems/vocals.flac'),
  drums: require('./assets/sample/stems/drums.flac'),
  bass: require('./assets/sample/stems/bass.flac'),
  guitar: require('./assets/sample/stems/guitar.flac'),
  piano: require('./assets/sample/stems/piano.flac'),
  other: require('./assets/sample/stems/other.flac')
}

const C = {
  bg: '#131009',
  panel: '#1d1915',
  border: '#31291f',
  text: '#e8ddc8',
  dim: '#9a8d76',
  faint: '#5f5545',
  amber: '#f2c14e'
}

const engine = new MultitrackEngine()

/** Dev-only driver hooks (the mobile analog of desktop's window.__engine). */
const TEST: Record<string, unknown> | null = __DEV__
  ? ((globalThis as Record<string, unknown>).__test = { engine })
  : null

/** Horizontal drag/tap bar (seek + volume). Value is 0..1 of its width. */
function Bar({
  value,
  onChange,
  color,
  height = 26,
  track = '#2a231b'
}: {
  value: number
  onChange: (v: number) => void
  color: string
  height?: number
  track?: string
}): React.JSX.Element {
  const width = useRef(1)
  const handle = useCallback(
    (e: GestureResponderEvent) => {
      onChange(Math.max(0, Math.min(1, e.nativeEvent.locationX / width.current)))
    },
    [onChange]
  )
  return (
    <View
      style={[styles.bar, { height, backgroundColor: track }]}
      onLayout={(e: LayoutChangeEvent) => {
        width.current = Math.max(1, e.nativeEvent.layout.width)
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={handle}
      onResponderMove={handle}
    >
      <View
        pointerEvents="none"
        style={{
          width: `${Math.max(0, Math.min(1, value)) * 100}%`,
          height: '100%',
          backgroundColor: color,
          opacity: 0.85
        }}
      />
    </View>
  )
}

function Chip({
  label,
  active,
  activeColor,
  onPress,
  disabled
}: {
  label: string
  active: boolean
  activeColor: string
  onPress: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.chip,
        active && { backgroundColor: activeColor, borderColor: activeColor },
        disabled && { opacity: 0.4 }
      ]}
      hitSlop={6}
    >
      <Text style={[styles.chipText, active && { color: '#191510' }]}>{label}</Text>
    </Pressable>
  )
}

function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  step = 1
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
}): React.JSX.Element {
  return (
    <View style={styles.stepRow}>
      <Text style={styles.stepLabel}>{label}</Text>
      <Pressable
        style={styles.stepBtn}
        hitSlop={6}
        onPress={() => onChange(Math.max(min, value - step))}
      >
        <Text style={styles.stepBtnText}>−</Text>
      </Pressable>
      <Text style={styles.stepValue}>{value}</Text>
      <Pressable
        style={styles.stepBtn}
        hitSlop={6}
        onPress={() => onChange(Math.min(max, value + step))}
      >
        <Text style={styles.stepBtnText}>+</Text>
      </Pressable>
    </View>
  )
}

/* ------------------------------- Project list ------------------------------ */

function ListScreen({
  onLoaded
}: {
  onLoaded: (p: LoadedProject) => void
}): React.JSX.Element {
  const [root, setRoot] = useState<RootInfo | null>(null)
  const [projects, setProjects] = useState<ProjectEntry[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setError(null)
      setRoot(await getRoot())
      setProjects(await listProjects())
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!TEST) return
    TEST.screen = 'list'
    TEST.refresh = refresh
    TEST.openSample = openSample
    TEST.openProject = (dir: string) => {
      const entry = (projects ?? []).find((p) => p.dir === dir)
      return entry ? openEntry(entry) : Promise.reject(new Error(`no project ${dir}`))
    }
    TEST.projects = (projects ?? []).map((p) => p.dir)
  })

  const openEntry = async (entry: ProjectEntry): Promise<void> => {
    setBusy('Opening…')
    setError(null)
    try {
      const loaded = await loadProject(entry, engine.sampleRate, setBusy)
      onLoaded(loaded)
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  const openSample = async (): Promise<void> => {
    setBusy('Loading sample…')
    try {
      const ids = STEM_ORDER_ALL.filter((s) => s in SAMPLE_STEMS)
      const stems: LoadedProject['stems'] = []
      for (let i = 0; i < ids.length; i++) {
        setBusy(`Decoding ${ids[i]} (${i + 1}/${ids.length})…`)
        stems.push({
          id: ids[i],
          buffer: await decodeAudioData(SAMPLE_STEMS[ids[i]], engine.sampleRate)
        })
      }
      onLoaded({
        name: SAMPLE_PROJECT.name,
        doc: SAMPLE_PROJECT,
        lyrics: SAMPLE_LYRICS,
        stems
      })
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e))
    } finally {
      setBusy(null)
    }
  }

  const changeFolder = async (): Promise<void> => {
    const picked = await pickFolder()
    if (picked) await refresh()
  }

  return (
    <View style={styles.listWrap}>
      <Text style={styles.appTitle}>SingZ</Text>
      <Text style={styles.rootLine}>
        {root
          ? root.kind === 'picked'
            ? `Folder: ${root.name}`
            : 'On this iPhone (drop projects in via Files or Finder)'
          : ' '}
      </Text>
      <View style={styles.rootActions}>
        <Chip label="Choose folder…" active={false} activeColor={C.amber} onPress={() => void changeFolder()} />
        {root?.kind === 'picked' && (
          <Chip
            label="Use this iPhone"
            active={false}
            activeColor={C.amber}
            onPress={() => void clearRoot().then(() => refresh())}
          />
        )}
        <Chip label="Refresh" active={false} activeColor={C.amber} onPress={() => void refresh()} />
      </View>
      {busy !== null ? (
        <View style={styles.busyWrap}>
          <ActivityIndicator color={C.amber} size="large" />
          <Text style={styles.busyText}>{busy}</Text>
        </View>
      ) : (
        <ScrollView style={styles.projRows}>
          {(projects ?? []).map((p) => (
            <Pressable key={p.dir} style={styles.projRow} onPress={() => void openEntry(p)}>
              <Text style={styles.projName} numberOfLines={1}>
                {p.doc.name ?? p.dir}
              </Text>
              <Text style={styles.projMeta}>
                {Object.keys(p.stems).length} stems
                {Object.values(p.stems).some((f) => f === 'wav') ? ' · needs desktop update' : ''}
                {p.hasLyrics ? ' · lyrics' : ''}
              </Text>
            </Pressable>
          ))}
          {projects !== null && projects.length === 0 && (
            <Text style={styles.emptyText}>
              No projects here yet. Save one on your computer into the shared folder (iCloud
              Drive/SingZ), or pick a different folder above.
            </Text>
          )}
          <Pressable style={[styles.projRow, styles.sampleRow]} onPress={() => void openSample()}>
            <Text style={styles.projName}>Sample — {SAMPLE_PROJECT.name}</Text>
            <Text style={styles.projMeta}>bundled · 6 stems · lyrics</Text>
          </Pressable>
          {error && <Text style={styles.errText}>{error}</Text>}
        </ScrollView>
      )}
    </View>
  )
}

/* --------------------------------- Player --------------------------------- */

function PlayerScreen({
  project,
  onBack
}: {
  project: LoadedProject
  onBack: () => void
}): React.JSX.Element {
  const [tracks, setTracks] = useState<TrackState[]>([])
  const [ducked, setDucked] = useState<string[]>([])
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [training, setTraining] = useState(false)
  const [trainCfg, setTrainCfg] = useState<TrainingConfig>(TRAIN_DEFAULTS)
  const [showTrain, setShowTrain] = useState(false)
  const [loop, setLoop] = useState(false)
  const [route, setRoute] = useState<RouteLatency | null>(null)
  const [trimMs, setTrim] = useState(0)
  const [showSync, setShowSync] = useState(false)

  /* Route-latency compensation: highlights shift to match what the ear hears
     (CarPlay/BT). Auto part from AVAudioSession, user trim persisted per
     route; re-read on route changes (session values settle asynchronously). */
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
        // no native module (fresh pod not built yet) — play uncompensated
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
  }, [])

  const applyTrim = useCallback(
    (ms: number) => {
      const clamped = Math.max(-2000, Math.min(2000, Math.round(ms)))
      setTrim(clamped)
      if (route) {
        void setTrimMs(route.key, clamped)
        engine.setDisplayLatency(route.autoSec + clamped / 1000)
      }
    },
    [route]
  )

  const lines = useMemo(() => project.lyrics?.lines ?? [], [project])
  const stemIds = useMemo(() => project.stems.map((s) => s.id), [project])

  /* Feed the engine + apply the project's saved settings. */
  useEffect(() => {
    engine.load(project.stems.map(({ id, buffer }) => ({ id, buffer })))
    const st: ProjectSettings | undefined = project.doc.settings
    if (st) {
      for (const [id, t] of Object.entries(st.tracks ?? {})) {
        engine.setMuted(id, t.muted)
        engine.setSolo(id, t.solo)
        engine.setVolume(id, t.volume)
      }
      if (st.selection) {
        engine.setRegion({ start: st.selection.s, end: st.selection.e }, st.loop === true)
        setLoop(st.loop === true)
      }
      const tn = st.training
      if (tn) {
        setTrainCfg(sanitizeTraining(tn))
        if (tn.on === true) setTraining(true)
      }
    }
    return () => {
      engine.pause()
      engine.setTraining(null)
    }
  }, [project])

  useEffect(() => {
    return engine.subscribe(() => {
      setTracks(engine.getTrackStates())
      setDucked(engine.duckedStems)
      setPlaying(engine.playing)
      setPos(engine.position)
    })
  }, [])

  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setPos(engine.position), 100)
    return () => clearInterval(t)
  }, [playing])

  /* Training schedule -> engine spec (same derivation as desktop App.tsx). */
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
  }, [training, trainCfg, lines])

  const mask = useMemo(
    () =>
      training && trainCfg.mode === 'lines'
        ? singMask(lines.length, trainCfg.hear, trainCfg.sing)
        : null,
    [training, trainCfg, lines.length]
  )

  const currentLine = useMemo(() => {
    let cur = -1
    for (let i = 0; i < lines.length; i++) if (lines[i].start <= pos + 0.05) cur = i
    return cur
  }, [lines, pos])

  const scrollRef = useRef<ScrollView>(null)
  const lineYs = useRef<number[]>([])
  useEffect(() => {
    const y = lineYs.current[currentLine]
    if (currentLine >= 0 && y !== undefined) {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 130), animated: true })
    }
  }, [currentLine])

  const toggleTrainStem = (id: string): void => {
    setTrainCfg((c) => {
      const has = c.stems.includes(id)
      if (has && c.stems.length === 1) return c // never empty
      return { ...c, stems: has ? c.stems.filter((s) => s !== id) : [...c.stems, id] }
    })
  }

  const armTraining = (): void => {
    // Arming unmutes the trained stems — the schedule now owns their silence.
    if (!training) for (const id of trainCfg.stems) engine.setMuted(id, false)
    setTraining(!training)
  }

  useEffect(() => {
    if (!TEST) return
    TEST.screen = 'player'
    TEST.armTraining = armTraining
    TEST.trainingOn = training
    TEST.setTrainMode = (mode: 'time' | 'lines') => setTrainCfg((c) => ({ ...c, mode }))
    TEST.showTrainPanel = () => setShowTrain(true)
    TEST.latency = () => ({
      route: route?.label ?? null,
      autoMs: route ? Math.round(route.autoSec * 1000) : null,
      trimMs,
      appliedMs: Math.round(engine.displayLatency * 1000)
    })
    TEST.setTrim = applyTrim
    TEST.showSyncPanel = () => setShowSync(true)
  })

  return (
    <>
      {/* Header */}
      <View style={styles.header}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.backBtn}>‹</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {project.name}
        </Text>
        <Text style={styles.time}>
          {fmtTime(pos)} / {fmtTime(engine.duration)}
        </Text>
      </View>

      {/* Seek */}
      <View style={styles.seekWrap}>
        <Bar
          value={engine.duration > 0 ? pos / engine.duration : 0}
          onChange={(v) => engine.seek(v * engine.duration)}
          color={C.amber}
          height={30}
        />
      </View>

      {/* Transport */}
      <View style={styles.transport}>
        <Pressable style={styles.skipBtn} onPress={() => engine.seekBy(-5)} hitSlop={8}>
          <Text style={styles.skipText}>−5s</Text>
        </Pressable>
        <Pressable style={styles.playBtn} onPress={() => engine.toggle()} hitSlop={8}>
          <Text style={styles.playText}>{playing ? '❚❚' : '▶'}</Text>
        </Pressable>
        <Pressable style={styles.skipBtn} onPress={() => engine.seekBy(5)} hitSlop={8}>
          <Text style={styles.skipText}>+5s</Text>
        </Pressable>
        <View style={styles.transportRight}>
          <Chip
            label="Loop"
            active={loop}
            activeColor={C.amber}
            disabled={!project.doc.settings?.selection}
            onPress={() => {
              const next = !loop
              setLoop(next)
              const sel = project.doc.settings?.selection
              engine.setRegion(sel ? { start: sel.s, end: sel.e } : null, next)
            }}
          />
          <Chip
            label={training && ducked.length > 0 ? 'You sing!' : 'Training'}
            active={training}
            activeColor={C.amber}
            onPress={() => setShowTrain((v) => !v)}
          />
          <Chip
            label="Sync"
            active={showSync || trimMs !== 0}
            activeColor={C.amber}
            onPress={() => setShowSync((v) => !v)}
          />
        </View>
      </View>

      {/* Lyric-sync panel: route latency compensation + per-route trim */}
      {showSync && (
        <View style={styles.trainPanel}>
          <View style={styles.trainHead}>
            <Text style={styles.trainTitle}>Lyric timing</Text>
            <Text style={styles.caption}>
              {route ? `${route.label} · auto ${Math.round(route.autoSec * 1000)} ms` : '…'}
            </Text>
          </View>
          <Stepper
            label="Trim"
            value={trimMs}
            min={-2000}
            max={2000}
            step={25}
            onChange={applyTrim}
          />
          <Text style={styles.caption}>
            Highlights are shifted {Math.round(engine.displayLatency * 1000)} ms to match what you
            hear. If words light up before you hear them (car audio, Bluetooth), add more.
          </Text>
          {trimMs !== 0 && (
            <View style={styles.segRow}>
              <Chip label="Reset" active={false} activeColor={C.amber} onPress={() => applyTrim(0)} />
            </View>
          )}
        </View>
      )}

      {/* Training panel */}
      {showTrain && (
        <View style={styles.trainPanel}>
          <View style={styles.trainHead}>
            <Text style={styles.trainTitle}>Vocal training</Text>
            <Chip
              label={training ? 'On' : 'Off'}
              active={training}
              activeColor={C.amber}
              onPress={armTraining}
            />
          </View>
          <View style={styles.segRow}>
            <Chip
              label="By time"
              active={trainCfg.mode === 'time'}
              activeColor={C.amber}
              onPress={() => setTrainCfg((c) => ({ ...c, mode: 'time' }))}
            />
            <Chip
              label="By lyric lines"
              active={trainCfg.mode === 'lines'}
              activeColor={C.amber}
              onPress={() => setTrainCfg((c) => ({ ...c, mode: 'lines' }))}
            />
          </View>
          {trainCfg.mode === 'time' ? (
            <>
              <Stepper
                label="Interval"
                value={trainCfg.periodSec}
                min={5}
                max={60}
                step={5}
                onChange={(v) => setTrainCfg((c) => ({ ...c, periodSec: v }))}
              />
              <Text style={styles.caption}>
                Guide plays {trainCfg.periodSec} s, then you take the next {trainCfg.periodSec} s.
              </Text>
            </>
          ) : (
            <>
              <Stepper
                label="Hear"
                value={trainCfg.hear}
                min={1}
                max={8}
                onChange={(v) => setTrainCfg((c) => ({ ...c, hear: v }))}
              />
              <Stepper
                label="Sing"
                value={trainCfg.sing}
                min={1}
                max={8}
                onChange={(v) => setTrainCfg((c) => ({ ...c, sing: v }))}
              />
              <Text style={styles.caption}>
                Hear {trainCfg.hear} line{trainCfg.hear > 1 ? 's' : ''}, then sing {trainCfg.sing}{' '}
                on your own.
              </Text>
            </>
          )}
          <Text style={styles.trainStemsLabel}>Muted while you sing:</Text>
          <View style={styles.stemChips}>
            {stemIds.map((id) => (
              <Chip
                key={id}
                label={TRACK_META[id]?.label ?? id}
                active={trainCfg.stems.includes(id)}
                activeColor={C.amber}
                onPress={() => toggleTrainStem(id)}
              />
            ))}
          </View>
        </View>
      )}

      {/* Stems */}
      <View style={styles.stems}>
        {tracks.map((t) => {
          const meta = TRACK_META[t.id] ?? { label: t.id, color: C.dim }
          const isDucked = ducked.includes(t.id)
          return (
            <View key={t.id} style={styles.stemRow}>
              <View style={[styles.stemDot, { backgroundColor: meta.color }]} />
              <Text style={styles.stemLabel} numberOfLines={1}>
                {meta.label}
              </Text>
              {isDucked && (
                <View style={[styles.youPill, { backgroundColor: meta.color }]}>
                  <Text style={styles.youPillText}>your turn</Text>
                </View>
              )}
              <View style={styles.stemVol}>
                <Bar
                  value={t.volume}
                  onChange={(v) => engine.setVolume(t.id, v)}
                  color={meta.color}
                  height={20}
                />
              </View>
              <Chip
                label="M"
                active={t.muted}
                activeColor="#e2574c"
                onPress={() => engine.setMuted(t.id, !t.muted)}
              />
              <Chip
                label="S"
                active={t.solo}
                activeColor={C.amber}
                onPress={() => engine.setSolo(t.id, !t.solo)}
              />
            </View>
          )
        })}
      </View>

      {/* Lyrics */}
      <ScrollView ref={scrollRef} style={styles.lyrics} contentContainerStyle={styles.lyricsPad}>
        {lines.map((ln, i) => {
          const isCurrent = i === currentLine
          const isSing = mask?.[i] === true
          return (
            <View
              key={i}
              style={[styles.line, isSing && styles.lineSing]}
              onLayout={(e) => {
                lineYs.current[i] = e.nativeEvent.layout.y
              }}
            >
              <Text style={styles.lineText}>
                {ln.words.map((w, j) => (
                  <Text
                    key={j}
                    style={[
                      styles.word,
                      i < currentLine && styles.wordPast,
                      isCurrent && styles.wordCurrent,
                      isCurrent && pos >= w.s && styles.wordSung,
                      isSing && isCurrent && pos >= w.s && styles.wordSungSing
                    ]}
                  >
                    {w.w + (j < ln.words.length - 1 ? ' ' : '')}
                  </Text>
                ))}
              </Text>
            </View>
          )
        })}
        {lines.length === 0 && (
          <Text style={styles.emptyText}>No lyrics in this project yet.</Text>
        )}
      </ScrollView>
    </>
  )
}

/* ---------------------------------- Root ----------------------------------- */

export default function App(): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)

  useEffect(() => {
    AudioManager.setAudioSessionOptions({ iosCategory: 'playback', iosMode: 'default' })
    void AudioManager.setAudioSessionActivity(true)
  }, [])

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
        <StatusBar barStyle="light-content" />
        {project === null ? (
          <ListScreen onLoaded={setProject} />
        ) : (
          <PlayerScreen project={project} onBack={() => setProject(null)} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },

  listWrap: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
  appTitle: { color: C.amber, fontSize: 26, fontWeight: '800', letterSpacing: 1 },
  rootLine: { color: C.dim, fontSize: 13, marginTop: 4 },
  rootActions: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  busyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  busyText: { color: C.dim, fontSize: 14 },
  projRows: { marginTop: 14, flex: 1 },
  projRow: {
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8
  },
  sampleRow: { borderStyle: 'dashed', backgroundColor: 'transparent' },
  projName: { color: C.text, fontSize: 16, fontWeight: '700' },
  projMeta: { color: C.faint, fontSize: 12, marginTop: 2 },
  emptyText: { color: C.faint, fontSize: 14, lineHeight: 20, marginVertical: 12 },
  errText: { color: '#e2574c', fontSize: 13, marginTop: 10 },

  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    paddingHorizontal: 16,
    paddingTop: 6,
    gap: 10
  },
  backBtn: { color: C.amber, fontSize: 26, fontWeight: '700', marginTop: -2 },
  title: { color: C.text, fontSize: 20, fontWeight: '700', flexShrink: 1 },
  time: { color: C.dim, fontSize: 13, fontVariant: ['tabular-nums'], marginLeft: 'auto' },

  seekWrap: { paddingHorizontal: 16, paddingTop: 8 },
  bar: { borderRadius: 6, overflow: 'hidden' },

  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 10
  },
  playBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: C.amber,
    alignItems: 'center',
    justifyContent: 'center'
  },
  playText: { color: '#191510', fontSize: 18, fontWeight: '800' },
  skipBtn: {
    paddingHorizontal: 10,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  skipText: { color: C.dim, fontSize: 13, fontWeight: '600' },
  transportRight: { flexDirection: 'row', gap: 8, marginLeft: 'auto' },

  chip: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 13,
    paddingHorizontal: 10,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#221c15'
  },
  chipText: { color: C.dim, fontSize: 12, fontWeight: '700' },

  trainPanel: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    backgroundColor: C.panel,
    borderWidth: 1,
    borderColor: C.border,
    gap: 8
  },
  trainHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  trainTitle: { color: C.text, fontSize: 15, fontWeight: '700' },
  segRow: { flexDirection: 'row', gap: 8 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepLabel: { color: C.dim, fontSize: 13, width: 60 },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepBtnText: { color: C.text, fontSize: 16, fontWeight: '700' },
  stepValue: {
    color: C.text,
    fontSize: 15,
    fontWeight: '700',
    minWidth: 28,
    textAlign: 'center',
    fontVariant: ['tabular-nums']
  },
  caption: { color: C.faint, fontSize: 12 },
  trainStemsLabel: { color: C.dim, fontSize: 12, marginTop: 2 },
  stemChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  stems: { paddingHorizontal: 16, gap: 6, paddingBottom: 6 },
  stemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  stemDot: { width: 10, height: 10, borderRadius: 5 },
  stemLabel: { color: C.text, fontSize: 13, fontWeight: '600', width: 86 },
  stemVol: { flex: 1 },
  youPill: { borderRadius: 8, paddingHorizontal: 6, paddingVertical: 1 },
  youPillText: { color: '#191510', fontSize: 10, fontWeight: '800' },

  lyrics: { flex: 1, marginTop: 4, borderTopWidth: 1, borderTopColor: C.border },
  lyricsPad: { paddingHorizontal: 20, paddingVertical: 14, paddingBottom: 120 },
  line: { paddingVertical: 5, paddingHorizontal: 8, borderRadius: 8 },
  lineSing: {
    backgroundColor: 'rgba(242, 193, 78, 0.07)',
    borderLeftWidth: 3,
    borderLeftColor: C.amber
  },
  lineText: { fontSize: 17, lineHeight: 24 },
  word: { color: C.faint, fontWeight: '500' },
  wordPast: { color: '#6e6350' },
  wordCurrent: { color: C.text },
  wordSung: { color: C.amber, fontWeight: '700' },
  wordSungSing: { color: '#ffd97a' }
})
