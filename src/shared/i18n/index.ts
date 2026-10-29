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
    const loaders: Record<Exclude<Locale, 'en'>, () => Promise<void>> = {
      'es-419': () => import('./es-419').then((m) => register('es-419', m.es419)),
      'pt-BR': () => import('./pt-BR').then((m) => register('pt-BR', m.ptBR)),
      'tr': () => import('./tr').then((m) => register('tr', m.tr)),
      'ru': () => import('./ru').then((m) => register('ru', m.ru)),
      'zh-CN': () => import('./zh-CN').then((m) => register('zh-CN', m.zhCN)),
      'hi': () => import('./hi').then((m) => register('hi', m.hi)),
      'ja': () => import('./ja').then((m) => register('ja', m.ja)),
      'ko': () => import('./ko').then((m) => register('ko', m.ko)),
      'th': () => import('./th').then((m) => register('th', m.th)),
      'id': () => import('./id').then((m) => register('id', m.id)),
      'vi': () => import('./vi').then((m) => register('vi', m.vi)),
      'fil': () => import('./fil').then((m) => register('fil', m.fil)),
      'ms': () => import('./ms').then((m) => register('ms', m.ms)),
      'zh-TW': () => import('./zh-TW').then((m) => register('zh-TW', m.zhTW)),
    }
    p = (l === 'en' ? Promise.resolve() : loaders[l]()).catch((err: unknown) => {
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
  { value: 'es-419', label: 'Español (Latinoamérica)', code: 'ES' },
  { value: 'pt-BR', label: 'Português (Brasil)', code: 'PT' },
  { value: 'tr', label: 'Türkçe', code: 'TR' },
  { value: 'ru', label: 'Русский', code: 'RU' },
  { value: 'zh-CN', label: '简体中文', code: 'ZH' },
  { value: 'hi', label: 'हिन्दी', code: 'HI' },
  { value: 'ja', label: '日本語', code: 'JA' },
  { value: 'ko', label: '한국어', code: 'KO' },
  { value: 'th', label: 'ไทย', code: 'TH' },
  { value: 'id', label: 'Bahasa Indonesia', code: 'ID' },
  { value: 'vi', label: 'Tiếng Việt', code: 'VI' },
  { value: 'fil', label: 'Filipino', code: 'FIL' },
  { value: 'ms', label: 'Bahasa Melayu', code: 'MS' },
  { value: 'zh-TW', label: '繁體中文', code: 'ZH-TW' }
]
