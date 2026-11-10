import { loadLocale, setLocale, t, tn, type Locale } from '../../../shared/i18n'
import { register } from '../../../shared/i18n/core'

export { t, tn }

const SUPPORTED = new Set<Locale>(['en', 'ru', 'zh-CN'])

export async function prepareBoxLocale(requested: Locale): Promise<Locale> {
  const locale = SUPPORTED.has(requested) ? requested : 'en'
  await loadLocale(locale)
  const dictionary = locale === 'ru'
    ? await import('../../../shared/i18n/ru/box')
    : locale === 'zh-CN'
      ? await import('../../../shared/i18n/zh-CN/box')
      : await import('../../../shared/i18n/en/box')
  register(locale, dictionary.box)
  setLocale(locale)
  return locale
}
