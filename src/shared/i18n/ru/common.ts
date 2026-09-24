/* Русский — the `common` strings, typed against English. */
import type { common as en } from '../en/common'
import type { Translation } from '../types'

export const common: Translation<typeof en> = {
  'lang.en': 'Английский',
  'lang.ru': 'Русский',
  'lang.zh-CN': 'Упрощённый китайский',
  'lang.system': 'Системный',
  'lang.systemHint': 'Как в {os} · {name}',
  'lang.auto': 'авто',
  'lang.label': 'Язык',

  'stem.original': 'Оригинал',
  'stem.vocals': 'Вокал',
  'stem.drums': 'Барабаны',
  'stem.bass': 'Бас',
  'stem.guitar': 'Гитара',
  'stem.piano': 'Клавиши',
  'stem.other': 'Инструменты',

  'key.major': '{tonic} мажор',
  'key.minor': '{tonic} минор',

  'interval.perfect.unison': 'чистый унисон',
  'interval.augmented.unison': 'увеличенный унисон',
  'interval.diminished.unison': 'уменьшённый унисон',
  'interval.major.second': 'большая секунда',
  'interval.minor.second': 'малая секунда',
  'interval.augmented.second': 'увеличенная секунда',
  'interval.diminished.second': 'уменьшённая секунда',
  'interval.major.third': 'большая терция',
  'interval.minor.third': 'малая терция',
  'interval.augmented.third': 'увеличенная терция',
  'interval.diminished.third': 'уменьшённая терция',
  'interval.perfect.fourth': 'чистая кварта',
  'interval.augmented.fourth': 'увеличенная кварта',
  'interval.diminished.fourth': 'уменьшённая кварта',
  'interval.perfect.fifth': 'чистая квинта',
  'interval.augmented.fifth': 'увеличенная квинта',
  'interval.diminished.fifth': 'уменьшённая квинта',
  'interval.major.sixth': 'большая секста',
  'interval.minor.sixth': 'малая секста',
  'interval.augmented.sixth': 'увеличенная секста',
  'interval.diminished.sixth': 'уменьшённая секста',
  'interval.major.seventh': 'большая септима',
  'interval.minor.seventh': 'малая септима',
  'interval.augmented.seventh': 'увеличенная септима',
  'interval.diminished.seventh': 'уменьшённая септима',
  'interval.perfect.octave': 'чистая октава',
  'interval.augmented.octave': 'увеличенная октава',
  'interval.diminished.octave': 'уменьшённая октава'
}
