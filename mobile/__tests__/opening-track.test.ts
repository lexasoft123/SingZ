import { openingTrack } from '../src/drive-progress'
import { getLocale, t } from '../src/i18n'
import { i18nSetLocale } from '../src/gen/training-lib'

it('localizes built-in stems without changing user-authored track names or ordinals', () => {
  const previous = getLocale()
  try {
    i18nSetLocale('ru')
    expect(openingTrack('vocals', 1, 7)).toEqual({ label: 'Вокал', index: 1, count: 7 })
    expect(openingTrack('bass', 3, 7)).toEqual({ label: 'Бас', index: 3, count: 7 })
    expect(openingTrack('custom-backing', 7, 7, 'My backing voices')).toEqual({
      label: 'My backing voices', index: 7, count: 7,
    })
    i18nSetLocale('en')
    expect(openingTrack('vocals', 1, 7).label).toBe('Vocals')
  } finally { i18nSetLocale(previous) }
})

it.each(['en', 'ru', 'zh-CN', 'zh-TW', 'es-419', 'pt-BR', 'tr', 'hi', 'ja', 'ko', 'th', 'id', 'vi', 'fil', 'ms'] as const)(
  'uses the existing mixer stem names in %s', locale => {
    const previous = getLocale()
    try {
      i18nSetLocale(locale)
      for (const id of ['original', 'vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const)
        expect(openingTrack(id, 1, 7).label).toBe(t(`phone.player.stem.${id}`))
    } finally { i18nSetLocale(previous) }
  },
)
