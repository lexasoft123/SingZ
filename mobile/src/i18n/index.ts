/*
 * The phone's language. There is no picker in the app: it follows the
 * system, and the singer changes it per app in the OS itself — iOS Settings ›
 * SingZ › Language, Android 13+ Settings › Apps › SingZ › Language. The
 * native projects declare the three languages so both OSes offer that row
 * (ios/…/InfoPlist.strings, android/…/xml/locales_config.xml).
 *
 * The lookup is the desktop's core (src/shared/i18n/core.ts), used through
 * gen/training-lib.js: that bundle carries its own copy of the core for the
 * shared training code, and the app must switch THAT copy, or the training
 * prompts would stay in the old language.
 */
import { useSyncExternalStore } from 'react'
import { NativeModules, Platform } from 'react-native'
import {
  i18nGetLocale,
  i18nLookup,
  i18nLookupPlural,
  i18nRegister,
  i18nResolveLocale,
  i18nSetLocale,
  i18nSubscribe
} from '../gen/training-lib'
import type { Locale, Vars } from '../../../src/shared/i18n/rules'
import { training as ruTraining } from '../../../src/shared/i18n/ru/training'
import { training as zhTraining } from '../../../src/shared/i18n/zh-CN/training'
// key and interval names (keyLabel / intervalLabel) live in the desktop's
// `common`; the language and stem-name keys ride along unused
import { common as enCommon } from '../../../src/shared/i18n/en/common'
import { common as ruCommon } from '../../../src/shared/i18n/ru/common'
import { common as zhCommon } from '../../../src/shared/i18n/zh-CN/common'
import { en } from './en'
import { ru } from './ru'
import { zhCN } from './zh-CN'

export type { Locale } from '../../../src/shared/i18n/rules'

// English training strings are registered by the bundle itself.
i18nRegister('en', { ...enCommon, ...en })
i18nRegister('ru', { ...ruCommon, ...ruTraining, ...ru })
i18nRegister('zh-CN', { ...zhCommon, ...zhTraining, ...zhCN })

export type Key = keyof typeof en
export type PluralKey = { [K in Key]: K extends `${infer B}_one` ? B : never }[Key]

export const t = (key: Key, vars?: Vars): string => i18nLookup(key, vars)
export const tn = (key: PluralKey, n: number, vars?: Vars): string => i18nLookupPlural(key, n, vars)
export const getLocale = (): Locale => i18nGetLocale()

/**
 * The languages the OS says this app should speak, most preferred first.
 * iOS: the app's own AppleLanguages (a per-app choice in Settings lands
 * there, and iOS relaunches the app on a change). Android: the app's
 * configuration locale, which a per-app choice sets.
 */
export function systemTags(): string[] {
  // Suites assert English copy; a developer's own system language must not
  // leak into them.
  if (typeof process !== 'undefined' && process.env?.JEST_WORKER_ID) return ['en']
  try {
    if (Platform.OS === 'ios') {
      const s = NativeModules.SettingsManager?.getConstants?.().settings ?? NativeModules.SettingsManager?.settings
      const langs: unknown = s?.AppleLanguages
      if (Array.isArray(langs) && langs.length) return langs.map(String)
      if (typeof s?.AppleLocale === 'string') return [s.AppleLocale]
    } else {
      const id: unknown = NativeModules.I18nManager?.getConstants?.().localeIdentifier
      if (typeof id === 'string' && id) return [id]
    }
  } catch {
    /* fall through to the JS engine's own idea */
  }
  try {
    return [Intl.DateTimeFormat().resolvedOptions().locale]
  } catch {
    return []
  }
}

/** Read the system's choice and switch to it. Returns the locale in use. */
export function applySystemLocale(): Locale {
  const l = i18nResolveLocale('system', systemTags())
  i18nSetLocale(l)
  return l
}

/** The locale as React state: a component calling this re-renders on a switch. */
export function useLocale(): Locale {
  return useSyncExternalStore(i18nSubscribe, i18nGetLocale)
}
