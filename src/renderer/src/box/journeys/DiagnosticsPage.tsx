import { Button } from '@singz/ui'
import type { BoxDiagnostics } from '../../../../shared/box-contract'
import { getLocale } from '../../../../shared/i18n/core'
import { summarizeAudio } from './format'
import { tJourney } from './i18n'
import { ErrorNotice, LoadingNotice, PageFrame } from './ui'

export function DiagnosticsPage({ diagnostics, loading, error, onRefresh, onAudio, onSetup, onBack }: {
  diagnostics: BoxDiagnostics | null
  loading: boolean
  error: string | null
  onRefresh: () => void
  onAudio: () => void
  onSetup: () => void
  onBack: () => void
}) {
  const audio = summarizeAudio(diagnostics?.audio)
  const booleanText = (value: boolean): string => tJourney(value ? 'journey.diagnostics.yes' : 'journey.diagnostics.no')
  return <PageFrame title={tJourney('journey.diagnostics.title')} subtitle={tJourney('journey.diagnostics.subtitle')} onBack={onBack}>
    <ErrorNotice error={error} /><LoadingNotice active={loading && !diagnostics} />
    <div className="journey-metrics">
      <div><span>{tJourney('journey.diagnostics.app')}</span><strong>{diagnostics?.appVersion ?? '—'}</strong></div>
      <div><span>{tJourney('journey.diagnostics.platform')}</span><strong>{diagnostics?.platform ?? '—'}</strong></div>
      <div><span>{tJourney('journey.diagnostics.arch')}</span><strong>{diagnostics?.arch ?? '—'}</strong></div>
    </div>
    <section className="journey-section">
      <h2>{tJourney('journey.diagnostics.audio')}</h2>
      {audio.detail === 'missing' && <p>{tJourney('journey.diagnostics.noAudio')}</p>}
      {audio.detail === 'redacted' && <p>{tJourney('journey.diagnostics.redacted')}</p>}
      {audio.ready !== null && <p>{tJourney('journey.diagnostics.ready', { value: booleanText(audio.ready) })}</p>}
      {audio.playing !== null && <p>{tJourney('journey.diagnostics.playing', { value: booleanText(audio.playing) })}</p>}
      <p className="journey-note">{tJourney('journey.diagnostics.safeAudio')}</p>
    </section>
    {diagnostics?.cec && <section className="journey-section" data-cec-status={diagnostics.cec.state}>
      <h2>{tJourney('journey.diagnostics.cec')}</h2>
      <p>{tJourney(`journey.diagnostics.cec.${diagnostics.cec.state}`)}</p>
      {diagnostics.cec.detail && <p>{diagnostics.cec.detail}</p>}
      <p>{tJourney('journey.diagnostics.cec.lastInput')}: {diagnostics.cec.lastInputAt === null ? '—' : new Date(diagnostics.cec.lastInputAt).toLocaleTimeString(getLocale())}</p>
    </section>}
    <p className="journey-note">{tJourney('journey.diagnostics.noResume')}</p>
    <div className="journey-actions">
      <Button data-journey-primary variant="primary" disabled={loading} onClick={onRefresh}>{tJourney('journey.refresh')}</Button>
      <Button onClick={onAudio}>{tJourney('journey.diagnostics.openAudio')}</Button>
      <Button onClick={onSetup}>{tJourney('journey.home.setup')}</Button>
    </div>
  </PageFrame>
}
