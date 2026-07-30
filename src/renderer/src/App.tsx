import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CustomTrack,
  EngineStatus,
  LyricLine,
  ProjectSettings,
  SeparationProgress
} from '../../shared/types'
import { BEAT_DETECT_VERSION, detectBeats, estimateKey, type KeyGuess } from './audio/analysis'
import {
  MET_DEFAULTS,
  sanitizeBeatInfo,
  sanitizeMetronome,
  type BeatInfo,
  type MetronomeConfig
} from './audio/beat'
import { MultitrackEngine } from './audio/engine'
import { computePeaks } from './audio/peaks'
import DropScreen from './components/DropScreen'
import LogPanel from './components/LogPanel'
import LyricsPanel, { type LyricsState } from './components/LyricsPanel'
import LibraryImport from './components/LibraryImport'
import ProjectPicker from './components/ProjectPicker'
import SetupWizard from './components/SetupWizard'
import PitchStrip, { type MelodyState } from './components/PitchStrip'
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
  sanitizeTraining,
  trackLabel,
  TRACK_META,
  TRAIN_DEFAULTS,
  trainingWindows,
  type TimeView,
  type TrainingConfig,
  type UITrack
} from './model'

type Phase = 'empty' | 'loading' | 'ready'

const ACCEPT = '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.aif,.aiff,audio/*'


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
  const [transpose, setTranspose] = useState(0)
  const [tempoRate, setTempoRate] = useState(1)
  const [view, setView] = useState<TimeView | null>(null)
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
  const bassBufRef = useRef<AudioBuffer | null>(null)
  const linesRef = useRef<LyricLine[] | null>(null)
  const originalBufRef = useRef<AudioBuffer | null>(null)
  const lyricsRef = useRef(lyrics)
  lyricsRef.current = lyrics
  const melodyRef = useRef(melody)
  melodyRef.current = melody
  const selectionRef = useRef(selection)
  selectionRef.current = selection
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

  // Background animation loops pause while a modal covers the app (the
  // scrim's backdrop blur re-rasters the whole window on every change).
  useEffect(() => {
    const open = Boolean(showLog || showProjects || showSetup || showImport || wizard)
    document.body.classList.toggle('modal-open', open)
  }, [showLog, showProjects, showSetup, showImport, wizard])

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
      const tgt = e.target as HTMLElement
      const inText =
        (tgt instanceof HTMLInputElement && tgt.type !== 'range') ||
        tgt instanceof HTMLTextAreaElement
      if (inText) return
      if (e.code === 'Escape') {
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
      vocalsBufRef.current = null
      drumsBufRef.current = null
      bassBufRef.current = null
      originalBufRef.current = null
      setSongInfo({ key: null, bpm: null })
      setBeatInfo(null)
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
      setView(null)
      setPhase('loading')
      setSong({ path: reg.path, name: reg.name })
      setIsProject(Boolean(reg.project))
      setInLibrary(reg.project?.inLibrary ?? true)
      setProjectDir(reg.project?.dir ?? null)
      setEditName(null)
      setShowProjects(false)
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
          drumsBufRef.current = buffers[order.indexOf('drums')] ?? null
          bassBufRef.current = buffers[order.indexOf('bass')] ?? null
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
          if (localStorage.getItem('singz.karaoke') === '1') openKaraokeRef.current?.()
          else prepMelodyRef.current?.()
          const st = proj.settings.transpose ?? 0
          setTranspose(st)
          void engine.setTranspose(st)
          const tr = proj.settings.tempo ?? 1
          setTempoRate(tr)
          void engine.setTempo(tr)
          const bg = sanitizeBeatInfo(proj.settings.beat)
          if (bg) {
            setBeatInfo(bg)
            setSongInfo({ key: null, bpm: bg.bpm })
          }
          if (proj.settings.metronome) setMetCfg(sanitizeMetronome(proj.settings.metronome))
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
              if (r.ok && r.converted) {
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
      drumsBufRef.current = buffers[order.indexOf('drums')] ?? null
      bassBufRef.current = buffers[order.indexOf('bass')] ?? null
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
      // Ladder: cache → LRCLIB synced lyrics → whisper (with model consent).
      setLyrics({ status: 'loading', progress: null })
      const unsub = window.singz.onLyricsProgress((p) => setLyrics({ status: 'loading', progress: p }))
      const res = await window.singz.getLyrics(
        song.path,
        engine.duration,
        allowDownload,
        preferRef.current
      )
      unsub()
      applyLyricsResult(res)
    },
    [song, engine, applyLyricsResult]
  )
  prepLyricsRef.current = prepLyrics

  const prepMelody = useCallback(() => {
    if (melodyRef.current.status !== 'none') return
    const buf = vocalsBufRef.current
    if (!buf) return
    const chans = Math.min(2, buf.numberOfChannels)
    const mono = new Float32Array(buf.length)
    for (let c = 0; c < chans; c++) {
      const data = buf.getChannelData(c)
      for (let i = 0; i < data.length; i++) mono[i] += data[i] / chans
    }
    setMelody({ status: 'computing', p: 0 })
    const worker = new Worker(new URL('./audio/pitch.worker.ts', import.meta.url), {
      type: 'module'
    })
    worker.onmessage = (e: MessageEvent<{ type: string; p?: number; f0?: Float32Array; raw?: Float32Array; clarity?: Float32Array; rms?: Float32Array; hopSec?: number }>) => {
      if (e.data.type === 'progress') {
        setMelody({ status: 'computing', p: e.data.p ?? 0 })
      } else if (e.data.type === 'done' && e.data.f0 && e.data.hopSec) {
        // diagnostics hook: E2E drivers dump this to tune the melody cleaner
        ;(window as { __melody?: unknown }).__melody = {
          f0: e.data.f0,
          raw: e.data.raw,
          clarity: e.data.clarity,
          rms: e.data.rms,
          hopSec: e.data.hopSec
        }
        setMelody({ status: 'ready', f0: e.data.f0, hopSec: e.data.hopSec })
        // Beat track from the drums (once per song — a hand-tuned track wins
        // over re-detection; restored auto tracks from an older detector are
        // silently re-tracked so downbeat fixes reach saved projects).
        let info = beatInfoRef.current
        const stale = info?.source === 'auto' && info.detVersion !== BEAT_DETECT_VERSION
        if ((!info || stale) && drumsBufRef.current) {
          const det = detectBeats(drumsBufRef.current, {
            bass: bassBufRef.current,
            vocals: vocalsBufRef.current,
            lineStarts: linesRef.current?.map((l) => l.words[0]?.s ?? l.start) ?? null
          })
          if (det) {
            info = {
              beats: det.beats,
              bpm: det.bpm,
              beatsPerBar: det.beatsPerBar,
              downbeat: det.downbeat,
              source: 'auto',
              detVersion: BEAT_DETECT_VERSION
            }
            setBeatInfo(info)
            if (stale) touchSettings()
          }
        }
        setSongInfo({
          key: estimateKey(e.data.f0),
          bpm: info?.bpm ?? null
        })
        worker.terminate()
      }
    }
    worker.postMessage({ mono, sampleRate: buf.sampleRate }, [mono.buffer])
  }, [])
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
      metronome: metCfg,
      custom: tracks
        .filter((t) => t.custom)
        .map((t) => ({ id: t.id, label: t.label, color: t.color, file: t.custom!.file })),
      tracks: Object.fromEntries(
        tracks.map((t) => [t.id, { muted: t.muted, solo: t.solo, volume: t.volume }])
      )
    }
    const res = await window.singz.saveProject(song.path, cleanSongName(song.name), settings)
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
  }, [song, saveState, transpose, tempoRate, view, selection, loopOn, training, trainCfg, beatInfo, metCfg, tracks, reanchorCustom])

  /** Bring a project opened from outside the library in, and follow it there. */
  const handleImport = useCallback(
    async (mode: 'copy' | 'move') => {
      if (!song || importing) return
      setImporting(true)
      const res = await window.singz.importProject(song.path, mode)
      setImporting(false)
      if (!res.ok) {
        setShowImport(false)
        setError(res.error)
        return
      }
      // the copy in the library is the one we keep working on from here
      setSong((s) => (s ? { ...s, path: res.songPath } : s))
      if (res.stems) setStemFiles(res.stems)
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
        const res = await window.singz.renameProject(song.path, name)
        if (!res.ok) {
          setError(res.error)
          return
        }
        setSong({ path: res.songPath, name: res.name })
        if (res.stems) setStemFiles(res.stems)
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

  /** Re-track the beats from the drums stem (the popover's Re-detect). */
  const redetectBeat = useCallback(() => {
    const buf = drumsBufRef.current
    if (!buf) return
    const det = detectBeats(buf, {
      bass: bassBufRef.current,
      vocals: vocalsBufRef.current,
      lineStarts: linesRef.current?.map((l) => l.words[0]?.s ?? l.start) ?? null
    })
    if (det) {
      touchSettings()
      setBeatInfo({
        beats: det.beats,
        bpm: det.bpm,
        beatsPerBar: det.beatsPerBar,
        downbeat: det.downbeat,
        source: 'auto',
        detVersion: BEAT_DETECT_VERSION
      })
      setSongInfo((s) => ({ ...s, bpm: det.bpm }))
    } else {
      setNotice('No steady beat found in the drums — tap the tempo instead.')
    }
  }, [touchSettings])

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

  const zoomBy = useCallback(
    (factor: number, center?: number) => {
      touchSettings()
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
    [engine, clampView, touchSettings]
  )

  const shiftView = useCallback(
    (s: number, e: number) => {
      touchSettings()
      setView(clampView(s, e))
    },
    [clampView, touchSettings]
  )

  return (
    <div className="app">
      <header className="titlebar">
        {document.body.classList.contains('win') && <WindowButtons />}
        <div className="logo">
          Sing<span>Z</span>
          {ver && <em className="ver">{ver}</em>}
        </div>
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
          {phase === 'ready' && (
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
        </div>
      </header>

      {phase === 'ready' ? (
        <>
          <div className="main-row">
            <div className="main-col">
              <TrackStack
                tracks={tracks}
                engine={engine}
                view={view}
                ducked={duckedIds}
                selection={selection}
                onSelection={handleSelection}
                onZoom={zoomBy}
                onViewShift={shiftView}
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
                  transpose={transpose}
                  tempo={tempoRate}
                  view={view}
                  onZoom={zoomBy}
                  onViewShift={shiftView}
                  info={songInfo}
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
          onBrowse={openPicker}
          onOpenProject={(p) => void loadPath(p)}
          onManageStorage={() => setShowProjects(true)}
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
