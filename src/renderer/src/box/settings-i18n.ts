import { lookup, register } from '../../../shared/i18n/core'
import type { Vars } from '../../../shared/i18n/rules'
import { boxSettings as english } from '../../../shared/i18n/en/box-settings'
import { boxSettings as russian } from '../../../shared/i18n/ru/box-settings'
import { boxSettings as simplifiedChinese } from '../../../shared/i18n/zh-CN/box-settings'

register('en', english)
register('ru', russian)
register('zh-CN', simplifiedChinese)

export type SettingsKey = keyof typeof english

export function tSettings(key: SettingsKey, vars?: Vars): string {
  return lookup(key, vars)
}
