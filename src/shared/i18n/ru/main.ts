/* Русский — the `main` strings, typed against English. */
import type { main as en } from '../en/main'
import type { Translation } from '../types'

export const main: Translation<typeof en> = {
  // ── errors ──
  'main.error.fileNotRegistered': 'Файл не в реестре.',
  'main.error.folderNotRegistered': 'Папка не в реестре.',
  'main.error.playbackInvalidConfig': 'Нативному плееру нужен ограниченный проект и дорожки.',
  'main.error.playbackLaneSchema': 'Дорожки нативного плеера не прошли проверку схемы.',
  'main.error.playbackLaneUnauthorized':
    'Каждая дорожка нативного плеера должна быть авторизована и разрешена декодером.',

  // ── dialogs ──
  'main.dialog.chooseProjectsRoot': 'Выберите, где хранить проекты SingZ',

  // ── projects: format / library errors ──
  'main.error.notProjectFolder': 'это не папка проекта',
  'main.error.stemsNotConverted': 'часть дорожек не преобразовалась',
  // {dir} is a filesystem path
  'main.error.notReadableProjectFolder': '{dir} — это не читаемая папка проекта.',
  'main.error.invalidGraphHash': 'у project.json неверный graphHash.',
  // {have}/{supported} are graph document format version numbers
  'main.error.graphFormatUnsupported': 'Проект использует формат графа {have}; версия поддерживает формат {supported}.',
  'main.error.invalidGraphFormatOrSize': 'project.json: неверный формат или размер графа.',
  'main.error.graphMissing': 'graph.json не найден.',
  'main.error.graphMismatch': 'graph.json не совпадает с размером и md5, указанными в project.json.',
  'main.error.graphUnsupportedFormat': 'graph.json неподдерживаемого формата.',
  // {message} is a lower-level parser error, not itself translated
  'main.error.graphInvalid': 'graph.json неверен: {message}',
  'main.error.notSavedProject': 'Это не сохранённый проект.',
  // {format} is a graph document format version number
  'main.error.cannotWriteGraphFormat': 'Эта версия не пишет формат графа {format}.',
  'main.error.graphDisappeared': 'graph.json исчез до публикации.',
  'main.error.songMoved': 'Песня не там, где была — откройте и сохраните снова.',
  'main.error.leadVocalNotIssued': 'Замена вокала не была создана этой сессией. Разделите его ещё раз.',
  'main.error.songNotSavedYet': 'Песня пока не сохранена как проект.',
  // {name} is the project's (song) name the singer chose
  'main.error.projectNameExists': 'Проект «{name}» уже существует.',
  'main.error.folderNotInLibrary': 'Эта папка — не проект в вашей библиотеке.',
  'main.error.folderNotSavedProject': 'Эта папка — не сохранённый проект.',
  'main.error.projectAlreadyInLibrary': 'Этот проект уже есть в вашей библиотеке.',
  'main.error.projectNameAlreadyInLibrary': 'Проект «{name}» уже есть в вашей библиотеке.',

  // ── separation (splitter) ──
  'main.error.splitterNotDownloaded': 'Разделитель на дорожки ещё не загружен.',
  // engine descriptions shown as a tooltip (e.g. "manage splitter pack (ONNX)")
  'main.engine.onnxPack': 'разделение (ONNX)',
  'main.engine.cpuPackNoGpu': 'разделение (CPU — у пакета нет GPU-движка, обновите его в менеджере моделей)',
  'main.engine.trtrtxPack': 'разделение (TensorRT RTX)',
  'main.engine.cpuPackGpuOff': 'пакет разделения (CPU — движок GPU здесь отключён)',
  'main.error.separationAlreadyRunning': 'Разделение уже выполняется.',
  // {ext} is a file extension, e.g. ".m4a"
  'main.error.splitterUnsupportedFormat': 'Разделитель читает WAV/MP3/FLAC/OGG — преобразуйте {ext}.',
  // {message} is a low-level OS/process error, not itself translated
  'main.error.couldNotStartDemucs': 'Demucs не запустился: {message}',
  'main.error.cancelled': 'Отменено.',
  'main.error.notStarted': 'не запущено',
  'main.error.couldNotStartGpuPack': 'GPU-пакет не запустился: {message}',
  'main.error.gpuEngineTooSlow': 'Движок GPU слишком медленный на этом ПК.',

  // ── separation: friendlyError (parsed from engine stderr) ──
  'main.error.gpuOutOfMemory': 'Видеокарте не хватило памяти для этой модели.',
  'main.error.gpuDriverHung': 'Драйвер видеокарты перестал отвечать при работе с этой моделью (Windows сбросила GPU).',
  'main.error.gpuDeviceRemoved': 'Драйвер видеокарты не запустил модель (устройство GPU удалено).',
  'main.error.splitterMissingModel':
    'У разделителя нет модели — откройте менеджер моделей (чип разделителя) и загрузите её снова.',
  'main.error.demucsNeedsTorchCodec':
    'Эта установка demucs больше не читает звук (нужен TorchCodec). Обновите её (pipx upgrade demucs) или установите ffmpeg (brew install ffmpeg).',
  'main.error.demucsBrokenInstall':
    'Установка demucs повреждена (нет модуля Python). Попробуйте: pipx reinstall demucs && pipx inject demucs numpy',
  'main.error.couldNotReadAudioFile':
    'Не удалось прочитать аудиофайл. Убедитесь, что ffmpeg установлен (brew install ffmpeg) и файл воспроизводится.',
  'main.error.splitterOutOfMemory': 'Разделителю не хватило памяти — закройте программы и повторите.',
  // {tail} is the last few lines of the engine's own error output, not translated
  'main.error.separationFailed': 'Ошибка разделения: {tail}',
  'main.error.unknownError': 'неизвестно',
  // {stem} is a stem name, e.g. "vocals"
  'main.error.gpuPackNoStemFile': 'GPU-пакет не создал файл {stem}',

  // ── model manager: model catalog labels/descriptions ──
  'main.model.splitter.label': 'Разделитель · ИИ',
  'main.model.splitter.descriptionWin':
    'Разделяет песни на семь дорожек — ведущий и бэк-вокал, барабаны, бас, гитару, клавишные и остальное — на GPU, если подходит (GeForce RTX 30xx или новее; иначе на CPU).',
  'main.model.splitter.descriptionAppleSilicon':
    'Разделяет песни на семь дорожек — ведущий и бэк-вокал, барабаны, бас, гитару, клавишные и остальное — за секунды на GPU Apple Silicon.',
  'main.model.splitter.descriptionGeneric': 'Разделяет песни на семь дорожек — ведущий и бэк-вокал, барабаны, бас, гитару, клавишные и остальное.',
  'main.model.qwenAsr.label': 'Модель речи · текст',
  'main.model.qwenAsr.description':
    'Слушает вокал: распознаёт текст, если его нет в сети, и проверяет и выравнивает загруженный текст по тому, что поётся. Обучена на пении, на 30 языках, со своим выравнивателем слов.',
  'main.model.aligner.label': 'Выравниватель слов',
  'main.model.aligner.description':
    'Привязывает каждое слово к моменту, когда оно поётся — точнейшая синхронизация караоке на 1100+ языках. Работает через пакет разделения.',

  // ── model manager: download errors ──
  // {status} is an HTTP status code
  'main.error.downloadFailedHttp': 'ошибка загрузки (HTTP {status})',
  // {got}/{total} are megabyte amounts already formatted to one decimal
  'main.error.downloadStoppedShort':
    'загрузка прервалась — {got} МБ из {total} МБ, обещанных сервером. Попробуйте снова.',
  'main.error.downloadOverran': 'загрузка превысила размер: {got} МБ из {total} МБ. Попробуйте снова.',
  'main.error.splitterPackIncompatible':
    'Загруженный разделитель не подходит для этой версии. Ваш установленный разделитель не изменён.',
  'main.error.modelDownloadAlreadyRunning': 'Загрузка модели уже выполняется.',

  // ── lyrics ──
  'main.error.entryNoUsableSyncedLyrics': 'У записи нет годного текста.',
  'main.error.noLinesToSave': 'Нет строк для сохранения.',
  'main.error.couldNotSaveLyrics': 'Текст не сохранён: {message}',
  'main.error.lyricsJobAlreadyRunning': 'Задача с текстом уже выполняется.',
  'main.error.noLinesToAlign': 'Нет строк для выравнивания.',
  'main.error.splitFirstAlign': 'Сначала разделите песню на дорожки — выравнивание слушает дорожку вокала.',
  'main.error.preciseNeedsPack': 'Точное выравнивание работает через пакет разделения — установите его в менеджере моделей.',
  'main.error.preciseNeedsAlignerModel': 'Точному выравниванию нужна модель выравнивателя.',
  'main.error.couldNotDownloadAlignerModel': 'Модель выравнивателя не загрузилась: {message}',
  'main.error.splitFirstLyrics': 'Сначала разделите песню на дорожки — текст читается с дорожки вокала.',
  'main.error.lyricsEngineMissing': 'В этой версии нет движка для текста песен.',
  'main.error.hearingNeedsSpeechModel': 'Распознаванию вокала нужна речевая модель.',
  'main.error.couldNotDownloadSpeechModel': 'Не удалось загрузить речевую модель: {message}',
  'main.error.noSingingFound': 'На дорожке вокала не найдено пения.',
  'main.error.couldNotMakeOutVocals':
    'Не удалось разобрать вокал, чтобы проверить слова. Точное выравнивание может всё же сработать.',
  'main.error.couldNotTimeWords': 'Не удалось привязать время слов к вокалу.',
  'main.error.alignmentFailed': 'Сбой выравнивания: {message}',
  'main.error.noWordsDetected': 'В вокале не обнаружено слов.',
  'main.error.couldNotTimeTranscribedWords': 'Не удалось привязать время распознанных слов к вокалу.',
  'main.error.transcriptionFailed': 'Ошибка распознавания: {message}',
  'main.error.preciseAlignmentFailed': 'Сбой точного выравнивания: {message}',

  // ── qwen forced aligner (qwen-align.ts) ──
  'main.error.wordAlignerMissing': 'В этой версии нет выравнивателя слов.',
  'main.error.wordAlignerModelNotInstalled': 'Модель выравнивателя слов не установлена.',

  // ── qwen speech server (qwen-asr.ts) ──
  'main.error.llamaServerMissing': 'В этой версии отсутствует движок распознавания (llama-server).',
  'main.error.qwenModelNotInstalled': 'Речевая модель Qwen не установлена.',
  'main.error.llamaServerStopped': 'llama-server прервался до готовности',
  // {why} is a short excerpt of the engine's own last log lines, not translated
  'main.error.llamaServerStoppedWithReason': 'llama-server прервался до готовности: {why}',
  'main.error.llamaServerNotReadyInTime': 'llama-server не подготовился вовремя.',
  // {status} is an HTTP status code
  'main.error.llamaServerHttpError': 'llama-server ответил HTTP {status}',

  // ── Google Drive sign-in (gdriveSignIn only — gdriveSync's own errors stay
  //    English on purpose: sync-scheduler.ts's classifySyncError pattern-matches
  //    their English text to decide retry behaviour) ──
  'main.error.driveNotConfigured': 'Google Drive не настроен в этой версии',
  // the page shown in the system browser right after Google's OAuth redirect
  'main.drive.signedInPageTitle': 'SingZ в системе',
  'main.drive.signedInPageBody': 'Закройте вкладку и вернитесь в приложение.',
  'main.error.googleSignInCancelled': 'Вход в Google был отменён',
  'main.error.googleSignInTimedOut': 'Тайм-аут входа в Google',
  'main.error.googleNoTokens': 'Google не выдал токены',

  // ── backing-vocal separation ──
  'main.error.backingVocalSeparationAlreadyRunning': 'Разделение бэк-вокала уже выполняется.',
  // note: no trailing period, unlike main.error.cancelled — kept distinct on purpose
  'main.error.cancelledNoDot': 'Отменено',
  'main.error.downloadSplitterToSeparateVocals': 'Загрузите разделитель, чтобы разделить вокал.',
  'main.error.vocalFileChangedDuringSeparation': 'Файл вокала изменился при разделении. Попробуйте снова.',
  'main.error.vocalFileNotRegistered': 'Файл вокала не зарегистрирован.',

  // ── native audio (capture.ts): device inventory, monitoring, mic ──
  'main.error.audioProviderNotAvailable': 'Запрошенный нативный аудиопровайдер недоступен на этой платформе.',
  'main.error.nativeAudioHostUnavailable': 'Нативный аудиохост недоступен',
  'main.error.nativeAudioHostInvalidInventory': 'Нативный аудиохост вернул неверный список устройств.',
  'main.error.nativeAudioHostInventoryFailed': 'Аудиохост: сбой списка устройств: {message}',
  'main.error.nativeCaptureUnavailable': 'Нативный захват недоступен',
  'main.error.monitorGenerationExhausted': 'Диапазон поколений мониторинга исчерпан.',
  'main.error.monitorFailedToStart': 'Не удалось запустить мониторинг наушников: {message}',
  'main.error.monitorInvalidResponse': 'Мониторинг наушников вернул недействительный ответ.',
  'main.error.monitorGenerationInactive': 'Это поколение мониторинга наушников неактивно.',
  'main.error.monitorGainInvalidResponse': 'Громкость наушников вернула недействительный ответ.',
  'main.error.monitorGainFailed': 'Ошибка громкости наушников: {message}',
  'main.error.monitorInvalidStopResponse': 'Мониторинг наушников: недействительный ответ на остановку.',
  'main.error.monitorFailedToStop': 'Не удалось остановить мониторинг наушников: {message}',
  'main.error.nativePlaybackUnavailable': 'Нативный плеер недоступен',
  'main.error.invalidMicOwnershipGeneration': 'Неверное поколение владения микрофоном.',
  'main.error.nativeMicSupportUnavailable': 'Нативная поддержка микрофона недоступна: {message}',
  'main.error.monitorFailedGeneric': 'Мониторинг наушников не удался.',
  'main.error.monitorEndActiveFirst': 'Сначала завершите активный мониторинг наушников.',

  // ── source registration (drag/drop, file picker) ──
  // {ext} is a file extension (e.g. ".txt") or the fallback "that file"
  'main.error.cantUseFileDrop': 'Нельзя {ext} — перетащите MP3/WAV/FLAC/M4A.',
  'main.error.cantUseFilePick': 'Нельзя {ext} — выберите MP3/WAV/FLAC/M4A.',
  'main.error.thatFile': 'этот файл',
  'main.error.notAFile': 'Это не файл.',
  'main.error.couldNotReadFile': 'Не удалось прочитать файл.',

  // ── training microphone (audio-input.ts) ──
  'main.error.audioInputNoResult': 'audio-input не вернул результата',
  'main.error.audioInputUnsupportedFormat': 'audio-input: неподдерживаемый формат списка',
  // {index} is a 1-based device number
  'main.error.audioInputDeviceMalformed': 'устройство {index} audio-input повреждено',
  'main.error.audioInputCoreMissing': 'Нативное ядро audio-input отсутствует в версии.',
  'main.error.anotherTrainingMicStarting': 'Другой тренировочный микрофон стартует.',
  'main.error.anotherTrainingMicActive': 'Другой тренировочный микрофон активен.',
  'main.error.micAccessBlocked': 'Микрофон заблокирован. Разрешите SingZ в «Системные настройки › Конфиденциальность и безопасность › Микрофон» и повторите.',
  'main.error.noMicrophoneAvailable': 'Микрофон недоступен.',
  'main.error.micTookTooLongToStart': 'Микрофон запускался слишком долго.',
  'main.error.couldNotStartMicrophone': 'Не удалось запустить микрофон: {message}',
  'main.error.micDidNotConfirmStop': 'Нативный микрофон не подтвердил остановку.',
  'main.error.invalidMicFallback': 'Неверный резервный микрофон.',

  // ── Google Drive sync progress: taking a phone's song into the library (Phase 6) ──
  'main.sync.addingFromPhone': 'Добавление {dir} с телефона…',

  // ── Drive sync progress (shown under the library while it runs) ──
  'main.sync.syncing': 'Синхронизация «{dir}»…',
  'main.sync.uploading': 'Загрузка {file}…',
  'main.sync.removing': 'Удаление {file} из Drive…',
  'main.sync.removingGone': 'Удаление {name} из Drive (переименовано/удалено)…',
  'main.sync.updatingCatalog': 'Обновляем каталог телефона…',
  'main.sync.upToDate': 'Drive актуален'
}
