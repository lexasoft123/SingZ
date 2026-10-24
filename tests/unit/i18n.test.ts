/*
 * The locale rules and the three dictionaries. English is the source; Russian
 * and Simplified Chinese must hold every key, keep every {placeholder}, keep
 * the **bold** markers balanced, and give Russian its few/many plural forms.
 */
import { describe, expect, it } from 'vitest'
import { cldrPlural, fill, fromTag, pluralForm, resolveLocale } from '../../src/shared/i18n/rules'
import { en } from '../../src/shared/i18n/en'
import { ru } from '../../src/shared/i18n/ru'
import { zhCN } from '../../src/shared/i18n/zh-CN'
import { hi } from '../../src/shared/i18n/hi'
import { ja } from '../../src/shared/i18n/ja'
import { ko } from '../../src/shared/i18n/ko'
import { th } from '../../src/shared/i18n/th'
import { id } from '../../src/shared/i18n/id'
import { vi } from '../../src/shared/i18n/vi'
import { fil } from '../../src/shared/i18n/fil'
import { ms } from '../../src/shared/i18n/ms'
import { zhTW } from '../../src/shared/i18n/zh-TW'
import { loadLocale, setLocale, t, tn } from '../../src/shared/i18n'

describe('fromTag', () => {
  it('maps every spelling the platforms use', () => {
    for (const tag of ['en', 'en-US', 'en_GB', 'en-IN']) expect(fromTag(tag)).toBe('en')
    for (const tag of ['ru', 'ru-RU', 'ru_UA', 'ru-KZ']) expect(fromTag(tag)).toBe('ru')
    for (const tag of ['zh', 'zh-CN', 'zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-Hans-SG', 'zh-SG']) {
      expect(fromTag(tag)).toBe('zh-CN')
    }
  })
  it('uses Traditional Chinese for Traditional readers', () => {
    for (const tag of ['zh-TW', 'zh-Hant', 'zh-Hant-TW', 'zh-HK', 'zh-MO']) expect(fromTag(tag)).toBe('zh-TW')
  })
  it('resolves regional and legacy Asian language tags', () => {
    for (const [tag, locale] of [['hi-IN','hi'],['hi_Latn_IN','hi'],['ja-JP','ja'],['ko-KR','ko'],['th-TH','th'],['id-ID','id'],['in-ID','id'],['vi-VN','vi'],['tl-PH','fil'],['fil-PH','fil'],['ms-MY','ms'],['zh-Hant-HK','zh-TW']]) {
      expect(fromTag(tag), tag).toBe(locale)
    }
  })
  it('has nothing for other languages', () => {
    for (const tag of ['de-DE', 'uk-UA', '']) expect(fromTag(tag)).toBeNull()
  })
})

describe('resolveLocale', () => {
  it('honours an explicit choice over the system', () => {
    expect(resolveLocale('en', ['ru-RU'])).toBe('en')
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN')
  })
  it('walks the system list in order and takes the first it can speak', () => {
    expect(resolveLocale('system', ['ru-RU', 'en-US'])).toBe('ru')
    expect(resolveLocale('system', ['ja', 'zh-Hans-CN'])).toBe('ja')
    expect(resolveLocale('system', ['zh-TW', 'en'])).toBe('zh-TW')
  })
  it('falls back to English', () => {
    expect(resolveLocale('system', [])).toBe('en')
    expect(resolveLocale('system', ['de-DE', 'uk-UA'])).toBe('en')
  })
})

describe('fill and plurals', () => {
  it('interpolates and leaves an unknown name visible', () => {
    expect(fill('{n} of {total}', { n: 1, total: 3 })).toBe('1 of 3')
    expect(fill('{n} of {total}', { n: 1 })).toBe('1 of {total}')
  })
  it('picks the CLDR form', () => {
    expect([1, 2, 5, 21, 22, 25].map((n) => pluralForm('ru', n))).toEqual(['one', 'few', 'many', 'one', 'few', 'many'])
    expect([1, 2].map((n) => pluralForm('en', n))).toEqual(['one', 'other'])
    expect(pluralForm('zh-CN', 1)).toBe('other')
  })
  it('the hand-written rules (Hermes has no PluralRules) agree with Intl', () => {
    for (const locale of ['en', 'ru', 'zh-CN', 'hi', 'ja', 'ko', 'th', 'id', 'vi', 'fil', 'ms', 'zh-TW'] as const) {
      const intl = new Intl.PluralRules(locale)
      for (let n = 0; n <= 125; n++) {
        const want = intl.select(n)
        expect(cldrPlural(locale, n), `${locale} ${n}`).toBe(want === 'zero' || want === 'two' ? 'other' : want)
      }
    }
    expect([1, 2, 5, 11, 21, 22, 112].map((n) => cldrPlural('ru', n))).toEqual(['one', 'few', 'many', 'many', 'one', 'few', 'many'])
  })
  it('matches CLDR for Hindi and Filipino fractions without Intl.PluralRules', () => {
    for (const locale of ['hi', 'fil'] as const) {
      for (const n of [0, 0.1, 0.4, 0.6, 0.9, 1, 1.1, 1.4, 2, 4, 6, 9, 14, 24, 1.1234]) {
        expect(cldrPlural(locale,n), `${locale} ${n}`).toBe(new Intl.PluralRules(locale).select(n))
      }
    }
  })
  it('switches language live', async () => {
    await loadLocale('ru')
    await loadLocale('zh-CN')
    setLocale('ru')
    expect(t('lang.label')).toBe(ru['lang.label'])
    setLocale('zh-CN')
    expect(t('lang.label')).toBe(zhCN['lang.label'])
    setLocale('en')
    expect(t('lang.label')).toBe('Language')
  })
})

describe('added Asian languages load and switch', () => {
  it.each(['hi','ja','ko','th','id','vi','fil','ms','zh-TW'] as const)('%s registers its own strings', async locale => {
    await loadLocale(locale)
    setLocale(locale)
    expect(t('lang.label')).not.toBe('lang.label')
    expect(t('app.titlebar.songs')).not.toBe('Songs')
    setLocale('en')
  })
})

describe('the dictionaries', () => {
  const keys = Object.keys(en) as (keyof typeof en)[]
  const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  const stems = keys.filter((k) => k.endsWith('_one')).map((k) => k.slice(0, -4))
  const dicts: [string, Record<string, string>][] = [
    ['ru', ru],
    ['zh-CN', zhCN],
    ['hi', hi],
    ['ja', ja],
    ['ko', ko],
    ['th', th],
    ['id', id],
    ['vi', vi],
    ['fil', fil],
    ['ms', ms],
    ['zh-TW', zhTW]
  ]

  it('English keys are namespaced and non-empty', () => {
    for (const k of keys) {
      expect(k, k).toMatch(/^[a-z]+[\w-]*\.[\w.-]+$/)
      expect(en[k].trim(), k).not.toBe('')
    }
  })

  for (const [name, dict] of dicts) {
    it(`${name} has every English key, nothing empty, nothing extra`, () => {
      const missing = keys.filter((k) => typeof dict[k] !== 'string' || dict[k].trim() === '')
      expect(missing, `${name} lacks`).toEqual([])
      const allowed = new Set<string>([...keys, ...stems.flatMap((s) => [`${s}_few`, `${s}_many`])])
      expect(Object.keys(dict).filter((k) => !allowed.has(k)), `${name} has unknown keys`).toEqual([])
    })

    it(`${name} keeps every {placeholder}`, () => {
      const bad = keys.filter((k) => dict[k] !== undefined && holes(dict[k]).join() !== holes(en[k]).join())
      expect(bad, `placeholders differ in ${name}`).toEqual([])
      for (const s of stems) {
        for (const f of ['few', 'many']) {
          const v = dict[`${s}_${f}`]
          if (v !== undefined) expect(holes(v).join(), `${s}_${f}`).toBe(holes(en[`${s}_other` as keyof typeof en]).join())
        }
      }
    })

    it(`${name} keeps the **bold** markers balanced`, () => {
      for (const k of keys) {
        expect(((dict[k] ?? '').match(/\*\*/g) ?? []).length % 2, `${name} ${k}`).toBe(0)
        expect((en[k].match(/\*\*/g) ?? []).length % 2, `en ${k}`).toBe(0)
      }
    })
  }

  it('every plural has its pair, and Russian has its few/many forms', () => {
    for (const s of stems) expect(keys, `${s}_other`).toContain(`${s}_other`)
    for (const k of keys.filter((k) => k.endsWith('_other'))) expect(keys, `${k} has no _one`).toContain(`${k.slice(0, -6)}_one`)
    const lacking = stems.filter((s) => !ru[`${s}_few`] || !ru[`${s}_many`])
    expect(lacking, 'ru plurals without _few/_many').toEqual([])
  })

  it('tn picks the Russian forms', async () => {
    const s = stems[0]
    if (!s) return
    await loadLocale('ru')
    setLocale('ru')
    expect(tn(s as never, 2)).toBe(fill(ru[`${s}_few`], { n: 2 }))
    expect(tn(s as never, 5)).toBe(fill(ru[`${s}_many`], { n: 5 }))
    setLocale('en')
  })
})
