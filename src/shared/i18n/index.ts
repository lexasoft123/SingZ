/*
 * SingZ's strings, in both processes.
 *
 * The main process resolves the locale from the saved preference (or the
 * system) and translates what it originates — dialog titles, the errors that
 * end up on screen. The renderer asks main for the same answer at startup and
 * whenever the singer changes it, and translates everything else. Both are
 * this one module; each process holds its own copy.
 *
 * No library: `t` is a lookup plus `{name}` interpolation, and every
 * translation is typed against English (see `Translation`), so a missing
 * string is a compile error rather than an English line on a Russian screen.
 */
import { en } from './en'
import { register } from './core'
import type { Locale } from './rules'

export {
  fromTag,
  isLanguage,
  resolveLocale,
  LOCALE_VALUES,
  type Language,
  type Locale,
  type Vars
} from './rules'
export { t, tn, setLocale, getLocale, subscribeLocale, type Key, type PluralKey } from './core'

// English is the source and every fallback, so it is always here. The others
// load on demand: the renderer's entry chunk has a size budget
// (scripts/check-renderer-split.mjs), and a singer reads one language.
register('en', en)

const loaded = new Map<Locale, Promise<void>>([['en', Promise.resolve()]])

/** Fetch a language's strings once; resolve when `t` can speak it. */
export function loadLocale(l: Locale): Promise<void> {
  let p = loaded.get(l)
  if (!p) {
    p = (l === 'ru'
      ? import('./ru').then((m) => register('ru', m.ru))
      : import('./zh-CN').then((m) => register('zh-CN', m.zhCN))
    ).catch((err: unknown) => {
      loaded.delete(l)
      throw err
    })
    loaded.set(l, p)
  }
  return p
}

/** Each language by its OWN name — the reader who needs this list is the one
 *  who cannot read the current language. */
export const LOCALES: { value: Locale; label: string; code: string }[] = [
  { value: 'en', label: 'English', code: 'EN' },
  { value: 'ru', label: 'Русский', code: 'RU' },
  { value: 'zh-CN', label: '简体中文', code: 'ZH' }
]
