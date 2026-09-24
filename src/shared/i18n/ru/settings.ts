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
  'settings.playback.useNativeLabel': 'Нативный плейбэк DSP',
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
  'settings.mic.usedByMonitoring': 'Используется мониторингом',
  'settings.mic.unavailableTrainingCleanup': 'Недоступно, пока идёт очистка звука вокальной тренировки.',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': 'Нет сигнала, канал {channel}',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '{dbfs} дБFS на канале {channel}',
  'settings.mic.pausedByOtherOwner': 'Предпросмотр приостановлен другим владельцем звука.',
  'settings.mic.pausedByMonitoring': 'Предпросмотр приостановлен: активен мониторинг в наушниках.',
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

  // ── SettingsModal: headphone monitoring section ──
  'settings.monitor.heading': 'Монитор в наушниках',
  'settings.monitor.subheading': 'Слышать микрофон через граф DSP',
  'settings.monitor.experimentalBadge': 'Тестовое',
  'settings.monitor.nativeInputLabel': 'Вход мониторинга',
  'settings.monitor.chooseNativeDevice': 'Выбрать нативное устройство…',
  'settings.monitor.savedInputMissing': 'Сохранённый вход (не подключён)',
  'settings.monitor.osUidHint': 'Это UID устройства ОС. SingZ не сопоставляет его по имени Chromium.',
  'settings.monitor.outputLabel': 'Вывод через интерфейс',
  'settings.monitor.choosePlaybackDevice': 'Выбрать выход…',
  'settings.monitor.savedOutputMissing': 'Сохранённый выход (не подключён)',
  'settings.monitor.micChannelLabel': 'Канал микрофона',
  'settings.monitor.playbackLeft': 'Выход Л',
  'settings.monitor.playbackRight': 'Выход П',
  'settings.monitor.playbackGeneric': 'Выход',
  'settings.monitor.playbackLeftChannel': 'Левый канал плейбэка',
  'settings.monitor.playbackRightChannel': 'Правый канал плейбэка',
  'settings.monitor.playbackChannelGeneric': 'Канал плейбэка',
  'settings.monitor.gainLabel': 'Усиление',
  'settings.monitor.headphonesConfirmLabel': 'Наушники подключены проводом к устройству',
  'settings.monitor.stopButton': 'Стоп монитор',
  'settings.monitor.preparingButton': 'Готовим…',
  'settings.monitor.startButton': 'Старт монитор',
  'settings.monitor.notReported': 'Не сообщено',
  // {frames} is a frame count
  'settings.monitor.framesValue': '{frames} кадров',
  'settings.monitor.framesProviderReported': '{frames} кадров · от провайдера',
  'settings.monitor.unknownNotMeasured': 'Неизвестно, без замера',
  // channel-count unit abbreviations, e.g. "2 ch", "3 in", "2 out"
  'settings.monitor.channelsUnit': 'кан.',
  'settings.monitor.inputsUnit': 'вх.',
  'settings.monitor.outputsUnit': 'вых.',
  // the joining word in a list of channel numbers, e.g. "1, 2 and 3"
  'settings.monitor.channelListAnd': 'и',
  'settings.monitor.chooseChannels': 'Выберите физические входные и выходные каналы, доступные на этом устройстве.',
  'settings.monitor.previewMustConfirm': 'Прежде чем начать мониторинг, предпросмотр должен подтвердить это устройство и канал.',
  'settings.monitor.unavailableCleanup': 'Мониторинг недоступен, пока идёт очистка звука другим владельцем.',
  // {channels} is a formatted list of playback channel numbers, e.g. "1 and 2"
  'settings.monitor.zenQuadroHelp':
    'Zen Quadro: в Antelope Control Panel → Monitors & Headphones назначьте USB 1 PLAY {channels} на микшер Monitor/HP1 или Headphones 2.',
  'settings.monitor.playbackLanesHelp':
    'Это дорожки воспроизведения, не физические разъёмы. В микшере интерфейса направьте OUT {channels} на шину наушников.',
  // {channel} is an input channel label, {db} a level in dBFS
  'settings.monitor.signalNearSilenceInput':
    'Мониторинг работает, но {channel} почти в тишине ({db} дБFS). Проверьте входной канал и предусилитель интерфейса, затем пойте в микрофон.',
  'settings.monitor.signalNearSilenceOutput':
    'Микрофон доходит до графа DSP, но его выход почти в тишине ({db} дБFS). Увеличьте усиление монитора.',
  // {channels} is a formatted list of output channel labels, e.g. "OUT 1 and OUT 2"
  'settings.monitor.signalLive':
    'Звук DSP активен: {db} дБFS на {channels}. Если в наушниках тишина, направьте эти дорожки на шину наушников в микшере.',
  'settings.monitor.routeInspecting': 'Проверка аудиомаршрутов…',
  'settings.monitor.routeWindowsUnavailable':
    'Мониторинг пока не доступен в Windows. Список WASAPI показан, но нативный выход в этой версии выключен.',
  'settings.monitor.routePlatformUnavailable': 'Мониторинг пока не доступен на этой десктопной платформе.',
  'settings.monitor.routeChooseInput': 'Выберите вход мониторинга. SingZ не угадывает его по имени устройства.',
  'settings.monitor.routeChooseOutput': 'Выберите устройство вывода.',
  'settings.monitor.routeNeedsSameDuplexDevice': 'В macOS микрофон и наушники должны быть на одном дуплексном устройстве.',
  'settings.monitor.routeHighLatency': 'Это маршрут с задержкой — беспроводной или автомобильный. Выберите проводные наушники.',
  'settings.monitor.routeNotApproved': 'Маршрут не подходит для мониторинга с низкой задержкой. Выберите проводное устройство.',
  // {device} is the playback device's label
  'settings.monitor.routeApproved': '{device} подходит для дуплексного мониторинга.',
  // {subject} is a translated word/phrase supplied by the caller at call
  // time (see settings.subject.* below).
  'settings.monitor.audioSafetyBlocked': '{subject}: недоступно, пока звук занят или идёт смена маршрута. Откройте настройки, чтобы проверить владельца или повторить маршрут.',

  // ── audioSafetyBlockedCopy() subjects: the {subject} passed into settings.monitor.audioSafetyBlocked ──
  'settings.subject.microphone': 'Микрофон',
  'settings.subject.trainingAudio': 'Тренировка',
  'settings.subject.songPlayback': 'Воспроизведение',

  // ── SettingsModal: native host diagnostics panel ──
  'settings.monitor.diagnosticsAriaLabel': 'Диагностика узла',
  'settings.monitor.diagnostic.inputDevice': 'Вход',
  'settings.monitor.diagnostic.buffer': 'Буфер',
  'settings.monitor.diagnostic.outputDevice': 'Выход',
  'settings.monitor.diagnostic.externalRoute': 'Внешний путь',
  'settings.monitor.diagnostic.xruns': 'Xruns',
  'settings.monitor.diagnostic.deadlineMisses': 'Пропуски срока',
  'settings.monitor.diagnostic.renderFailures': 'Ошибки рендера',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': 'Микрофон отключился. Переподключите его или выберите другой вход.',
  'settings.mic.channelRoutePending': 'Подождите подключения микрофона, прежде чем выбирать канал.',
  'settings.output.channelRoutePending': 'Подождите подключения устройства, прежде чем выбирать его каналы.',

  // ── audio/monitoring.ts: DesktopMonitorCoordinator status messages ──
  'settings.monitorCoordinator.idle': 'Монитор выключен.',
  'settings.monitorCoordinator.releasing': 'Освобождение микрофона и вывода песни…',
  'settings.monitorCoordinator.startingNative': 'Запуск нативного пути DSP…',
  'settings.monitorCoordinator.active': 'Нативный мониторинг DSP активен.',
  'settings.monitorCoordinator.generationChanged': 'Поколение нативного монитора изменилось до готовности.',
  'settings.monitorCoordinator.deviceDisconnected': 'Устройство мониторинга отключилось. Подключите снова.',
  'settings.monitorCoordinator.hostStopped': 'Узел мониторинга остановился.',
  'settings.monitorCoordinator.callbackTimeout': 'Нативный путь DSP не подтвердил аудиовызов вовремя.',
  'settings.monitorCoordinator.routeStopped': 'Маршрут мониторинга остановился.',
  'settings.monitorCoordinator.stopping': 'Остановка мониторинга…',
  'settings.monitorCoordinator.shutdownUnconfirmed': 'Мониторинг не подтвердил завершение. Вывод песни остаётся освобождён.',
  // {error} is the underlying error's message
  'settings.monitorCoordinator.outputRestoreFailed': 'Не удалось восстановить вывод: {error}',
  'settings.monitorCoordinator.error.platformNotReady': 'Мониторинг пока не доступен в Windows. Нативный выход остался выключен.',
  'settings.monitorCoordinator.error.unsupportedRoute': 'Маршрут не подходит для мониторинга. Выберите проводное устройство.',
  'settings.monitorCoordinator.error.micBusy': 'Микрофон занят. Остановите предпросмотр или упражнение и повторите.',
  'settings.monitorCoordinator.error.queueFull': 'Очередь DSP занята. Подождите и повторите попытку.',
  'settings.monitorCoordinator.error.couldNotStart': 'Не удалось запустить мониторинг.',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': 'Открытие настроек…',
  'settings.route.failedTitle': 'Настройки не открыты',
  'settings.route.restartHint': 'Перезапустите SingZ и откройте настройки снова.',
  'settings.route.failure.none': 'Не удалось загрузить настройки звука. Предпросмотр не начат.',
  'settings.route.failure.appShellStop':
    'Не удалось загрузить настройки звука. Микрофон или наушники заняты; нажмите «Стоп» в верхней панели, чтобы освободить их.',
  'settings.route.failure.routeOnly':
    'Не удалось загрузить настройки звука. Маршрут вывода требует внимания — после перезапуска SingZ откройте настройки, чтобы завершить маршрут перед запуском звука.',
  'settings.route.failure.settingsPreview':
    'Не удалось загрузить настройки звука. Предпросмотр микрофона в настройках занимает устройство; перезапустите SingZ.',
  'settings.route.failure.unknown':
    'Не удалось загрузить настройки звука: не разрешён другой владелец звука. Перезапустите SingZ.',
  'settings.route.unavailableTitle': 'Настройки звука недоступны',
  'settings.route.stoppedTitle': 'Настройки звука стоп',
  'settings.route.confirmingStopped': 'Подтверждение остановки мониторинга в наушниках…',
  'settings.route.unsafeCleanup':
    'Очистка микрофона или мониторинга ещё не подтверждена. Повторите остановку звука, чтобы освободить владельца. Если это не помогает, закройте SingZ перед отключением устройств.',
  'settings.route.pendingMessage':
    'Смена аудиомаршрута продолжается. Отменить её здесь нельзя; дождитесь завершения перед повторным открытием настроек.',
  'settings.route.unconfirmedMessage':
    'Маршрут воспроизведения ещё не подтверждён. Повторите настройки, чтобы выбрать вывод. Запуск звука заблокирован, пока маршрут не восстановлен.',
  'settings.route.offMessage': 'Мониторинг в наушниках выключен. Повторите настройки звука или закройте окно.',
  'settings.route.retryStopButton': 'Повторить стоп',
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

  // ── PersistentMonitorControl.tsx ──
  'settings.persistentMonitor.routeNeedsAttention': 'Маршрут требует внимания',
  'settings.persistentMonitor.changingRoute': 'Смена аудиомаршрута…',
  'settings.persistentMonitor.cleanupNeeded': 'Нужна очистка микрофона',
  'settings.persistentMonitor.starting': 'Запуск монитора',
  'settings.persistentMonitor.stopping': 'Остановка',
  'settings.persistentMonitor.needsAttention': 'Требует внимания',
  'settings.persistentMonitor.micMonitoring': 'Мониторинг',
  'settings.persistentMonitor.openCleanupSettings': 'Открыть очистку звука',
  'settings.persistentMonitor.openRouteSettings': 'Открыть маршрут звука',
  'settings.persistentMonitor.openMonitoringSettings': 'Открыть настройки мониторинга',
  // {label} is the status label above (e.g. "Mic monitoring")
  'settings.persistentMonitor.ariaLabel': '{label}. Новая песня и звук тренировки блокированы. Откройте настройки звука.',
  'settings.persistentMonitor.retryCleanupAria': 'Повторить очистку и освободить звук',
  'settings.persistentMonitor.stopAria': 'Остановить монитор и освободить микрофон',
  'settings.persistentMonitor.stopButton': 'Стоп',
  'settings.persistentMonitor.groupAriaLabel': 'Управление мониторингом',

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
