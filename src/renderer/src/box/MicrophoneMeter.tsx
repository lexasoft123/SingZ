import { useEffect, useRef } from 'react'
import { PeakMeter, type PeakMeterHandle } from '@singz/ui'
import { useMeterVisibility } from '../meter-visibility'
import { t } from './i18n'
import { microphoneLevelDb, microphoneMeterStateKey, microphoneSlotLevel, useMicrophoneSlotState, type BoxMicrophones, type MicrophoneSnapshot } from './microphones'

/** Mixer rows: full 40-brick meter at the kit's 16 px height. */
export const MIXER_METER_SIZE = 1
/** Player bar: the 16-brick mini meter scaled to the same 16 px the old bar had. */
export const PLAYER_METER_SIZE = 1.8

/** The kit PeakMeter plus a plain word. Readings reach the meter through
 * `PeakMeterHandle.push` from the store subscription, so a reading never renders
 * React; only a change of the word (Singing, Quiet, Off) does. */
export function MicrophoneMeter({ source, snapshot, slot, meterId, mini = false, visible = true }: {
  source?: BoxMicrophones; snapshot?: MicrophoneSnapshot; slot: number; meterId?: string; mini?: boolean; visible?: boolean
}): React.JSX.Element {
  const showing = useMeterVisibility(visible)
  const state = useMicrophoneSlotState(source, snapshot, slot, showing)
  const live = state === 'singing' || state === 'quiet' || state === 'loud'
  const meter = useRef<PeakMeterHandle>(null)
  useEffect(() => {
    if (!source || snapshot || !live || !showing) return
    const feed = (): void => {
      const level = microphoneSlotLevel(source.getSnapshot(), slot)
      // Peak drives both the live bar and the held marker, as on the phone.
      const db = level === null ? Number.NEGATIVE_INFINITY : microphoneLevelDb(level)
      meter.current?.push(db, db)
    }
    feed()
    return source.subscribe(feed)
  }, [source, snapshot, slot, live, showing])
  const level = snapshot ? microphoneSlotLevel(snapshot, slot) : null
  const staticDb = level === null ? Number.NEGATIVE_INFINITY : microphoneLevelDb(level)
  return <span className="mic-meter" data-mic-state={state} data-mic-status={live ? 'level' : state}
    data-mic-db={snapshot && live ? (Number.isFinite(staticDb) ? staticDb.toFixed(1) : '-inf') : undefined}>
    <span className="mic-meter-bar" data-mix-meter={live ? meterId : undefined} aria-hidden="true">
      <PeakMeter ref={meter} db={staticDb} enabled={live && showing} mini={mini} clipped={state === 'loud'} size={mini ? PLAYER_METER_SIZE : MIXER_METER_SIZE} />
    </span>
    <b className="mic-meter-state">{t(microphoneMeterStateKey(state))}</b>
  </span>
}
