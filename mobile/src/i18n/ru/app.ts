/* Русский — the `phone.app` strings, typed against English. */
import type { app as en } from '../en/app'
import type { Translation } from '../../../../src/shared/i18n/types'

export const app: Translation<typeof en> = {
  // ── bottom tabs (App.tsx tab screens + ui/BottomTabs.tsx fallback labels) ──
  'phone.app.tab.songs': 'Песни',
  'phone.app.tab.train': 'Тренировка',

  // ── root navigator (ui/RootNavigator.tsx) ──
  'phone.app.metronomeNotSaved': 'Метроном не сохранён',

  // ── settings screen (ui/SettingsScreen.tsx) ──
  'phone.app.settings.title': 'Настройки',
  'phone.app.settings.checking': 'Проверяем нативный плеер…',
  'phone.app.settings.closeA11y': 'Закрыть',
  'phone.app.settings.done': 'Готово',
  // section header, all caps by design
  'phone.app.settings.sectionAudio': 'АУДИО',
  'phone.app.settings.nativePlaybackName': 'Нативное аудио',
  // small badge next to the feature name, all caps by design
  'phone.app.settings.nativePlaybackBadge': 'ОСНОВНОЙ',
  'phone.app.settings.nativePlaybackDescription':
    'Воспроизводит подходящие проекты с дорожками и треками через zcore + zdsp: управление, высота тона, темп, петля, метроном, отсчёт и тренировка. Неподдерживаемые форматы — на обычном плеере.',
  'phone.app.settings.unsupportedPlatform': 'Нативное воспроизведение недоступно здесь.',
  'phone.app.settings.nativePlaybackA11y': 'Нативное аудио',
  'phone.app.settings.nativePlaybackNote':
    'Подходящие песни используют обычные элементы плеера, но с нативной DSP-обработкой. Остальные — на обычном плеере.',

  // ── log panel chrome (ui/LogPanel.tsx) — log LINES themselves stay English ──
  'phone.app.log.title': 'Журнал',
  'phone.app.log.lines_one': '{n} строка',
  'phone.app.log.lines_few': '{n} строки',
  'phone.app.log.lines_many': '{n} строк',
  'phone.app.log.lines_other': '{n} строки',
  'phone.app.log.share': 'Поделиться',
  'phone.app.log.shareA11y': 'Поделиться',
  'phone.app.log.clear': 'Очистить',
  'phone.app.log.clearA11y': 'Очистить',
  'phone.app.log.close': 'Закрыть',
  'phone.app.log.closeA11y': 'Закрыть',
  'phone.app.log.confirmTitle': 'Очистить всё?',
  'phone.app.log.confirmBody': 'Это единственная запись действий приложения.',
  'phone.app.log.keepIt': 'Отмена',
  'phone.app.log.empty': 'Пока пусто.',

  // ── training cue errors (engine.ts playTrainingCues) — read out by
  //    ui/TrainingScreen.tsx when a reference tone or training cue fails ──
  'phone.app.engine.pausedInBackground': 'Звук приостановлен, пока SingZ работает в фоне.',
  'phone.app.engine.outputOwnedBySong': 'Воспроизведение песни занимает аудиовыход iPhone.',
  'phone.app.engine.cueCancelled': 'Сигнал тренировки отменён.',

  // ── native playback status (playback/native.ts settingsStatus(), read by
  //    ui/SettingsScreen.tsx as the status line under the toggle) ──
  'phone.app.native.status.unavailablePlatform': 'Нативное воспроизведение недоступно здесь.',
  'phone.app.native.status.noBridge': 'Эта сборка не содержит нативный мост воспроизведения.',
  'phone.app.native.status.missingCapability':
    'В нативной среде выполнения нет нужной функции воспроизведения.',
  // {message} is the caught error's own text
  'phone.app.native.status.failed': 'Ошибка статуса: {message}',

  // ── native playback load/prepare failures (playback/native.ts load()),
  //    surfaced by ui/CatalogScreen.tsx's error banner when opening a song ──
  'phone.app.native.cleanupBlockedLegacy':
    'Нативное закрытие неточно. Обычное — заблокировано.',
  'phone.app.native.cleanupNextNotOpened':
    'Нативное закрытие неточно. Следующая песня не открыта.',
  // {message} is the caught error's own text
  'phone.app.native.prepareFailed': 'Ошибка подготовки: {message}',
  // {message} is the native core's own refusal text
  'phone.app.native.prepareRefused': 'Подготовка отклонила песню: {message}',
  // {message} is the caught error's own text
  'phone.app.native.prepareStatusFailed': 'Ошибка статуса подготовки: {message}',
  'phone.app.native.prepareInconsistent': 'Нативная подготовка вернула неверный статус сессии.',
  // internal state also compared with === elsewhere in native.ts; keep in
  // sync if this value's shape ever changes
  // {reason} is a short internal cause (e.g. "cancelled prepare")
  'phone.app.native.cleanupUncertain':
    'Нативное воспроизведение не завершилось ({reason}). Переход на обычный плеер заблокирован — риск конфликта аудио.',
  // {detail} is the caught error's own text
  'phone.app.native.suspendLegacyFailed':
    'Нативное воспроизведение не остановило обычный звук перед захватом аудиосессии: {detail}',
  'phone.app.native.noOutput': 'Нативный аудиовыход недоступен.',
  'phone.app.native.unavailable': 'Нативный плеер недоступен.',
  'phone.app.native.focusLost': 'Android сменил фокус или маршрут звука — звук остановлен. Нажмите «Воспроизвести».',
  // {reason} is a short internal cause reported by the native session
  'phone.app.native.stoppedReasonRetry': 'Остановлен: {reason}. Нажмите «Воспроизвести».',
  // {reason} is a short internal cause; the sentence continues with a fixed tail
  'phone.app.native.outputDidNotOpen':
    'Нативный выход не открылся: {reason}. Воспроизведение на нативном движке остановлено.',
  'phone.app.native.unloadUncertainPublished':
    'Выгрузка неточна: владение остаётся нативным.',
  'phone.app.native.unloadUncertainNotStarted':
    'Выгрузка неточна: другой движок не запущен.',
  'phone.app.native.unloadUncertainBlocked':
    'Выгрузка неточна: владение заблокировано.',
  'phone.app.native.outputStreamNotReleased':
    'Не удалось освободить нативный аудиопоток после перехода в фоновый режим.',

  // ── native playback loading progress (playback/native.ts materializeNativeProject,
  //    read by ui/CatalogScreen.tsx's loading banner while a song opens) ──
  'phone.app.native.progress.releasingLastSong': 'Закрываем прошлую песню…',
  'phone.app.native.progress.buildingGraph': 'Строим звуковой граф…',
  // {label} is a track/lane name (already resolved and translated elsewhere), {index}/{count} are 1-based
  'phone.app.native.progress.fetchingTrack': 'Грузим {label} · {index}/{count}',
  'phone.app.native.progress.fetchingLyrics': 'Текст песни…'
}
