import { t } from './i18n'
import { tMicrophone } from './settings-i18n'
import { microphoneMeterFill, microphoneMeterState, microphoneMeterStateKey, type MicrophoneSlotStatus } from './microphones'

/** Large level bar plus a plain word. The bar is scaled with a transform only, so a level update never re-lays-out the player. */
export function MicrophoneMeter({ status, channel, meterId }: { status: MicrophoneSlotStatus; channel: number; meterId?: string }): React.JSX.Element {
  const state = microphoneMeterState(status)
  const level = status.kind === 'level' ? status.level : null
  return <span className="mic-meter" data-mic-state={state} data-mic-status={status.kind}>
    {level === null
      ? <span className="mic-meter-bar" aria-hidden="true" />
      : <span className="mic-meter-bar" data-mix-meter={meterId} role="meter"
        aria-label={tMicrophone('box.microphones.channelLevel', { channel: channel + 1 })}
        aria-valuemin={0} aria-valuemax={1} aria-valuenow={Math.min(1, level)}
        aria-valuetext={level > 1 ? tMicrophone('box.microphones.clipping') : tMicrophone('box.microphones.percent', { value: Math.round(level * 100) })}>
        <span style={{ transform: `scaleX(${microphoneMeterFill(level)})` }} />
      </span>}
    <b className="mic-meter-state">{t(microphoneMeterStateKey(state))}</b>
  </span>
}
