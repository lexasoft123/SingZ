/*
 * The lookup itself, with no dictionaries: which locale is current, which
 * strings are registered for it, and `t` / `tn` over them.
 *
 * Split from index.ts for the PHONE: mobile bundles src/shared's training code
 * (mobile/scripts/build-training.mjs), and that code calls `t`. Importing
 * index.ts there would drag every desktop dictionary into the app. Shared code
 * the phone bundles imports `./i18n/training` instead — this core plus the
 * English training strings, nothing else — and on the phone, where nothing
 * ever sets a locale, it reads English exactly as before. The desktop's
 * index.ts registers every dictionary for every locale.
 */
import { fill, pluralForm, type Locale, type Vars } from './rules'
import type { en } from './en'

export type Key = keyof typeof en

const DICTS: Record<Locale, Record<string, string>> = { en: {}, ru: {}, 'zh-CN': {} }

export function register(locale: Locale, dict: Record<string, string>): void {
  Object.assign(DICTS[locale], dict)
}

let current: Locale = 'en'
const listeners = new Set<() => void>()

export function setLocale(l: Locale): void {
  if (l === current) return
  current = l
  for (const fn of listeners) fn()
}
export const getLocale = (): Locale => current

/** For `useSyncExternalStore`: called after every locale change. */
export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * The untyped lookups. Each app wraps them with its own key type — the
 * desktop's `t`/`tn` below, the phone's in mobile/src/i18n.ts — so one core
 * serves two sets of dictionaries without either seeing the other's keys.
 */
export function lookup(key: string, vars?: Vars): string {
  return fill(DICTS[current][key] ?? DICTS.en[key] ?? key, vars)
}

export function lookupPlural(stem: string, n: number, vars?: Vars): string {
  const dict = DICTS[current]
  const text =
    dict[`${stem}_${pluralForm(current, n)}`] ??
    dict[`${stem}_other`] ??
    DICTS.en[`${stem}_${n === 1 ? 'one' : 'other'}`] ??
    stem
  return fill(text, { n, ...vars })
}

/** The string for `key` in the current locale, with `{name}` filled in. */
export function t(key: Key, vars?: Vars): string {
  return lookup(key, vars)
}

/** The keys that come in `_one` / `_other` pairs, by their stem. */
export type PluralKey = { [K in Key]: K extends `${infer B}_one` ? B : never }[Key]

/**
 * `tn('songs', 3)` → "3 songs" / "3 песни" / "3 首歌". English writes `_one`
 * and `_other`; a translation adds `_few` / `_many` where its language has
 * them (Russian), and any form it lacks falls back to `_other`. `n` is also
 * available to the string as `{n}`.
 */
export function tn(key: PluralKey, n: number, vars?: Vars): string {
  return lookupPlural(key, n, vars)
}
