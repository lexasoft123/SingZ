import { useState } from 'react'
import { Button } from '@singz/ui'
import type { BoxPlatformSnapshot, BoxState } from '../../../../shared/box-contract'
import type { DesktopAudioHostInventoryResult } from '../../../../shared/types'
import { audioCounts, audioReadyText, networkStateLabel } from './format'
import { tJourney, type JourneyKey } from './i18n'
import { setupStages, type SetupStage } from './model'
import { ErrorNotice, LoadingNotice, PageFrame } from './ui'
import type { DriveStatus } from './useInventory'
import type { JourneyLanguage } from './usePreferences'
import type { SafeAreaPercent } from './types'

const remoteKeys = [
  ['up', 'journey.setup.up'], ['down', 'journey.setup.down'], ['left', 'journey.setup.left'],
  ['right', 'journey.setup.right'], ['ok', 'journey.setup.ok']
] as const

export function SetupPage({ stage, box, platform, audio, drive, loading, error, finishing, onStage, onStep, onNetwork, onRetry, onAudio, onCollection, onSafeArea, onLanguage, onFinish, onBack }: {
  stage: SetupStage
  box: BoxState | null
  platform: BoxPlatformSnapshot | null
  audio: DesktopAudioHostInventoryResult | null
  drive: DriveStatus | null
  loading: boolean
  error: string | null
  finishing: boolean
  onStage: (stage: SetupStage) => void
  onStep: (delta: -1 | 1) => void
  onNetwork: () => void
  onRetry: () => void
  onAudio: () => void
  onCollection: () => void
  onSafeArea: (percent: SafeAreaPercent) => void
  onLanguage: (language: JourneyLanguage) => void
  onFinish: () => void
  onBack: () => void
}) {
  const [checked, setChecked] = useState<readonly string[]>([])
  const counts = audioCounts(audio)
  const stageIndex = setupStages.indexOf(stage)
  const selectedSafeArea = box?.preferences.safeAreaPercent ?? 0
  const selectedLanguage = box?.preferences.language ?? 'en'
  const firstUnchecked = remoteKeys.find(([id]) => !checked.includes(id))?.[0]
  const stageKey = `journey.setup.${stage}` as JourneyKey
  const retry = Boolean(error && stage === 'boot')

  return <PageFrame
    title={tJourney('journey.setup.title')}
    subtitle={tJourney('journey.setup.step', { step: stageIndex + 1, total: setupStages.length })}
    onBack={onBack}
  >
    <div className="setup-progress" aria-label={tJourney('journey.setup.title')}>
      {setupStages.map((item, index) => <button
        key={item}
        className={item === stage ? 'current' : index < stageIndex ? 'done' : ''}
        data-focus={`setup-stage-${item}`}
        onClick={() => onStage(item)}
      >{tJourney(`journey.setup.${item}` as JourneyKey)}</button>)}
    </div>
    <ErrorNotice error={error} />
    <LoadingNotice active={loading && !platform && !audio && stage === 'boot'} />
    <section className="setup-stage" data-setup-stage={stage}>
      <span className="journey-kicker">{tJourney(stageKey)}</span>
      {stage === 'boot' && <>
        <h2>{tJourney('journey.setup.bootTitle')}</h2>
        <p>{tJourney('journey.setup.bootBody')}</p>
        <div className="journey-status-block">
          <strong>{platform?.available ? tJourney('journey.setup.platformReady') : tJourney('journey.setup.platformMissing')}</strong>
          <span>{counts.outputs > 0 ? audioReadyText(counts) : tJourney('journey.setup.audioMissing')}</span>
        </div>
        <div className="journey-actions">
          {retry && <Button data-journey-primary variant="primary" onClick={onRetry}>{tJourney('journey.retry')}</Button>}
          <Button data-journey-primary={!retry || undefined} variant="primary" disabled={loading && !platform && !audio} onClick={() => onStep(1)}>
            {tJourney('journey.continue')}
          </Button>
        </div>
      </>}
      {stage === 'welcome' && <>
        <h2>{tJourney('journey.setup.welcomeTitle')}</h2><p>{tJourney('journey.setup.welcomeBody')}</p>
        <div className="setup-languages" role="group" aria-label={tJourney('journey.setup.language')}>
          {([['en', 'English'], ['ru', 'Русский'], ['zh-CN', '简体中文']] as const).map(([language, label]) =>
            <Button key={language} aria-pressed={selectedLanguage === language} disabled={loading} onClick={() => onLanguage(language)}>{label}</Button>)}
        </div>
        <div className="journey-actions"><Button data-journey-primary variant="primary" onClick={() => onStep(1)}>{tJourney('journey.continue')}</Button></div>
      </>}
      {stage === 'remote' && <>
        <h2>{tJourney('journey.setup.remoteTitle')}</h2><p>{tJourney('journey.setup.remoteBody')}</p>
        <div className="setup-remote-checks">
          {remoteKeys.map(([id, label]) => <Button
            key={id} data-journey-primary={firstUnchecked === id || undefined} data-remote-check={id}
            aria-pressed={checked.includes(id)} onClick={() => setChecked(current => current.includes(id) ? current : [...current, id])}
          >{tJourney(label)}{checked.includes(id) ? ` ✓ ${tJourney('journey.setup.checked')}` : ''}</Button>)}
        </div>
        <h3>{tJourney('journey.setup.safeArea')}</h3><p>{tJourney('journey.setup.safeAreaBody')}</p>
        <div className="journey-actions">
          {([0, 3, 5] as const).map(percent => <Button key={percent} aria-pressed={selectedSafeArea === percent} disabled={loading} onClick={() => onSafeArea(percent)}>
            {percent}%
          </Button>)}
          <Button disabled={loading || selectedSafeArea === 0} onClick={() => onSafeArea(0)}>{tJourney('journey.setup.restore')}</Button>
          <Button data-journey-primary={!firstUnchecked || undefined} variant="primary" onClick={() => onStep(1)}>{tJourney('journey.continue')}</Button>
        </div>
      </>}
      {stage === 'network' && <>
        <h2>{tJourney('journey.setup.networkTitle')}</h2><p>{tJourney('journey.setup.networkBody')}</p>
        <div className="journey-status-block"><strong>{platform ? networkStateLabel(platform.network.state) : tJourney('journey.unavailable')}</strong><span>{tJourney('journey.network.internet')}</span></div>
        <div className="journey-actions">
          <Button data-journey-primary variant="primary" onClick={onNetwork}>{tJourney('journey.home.network')}</Button>
          <Button onClick={() => onStep(1)}>{platform?.network.state === 'connected' ? tJourney('journey.continue') : tJourney('journey.continueOffline')}</Button>
        </div>
      </>}
      {stage === 'audio' && <>
        <h2>{tJourney('journey.setup.audioTitle')}</h2><p>{tJourney('journey.setup.audioBody')}</p>
        <div className="journey-status-block"><strong>{counts.outputs > 0 ? audioReadyText(counts) : tJourney('journey.setup.audioMissing')}</strong></div>
        <div className="journey-actions"><Button data-journey-primary variant="primary" onClick={onAudio}>{tJourney('journey.home.audio')}</Button><Button onClick={() => onStep(1)}>{tJourney('journey.continue')}</Button></div>
      </>}
      {stage === 'account' && <>
        <h2>{tJourney('journey.setup.accountTitle')}</h2><p>{tJourney('journey.setup.accountBody')}</p>
        <div className="journey-status-block"><strong>Google Drive · {drive ? tJourney(drive.signedIn ? 'journey.signedIn' : 'journey.signedOut') : tJourney('journey.unavailable')}</strong></div>
        <div className="journey-actions"><Button data-journey-primary variant="primary" onClick={onCollection}>{tJourney('journey.setup.connectDrive')}</Button><Button onClick={() => onStep(1)}>{tJourney('journey.setup.useLocal')}</Button></div>
      </>}
      {stage === 'done' && <>
        <h2>{tJourney('journey.setup.doneTitle')}</h2><p>{tJourney('journey.setup.doneBody')}</p>
        <div className="journey-actions"><Button data-journey-primary variant="primary" disabled={finishing || loading} onClick={onFinish}>
          {finishing ? tJourney('journey.setup.saving') : tJourney('journey.setup.finish')}
        </Button></div>
      </>}
    </section>
  </PageFrame>
}
