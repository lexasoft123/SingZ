import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineStatus, SeparationProgress, StemName } from '../../shared/types'
import { estimateKey, estimateTempo, type KeyGuess } from './audio/analysis'
import { MultitrackEngine } from './audio/engine'
import { computePeaks } from './audio/peaks'
import DropScreen from './components/DropScreen'
import LyricsPanel, { type LyricsState } from './components/LyricsPanel'
import SetupWizard from './components/SetupWizard'
import PitchStrip, { type MelodyState } from './components/PitchStrip'
import SetupModal from './components/SetupModal'
import TrackStack from './components/TrackStack'
import Transport from './components/Transport'
import { cleanSongName, STEM_ORDER, TRACK_META, type TimeView, type UITrack } from './model'

type Phase = 'empty' | 'loading' | 'ready'

const ACCEPT = '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.aif,.aiff,audio/*'

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
      <span className="chip-status" title={status.command}>
        <span className="dot ok" /> splitter ready
      </span>
    )
  }
  return (
    <button type="button" className="chip-status warn" onClick={onClick}>
      <span className="dot warn" /> splitter setup
    </button>
  )
}

export default function App(): React.JSX.Element {
  const [engine] = useState(() => new MultitrackEngine())
  const [phase, setPhase] = useState<Phase>('empty')
  const [song, setSong] = useState<{ path: string; name: string } | null>(null)
  const [tracks, setTracks] = useState<UITrack[]>([])
  const [split, setSplit] = useState(false)
  const [stemFiles, setStemFiles] = useState<Record<StemName, string> | null>(null)
  const [sep, setSep] = useState<SeparationProgress | null>(null)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [showSetup, setShowSetup] = useState(false)
  const [wizardModels, setWizardModels] = useState<import('../../shared/types').ModelInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [karaoke, setKaraoke] = useState(false)
  const [lyrics, setLyrics] = useState<LyricsState>({ status: 'idle' })
  const [melody, setMelody] = useState<MelodyState>({ status: 'none' })
  const [transpose, setTranspose] = useState(0)
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
    void window.singz.checkEngine().then(setEngineStatus)
    // First-run setup: required models that aren't downloaded yet.
    void window.singz.modelsStatus().then((models) => {
      const missing = models.filter((m) => m.required && !m.present)
      if (missing.length > 0) setWizardModels(missing)
    })
  }, [])

  const finishWizard = useCallback(() => {
    setWizardModels(null)
    void window.singz.checkEngine(true).then(setEngineStatus)
  }, [])

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 7000)
    return () => clearTimeout(t)
  }, [error])

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

  const loadFile = useCallback(
    async (file: File) => {
      const path = window.singz.pathForFile(file)
      if (!path) {
        setError('Could not resolve that file on disk.')
        return
      }
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
      setSaveState('idle')
      setView(null)
      setPhase('loading')
      setSong({ path: reg.path, name: reg.name })
      try {
        // Saved project with stems: load them directly and restore settings.
        if (reg.project?.stems) {
          const proj = reg.project
          const stems = proj.stems as Record<StemName, string>
          const buffers = await Promise.all(
            STEM_ORDER.map(async (s) => engine.decode(await window.singz.readAudio(stems[s])))
          )
          if (seq !== loadSeq.current) return
          engine.load(STEM_ORDER.map((s, i) => ({ id: s, buffer: buffers[i] })))
          const uiTracks = STEM_ORDER.map((s, i) => {
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
          vocalsBufRef.current = buffers[STEM_ORDER.indexOf('vocals')]
          drumsBufRef.current = buffers[STEM_ORDER.indexOf('drums')]
          const st = proj.settings.transpose ?? 0
          setTranspose(st)
          void engine.setTranspose(st)
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
        const models = await window.singz.modelsStatus()
        setWizardModels(models.filter((m) => !m.present))
      } else {
        setShowSetup(true)
      }
      return
    }
    // The bundled splitter needs 44.1k audio — render it from the decoded
    // buffer so any source format/sample-rate works.
    if (status.command === 'bundled demucs.cpp' && originalBufRef.current) {
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
      const buffers = await Promise.all(
        STEM_ORDER.map(async (s) => engine.decode(await window.singz.readAudio(res.stems[s])))
      )
      const position = engine.position
      const wasPlaying = engine.playing
      engine.load(
        STEM_ORDER.map((s, i) => ({ id: s, buffer: buffers[i] })),
        { position, play: wasPlaying }
      )
      setTracks(STEM_ORDER.map((s, i) => makeTrack(s, buffers[i])))
      setStemFiles(res.stems)
      setSplit(true)
      vocalsBufRef.current = buffers[STEM_ORDER.indexOf('vocals')]
      drumsBufRef.current = buffers[STEM_ORDER.indexOf('drums')]
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
    worker.onmessage = (e: MessageEvent<{ type: string; p?: number; f0?: Float32Array; hopSec?: number }>) => {
      if (e.data.type === 'progress') {
        setMelody({ status: 'computing', p: e.data.p ?? 0 })
      } else if (e.data.type === 'done' && e.data.f0 && e.data.hopSec) {
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
      tracks: Object.fromEntries(
        tracks.map((t) => [t.id, { muted: t.muted, solo: t.solo, volume: t.volume }])
      )
    }
    const res = await window.singz.saveProject(song.path, cleanSongName(song.name), settings)
    if (res.ok) {
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2500)
    } else {
      setSaveState('idle')
      setError(`Could not save the project: ${res.error}`)
    }
  }, [song, saveState, transpose, tracks])

  const handleTranspose = useCallback(
    (st: number) => {
      const clamped = Math.max(-12, Math.min(12, st))
      setTranspose(clamped)
      void engine.setTranspose(clamped)
    },
    [engine]
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
        </div>
        {song && phase === 'ready' && <div className="song-title">{song.name}</div>}
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
            <button type="button" className="pill ghost small" onClick={openPicker}>
              Open…
            </button>
          )}
          <EngineChip
            status={engineStatus}
            onClick={() => {
              if (engineStatus && !engineStatus.ok && engineStatus.needsModels) {
                void window.singz.modelsStatus().then((models) => {
                  setWizardModels(models.filter((m) => !m.present))
                })
              } else {
                setShowSetup(true)
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
            onToggleKaraoke={toggleKaraoke}
            onSplit={() => void startSplit()}
            onCancelSplit={() => void window.singz.cancelSeparation()}
            onReveal={
              stemFiles ? () => void window.singz.revealInFolder(stemFiles.vocals) : null
            }
          />
        </>
      ) : (
        <DropScreen loading={phase === 'loading'} songName={song?.name} onBrowse={openPicker} />
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

      {showSetup && (
        <SetupModal
          status={engineStatus}
          onClose={() => setShowSetup(false)}
          onStatus={setEngineStatus}
        />
      )}

      {wizardModels && wizardModels.length > 0 && (
        <SetupWizard
          models={wizardModels}
          onDone={finishWizard}
          onSkip={() => setWizardModels(null)}
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
