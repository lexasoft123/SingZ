import { melodyGrid, signedMelodyInterval } from '../../../shared/training-melody'
import type { TrainingPrompt } from '../../../shared/training-types'
import { t } from '../../../shared/i18n'

export function MelodyGrid({ prompt, activeTarget, matchedCount }: { prompt: TrainingPrompt; activeTarget: number; matchedCount: number }): React.JSX.Element {
  const grid = melodyGrid(prompt)
  const x = (v: number) => 48 + v * 500, y = (v: number) => 42 + v * 180
  return <figure style={{ margin: '8px 0', width: '100%', maxWidth: 480 }} aria-label={t('training.exercise.melody.label')}>
    <svg viewBox="0 0 568 250" role="img" style={{ width: '100%', overflow: 'visible' }}>
      {grid.rows.map(row => <g key={row.midi}><line x1="48" x2="548" y1={y(row.y)} y2={y(row.y)} stroke="currentColor" opacity={row.label ? .16 : .07} /><text x="40" y={y(row.y) + 4} textAnchor="end" fill="currentColor" opacity=".55" fontSize="11">{row.label}</text></g>)}
      {grid.notes.map((note, i) => {
        const prev = grid.notes[i-1]
        const dx = prev ? x(note.x) - x(prev.x) : 0, dy = prev ? y(note.y) - y(prev.y) : 0
        const length = Math.hypot(dx, dy)
        const inset = length > 0 ? Math.min(12 / length, .5) : 0
        return <g key={i}>
        <line x1={x(note.x)} x2={x(note.x)} y1="36" y2="230" stroke="currentColor" opacity=".07" strokeDasharray="3 5" />
        {prev && <><line x1={x(prev.x) + dx * inset} y1={y(prev.y) + dy * inset} x2={x(note.x) - dx * inset} y2={y(note.y) - dy * inset} stroke="#ffb12d" opacity=".3" strokeWidth="2" /><text x={x((note.x + grid.notes[i-1].x)/2)} y="20" textAnchor="middle" fill="currentColor" opacity=".65" fontSize="12">{signedMelodyInterval(note.interval!)}</text></>}
        {i === activeTarget && i >= matchedCount && <circle cx={x(note.x)} cy={y(note.y)} r="17" fill="none" stroke="#ffb12d" strokeWidth="2" />}
        <circle data-melody-note={i} data-matched={i < matchedCount} cx={x(note.x)} cy={y(note.y)} r="11" fill={i < matchedCount ? '#ffce45' : '#352c25'} stroke={i < matchedCount ? '#ffce45' : '#9e8d7c'} strokeWidth="2" />
        {i < matchedCount && <text x={x(note.x)} y={y(note.y)+4} textAnchor="middle" fontSize="12" fill="#241800">✓</text>}
        <text x={x(note.x)} y="247" textAnchor="middle" fill="currentColor" opacity=".5" fontSize="11">{i+1}</text>
      </g>})}
    </svg><figcaption style={{ fontSize: 12, opacity: .6 }}>{t('training.melody.gridCaption')}</figcaption>
  </figure>
}

export function MelodyLengthSelector({ value, onChange }: { value: 3 | 5 | 7; onChange: (value: 3 | 5 | 7) => void }): React.JSX.Element {
  return <fieldset className="vt-fieldset"><legend>{t('training.melody.length')}</legend><div className="vt-segment">{([3,5,7] as const).map(n => <button type="button" key={n} aria-pressed={value === n} className={value === n ? 'active' : ''} onClick={() => onChange(n)}>{n}</button>)}</div><p>{t('training.melody.help')}</p></fieldset>
}
