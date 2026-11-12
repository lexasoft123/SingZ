/*
 * The Voice strip's strings, registered when its chunk loads rather than with
 * the eager dictionaries (the renderer entry has a size budget). English is
 * registered at import; the current language is fetched on demand.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { register } from '../../../shared/i18n/core'
import { voice as en } from '../../../shared/i18n/en/voice'
import { getLocale, subscribeLocale } from '../../../shared/i18n/core'
import type { Locale } from '../../../shared/i18n/rules'

register('en', en)

const dict = (m: Promise<{ voice: Record<string, string> }>): Promise<Record<string, string>> => m.then((x) => x.voice)
const LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<Record<string, string>>> = {
  'es-419': () => dict(import('../../../shared/i18n/es-419/voice')),
  'pt-BR': () => dict(import('../../../shared/i18n/pt-BR/voice')),
  tr: () => dict(import('../../../shared/i18n/tr/voice')),
  ru: () => dict(import('../../../shared/i18n/ru/voice')),
  'zh-CN': () => dict(import('../../../shared/i18n/zh-CN/voice')),
  hi: () => dict(import('../../../shared/i18n/hi/voice')),
  ja: () => dict(import('../../../shared/i18n/ja/voice')),
  ko: () => dict(import('../../../shared/i18n/ko/voice')),
  th: () => dict(import('../../../shared/i18n/th/voice')),
  id: () => dict(import('../../../shared/i18n/id/voice')),
  vi: () => dict(import('../../../shared/i18n/vi/voice')),
  fil: () => dict(import('../../../shared/i18n/fil/voice')),
  ms: () => dict(import('../../../shared/i18n/ms/voice')),
  'zh-TW': () => dict(import('../../../shared/i18n/zh-TW/voice'))
}

const loaded = new Set<Locale>(['en'])

/** Register the Voice strings for a language; resolves true when it newly loaded. */
export async function loadVoiceStrings(locale: Locale): Promise<boolean> {
  if (loaded.has(locale) || locale === 'en') return false
  register(locale, await LOADERS[locale]())
  loaded.add(locale)
  return true
}

/** Call in every Voice component: loads the current language and re-renders when it arrives. */
export function useVoiceStrings(): void {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale)
  const [, bump] = useState(0)
  useEffect(() => {
    let live = true
    void loadVoiceStrings(locale)
      .then((fresh) => {
        if (live && fresh) bump((n) => n + 1)
      })
      .catch(() => undefined) // English fallback stays on screen
    return () => {
      live = false
    }
  }, [locale])
}
