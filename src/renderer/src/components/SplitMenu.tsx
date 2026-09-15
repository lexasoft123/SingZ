import { useEffect, useRef, useState } from 'react'
import type { SplitMode } from '../split-workflow'

export default function SplitMenu({ split, disabled, canResplit, canSplitBacking, onSplit }: {
  split: boolean
  disabled: boolean
  canResplit: boolean
  canSplitBacking: boolean
  onSplit: (mode: SplitMode) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [backing, setBacking] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('.split-menu input, .split-menu button:not(:disabled)')?.focus()
    const outside = (e: Event): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('keydown', escape, true)
    }
  }, [open])
  const start = (mode: SplitMode): void => { setOpen(false); onSplit(mode) }
  return <div className="split-control" ref={ref}>
    <button ref={button} type="button" className={`pill ${split ? 'ghost' : 'primary'}`}
      disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(v => !v)}>
      Split <span aria-hidden>▾</span>
    </button>
    {open && <div className="train-pop split-menu" role="dialog" aria-label="Split song">
      <div className="tp-head"><span className="tp-title">{split ? 'Split options' : 'Split song'}</span></div>
      {split ? <>
        <button type="button" className="split-menu-action" disabled={!canSplitBacking}
          onClick={() => start('vocals')}>Separate backing vocals</button>
        <button type="button" className="split-menu-action" disabled={!canResplit}
          onClick={() => start('stems')}>Re-split instrument stems</button>
        {!canSplitBacking && !canResplit && <p>These vocals are already separated.</p>}
      </> : <>
        <p>Create vocals, drums, bass, guitar, piano and instruments.</p>
        <label className="split-menu-option">
          <input type="checkbox" checked={backing} onChange={e => setBacking(e.target.checked)} />
          <span>Separate backing vocals</span>
        </label>
        <p className="split-menu-hint">{backing ? 'Two steps. Takes a few extra minutes; an additional model may be needed.' : 'Takes a few minutes. Models are downloaded once.'}</p>
        <button type="button" className="pill primary" onClick={() => start(backing ? 'stems-and-vocals' : 'stems')}>Split</button>
      </>}
    </div>}
  </div>
}
