import { Button } from '@singz/ui'
import { Icon } from '@singz/ui/icons'
import { t } from './i18n'
import { parseSongName } from './song-identity'
import { signedSemitones, stepTranspose, TRANSPOSE_MAX, TRANSPOSE_MIN } from './key-change'
import { bpmText, durationText, keyText, rangeText } from './metadata'
import type { BoxProjectInspection, BoxProjectMetadata } from './project'
import type { CollectionDownloadState, CollectionEntry } from './collection/types'

export function SongDetails({
  entry,
  inspection,
  metadata,
  transpose,
  queued,
  busy,
  error,
  actionError,
  download,
  onBack,
  onSing,
  onPrepare,
  onVerify,
  onCancelDownload,
  onToggleQueue,
  onTranspose
}: {
  entry: CollectionEntry
  inspection?: BoxProjectInspection
  metadata?: BoxProjectMetadata
  transpose: number
  queued: boolean
  busy: boolean
  error: string | null
  actionError: string | null
  download: CollectionDownloadState | null
  onBack: () => void
  onSing: () => void
  onPrepare: () => void
  onVerify: () => void
  onCancelDownload: () => void
  onToggleQueue: () => void
  /** Absolute semitone offset; the caller applies and saves it. */
  onTranspose: (semitones: number) => void
}): React.JSX.Element {
  const readiness = inspection?.readiness
  const identity = parseSongName(entry.name)
  const ready = entry.local !== null && readiness === 'ready'
  const downloading = download !== null
  const keyEditable = ready && !busy && !downloading
  const title = downloading ? t('box.details.downloading')
    : entry.unavailable ? t('box.state.unavailable')
      : !entry.local ? t('box.details.downloadRequired')
      : !inspection ? t('box.details.checking')
        : ready ? t('box.details.ready')
          : readiness === 'needs-lyrics' ? t('box.details.lyricsRequired')
            : readiness === 'unprepared' ? t('box.details.unprepared')
              : readiness === 'damaged' ? t('box.details.damaged')
                : readiness === 'unsupported' ? t('box.details.unsupported')
                  : t('box.details.error')
  const copy = downloading ? t('box.details.downloadingBody')
    : !entry.local ? entry.unavailable ? t('box.details.unavailableBody') : t('box.details.downloadRequiredBody')
      : !inspection ? t('box.details.checkingBody')
        : ready ? t('box.details.readyBody')
          : readiness === 'needs-lyrics' ? t('box.details.lyricsRequiredBody')
            : readiness === 'unprepared' ? t('box.details.unpreparedBody')
              : readiness === 'damaged' ? t('box.details.damagedFiles', { files: inspection?.message ?? '—' })
                : readiness === 'unsupported' ? t('box.details.unsupportedBody')
                  : inspection?.message ?? t('box.details.errorBody')
  return <main className="box-details" data-surface="details" data-collection-id={entry.id} aria-label={t('box.details.label')}>
    <div className="detail-back"><Button data-focus="details-back" onClick={onBack}>← {t('box.navigation.catalog')}</Button></div>
    <div className="detail-identity"><p aria-label={identity.artist ? undefined : t('box.metadata.artistUnknown')}>{identity.artist ?? '—'}</p><h1>{identity.title}</h1></div>
    <dl className="detail-metadata">
      <div><dt>{t('box.details.originalKey')}</dt><dd aria-label={metadata?.key ? undefined : t('box.metadata.keyUnknown')}>{metadata ? keyText(metadata) : '—'}</dd></div>
      <div><dt>{t('box.details.tempo')}</dt><dd aria-label={metadata?.bpm ? undefined : t('box.metadata.tempoUnknown')}>{metadata ? bpmText(metadata) : '—'}{metadata?.bpm ? <small>{t('box.metadata.bpm')}</small> : null}</dd></div>
      <div><dt>{t('box.details.range')} <small>{t('box.details.rangeNote')}</small></dt><dd aria-label={metadata?.range ? undefined : t('box.metadata.rangeUnknown')}>{metadata ? rangeText(metadata) : '—'}</dd></div>
      <div><dt>{t('box.details.duration')}</dt><dd aria-label={metadata?.duration ? undefined : t('box.metadata.durationUnknown')}>{metadata ? durationText(metadata) : '—'}</dd></div>
    </dl>
    <div className="detail-body">
      <section className="detail-readiness" aria-label={t('box.details.readiness')}>
        <h2><span className={`detail-status-dot ${ready ? 'ready' : ''}`} />{title}</h2>
        <p>{copy}</p>
        {(actionError ?? error) && <p className="box-error" role="alert">{actionError ?? error}</p>}
        {downloading && <p className="box-download-progress" role="status" aria-busy="true"><span className="box-indeterminate" />{download.msg || t('box.details.downloadWaiting')}</p>}
        <div className="detail-files">
          <span>{ready ? `✓ ${t('box.details.stemsSaved', { count: Object.keys(inspection?.project?.stems ?? {}).length })}` : `! ${t('box.details.stemsNotReady')}`}</span>
          <span>{ready && inspection?.project?.hasLyrics ? `✓ ${t('box.details.lyricsSaved')}` : `— ${t('box.details.lyricsMissing')}`}</span>
        </div>
        {inspection?.project?.sourceMissing && <p>{t('box.details.sourceMissing')}</p>}
      </section>
      <section className="detail-key" aria-label={t('box.details.playbackKey')}>
        <div className="detail-key-heading"><h2>{t('box.details.playbackKey')}</h2><span>{metadata ? keyText(metadata, transpose) : '—'}</span></div>
        <div className="detail-key-controls">
          <Button data-key-down aria-label={t('box.details.keyLower')} disabled={!keyEditable || transpose <= TRANSPOSE_MIN} onClick={() => onTranspose(stepTranspose(transpose, -1))}>−</Button>
          <span className="detail-key-offset" data-key-offset={transpose} aria-live="polite">{transpose === 0 ? t('box.details.keyOriginal') : t('box.details.keyOffset', { offset: signedSemitones(transpose) })}</span>
          <Button data-key-up aria-label={t('box.details.keyHigher')} disabled={!keyEditable || transpose >= TRANSPOSE_MAX} onClick={() => onTranspose(stepTranspose(transpose, 1))}>+</Button>
        </div>
        <p>{t('box.details.keySaved')}</p>
        <p>{t('box.details.noPreparation')}</p>
      </section>
    </div>
    <div className="detail-actions">
      {downloading ? <Button variant="primary" data-detail-primary onClick={onCancelDownload} disabled={download.phase === 'cancelling'}>
        {download.phase === 'cancelling' ? t('box.details.cancellingDownload') : t('box.details.cancelDownload')}
      </Button> : !entry.local && entry.remoteId && !entry.unavailable ? <Button variant="primary" data-detail-primary disabled={busy} onClick={onPrepare}>
        <Icon name="progress" size={20} />{t('box.details.downloadPrepare')}
      </Button> : ready ? <Button variant="primary" data-detail-primary disabled={busy} onClick={onSing}>
        <Icon name="play" size={20} />{busy ? t('box.details.opening') : t('box.details.sing')}
      </Button> : entry.local && (readiness === 'needs-lyrics' || readiness === 'error') ? <Button variant="primary" data-detail-primary disabled={busy} onClick={onVerify}>
        {t('box.details.verifyCached')}
      </Button> : <Button variant="primary" data-detail-primary disabled>{t('box.details.sing')}</Button>}
      <Button disabled={busy} onClick={onToggleQueue}>{queued ? t('box.queue.remove') : t('box.queue.add')}</Button>
      <span aria-live="polite">{ready ? t('box.details.opensPaused') : t('box.details.returnHint')}</span>
    </div>
    <footer className="box-footer"><div><span className="box-key">↑ ↓ ← →</span>{t('box.hints.move')}<span className="box-key">OK</span>{t('box.hints.select')}<span className="box-key">Back</span>{t('box.navigation.catalog')}</div></footer>
  </main>
}
