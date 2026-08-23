import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CustomTrack,
  EngineStatus,
  KeyInfo,
  LyricLine,
  MelodyInfo,
  ProjectSettings,
  SeparationProgress
} from '../../shared/types'
import {
  BEAT_DETECT_VERSION,
  KEY_DETECT_VERSION,
  detectBeats,
  estimateKey,
  estimateKeyFromStems,
  sanitizeKeyInfo,
  type DetectedBeats,
  type KeyGuess,
  type MlGrid
} from './audio/analysis'
import {
  applyUserBars,
  clearUserBar,
  MET_DEFAULTS,
  sanitizeBeatInfo,
  sanitizeMetronome,
  setUserBar,
  type BeatInfo,
  type MetronomeConfig
} from './audio/beat'
import { MultitrackEngine } from './audio/engine'
import { decodeMelody, encodeMelody, melodyFitsSong, PITCH_DETECT_VERSION } from './audio/melody'
import type { MicDevice } from './audio/mic'
import { computePeaks } from './audio/peaks'
import { stemSampleRate } from './audio/stem-rate'
import DropScreen from './components/DropScreen'
import LogPanel from './components/LogPanel'
import LyricsPanel, { type LyricsState } from './components/LyricsPanel'
import LibraryImport from './components/LibraryImport'
import ProjectPicker from './components/ProjectPicker'
import SetupWizard from './components/SetupWizard'
import PitchStrip, { type MelodyState } from './components/PitchStrip'
import SettingsModal from './components/SettingsModal'
import SetupModal from './components/SetupModal'
import TrackStack from './components/TrackStack'
import WindowButtons from './components/WindowButtons'
import Transport from './components/Transport'
import {
  cleanSongName,
  customTrackId,
  CUSTOM_COLORS,
  fmtTime,
  orderedStems,
  sanitizeAudioPrefs,
  sanitizeTraining,
  trackLabel,
  TRACK_META,
  TRAIN_DEFAULTS,
  trainingWindows,
  type AudioPrefs,
  type TimeView,
  type TrainingConfig,
  type UITrack
} from './model'

type Phase = 'empty' | 'loading' | 'ready'

const ACCEPT = '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.aif,.aiff,audio/*'

/**
 * How long the view takes to glide to the next screenful behind the playhead.
 * The repaint a view change costs holds the glide to ~37fps whatever this is,
 * so the length is what sets how far the song slides per frame: at 480ms the
 * fastest frame moved 11% of the screen, which still read as a lurch.
 */
const FOLLOW_MS = 750


/**
 * The mono signal the melody tracker runs on, and the rate it must be told.
 *
 * Read from the stem FILE at the rate the file states, not from the playing
 * buffer: the engine's AudioContext resamples everything to the output
 * device's rate, and the tracker derives its hop from whatever rate it is
 * handed, so tracking the playback buffer makes a project's stored line — hop
 * and frame count both — a property of the machine that happened to open it
 * rather than of the song (audio/stem-rate.ts spells the numbers out). The C++
 * core reads the file, so reading the file is what agrees with it.
 *
 * Falls back to the playback buffer when there is no readable stem to go to:
 * an unsaved split whose path never landed, a header in neither format, a
 * stem that has gone missing. A line tracked that way is still this song's
 * line and still saves — it is just framed by whatever rate the device runs
 * at, which is the state every project was in before this.
 */
/**
 * One stem, decoded at the rate its FILE states — the shared primitive under
 * every analysis input. `decodeAudioData` resamples to its context's rate, so
 * the context is built at the file's own and the decode is a pass-through:
 * the analysis sees the samples the C++ core reads. Null when the file cannot
 * say (unreadable, foreign format) — the caller decides what to fall back to,
 * and says so out loud, because a silent fallback IS the bug this exists to
 * fix, wearing the current stamp.
 */
async function decodeStemAtFileRate(path: string): Promise<AudioBuffer | null> {
  const one = async (p: string): Promise<AudioBuffer | null> => {
    try {
      const bytes = await window.singz.readAudio(p)
      const sr = stemSampleRate(bytes)
      if (sr === null) return null
      return await new OfflineAudioContext(1, 1, sr).decodeAudioData(bytes)
    } catch {
      return null
    }
  }
  const direct = await one(path)
  if (direct) return direct
  // A .wav that no longer exists is usually the v1->v2 upgrade running
  // beside this analysis: convertStemsToFlac writes the verified .flac and
  // THEN unlinks the .wav, per stem, while stemPathsRef keeps naming .wav
  // until the whole upgrade lands. One of the two files always exists — so
  // try the sibling before falling back to the device-rate buffer, which
  // would be the old bug auto-saved under the new stamp.
  if (/\.wav$/i.test(path)) return one(path.replace(/\.wav$/i, '.flac'))
  return null
}

/**
 * The beat/key analyses' stems, decoded from their FILES at the rate the
 * files state — never the playing buffers, which Chromium resampled to the
 * output device's rate. The beat detector's whole octave decision rides on
 * this: monoAt44k resamples a device-rate buffer BACK down through linear
 * interpolation, and on that doubly-resampled audio the ground-truth harness
 * (eval/beats/run-current.mjs, which has only ever scored the file-rate path)
 * measured Wild World at 156.6 bpm — the exact number its GT entry records as
 * "the pre-v16 wrong answer". detVersion 22 is the stamp of file-fed grids.
 *
 * Composes exactly the aux the playback refs did: `ids` is the AUDIBLE lane
 * order, so silent guitar/piano stems stay out of the vote here too. Per-stem
 * fallback to the playback buffer, loudly — a missing file should degrade one
 * lane, not the song.
 */
async function analysisStems(
  paths: Record<string, string> | null,
  ids: string[],
  fallback: { drums: AudioBuffer | null; bass: AudioBuffer | null; vocals: AudioBuffer | null; inst: AudioBuffer[] }
): Promise<{ drums: AudioBuffer | null; bass: AudioBuffer | null; vocals: AudioBuffer | null; inst: AudioBuffer[] }> {
  const one = async (id: string, fb: AudioBuffer | null): Promise<AudioBuffer | null> => {
    const path = paths?.[id]
    if (!path) return fb
    const decoded = await decodeStemAtFileRate(path)
    if (decoded) return decoded
    // E2E drivers read these, the same way they read the beat-model warnings
    console.warn(`analysis: ${path} could not be read at its own rate — using the playback buffer at ${fb?.sampleRate ?? '?'} Hz`)
    return fb
  }
  const instIds = ids.filter((id) => id !== 'vocals' && id !== 'drums' && id !== 'bass')
  const inst = (await Promise.all(instIds.map((id, i) => one(id, fallback.inst[i] ?? null)))).filter(
    (b): b is AudioBuffer => b !== null
  )
  return {
    drums: await one('drums', fallback.drums),
    bass: await one('bass', fallback.bass),
    vocals: await one('vocals', fallback.vocals),
    inst
  }
}

async function melodyInput(
  path: string | null,
  buf: AudioBuffer
): Promise<{ mono: Float32Array; sampleRate: number }> {
  const fold = (b: AudioBuffer): Float32Array => {
    const chans = Math.min(2, b.numberOfChannels)
    const mono = new Float32Array(b.length)
    for (let c = 0; c < chans; c++) {
      const data = b.getChannelData(c)
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / chans
    }
    return mono
  }
  if (path) {
    const decoded = await decodeStemAtFileRate(path)
    if (decoded) return { mono: fold(decoded), sampleRate: decoded.sampleRate }
    // E2E drivers read these, the same way they read the beat-model warnings
    console.warn(`melody: ${path} could not be read at its own rate — tracking the playback buffer at ${buf.sampleRate} Hz`)
  }
  return { mono: fold(buf), sampleRate: buf.sampleRate }
}

/**
 * The beat grid through the core, when the binary is here — Phase 4 of the
 * cutover. The renderer still decodes the stems (the neural mix is rendered
 * HERE, from Chromium's decode — the model's canonical input, docs/BEAT-
 * DETECTION.md) and still produces the ML grid; what moves out is the
 * 1.7-second synchronous detectBeats call. The parity gate held every branch
 * of the ML fork IDENTICAL over the whole library with real grids before this
 * swap (eval/beats-parity.mjs --library --ml), which is what licensed it.
 * Returns null when the core cannot answer — wrong stamp, missing binary,
 * failed run — after saying WHY out loud; the caller then runs the TS.
 */
/**
 * One combined core pass — Phase 5 of the cutover, the shape the user set:
 * "the core can do melody/key/beats in one pass, configurable via cli args;
 * the TS asks for all simultaneously." One child, every stem file read once
 * BY THE CORE (file paths, never streamed buffers: analysisStems' per-lane
 * fallback can hand back a device-rate playback buffer, and streaming would
 * carry that into the core silently — the rate-bug class this session
 * closed twice). The lattice arrives late over the child's stdin, so melody
 * and key run while the renderer's own model is still busy.
 *
 * Returns the per-part results; every refusal (missing binary, wrong stamp,
 * malformed part) is a per-part `undefined` AFTER a loud warn, and the
 * caller runs that part's TS fallback.
 */
let analyzeRunSeq = 0

async function runCombinedCore(
  want: { melody: boolean; key: boolean; beats: boolean },
  paths: Record<string, string> | null,
  ids: string[],
  provideMl: () => Promise<{
    ml: MlGrid | null
    lineStarts: number[] | null
    words: { s: number; e: number }[] | null
  }>
): Promise<{
  melody?: { f0: Float32Array; raw?: Float32Array; rms?: Float32Array; hopSec: number }
  key?: { pc: number; minor: boolean }
  beats?: DetectedBeats | null
}> {
  const out: Awaited<ReturnType<typeof runCombinedCore>> = {}
  if (!paths) return out
  const avail = await window.singz.melodyNativeAvailable().catch(() => ({ ok: false, available: false }))
  if (!avail.available) return out
  const instPaths = ids
    .filter((id) => id !== 'vocals' && id !== 'drums' && id !== 'bass')
    .map((id) => paths[id])
    .filter((p): p is string => typeof p === 'string')
  const token = `run-${++analyzeRunSeq}`
  const resP = window.singz
    .analyzeNative({
      token,
      want,
      vocals: ids.includes('vocals') ? (paths.vocals ?? null) : null,
      drums: want.beats ? (paths.drums ?? null) : null,
      bass: ids.includes('bass') ? (paths.bass ?? null) : null,
      inst: instPaths,
      // the lyric aux is only KNOWN late (lyrics load while the child is
      // already tracking melody) — it travels with the lattice over stdin
      lineStarts: null,
      words: null
    })
    .catch((e) => ({ ok: false as const, error: String(e) }))
  if (want.beats) {
    // the model's own render happens renderer-side while the child already
    // tracks melody and key; the child's beats stage blocks on stdin for the
    // lattice AND the lyric aux, gathered at this late moment
    const late = await provideMl().catch(() => ({ ml: null, lineStarts: null, words: null }))
    await window.singz
      .analyzeProvideMl(
        late.ml
          ? {
              beats: Array.from(late.ml.beats),
              downbeats: Array.from(late.ml.downbeats),
              ...(late.ml.beatProb ? { beatProb: Array.from(late.ml.beatProb) } : {}),
              ...(late.ml.downbeatProb ? { downbeatProb: Array.from(late.ml.downbeatProb) } : {}),
              ...(late.ml.fps ? { fps: late.ml.fps } : {})
            }
          : null,
        { lineStarts: late.lineStarts, words: late.words },
        token
      )
      .catch(() => undefined)
  }
  const res = await resP
  if (!res.ok) {
    // E2E drivers read these, like the beat-model warnings
    console.warn(`analysis: singz-analyze failed (${res.error}) — falling back to the in-app detectors`)
    return out
  }
  const combined = res
  if (want.melody) {
    const m = combined.melody
    if (m?.ok && m.f0 && m.hopSec && m.detVersion === PITCH_DETECT_VERSION) {
      out.melody = { f0: m.f0, raw: m.raw, rms: m.rms, hopSec: m.hopSec }
    } else if (m) {
      console.warn(
        m.ok
          ? `melody: singz-analyze is stamped v${m.detVersion} but the app is v${PITCH_DETECT_VERSION} — a stale binary; falling back to the in-app tracker`
          : `melody: singz-analyze failed (${m.error}) — falling back to the in-app tracker`
      )
    }
  }
  if (want.key) {
    const k = combined.key
    if (k?.ok && k.pc !== undefined && k.minor !== undefined && k.detVersion === KEY_DETECT_VERSION) {
      out.key = { pc: k.pc, minor: k.minor }
    } else if (k) {
      console.warn(
        k.ok
          ? `key: singz-analyze is stamped v${k.detVersion} but the app is v${KEY_DETECT_VERSION} — a stale binary; falling back to the in-app detector`
          : `key: singz-analyze failed (${k.error}) — falling back to the in-app detector`
      )
    }
  }
  if (want.beats) {
    const b = combined.beats
    if (b?.ok && b.detVersion === BEAT_DETECT_VERSION) {
      out.beats =
        !b.beats || b.beats.length === 0
          ? null // the detector's own "no steady beat"
          : {
              beats: b.beats,
              bpm: b.bpm ?? 0,
              beatsPerBar: b.beatsPerBar ?? 4,
              downbeat: b.downbeat ?? 0,
              ...(b.hasDownbeats && b.downbeats ? { downbeats: b.downbeats } : {}),
              ...(b.suspectAt && b.suspectAt.length > 0 ? { suspectAt: b.suspectAt } : {})
            }
    } else if (b) {
      console.warn(
        b.ok
          ? `beats: singz-analyze is stamped v${b.detVersion} but the app is v${BEAT_DETECT_VERSION} — a stale binary; falling back to the in-app detector`
          : `beats: singz-analyze failed (${b.error}) — falling back to the in-app detector`
      )
    }
  }
  return out
}

/** Guitar/piano lanes only appear when the song actually has them. */
function audibleStems(order: string[], buffers: AudioBuffer[]): { order: string[]; buffers: AudioBuffer[] } {
  const keptOrder: string[] = []
  const keptBuffers: AudioBuffer[] = []
  for (let i = 0; i < order.length; i++) {
    if (order[i] === 'guitar' || order[i] === 'piano') {
      const data = buffers[i].getChannelData(0)
      let energy = 0
      const step = Math.max(1, Math.floor(data.length / 200000))
      let n = 0
      for (let j = 0; j < data.length; j += step) {
        energy += data[j] * data[j]
        n++
      }
      if (Math.sqrt(energy / Math.max(1, n)) < 0.004) continue
    }
    keptOrder.push(order[i])
    keptBuffers.push(buffers[i])
  }
  return { order: keptOrder, buffers: keptBuffers }
}

/** Diagnostics hook (same idea as __melody/__mlGrid): every in-app beat
 *  detection publishes its inputs and debug trail so E2E drivers can diff the
 *  app run against the eval harness — app-vs-harness grid divergences are
 *  invisible without this. */
function publishBeatDbg(
  why: string,
  src: 'core' | 'ts',
  drums: AudioBuffer,
  aux: {
    bass: AudioBuffer | null
    vocals: AudioBuffer | null
    inst: AudioBuffer[]
    lineStarts: number[] | null
    ml: MlGrid | null | undefined
  },
  det: ReturnType<typeof detectBeats>,
  dbg: Record<string, unknown>
): void {
  const stat = (b: AudioBuffer | null): { sr: number; n: number; ch: number } | null =>
    b ? { sr: b.sampleRate, n: b.length, ch: b.numberOfChannels } : null
  ;(window as { __beatDbg?: unknown }).__beatDbg = {
    why,
    src,
    drums: stat(drums),
    bass: stat(aux.bass),
    vocals: stat(aux.vocals),
    inst: aux.inst.map((b) => stat(b)),
    lineStarts: aux.lineStarts?.length ?? null,
    ml: aux.ml ? { beats: aux.ml.beats.length, downbeats: aux.ml.downbeats.length } : null,
    det: det
      ? {
          bpm: det.bpm,
          beatsPerBar: det.beatsPerBar,
          downbeat: det.downbeat,
          beats: det.beats,
          downbeats: det.downbeats ?? null,
          suspectAt: det.suspectAt ?? null
        }
      : null,
    dbg
  }
}

function makeTrack(
  id: string,
  buffer: AudioBuffer,
  over?: Partial<Pick<UITrack, 'label' | 'color' | 'custom'>>
): UITrack {
  const meta = TRACK_META[id] ?? { label: id, color: '#bfb49d' }
  const { peaks, scale } = computePeaks(buffer)
  return { id, ...meta, peaks, buffer, scale, muted: false, solo: false, volume: 1, ...over }
}

function EngineChip({
  status,
  onClick
}: {
  status: EngineStatus | null
  onClick: () => void
}): React.JSX.Element {
  if (!status) {
    return (
      <span className="chip-status">
        <span className="dot idle" /> checking splitter…
      </span>
    )
  }
  if (status.ok) {
    return (
      <button
        type="button"
        className="chip-status"
        title={`${status.command} — click to manage AI models`}
        onClick={onClick}
      >
        <span className="dot ok" /> splitter ready
      </button>
    )
  }
  return (
    <button type="button" className="chip-status warn" onClick={onClick}>
      <span className="dot warn" /> splitter setup
    </button>
  )
}

export default function App(): React.JSX.Element {
  const [engine] = useState(() => {
    const e = new MultitrackEngine()
    ;(window as unknown as { __engine: MultitrackEngine }).__engine = e
    return e
  })
  const [phase, setPhase] = useState<Phase>('empty')
  const [song, setSong] = useState<{ path: string; name: string } | null>(null)
  const [tracks, setTracks] = useState<UITrack[]>([])
  const [split, setSplit] = useState(false)
  const [stemFiles, setStemFiles] = useState<Record<string, string> | null>(null)
  const [sep, setSep] = useState<SeparationProgress | null>(null)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  /** Catalog page shown over a loaded song — the song stays live underneath. */
  const [showCatalog, setShowCatalog] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [audioPrefs, setAudioPrefs] = useState<AudioPrefs>(() => {
    try {
      const raw = localStorage.getItem('singz.audio')
      return raw ? sanitizeAudioPrefs(JSON.parse(raw)) : {}
    } catch {
      return {}
    }
  })
  /** App-level verdict on the saved output ("not connected", "not allowed"). */
  const [outputStatus, setOutputStatus] = useState<string | null>(null)
  /** What the mic is actually listening through, when it's on. */
  const [micDevice, setMicDevice] = useState<MicDevice | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [ver, setVer] = useState('')
  const [update, setUpdate] = useState<import('../../shared/types').UpdateState>({ state: 'none' })
  const [isProject, setIsProject] = useState(false)
  /** A project folder opened from outside the library can be brought into it. */
  const [inLibrary, setInLibrary] = useState(true)
  const [projectDir, setProjectDir] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [importing, setImporting] = useState(false)
  const [editName, setEditName] = useState<string | null>(null)
  const [wizard, setWizard] = useState<{
    models: import('../../shared/types').ModelInfo[]
    origin: 'auto' | 'manual'
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [dirty, setDirty] = useState(false)
  const [karaoke, setKaraoke] = useState(false)
  const [lyrics, setLyrics] = useState<LyricsState>({ status: 'idle' })
  const [melody, setMelody] = useState<MelodyState>({ status: 'none' })
  /** Beat-detection progress (0..1) — the HUD's second analysis phase.
   *  Driven by the pack runner's PROG lines; null = not detecting. */
  const [beatProg, setBeatProg] = useState<number | null>(null)
  useEffect(
    () =>
      window.singz.onBeatsProgress((p) => {
        // only track while a detection this renderer started is active
        setBeatProg((cur) => (cur === null ? cur : Math.max(cur, p)))
      }),
    []
  )
  const analysisNote =
    melody.status === 'computing'
      ? { label: 'Reading the melody', p: melody.p }
      : beatProg !== null
        ? { label: 'Finding the beat', p: beatProg }
        : null
  const [transpose, setTranspose] = useState(0)
  const [tempoRate, setTempoRate] = useState(1)
  const [view, setView] = useState<TimeView | null>(null)
  /** The rendered view, for the follow glide to start its easing from. */
  const viewLive = useRef<TimeView | null>(null)
  viewLive.current = view
  const [selection, setSelection] = useState<{ s: number; e: number } | null>(null)
  const [loopOn, setLoopOn] = useState(false)
  const [training, setTraining] = useState(false)
  const [trainCfg, setTrainCfg] = useState<TrainingConfig>(() => {
    try {
      const raw = localStorage.getItem('singz.train')
      return raw ? sanitizeTraining(JSON.parse(raw)) : TRAIN_DEFAULTS
    } catch {
      return TRAIN_DEFAULTS
    }
  })
  const [duckedIds, setDuckedIds] = useState<string[]>([])
  const [songInfo, setSongInfo] = useState<{ key: KeyGuess | null; bpm: number | null }>({
    key: null,
    bpm: null
  })
  const [beatInfo, setBeatInfo] = useState<BeatInfo | null>(null)
  /** The stored form of the melody line, written back on every save so a
   *  tracked song never pays for its pitch line twice. */
  const [melodyInfo, setMelodyInfo] = useState<MelodyInfo | null>(null)
  /** The stored key, same contract: estimated once, saved, re-estimated only
   *  when KEY_DETECT_VERSION moves on. The ref mirrors it for applyMelody,
   *  which runs before the state lands. */
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null)
  const keyInfoRef = useRef<KeyInfo | null>(null)
  /** Set when analysis just produced something a saved project should keep —
   *  a fresh pitch line, a (re)stamped auto grid — consumed by an effect that
   *  saves the project so phones (which have neither detector) get it too. */
  const [analysisAutoSave, setAnalysisAutoSave] = useState(false)
  const [metCfg, setMetCfg] = useState<MetronomeConfig>(() => {
    try {
      const raw = localStorage.getItem('singz.met')
      return raw ? sanitizeMetronome(JSON.parse(raw)) : MET_DEFAULTS
    } catch {
      return MET_DEFAULTS
    }
  })
  const beatInfoRef = useRef(beatInfo)
  beatInfoRef.current = beatInfo
  const drumsBufRef = useRef<AudioBuffer | null>(null)
  const loadSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const trackInputRef = useRef<HTMLInputElement>(null)
  const sepRunningRef = useRef(false)
  sepRunningRef.current = sep !== null
  const vocalsBufRef = useRef<AudioBuffer | null>(null)
  /** Where the vocals stem in `vocalsBufRef` came from. The melody is tracked
   *  from the FILE, not from that buffer: `decodeAudioData` resamples to the
   *  playback device's rate, and every analysis derives something from the
   *  rate it is handed — the melody its hop, the beat detector its whole
   *  octave decision (monoAt44k resamples BACK from the device rate, and the
   *  ground-truth harness only ever scored the file-rate path; Wild World
   *  came out at the 156.6 bpm the GT records as "the pre-v16 wrong answer").
   *  So analyses read the FILES (see audio/stem-rate.ts). Assigned by hand
   *  next to the buffers, not read from `stemFiles` state — the load path
   *  calls prepMelody in the same breath as `setStemFiles`, a render too early
   *  for state to have caught up, and a stale path here is silently the old
   *  bug again. */
  const stemPathsRef = useRef<Record<string, string> | null>(null)
  /** The AUDIBLE stems, in lane order — which of the six the analyses use.
   *  Kept beside the paths so the file-reading path composes exactly the aux
   *  the buffer path did: silent guitar/piano lanes stay out of the vote. */
  const audibleIdsRef = useRef<string[]>([])
  const bassBufRef = useRef<AudioBuffer | null>(null)
  /** Non-drum, non-bass, non-vocal stems (other/guitar/piano) — the beat
   *  tracker's fill where drums are silent. */
  const instBufsRef = useRef<AudioBuffer[]>([])
  const linesRef = useRef<LyricLine[] | null>(null)
  const originalBufRef = useRef<AudioBuffer | null>(null)
  const lyricsRef = useRef(lyrics)
  lyricsRef.current = lyrics
  const melodyRef = useRef(melody)
  melodyRef.current = melody
  /** A saved project's stored pitch line, waiting for prepMelody to adopt it
   *  (or throw it away as the work of an older tracker). */
  const storedMelodyRef = useRef<{ info: MelodyInfo; f0: Float32Array } | null>(null)
  /** Adopt a detected key (store + display + autosave) — one implementation
   *  for every path that produces one, core or TS, combined or standalone. */
  const applyKeyRef = useRef<((pc: number, minor: boolean) => void) | null>(null)
  /** Does THIS song still owe a key? Read by the combined pass so beats and
   *  key share one child when both are owed. */
  const keyNeededRef = useRef<(() => boolean) | null>(null)
  /** The seq whose combined pass CARRIES the key — the standalone key path
   *  must stand down for it, or the early melody part races it into the
   *  single-flight (the same race the beats stash kills, on the key-only
   *  lane: a no-drums song warned "already running" and burned a duplicate
   *  harmonic decode on a machine where the core had already answered). */
  const keyCarriedBySeqRef = useRef<number | null>(null)
  /** A combined core pass prepMelody is running (or ran) for THIS song —
   *  ARMED BEFORE the pass starts, because the melody part streams out of
   *  the child seconds ahead of the final result, and applyMelody's beat
   *  block fires on it: without the promise it would spawn a SECOND combined
   *  child into the single-flight (measured: "An analysis is already
   *  running." and everything falling back to TS). The block awaits the
   *  promise instead. stems null = the pass never got that far (no binary):
   *  the block decodes its own. `beats` undefined = the core could not
   *  answer that part (TS fallback); null = the detector's own "no beat". */
  const pendingCoreAnalysisRef = useRef<{
    seq: number
    promise: Promise<{
      stems: Awaited<ReturnType<typeof analysisStems>> | null
      ml: MlGrid | null
      beats: DetectedBeats | null | undefined
      key: { pc: number; minor: boolean } | undefined
    }>
  } | null>(null)
  /** pYIN's worker while it runs — held so leaving the song can stop it. */
  const melodyWorkerRef = useRef<Worker | null>(null)
  const selectionRef = useRef(selection)
  selectionRef.current = selection
  const showCatalogRef = useRef(showCatalog)
  showCatalogRef.current = showCatalog
  const selMemReadyRef = useRef(false)
  const trainingRef = useRef(training)
  trainingRef.current = training
  const trainCfgRef = useRef(trainCfg)
  trainCfgRef.current = trainCfg
  const tracksRef = useRef(tracks)
  tracksRef.current = tracks

  // The coach configures the drill once — the setup follows them across songs.
  useEffect(() => {
    localStorage.setItem('singz.train', JSON.stringify(trainCfg))
  }, [trainCfg])

  // Metronome prefs follow the singer across songs too (projects override on open).
  useEffect(() => {
    localStorage.setItem('singz.met', JSON.stringify(metCfg))
  }, [metCfg])

  // Device picks and the output level follow the machine, not the song.
  useEffect(() => {
    localStorage.setItem('singz.audio', JSON.stringify(audioPrefs))
  }, [audioPrefs])

  const masterVol = audioPrefs.master ?? 1
  useEffect(() => {
    engine.setMasterVolume(masterVol)
  }, [engine, masterVol])

  const changeMasterVol = useCallback((v: number) => {
    setAudioPrefs((p) => ({ ...p, master: Math.max(0, Math.min(1, v)) }))
  }, [])

  // Keep the context's sink pointed at the saved output. Single-flight,
  // last-wins: BT headsets fire devicechange in bursts. The saved id is
  // never cleared here — plugging the device back in restores it.
  const outputSeq = useRef(0)
  const reconcileOutput = useCallback(
    async (wantId: string | undefined) => {
      const seq = ++outputSeq.current
      try {
        if (wantId) {
          const devs = await navigator.mediaDevices.enumerateDevices()
          if (seq !== outputSeq.current) return
          if (!devs.some((d) => d.kind === 'audiooutput' && d.deviceId === wantId)) {
            await engine.setOutput('')
            if (seq === outputSeq.current) {
              setOutputStatus('Saved playback device not connected — using the system default')
            }
            return
          }
        }
        await engine.setOutput(wantId ?? '')
        if (seq === outputSeq.current) setOutputStatus(null)
      } catch (err) {
        if (seq !== outputSeq.current) return
        const name = err instanceof DOMException ? err.name : ''
        setOutputStatus(
          name === 'NotAllowedError'
            ? "SingZ wasn't allowed to switch playback devices"
            : 'Could not switch to the saved playback device — using the system default'
        )
      }
    },
    [engine]
  )

  useEffect(() => {
    void reconcileOutput(audioPrefs.outputId)
    const onChange = (): void => void reconcileOutput(audioPrefs.outputId)
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange)
  }, [audioPrefs.outputId, reconcileOutput])

  // Apply-then-commit: a pick that fails never lands in the prefs, so the
  // dropdown (valued from them) snaps back by itself.
  const changeOutput = useCallback(
    async (id: string | undefined) => {
      if (!id) {
        setAudioPrefs((p) => ({ ...p, outputId: undefined }))
        setOutputStatus(null)
        return
      }
      try {
        await engine.setOutput(id)
        setAudioPrefs((p) => ({ ...p, outputId: id }))
        setOutputStatus(null)
      } catch (err) {
        const name = err instanceof DOMException ? err.name : ''
        setOutputStatus(
          name === 'NotAllowedError'
            ? "SingZ wasn't allowed to switch playback devices"
            : 'Could not switch to that device — still on the previous one'
        )
      }
    },
    [engine]
  )

  const changeInput = useCallback((id: string | undefined) => {
    // stored right away; PitchStrip restarts a running mic and validation
    // surfaces through micDevice when the mic next starts
    setAudioPrefs((p) => ({ ...p, inputId: id }))
  }, [])

  useEffect(() => {
    engine.setBeats(beatInfo)
  }, [engine, beatInfo])

  useEffect(() => {
    engine.setMetronome(metCfg)
  }, [engine, metCfg])

  // Mirror the engine's ducked set (lane dimming + the pulsing train button).
  useEffect(
    () =>
      engine.subscribe(() => {
        setDuckedIds((prev) => {
          const next = engine.duckedStems
          return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next
        })
      }),
    [engine]
  )

  // Every song remembers its selection and loop arm (projects additionally
  // carry them in project.json, which wins on open). Guarded so the load-time
  // reset never clobbers the stored value before restore runs.
  useEffect(() => {
    const path = song?.path
    if (!path || !selMemReadyRef.current) return
    const key = `singz.sel:${path}`
    if (selection) {
      localStorage.setItem(key, JSON.stringify({ s: selection.s, e: selection.e, loop: loopOn }))
    } else {
      localStorage.removeItem(key)
    }
  }, [selection, loopOn, song])

  useEffect(() => engine.subscribe(() => setPlaying(engine.playing)), [engine])

  useEffect(() => {
    void window.singz.updateStateNow().then(setUpdate)
    return window.singz.onUpdateState(setUpdate)
  }, [])

  useEffect(() => {
    void window.singz.appVersion().then(setVer)
    void window.singz.checkEngine().then(setEngineStatus)
    // First-run setup: open when something required is missing.
    void window.singz.modelsStatus().then((models) => {
      if (models.some((m) => m.required && !m.present)) setWizard({ models, origin: 'auto' })
    })
  }, [])

  const openWizard = useCallback(async (origin: 'auto' | 'manual') => {
    const models = await window.singz.modelsStatus()
    setWizard({ models, origin })
  }, [])

  const closeWizard = useCallback(() => {
    setWizard(null)
    void window.singz.checkEngine(true).then(setEngineStatus)
  }, [])

  // body.modal-open — which pauses the background animation loops, because
  // the scrim's backdrop blur re-rasters the whole window on every change —
  // is now owned by the kit's <Modal>, ref-counted across every dialog. This
  // used to be one of two independent owners (DropScreen had the other), so
  // closing either cleared the flag while the other was still up.

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 7000)
    return () => clearTimeout(t)
  }, [error])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
  }, [notice])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Comma' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setShowSettings(true)
        return
      }
      const tgt = e.target as HTMLElement
      const inText =
        (tgt instanceof HTMLInputElement && tgt.type !== 'range') ||
        tgt instanceof HTMLTextAreaElement
      if (inText) return
      if (e.code === 'Escape') {
        if (showCatalogRef.current) {
          setShowCatalog(false)
          return
        }
        if (selectionRef.current) {
          setSelection(null)
          setSaveState((st) => (st === 'saved' ? 'idle' : st))
          return
        }
        setKaraoke(false)
        localStorage.setItem('singz.karaoke', '0')
      } else if (e.code === 'Space') {
        e.preventDefault()
        ;(tgt.closest('button') as HTMLElement | null)?.blur()
        togglePlayRef.current()
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault()
        engine.seekBy(-5)
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        engine.seekBy(5)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine])

  const loadPath = useCallback(
    async (path: string) => {
      const reg = await window.singz.registerSource(path)
      if (!reg.ok) {
        setError(reg.error)
        return
      }
      const seq = ++loadSeq.current
      await window.singz.cancelSeparation()
      await window.singz.cancelLyrics()
      setSep(null)
      setSplit(false)
      setStemFiles(null)
      setError(null)
      setNotice(null)
      setKaraoke(false)
      setLyrics({ status: 'idle' })
      setMelody({ status: 'none' })
      setMelodyInfo(null)
      storedMelodyRef.current = null
      // pYIN takes seconds; whatever it is still chewing on belongs to the song
      // being left, not the one arriving.
      melodyWorkerRef.current?.terminate()
      melodyWorkerRef.current = null
      void window.singz.cancelAnalyzeNative() // the core's children die with the song too
      vocalsBufRef.current = null
      stemPathsRef.current = null
      audibleIdsRef.current = []
      drumsBufRef.current = null
      instBufsRef.current = []
      bassBufRef.current = null
      originalBufRef.current = null
      setSongInfo({ key: null, bpm: null })
      setBeatInfo(null)
      setKeyInfo(null)
      keyInfoRef.current = null
      preferRef.current = 'auto'
      setTranspose(0)
      void engine.setTranspose(0)
      setTempoRate(1)
      void engine.setTempo(1)
      selMemReadyRef.current = false
      setSelection(null)
      setLoopOn(false)
      setTraining(false)
      trainingRef.current = false // openKaraoke may consult it before the render flushes
      setView(null)
      setDirty(false)
      setSaveState('idle')
      setPhase('loading')
      setSong({ path: reg.path, name: reg.name })
      setIsProject(Boolean(reg.project))
      setInLibrary(reg.project?.inLibrary ?? true)
      setProjectDir(reg.project?.dir ?? null)
      setEditName(null)
      setShowProjects(false)
      setShowCatalog(false)
      /** Decode the project's added tracks into lanes; a missing one is skipped. */
      const decodeCustom = async (defs?: CustomTrack[]): Promise<UITrack[]> => {
        const out: UITrack[] = []
        for (const c of defs ?? []) {
          try {
            const buf = await engine.decode(await window.singz.readAudio(c.file))
            out.push(makeTrack(c.id, buf, { label: c.label, color: c.color, custom: { file: c.file } }))
          } catch {
            setNotice(`“${c.label}” could not be read — that lane is missing from the mix.`)
          }
        }
        return out
      }
      /** Re-apply a project's saved mute/solo/volume to whichever lanes it has. */
      const applySavedMix = (lanes: UITrack[], saved?: ProjectSettings['tracks']): void => {
        for (const t of lanes) {
          const s = saved?.[t.id]
          if (!s) continue
          t.muted = s.muted
          t.solo = s.solo
          t.volume = s.volume
          engine.setMuted(t.id, s.muted)
          engine.setSolo(t.id, s.solo)
          engine.setVolume(t.id, s.volume)
        }
      }
      try {
        // Saved project with stems: load them directly and restore settings.
        if (reg.project?.stems) {
          const proj = reg.project
          const stems = proj.stems as Record<string, string>
          const rawOrder = orderedStems(stems)
          const decoded = await Promise.all(
            rawOrder.map(async (s) => engine.decode(await window.singz.readAudio(stems[s])))
          )
          if (seq !== loadSeq.current) return
          const { order, buffers } = audibleStems(rawOrder, decoded)
      const hidden = rawOrder.filter((st) => !order.includes(st))
      if (hidden.length > 0) {
        setNotice(
          `Split into six stems — ${hidden.join(' and ')} ${hidden.length > 1 ? 'are' : 'is'} silent in this song, so ${hidden.length > 1 ? 'their lanes are' : 'its lane is'} hidden.`
        )
      }
          // Tracks the singer added themselves decode after the stems and sit
          // below them; one that no longer decodes must not sink the song.
          const lanes = [
            ...order.map((s, i) => makeTrack(s, buffers[i])),
            ...(await decodeCustom(proj.settings.custom))
          ]
          if (seq !== loadSeq.current) return
          engine.load(lanes.map((t) => ({ id: t.id, buffer: t.buffer })))
          applySavedMix(lanes, proj.settings.tracks)
          setTracks(lanes)
          setSplit(true)
          setStemFiles(stems)
          setIsProject(true)
          vocalsBufRef.current = buffers[order.indexOf('vocals')] ?? null
          stemPathsRef.current = stems
          audibleIdsRef.current = order
          drumsBufRef.current = buffers[order.indexOf('drums')] ?? null
          bassBufRef.current = buffers[order.indexOf('bass')] ?? null
          instBufsRef.current = order
            .map((s, i) => (s !== 'vocals' && s !== 'drums' && s !== 'bass' ? buffers[i] : null))
            .filter((b): b is AudioBuffer => !!b)
          // Restore training BEFORE karaoke may reopen: its auto-mute must
          // know training governs the vocals (the ref is set synchronously —
          // state alone would land a render too late).
          const tn = proj.settings.training
          if (tn) {
            setTrainCfg(sanitizeTraining(tn))
            if (tn.on === true) {
              setTraining(true)
              trainingRef.current = true
            }
          }
          // The saved analysis is restored BEFORE karaoke may reopen: adopting
          // a stored pitch line is synchronous, and it asks in the same breath
          // whether this song still needs its beat grid tracked. The refs are
          // assigned by hand for the same reason training's is — state alone
          // would land a render too late, and the answer would be "no grid
          // saved, track it again" on every open.
          const bg = sanitizeBeatInfo(proj.settings.beat)
          beatInfoRef.current = bg
          // A stored key with the current stamp fills the info card before the
          // stems even decode; any other stamp re-estimates in applyMelody.
          const kg = sanitizeKeyInfo(proj.settings.key)
          keyInfoRef.current = kg
          setKeyInfo(kg)
          const restoredKey =
            kg && kg.detVersion === KEY_DETECT_VERSION ? { pc: kg.pc, minor: kg.minor } : null
          if (bg || restoredKey) {
            if (bg) setBeatInfo(bg)
            setSongInfo({ key: restoredKey, bpm: bg?.bpm ?? null })
          }
          const md = decodeMelody(proj.settings.melody)
          storedMelodyRef.current = md
          setMelodyInfo(md?.info ?? null)
          if (localStorage.getItem('singz.karaoke') === '1') openKaraokeRef.current?.()
          else prepMelodyRef.current?.()
          const st = proj.settings.transpose ?? 0
          setTranspose(st)
          void engine.setTranspose(st)
          const tr = proj.settings.tempo ?? 1
          setTempoRate(tr)
          void engine.setTempo(tr)
          if (proj.settings.metronome) {
            const saved = sanitizeMetronome(proj.settings.metronome)
            // The click and the count-in belong to the song; the grid lines are
            // how the singer looks at any song — opening one saved before the
            // view existed must not switch them off underneath them.
            setMetCfg((cur) => ({ ...saved, grid: cur.grid }))
          }
          const v = proj.settings.view
          if (v && Number.isFinite(v.s) && Number.isFinite(v.e) && v.e - v.s > 0.05) {
            setView({ s: Math.max(0, v.s), e: v.e })
          }
          const sel = proj.settings.selection
          if (sel && Number.isFinite(sel.s) && Number.isFinite(sel.e) && sel.e - sel.s > 0.05) {
            setSelection({ s: Math.max(0, sel.s), e: sel.e })
          }
          if (proj.settings.loop === true) setLoopOn(true)
          selMemReadyRef.current = true
          setSaveState('saved')
          setPhase('ready')
          void prepLyricsRef.current?.()
          if ((proj.formatVersion ?? 1) < 2) {
            // Old WAV project: repack stems as FLAC in the background (the
            // buffers above are already in memory, so nothing here notices).
            void window.singz.upgradeProject(proj.dir).then((r) => {
              if (seq !== loadSeq.current) return // these are another song's stems now
              if (r.ok && r.converted) {
                // The wav this named has been unlinked. Nothing reachable reads
                // it after this point — a melody run that wanted it started
                // back at prepMelody, before the upgrade was even invoked — but
                // a stale path here fails SILENTLY, falling back to the
                // device-rate buffer under a v2 stamp, which is the old bug
                // wearing the new stamp.
                stemPathsRef.current = stemPathsRef.current
                  ? Object.fromEntries(
                      Object.entries(stemPathsRef.current).map(([id, f]) => [id, f.replace(/\.wav$/, '.flac')])
                    )
                  : null
                setStemFiles((prev) => {
                  if (!prev) return prev
                  const next: Record<string, string> = {}
                  for (const [s, p] of Object.entries(prev)) {
                    next[s] = p.replace(/\.wav$/, '.flac')
                  }
                  return next
                })
              }
            })
          }
          return
        }

        const buf = await window.singz.readAudio(reg.path)
        const audio = await engine.decode(buf)
        if (seq !== loadSeq.current) return
        originalBufRef.current = audio
        // A project saved before it was ever split has no stems, but it can
        // still carry tracks the singer added — those lanes come back here.
        const lanes = [
          makeTrack('original', audio),
          ...(await decodeCustom(reg.project?.settings.custom))
        ]
        if (seq !== loadSeq.current) return
        engine.load(lanes.map((t) => ({ id: t.id, buffer: t.buffer })))
        applySavedMix(lanes, reg.project?.settings.tracks)
        setTracks(lanes)
        try {
          const mem = JSON.parse(localStorage.getItem(`singz.sel:${reg.path}`) ?? 'null') as {
            s: number
            e: number
            loop?: boolean
          } | null
          if (mem && Number.isFinite(mem.s) && Number.isFinite(mem.e) && mem.e - mem.s > 0.05) {
            setSelection({ s: Math.max(0, mem.s), e: mem.e })
            if (mem.loop === true) setLoopOn(true)
          }
        } catch {
          /* corrupt entry — ignore */
        }
        selMemReadyRef.current = true
        setPhase('ready')
        // Look for lyrics right away (cache/online only — never triggers the
        // model download without consent), so karaoke opens with answers ready.
        void prepLyricsRef.current?.()
      } catch (err) {
        console.error('song load failed:', err) // E2E drivers read this; the toast hides the cause
        if (seq !== loadSeq.current) return
        setPhase('empty')
        setSong(null)
        setTracks([])
        setError('Could not decode that audio file.')
      }
    },
    [engine]
  )

  const loadFile = useCallback(
    async (file: File) => {
      const path = window.singz.pathForFile(file)
      if (!path) {
        setError('Could not resolve that file on disk.')
        return
      }
      await loadPath(path)
    },
    [loadPath]
  )

  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'))
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault()
      if (hasFiles(e)) setDragDepth((d) => d + 1)
    }
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      setDragDepth((d) => Math.max(0, d - 1))
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      setDragDepth(0)
      const file = e.dataTransfer?.files?.[0]
      if (file) void loadFile(file)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [loadFile])

  /**
   * Swap the engine's lane set — adding, removing or replacing a lane rebuilds
   * every source. engine.load() hands back fresh lanes (unmuted, full volume),
   * so each lane's mixer state is re-applied here, and the playhead and
   * whether it was playing survive the swap.
   */
  const loadLanes = useCallback(
    (list: UITrack[]) => {
      const position = engine.position
      const play = engine.playing
      engine.load(
        list.map((t) => ({ id: t.id, buffer: t.buffer })),
        { position, play }
      )
      for (const t of list) {
        if (t.muted) engine.setMuted(t.id, true)
        if (t.solo) engine.setSolo(t.id, true)
        if (t.volume !== 1) engine.setVolume(t.id, t.volume)
      }
      setTracks(list)
    },
    [engine]
  )

  const startSplit = useCallback(async () => {
    if (!song || sepRunningRef.current) return
    let status = engineStatus
    if (!status?.ok) {
      status = await window.singz.checkEngine(true)
      setEngineStatus(status)
    }
    if (!status.ok) {
      if (status.needsModels) {
        await openWizard('auto')
      } else {
        setShowSetup(true)
      }
      return
    }
    // Some engines want a plain 44.1k WAV — render it from the decoded
    // buffer so any source format/sample-rate works.
    if (status.needsPcm && originalBufRef.current) {
      const orig = originalBufRef.current
      const off = new OfflineAudioContext(2, Math.ceil(orig.duration * 44100), 44100)
      const src = off.createBufferSource()
      src.buffer = orig
      src.connect(off.destination)
      src.start()
      const rendered = await off.startRendering()
      await window.singz.provideSplitInput(
        song.path,
        rendered.getChannelData(0),
        rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0)
      )
    }
    setSep({ stage: 'preparing', percent: 0 })
    const unsub = window.singz.onSeparationProgress((p) => setSep(p))
    const res = await window.singz.separate(song.path)
    unsub()
    if (!res.ok) {
      setSep(null)
      if (!res.cancelled) setError(res.error)
      return
    }
    setSep({ stage: 'loading-stems', percent: 100 })
    try {
      const stems = res.stems as Record<string, string>
      const rawOrder = orderedStems(stems)
      const decoded = await Promise.all(
        rawOrder.map(async (s) => engine.decode(await window.singz.readAudio(stems[s])))
      )
      const { order, buffers } = audibleStems(rawOrder, decoded)
      // The stems replace the full-mix lane; tracks the singer added stay.
      loadLanes([
        ...order.map((s, i) => makeTrack(s, buffers[i])),
        ...tracksRef.current.filter((t) => t.custom)
      ])
      setStemFiles(stems)
      setSplit(true)
      // Fresh stems in an open project are unsaved content.
      setDirty(true)
      setSaveState((st) => (st === 'saved' ? 'idle' : st))
      vocalsBufRef.current = buffers[order.indexOf('vocals')] ?? null
      stemPathsRef.current = stems
      audibleIdsRef.current = order
      drumsBufRef.current = buffers[order.indexOf('drums')] ?? null
      bassBufRef.current = buffers[order.indexOf('bass')] ?? null
      instBufsRef.current = order
        .map((s, i) => (s !== 'vocals' && s !== 'drums' && s !== 'bass' ? buffers[i] : null))
        .filter((b): b is AudioBuffer => !!b)
      // These are different stems than any line already on screen was tracked
      // from (re-splitting an open project), so that line — and the stored one
      // it came from — is retired here rather than left to be saved as this
      // song's melody. The ref goes with it: prepMelody consults it below,
      // before the render.
      setMelody({ status: 'none' })
      melodyRef.current = { status: 'none' }
      setMelodyInfo(null)
      storedMelodyRef.current = null
      // Analyze right away (melody, key, bpm) so karaoke opens warm and the
      // bpm box fills in without a trip through karaoke mode. If karaoke was
      // open last session, reopen it.
      if (localStorage.getItem('singz.karaoke') === '1') openKaraokeRef.current?.()
      else prepMelodyRef.current?.()
    } catch {
      setError('Separation finished, but loading the stem files failed.')
    }
    setSep(null)
  }, [song, engineStatus, engine, loadLanes])

  /** Any settings change marks an open project as having unsaved changes. */
  const touchSettings = useCallback(() => {
    setDirty(true)
    setSaveState((s) => (s === 'saved' ? 'idle' : s))
  }, [])

  const handleMute = useCallback(
    (id: string, muted: boolean) => {
      touchSettings()
      engine.setMuted(id, muted)
      setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, muted } : t)))
    },
    [engine, touchSettings]
  )
  const handleSolo = useCallback(
    (id: string, solo: boolean) => {
      touchSettings()
      engine.setSolo(id, solo)
      setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, solo } : t)))
    },
    [engine, touchSettings]
  )
  const handleVolume = useCallback(
    (id: string, volume: number) => {
      touchSettings()
      engine.setVolume(id, volume)
      setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, volume } : t)))
    },
    [engine, touchSettings]
  )

  /**
   * Add audio files of the singer's own as extra lanes — a backing track, a
   * harmony they recorded, a click, a spoken cue. They play from 0:00 next to
   * the stems and are copied into the project folder on the next save.
   */
  const addTracks = useCallback(
    async (files: File[]) => {
      const before = engine.duration
      const taken = new Set(tracksRef.current.map((t) => t.id))
      const customSoFar = tracksRef.current.filter((t) => t.custom).length
      const added: UITrack[] = []
      for (const file of files) {
        const path = window.singz.pathForFile(file)
        if (!path) {
          setError('Could not resolve that file on disk.')
          continue
        }
        const reg = await window.singz.registerTrack(path)
        if (!reg.ok) {
          setError(reg.error)
          continue
        }
        try {
          const buf = await engine.decode(await window.singz.readAudio(reg.path))
          const id = customTrackId(reg.name, taken)
          taken.add(id)
          added.push(
            makeTrack(id, buf, {
              label: trackLabel(reg.name),
              color: CUSTOM_COLORS[(customSoFar + added.length) % CUSTOM_COLORS.length],
              custom: { file: reg.path }
            })
          )
        } catch {
          setError(`Could not decode ${reg.name} — try an MP3, WAV, FLAC or M4A.`)
        }
      }
      if (added.length === 0) return
      loadLanes([...tracksRef.current, ...added])
      touchSettings()
      const names = added.map((t) => t.label).join(', ')
      const longest = Math.max(...added.map((t) => t.buffer.duration))
      setNotice(
        longest > before + 0.05
          ? `Added ${names} — it starts at 0:00 and runs past the song, so the timeline now ends at ${fmtTime(longest)}. Save the project to keep it.`
          : `Added ${names} — it starts at 0:00, alongside the stems. Save the project to keep it.`
      )
    },
    [engine, loadLanes, touchSettings]
  )

  /**
   * Rename a lane the singer added. The label is all that changes: the id is
   * the mixer key AND the file name inside the project, so renaming leaves the
   * audio exactly where it is — no re-upload to Drive, no re-download on the
   * phones, which pick up the new name with the next sync.
   */
  const renameTrack = useCallback(
    (id: string, label: string) => {
      setTracks((ts) => ts.map((t) => (t.id === id && t.custom ? { ...t, label } : t)))
      touchSettings()
    },
    [touchSettings]
  )

  /** Drop a lane the singer added; its copy in the project goes on next save. */
  const removeTrack = useCallback(
    (id: string) => {
      const next = tracksRef.current.filter((t) => t.id !== id)
      if (next.length === tracksRef.current.length) return
      loadLanes(next)
      touchSettings()
    },
    [loadLanes, touchSettings]
  )

  /**
   * Re-point added lanes at the project's own copies after a save, rename or
   * import — the paths they were added from (or lived at) are not where the
   * files are now.
   */
  const reanchorCustom = useCallback((list: CustomTrack[] | undefined) => {
    if (!list || list.length === 0) return
    setTracks((ts) =>
      ts.map((t) => {
        const c = t.custom ? list.find((x) => x.id === t.id) : undefined
        return c ? { ...t, custom: { file: c.file } } : t
      })
    )
  }, [])

  const vocalsMuted = tracks.find((t) => t.id === 'vocals')?.muted ?? false

  const applyLyricsResult = useCallback((res: import('../../shared/types').LyricsResult) => {
    if (!res.ok) {
      setLyrics(
        res.cancelled
          ? { status: 'idle' }
          : res.needsModel
            ? { status: 'consent', sizeMb: res.needsModel.sizeMb, what: res.needsModel.what }
            : { status: 'error', error: res.error }
      )
      return
    }
    setLyrics(
      res.lines.length > 0
        ? {
            status: 'ready',
            lines: res.lines,
            source: res.source,
            credit: res.credit,
            aligned: res.aligned,
            check: res.check
          }
        : { status: 'error', error: 'No words were detected in the vocals.' }
    )
  }, [])

  const [preciseCap, setPreciseCap] = useState(false)
  useEffect(() => {
    void window.singz.alignCaps().then((c) => setPreciseCap(c.precise))
  }, [])

  const preferRef = useRef<'auto' | 'whisper' | 'align' | 'precise'>('auto')
  const prepLyricsRef = useRef<
    ((allowDownload?: boolean, prefer?: 'auto' | 'whisper' | 'align' | 'precise') => Promise<void>) | null
  >(null)

  const prepLyrics = useCallback(
    async (allowDownload = false, prefer?: 'auto' | 'whisper' | 'align' | 'precise') => {
      if (!song) return
      if (prefer) preferRef.current = prefer
      const cur = lyricsRef.current.status
      if (!allowDownload && !prefer && (cur === 'loading' || cur === 'ready' || cur === 'consent'))
        return
      // Which song these lyrics are being looked up for. The LRCLIB ladder is
      // several network round-trips and whisper is minutes, so the singer can
      // well be in another song by the time it answers — and lyrics that land
      // in the wrong song are not merely drawn there: linesRef feeds
      // detectBeats' lineStarts/words, and that grid is auto-saved into the
      // project. Same rule as prepMelody, for the same reason.
      const seq = loadSeq.current
      // Ladder: cache → LRCLIB synced lyrics → whisper (with model consent).
      setLyrics({ status: 'loading', progress: null })
      const unsub = window.singz.onLyricsProgress((p) => {
        if (seq === loadSeq.current) setLyrics({ status: 'loading', progress: p })
      })
      const res = await window.singz.getLyrics(
        song.path,
        engine.duration,
        allowDownload,
        preferRef.current
      )
      unsub()
      if (seq !== loadSeq.current) return // a different song is open now
      applyLyricsResult(res)
    },
    [song, engine, applyLyricsResult]
  )
  prepLyricsRef.current = prepLyrics

  /**
   * Hand a finished melody line to the app: the pitch strip, the key readout,
   * and — once per song — the beat track that rides on the same analysis pass.
   * `tracked` says pYIN just ran, so the line is new to this project and has
   * to be written down; a line adopted from project.json is already there.
   */
  applyKeyRef.current = (pc: number, minor: boolean): void => {
    setSongInfo((s) => ({ ...s, key: { pc, minor } }))
    const ki = { pc, minor, detVersion: KEY_DETECT_VERSION }
    keyInfoRef.current = ki
    setKeyInfo(ki)
    setAnalysisAutoSave(true)
  }
  keyNeededRef.current = (): boolean => {
    const stored = keyInfoRef.current
    if (stored && stored.detVersion === KEY_DETECT_VERSION) return false
    return instBufsRef.current.length > 0 || bassBufRef.current !== null
  }

  /** The standalone key derivation — core first, TS stems fallback, melody
   *  histogram as display-only last resort. Runs when the combined pass
   *  cannot carry the key: applyMelody's standalone arm, and the release
   *  path when a pass that CLAIMED the carry ends keyless after applyMelody
   *  already stood down on it. Guards on the song's own buffers. */
  const deriveStandaloneKey = useCallback((f0: Float32Array | null): void => {
    const inst = instBufsRef.current
    const bassBuf = bassBufRef.current
    if (inst.length === 0 && !bassBuf) {
      if (f0) setSongInfo((s) => ({ ...s, key: estimateKey(f0) }))
      return
    }
    void (async () => {
      const core = await runCombinedCore(
        { melody: false, key: true, beats: false },
        stemPathsRef.current,
        audibleIdsRef.current,
        async () => ({ ml: null, lineStarts: null, words: null })
      )
      if (instBufsRef.current !== inst || bassBufRef.current !== bassBuf) return // song changed
      if (core.key) {
        ;(window as { __keySrc?: string }).__keySrc = 'core'
        applyKeyRef.current?.(core.key.pc, core.key.minor)
        return
      }
      // Fallback: the TS detector on stems decoded off disk — same input
      // rule, renderer-side. The key answer measured identical across the
      // whole library at both input rates (17/17), which is why
      // KEY_DETECT_VERSION does not move for any of this.
      const allPaths = stemPathsRef.current
      const harmonicPaths = allPaths
        ? Object.fromEntries(Object.entries(allPaths).filter(([id]) => id !== 'drums' && id !== 'vocals'))
        : null
      const fromDisk = await analysisStems(harmonicPaths, audibleIdsRef.current, {
        drums: null,
        bass: bassBuf,
        vocals: null,
        inst
      })
      // let the melody paint before the synchronous chroma pass blocks
      await new Promise((r) => setTimeout(r, 30))
      if (instBufsRef.current !== inst || bassBufRef.current !== bassBuf) return // song changed
      const stems = estimateKeyFromStems(fromDisk.inst, fromDisk.bass)
      ;(window as { __keySrc?: string }).__keySrc = stems ? 'ts' : 'melody-histogram'
      // A melody-histogram fallback is displayed but never stored under
      // the v2 stamp — it is the method the stamp says we left behind.
      if (stems) applyKeyRef.current?.(stems.pc, stems.minor)
      else if (f0) setSongInfo((s) => ({ ...s, key: estimateKey(f0) }))
    })()
  }, [])
  const deriveStandaloneKeyRef = useRef(deriveStandaloneKey)
  deriveStandaloneKeyRef.current = deriveStandaloneKey

  const applyMelody = useCallback(
    (f0: Float32Array, hopSec: number, tracked: boolean) => {
      const next: MelodyState = { status: 'ready', f0, hopSec }
      melodyRef.current = next // prepMelody may re-enter before the render
      setMelody(next)
      if (tracked) setMelodyInfo(encodeMelody(f0, hopSec))
      // Beat track from the drums (once per song — a hand-tuned track wins
      // over re-detection; restored auto tracks from an older detector are
      // silently re-tracked so downbeat fixes reach saved projects). The
      // pack's neural grid is fetched first when available — detectBeats
      // fuses it with the stem cues; without a pack it changes nothing.
      const info = beatInfoRef.current
      const fresh = !info
      const stale = info?.source === 'auto' && info.detVersion !== BEAT_DETECT_VERSION
      if ((fresh || stale) && drumsBufRef.current) {
        const drums = drumsBufRef.current
        void (async () => {
          setBeatProg(0.02)
          try {
            // A combined pass prepMelody armed for this song leaves a
            // PROMISE of its stems, lattice and results — await it rather
            // than decode, render and spawn again (spawning here raced the
            // single-flight the first time: the melody part event fires
            // seconds before the pass finishes). Otherwise (stored/worker
            // melody) this block does the whole job itself.
            const pending = pendingCoreAnalysisRef.current
            pendingCoreAnalysisRef.current = null
            const stashed = pending && pending.seq === loadSeq.current ? await pending.promise : null
            if (drumsBufRef.current !== drums) return // song changed while awaiting the pass
            // The stems off DISK, at the rate the files state — the model's
            // mix and the detector both. The playing buffers are only the
            // per-lane fallback (analysisStems says when one is taken).
            const stems =
              stashed?.stems ??
              (await analysisStems(stemPathsRef.current, audibleIdsRef.current, {
                drums,
                bass: bassBufRef.current,
                vocals: vocalsBufRef.current,
                inst: instBufsRef.current
              }))
            if (drumsBufRef.current !== drums) return // song changed mid-flight
            const ml = stashed?.stems ? stashed.ml : ((await fetchMlGridRef.current?.()) ?? null)
            if (drumsBufRef.current !== drums) return // song changed mid-flight
            // let the bar paint before the synchronous tracker blocks
            setBeatProg((cur) => (cur === null ? cur : Math.max(cur, 0.97)))
            await new Promise((r) => setTimeout(r, 30))
            if (!stems.drums) return // no file and no buffer: nothing to track
            const aux = {
              bass: stems.bass,
              vocals: stems.vocals,
              inst: stems.inst,
              lineStarts: linesRef.current?.map((l) => l.words[0]?.s ?? l.start) ?? null,
              words: linesRef.current?.flatMap((l) => l.words.map((w) => ({ s: w.s, e: w.e }))) ?? null,
              ml
            }
            const dbg = {}
            // ONE combined child for beats + key when nothing is stashed
            // (melody is already in hand on this path — stored or worker).
            const keyWanted = keyNeededRef.current?.() ?? false
            const core = stashed?.stems
              ? { beats: stashed.beats, key: stashed.key }
              : await runCombinedCore(
                  { melody: false, key: keyWanted, beats: true },
                  stemPathsRef.current,
                  audibleIdsRef.current,
                  async () => ({ ml, lineStarts: aux.lineStarts, words: aux.words })
                )
            if (drumsBufRef.current !== drums) return // song changed mid-flight
            const det = core.beats !== undefined ? core.beats : detectBeats(stems.drums, aux, dbg)
            publishBeatDbg('auto', core.beats !== undefined ? 'core' : 'ts', stems.drums, aux, det, dbg)
            if (keyWanted) {
              if (!stashed && core.key) {
                ;(window as { __keySrc?: string }).__keySrc = 'core'
                applyKeyRef.current?.(core.key.pc, core.key.minor)
              } else if (keyNeededRef.current?.() ?? false) {
                // the TS fallback — including for a stash whose key part
                // failed (prepMelody released the carry in that case)
                const k = estimateKeyFromStems(stems.inst, stems.bass)
                ;(window as { __keySrc?: string }).__keySrc = k ? 'ts' : 'melody-histogram'
                if (k) applyKeyRef.current?.(k.pc, k.minor)
                else setSongInfo((s2) => ({ ...s2, key: estimateKey(f0) })) // the last resort, displayed never stored
              }
            }
            if (det) {
              // Hand-placed bar lines are re-folded onto the FRESH beat
              // array — they are stored as times precisely so they survive a
              // re-detection that renumbers every beat. This is what lets a
              // song the singer corrected go on receiving detector work
              // instead of being frozen at whatever version fixed it.
              const auto = det.downbeats ?? undefined
              setBeatInfo(
                applyUserBars({
                  beats: det.beats,
                  bpm: det.bpm,
                  beatsPerBar: det.beatsPerBar,
                  downbeat: det.downbeat,
                  ...(auto ? { downbeats: auto, autoDownbeats: auto } : {}),
                  ...(det.suspectAt ? { suspectAt: det.suspectAt } : {}),
                  ...(info?.userBars ? { userBars: info.userBars } : {}),
                  source: 'auto',
                  detVersion: BEAT_DETECT_VERSION
                })
              )
              if (stale) touchSettings()
              setSongInfo((s) => ({ ...s, bpm: det.bpm }))
            }
            // What analysis just worked out must reach the project file — and
            // through Drive the phones, which have neither detector of their
            // own — without waiting for a manual save. One save for the whole
            // pass, deferred via state so the save handler's closure sees both
            // the new grid and the new line.
            if (tracked || det) setAnalysisAutoSave(true)
          } finally {
            setBeatProg(null)
          }
        })()
      } else if (tracked) {
        setAnalysisAutoSave(true)
      }
      // Key: asked of the harmonic stems, not the sung line — Zeit's vocal
      // touches its Gm tonic on 1.3% of voiced frames and the histogram of it
      // answered A major. The melody histogram survives only as the answer of
      // last resort for a project whose stems went missing.
      //
      // When the BEAT pass above runs, the key rides its combined child (one
      // spawn for beats + key + sometimes melody). This standalone path is
      // only for songs the beat pass skips — no drums, or a current grid —
      // where the key still has to come from somewhere.
      const storedKey = keyInfoRef.current
      const inst = instBufsRef.current
      const bassBuf = bassBufRef.current
      const beatPassCarriesKey =
        ((fresh || stale) && !!drumsBufRef.current) || keyCarriedBySeqRef.current === loadSeq.current
      if (storedKey && storedKey.detVersion === KEY_DETECT_VERSION) {
        setSongInfo({ key: { pc: storedKey.pc, minor: storedKey.minor }, bpm: info?.bpm ?? null })
      } else if (beatPassCarriesKey) {
        setSongInfo({ key: null, bpm: info?.bpm ?? null }) // the combined pass fills it in
      } else if (inst.length > 0 || bassBuf) {
        setSongInfo({ key: null, bpm: info?.bpm ?? null })
        deriveStandaloneKeyRef.current?.(f0)
      } else {
        setSongInfo({ key: estimateKey(f0), bpm: info?.bpm ?? null })
      }
    },
    [touchSettings]
  )

  const prepMelody = useCallback(() => {
    if (melodyRef.current.status !== 'none') return
    const stored = storedMelodyRef.current
    const buf = vocalsBufRef.current
    // A stored line tracked by THIS detector, and covering THIS song, is
    // adopted as it is — the pitch strip draws instantly instead of after
    // seconds of pYIN, and the phones' copy of the song stays the line the
    // singer already practised against. An older stamp — or a line whose
    // length says it was tracked from a different song — is re-tracked, and
    // the fresh line saves itself, which is how the two projects that caught a
    // neighbour's line heal on the next open. With no vocals stem to track
    // from (a project whose stems went missing) even a stale line beats none.
    if (
      stored &&
      (!buf ||
        (stored.info.detVersion === PITCH_DETECT_VERSION &&
          melodyFitsSong(stored.f0, stored.info.hopSec, buf.duration)))
    ) {
      storedMelodyRef.current = null
      ;(window as { __melody?: unknown }).__melody = {
        src: 'stored',
        f0: stored.f0,
        hopSec: stored.info.hopSec,
        stored: true
      }
      applyMelody(stored.f0, stored.info.hopSec, false)
      return
    }
    storedMelodyRef.current = null
    if (!buf) return
    setMelody({ status: 'computing', p: 0 })
    // The ref too: reading the stem back off disk below is asynchronous, so
    // without this a second prepMelody — karaoke opening in the same breath as
    // the load that called it — would walk straight past the guard at the top
    // and start a second pYIN on the same song.
    melodyRef.current = { status: 'computing', p: 0 }
    // Which song this line is being tracked for. pYIN runs for seconds, so the
    // singer can well be in another song by the time it answers — and a line
    // that lands in the wrong song is not merely drawn there, it is saved
    // there (analysis auto-saves), and then adopted on every open thereafter.
    const seq = loadSeq.current
    const path = stemPathsRef.current?.vocals ?? null
    void (async () => {
      // The C++ core first (singz-analyze, spawned by main like whisper-cli).
      // It reads the stem FILE at the file's own rate — the same input
      // discipline melodyInput enforces below — and the parity gates hold it
      // bit-identical to the worker's TS, so which one ran is invisible in
      // the line and visible only in __melody.src. The worker survives as
      // the fallback for a build with no binary, and every fallback says so
      // out loud: silent substitution is how input bugs shipped before.
      if (path) {
        const avail = await window.singz.melodyNativeAvailable().catch(() => ({ ok: false, available: false }))
        if (seq !== loadSeq.current) return
        if (avail.available) {
          // Everything this song still owes, in the ONE child: melody now,
          // and — when they are owed too — key and beats ride along. The
          // stems and the lattice are prepared inside provideMl (the child is
          // already tracking melody while the model renders), then stashed
          // with the results for applyMelody's adoption machinery, which owns
          // setBeatInfo/applyUserBars/publish and must not be duplicated.
          const beatInfo = beatInfoRef.current
          const wantBeats =
            (!beatInfo || (beatInfo.source === 'auto' && beatInfo.detVersion !== BEAT_DETECT_VERSION)) &&
            drumsBufRef.current !== null
          const wantKey = keyNeededRef.current?.() ?? false
          let stashStems: Awaited<ReturnType<typeof analysisStems>> | null = null
          let stashMl: MlGrid | null = null
          let melodyAdopted = false
          if (wantKey) keyCarriedBySeqRef.current = seq
          let resolveStash!: (v: Awaited<NonNullable<typeof pendingCoreAnalysisRef.current>['promise']> extends infer T ? T : never) => void
          if (wantBeats) {
            pendingCoreAnalysisRef.current = {
              seq,
              promise: new Promise((r) => {
                resolveStash = r
              })
            }
          }
          const unsub = window.singz.onMelodyNativeProgress((p) => {
            if (seq === loadSeq.current) setMelody({ status: 'computing', p })
          })
          // The melody part streams out of the child the moment the tracker
          // finishes — seconds before the beats stage even has its lattice.
          // Adopt it here; the final result's copy is only the fallthrough.
          const unsubPart = window.singz.onAnalyzePart((part) => {
            if (seq !== loadSeq.current || melodyAdopted) return
            const m = part.melody
            if (m?.ok && m.f0 && m.hopSec && m.detVersion === PITCH_DETECT_VERSION) {
              melodyAdopted = true
              ;(window as { __melody?: unknown }).__melody = {
                src: 'core',
                f0: m.f0,
                raw: m.raw,
                rms: m.rms,
                hopSec: m.hopSec
              }
              applyMelody(m.f0, m.hopSec, true)
            }
          })
          const core = await runCombinedCore(
            { melody: true, key: wantKey, beats: wantBeats },
            stemPathsRef.current,
            audibleIdsRef.current,
            async () => {
              stashStems = await analysisStems(stemPathsRef.current, audibleIdsRef.current, {
                drums: drumsBufRef.current,
                bass: bassBufRef.current,
                vocals: vocalsBufRef.current,
                inst: instBufsRef.current
              })
              if (seq !== loadSeq.current) return { ml: null, lineStarts: null, words: null }
              stashMl = (await fetchMlGridRef.current?.()) ?? null
              // gathered NOW, after the model render — the lyrics have loaded
              // by this point where at spawn they had not (measured: 0 words)
              return {
                ml: stashMl,
                lineStarts: linesRef.current?.map((l) => l.words[0]?.s ?? l.start) ?? null,
                words: linesRef.current?.flatMap((l) => l.words.map((w) => ({ s: w.s, e: w.e }))) ?? null
              }
            }
          )
          unsub()
          unsubPart()
          if (wantBeats) resolveStash({ stems: stashStems, ml: stashMl, beats: core.beats, key: core.key })
          if (seq !== loadSeq.current) return
          if (wantKey) {
            if (core.key) {
              ;(window as { __keySrc?: string }).__keySrc = 'core'
              applyKeyRef.current?.(core.key.pc, core.key.minor)
            } else {
              // the pass could not answer the key — release the carry so the
              // fallback machinery (the beat block's arm, or the standalone
              // path on a later prep) is allowed to run it. If the part event
              // already ran applyMelody, its standalone arm stood down on the
              // carry and will not come back this session: run it now.
              keyCarriedBySeqRef.current = null
              // beats owed → the beat block's own keyNeeded arm covers this;
              // kicking too would spawn a redundant key-only child
              if (melodyAdopted && !wantBeats) deriveStandaloneKeyRef.current?.(core.melody?.f0 ?? null)
            }
          }
          if (melodyAdopted) return // the part event already applied it
          if (core.melody) {
            // belt: the event can only have been missed by a subscription
            // race — the validated final copy is identical
            ;(window as { __melody?: unknown }).__melody = {
              src: 'core',
              f0: core.melody.f0,
              raw: core.melody.raw,
              rms: core.melody.rms,
              hopSec: core.melody.hopSec
            }
            applyMelody(core.melody.f0, core.melody.hopSec, true)
            return
          }
          // the melody part fell through (warned inside runCombinedCore) —
          // the worker below takes it, and any stashed beats/key still adopt
          // when applyMelody fires at its end.
        }
      }
      const src = await melodyInput(path, buf)
      if (seq !== loadSeq.current) return // a different song is open now
      const worker = new Worker(new URL('./audio/pitch.worker.ts', import.meta.url), {
        type: 'module'
      })
      melodyWorkerRef.current = worker
      worker.onmessage = (e: MessageEvent<{ type: string; p?: number; f0?: Float32Array; raw?: Float32Array; clarity?: Float32Array; rms?: Float32Array; hopSec?: number }>) => {
        if (seq !== loadSeq.current) {
          worker.terminate() // a different song is open now
          return
        }
        if (e.data.type === 'progress') {
          setMelody({ status: 'computing', p: e.data.p ?? 0 })
        } else if (e.data.type === 'done' && e.data.f0 && e.data.hopSec) {
          // diagnostics hook: E2E drivers dump this to tune the melody cleaner
          ;(window as { __melody?: unknown }).__melody = {
            src: 'worker',
            f0: e.data.f0,
            raw: e.data.raw,
            clarity: e.data.clarity,
            rms: e.data.rms,
            hopSec: e.data.hopSec
          }
          applyMelody(e.data.f0, e.data.hopSec, true)
          worker.terminate()
          if (melodyWorkerRef.current === worker) melodyWorkerRef.current = null
        }
      }
      worker.postMessage({ mono: src.mono, sampleRate: src.sampleRate }, [src.mono.buffer])
    })().catch((e) => {
      // Nothing above is expected to throw — melodyInput swallows its own — but
      // a pitch strip stuck on "computing" forever is a worse way to find out
      // than a line in the console and a state that can be asked again.
      console.error('melody: tracking could not start:', e)
      if (seq !== loadSeq.current) return
      melodyRef.current = { status: 'none' }
      setMelody({ status: 'none' })
    })
  }, [applyMelody])
  const prepMelodyRef = useRef<(() => void) | null>(null)
  prepMelodyRef.current = prepMelody

  const openKaraoke = useCallback(() => {
    setKaraoke(true)
    // Karaoke normally mutes the guide so you sing over the band — but with
    // training armed, the training schedule governs the vocals instead.
    if (!trainingRef.current) {
      engine.setMuted('vocals', true)
      setTracks((ts) => ts.map((t) => (t.id === 'vocals' ? { ...t, muted: true } : t)))
    }
    void prepLyrics()
    prepMelody()
  }, [engine, prepLyrics, prepMelody])
  const openKaraokeRef = useRef(openKaraoke)
  openKaraokeRef.current = openKaraoke

  const toggleKaraoke = useCallback(() => {
    if (karaoke) {
      setKaraoke(false)
      localStorage.setItem('singz.karaoke', '0')
      return
    }
    if (!split) return
    localStorage.setItem('singz.karaoke', '1')
    openKaraoke()
  }, [karaoke, split, openKaraoke])

  const openPicker = useCallback(() => fileInputRef.current?.click(), [])
  const openTrackPicker = useCallback(() => trackInputRef.current?.click(), [])

  const handleSaveProject = useCallback(async () => {
    if (!song || saveState === 'saving') return
    // Which song this save is about. Saving converts six stems to FLAC, so it
    // runs for seconds — long enough to open another song meanwhile — and its
    // answer carries the PATH of the folder it wrote. Splicing that onto the
    // song now on screen leaves a header naming one song and a path pointing
    // at another, and the next save or rename acts on the wrong folder: that
    // is how a rename typed for one song moved a different song's folder.
    const seq = loadSeq.current
    setSaveState('saving')
    const settings = {
      transpose,
      tempo: tempoRate,
      view: view ?? undefined,
      selection: selection ?? undefined,
      loop: loopOn || undefined,
      training: { on: training || undefined, ...trainCfg },
      // Beat times rounded to the millisecond keep project.json readable.
      beat: beatInfo
        ? { ...beatInfo, beats: beatInfo.beats.map((b) => Math.round(b * 1000) / 1000) }
        : undefined,
      melody: melodyInfo ?? undefined,
      key: keyInfo ?? undefined,
      metronome: metCfg,
      custom: tracks
        .filter((t) => t.custom)
        .map((t) => ({ id: t.id, label: t.label, color: t.color, file: t.custom!.file })),
      tracks: Object.fromEntries(
        tracks.map((t) => [t.id, { muted: t.muted, solo: t.solo, volume: t.volume }])
      )
    }
    const res = await window.singz.saveProject(song.path, cleanSongName(song.name), settings)
    // Another song took the stage while this one was being written. The save
    // itself stands (main finished it, and the log says so) — it is only this
    // screen's state that must not learn about a project it is no longer on.
    if (seq !== loadSeq.current) return
    if (res.ok) {
      setDirty(false)
      setSaveState('saved')
      // The song now lives inside its project folder — anchor there so
      // renaming and future saves act on the project, not the original file.
      setSong((s) => (s ? { ...s, path: res.songPath } : s))
      setIsProject(true)
      setInLibrary(res.inLibrary)
      setProjectDir(res.dir)
      reanchorCustom(res.custom)
      // A track whose file disappeared between adding and saving is still
      // playing here but is not in the project — say so rather than let the
      // next open be quietly short of a lane.
      const kept = new Set((res.custom ?? []).map((c) => c.id))
      const lost = settings.custom.filter((c) => !kept.has(c.id)).map((c) => c.label)
      setNotice(
        lost.length > 0
          ? `Saved to ${res.dir} — but ${lost.join(', ')} could not be copied in (the file is no longer where you added it from).`
          : res.driveSignedOut
            ? `Saved to ${res.dir} — Google Drive is signed out on this computer, so your phones won't see this until you sign in (Open… screen).`
            : `Saved to ${res.dir}`
      )
      setTimeout(() => setSaveState('idle'), 2500)
    } else {
      setSaveState('idle')
      setError(`Could not save the project: ${res.error}`)
    }
  }, [song, saveState, transpose, tempoRate, view, selection, loopOn, training, trainCfg, beatInfo, melodyInfo, keyInfo, metCfg, tracks, reanchorCustom])

  /** A silently tracked pitch line or (re)detected grid saves itself — but
   *  only into an existing project (never creating one under a raw file), and
   *  after the commit so the save closure already sees them. */
  useEffect(() => {
    if (!analysisAutoSave) return
    // A save already writing would swallow this one (handleSaveProject
    // early-returns mid-save) — leave the flag set so the effect re-fires
    // when saveState settles and the later analysis still reaches disk.
    // Two analyses can now finish inside one save's window: the key job's
    // autosave runs for seconds on a re-split while the beat detector lands.
    if (saveState === 'saving') return
    setAnalysisAutoSave(false)
    if (song && isProject) void handleSaveProject()
  }, [analysisAutoSave, saveState, song, isProject, handleSaveProject])

  /** Bring a project opened from outside the library in, and follow it there. */
  const handleImport = useCallback(
    async (mode: 'copy' | 'move') => {
      if (!song || importing) return
      const seq = loadSeq.current
      setImporting(true)
      const res = await window.singz.importProject(song.path, mode)
      setImporting(false)
      if (seq !== loadSeq.current) return // a different song is open now
      if (!res.ok) {
        setShowImport(false)
        setError(res.error)
        return
      }
      // the copy in the library is the one we keep working on from here
      setSong((s) => (s ? { ...s, path: res.songPath } : s))
      if (res.stems) {
        setStemFiles(res.stems)
        stemPathsRef.current = res.stems // the folder moved
      }
      reanchorCustom(res.custom)
      setInLibrary(true)
      setProjectDir(res.dir)
      setShowImport(false)
      setNotice(
        res.moved
          ? `Moved into your library — the project now lives in ${res.dir}`
          : `Copied into your library — ${res.dir}. The original folder is untouched.`
      )
    },
    [song, importing, reanchorCustom]
  )

  const commitRename = useCallback(
    async (raw: string) => {
      setEditName(null)
      const name = raw.trim()
      if (!song || !name || name === song.name) return
      if (isProject) {
        const seq = loadSeq.current
        const res = await window.singz.renameProject(song.path, name)
        if (seq !== loadSeq.current) return // the folder moved; this screen has since moved on
        if (!res.ok) {
          setError(res.error)
          return
        }
        setSong({ path: res.songPath, name: res.name })
        if (res.stems) {
          setStemFiles(res.stems)
          stemPathsRef.current = res.stems // the folder moved
        }
        reanchorCustom(res.custom)
        setProjectDir(res.dir)
        setNotice(`Renamed — the project folder is now ${res.dir}`)
      } else {
        setSong({ ...song, name })
        setSaveState('idle')
      }
    },
    [song, isProject, reanchorCustom]
  )

  const handleTranspose = useCallback(
    (st: number) => {
      const clamped = Math.max(-12, Math.min(12, st))
      touchSettings()
      setTranspose(clamped)
      // Re-sync afterwards: if the stretch worklet fails, the engine reverts
      // to 0 and the badge must not keep promising a shift that isn't heard.
      void engine.setTranspose(clamped).finally(() => setTranspose(engine.transpose))
    },
    [engine, touchSettings]
  )

  // Selection/loop region: with loop the region repeats; without it,
  // playback started inside the selection stops at its end.
  useEffect(() => {
    engine.setRegion(
      selection
        ? { start: selection.s, end: selection.e }
        : loopOn
          ? { start: 0, end: engine.duration }
          : null,
      loopOn
    )
  }, [engine, loopOn, selection, tracks])

  const handleSelection = useCallback(
    (sel: { s: number; e: number } | null) => {
      touchSettings()
      setSelection(sel)
    },
    [touchSettings]
  )

  /** Space / play button: starting with a selection armed targets the selection. */
  const togglePlay = useCallback(() => {
    if (!engine.playing) {
      const sel = selectionRef.current
      if (sel) {
        const pos = engine.position
        if (pos < sel.s - 0.05 || pos >= sel.e - 0.05) engine.seek(sel.s)
      }
    }
    engine.toggle()
  }, [engine])
  const togglePlayRef = useRef(togglePlay)
  togglePlayRef.current = togglePlay

  /** Catalog covers the transport, so nothing may be left playing behind it. */
  const toggleCatalog = useCallback(() => {
    const opening = !showCatalogRef.current
    if (opening) engine.pause()
    setShowCatalog(opening)
  }, [engine])

  /**
   * A project was deleted from the catalog. If it was the one open behind the
   * catalog, what is on screen now describes files that no longer exist —
   * every lane, the pencil and Save would all be pointing into a folder that
   * is gone. Let it go rather than leave a song nothing can be saved into.
   */
  const handleDeleted = useCallback(
    (dir: string) => {
      if (dir !== projectDir) return
      loadSeq.current++ // anything still in flight for that song lands nowhere
      engine.pause()
      engine.load([])
      setSong(null)
      setTracks([])
      setStemFiles(null)
      setIsProject(false)
      setProjectDir(null)
      setSplit(false)
      setKaraoke(false)
      setLyrics({ status: 'idle' })
      setBeatInfo(null)
      setMelodyInfo(null)
      setSaveState('idle')
      setDirty(false)
      setShowCatalog(false)
      setPhase('empty')
    },
    [engine, projectDir]
  )

  const toggleLoop = useCallback(() => {
    touchSettings()
    setLoopOn((on) => {
      const next = !on
      if (next && selection) {
        const pos = engine.position
        if (pos < selection.s || pos > selection.e) engine.seek(selection.s)
      }
      return next
    })
  }, [engine, selection, touchSettings])

  const handleMetCfg = useCallback(
    (m: MetronomeConfig) => {
      touchSettings()
      setMetCfg(m)
    },
    [touchSettings]
  )

  const handleBeat = useCallback(
    (g: BeatInfo) => {
      touchSettings()
      setBeatInfo(g)
      setSongInfo((s) => ({ ...s, bpm: g.bpm }))
    },
    [touchSettings]
  )

  // Hand-placed bar lines. Note what these do NOT do: touch `source`. Every
  // other beat edit in this app marks the track 'manual', which quietly opts
  // it out of the auto-heal gate forever — fix one song's downbeat and it
  // stops receiving detector work for good. A moved bar line is stored as a
  // time, re-folded after each re-detection, and the track stays 'auto'.
  // These SAVE, they do not merely mark the project dirty. A corrected bar
  // line is grid truth of exactly the kind the detected grid is, and the
  // comment on that path applies word for word: it has to reach the project
  // file — and through Drive the phones, which have no detector of their own
  // — without waiting for a manual save. A correction the singer made and
  // then lost by closing the song is worse than never offering the edit.
  const handleMoveBar = useCallback((fromT: number, toT: number) => {
    touchSettings()
    setBeatInfo((g) => (g ? setUserBar(g, toT, fromT) : g))
    setAnalysisAutoSave(true)
  }, [touchSettings])

  const handleClearBar = useCallback((t: number) => {
    touchSettings()
    setBeatInfo((g) => (g ? clearUserBar(g, t) : g))
    setAnalysisAutoSave(true)
  }, [touchSettings])

  /** Full-mix neural beat grid from the splitter pack (null without a pack —
   *  the detector then takes its homegrown path unchanged). The mix is
   *  rendered offline at the model's 22.05 kHz from whatever stems are
   *  loaded: the model wants what the singer hears, not one stem. */
  const fetchMlGrid = useCallback(async (): Promise<MlGrid | null> => {
    try {
      const avail = await window.singz.beatsMlAvailable()
      if (!avail.ok || !avail.available) return null
      // The mix is rendered by the CORE from the stem FILES (main spawns
      // singz-analyze mlmix) — never by an OfflineAudioContext here, whose
      // render moved with every Electron upgrade and whose input rode the
      // playback buffers (the device-rate bug class, twice fixed).
      const paths = stemPathsRef.current
      const ids = audibleIdsRef.current
      const stemPaths = ids
        .map((id) => paths?.[id])
        .filter((p): p is string => typeof p === 'string')
      if (stemPaths.length === 0) return null
      const res = await window.singz.beatsMlDetectStems(stemPaths)
      if (!res.ok) {
        // A failed model run is a silent quality downgrade (the detector
        // falls back to drums-only) — it must at least be diagnosable.
        console.warn('beat model failed:', res.error)
        ;(window as { __mlGrid?: unknown }).__mlGrid = { ok: false, error: res.error }
        return null
      }
      ;(window as { __mlGrid?: unknown }).__mlGrid = { ok: true, beats: res.beats.length }
      return {
        beats: res.beats,
        downbeats: res.downbeats,
        beatProb: res.beatProb,
        downbeatProb: res.downbeatProb,
        fps: res.fps
      }
    } catch (e) {
      console.warn('beat model unavailable:', e)
      ;(window as { __mlGrid?: unknown }).__mlGrid = { ok: false, error: String(e) }
      return null
    }
  }, [])
  const fetchMlGridRef = useRef<typeof fetchMlGrid | null>(null)
  fetchMlGridRef.current = fetchMlGrid

  /** Re-track the beats from the stems (the popover's Re-detect). */
  const redetectBeat = useCallback(() => {
    const buf = drumsBufRef.current
    if (!buf) return
    void (async () => {
      setBeatProg(0.02)
      try {
        // Same as the auto pass: files first, playing buffers as fallback.
        const stems = await analysisStems(stemPathsRef.current, audibleIdsRef.current, {
          drums: buf,
          bass: bassBufRef.current,
          vocals: vocalsBufRef.current,
          inst: instBufsRef.current
        })
        if (drumsBufRef.current !== buf) return // song changed mid-flight
        const ml = await fetchMlGrid()
        if (drumsBufRef.current !== buf) return // song changed mid-flight
        setBeatProg((cur) => (cur === null ? cur : Math.max(cur, 0.97)))
        await new Promise((r) => setTimeout(r, 30))
        if (!stems.drums) return
        const aux = {
          bass: stems.bass,
          vocals: stems.vocals,
          inst: stems.inst,
          lineStarts: linesRef.current?.map((l) => l.words[0]?.s ?? l.start) ?? null,
          words: linesRef.current?.flatMap((l) => l.words.map((w) => ({ s: w.s, e: w.e }))) ?? null,
          ml
        }
        const dbg = {}
        const core = await runCombinedCore(
          { melody: false, key: false, beats: true },
          stemPathsRef.current,
          audibleIdsRef.current,
          async () => ({ ml: ml ?? null, lineStarts: aux.lineStarts, words: aux.words })
        )
        if (drumsBufRef.current !== buf) return // song changed mid-flight
        const det = core.beats !== undefined ? core.beats : detectBeats(stems.drums, aux, dbg)
        publishBeatDbg('redetect', core.beats !== undefined ? 'core' : 'ts', stems.drums, aux, det, dbg)
        if (det) {
          touchSettings()
          setBeatInfo({
            beats: det.beats,
            bpm: det.bpm,
            beatsPerBar: det.beatsPerBar,
            downbeat: det.downbeat,
            ...(det.downbeats ? { downbeats: det.downbeats } : {}),
            source: 'auto',
            detVersion: BEAT_DETECT_VERSION
          })
          setSongInfo((s) => ({ ...s, bpm: det.bpm }))
        } else {
          setNotice('No steady beat found — tap the tempo instead.')
        }
      } finally {
        setBeatProg(null)
      }
    })()
  }, [touchSettings, fetchMlGrid])

  const handleTempo = useCallback(
    (rate: number) => {
      const clamped = Math.round(Math.max(0.5, Math.min(1.5, rate)) * 10000) / 10000
      touchSettings()
      setTempoRate(clamped)
      void engine.setTempo(clamped).finally(() => {
        setTempoRate(engine.tempo)
        setTranspose(engine.transpose)
      })
    },
    [engine, touchSettings]
  )

  const lines = lyrics.status === 'ready' ? lyrics.lines : null
  linesRef.current = lines

  /** Arm/disarm vocal training; arming un-mutes the stems it alternates. */
  const toggleTraining = useCallback(() => {
    touchSettings()
    const arming = !trainingRef.current
    if (arming) {
      for (const id of trainCfgRef.current.stems) {
        const t = tracksRef.current.find((x) => x.id === id)
        if (t?.muted) handleMute(id, false)
      }
    }
    setTraining(arming)
  }, [touchSettings, handleMute])

  const handleTrainCfg = useCallback(
    (cfg: TrainingConfig) => {
      touchSettings()
      setTrainCfg(cfg)
      // Line mode needs the lyrics — fetch them if nothing has yet (no-op
      // when they are already loading or ready; never downloads models).
      if (cfg.mode === 'lines') void prepLyricsRef.current?.()
    },
    [touchSettings]
  )

  // Push the training schedule into the engine. Line mode falls back to the
  // timer until synced lyrics are actually available.
  useEffect(() => {
    if (!training || !split) {
      engine.setTraining(null)
      return
    }
    if (trainCfg.mode === 'lines' && lines && lines.length > 0) {
      engine.setTraining({
        mode: 'windows',
        windows: trainingWindows(lines, trainCfg.hear, trainCfg.sing, engine.duration),
        stems: trainCfg.stems
      })
    } else {
      engine.setTraining({ mode: 'period', periodSec: trainCfg.periodSec, stems: trainCfg.stems })
    }
  }, [engine, training, split, trainCfg, lines])

  /** Which lyric lines the singer carries alone (karaoke tints them). */
  const singMask = useMemo(() => {
    if (!training || trainCfg.mode !== 'lines' || !lines) return null
    const cycle = trainCfg.hear + trainCfg.sing
    return lines.map((_, i) => i % cycle >= trainCfg.hear)
  }, [training, trainCfg, lines])

  /** Global timeline zoom shared by the lanes and the pitch strip. */
  const clampView = useCallback(
    (s: number, e: number): TimeView | null => {
      const dur = engine.duration
      if (dur <= 0 || e - s >= dur) return null
      let span = Math.max(2, e - s)
      let ns = s
      if (ns < 0) ns = 0
      if (ns + span > dur) ns = dur - span
      return { s: ns, e: ns + span }
    },
    [engine]
  )

  const followAnim = useRef<{ from: number; span: number; to: number; t0: number; raf: number } | null>(
    null
  )

  /** Drop any follow glide in flight — the singer's own scrolling outranks it. */
  const stopFollow = useCallback(() => {
    const a = followAnim.current
    if (a) {
      cancelAnimationFrame(a.raf)
      followAnim.current = null
    }
  }, [])

  useEffect(() => stopFollow, [stopFollow])

  const zoomBy = useCallback(
    (factor: number, center?: number) => {
      touchSettings()
      stopFollow()
      setView((v) => {
        const dur = engine.duration
        if (dur <= 0) return v
        const cur = v ?? { s: 0, e: dur }
        const span = (cur.e - cur.s) * factor
        const c = center ?? Math.min(Math.max(engine.position, cur.s), cur.e)
        const ratio = span > 0 ? (c - cur.s) / (cur.e - cur.s) : 0.5
        return clampView(c - span * ratio, c - span * ratio + span)
      })
    },
    [engine, clampView, touchSettings, stopFollow]
  )

  /**
   * Scroll the timeline along by dt seconds — by a delta, never to absolute
   * bounds. A trackpad fires wheel events far faster than React re-renders,
   * and panning from the last *rendered* view meant every event that arrived
   * within a frame overwrote its predecessor instead of adding to it: ten
   * events back to back moved the view 2.2s where they had asked for 22s.
   */
  const panView = useCallback(
    (dt: number) => {
      touchSettings()
      stopFollow()
      setView((v) => (v ? clampView(v.s + dt, v.e + dt) : v))
    },
    [clampView, touchSettings, stopFollow]
  )

  /**
   * The playhead pulls the view along, as a glide rather than a cut: landing
   * the next screenful in one frame threw two thirds of a span sideways and
   * read as the grid lurching. Eased over FOLLOW_MS instead, so the song
   * slides under a playhead that walks back across it.
   *
   * Not a continuous scroll — every view change fully repaints two canvases
   * per lane plus the beat grid and the pitch strip, which per frame for the
   * length of a song is exactly what the weak-iGPU rules exist to prevent.
   * One eased turn per screenful costs about what a short two-finger scroll
   * already does, and only while the song plays.
   */
  const followView = useCallback(
    (s: number, e: number, smooth: boolean) => {
      // A seek cuts. Only the page-turn under a playing song glides: easing
      // across a jump to somewhere else in the song would smear the whole
      // way there, repainting every lane at each stop.
      if (!smooth) {
        stopFollow()
        setView(clampView(s, e))
        return
      }
      // Already on its way there: the trailing edge stays tripped for the
      // frame or two before the view actually moves.
      if (followAnim.current) return
      const from = viewLive.current
      if (!from) return
      const span = e - s
      const step = (): void => {
        const a = followAnim.current
        if (!a) return
        const k = Math.min(1, (performance.now() - a.t0) / FOLLOW_MS)
        // easeInOutSine: leaves and arrives at rest like any ease-in-out, but
        // peaks at 1.57x its average speed where a cubic peaks at 3x — and it
        // is that peak, not the trip, that the eye reads as a lurch.
        const eased = (1 - Math.cos(Math.PI * k)) / 2
        const at = a.from + (a.to - a.from) * eased
        setView(clampView(at, at + a.span))
        if (k < 1) a.raf = requestAnimationFrame(step)
        else followAnim.current = null
      }
      followAnim.current = { from: from.s, span, to: s, t0: performance.now(), raf: 0 }
      followAnim.current.raf = requestAnimationFrame(step)
    },
    [clampView, stopFollow]
  )

  return (
    <div className="app">
      <header className="titlebar">
        {document.body.classList.contains('win') && <WindowButtons />}
        <div className="logo">
          Sing<span>Z</span>
          {ver && <em className="ver">{ver}</em>}
        </div>
        {phase === 'ready' && (
          <button
            type="button"
            className={`pill ghost small catalog-btn${showCatalog ? ' active' : ''}`}
            title={
              showCatalog
                ? 'Back to your song (Esc)'
                : 'Browse your project library — this song stays loaded'
            }
            aria-pressed={showCatalog}
            onClick={toggleCatalog}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <rect x="1.5" y="1.5" width="5.4" height="5.4" rx="1.3" />
              <rect x="9.1" y="1.5" width="5.4" height="5.4" rx="1.3" />
              <rect x="1.5" y="9.1" width="5.4" height="5.4" rx="1.3" />
              <rect x="9.1" y="9.1" width="5.4" height="5.4" rx="1.3" />
            </svg>
            Catalog
          </button>
        )}
        {update.state === 'ready' && (
          <button
            type="button"
            className="pill primary small no-drag update-chip"
            title="The update is downloaded — restarting installs it"
            onClick={() => window.singz.installUpdate()}
          >
            Restart to update
          </button>
        )}
        {update.state === 'available' && (
          <button
            type="button"
            className="pill ghost small no-drag update-chip"
            title="A newer version is out — opens the download page"
            onClick={() => void window.singz.openExternal(update.url)}
          >
            Get v{update.version}
          </button>
        )}
        {update.state === 'downloading' && (
          <span className="chip-status no-drag update-chip" title="Downloading the update in the background">
            <span className="dot idle" /> update {update.percent}%
          </span>
        )}
        {song && phase === 'ready' && (
          <div className="song-title no-drag">
            {editName === null ? (
              <>
                <span className="song-title-text">{song.name}</span>
                <button
                  type="button"
                  className="pencil"
                  title={isProject ? 'Rename song and project folder' : 'Rename song'}
                  onClick={() => setEditName(song.name)}
                >
                  ✎
                </button>
              </>
            ) : (
              <input
                className="title-input"
                value={editName}
                autoFocus
                spellCheck={false}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(editName)
                  else if (e.key === 'Escape') setEditName(null)
                }}
                onBlur={() => void commitRename(editName)}
              />
            )}
          </div>
        )}
        <div className="header-right no-drag">
          {phase === 'ready' && (
            <button
              type="button"
              className="pill ghost small"
              title={
                isProject
                  ? 'Save stems, lyrics and settings into this project folder'
                  : 'Save song, stems, lyrics and settings into your project library'
              }
              disabled={saveState === 'saving'}
              onClick={() => void handleSaveProject()}
            >
              {saveState === 'saved' ? (
                'Saved ✓'
              ) : saveState === 'saving' ? (
                'Saving…'
              ) : (
                <>
                  Save project
                  {isProject && dirty && <span className="dirty-dot" title="Unsaved changes" />}
                </>
              )}
            </button>
          )}
          {phase === 'ready' && isProject && !inLibrary && (
            <button
              type="button"
              className="pill ghost small"
              title="This project sits outside your library — copy or move it in"
              onClick={() => setShowImport(true)}
            >
              Add to library…
            </button>
          )}
          {/* the catalog page already lists the library — no second door to it */}
          {phase === 'ready' && !showCatalog && (
            <button type="button" className="pill ghost small" onClick={() => setShowProjects(true)}>
              Open…
            </button>
          )}
          <button
            type="button"
            className="pill ghost small"
            title="What the app is doing under the hood — copy or save it when reporting a problem"
            onClick={() => setShowLog(true)}
          >
            Log
          </button>
          <EngineChip
            status={engineStatus}
            onClick={() => {
              if (engineStatus && !engineStatus.ok && !engineStatus.needsModels) {
                setShowSetup(true)
              } else {
                void openWizard('manual')
              }
            }}
          />
          <button
            type="button"
            className="pill ghost small gear"
            title="Settings"
            aria-label="Settings"
            onClick={() => setShowSettings(true)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
              <path d="M9.405 1.05c-.413-1.4-2.397-1.4-2.81 0l-.1.34a1.464 1.464 0 0 1-2.105.872l-.31-.17c-1.283-.698-2.686.705-1.987 1.987l.169.311c.446.82.023 1.841-.872 2.105l-.34.1c-1.4.413-1.4 2.397 0 2.81l.34.1a1.464 1.464 0 0 1 .872 2.105l-.17.31c-.698 1.283.705 2.686 1.987 1.987l.311-.169a1.464 1.464 0 0 1 2.105.872l.1.34c.413 1.4 2.397 1.4 2.81 0l.1-.34a1.464 1.464 0 0 1 2.105-.872l.31.17c1.283.698 2.686-.705 1.987-1.987l-.169-.311a1.464 1.464 0 0 1 .872-2.105l.34-.1c1.4-.413 1.4-2.397 0-2.81l-.34-.1a1.464 1.464 0 0 1-.872-2.105l.17-.31c.698-1.283-.705-2.686-1.987-1.987l-.311.169a1.464 1.464 0 0 1-2.105-.872l-.1-.34zM8 10.93a2.929 2.929 0 1 1 0-5.86 2.929 2.929 0 0 1 0 5.858z" />
            </svg>
          </button>
        </div>
      </header>

      {phase === 'ready' && !showCatalog ? (
        <>
          <div className="main-row">
            <div className="main-col">
              <TrackStack
                tracks={tracks}
                engine={engine}
                view={view}
                beat={metCfg.grid ? beatInfo : null}
                onMoveBar={handleMoveBar}
                onClearBar={handleClearBar}
                ducked={duckedIds}
                selection={selection}
                onSelection={handleSelection}
                onZoom={zoomBy}
                onViewPan={panView}
                onFollow={followView}
                onResetZoom={() => {
                  touchSettings()
                  setView(null)
                }}
                onMute={handleMute}
                onSolo={handleSolo}
                onVolume={handleVolume}
                onAddTrack={openTrackPicker}
                onRemoveTrack={removeTrack}
                onRenameTrack={renameTrack}
              />
              {karaoke && (
                <PitchStrip
                  engine={engine}
                  melody={melody}
                  beatProg={beatProg}
                  transpose={transpose}
                  tempo={tempoRate}
                  view={view}
                  onZoom={zoomBy}
                  onViewPan={panView}
                  info={songInfo}
                  inputId={audioPrefs.inputId}
                  onMicDevice={setMicDevice}
                />
              )}
            </div>
            {karaoke && (
              <LyricsPanel
                engine={engine}
                lyrics={lyrics}
                singMask={singMask}
                songPath={song?.path ?? ''}
                songName={cleanSongName(song?.name ?? '')}
                guideOn={!vocalsMuted}
                onToggleGuide={() => handleMute('vocals', !vocalsMuted)}
                onRetry={() => void prepLyrics()}
                onDownloadModel={() => void prepLyrics(true)}
                onUseWhisper={() => void prepLyrics(false, 'whisper')}
                onRefineTiming={() => void prepLyrics(false, 'align')}
                onPreciseAlign={preciseCap ? () => void prepLyrics(false, 'precise') : null}
                onResult={applyLyricsResult}
                onCancel={() => void window.singz.cancelLyrics()}
              />
            )}
          </div>
          <Transport
            engine={engine}
            playing={playing}
            onTogglePlay={togglePlay}
            split={split}
            sep={sep}
            karaokeOn={karaoke}
            loopOn={loopOn}
            onToggleLoop={toggleLoop}
            hasSelection={selection !== null}
            volume={masterVol}
            onVolume={changeMasterVol}
            training={training}
            trainCfg={trainCfg}
            onToggleTraining={toggleTraining}
            onTrainCfg={handleTrainCfg}
            ducking={duckedIds.length > 0}
            linesReady={lines !== null && lines.length > 0}
            stemIds={split ? tracks.map((t) => t.id) : []}
            transpose={transpose}
            onTranspose={handleTranspose}
            tempo={tempoRate}
            onTempo={handleTempo}
            bpm={songInfo.bpm}
            analysis={analysisNote}
            beat={beatInfo}
            met={metCfg}
            canDetectBeat={drumsBufRef.current !== null}
            onMetCfg={handleMetCfg}
            onBeat={handleBeat}
            onRedetectBeat={redetectBeat}
            onToggleKaraoke={toggleKaraoke}
            onSplit={() => void startSplit()}
            onResplit={split && !sep ? () => void startSplit() : null}
            onCancelSplit={() => void window.singz.cancelSeparation()}
            onReveal={
              stemFiles ? () => void window.singz.revealInFolder(stemFiles.vocals) : null
            }
          />
        </>
      ) : (
        <DropScreen
          loading={phase === 'loading'}
          songName={song?.name}
          openName={showCatalog ? song?.name : undefined}
          onBrowse={openPicker}
          onOpenProject={(p) => void loadPath(p)}
          onManageStorage={() => setShowProjects(true)}
          onShowLog={() => setShowLog(true)}
          onDeleted={handleDeleted}
        />
      )}

      {dragDepth > 0 && (
        <div className="drop-overlay">
          <div className="drop-frame">Release to load</div>
        </div>
      )}

      {error && (
        <div className="toast" role="alert">
          {error}
        </div>
      )}

      {notice && !error && <div className="toast ok">{notice}</div>}

      {showSetup && (
        <SetupModal
          status={engineStatus}
          onClose={() => setShowSetup(false)}
          onStatus={setEngineStatus}
        />
      )}

      {wizard && (
        <SetupWizard models={wizard.models} origin={wizard.origin} onClose={closeWizard} />
      )}

      {showLog && <LogPanel onClose={() => setShowLog(false)} />}

      {showSettings && (
        <SettingsModal
          audio={audioPrefs}
          onChangeOutput={(id) => void changeOutput(id)}
          onChangeInput={changeInput}
          outputStatus={outputStatus}
          micDevice={micDevice}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showProjects && (
        <ProjectPicker
          onOpen={(p) => void loadPath(p)}
          onBrowse={() => {
            setShowProjects(false)
            openPicker()
          }}
          onClose={() => setShowProjects(false)}
        />
      )}

      {showImport && projectDir && (
        <LibraryImport
          dir={projectDir}
          busy={importing}
          onImport={(mode) => void handleImport(mode)}
          onClose={() => !importing && setShowImport(false)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void loadFile(file)
          e.target.value = ''
        }}
      />

      <input
        ref={trackInputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        data-testid="add-track-input"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length > 0) void addTracks(files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
