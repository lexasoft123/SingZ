import { afterEach, describe, expect, it } from 'vitest'
import { box as en } from '../../src/shared/i18n/en/box'
import { box as ru } from '../../src/shared/i18n/ru/box'
import { box as zh } from '../../src/shared/i18n/zh-CN/box'
import { boxSettings as enSettings } from '../../src/shared/i18n/en/box-settings'
import { boxSettings as ruSettings } from '../../src/shared/i18n/ru/box-settings'
import { boxSettings as zhSettings } from '../../src/shared/i18n/zh-CN/box-settings'
import { journeyEnglish, journeyRussian, journeyChinese } from '../../src/renderer/src/box/journeys/i18n'
import { phonesStatus } from '../../src/renderer/src/box/journeys/format'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'
import { setLocale } from '../../src/shared/i18n'

const values = (...dictionaries: Array<Record<string, string>>): Array<[string, string]> =>
  dictionaries.flatMap(dictionary => Object.entries(dictionary))

// One name per concept: Songs (library), Google Drive (account), Audio & microphones (sound page), Vocals.
const RETIRED: Record<string, RegExp> = {
  en: /catalog|collection|your projects|SingZ library|local projects|sound settings|lead vocal|desktop singz|prepared (local )?stems?|prepared in|FLOW 8|\bPCM\b|revision|nominal/i,
  ru: /каталог|коллекц|ваши проекты|библиотека singz|локальные проекты|настройки звука|ведущий вокал|desktop singz|FLOW 8|номинальн|версия \{/i,
  'zh-CN': /曲库|收藏|你的项目|本地项目|声音设置|主唱|desktop singz|FLOW 8|标称|版本 \{/i
}
const sets = {
  en: [en, enSettings, journeyEnglish],
  ru: [ru, ruSettings, journeyRussian],
  'zh-CN': [zh, zhSettings, journeyChinese]
} as unknown as Record<string, Array<Record<string, string>>>

afterEach(() => setLocale('en'))

describe('Box copy: one name per concept, no engineering text', () => {
  for (const [locale, pattern] of Object.entries(RETIRED)) {
    it(`${locale}: no retired name or engineering term in any Box string`, () => {
      const hits = values(...sets[locale]).filter(([, text]) => pattern.test(text)).map(([key, text]) => `${key}: ${text}`)
      expect(hits).toEqual([])
    })
  }

  it('uses the chosen names', () => {
    expect(en['box.navigation.catalog']).toBe('Songs')
    expect(en['box.catalog.title']).toBe('Songs')
    expect(en['box.navigation.account']).toBe('Google Drive')
    expect(en['box.account.title']).toBe('Google Drive')
    expect(enSettings['box.settings.title']).toBe(journeyEnglish['journey.home.audio'])
    expect(ruSettings['box.settings.title']).toBe(journeyRussian['journey.home.audio'])
    expect(zhSettings['box.settings.title']).toBe(journeyChinese['journey.home.audio'])
    expect(en['box.mix.lead']).toBe('Vocals')
    expect(en['box.hints.navigation']).toBe('Menu')
  })

  it('has no keys for the retired concepts', () => {
    for (const dictionary of [en, ru, zh] as Array<Record<string, string>>) {
      expect('box.catalog.library' in dictionary).toBe(false)
      expect('box.player.savedStems' in dictionary).toBe(false)
    }
    for (const dictionary of [enSettings, ruSettings, zhSettings] as Array<Record<string, string>>) expect('box.settings.routing.revisions' in dictionary).toBe(false)
  })

  it('unit text keeps number and unit together (no double space)', () => {
    for (const text of [journeyEnglish['journey.expires'], journeyRussian['journey.expires'], en['box.player.countdownSeconds'], ru['box.player.countdownSeconds']]) {
      expect(text).not.toMatch(/ {2}|  |  |  |  /)
    }
  })
})

describe('Settings phone status is a word with its own plural form, never a bare number', () => {
  const cases: Array<[string, 'en' | 'ru' | 'zh-CN', number, string]> = [
    ['en 0', 'en', 0, 'None paired'], ['en 1', 'en', 1, '1 phone'], ['en 2', 'en', 2, '2 phones'],
    ['ru 0', 'ru', 0, 'Нет подключённых'], ['ru 1', 'ru', 1, '1 телефон'], ['ru 2', 'ru', 2, '2 телефона'],
    ['ru 5', 'ru', 5, '5 телефонов'], ['ru 21', 'ru', 21, '21 телефон'], ['ru 22', 'ru', 22, '22 телефона'],
    ['zh 3', 'zh-CN', 3, '3部手机']
  ]
  it.each(cases)('%s', async (_name, locale, count, expected) => {
    await prepareBoxLocale(locale)
    expect(phonesStatus(count)).toBe(expected)
  })
  it('negative control: the old status was the bare count', () => {
    expect(phonesStatus(0)).not.toBe('0')
  })
})
