import { TRACK_META } from '../model'

const BAR_COLORS = [
  TRACK_META.vocals.color,
  TRACK_META.drums.color,
  TRACK_META.bass.color,
  TRACK_META.other.color
]

// Deterministic pseudo-random bars so renders are stable.
const BARS = Array.from({ length: 56 }, (_, i) => ({
  h: 16 + Math.abs(Math.sin(i * 1.7 + 0.4)) * 78,
  d: (i * 0.137) % 1.4,
  c: BAR_COLORS[i % 4]
}))

interface Props {
  loading: boolean
  songName?: string
  onBrowse: () => void
}

export default function DropScreen({ loading, songName, onBrowse }: Props): React.JSX.Element {
  return (
    <div className={`drop-screen${loading ? ' loading' : ''}`}>
      <div className="drop-inner">
        <div className="eq" aria-hidden>
          {BARS.map((b, i) => (
            <span
              key={i}
              style={{
                height: `${b.h}px`,
                animationDelay: `${b.d}s`,
                background: b.c,
                ['--c' as string]: b.c
              }}
            />
          ))}
        </div>
        {loading ? (
          <>
            <h1>Reading {songName ? `“${songName}”` : 'song'}…</h1>
            <p>Decoding audio and drawing the timeline.</p>
          </>
        ) : (
          <>
            <h1>Drop a song.</h1>
            <p>
              MP3, WAV, FLAC or M4A — SingZ splits it into vocals, drums, bass &amp; instruments
              you can mute while you sing.
            </p>
            <button type="button" className="pill ghost browse" onClick={onBrowse}>
              Browse files…
            </button>
            <span className="drop-hint">or drag it anywhere into this window</span>
          </>
        )}
      </div>
    </div>
  )
}
