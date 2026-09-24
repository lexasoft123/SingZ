/* Русский — the `main` strings, typed against English. */
import type { main as en } from '../en/main'
import type { Translation } from '../types'

export const main: Translation<typeof en> = {
  // ── errors ──
  'main.error.fileNotRegistered': 'Файл не зарегистрирован.',
  'main.error.folderNotRegistered': 'Папка не зарегистрирована.',
  'main.error.playbackInvalidConfig': 'Для нативного воспроизведения нужен ограниченный проект и список дорожек.',
  'main.error.playbackLaneSchema': 'Дорожки нативного воспроизведения не прошли строгую проверку схемы.',
  'main.error.playbackLaneUnauthorized':
    'Каждая дорожка нативного воспроизведения должна быть авторизована и поддерживаться проверенным декодером.',

  // ── dialogs ──
  'main.dialog.chooseProjectsRoot': 'Выберите, где SingZ будет хранить ваши проекты',

  // ── projects: format / library errors ──
  'main.error.notProjectFolder': 'это не папка проекта',
  'main.error.stemsNotConverted': 'некоторые дорожки не удалось преобразовать',
  // {dir} is a filesystem path
  'main.error.notReadableProjectFolder': '{dir} — это не читаемая папка проекта.',
  'main.error.invalidGraphHash': 'у project.json недействительный graphHash.',
  // {have}/{supported} are graph document format version numbers
  'main.error.graphFormatUnsupported': 'Этот проект использует формат графа {have}; эта версия поддерживает формат {supported}.',
  'main.error.invalidGraphFormatOrSize': 'project.json указывает недействительный формат или размер графа.',
  'main.error.graphMissing': 'graph.json отсутствует.',
  'main.error.graphMismatch': 'graph.json не совпадает с размером и md5, указанными в project.json.',
  'main.error.graphUnsupportedFormat': 'graph.json использует неподдерживаемый формат.',
  // {message} is a lower-level parser error, not itself translated
  'main.error.graphInvalid': 'graph.json недействителен: {message}',
  'main.error.notSavedProject': 'Это не сохранённый проект.',
  // {format} is a graph document format version number
  'main.error.cannotWriteGraphFormat': 'Эта версия не может записывать формат графа {format}.',
  'main.error.graphDisappeared': 'graph.json исчез до публикации.',
  'main.error.songMoved': 'Эта песня больше не там, где была — откройте её снова и сохраните ещё раз.',
  'main.error.leadVocalNotIssued': 'Замена вокала не была создана этой сессией. Разделите его ещё раз.',
  'main.error.songNotSavedYet': 'Эта песня пока не сохранена как проект.',
  // {name} is the project's (song) name the singer chose
  'main.error.projectNameExists': 'Проект «{name}» уже существует.',
  'main.error.folderNotInLibrary': 'Эта папка не является проектом в вашей библиотеке.',
  'main.error.folderNotSavedProject': 'Эта папка не является сохранённым проектом.',
  'main.error.projectAlreadyInLibrary': 'Этот проект уже есть в вашей библиотеке.',
  'main.error.projectNameAlreadyInLibrary': 'Проект «{name}» уже есть в вашей библиотеке.',

  // ── separation (splitter) ──
  'main.error.splitterNotDownloaded': 'Разделитель на дорожки ещё не загружен.',
  // engine descriptions shown as a tooltip (e.g. "manage splitter pack (ONNX)")
  'main.engine.onnxPack': 'пакет разделения (ONNX)',
  'main.engine.cpuPackNoGpu': 'пакет разделения (CPU — у этого пакета нет движка для GPU, обновите его в менеджере моделей)',
  'main.engine.trtrtxPack': 'пакет разделения (TensorRT RTX)',
  'main.engine.cpuPackGpuOff': 'пакет разделения (CPU — движок GPU здесь отключён)',
  'main.error.separationAlreadyRunning': 'Разделение уже выполняется.',
  // {ext} is a file extension, e.g. ".m4a"
  'main.error.splitterUnsupportedFormat': 'Разделитель читает WAV/MP3/FLAC/OGG — сначала преобразуйте {ext}.',
  // {message} is a low-level OS/process error, not itself translated
  'main.error.couldNotStartDemucs': 'Не удалось запустить demucs: {message}',
  'main.error.cancelled': 'Отменено.',
  'main.error.notStarted': 'не запущено',
  'main.error.couldNotStartGpuPack': 'Не удалось запустить пакет для GPU: {message}',
  'main.error.gpuEngineTooSlow': 'Движок GPU работал слишком медленно на этом компьютере.',

  // ── separation: friendlyError (parsed from engine stderr) ──
  'main.error.gpuOutOfMemory': 'Видеокарте не хватило памяти для этой модели.',
  'main.error.gpuDriverHung': 'Драйвер видеокарты перестал отвечать при работе с этой моделью (Windows сбросила GPU).',
  'main.error.gpuDeviceRemoved': 'Драйвер видеокарты не смог запустить эту модель (устройство GPU удалено).',
  'main.error.splitterMissingModel':
    'У разделителя отсутствует модель — откройте менеджер моделей (чип разделителя) и загрузите её снова.',
  'main.error.demucsNeedsTorchCodec':
    'Эта установка demucs больше не может читать звук (torchaudio теперь требует TorchCodec). Обновите её (pipx upgrade demucs) или установите ffmpeg (brew install ffmpeg).',
  'main.error.demucsBrokenInstall':
    'Установка demucs выглядит повреждённой (отсутствует модуль Python). Попробуйте: pipx reinstall demucs && pipx inject demucs numpy',
  'main.error.couldNotReadAudioFile':
    'Не удалось прочитать аудиофайл. Убедитесь, что ffmpeg установлен (brew install ffmpeg) и файл нормально воспроизводится.',
  'main.error.splitterOutOfMemory': 'Разделителю не хватило памяти. Закройте другие приложения и попробуйте снова.',
  // {tail} is the last few lines of the engine's own error output, not translated
  'main.error.separationFailed': 'Разделение не удалось: {tail}',
  'main.error.unknownError': 'неизвестная ошибка',
  // {stem} is a stem name, e.g. "vocals"
  'main.error.gpuPackNoStemFile': 'Пакет для GPU не создал файл дорожки {stem}',

  // ── model manager: model catalog labels/descriptions ──
  'main.model.splitter.label': 'Разделитель на дорожки · ИИ',
  'main.model.splitter.descriptionWin':
    'Разделяет песни на семь дорожек — ведущий и бэк-вокал, барабаны, бас, гитару, клавишные и остальное — на вашем GPU, если он подходит (GeForce RTX 30xx или новее; иначе на CPU).',
  'main.model.splitter.descriptionAppleSilicon':
    'Разделяет песни на семь дорожек — ведущий и бэк-вокал, барабаны, бас, гитару, клавишные и остальное — за секунды на GPU Apple Silicon.',
  'main.model.splitter.descriptionGeneric':
    'Разделяет песни на семь дорожек — ведущий и бэк-вокал, барабаны, бас, гитару, клавишные и остальное.',
  'main.model.qwenAsr.label': 'Речевая модель · текст песни',
  'main.model.qwenAsr.description':
    'Слушает вокал: распознаёт текст, если его нет в сети, и проверяет и выравнивает загруженный текст по тому, что действительно поётся. Обучена на пении, на 30 языках, со своим выравнивателем слов.',
  'main.model.aligner.label': 'Точный выравниватель слов',
  'main.model.aligner.description':
    'Привязывает каждое слово текста к точному моменту, когда оно поётся — самая точная синхронизация для караоке, на 1100+ языках. Работает через пакет разделения.',

  // ── model manager: download errors ──
  // {status} is an HTTP status code
  'main.error.downloadFailedHttp': 'загрузка не удалась (HTTP {status})',
  // {got}/{total} are megabyte amounts already formatted to one decimal
  'main.error.downloadStoppedShort':
    'загрузка прервалась раньше времени — {got} МБ из {total} МБ, обещанных сервером. Попробуйте снова.',
  'main.error.downloadOverran': 'загрузка превысила ожидаемый размер — {got} МБ из {total} МБ, обещанных сервером. Попробуйте снова.',
  'main.error.splitterPackIncompatible':
    'Загруженный разделитель на дорожки не подходит для этой версии. Установленный у вас разделитель не изменён.',
  'main.error.modelDownloadAlreadyRunning': 'Загрузка модели уже выполняется.',

  // ── lyrics ──
  'main.error.entryNoUsableSyncedLyrics': 'У этой записи нет пригодного синхронизированного текста.',
  'main.error.noLinesToSave': 'Нет строк для сохранения.',
  'main.error.couldNotSaveLyrics': 'Не удалось сохранить текст: {message}',
  'main.error.lyricsJobAlreadyRunning': 'Задача с текстом уже выполняется.',
  'main.error.noLinesToAlign': 'Нет строк для выравнивания.',
  'main.error.splitFirstAlign': 'Сначала разделите песню на дорожки — выравнивание слушает дорожку вокала.',
  'main.error.preciseNeedsPack': 'Точное выравнивание работает через пакет разделения — сначала установите его в менеджере моделей.',
  'main.error.preciseNeedsAlignerModel': 'Для точного выравнивания нужна многоязычная модель выравнивателя.',
  'main.error.couldNotDownloadAlignerModel': 'Не удалось загрузить модель выравнивателя: {message}',
  'main.error.splitFirstLyrics': 'Сначала разделите песню на дорожки — текст читается с дорожки вокала.',
  'main.error.lyricsEngineMissing': 'В этой версии отсутствует движок для текста песен.',
  'main.error.hearingNeedsSpeechModel': 'Для распознавания вокала нужна речевая модель.',
  'main.error.couldNotDownloadSpeechModel': 'Не удалось загрузить речевую модель: {message}',
  'main.error.noSingingFound': 'На дорожке вокала не найдено пения.',
  'main.error.couldNotMakeOutVocals':
    'Не удалось разобрать вокал достаточно, чтобы проверить слова. Точное выравнивание может всё же сработать.',
  'main.error.couldNotTimeWords': 'Не удалось привязать время слов к вокалу.',
  'main.error.alignmentFailed': 'Выравнивание не удалось: {message}',
  'main.error.noWordsDetected': 'В вокале не обнаружено слов.',
  'main.error.couldNotTimeTranscribedWords': 'Не удалось привязать время распознанных слов к вокалу.',
  'main.error.transcriptionFailed': 'Распознавание не удалось: {message}',
  'main.error.preciseAlignmentFailed': 'Точное выравнивание не удалось: {message}',

  // ── qwen forced aligner (qwen-align.ts) ──
  'main.error.wordAlignerMissing': 'В этой версии отсутствует выравниватель слов.',
  'main.error.wordAlignerModelNotInstalled': 'Модель выравнивателя слов не установлена.',

  // ── qwen speech server (qwen-asr.ts) ──
  'main.error.llamaServerMissing': 'В этой версии отсутствует движок распознавания (llama-server).',
  'main.error.qwenModelNotInstalled': 'Речевая модель Qwen не установлена.',
  'main.error.llamaServerStopped': 'llama-server остановился, не успев подготовиться',
  // {why} is a short excerpt of the engine's own last log lines, not translated
  'main.error.llamaServerStoppedWithReason': 'llama-server остановился, не успев подготовиться: {why}',
  'main.error.llamaServerNotReadyInTime': 'llama-server не подготовился вовремя.',
  // {status} is an HTTP status code
  'main.error.llamaServerHttpError': 'llama-server ответил HTTP {status}',

  // ── Google Drive sign-in (gdriveSignIn only — gdriveSync's own errors stay
  //    English on purpose: sync-scheduler.ts's classifySyncError pattern-matches
  //    their English text to decide retry behaviour) ──
  'main.error.driveNotConfigured': 'Google Drive не настроен в этой версии',
  // the page shown in the system browser right after Google's OAuth redirect
  'main.drive.signedInPageTitle': 'SingZ вошёл в систему',
  'main.drive.signedInPageBody': 'Можете закрыть эту вкладку и вернуться в приложение.',
  'main.error.googleSignInCancelled': 'Вход в Google был отменён',
  'main.error.googleSignInTimedOut': 'Вход в Google не завершился вовремя',
  'main.error.googleNoTokens': 'Google не выдал токены',

  // ── backing-vocal separation ──
  'main.error.backingVocalSeparationAlreadyRunning': 'Разделение бэк-вокала уже выполняется.',
  // note: no trailing period, unlike main.error.cancelled — kept distinct on purpose
  'main.error.cancelledNoDot': 'Отменено',
  'main.error.downloadSplitterToSeparateVocals': 'Загрузите разделитель на дорожки, чтобы разделить вокал.',
  'main.error.vocalFileChangedDuringSeparation': 'Файл вокала изменился во время разделения. Попробуйте ещё раз.',
  'main.error.vocalFileNotRegistered': 'Этот файл вокала не зарегистрирован.',

  // ── native audio (capture.ts): device inventory, monitoring, mic ──
  'main.error.audioProviderNotAvailable': 'Запрошенный нативный аудиопровайдер недоступен на этой платформе.',
  'main.error.nativeAudioHostUnavailable': 'Нативный аудиохост недоступен',
  'main.error.nativeAudioHostInvalidInventory': 'Нативный аудиохост вернул недействительный список устройств.',
  'main.error.nativeAudioHostInventoryFailed': 'Не удалось получить список устройств нативного аудиохоста: {message}',
  'main.error.nativeCaptureUnavailable': 'Нативный захват звука недоступен',
  'main.error.monitorGenerationExhausted': 'Диапазон поколений нативного мониторинга исчерпан.',
  'main.error.monitorFailedToStart': 'Не удалось запустить нативный мониторинг наушников: {message}',
  'main.error.monitorInvalidResponse': 'Нативный мониторинг наушников вернул недействительный ответ.',
  'main.error.monitorGenerationInactive': 'Это поколение мониторинга наушников больше не активно.',
  'main.error.monitorGainInvalidResponse': 'Нативная громкость наушников вернула недействительный ответ.',
  'main.error.monitorGainFailed': 'Не удалось изменить нативную громкость наушников: {message}',
  'main.error.monitorInvalidStopResponse': 'Нативный мониторинг наушников вернул недействительный ответ об остановке.',
  'main.error.monitorFailedToStop': 'Не удалось остановить нативный мониторинг наушников: {message}',
  'main.error.nativePlaybackUnavailable': 'Нативное воспроизведение недоступно',
  'main.error.invalidMicOwnershipGeneration': 'Недействительное поколение владения микрофоном.',
  'main.error.nativeMicSupportUnavailable': 'Нативная поддержка микрофона недоступна: {message}',
  'main.error.monitorFailedGeneric': 'Нативный мониторинг наушников не удался.',
  'main.error.monitorEndActiveFirst': 'Сначала завершите активный мониторинг наушников, прежде чем начинать новый.',

  // ── source registration (drag/drop, file picker) ──
  // {ext} is a file extension (e.g. ".txt") or the fallback "that file"
  'main.error.cantUseFileDrop': 'Не получится использовать {ext} — перетащите MP3, WAV, FLAC или M4A.',
  'main.error.cantUseFilePick': 'Не получится использовать {ext} — выберите MP3, WAV, FLAC или M4A.',
  'main.error.thatFile': 'этот файл',
  'main.error.notAFile': 'Это не файл.',
  'main.error.couldNotReadFile': 'Не удалось прочитать этот файл.',

  // ── training microphone (audio-input.ts) ──
  'main.error.audioInputNoResult': 'инвентаризация audio-input не вернула результата',
  'main.error.audioInputUnsupportedFormat': 'у инвентаризации audio-input неподдерживаемый формат',
  // {index} is a 1-based device number
  'main.error.audioInputDeviceMalformed': 'устройство {index} в инвентаризации audio-input повреждено',
  'main.error.audioInputCoreMissing': 'Нативное ядро audio-input отсутствует в этой версии.',
  'main.error.anotherTrainingMicStarting': 'Другой тренировочный микрофон запускается.',
  'main.error.anotherTrainingMicActive': 'Другой тренировочный микрофон активен.',
  'main.error.micAccessBlocked':
    'Доступ к микрофону заблокирован. Разрешите SingZ в Системных настройках › Конфиденциальность и безопасность › Микрофон, затем попробуйте снова.',
  'main.error.noMicrophoneAvailable': 'Микрофон недоступен.',
  'main.error.micTookTooLongToStart': 'Микрофон запускался слишком долго.',
  'main.error.couldNotStartMicrophone': 'Не удалось запустить микрофон: {message}',
  'main.error.micDidNotConfirmStop': 'Нативный микрофон не подтвердил остановку.',
  'main.error.invalidMicFallback': 'Недействительный резервный вариант микрофона.'
}
