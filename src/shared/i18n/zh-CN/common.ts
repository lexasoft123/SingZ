/* 简体中文 — the `common` strings, typed against English. */
import type { common as en } from '../en/common'
import type { Translation } from '../types'

export const common: Translation<typeof en> = {
  'lang.en': '英语',
  'lang.ru': '俄语',
  'lang.zh-CN': '简体中文',
  'lang.system': '跟随系统',
  'lang.systemHint': '跟随 {os} · {name}',
  'lang.auto': '自动',
  'lang.label': '语言',

  'stem.original': '完整混音',
  'stem.vocals': '人声',
  'stem.drums': '鼓',
  'stem.bass': '贝斯',
  'stem.guitar': '吉他',
  'stem.piano': '钢琴',
  'stem.other': '乐器',

  'key.major': '{tonic} 大调',
  'key.minor': '{tonic} 小调',

  'interval.perfect.unison': '纯同度',
  'interval.augmented.unison': '增同度',
  'interval.diminished.unison': '减同度',
  'interval.major.second': '大二度',
  'interval.minor.second': '小二度',
  'interval.augmented.second': '增二度',
  'interval.diminished.second': '减二度',
  'interval.major.third': '大三度',
  'interval.minor.third': '小三度',
  'interval.augmented.third': '增三度',
  'interval.diminished.third': '减三度',
  'interval.perfect.fourth': '纯四度',
  'interval.augmented.fourth': '增四度',
  'interval.diminished.fourth': '减四度',
  'interval.perfect.fifth': '纯五度',
  'interval.augmented.fifth': '增五度',
  'interval.diminished.fifth': '减五度',
  'interval.major.sixth': '大六度',
  'interval.minor.sixth': '小六度',
  'interval.augmented.sixth': '增六度',
  'interval.diminished.sixth': '减六度',
  'interval.major.seventh': '大七度',
  'interval.minor.seventh': '小七度',
  'interval.augmented.seventh': '增七度',
  'interval.diminished.seventh': '减七度',
  'interval.perfect.octave': '纯八度',
  'interval.augmented.octave': '增八度',
  'interval.diminished.octave': '减八度'
}
