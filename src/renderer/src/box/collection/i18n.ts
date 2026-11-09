import { lookup, register } from '../../../../shared/i18n/core'
import type { Vars } from '../../../../shared/i18n/rules'

/** Collection-owned copy, registered like journeys/i18n.ts so the shared Box dictionary stays untouched. */
const en = {
  'collection.unavailableProject': 'Unavailable project',
  'collection.unavailableDriveProject': 'Unavailable Drive project',
  'collection.driveReadFailed': 'Google Drive projects could not be read.',
  'collection.noLocalCopy': 'This song has no local copy on this Box.',
  'collection.superseded': 'A newer check of this song replaced this one. Try again.',
  'collection.missing': 'This project is no longer in the collection.',
  'collection.unavailable': 'This project is unavailable.',
  'collection.downloadBusy': 'Another download is still settling. Cancel it and wait before retrying.',
  'collection.signInFirst': 'Sign in to Google Drive before downloading.',
  'collection.noDownloadResult': 'The download returned no local project.',
  'collection.notInLibrary': 'The downloaded project was not returned by the local library.'
} as const

const ru: Record<keyof typeof en, string> = {
  'collection.unavailableProject': 'Недоступный проект',
  'collection.unavailableDriveProject': 'Недоступный проект Drive',
  'collection.driveReadFailed': 'Не удалось прочитать проекты Google Drive.',
  'collection.noLocalCopy': 'На этом Box нет локальной копии этой песни.',
  'collection.superseded': 'Эту проверку песни заменила более новая. Попробуйте ещё раз.',
  'collection.missing': 'Этого проекта больше нет в коллекции.',
  'collection.unavailable': 'Этот проект недоступен.',
  'collection.downloadBusy': 'Другая загрузка ещё завершается. Отмените её и подождите, прежде чем повторить.',
  'collection.signInFirst': 'Войдите в Google Drive, чтобы загружать песни.',
  'collection.noDownloadResult': 'Загрузка не вернула локальный проект.',
  'collection.notInLibrary': 'Локальная библиотека не нашла загруженный проект.'
}

const zh: Record<keyof typeof en, string> = {
  'collection.unavailableProject': '不可用的项目',
  'collection.unavailableDriveProject': '不可用的 Drive 项目',
  'collection.driveReadFailed': '无法读取 Google Drive 项目。',
  'collection.noLocalCopy': '此 Box 上没有这首歌的本地副本。',
  'collection.superseded': '这首歌的检查已被更新的检查取代，请重试。',
  'collection.missing': '此项目已不在曲库中。',
  'collection.unavailable': '此项目不可用。',
  'collection.downloadBusy': '另一个下载仍在结束中。请取消并等待后再重试。',
  'collection.signInFirst': '下载前请先登录 Google Drive。',
  'collection.noDownloadResult': '下载未返回本地项目。',
  'collection.notInLibrary': '本地曲库未找到已下载的项目。'
}

register('en', en)
register('ru', ru)
register('zh-CN', zh)
export type CollectionKey = keyof typeof en
export const collectionEnglish = en
export const collectionRussian = ru
export const collectionChinese = zh
export function tCollection(key: CollectionKey, vars?: Vars): string {
  return lookup(key, vars)
}
