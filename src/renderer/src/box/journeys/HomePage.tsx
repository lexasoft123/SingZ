import type { BoxPhoneState, BoxPlatformSnapshot, BoxStorageSnapshot } from '../../../../shared/box-contract'
import { type JourneyAudioInventory, audioCounts, audioReadyText, formatBytes, phonesStatus, networkStateLabel, updateStateLabel } from './format'
import { tJourney } from './i18n'
import type { DriveStatus } from './useInventory'
import { ErrorNotice, LoadingNotice, PageFrame, SettingRow } from './ui'
import type { JourneyPage } from './types'

export function HomePage({ audio, platform, drive, phones, storage, loading, error, onBack, onOpen, onOpenAudio, onOpenCollection }: {
  audio: JourneyAudioInventory | null
  platform: BoxPlatformSnapshot | null
  drive: DriveStatus | null
  phones: BoxPhoneState | null
  storage: BoxStorageSnapshot | null
  loading: boolean
  error: string | null
  onBack: () => void
  onOpen: (page: JourneyPage) => void
  onOpenAudio: () => void
  onOpenCollection: () => void
}) {
  const counts = audioCounts(audio)
  return <PageFrame title={tJourney('journey.settings')} subtitle={tJourney('journey.subtitle')} onBack={onBack}>
    <ErrorNotice error={error} />
    <LoadingNotice active={loading && !platform && !audio} />
    <div className="journey-list">
      <SettingRow
        primary focus="journey-audio" title={tJourney('journey.home.audio')} help={tJourney('journey.home.audioHelp')}
        status={audio?.ok && audio.physicalInputCount !== null ? audioReadyText(counts) : tJourney('journey.unavailable')}
        onOpen={onOpenAudio}
      />
      <SettingRow
        focus="journey-network" title={tJourney('journey.home.network')} help={tJourney('journey.home.networkHelp')}
        status={platform ? networkStateLabel(platform.network.state) : tJourney('journey.unavailable')}
        onOpen={() => onOpen('network')}
      />
      <SettingRow
        focus="journey-collection" title={tJourney('journey.home.collection')} help={tJourney('journey.home.collectionHelp')}
        status={drive ? tJourney(drive.signedIn ? 'journey.signedIn' : 'journey.signedOut') : tJourney('journey.unavailable')}
        onOpen={onOpenCollection}
      />
      <SettingRow
        focus="journey-phones" title={tJourney('journey.home.phones')} help={tJourney('journey.home.phonesHelp')}
        status={phones ? phonesStatus(phones.sessions.length) : tJourney('journey.unavailable')}
        onOpen={() => onOpen('phones')}
      />
      <SettingRow
        focus="journey-storage" title={tJourney('journey.home.storage')} help={tJourney('journey.home.storageHelp')}
        status={storage ? (storage.cacheBytes > 0 ? formatBytes(storage.cacheBytes) : tJourney('journey.storage.none')) : tJourney('journey.unavailable')}
        onOpen={() => onOpen('storage')}
      />
      <SettingRow
        focus="journey-diagnostics" title={tJourney('journey.home.diagnostics')} help={tJourney('journey.home.diagnosticsHelp')}
        onOpen={() => onOpen('diagnostics')}
      />
      <SettingRow
        focus="journey-system" title={tJourney('journey.home.system')} help={tJourney('journey.home.systemHelp')}
        status={platform ? updateStateLabel(platform.update.state) : tJourney('journey.unavailable')}
        onOpen={() => onOpen('system')}
      />
      <SettingRow
        focus="journey-privacy" title={tJourney('journey.home.privacy')} help={tJourney('journey.home.privacyHelp')}
        status={tJourney('journey.manage')} onOpen={() => onOpen('privacy')}
      />
      <SettingRow
        focus="journey-setup" title={tJourney('journey.home.setup')} help={tJourney('journey.home.setupHelp')}
        status={tJourney('journey.open')} onOpen={() => onOpen('setup')}
      />
    </div>
  </PageFrame>
}
