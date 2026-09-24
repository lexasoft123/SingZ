import React, { useEffect, useRef, useState } from 'react'
import type { ModelId, ModelInfo } from '../../../shared/types'
import { Modal } from '@singz/ui'
import { t } from '../i18n'

interface Props {
  models: ModelInfo[]
  origin: 'auto' | 'manual'
  focusModel?: ModelId
  /** Why the wizard opened by itself, when it did — shown above the rows. */
  notice?: string
  onClose: () => void
}

export function setupWizardCloseAction(
  origin: Props['origin'],
  busy: boolean
): 'leave-running' | 'cancel' {
  return origin === 'auto' && busy ? 'leave-running' : 'cancel'
}

/**
 * Model manager / first-run setup. Required items download automatically
 * (auto origin); optional packs have their own Get button. Everything lands
 * in the shared local cache with per-model progress.
 */
export default function SetupWizard({ models: initial, origin, focusModel, notice, onClose }: Props): React.JSX.Element {
  const focusRow = useRef<HTMLDivElement>(null)
  useEffect(() => { focusRow.current?.scrollIntoView({ block: 'nearest' }) }, [focusModel])
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
    <Modal onClose={onClose} cardClassName="wizard" persistent>
        <h2>{origin === 'auto' ? t('settings.wizard.settingUpTitle') : t('settings.wizard.aiModelsTitle')}</h2>
        <p>
          {t('settings.wizard.intro')}
        </p>
        {notice && (
          <p className="wiz-notice" role="status" data-testid="wiz-notice">
            {notice}
          </p>
        )}
        <div className="wiz-rows">
          {models.map((m) => {
            const isRunning = running.has(m.id)
            const pct = progress[m.id] ?? 0
            const targets: ModelId[] = [m.id]
            const downloadMb = m.downloadMb
            return (
              <div
                key={m.id}
                ref={m.id === focusModel ? focusRow : undefined}
                data-model-id={m.id}
                className={`wiz-row${m.present ? ' done' : ''}${notice && m.id === focusModel && !m.present ? ' attention' : ''}`}
              >
                <div className="wiz-head">
                  <span className="wiz-name">{m.label}</span>
                  {m.present && !isRunning ? (
                    <span className="wiz-installed">
                      <span className="wiz-size ok">{t('settings.wizard.installedBadge')}</span>
                      <button
                        type="button"
                        className="pill ghost small"
                        title={t('settings.wizard.reinstallTitle')}
                        disabled={busy}
                        onClick={() => void download(targets)}
                      >
                        {t('settings.wizard.reinstallButton')}
                      </button>
                    </span>
                  ) : isRunning ? (
                    <span className="wiz-size">{Math.round(pct)}%</span>
                  ) : !m.present ? (
                    <button
                      type="button"
                      className="pill ghost small"
                      disabled={busy}
                      onClick={() => void download(targets)}
                    >
                      {t('settings.wizard.getButton', { mb: downloadMb })}
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
              <span className="wiz-name">{t('settings.wizard.engineLabel')}</span>
              <span className="mode-seg">
                <button
                  type="button"
                  className={engineMode.mode === 'auto' ? 'on' : ''}
                  title={t('settings.wizard.gpuTitle')}
                  onClick={() => void chooseMode('auto')}
                >
                  GPU
                </button>
                <button
                  type="button"
                  className={engineMode.mode === 'cpu' ? 'on' : ''}
                  title={t('settings.wizard.cpuTitle')}
                  onClick={() => void chooseMode('cpu')}
                >
                  CPU
                </button>
              </span>
            </div>
            <p className="wiz-desc">
              {engineMode.mode === 'cpu'
                ? engineMode.reason && engineMode.reason !== 'chosen in the model manager'
                  ? t('settings.wizard.gpuAutoOff', { reason: engineMode.reason })
                  : t('settings.wizard.cpuOnly')
                : t('settings.wizard.autoDescription')}
            </p>
          </div>
        )}
        {error && <p className="fine warn">{error}</p>}
        <div className="modal-actions">
          {error && (
            <button type="button" className="pill primary" onClick={() => void download()}>
              {t('settings.wizard.tryAgainButton')}
            </button>
          )}
          <button
            type="button"
            className="pill ghost"
            onClick={() => {
              // Skip closes the first-run wizard but lets a running download
              // finish in the background — a 525 MB pack died twice in the
              // field to an impatient Skip, and the splitter then "couldn't
              // download". Deliberately opened dialogs keep Close = cancel.
              if (setupWizardCloseAction(origin, busy) === 'cancel') {
                void window.singz.cancelModels()
              }
              onClose()
            }}
          >
            {origin === 'auto' && !requiredDone ? t('settings.wizard.skipButton') : t('settings.action.close')}
          </button>
        </div>
    </Modal>
  )
}
