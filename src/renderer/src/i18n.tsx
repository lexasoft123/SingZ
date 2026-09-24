import { Fragment, useSyncExternalStore, type ReactNode } from 'react'
import { getLocale, subscribeLocale, t, type Locale } from '../../shared/i18n'

export { t, tn, LOCALES, getLocale, setLocale, loadLocale } from '../../shared/i18n'
export type { Key, Locale, Language, PluralKey } from '../../shared/i18n'

/**
 * The locale in use, as React state: a component that calls this re-renders
 * when the singer switches language. App calls it, so every child it renders
 * follows; a memoized child that would otherwise skip the render calls it too.
 * Switching never remounts anything — the song stays loaded and playing.
 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale)
}

/**
 * The strings' only markup, turned into elements: `**bold**` → <strong> (the
 * element the copy used before it moved into dictionaries — CSS targets it),
 * with `strongClass` when the bold spans need one. Anything else is text.
 * Kept this small on purpose — a translator never writes JSX, and a string
 * with an unbalanced marker still renders, marker showing.
 */
export function rich(text: string, strongClass?: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  if (parts.length === 1) return text
  return parts.map((p, i) =>
    p.startsWith('**') && p.endsWith('**')
      ? <strong key={i} className={strongClass}>{p.slice(2, -2)}</strong>
      : <Fragment key={i}>{p}</Fragment>
  )
}

/** `<T k="…" />` — t() with the markup rendered. */
export function T({ k, vars, strongClass }: {
  k: Parameters<typeof t>[0]
  vars?: Parameters<typeof t>[1]
  strongClass?: string
}): React.JSX.Element {
  return <>{rich(t(k, vars), strongClass)}</>
}

/**
 * The locale to format dates and numbers with: the chosen language — except
 * English, which keeps the machine's own conventions (an en-GB or Russian
 * system reads 26 Jul, not Jul 26), exactly as before localization.
 */
export function formatLocale(): string | undefined {
  const l = getLocale()
  return l === 'en' ? undefined : l
}
