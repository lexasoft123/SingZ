/*
 * The phone's language. There is no picker in the app: it follows the
 * system, and the singer changes it per app in the OS itself — iOS Settings ›
 * SingZ › Language, Android 13+ Settings › Apps › SingZ › Language. The
 * native projects declare the supported languages so both OSes offer that row
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
import { es419 } from './es-419'
import { training as es419Training } from '../../../src/shared/i18n/es-419/training'
import { common as es419Common } from '../../../src/shared/i18n/es-419/common'
import { ptBR } from './pt-BR'
import { training as ptBRTraining } from '../../../src/shared/i18n/pt-BR/training'
import { common as ptBRCommon } from '../../../src/shared/i18n/pt-BR/common'
import { tr } from './tr'
import { training as trTraining } from '../../../src/shared/i18n/tr/training'
import { common as trCommon } from '../../../src/shared/i18n/tr/common'
import { en } from './en'
import { ru } from './ru'
import { zhCN } from './zh-CN'
import { hi } from './hi'
import { training as hiTraining } from '../../../src/shared/i18n/hi/training'
import { common as hiCommon } from '../../../src/shared/i18n/hi/common'

import { ja } from './ja'
import { training as jaTraining } from '../../../src/shared/i18n/ja/training'
import { common as jaCommon } from '../../../src/shared/i18n/ja/common'
import { ko } from './ko'
import { training as koTraining } from '../../../src/shared/i18n/ko/training'
import { common as koCommon } from '../../../src/shared/i18n/ko/common'
import { th } from './th'
import { training as thTraining } from '../../../src/shared/i18n/th/training'
import { common as thCommon } from '../../../src/shared/i18n/th/common'
import { id } from './id'
import { training as idTraining } from '../../../src/shared/i18n/id/training'
import { common as idCommon } from '../../../src/shared/i18n/id/common'
import { vi } from './vi'
import { training as viTraining } from '../../../src/shared/i18n/vi/training'
import { common as viCommon } from '../../../src/shared/i18n/vi/common'
import { fil } from './fil'
import { training as filTraining } from '../../../src/shared/i18n/fil/training'
import { common as filCommon } from '../../../src/shared/i18n/fil/common'
import { ms } from './ms'
import { training as msTraining } from '../../../src/shared/i18n/ms/training'
import { common as msCommon } from '../../../src/shared/i18n/ms/common'
import { zhTW } from './zh-TW'
import { training as zhTWTraining } from '../../../src/shared/i18n/zh-TW/training'
import { common as zhTWCommon } from '../../../src/shared/i18n/zh-TW/common'

export type { Locale } from '../../../src/shared/i18n/rules'

// English training strings are registered by the bundle itself.
i18nRegister('en', { ...enCommon, ...en })
i18nRegister('es-419', { ...es419Common, ...es419Training, ...es419 })
i18nRegister('pt-BR', { ...ptBRCommon, ...ptBRTraining, ...ptBR })
i18nRegister('tr', { ...trCommon, ...trTraining, ...tr })
i18nRegister('ru', { ...ruCommon, ...ruTraining, ...ru })
i18nRegister('zh-CN', { ...zhCommon, ...zhTraining, ...zhCN })
i18nRegister('hi', { ...hiCommon, ...hiTraining, ...hi })

i18nRegister('ja', { ...jaCommon, ...jaTraining, ...ja })
i18nRegister('ko', { ...koCommon, ...koTraining, ...ko })
i18nRegister('th', { ...thCommon, ...thTraining, ...th })
i18nRegister('id', { ...idCommon, ...idTraining, ...id })
i18nRegister('vi', { ...viCommon, ...viTraining, ...vi })
i18nRegister('fil', { ...filCommon, ...filTraining, ...fil })
i18nRegister('ms', { ...msCommon, ...msTraining, ...ms })
i18nRegister('zh-TW', { ...zhTWCommon, ...zhTWTraining, ...zhTW })

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
