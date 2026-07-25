import type { UITrack } from '../model'
import Waveform from './Waveform'

interface Props {
  track: UITrack
  dimmed: boolean
  onMute: (id: string, muted: boolean) => void
  onSolo: (id: string, solo: boolean) => void
  onVolume: (id: string, volume: number) => void
  showSolo: boolean
  index: number
  viewStart: number
  viewEnd: number
}

export default function TrackLane({
  track,
  dimmed,
  onMute,
  onSolo,
  onVolume,
  showSolo,
  index,
  viewStart,
  viewEnd
}: Props): React.JSX.Element {
  const off = track.muted || dimmed
  // Explicit grid rows: the scrub overlay is definitely-placed and would
  // otherwise push auto-placed lanes into implicit rows below it.
  const row = index + 2
  return (
    <>
      <div
        className={`lane-controls${off ? ' is-off' : ''}`}
        style={{ gridRow: row, ['--stem' as string]: track.color, ['--i' as string]: index }}
      >
        <div className="lane-title">
          <span className="lane-dot" />
          <span className="lane-name">{track.label}</span>
        </div>
        <div className="lane-buttons">
          <button
            type="button"
            className={`chip mute${track.muted ? ' active' : ''}`}
            aria-pressed={track.muted}
            title={track.muted ? 'Unmute' : 'Mute'}
            onClick={() => onMute(track.id, !track.muted)}
          >
            M
          </button>
          {showSolo && (
            <button
              type="button"
              className={`chip solo${track.solo ? ' active' : ''}`}
              aria-pressed={track.solo}
              title={track.solo ? 'Unsolo' : 'Solo'}
              onClick={() => onSolo(track.id, !track.solo)}
            >
              S
            </button>
          )}
          <input
            className="vol"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={track.volume}
            title="Volume"
            onChange={(e) => onVolume(track.id, Number(e.target.value))}
          />
        </div>
      </div>
      <div
        className={`lane-wave${off ? ' is-off' : ''}`}
        style={{ gridRow: row, ['--i' as string]: index }}
      >
        <Waveform
          peaks={track.peaks}
          buffer={track.buffer}
          scale={track.scale}
          color={track.color}
          viewStart={viewStart}
          viewEnd={viewEnd}
        />
      </div>
    </>
  )
}
