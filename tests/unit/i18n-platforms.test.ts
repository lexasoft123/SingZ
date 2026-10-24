import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOCALE_VALUES } from '../../src/shared/i18n/rules'

const root = resolve(__dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const iosLocale = (locale: string) => locale === 'zh-CN' ? 'zh-Hans' : locale === 'zh-TW' ? 'zh-Hant' : locale

describe('language declarations agree across platforms', () => {
  it.each(LOCALE_VALUES)('%s is available to both OS language pickers', locale => {
    expect(read('mobile/android/app/src/main/res/xml/locales_config.xml')).toContain(`android:name="${locale}"`)
    const ios = iosLocale(locale)
    expect(read('mobile/ios/SingZPlayer/Info.plist')).toContain(`<string>${ios}</string>`)
    expect(read('mobile/ios/SingZPlayer.xcodeproj/project.pbxproj')).toContain(`SingZPlayer/${ios}.lproj/InfoPlist.strings`)
    expect(read(`mobile/ios/SingZPlayer/${ios}.lproj/InfoPlist.strings`)).toContain('NSMicrophoneUsageDescription')
    expect(existsSync(resolve(root, `src/shared/i18n/${locale}/index.ts`))).toBe(true)
    if (locale !== 'en') expect(read('src/main/locale.ts')).toContain(`register('${locale}',`)
    expect(existsSync(resolve(root, `mobile/src/i18n/${locale}/index.ts`))).toBe(true)
  })
})
