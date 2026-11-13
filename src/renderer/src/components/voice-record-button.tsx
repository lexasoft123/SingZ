import { canPressRecord, recordBlock, type VoiceController } from '../audio/voice-take'
import { t } from '../i18n'
import { blockText, clock } from './voice-format'
import { useVoiceModel } from './voice-host'
import { useVoiceStrings } from './voice-strings'
import Tooltip from './Tooltip'
import './voice-strip.css'

/** The transport's Record button (next to Play). The strip's live region owns announcements. */
export default function VoiceRecordButton({ controller }: { controller: VoiceController }): React.JSX.Element {
  useVoiceStrings()
  const m = useVoiceModel(controller)
  const rec = m.recording
  const block = recordBlock(m)
  const disabled = !canPressRecord(m)
  const label = rec ? t('player.voice.stop') : disabled ? blockText(block) || t('player.voice.record') : t('player.voice.record')
  return (
    <>
      <Tooltip label={label}>
        <button
          type="button"
          className={`vs-rec-t${rec ? ' recording' : ''}${m.armed ? ' armed' : ''}`}
          aria-pressed={rec}
          aria-label={label}
          aria-disabled={disabled}
          disabled={disabled}
          onClick={() => void controller.toggleRecord()}
        >
          <span className="vs-rec-core" aria-hidden="true" />
        </button>
      </Tooltip>
      {rec && (
        <span className="vs-rec-time" aria-hidden="true">
          {clock(m.elapsedSec)}
        </span>
      )}
    </>
  )
}
export { VoiceRecordButton }
