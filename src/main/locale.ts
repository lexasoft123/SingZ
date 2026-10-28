import { app, ipcMain } from 'electron'
import { isLanguage, resolveLocale, setLocale, type Language, type Locale } from '../shared/i18n'
import { register } from '../shared/i18n/core'
import { tr } from '../shared/i18n/tr'
import { ru } from '../shared/i18n/ru'
import { zhCN } from '../shared/i18n/zh-CN'
import { hi } from '../shared/i18n/hi'
import { ja } from '../shared/i18n/ja'
import { ko } from '../shared/i18n/ko'
import { th } from '../shared/i18n/th'
import { id } from '../shared/i18n/id'
import { vi } from '../shared/i18n/vi'
import { fil } from '../shared/i18n/fil'
import { ms } from '../shared/i18n/ms'
import { zhTW } from '../shared/i18n/zh-TW'
import { readSettings, writeSettings } from './settings'
import { log } from './log'
import type { LocaleState } from '../shared/types'

/**
 * The app's language: a saved preference (`settings.json` → `language`),
 * `system` by default, resolved against the machine's preferred languages.
 *
 * `SINGZ_LANG` overrides both, and E2E runs (`SINGZ_E2E_HIDDEN=1`) default to
 * English: the drivers find controls by their English text, and the Windows
 * field laptop is a Russian-locale machine that `system` would hand Russian.
 */
let pickedThisSession: Language | null = null

function forced(): Language | null {
  // A pick made in this session wins over the env: a driver that pins English
  // and then presses the flag is testing the switch.
  if (pickedThisSession) return pickedThisSession
  const env = process.env.SINGZ_LANG
  if (isLanguage(env)) return env
  if (process.env.SINGZ_E2E_HIDDEN === '1') return 'en'
  return null
}

/** The machine's languages, most preferred first, as BCP-47 tags. */
function systemTags(): string[] {
  try {
    const tags = app.getPreferredSystemLanguages()
    if (tags.length) return tags
  } catch {
    /* before ready on some platforms — fall through */
  }
  return [app.getLocale()]
}

function preference(): Language {
  const saved = readSettings().language
  return isLanguage(saved) ? saved : 'system'
}

export function localeState(): LocaleState {
  const language = forced() ?? preference()
  const tags = systemTags()
  return { language, locale: resolveLocale(language, tags), systemLocale: resolveLocale('system', tags) }
}

// Main has no bundle budget and must answer synchronously: every language is
// registered up front (the renderer loads them on demand instead).
register('tr', tr)
register('ru', ru)
register('zh-CN', zhCN)
register('zh-TW', zhTW)
register('ms', ms)
register('fil', fil)
register('vi', vi)
register('id', id)
register('th', th)
register('ko', ko)
register('ja', ja)
register('hi', hi)

/** Resolve and apply the locale for main's own strings. */
export function applyLocale(): Locale {
  const { locale } = localeState()
  setLocale(locale)
  return locale
}

export function registerLocale(): void {
  applyLocale()
  const s = localeState()
  log('app', `language: ${s.language} → ${s.locale} (system ${s.systemLocale})`)
  ipcMain.handle('i18n:get', () => localeState())
  ipcMain.handle('i18n:set', (_e, language: unknown) => {
    if (isLanguage(language)) {
      writeSettings({ language })
      pickedThisSession = language
    }
    log('app', `language set: ${String(language)} → ${applyLocale()}`)
    return localeState()
  })
}
