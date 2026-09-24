/* Русский — the `phone.app` strings, typed against English. */
import type { app as en } from '../en/app'
import type { Translation } from '../../../../src/shared/i18n/types'

export const app: Translation<typeof en> = {
  // ── bottom tabs (App.tsx tab screens + ui/BottomTabs.tsx fallback labels) ──
  'phone.app.tab.songs': 'Песни',
  'phone.app.tab.train': 'Тренировка',

  // ── root navigator (ui/RootNavigator.tsx) ──
  'phone.app.metronomeNotSaved': 'Настройка метронома не сохранена',

  // ── settings screen (ui/SettingsScreen.tsx) ──
  'phone.app.settings.title': 'Настройки',
  'phone.app.settings.checking': 'Проверка нативного воспроизведения…',
  'phone.app.settings.closeA11y': 'Закрыть настройки',
  'phone.app.settings.done': 'Готово',
  // section header, all caps by design
  'phone.app.settings.sectionAudio': 'АУДИО',
  'phone.app.settings.nativePlaybackName': 'Нативное воспроизведение',
  // small badge next to the feature name, all caps by design
  'phone.app.settings.nativePlaybackBadge': 'ПО УМОЛЧАНИЮ',
  'phone.app.settings.nativePlaybackDescription':
    'Воспроизводит подходящие проекты с дорожками и добавленными треками через zcore + zdsp. Нативное воспроизведение включает управление воспроизведением, высоту тона, темп, петлю, метроном, отсчёт и тренировку; неподдерживаемые форматы файлов остаются на обычном плеере.',
  'phone.app.settings.unsupportedPlatform': 'Нативное воспроизведение недоступно на этой платформе.',
  'phone.app.settings.nativePlaybackA11y': 'Нативное воспроизведение',
  'phone.app.settings.nativePlaybackNote':
    'Подходящие песни используют обычные элементы управления плеера, но с нативной DSP-обработкой. Остальные песни полностью остаются на обычном плеере.',

  // ── log panel chrome (ui/LogPanel.tsx) — log LINES themselves stay English ──
  'phone.app.log.title': 'Журнал',
  'phone.app.log.lines_one': '{n} строка',
  'phone.app.log.lines_few': '{n} строки',
  'phone.app.log.lines_many': '{n} строк',
  'phone.app.log.lines_other': '{n} строки',
  'phone.app.log.share': 'Поделиться',
  'phone.app.log.shareA11y': 'Поделиться журналом',
  'phone.app.log.clear': 'Очистить',
  'phone.app.log.clearA11y': 'Очистить журнал',
  'phone.app.log.close': 'Закрыть',
  'phone.app.log.closeA11y': 'Закрыть журнал',
  'phone.app.log.confirmTitle': 'Очистить журнал?',
  'phone.app.log.confirmBody': 'Это единственная запись того, что делало приложение.',
  'phone.app.log.keepIt': 'Оставить',
  'phone.app.log.empty': 'Пока ничего не записано.',

  // ── training cue errors (engine.ts playTrainingCues) — read out by
  //    ui/TrainingScreen.tsx when a reference tone or training cue fails ──
  'phone.app.engine.pausedInBackground': 'Звук приостановлен, пока SingZ работает в фоне.',
  'phone.app.engine.outputOwnedBySong': 'Воспроизведение песни сейчас занимает аудиовыход iPhone.',
  'phone.app.engine.cueCancelled': 'Тренировочный сигнал отменён.',

  // ── native playback status (playback/native.ts settingsStatus(), read by
  //    ui/SettingsScreen.tsx as the status line under the toggle) ──
  'phone.app.native.status.unavailablePlatform': 'Нативное воспроизведение недоступно на этой платформе.',
  'phone.app.native.status.noBridge': 'Эта сборка не содержит нативный мост воспроизведения.',
  'phone.app.native.status.missingCapability':
    'В подключённой нативной среде выполнения отсутствует необходимая функция воспроизведения.',
  // {message} is the caught error's own text
  'phone.app.native.status.failed': 'Не удалось получить статус нативного воспроизведения: {message}',

  // ── native playback load/prepare failures (playback/native.ts load()),
  //    surfaced by ui/CatalogScreen.tsx's error banner when opening a song ──
  'phone.app.native.cleanupBlockedLegacy':
    'Не удалось точно завершить нативное воспроизведение. Обычное воспроизведение остаётся заблокированным.',
  'phone.app.native.cleanupNextNotOpened':
    'Не удалось точно завершить нативное воспроизведение. Следующая песня не была открыта.',
  // {message} is the caught error's own text
  'phone.app.native.prepareFailed': 'Не удалось подготовить нативное воспроизведение: {message}',
  // {message} is the native core's own refusal text
  'phone.app.native.prepareRefused': 'Нативная подготовка отклонила песню: {message}',
  // {message} is the caught error's own text
  'phone.app.native.prepareStatusFailed': 'Не удалось получить статус нативной подготовки: {message}',
  'phone.app.native.prepareInconsistent': 'Нативная подготовка вернула несогласованный статус сессии.',
  // internal state also compared with === elsewhere in native.ts; keep in
  // sync if this value's shape ever changes
  // {reason} is a short internal cause (e.g. "cancelled prepare")
  'phone.app.native.cleanupUncertain':
    'Не удалось точно завершить нативное воспроизведение ({reason}). Переход на обычное воспроизведение заблокирован, чтобы избежать конфликта аудиовыходов.',
  // {detail} is the caught error's own text
  'phone.app.native.suspendLegacyFailed':
    'Нативное воспроизведение не смогло приостановить обычный вывод звука перед захватом аудиосессии: {detail}',
  'phone.app.native.noOutput': 'Нативный аудиовыход недоступен.',
  'phone.app.native.unavailable': 'Нативное воспроизведение недоступно.',
  'phone.app.native.focusLost':
    'Нативный звук остановился, потому что Android изменил фокус звука или маршрут вывода. Нажмите «Воспроизвести», чтобы повторить.',
  // {reason} is a short internal cause reported by the native session
  'phone.app.native.stoppedReasonRetry': 'Нативный звук остановился: {reason}. Нажмите «Воспроизвести», чтобы повторить.',
  // {reason} is a short internal cause; the sentence continues with a fixed tail
  'phone.app.native.outputDidNotOpen':
    'Нативный выход не открылся: {reason}. Воспроизведение на нативном движке остаётся остановленным.',
  'phone.app.native.unloadUncertainPublished':
    'Не удалось точно выгрузить нативное воспроизведение: владение по-прежнему объявлено нативным.',
  'phone.app.native.unloadUncertainNotStarted':
    'Не удалось точно выгрузить нативное воспроизведение: другой движок воспроизведения не был запущен.',
  'phone.app.native.unloadUncertainBlocked':
    'Не удалось точно выгрузить нативное воспроизведение: нативное владение остаётся заблокированным.',
  'phone.app.native.outputStreamNotReleased':
    'Не удалось освободить нативный аудиопоток после перехода в фоновый режим.',

  // ── native playback loading progress (playback/native.ts materializeNativeProject,
  //    read by ui/CatalogScreen.tsx's loading banner while a song opens) ──
  'phone.app.native.progress.releasingLastSong': 'Освобождаем предыдущую песню…',
  'phone.app.native.progress.buildingGraph': 'Строим граф обработки звука…',
  // {label} is a track/lane name (already resolved and translated elsewhere), {index}/{count} are 1-based
  'phone.app.native.progress.fetchingTrack': 'Загружаем {label} · {index}/{count}',
  'phone.app.native.progress.fetchingLyrics': 'Загружаем текст песни…'
}
