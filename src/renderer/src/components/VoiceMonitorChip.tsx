import { useState } from 'react'
import type { MultitrackEngine } from '../audio/engine'
import type { VoiceModel } from '../audio/voice-take'
import { t } from '../i18n'
import { createVoiceController } from './voice-bootstrap'
import { useVoiceModel } from './voice-host'
import { useVoiceStrings } from './voice-strings'
import Tooltip from './Tooltip'
import './voice-strip.css'

/**
 * App-level monitoring indicator: a monitor left on keeps running in the main process after the Voice strip
 * is gone (library view). While it is on and no strip is mounted this chip shows it and stops it on click.
 * Same controller as the strip (one per engine), so both always agree.
 */
export function MonitorChipView({ m, onStop }: { m: VoiceModel; onStop: () => void }): React.JSX.Element | null {
  if (!m.monitor.on || m.stripMounted) return null
  const label = t('player.voice.monitorChip')
  return (
    <Tooltip label={label}>
      <button type="button" className="vs-mon-chip" aria-label={label} onClick={onStop}>
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M2 6h2.6L8 3v10L4.6 10H2z" fill="currentColor" />
          <path d="M10.4 5.8a3.2 3.2 0 0 1 0 4.4M12.2 4a5.6 5.6 0 0 1 0 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {m.monitor.latency && <span>{t('player.voice.monitorBadge', { ms: Math.round(m.monitor.latency.roundTripMs) })}</span>}
      </button>
    </Tooltip>
  )
}

export default function VoiceMonitorChip({ engine }: { engine: MultitrackEngine }): React.JSX.Element | null {
  useVoiceStrings()
  const [controller] = useState(() => createVoiceController(engine))
  const m = useVoiceModel(controller)
  return <MonitorChipView m={m} onStop={() => void controller.releaseMonitor()} />
}
