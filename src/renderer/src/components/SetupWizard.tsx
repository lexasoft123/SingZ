import { useEffect, useRef, useState } from 'react'
import type { ModelId, ModelInfo } from '../../../shared/types'

interface Props {
  models: ModelInfo[]
  origin: 'auto' | 'manual'
  onClose: () => void
}

/**
 * Model manager / first-run setup. Required items download automatically
 * (auto origin); optional packs have their own Get button. Everything lands
 * in the shared local cache with per-model progress.
 */
export default function SetupWizard({ models: initial, origin, onClose }: Props): React.JSX.Element {
  const [models, setModels] = useState(initial)
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const isWin = document.body.classList.contains('win')
  const [engineMode, setEngineMode] = useState<{ mode: 'auto' | 'cpu'; reason?: string } | null>(
    null
  )

  useEffect(() => {
    if (isWin) void window.singz.getSplitterMode().then(setEngineMode)
  }, [isWin])

  const chooseMode = async (mode: 'auto' | 'cpu'): Promise<void> => {
    await window.singz.setSplitterMode(mode)
    setEngineMode(await window.singz.getSplitterMode())
  }
  const startedRef = useRef(false)
  const busy = running.size > 0

  const download = async (ids?: ModelId[]): Promise<void> => {
    setError(null)
    const target = ids ?? models.filter((m) => m.required && !m.present).map((m) => m.id)
    if (target.length === 0) return
    setRunning(new Set(target))
    const unsub = window.singz.onModelsProgress((p) =>
      setProgress((prev) => ({ ...prev, [p.id]: p.percent }))
    )
    const res = await window.singz.downloadModels(target)
    unsub()
    setRunning(new Set())
    setModels(await window.singz.modelsStatus())
    if (!res.ok && !res.cancelled) setError(res.error)
  }

  useEffect(() => {
    if (origin === 'auto' && !startedRef.current) {
      startedRef.current = true
      void download()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // First-run flow closes itself once everything required is in place.
  const requiredDone = models.every((m) => !m.required || m.present)
  useEffect(() => {
    if (origin === 'auto' && requiredDone && !busy && !error) {
      const t = setTimeout(onClose, 1100)
      return () => clearTimeout(t)
    }
    return undefined
  }, [origin, requiredDone, busy, error, onClose])

  return (
    <div className="modal-scrim">
      <div className="modal-card wizard">
        <h2>{origin === 'auto' ? 'Setting up SingZ' : 'AI models'}</h2>
        <p>
          SingZ runs its AI locally. Models download once into a shared folder and are reused for
          every song.
        </p>
        <div className="wiz-rows">
          {models.map((m) => {
            const isRunning = running.has(m.id)
            const pct = progress[m.id] ?? 0
            return (
              <div key={m.id} className={`wiz-row${m.present ? ' done' : ''}`}>
                <div className="wiz-head">
                  <span className="wiz-name">{m.label}</span>
                  {m.present && !isRunning ? (
                    <span className="wiz-installed">
                      <span className="wiz-size ok">installed ✓</span>
                      <button
                        type="button"
                        className="pill ghost small"
                        title="Download and install this again — fixes an install that exists but won't run"
                        disabled={busy}
                        onClick={() => void download([m.id])}
                      >
                        Reinstall
                      </button>
                    </span>
                  ) : isRunning ? (
                    <span className="wiz-size">{Math.round(pct)}%</span>
                  ) : m.optional ? (
                    <button
                      type="button"
                      className="pill ghost small"
                      disabled={busy}
                      onClick={() => void download([m.id])}
                    >
                      Get · {m.sizeMb} MB
                    </button>
                  ) : (
                    <span className="wiz-size">{m.sizeMb} MB</span>
                  )}
                </div>
                <p className="wiz-desc">{m.description}</p>
                {(isRunning || (!m.present && !m.optional)) && (
                  <div className="lp-bar">
                    <div style={{ width: `${m.present ? 100 : pct}%` }} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {isWin && engineMode && (
          <div className="wiz-engine">
            <div className="wiz-head">
              <span className="wiz-name">Splitting engine</span>
              <span className="mode-seg">
                <button
                  type="button"
                  className={engineMode.mode === 'auto' ? 'on' : ''}
                  title="Try the graphics card first, fall back to the processor if it misbehaves"
                  onClick={() => void chooseMode('auto')}
                >
                  GPU
                </button>
                <button
                  type="button"
                  className={engineMode.mode === 'cpu' ? 'on' : ''}
                  title="Split on the processor only"
                  onClick={() => void chooseMode('cpu')}
                >
                  CPU
                </button>
              </span>
            </div>
            <p className="wiz-desc">
              {engineMode.mode === 'cpu'
                ? engineMode.reason && engineMode.reason !== 'chosen in the model manager'
                  ? `The graphics card was turned off automatically (${engineMode.reason}) — pick GPU to try it again.`
                  : 'Splits use the processor only.'
                : 'Splits try the graphics card first and fall back to the processor if it misbehaves.'}
            </p>
          </div>
        )}
        {error && <p className="fine warn">{error}</p>}
        <div className="modal-actions">
          {error && (
            <button type="button" className="pill primary" onClick={() => void download()}>
              Try again
            </button>
          )}
          <button
            type="button"
            className="pill ghost"
            onClick={() => {
              void window.singz.cancelModels()
              onClose()
            }}
          >
            {origin === 'auto' && !requiredDone ? 'Skip for now' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
