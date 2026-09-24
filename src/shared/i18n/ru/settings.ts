/* Русский — the `settings` strings, typed against English. */
import type { settings as en } from '../en/settings'
import type { Translation } from '../types'

export const settings: Translation<typeof en> = {
  // ── shared actions/labels, reused across dialogs in this namespace ──
  'settings.action.close': 'Закрыть',
  'settings.common.systemDefault': 'По умолчанию в системе',
  'settings.common.savedDeviceMissing': 'Сохранённое устройство (не подключено)',

  // ── SettingsModal: shell ──
  'settings.title': 'Настройки',
  'settings.tab.audio': 'Звук',
  'settings.devicesLoading': 'Поиск аудиоустройств…',
  'settings.inputLabelsHiddenHint': 'Разрешите доступ к микрофону в настройках системы, чтобы увидеть названия устройств.',
  'settings.nonDefaultSpeakerTip': 'Совет: на динамиках не по умолчанию пойте в наушниках — подавление эха следит только за системным выводом по умолчанию.',

  // ── SettingsModal: playback output device ──
  'settings.output.label': 'Устройство воспроизведения',
  'settings.output.confirming': 'Подтверждение маршрута воспроизведения…',
  // fallback status text when there is no more specific route error to show
  'settings.output.unconfirmedFallback': 'Маршрут воспроизведения не подтверждён.',
  'settings.output.retrying': 'Повтор попытки…',
  'settings.output.retryRoute': 'Повторить маршрут вывода',
  'settings.output.unconfirmedStatus': 'Не удалось подтвердить маршрут воспроизведения — выберите устройство вывода или повторите попытку',
  'settings.output.stillUnconfirmed': 'Маршрут всё ещё не подтверждён. Можно повторить попытку.',
  'settings.output.retryBlocked': 'Повторная попытка маршрута воспроизведения не может начаться, пока не подтверждена очистка звука.',

  // ── SettingsModal: native DSP playback checkbox ──
  'settings.playback.useNativeLabel': 'Использовать нативное воспроизведение DSP',
  'settings.playback.hint': 'Использует выбранный нативный провайдер, когда особенности песни точно совпадают с нативным графом.',

  // ── SettingsModal: Windows audio provider ──
  'settings.windows.providerLabel': 'Аудиопровайдер Windows',
  // "WASAPI" is the Windows audio API's own name, kept as-is
  'settings.windows.wasapiOption': 'Системный звук (WASAPI)',
  // {detail} is a technical reason string reported by the OS, not translated
  'settings.windows.asioUnavailable': 'ASIO недоступен: {detail}',

  // ── SettingsModal: microphone strip ──
  'settings.mic.label': 'Микрофон',
  'settings.mic.channelLabel': 'Входной канал',
  'settings.mic.monoInput': 'Монофонический вход · канал 1',
  'settings.mic.levelLabel': 'Уровень входа',
  'settings.mic.channelLevelAriaLabel': 'Уровень выбранного канала микрофона',
  // shown while the mic preview is still connecting
  'settings.mic.startingPreview': 'Запуск предпросмотра микрофона…',
  'settings.mic.usedByMonitoring': 'Используется мониторингом в наушниках',
  'settings.mic.unavailableTrainingCleanup': 'Недоступно, пока не завершена очистка звука вокальной тренировки.',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': 'Нет сигнала на канале {channel}',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '{dbfs} дБFS на канале {channel}',
  'settings.mic.pausedByOtherOwner': 'Предпросмотр микрофона приостановлен другим владельцем звука в системе.',
  'settings.mic.pausedByMonitoring': 'Предпросмотр микрофона приостановлен, пока активен мониторинг в наушниках.',
  // {device} is the microphone's label, {channel}/{count} are 1-based channel numbers
  'settings.mic.listeningThrough': 'Слушаем через {device} · канал {channel} из {count}',
  // fallback device name when the microphone has no label
  'settings.mic.theMicrophoneFallback': 'микрофон',
  'settings.mic.previewOpening': 'Идёт открытие предпросмотра микрофона.',
  'settings.mic.fallbackWarning': 'Сохранённый микрофон недоступен — используется системный по умолчанию для предпросмотра.',
  // {channel} is a 1-based channel number
  'settings.mic.channelFallbackWarning': 'Этот канал недоступен — предпросмотр канала {channel}.',
  // {reason} is a short technical explanation reported by the OS
  'settings.mic.fallbackNotice':
    'Используется захват микрофона через браузер вместо нативного захвата. {reason} Захват через браузер может открывать меньше входных каналов. Активный вход: {label}, канал {channel} из {count}.',
  // fallback label when the active input device has no name
  'settings.mic.fallbackDeviceLabel': 'микрофон',
  'settings.mic.nativeCapture': 'Нативный захват микрофона',
  // {error} is a technical reason string reported by the OS
  'settings.mic.nativeUnavailable': 'Нативный захват микрофона недоступен: {error} Захват через браузер может открывать меньше входных каналов.',

  // ── SettingsModal: headphone monitoring section ──
  'settings.monitor.heading': 'Мониторинг в наушниках',
  'settings.monitor.subheading': 'Слышать этот микрофон через нативный граф DSP',
  'settings.monitor.experimentalBadge': 'Экспериментально',
  'settings.monitor.nativeInputLabel': 'Нативный вход мониторинга',
  'settings.monitor.chooseNativeDevice': 'Выбрать конкретное нативное устройство…',
  'settings.monitor.savedInputMissing': 'Сохранённый нативный вход (не подключён)',
  'settings.monitor.osUidHint': 'Это UID аудиоустройства ОС. SingZ никогда не сопоставляет его по имени устройства Chromium.',
  'settings.monitor.outputLabel': 'Воспроизведение через аудиоинтерфейс',
  'settings.monitor.choosePlaybackDevice': 'Выбрать устройство воспроизведения…',
  'settings.monitor.savedOutputMissing': 'Сохранённый нативный выход (не подключён)',
  'settings.monitor.micChannelLabel': 'Канал микрофона',
  'settings.monitor.playbackLeft': 'Воспроизведение Л',
  'settings.monitor.playbackRight': 'Воспроизведение П',
  'settings.monitor.playbackGeneric': 'Воспроизведение',
  'settings.monitor.playbackLeftChannel': 'Левый канал воспроизведения',
  'settings.monitor.playbackRightChannel': 'Правый канал воспроизведения',
  'settings.monitor.playbackChannelGeneric': 'Канал воспроизведения',
  'settings.monitor.gainLabel': 'Усиление монитора',
  'settings.monitor.headphonesConfirmLabel': 'К этому устройству подключены проводные наушники',
  'settings.monitor.stopButton': 'Остановить мониторинг',
  'settings.monitor.preparingButton': 'Подготовка…',
  'settings.monitor.startButton': 'Начать мониторинг',
  'settings.monitor.notReported': 'Не сообщено',
  // {frames} is a frame count
  'settings.monitor.framesValue': '{frames} фреймов',
  'settings.monitor.framesProviderReported': '{frames} фреймов · по данным провайдера',
  'settings.monitor.unknownNotMeasured': 'Неизвестно · не измерено',
  // channel-count unit abbreviations, e.g. "2 ch", "3 in", "2 out"
  'settings.monitor.channelsUnit': 'кан.',
  'settings.monitor.inputsUnit': 'вх.',
  'settings.monitor.outputsUnit': 'вых.',
  // the joining word in a list of channel numbers, e.g. "1, 2 and 3"
  'settings.monitor.channelListAnd': 'и',
  'settings.monitor.chooseChannels': 'Выберите физические входные и выходные каналы, доступные на этом устройстве.',
  'settings.monitor.previewMustConfirm': 'Прежде чем начать мониторинг, предпросмотр микрофона должен подтвердить это конкретное нативное устройство и канал.',
  'settings.monitor.unavailableCleanup': 'Мониторинг недоступен, пока другой владелец звука в системе завершает очистку.',
  // {channels} is a formatted list of playback channel numbers, e.g. "1 and 2"
  'settings.monitor.zenQuadroHelp':
    'Zen Quadro: в Antelope Control Panel → Monitors & Headphones назначьте USB 1 PLAY {channels} на используемый микшер Monitor/HP1 или Headphones 2.',
  'settings.monitor.playbackLanesHelp':
    'Это дорожки воспроизведения, а не названия физических разъёмов. В микшере вашего интерфейса направьте OUT {channels} на используемую шину наушников.',
  // {channel} is an input channel label, {db} a level in dBFS
  'settings.monitor.signalNearSilenceInput':
    'Мониторинг работает, но {channel} почти в тишине ({db} дБFS). Проверьте входной канал и предусилитель интерфейса, затем пойте в микрофон.',
  'settings.monitor.signalNearSilenceOutput':
    'Микрофон доходит до графа DSP, но его выход почти в тишине ({db} дБFS). Увеличьте усиление монитора.',
  // {channels} is a formatted list of output channel labels, e.g. "OUT 1 and OUT 2"
  'settings.monitor.signalLive':
    'Звук DSP активен на уровне {db} дБFS на {channels}. Если в наушниках тишина, направьте эти дорожки воспроизведения на их шину наушников в микшере интерфейса.',
  'settings.monitor.routeInspecting': 'Проверка нативных аудиомаршрутов…',
  'settings.monitor.routeWindowsUnavailable':
    'Мониторинг в наушниках пока не доступен в Windows. Список устройств WASAPI показан, но нативный выход в этой версии остаётся выключенным.',
  'settings.monitor.routePlatformUnavailable': 'Мониторинг в наушниках пока не доступен на этой десктопной платформе.',
  'settings.monitor.routeChooseInput': 'Выберите нативный вход мониторинга. SingZ не станет угадывать его по имени устройства.',
  'settings.monitor.routeChooseOutput': 'Выберите нативное устройство воспроизведения.',
  'settings.monitor.routeNeedsSameDuplexDevice': 'Мониторинг в macOS требует, чтобы микрофон и наушники были на одном дуплексном аудиоустройстве.',
  'settings.monitor.routeHighLatency': 'Это маршрут с задержкой — беспроводной или автомобильного типа. Выберите проводные наушники на устройстве с низкой задержкой.',
  'settings.monitor.routeNotApproved': 'Этот маршрут не подходит для мониторинга с низкой задержкой. Выберите подтверждённое провайдером проводное устройство.',
  // {device} is the playback device's label
  'settings.monitor.routeApproved': '{device} подходит для дуплексного мониторинга с низкой задержкой.',
  // {subject} is a translated word/phrase supplied by the caller at call
  // time (see settings.subject.* below).
  'settings.monitor.audioSafetyBlocked': '{subject}: недоступно, пока активен другой владелец звука или идёт смена маршрута. Откройте настройки, чтобы проверить владельца звука или повторить маршрут вывода.',

  // ── audioSafetyBlockedCopy() subjects: the {subject} passed into settings.monitor.audioSafetyBlocked ──
  'settings.subject.microphone': 'Микрофон',
  'settings.subject.trainingAudio': 'Звук тренировки',
  'settings.subject.songPlayback': 'Воспроизведение песни',

  // ── SettingsModal: native host diagnostics panel ──
  'settings.monitor.diagnosticsAriaLabel': 'Диагностика нативного узла',
  'settings.monitor.diagnostic.inputDevice': 'Устройство ввода',
  'settings.monitor.diagnostic.buffer': 'Буфер',
  'settings.monitor.diagnostic.outputDevice': 'Устройство вывода',
  'settings.monitor.diagnostic.externalRoute': 'Внешний маршрут',
  'settings.monitor.diagnostic.xruns': 'Xruns',
  'settings.monitor.diagnostic.deadlineMisses': 'Пропуски дедлайна',
  'settings.monitor.diagnostic.renderFailures': 'Ошибки рендеринга',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': 'Микрофон отключился. Переподключите его или выберите другой вход.',
  'settings.mic.channelRoutePending': 'Подождите, пока выбранный микрофон подключится, прежде чем выбирать канал.',
  'settings.output.channelRoutePending': 'Подождите, пока выбранное устройство воспроизведения подключится, прежде чем выбирать его каналы.',

  // ── audio/monitoring.ts: DesktopMonitorCoordinator status messages ──
  'settings.monitorCoordinator.idle': 'Мониторинг выключен.',
  'settings.monitorCoordinator.releasing': 'Освобождение микрофона и вывода песни…',
  'settings.monitorCoordinator.startingNative': 'Запуск нативного пути DSP…',
  'settings.monitorCoordinator.active': 'Нативный мониторинг DSP активен.',
  'settings.monitorCoordinator.generationChanged': 'Поколение нативного монитора изменилось до готовности.',
  'settings.monitorCoordinator.deviceDisconnected': 'Устройство мониторинга отключилось. Подключите его снова и начните заново.',
  'settings.monitorCoordinator.hostStopped': 'Нативный узел мониторинга остановился.',
  'settings.monitorCoordinator.callbackTimeout': 'Нативный путь DSP не подтвердил аудиовызов вовремя.',
  'settings.monitorCoordinator.routeStopped': 'Маршрут нативного мониторинга остановился.',
  'settings.monitorCoordinator.stopping': 'Остановка нативного мониторинга…',
  'settings.monitorCoordinator.shutdownUnconfirmed': 'Нативный мониторинг не подтвердил завершение работы. Вывод песни остаётся освобождённым для безопасности.',
  // {error} is the underlying error's message
  'settings.monitorCoordinator.outputRestoreFailed': 'Не удалось восстановить вывод песни: {error}',
  'settings.monitorCoordinator.error.platformNotReady': 'Мониторинг в наушниках пока не доступен в Windows. Нативный выход остался выключенным.',
  'settings.monitorCoordinator.error.unsupportedRoute': 'Этот маршрут не подходит для мониторинга с низкой задержкой. Выберите проводное аудиоустройство.',
  'settings.monitorCoordinator.error.micBusy': 'Микрофон всё ещё используется. Остановите предпросмотр или упражнение, затем попробуйте снова.',
  'settings.monitorCoordinator.error.queueFull': 'Очередь управления DSP занята. Подождите немного и попробуйте снова.',
  'settings.monitorCoordinator.error.couldNotStart': 'Не удалось запустить нативный мониторинг в наушниках.',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': 'Открытие настроек звука…',
  'settings.route.failedTitle': 'Настройки не открылись',
  'settings.route.restartHint': 'Перезапустите SingZ перед новой попыткой открыть настройки.',
  'settings.route.failure.none': 'Не удалось загрузить настройки звука. Предпросмотр настроек не был запущен.',
  'settings.route.failure.appShellStop':
    'Не удалось загрузить настройки звука. Микрофон или звук в наушниках всё ещё занят; используйте кнопку «Стоп» в верхней панели, чтобы освободить его.',
  'settings.route.failure.routeOnly':
    'Не удалось загрузить настройки звука. Маршрут вывода всё ещё требует внимания; после перезапуска SingZ откройте настройки, чтобы завершить или повторить маршрут перед запуском звука.',
  'settings.route.failure.settingsPreview':
    'Не удалось загрузить настройки звука. Предпросмотр микрофона в настройках всё ещё занимает устройство; перезапустите SingZ перед повторным открытием настроек.',
  'settings.route.failure.unknown':
    'Не удалось загрузить настройки звука, пока не разрешён другой владелец звука. Перезапустите SingZ перед повторным открытием настроек.',
  'settings.route.unavailableTitle': 'Настройки звука недоступны',
  'settings.route.stoppedTitle': 'Настройки звука остановлены',
  'settings.route.confirmingStopped': 'Подтверждение остановки нативного мониторинга в наушниках…',
  'settings.route.unsafeCleanup':
    'Очистка микрофона или нативного мониторинга ещё не подтверждена. Повторите остановку звука, чтобы освободить точного владельца. Если очистку всё равно не удаётся подтвердить, закройте SingZ перед отключением устройств.',
  'settings.route.pendingMessage':
    'Смена аудиомаршрута ещё продолжается. Здесь её нельзя безопасно отменить; дождитесь завершения перед повторным открытием настроек.',
  'settings.route.unconfirmedMessage':
    'Физический маршрут воспроизведения ещё не подтверждён. Повторите настройки, чтобы выбрать или подтвердить вывод. Запуск звука остаётся заблокированным, пока этот маршрут не восстановлен.',
  'settings.route.offMessage': 'Нативный мониторинг в наушниках выключен. Можно повторить настройки звука или закрыть это окно.',
  'settings.route.retryStopButton': 'Повторить остановку звука',
  'settings.route.retrySettingsButton': 'Повторить настройки',

  // ── SetupWizard.tsx: model manager / first-run setup ──
  'settings.wizard.settingUpTitle': 'Настройка SingZ',
  'settings.wizard.aiModelsTitle': 'Модели ИИ',
  'settings.wizard.intro': 'SingZ запускает свой ИИ локально. Модели загружаются один раз в общую папку и используются для каждой песни.',
  // shown next to a model that has finished installing; keep the ✓ mark
  'settings.wizard.installedBadge': 'установлено ✓',
  'settings.wizard.reinstallTitle': 'Скачать и установить это снова — исправляет установку, которая есть, но не работает',
  'settings.wizard.reinstallButton': 'Переустановить',
  // {mb} is a download size in megabytes
  'settings.wizard.getButton': 'Скачать · {mb} МБ',
  'settings.wizard.engineLabel': 'Движок разделения',
  'settings.wizard.gpuTitle': 'Сначала попробовать видеокарту, при сбое перейти на процессор',
  'settings.wizard.cpuTitle': 'Разделять только на процессоре',
  // {reason} is a short technical reason code reported by the app, not translated
  'settings.wizard.gpuAutoOff': 'Видеокарта была автоматически отключена ({reason}) — выберите GPU, чтобы попробовать снова.',
  'settings.wizard.cpuOnly': 'Разделение использует только процессор.',
  'settings.wizard.autoDescription': 'Разделение сначала пробует видеокарту, а при сбое переходит на процессор.',
  'settings.wizard.tryAgainButton': 'Попробовать снова',
  'settings.wizard.skipButton': 'Пропустить пока',

  // ── SetupModal.tsx: Demucs one-time setup ──
  'settings.demucs.title': 'Для разделения на дорожки нужен Demucs',
  // first half of a sentence that continues with a bolded "Demucs" (<strong>)
  // and then settings.demucs.introAfter — the three form one sentence
  'settings.demucs.introBefore': 'SingZ использует',
  'settings.demucs.introAfter':
    '— бесплатную AI-модель с открытым кодом, которая работает полностью на вашем компьютере, — чтобы разделять песни на дорожки. Разовая настройка в терминале:',
  'settings.demucs.copiedBadge': 'Скопировано ✓',
  'settings.demucs.copyButton': 'Копировать',
  // first half of a sentence that continues with a <code>brew install pipx</code>
  // and then settings.demucs.pipxAfter — the three form one sentence
  'settings.demucs.pipxBefore': 'Нужны Python 3.10–3.13 и pipx (',
  'settings.demucs.pipxAfter': '). Первое разделение загрузит модель (~80 МБ); обычная песня занимает несколько минут процессорного времени.',
  'settings.demucs.checkingButton': 'Проверка…',
  'settings.demucs.recheckButton': 'Проверить снова',
  'settings.demucs.githubLink': 'Demucs на GitHub ↗',

  // ── PersistentMonitorControl.tsx ──
  'settings.persistentMonitor.routeNeedsAttention': 'Аудиомаршрут требует внимания',
  'settings.persistentMonitor.changingRoute': 'Смена аудиомаршрута…',
  'settings.persistentMonitor.cleanupNeeded': 'Нужна очистка микрофона',
  'settings.persistentMonitor.starting': 'Запуск монитора',
  'settings.persistentMonitor.stopping': 'Остановка монитора',
  'settings.persistentMonitor.needsAttention': 'Монитор требует внимания',
  'settings.persistentMonitor.micMonitoring': 'Мониторинг микрофона',
  'settings.persistentMonitor.openCleanupSettings': 'Открыть настройки очистки звука',
  'settings.persistentMonitor.openRouteSettings': 'Открыть настройки аудиомаршрута',
  'settings.persistentMonitor.openMonitoringSettings': 'Открыть настройки мониторинга в наушниках',
  // {label} is the status label above (e.g. "Mic monitoring")
  'settings.persistentMonitor.ariaLabel': '{label}. Запуск новой песни и звука тренировки заблокирован. Откройте настройки звука.',
  'settings.persistentMonitor.retryCleanupAria': 'Повторить очистку микрофона и освободить звук',
  'settings.persistentMonitor.stopAria': 'Остановить мониторинг и освободить звук микрофона',
  'settings.persistentMonitor.stopButton': 'Стоп',
  'settings.persistentMonitor.groupAriaLabel': 'Управление мониторингом в наушниках',

  // ── LazyDialogRoute.tsx: generic lazy-loaded dialog scaffolding ──
  'settings.dialogRoute.retryButton': 'Повторить',
  'settings.dialogRoute.recoveryFailed': 'Резервную копию тоже не удалось загрузить. Перезапустите SingZ перед новой попыткой.',
  // {name} is the dialog's own name (e.g. "Settings")
  'settings.dialogRoute.stoppedTitle': 'Окно «{name}» остановлено',
  'settings.dialogRoute.runtimeProblem': 'В этом окне произошла проблема. Уже начатая работа может всё ещё выполняться.',
  'settings.dialogRoute.keepOpenHint': 'Не закрывайте SingZ, пока текущая операция не завершится.',

  // ── audio/devices.ts: placeholder names for unnamed devices ──
  'settings.devices.microphone': 'Микрофон',
  'settings.devices.speakers': 'Динамики',

  // ── audio/mic-preview.ts: microphone preview errors ──
  'settings.micPreview.accessBlockedShort': 'Доступ к микрофону заблокирован.',
  'settings.micPreview.failed': 'Предпросмотр микрофона не удался.',
  'settings.micPreview.accessBlocked': 'Доступ к микрофону заблокирован. Разрешите SingZ в настройках приватности системы.',
  'settings.micPreview.busy': 'Микрофон занят другим приложением. Закройте это приложение и выберите вход снова.',
  'settings.micPreview.unavailable': 'Этот микрофон недоступен. Переподключите его или выберите другой вход.',
  'settings.micPreview.unknown': 'Не удалось запустить микрофон. Проверьте подключение устройства и попробуйте снова.'
}
