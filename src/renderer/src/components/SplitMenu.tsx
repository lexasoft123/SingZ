import { useEffect, useRef, useState } from 'react'
import type { SplitMode } from '../split-workflow'
import { t } from '../i18n'

export default function SplitMenu({ split, disabled, canResplit, canSplitBacking, onSplit }: {
  split: boolean
  disabled: boolean
  canResplit: boolean
  canSplitBacking: boolean
  onSplit: (mode: SplitMode) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
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
  // A project split before backing vocals became part of every split still
  // has one combined vocal lane. The button says so rather than waiting to
  // be opened — this is the only route those projects have.
  const owesBacking = split && canSplitBacking
  return <div className="split-control" ref={ref}>
    <button ref={button} type="button"
      className={`pill ${owesBacking ? 'attention' : split ? 'ghost' : 'primary'}`}
      title={owesBacking ? t('player.split.backingHint') : undefined}
      disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(v => !v)}>
      {t('player.split.button')} <span aria-hidden>▾</span>
    </button>
    {open && <div className="train-pop split-menu" role="dialog" aria-label={t('player.split.title')}>
      <div className="tp-head"><span className="tp-title">{split ? t('player.split.optionsTitle') : t('player.split.title')}</span></div>
      {split ? <>
        <button type="button" className="split-menu-action" disabled={!canSplitBacking}
          onClick={() => start('vocals')}>{t('player.split.separateBacking')}</button>
        <button type="button" className="split-menu-action" disabled={!canResplit}
          onClick={() => start('stems')}>{t('player.split.resplitStems')}</button>
        {!canSplitBacking && !canResplit && <p>{t('player.split.alreadySeparated')}</p>}
      </> : <>
        <p>{t('player.split.explain')}</p>
        <p className="split-menu-hint">{t('player.split.hint')}</p>
        <button type="button" className="pill primary" onClick={() => start('stems-and-vocals')}>{t('player.split.button')}</button>
      </>}
    </div>}
  </div>
}
