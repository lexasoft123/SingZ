import { describe, expect, it } from 'vitest'
import { en } from '../../src/shared/i18n/en'
import { native as enNative } from '../../src/shared/i18n/en/native'

const LOCALES = ['ru', 'zh-CN', 'hi', 'ja', 'ko', 'th', 'id', 'vi', 'fil', 'ms', 'zh-TW', 'tr', 'es-419', 'pt-BR'] as const
const holes = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()

describe('native-only strings', () => {
  it('stay out of the dictionary the Electron renderer bundles eagerly', () => {
    const leaked = Object.keys(enNative).filter((k) => k in en)
    expect(leaked, 'native keys in the eager English dictionary').toEqual([])
  })

  for (const locale of LOCALES) {
    it(`${locale} has every native key with its placeholders`, async () => {
      const { native } = (await import(`../../src/shared/i18n/${locale}/native`)) as {
        native: Record<string, string>
      }
      for (const [key, text] of Object.entries(enNative)) {
        expect(typeof native[key], `${locale} lacks ${key}`).toBe('string')
        expect(native[key].trim(), `${locale} ${key} is empty`).not.toBe('')
        expect(holes(native[key]), `${locale} ${key} placeholders`).toBe(holes(text))
      }
    })
  }
})
