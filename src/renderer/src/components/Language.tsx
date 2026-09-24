import { useEffect, useSyncExternalStore } from 'react'
import { LanguageSwitcher } from '@singz/ui'
import type { LocaleState } from '../../../shared/types'
import { LOCALES, loadLocale, setLocale, t, type Key, type Language as Lang } from '../i18n'
import { FLAGS } from './Flags'

/*
 * What main says about the language — the saved choice and what `system`
 * resolves to — held once for every switcher on screen, so the title bar's
 * flag and the Settings row can never disagree.
 */
let state: LocaleState | null = null
const listeners = new Set<() => void>()
let publishSeq = 0
const publish = async (next: LocaleState): Promise<void> => {
  // The strings first, then the switch — never a frame of half-translated UI.
  // Two quick picks: only the latest may land, whichever chunk arrives first.
  const seq = ++publishSeq
  await loadLocale(next.locale).catch(() => {})
  if (seq !== publishSeq) return
  state = next
  setLocale(next.locale)
  for (const fn of listeners) fn()
}
const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * The app's language switcher: the kit's control fed with this app's
 * languages, flags and words. `compact` is the flag alone, for the title bar —
 * the one control someone who cannot read the window needs to find, on every
 * screen, without opening a dialog whose title they cannot read either.
 */
export function Language({ compact = false }: { compact?: boolean }): React.JSX.Element | null {
  const s = useSyncExternalStore(subscribe, () => state)
  useEffect(() => {
    if (!state) void window.singz.getLocale().then(publish).catch(() => {})
  }, [])
  if (!s) return null

  const os = document.body.classList.contains('win') ? 'Windows' : 'macOS'
  // Each language by its own name, with its name in THIS language underneath
  // when the two differ — "English / Английский" on a Russian screen, and no
  // redundant "English / English" on an English one.
  const options = LOCALES.map((l) => {
    const named = t(`lang.${l.value}` as Key)
    return { value: l.value, label: l.label, code: l.code, flag: FLAGS[l.value], hint: named !== l.label ? named : undefined }
  })
  const systemName = LOCALES.find((l) => l.value === s.systemLocale)?.label ?? ''
  return (
    <LanguageSwitcher
      className="no-drag"
      options={options}
      value={s.language}
      onChange={(language) => {
        void window.singz.setLanguage(language as Lang).then(publish)
      }}
      system={{
        label: t('lang.system'),
        hint: t('lang.systemHint', { os, name: systemName }),
        resolves: s.systemLocale,
        badge: t('lang.auto')
      }}
      compact={compact}
      aria-label={t('lang.label')}
    />
  )
}
