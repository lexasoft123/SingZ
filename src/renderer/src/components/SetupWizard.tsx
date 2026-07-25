import { useEffect, useRef, useState } from 'react'
import type { ModelInfo } from '../../../shared/types'

interface Props {
  models: ModelInfo[]
  onDone: () => void
  onSkip: () => void
}

type RowState = 'waiting' | 'downloading' | 'done' | 'error'

/**
 * First-run setup: downloads the AI models the app needs into the shared
 * local cache, with per-model progress. Starts automatically on mount.
 */
export default function SetupWizard({ models, onDone, onSkip }: Props): React.JSX.Element {
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [states, setStates] = useState<Record<string, RowState>>({})
  const [error, setError] = useState<string | null>(null)
  const startedRef = useRef(false)

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const unsub = window.singz.onModelsProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p.percent }))
      setStates((prev) => ({ ...prev, [p.id]: p.percent >= 100 ? 'done' : 'downloading' }))
    })
    void (async () => {
      const res = await window.singz.downloadModels()
      unsub()
      if (res.ok) {
        onDone()
      } else if (!res.cancelled) {
        setError(res.error)
        setStates((prev) => {
          const next = { ...prev }
          for (const m of models) if (next[m.id] !== 'done') next[m.id] = 'error'
          return next
        })
      }
    })()
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const retry = (): void => {
    setError(null)
    startedRef.current = false
    setStates({})
    // re-trigger the mount effect by toggling a key upstream is overkill;
    // just run the same flow again inline
    startedRef.current = true
    const unsub = window.singz.onModelsProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p.percent }))
      setStates((prev) => ({ ...prev, [p.id]: p.percent >= 100 ? 'done' : 'downloading' }))
    })
    void window.singz.downloadModels().then((res) => {
      unsub()
      if (res.ok) onDone()
      else if (!res.cancelled) setError(res.error)
    })
  }

  return (
    <div className="modal-scrim">
      <div className="modal-card wizard">
        <h2>Setting up SingZ</h2>
        <p>
          Downloading the AI models SingZ runs locally — a one-time step; everything is stored on
          this machine and reused for every song.
        </p>
        <div className="wiz-rows">
          {models.map((m) => {
            const st = states[m.id] ?? 'waiting'
            const pct = progress[m.id] ?? 0
            return (
              <div key={m.id} className={`wiz-row ${st}`}>
                <div className="wiz-head">
                  <span className="wiz-name">{m.label}</span>
                  <span className="wiz-size">
                    {st === 'done' ? '✓' : st === 'error' ? 'failed' : `${m.sizeMb} MB`}
                  </span>
                </div>
                <div className="lp-bar">
                  <div style={{ width: `${st === 'done' ? 100 : pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
        {error && <p className="fine warn">{error}</p>}
        <div className="modal-actions">
          {error && (
            <button type="button" className="pill primary" onClick={retry}>
              Try again
            </button>
          )}
          <button
            type="button"
            className="pill ghost"
            onClick={() => {
              void window.singz.cancelModels()
              onSkip()
            }}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  )
}
