/* Русский — the `settings` strings, typed against English. */
import type { settings as en } from '../en/settings'
import type { Translation } from '../types'

export const settings: Translation<typeof en> = {
  // ── shared actions/labels, reused across dialogs in this namespace ──
  'settings.action.close': 'Закрыть',
  'settings.common.systemDefault': 'По умолчанию',
  'settings.common.savedDeviceMissing': 'Сохранённое (не подключено)',

  // ── SettingsModal: shell ──
  'settings.title': 'Настройки',
  'settings.tab.audio': 'Звук',
  'settings.devicesLoading': 'Поиск аудиоустройств…',
  'settings.inputLabelsHiddenHint': 'Разрешите доступ к микрофону, чтобы видеть имена устройств.',
  'settings.nonDefaultSpeakerTip': 'Совет: на нестандартных динамиках пойте в наушниках — эхоподавление следит только за системным выводом.',

  // ── SettingsModal: playback output device ──
  'settings.output.label': 'Вывод звука',
  'settings.output.confirming': 'Подтверждение маршрута…',
  // fallback status text when there is no more specific route error to show
  'settings.output.unconfirmedFallback': 'Маршрут не подтверждён.',
  'settings.output.retrying': 'Повтор…',
  'settings.output.retryRoute': 'Повторить маршрут',
  'settings.output.unconfirmedStatus': 'Маршрут не подтверждён — выберите вывод или повторите попытку',
  'settings.output.stillUnconfirmed': 'Маршрут ещё не подтверждён. Можно повторить.',
  'settings.output.retryBlocked': 'Повтор маршрута вывода недоступен, пока не подтверждена очистка звука.',

  // ── SettingsModal: native DSP playback checkbox ──
  'settings.playback.useNativeLabel': 'Нативное воспроизведение DSP',
  'settings.playback.hint': 'Использует нативный провайдер, когда песня точно совпадает с нативным графом.',

  // ── SettingsModal: Windows audio provider ──
  'settings.windows.providerLabel': 'Аудиопровайдер Windows',
  // "WASAPI" is the Windows audio API's own name, kept as-is
  'settings.windows.wasapiOption': 'Звук системы (WASAPI)',
  // {detail} is a technical reason string reported by the OS, not translated
  'settings.windows.asioUnavailable': 'ASIO недоступен: {detail}',

  // ── SettingsModal: microphone strip ──
  'settings.mic.label': 'Микрофон',
  'settings.mic.channelLabel': 'Входной канал',
  'settings.mic.monoInput': 'Моно-вход · канал 1',
  'settings.mic.levelLabel': 'Уровень',
  'settings.mic.channelLevelAriaLabel': 'Уровень канала микрофона',
  // shown while the mic preview is still connecting
  'settings.mic.startingPreview': 'Запуск предпросмотра…',
  'settings.mic.unavailableTrainingCleanup': 'Недоступно, пока идёт очистка звука вокальной тренировки.',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': 'Нет сигнала, канал {channel}',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '{dbfs} дБFS на канале {channel}',
  'settings.mic.pausedByOtherOwner': 'Предпросмотр приостановлен другим владельцем звука.',
  // {device} is the microphone's label, {channel}/{count} are 1-based channel numbers
  'settings.mic.listeningThrough': 'Слушаем через {device} · канал {channel} из {count}',
  // fallback device name when the microphone has no label
  'settings.mic.theMicrophoneFallback': 'микрофон',
  'settings.mic.previewOpening': 'Идёт открытие предпросмотра.',
  'settings.mic.fallbackWarning': 'Сохранённый микрофон недоступен — используется системный.',
  // {channel} is a 1-based channel number
  'settings.mic.channelFallbackWarning': 'Этот канал недоступен — предпросмотр канала {channel}.',
  // {reason} is a short technical explanation reported by the OS
  'settings.mic.fallbackNotice':
    'Используется захват через браузер, а не нативный. {reason} Он может открывать меньше входных каналов. Активный вход: {label}, канал {channel} из {count}.',
  // fallback label when the active input device has no name
  'settings.mic.fallbackDeviceLabel': 'микрофон',
  'settings.mic.nativeCapture': 'Нативный захват микрофона',
  // {error} is a technical reason string reported by the OS
  'settings.mic.nativeUnavailable': 'Нативный захват микрофона недоступен: {error} Браузер может открывать меньше каналов.',

  // channel-count unit abbreviation shown after a device's channel count, e.g. "2 ch"
  'settings.mic.channelsUnit': 'кан.',

  // ── subjects for RetainedAudioControl status labels ──
  'settings.subject.microphone': 'Микрофон',
  'settings.subject.songPlayback': 'Воспроизведение',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': 'Микрофон отключился. Переподключите его или выберите другой вход.',
  'settings.mic.channelRoutePending': 'Подождите подключения микрофона, прежде чем выбирать канал.',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': 'Открытие настроек…',
  'settings.route.failedTitle': 'Настройки не открыты',
  'settings.route.restartHint': 'Перезапустите SingZ и откройте настройки снова.',
  'settings.route.failure.none': 'Не удалось загрузить настройки звука. Предпросмотр не начат.',
  'settings.route.stoppedTitle': 'Настройки звука стоп',
  'settings.route.offMessage': 'В настройках звука произошла ошибка, и они безопасно закрыты. Повторите попытку или закройте окно.',
  'settings.route.retrySettingsButton': 'Повторить',

  // ── SetupWizard.tsx: model manager / first-run setup ──
  'settings.wizard.settingUpTitle': 'Настройка SingZ',
  'settings.wizard.aiModelsTitle': 'Модели ИИ',
  'settings.wizard.intro': 'SingZ запускает ИИ на устройстве. Модели загружаются раз в общую папку и переиспользуются.',
  // shown next to a model that has finished installing; keep the ✓ mark
  'settings.wizard.installedBadge': 'готово ✓',
  'settings.wizard.reinstallTitle': 'Скачать и установить снова — если установка есть, но не работает',
  'settings.wizard.reinstallButton': 'Переустановить',
  // {mb} is a download size in megabytes
  'settings.wizard.getButton': '{mb} МБ',
  'settings.wizard.engineLabel': 'Движок разделения',
  'settings.wizard.gpuTitle': 'Сначала попробовать видеокарту, при сбое перейти на процессор',
  'settings.wizard.cpuTitle': 'Только процессор',
  // {reason} is a short technical reason code reported by the app, not translated
  'settings.wizard.gpuAutoOff': 'Видеокарта отключена автоматически ({reason}) — выберите GPU снова.',
  'settings.wizard.cpuOnly': 'Используется только процессор.',
  'settings.wizard.autoDescription': 'Разделение сначала пробует видеокарту, а при сбое переходит на процессор.',
  'settings.wizard.tryAgainButton': 'Повтор',
  'settings.wizard.skipButton': 'Пропустить',

  // ── SetupModal.tsx: Demucs one-time setup ──
  'settings.demucs.title': 'Для разделения нужен Demucs',
  // first half of a sentence that continues with a bolded "Demucs" (<strong>)
  // and then settings.demucs.introAfter — the three form one sentence
  'settings.demucs.introBefore': 'SingZ:',
  'settings.demucs.introAfter':
    '— бесплатную модель с открытым кодом на вашем компьютере — чтобы делить песни на дорожки. Разовая настройка в терминале:',
  'settings.demucs.copiedBadge': 'Готово ✓',
  'settings.demucs.copyButton': 'Копировать',
  // first half of a sentence that continues with a <code>brew install pipx</code>
  // and then settings.demucs.pipxAfter — the three form one sentence
  'settings.demucs.pipxBefore': 'Нужны Python 3.10–3.13 и pipx (',
  'settings.demucs.pipxAfter': '). Первое разделение загрузит модель (~80 МБ); песня займёт пару минут CPU.',
  'settings.demucs.checkingButton': 'Проверка…',
  'settings.demucs.recheckButton': 'Проверить',
  'settings.demucs.githubLink': 'Demucs на GitHub ↗',

  // ── RetainedAudioControl.tsx ──
  'settings.persistentMonitor.needsAttention': 'Требует внимания',
  'settings.persistentMonitor.stopButton': 'Стоп',

  // ── LazyDialogRoute.tsx: generic lazy-loaded dialog scaffolding ──
  'settings.dialogRoute.retryButton': 'Повтор',
  'settings.dialogRoute.recoveryFailed': 'Резервную копию тоже не загрузить. Перезапустите SingZ и попробуйте снова.',
  // {name} is the dialog's own name (e.g. "Settings")
  'settings.dialogRoute.stoppedTitle': '«{name}» стоп',
  'settings.dialogRoute.runtimeProblem': 'В этом окне произошла проблема. Уже начатая работа может всё ещё выполняться.',
  'settings.dialogRoute.keepOpenHint': 'Не закрывайте SingZ, пока операция не завершится.',

  // ── audio/devices.ts: placeholder names for unnamed devices ──
  'settings.devices.microphone': 'Микрофон',
  'settings.devices.speakers': 'Динамики',

  // ── audio/mic-preview.ts: microphone preview errors ──
  'settings.micPreview.accessBlockedShort': 'Доступ к микрофону закрыт.',
  'settings.micPreview.failed': 'Предпросмотр не удался.',
  'settings.micPreview.accessBlocked': 'Доступ к микрофону закрыт. Разрешите SingZ в приватности системы.',
  'settings.micPreview.busy': 'Микрофон занят другим приложением. Закройте это приложение и выберите вход снова.',
  'settings.micPreview.unavailable': 'Этот микрофон недоступен. Переподключите его или выберите другой вход.',
  'settings.micPreview.unknown': 'Микрофон не запустился. Проверьте подключение и повторите.'
}
