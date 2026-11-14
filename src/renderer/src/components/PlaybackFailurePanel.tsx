import { useEffect, useRef, useState } from 'react'
import type { EnginePlaybackError } from '../audio/engine'
import { nativePlaybackFailureCopy } from '../audio/native-playback-failure'
import Tooltip from './Tooltip'
import { t } from '../i18n'
import { stemLabel } from '../model'
import './playback-failure.css'

/** Blocks transport, while lyrics and editing remain available on desktop. */
export default function PlaybackFailurePanel({ error, onRetry, onChooseDevice, laneName, fullscreen = false }: {
  error: EnginePlaybackError
  onRetry: () => Promise<unknown>
  onChooseDevice: () => void
  fullscreen?: boolean
  laneName?: string
}): React.JSX.Element {
  const [retrying, setRetrying] = useState(false)
  const [copied, setCopied] = useState(false)
  const retry = useRef<HTMLButtonElement>(null)
  const mounted = useRef(false)
  const retryRequested = useRef(false)
  const shouldFocus = fullscreen || error.userInitiated === true
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    if (!retrying && (shouldFocus || retryRequested.current)) {
      retry.current?.focus()
      retryRequested.current = false
    }
  }, [retrying, shouldFocus])
  const failure = error.failure ?? { code: 'prepare-failed' as const, detail: error.message }
  const runRetry = async (): Promise<void> => {
    if (retrying) return
    retryRequested.current = true
    setRetrying(true)
    try { await onRetry() } catch { /* Engine retains the current blocking reason. */ }
    finally { if (mounted.current) setRetrying(false) }
  }
  return <section className={`playback-failure${fullscreen ? ' playback-failure-fullscreen' : ''}`}
    data-surface="playback-failure" role="alertdialog" aria-modal={fullscreen || undefined} aria-labelledby="playback-failure-title"
    aria-describedby="playback-failure-reason" aria-live="assertive" aria-atomic="true" data-failure-code={failure.code}
    onKeyDown={event => {
      if (!fullscreen || event.key !== 'Tab') return
      const targets = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), summary'))
      const first = targets[0], last = targets[targets.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
    <div className="playback-failure-copy">
      <h2 id="playback-failure-title">{t('player.failure.title')}</h2>
      <p id="playback-failure-reason">{nativePlaybackFailureCopy(failure)}</p>
      {failure.laneId && <p>{t('player.failure.lane', { lane: laneName ?? stemLabel(failure.laneId) ?? failure.laneId, format: failure.format ?? '—' })}</p>}
      <details><summary>{t('player.failure.details')}</summary><pre>{failure.code}{'\n'}{failure.detail}</pre></details>
    </div>
    <div className="playback-failure-actions">
      <Tooltip label={t('player.failure.retryHelp')}>
        <button ref={retry} type="button" className="pill primary" disabled={retrying} aria-busy={retrying}
          data-control="playback-retry" onClick={() => { void runRetry() }}>{t(retrying ? 'player.failure.retrying' : 'player.failure.retry')}</button>
      </Tooltip>
      <Tooltip label={t('player.failure.chooseHelp')}>
        <button type="button" className="pill ghost" disabled={retrying} data-control="playback-device"
          onClick={onChooseDevice}>{t('player.failure.choose')}</button>
      </Tooltip>
      <Tooltip label={t('player.failure.copy')}>
        <button type="button" className="pill ghost" onClick={() => {
          void navigator.clipboard.writeText(`${failure.code}\n${failure.detail}`).then(() => {
            if (mounted.current) setCopied(true)
          }).catch(() => { if (mounted.current) setCopied(false) })
        }}>{t(copied ? 'player.failure.copied' : 'player.failure.copy')}</button>
      </Tooltip>
    </div>
  </section>
}
