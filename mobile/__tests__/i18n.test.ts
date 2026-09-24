/*
 * The phone's dictionaries: Russian and Simplified Chinese hold every English
 * key (Russian with its few/many plural forms), keep every {placeholder}, and
 * the lookup falls back to English and switches live. The desktop's own
 * dictionaries are checked by tests/unit/i18n.test.ts at the repo root.
 */
import { en } from '../src/i18n/en'
import { ru } from '../src/i18n/ru'
import { zhCN } from '../src/i18n/zh-CN'
import { getLocale, t, tn } from '../src/i18n'
import { i18nSetLocale } from '../src/gen/training-lib'

const keys = Object.keys(en) as (keyof typeof en)[]
const holes = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()
const stems = keys.filter((k) => k.endsWith('_one')).map((k) => k.slice(0, -4))

describe('phone dictionaries', () => {
  it('every English key is namespaced phone.*', () => {
    for (const k of keys) expect(k).toMatch(/^phone\.[a-z]+\.[\w.-]+$/)
  })

  for (const [name, dict] of [['ru', ru], ['zh-CN', zhCN]] as const) {
    it(`${name} has every key, nothing empty, nothing extra`, () => {
      expect(keys.filter((k) => !dict[k]?.trim())).toEqual([])
      const allowed = new Set<string>([...keys, ...stems.flatMap((s) => [`${s}_few`, `${s}_many`])])
      expect(Object.keys(dict).filter((k) => !allowed.has(k))).toEqual([])
    })
    it(`${name} keeps every {placeholder}`, () => {
      expect(keys.filter((k) => holes(dict[k] ?? '') !== holes(en[k]))).toEqual([])
    })
  }

  it('Russian has its few/many plural forms', () => {
    expect(stems.filter((s) => !ru[`${s}_few`] || !ru[`${s}_many`])).toEqual([])
  })

  it('suites run in English, and the lookup switches live', () => {
    expect(getLocale()).toBe('en')
    const key = keys[0]
    i18nSetLocale('ru')
    expect(t(key)).toBe(ru[key])
    // the shared training strings come along (desktop dictionaries)
    i18nSetLocale('zh-CN')
    expect(t(key)).toBe(zhCN[key])
    i18nSetLocale('en')
    expect(t(key)).toBe(en[key])
    if (stems[0]) {
      i18nSetLocale('ru')
      expect(tn(stems[0] as never, 5)).toContain('5')
      i18nSetLocale('en')
    }
  })

  it('picks Russian plural forms without Intl.PluralRules, as on Hermes', () => {
    const saved = Intl.PluralRules
    // Hermes' Intl has no PluralRules; the phone must still say 6 дорожек.
    // A fresh module registry, so no rule cached by an earlier test answers.
    ;(Intl as { PluralRules?: unknown }).PluralRules = undefined
    try {
      jest.isolateModules(() => {
        const fresh = require('../src/i18n') as typeof import('../src/i18n')
        const lib = require('../src/gen/training-lib') as typeof import('../src/gen/training-lib')
        const stem = 'phone.library.stemsCount' as never
        lib.i18nSetLocale('ru')
        const form = (f: string, n: number) => (ru as Record<string, string>)[`phone.library.stemsCount_${f}`].replace('{n}', String(n))
        expect(fresh.tn(stem, 1)).toBe(form('one', 1))
        expect(fresh.tn(stem, 3)).toBe(form('few', 3))
        expect(fresh.tn(stem, 6)).toBe(form('many', 6))
        expect(fresh.tn(stem, 21)).toBe(form('one', 21))
      })
    } finally {
      ;(Intl as { PluralRules?: unknown }).PluralRules = saved
    }
  })
})
