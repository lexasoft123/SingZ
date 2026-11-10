import { afterEach, describe, expect, it } from 'vitest'
import { box as english } from '../../src/shared/i18n/en/box'
import { box as russian } from '../../src/shared/i18n/ru/box'
import { box as simplifiedChinese } from '../../src/shared/i18n/zh-CN/box'
import { en as desktopEnglish } from '../../src/shared/i18n/en'
import { getLocale, tn } from '../../src/shared/i18n'
import { prepareBoxLocale, t } from '../../src/renderer/src/box/i18n'

const holes = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

afterEach(async () => {
  await prepareBoxLocale('en')
})

describe('canonical Box dictionaries', () => {
  it('keeps every key and placeholder in Russian and Simplified Chinese', () => {
    for (const [name, dictionary] of [['ru', russian], ['zh-CN', simplifiedChinese]] as const) {
      for (const [key, englishText] of Object.entries(english)) {
        expect(dictionary[key as keyof typeof english], `${name} ${key}`).toBeTypeOf('string')
        expect(dictionary[key as keyof typeof english].trim(), `${name} ${key}`).not.toBe('')
        expect(holes(dictionary[key as keyof typeof english]), `${name} ${key}`).toEqual(holes(englishText))
      }
      expect(Object.keys(dictionary).filter(key => !(key in english) && !/^box\.catalog\.songs_(few|many)$/.test(key))).toEqual([])
    }
    expect(russian['box.catalog.songs_few']).toContain('{count}')
    expect(russian['box.catalog.songs_many']).toContain('{count}')
  })

  it('falls back to English in memory for unsupported locales without changing saved preferences', async () => {
    expect(await prepareBoxLocale('ja')).toBe('en')
    expect(getLocale()).toBe('en')
    expect(t('box.navigation.catalog')).toBe('Catalog')
    expect(await prepareBoxLocale('ru')).toBe('ru')
    expect(t('box.navigation.catalog')).toBe('Каталог')
    expect(tn('box.catalog.songs', 2, { count: 2 })).toBe('2 песни')
    expect(tn('box.catalog.songs', 5, { count: 5 })).toBe('5 песен')
    expect(await prepareBoxLocale('zh-CN')).toBe('zh-CN')
    expect(t('box.navigation.catalog')).toBe('曲库')
  })

  it('does not add Box strings to Desktop eager English or expose milestone copy', () => {
    expect('box.navigation.catalog' in desktopEnglish).toBe(false)
    for (const value of Object.values(english)) {
      expect(value).not.toMatch(/this slice|for this slice/i)
    }
  })
})
