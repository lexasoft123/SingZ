import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineStatus, SeparationProgress } from '../../shared/types'
import { estimateKey, estimateTempo, type KeyGuess } from './audio/analysis'
import { MultitrackEngine } from './audio/engine'
import { computePeaks } from './audio/peaks'
import DropScreen from './components/DropScreen'
import LogPanel from './components/LogPanel'
import LyricsPanel, { type LyricsState } from './components/LyricsPanel'
import ProjectPicker from './components/ProjectPicker'
import SetupWizard from './components/SetupWizard'
import PitchStrip, { type MelodyState } from './components/PitchStrip'
import SetupModal from './components/SetupModal'
import TrackStack from './components/TrackStack'
import Transport from './components/Transport'
import { cleanSongName, orderedStems, TRACK_META, type TimeView, type UITrack } from './model'

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

function makeTrack(id: string, buffer: AudioBuffer): UITrack {
  const meta = TRACK_META[id] ?? { label: id, color: '#bfb49d' }
  const { peaks, scale } = computePeaks(buffer)
  return { id, ...meta, peaks, buffer, scale, muted: false, solo: false, volume: 1 }
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
  const [isProject, setIsProject] = useState(false)
  const [editName, setEditName] = useState<string | null>(null)
  const [wizard, setWizard] = useState<{
    models: import('../../shared/types').ModelInfo[]
    origin: 'auto' | 'manual'
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [karaoke, setKaraoke] = useState(false)
  const [lyrics, setLyrics] = useState<LyricsState>({ status: 'idle' })
  const [melody, setMelody] = useState<MelodyState>({ status: 'none' })
  const [transpose, setTranspose] = useState(0)
  const [tempoRate, setTempoRate] = useState(1)
  const [view, setView] = useState<TimeView | null>(null)
  const [songInfo, setSongInfo] = useState<{ key: KeyGuess | null; bpm: number | null }>({
    key: null,
    bpm: null
  })
  const drumsBufRef = useRef<AudioBuffer | null>(null)
  const loadSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sepRunningRef = useRef(false)
  sepRunningRef.current = sep !== null
  const vocalsBufRef = useRef<AudioBuffer | null>(null)
  const originalBufRef = useRef<AudioBuffer | null>(null)
  const lyricsRef = useRef(lyrics)
  lyricsRef.current = lyrics
  const melodyRef = useRef(melody)
  melodyRef.current = melody

  useEffect(() => engine.subscribe(() => setPlaying(engine.playing)), [engine])

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
    const open = Boolean(showLog || showProjects || showSetup || wizard)
    document.body.classList.toggle('modal-open', open)
  }, [showLog, showProjects, showSetup, wizard])

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
        setKaraoke(false)
      } else if (e.code === 'Space') {
        e.preventDefault()
        ;(tgt.closest('button') as HTMLElement | null)?.blur()
        engine.toggle()
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
      originalBufRef.current = null
      setSongInfo({ key: null, bpm: null })
      preferRef.current = 'auto'
      setTranspose(0)
      void engine.setTranspose(0)
      setTempoRate(1)
      void engine.setTempo(1)
      setSaveState('idle')
      setView(null)
      setPhase('loading')
      setSong({ path: reg.path, name: reg.name })
      setIsProject(Boolean(reg.project))
      setEditName(null)
      setShowProjects(false)
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
          engine.load(order.map((s, i) => ({ id: s, buffer: buffers[i] })))
          const uiTracks = order.map((s, i) => {
            const t = makeTrack(s, buffers[i])
            const saved = proj.settings.tracks[s]
            if (saved) {
              t.muted = saved.muted
              t.solo = saved.solo
              t.volume = saved.volume
              engine.setMuted(s, saved.muted)
              engine.setSolo(s, saved.solo)
              engine.setVolume(s, saved.volume)
            }
            return t
          })
          setTracks(uiTracks)
          setSplit(true)
          setStemFiles(stems)
          setIsProject(true)
          vocalsBufRef.current = buffers[order.indexOf('vocals')] ?? null
          drumsBufRef.current = buffers[order.indexOf('drums')] ?? null
          prepMelodyRef.current?.()
          const st = proj.settings.transpose ?? 0
          setTranspose(st)
          void engine.setTranspose(st)
          const tr = proj.settings.tempo ?? 1
          setTempoRate(tr)
          void engine.setTempo(tr)
          setSaveState('saved')
          setPhase('ready')
          void prepLyricsRef.current?.()
          return
        }

        const buf = await window.singz.readAudio(reg.path)
        const audio = await engine.decode(buf)
        if (seq !== loadSeq.current) return
        originalBufRef.current = audio
        engine.load([{ id: 'original', buffer: audio }])
        setTracks([makeTrack('original', audio)])
        setPhase('ready')
        // Look for lyrics right away (cache/online only — never triggers the
        // model download without consent), so karaoke opens with answers ready.
        void prepLyricsRef.current?.()
      } catch {
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
      const position = engine.position
      const wasPlaying = engine.playing
      engine.load(
        order.map((s, i) => ({ id: s, buffer: buffers[i] })),
        { position, play: wasPlaying }
      )
      setTracks(order.map((s, i) => makeTrack(s, buffers[i])))
      setStemFiles(stems)
      setSplit(true)
      vocalsBufRef.current = buffers[order.indexOf('vocals')] ?? null
      drumsBufRef.current = buffers[order.indexOf('drums')] ?? null
      // Analyze right away (melody, key, bpm) so karaoke opens warm and the
      // bpm box fills in without a trip through karaoke mode.
      prepMelodyRef.current?.()
    } catch {
      setError('Separation finished, but loading the stem files failed.')
    }
    setSep(null)
  }, [song, engineStatus, engine])

  const handleMute = useCallback(
    (id: string, muted: boolean) => {
      engine.setMuted(id, muted)
      setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, muted } : t)))
    },
    [engine]
  )
  const handleSolo = useCallback(
    (id: string, solo: boolean) => {
      engine.setSolo(id, solo)
      setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, solo } : t)))
    },
    [engine]
  )
  const handleVolume = useCallback(
    (id: string, volume: number) => {
      engine.setVolume(id, volume)
      setTracks((ts) => ts.map((t) => (t.id === id ? { ...t, volume } : t)))
    },
    [engine]
  )

  const vocalsMuted = tracks.find((t) => t.id === 'vocals')?.muted ?? false

  const applyLyricsResult = useCallback((res: import('../../shared/types').LyricsResult) => {
    if (!res.ok) {
      setLyrics(
        res.cancelled
          ? { status: 'idle' }
          : res.needsModel
            ? { status: 'consent', sizeMb: res.needsModel.sizeMb }
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
            aligned: res.aligned
          }
        : { status: 'error', error: 'No words were detected in the vocals.' }
    )
  }, [])

  const preferRef = useRef<'auto' | 'whisper' | 'align'>('auto')
  const prepLyricsRef = useRef<
    ((allowDownload?: boolean, prefer?: 'auto' | 'whisper' | 'align') => Promise<void>) | null
  >(null)

  const prepLyrics = useCallback(
    async (allowDownload = false, prefer?: 'auto' | 'whisper' | 'align') => {
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
        setSongInfo({
          key: estimateKey(e.data.f0),
          bpm: drumsBufRef.current ? estimateTempo(drumsBufRef.current) : null
        })
        worker.terminate()
      }
    }
    worker.postMessage({ mono, sampleRate: buf.sampleRate }, [mono.buffer])
  }, [])
  const prepMelodyRef = useRef<(() => void) | null>(null)
  prepMelodyRef.current = prepMelody

  const toggleKaraoke = useCallback(() => {
    if (karaoke) {
      setKaraoke(false)
      return
    }
    if (!split) return
    setKaraoke(true)
    engine.setMuted('vocals', true)
    setTracks((ts) => ts.map((t) => (t.id === 'vocals' ? { ...t, muted: true } : t)))
    void prepLyrics()
    prepMelody()
  }, [karaoke, split, engine, prepLyrics, prepMelody])

  const openPicker = useCallback(() => fileInputRef.current?.click(), [])

  const handleSaveProject = useCallback(async () => {
    if (!song || saveState === 'saving') return
    setSaveState('saving')
    const settings = {
      transpose,
      tempo: tempoRate,
      tracks: Object.fromEntries(
        tracks.map((t) => [t.id, { muted: t.muted, solo: t.solo, volume: t.volume }])
      )
    }
    const res = await window.singz.saveProject(song.path, cleanSongName(song.name), settings)
    if (res.ok) {
      setSaveState('saved')
      // The song now lives inside its project folder — anchor there so
      // renaming and future saves act on the project, not the original file.
      setSong((s) => (s ? { ...s, path: res.songPath } : s))
      setIsProject(true)
      setNotice(`Saved to ${res.dir}`)
      setTimeout(() => setSaveState('idle'), 2500)
    } else {
      setSaveState('idle')
      setError(`Could not save the project: ${res.error}`)
    }
  }, [song, saveState, transpose, tempoRate, tracks])

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
        setNotice(`Renamed — the project folder is now ${res.dir}`)
      } else {
        setSong({ ...song, name })
        setSaveState('idle')
      }
    },
    [song, isProject]
  )

  /** Any settings change makes an open project re-savable. */
  const touchSettings = useCallback(() => {
    setSaveState((s) => (s === 'saved' ? 'idle' : s))
  }, [])

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

  const handleTempo = useCallback(
    (rate: number) => {
      const clamped = Math.round(Math.max(0.5, Math.min(1.5, rate)) * 100) / 100
      touchSettings()
      setTempoRate(clamped)
      void engine.setTempo(clamped).finally(() => {
        setTempoRate(engine.tempo)
        setTranspose(engine.transpose)
      })
    },
    [engine, touchSettings]
  )

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
    [engine, clampView]
  )

  const shiftView = useCallback(
    (s: number, e: number) => {
      setView(clampView(s, e))
    },
    [clampView]
  )

  return (
    <div className="app">
      <header className="titlebar">
        <div className="logo">
          Sing<span>Z</span>
          {ver && <em className="ver">{ver}</em>}
        </div>
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
              title="Save song, stems, lyrics and settings into ~/Music/SingZ"
              disabled={saveState === 'saving'}
              onClick={() => void handleSaveProject()}
            >
              {saveState === 'saved' ? 'Saved ✓' : saveState === 'saving' ? 'Saving…' : 'Save project'}
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
                onZoom={zoomBy}
                onViewShift={shiftView}
                onResetZoom={() => setView(null)}
                onMute={handleMute}
                onSolo={handleSolo}
                onVolume={handleVolume}
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
                songPath={song?.path ?? ''}
                songName={cleanSongName(song?.name ?? '')}
                guideOn={!vocalsMuted}
                onToggleGuide={() => handleMute('vocals', !vocalsMuted)}
                onRetry={() => void prepLyrics()}
                onDownloadModel={() => void prepLyrics(true)}
                onUseWhisper={() => void prepLyrics(false, 'whisper')}
                onRefineTiming={() => void prepLyrics(false, 'align')}
                onResult={applyLyricsResult}
                onCancel={() => void window.singz.cancelLyrics()}
              />
            )}
          </div>
          <Transport
            engine={engine}
            playing={playing}
            split={split}
            sep={sep}
            karaokeOn={karaoke}
            transpose={transpose}
            onTranspose={handleTranspose}
            tempo={tempoRate}
            onTempo={handleTempo}
            bpm={songInfo.bpm}
            onToggleKaraoke={toggleKaraoke}
            onSplit={() => void startSplit()}
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
    </div>
  )
}
