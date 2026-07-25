import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngineStatus, SeparationProgress, StemName } from '../../shared/types'
import { MultitrackEngine } from './audio/engine'
import { computePeaks } from './audio/peaks'
import DropScreen from './components/DropScreen'
import SetupModal from './components/SetupModal'
import TrackStack from './components/TrackStack'
import Transport from './components/Transport'
import { STEM_ORDER, TRACK_META, type UITrack } from './model'

type Phase = 'empty' | 'loading' | 'ready'

const ACCEPT = '.mp3,.wav,.flac,.m4a,.aac,.ogg,.oga,.opus,.aif,.aiff,audio/*'

function makeTrack(id: string, buffer: AudioBuffer): UITrack {
  const meta = TRACK_META[id] ?? { label: id, color: '#bfb49d' }
  return { id, ...meta, peaks: computePeaks(buffer), muted: false, solo: false, volume: 1 }
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
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [dragDepth, setDragDepth] = useState(0)
  const loadSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sepRunningRef = useRef(false)
  sepRunningRef.current = sep !== null

  useEffect(() => engine.subscribe(() => setPlaying(engine.playing)), [engine])

  useEffect(() => {
    void window.singz.checkEngine().then(setEngineStatus)
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
      if (e.code === 'Space') {
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
      setSep(null)
      setSplit(false)
      setStemFiles(null)
      setError(null)
      setPhase('loading')
      setSong({ path: reg.path, name: reg.name })
      try {
        const buf = await window.singz.readAudio(reg.path)
        const audio = await engine.decode(buf)
        if (seq !== loadSeq.current) return
        engine.load([{ id: 'original', buffer: audio }])
        setTracks([makeTrack('original', audio)])
        setPhase('ready')
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
      setShowSetup(true)
      return
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

  const karaokeOn = split && (tracks.find((t) => t.id === 'vocals')?.muted ?? false)

  const openPicker = useCallback(() => fileInputRef.current?.click(), [])

  return (
    <div className="app">
      <header className="titlebar">
        <div className="logo">
          Sing<span>Z</span>
        </div>
        {song && phase === 'ready' && <div className="song-title">{song.name}</div>}
        <div className="header-right no-drag">
          {phase === 'ready' && (
            <button type="button" className="pill ghost small" onClick={openPicker}>
              Open…
            </button>
          )}
          <EngineChip status={engineStatus} onClick={() => setShowSetup(true)} />
        </div>
      </header>

      {phase === 'ready' ? (
        <>
          <TrackStack
            tracks={tracks}
            engine={engine}
            onMute={handleMute}
            onSolo={handleSolo}
            onVolume={handleVolume}
          />
          <Transport
            engine={engine}
            playing={playing}
            split={split}
            sep={sep}
            karaokeOn={karaokeOn}
            onToggleKaraoke={() => handleMute('vocals', !karaokeOn)}
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
