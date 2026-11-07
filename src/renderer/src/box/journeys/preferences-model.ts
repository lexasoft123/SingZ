import type { BoxPreferences } from '../../../../shared/box-contract'
import type { SafeAreaPercent } from './types'

export type JourneyLanguage = 'en' | 'ru' | 'zh-CN'

export function validJourneyLanguage(language: string): JourneyLanguage | null {
  return language === 'en' || language === 'ru' || language === 'zh-CN' ? language : null
}

export async function hydrateAuthoritativePreferences(preferences: BoxPreferences, hooks: {
  isCurrent: () => boolean
  applyLocale: (language: JourneyLanguage) => Promise<void>
  onSafeAreaChange: (percent: SafeAreaPercent) => void
}): Promise<boolean> {
  if (!hooks.isCurrent()) return false
  const language = validJourneyLanguage(preferences.language)
  if (language) await hooks.applyLocale(language)
  if (!hooks.isCurrent()) return false
  hooks.onSafeAreaChange(preferences.safeAreaPercent)
  return true
}
