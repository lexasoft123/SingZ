/*
 * The locale decisions, with no imports: which system tag maps to which
 * dictionary, how a preference resolves against the machine's list, and how a
 * count picks its plural form. Split from index.ts so a test can load them
 * without the dictionaries.
 */

export type Locale = 'en' | 'ru' | 'zh-CN'
/** What the preference stores: a locale, or `system` to follow the machine. */
export type Language = Locale | 'system'

export const LOCALE_VALUES: readonly Locale[] = ['en', 'ru', 'zh-CN']

export function isLanguage(v: unknown): v is Language {
  return v === 'system' || (typeof v === 'string' && (LOCALE_VALUES as readonly string[]).includes(v))
}

/**
 * The locale a system tag maps to, or null when SingZ has nothing for it.
 *
 * Simplified Chinese is offered to `zh`, `zh-CN`, `zh-SG` and any `zh-Hans`
 * form. Traditional variants (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`) are
 * deliberately NOT mapped: a Traditional reader gets Simplified only by
 * choosing it, not by being handed it. Russian takes every `ru` region.
 */
export function fromTag(tag: string): Locale | null {
  const parts = tag.toLowerCase().replace(/_/g, '-').split('-')
  const lang = parts[0]
  if (lang === 'en') return 'en'
  if (lang === 'ru') return 'ru'
  if (lang === 'zh') {
    if (parts.includes('hant')) return null
    if (parts.includes('hans')) return 'zh-CN'
    const region = parts.slice(1).find((p) => p.length === 2)
    return region === undefined || region === 'cn' || region === 'sg' ? 'zh-CN' : null
  }
  return null
}

/**
 * The locale to use: the preference when it names one, else the first of the
 * system's preferred languages SingZ can speak, else English.
 */
export function resolveLocale(language: Language, systemTags: readonly string[]): Locale {
  if (language !== 'system') return language
  for (const tag of systemTags) {
    const l = fromTag(tag)
    if (l) return l
  }
  return 'en'
}

export type Vars = Record<string, string | number>

/** `{name}` → vars.name. An unknown name is left as it was, visibly. */
export function fill(text: string, vars?: Vars): string {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/**
 * The CLDR plural form of `n` in `locale`: English has one/other, Russian
 * one/few/many (1 песня, 2 песни, 5 песен), Chinese only other.
 */
export type PluralForm = 'one' | 'few' | 'many' | 'other'
const rules = new Map<Locale, Intl.PluralRules>()
export function pluralForm(locale: Locale, n: number): PluralForm {
  let r = rules.get(locale)
  if (!r) {
    // Hermes — the phone's engine — has no Intl.PluralRules (its Intl is
    // Collator, DateTimeFormat and NumberFormat), so the CLDR rules for our
    // three languages are written out by hand for it.
    if (typeof Intl === 'undefined' || typeof Intl.PluralRules !== 'function') return cldrPlural(locale, n)
    rules.set(locale, (r = new Intl.PluralRules(locale)))
  }
  const f = r.select(n)
  return f === 'one' || f === 'few' || f === 'many' ? f : 'other'
}

/** CLDR cardinal rules for integer counts, for engines without PluralRules. */
export function cldrPlural(locale: Locale, n: number): PluralForm {
  if (!Number.isInteger(n)) return 'other'
  const a = Math.abs(n)
  if (locale === 'ru') {
    const d = a % 10
    const h = a % 100
    if (d === 1 && h !== 11) return 'one'
    if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 'few'
    return 'many'
  }
  if (locale === 'zh-CN') return 'other'
  return a === 1 ? 'one' : 'other'
}
