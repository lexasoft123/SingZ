/* Русский — the `library` strings, typed against English. */
import type { library as en } from '../en/library'
import type { Translation } from '../types'

export const library: Translation<typeof en> = {
  // ── shared across the library screens ──
  'library.common.close': 'Закрыть',
  'library.common.browseFiles': 'Обзор файлов…',
  'library.common.yourProjects': 'Ваши проекты',
  // fallback shown when an IPC failure carries no message of its own
  'library.common.unknownError': 'неизвестная ошибка',
  'library.common.finishGoogleSignIn': 'Завершите вход в Google в браузере…',
  'library.common.syncFailed': 'Синхронизация не удалась: {error}',

  // ── DropScreen (the Open/catalog screen) ──
  'library.dropScreen.cloudIcloud': 'Синхронизируется между устройствами через iCloud',
  'library.dropScreen.cloudOnedrive': 'Синхронизируется между устройствами через OneDrive',
  'library.dropScreen.cloudLocal': 'Только на этом компьютере',
  'library.dropScreen.signInFailed': 'Вход не удался: {error}',
  'library.dropScreen.deleteFailed': 'Не удалось удалить: {error}',
  'library.dropScreen.justNow': 'только что',
  // relative time, e.g. "5 min ago"
  'library.dropScreen.minAgo': '{mins} мин назад',
  // relative time, e.g. "3 h ago"
  'library.dropScreen.hAgo': '{h} ч назад',
  'library.dropScreen.uploadingTitle': 'Загрузка в Google Drive',
  'library.dropScreen.upToDateTitle': 'В Google Drive — актуально',
  // {reason}: the sync's own error text, or the "sync failed" fallback below
  'library.dropScreen.notOnDriveTitle': 'Пока не в Google Drive — {reason}',
  'library.dropScreen.syncFailedFallback': 'синхронизация не удалась',
  'library.dropScreen.waitingTitle': 'Ожидание связи с Google Drive',
  'library.dropScreen.reading': 'Чтение…',
  // {song}: the file name being opened
  'library.dropScreen.readingSong': 'Чтение «{song}»…',
  'library.dropScreen.decodingAudio': 'Декодирование звука и построение шкалы.',
  'library.dropScreen.yourCatalog': 'Ваш каталог.',
  // {song}: the name of the song still open behind this screen
  'library.dropScreen.catalogHint': 'Выберите проект ниже или перетащите другую песню в любое место этого окна — «{song}» останется загруженной, пока вы это не сделаете.',
  'library.dropScreen.escHint': 'или нажмите Esc, чтобы вернуться к своей песне',
  'library.dropScreen.dropASong': 'Перетащите песню.',
  'library.dropScreen.dropHintDesc': 'MP3, WAV, FLAC или M4A — SingZ разделит её на вокал, барабаны, бас и инструменты, которые можно заглушить во время пения.',
  'library.dropScreen.dragHint': 'или перетащите её в любое место этого окна',
  'library.dropScreen.searchPlaceholder': 'Поиск проектов…',
  // {cloud}: one of the cloudIcloud/cloudOnedrive/cloudLocal lines above
  'library.dropScreen.libraryLivesHere': 'Ваша библиотека здесь · {cloud}',
  'library.dropScreen.change': 'Изменить…',
  // {msg}: the sync's own progress text (already words, not translated twice); {percent}: 0-100
  'library.dropScreen.copyingToDrive': 'Копирование в Google Drive… {msg} {percent}%',
  'library.dropScreen.driveCopyLives': 'Копия также хранится в Google Drive',
  'library.dropScreen.upToDate': 'актуально',
  'library.dropScreen.keepCopyHint': 'Храните копию в Google Drive, чтобы телефоны могли проигрывать её оттуда',
  'library.dropScreen.syncLog': 'Журнал синхронизации',
  'library.dropScreen.syncNow': 'Синхронизировать',
  'library.dropScreen.connect': 'Подключить…',
  // always plural in English, even for a single stem — kept as-is on purpose
  'library.dropScreen.stemsCount_one': '{n} дорожка',
  'library.dropScreen.stemsCount_few': '{n} дорожки',
  'library.dropScreen.stemsCount_many': '{n} дорожек',
  'library.dropScreen.stemsCount_other': '{n} дорожки',
  'library.dropScreen.noStems': 'без дорожек',
  // short badge word appended after the stem count, e.g. "3 stems · lyrics"
  'library.dropScreen.lyricsBadge': 'текст',
  // {name}: the project's name
  'library.dropScreen.deleteTitle': 'Удалить «{name}» из вашей библиотеки',
  'library.dropScreen.deleteAria': 'Удалить {name}',
  // {query}: what the singer typed into the search box
  'library.dropScreen.noMatches': 'Ничего не найдено по запросу «{query}».',
  'library.dropScreen.deleteHeading': 'Удалить «{name}»?',
  // {stems}: either the stemsCount text above or eraseStemsFallback; {lyrics}: eraseLyricsSuffix or nothing; {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.eraseBody': 'Это удалит всю папку проекта целиком — {stems}{lyrics}, ваш микс, транспонирование и настройки «Веди строку», всего {size}. Она не попадёт в корзину, и здесь это нельзя отменить.',
  // stands in for the stem count above when the project has not been split yet
  'library.dropScreen.eraseStemsFallback': 'песню',
  // appended only when the project has synced lyrics — keep the leading comma
  'library.dropScreen.eraseLyricsSuffix': ', текст',
  'library.dropScreen.openSongNote': 'Это открытая сейчас песня — она продолжит играть, пока вы не загрузите другую, но сохранить её больше не во что. ',
  'library.dropScreen.driveTrashNote': 'Копия в Google Drive при следующей синхронизации переместится в корзину Drive, где её можно восстановить в течение 30 дней — на телефонах она больше не будет отображаться.',
  'library.dropScreen.resplitNote': 'Чтобы разделить её снова, понадобится повторный запуск разделения.',
  'library.dropScreen.keepIt': 'Оставить',
  'library.dropScreen.deleting': 'Удаление…',
  // {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.deleteSize': 'Удалить {size}',

  // ── ProjectPicker (the "Your projects" dialog) ──
  'library.projectPicker.googleSignInFailed': 'Вход в Google не удался: {error}',
  'library.projectPicker.syncingToDrive': 'Синхронизация ваших проектов с Drive…',
  // {uploaded}/{unchanged}: project counts
  'library.projectPicker.driveUpToDate': 'Drive актуален — загружено {uploaded}, без изменений {unchanged}. На телефонах они видны в разделе Google Drive.',
  'library.projectPicker.movedIn_one': 'Перенесено — скопирован {n} проект.',
  'library.projectPicker.movedIn_few': 'Перенесено — скопировано {n} проекта.',
  'library.projectPicker.movedIn_many': 'Перенесено — скопировано {n} проектов.',
  'library.projectPicker.movedIn_other': 'Перенесено — скопировано {n} проекта.',
  'library.projectPicker.switchFailed': 'Не удалось переключиться: {error}',
  // {root}: the folder path being listed
  'library.projectPicker.looking': 'Поиск в {root}…',
  // stands in for the path while it is still loading
  'library.projectPicker.defaultFolder': 'папку с проектами',
  // **Save project** stays bold; {root}: the library folder path, also bold
  'library.projectPicker.emptyHint': 'Пока ничего не сохранено. Загрузите песню и нажмите **Сохранить проект** — она попадёт в **{root}** со своими дорожками, текстом и настройками.',
  // small badge word on a project row that has split stems
  'library.projectPicker.stemsBadge': 'дорожки',
  // small badge word on a project row that has synced lyrics
  'library.projectPicker.lyricsBadge': 'текст',
  'library.projectPicker.storedIn': 'Хранится в {root}',
  // {path}: a cloud folder's filesystem path
  'library.projectPicker.cloudTitle': '{path} — синхронизируется с другими вашими устройствами, включая приложение на телефоне',
  // {label}: a cloud provider's name, e.g. "iCloud Drive"
  'library.projectPicker.inCloud': 'В {label} ✓',
  'library.projectPicker.useCloud': 'Использовать {label}',
  'library.projectPicker.gdriveConnectTitle': 'Отправляйте проекты в папку SingZ в Google Drive — телефоны будут проигрывать их оттуда, приложение Drive не нужно',
  'library.projectPicker.syncToDrive': 'Синхронизировать с Google Drive',
  'library.projectPicker.connectDrive': 'Подключить Google Drive…',
  'library.projectPicker.signOut': 'Выйти',
  'library.projectPicker.signedOut': 'Вы вышли из Google Drive.',
  'library.projectPicker.chooseFolder': 'Выбрать папку…',
  'library.projectPicker.backToDocuments': 'Назад в «Документы»',
  'library.projectPicker.moving': 'Копирование ваших проектов — существующие файлы остаются на месте…',

  // ── LibraryImport (adopt a project found outside the library) ──
  'library.libraryImport.heading': 'Добавить в библиотеку',
  // {dir}/{root}: filesystem paths, both stay bold
  'library.libraryImport.body': 'Этот проект находится в **{dir}**, вне вашей библиотеки. Там он прекрасно проигрывается и сохраняется — но добавление поместит его в **{root}**, где он появится на экране «Открыть» и будет подхватываться синхронизацией с Drive.',
  'library.libraryImport.copyIn': 'Скопировать в библиотеку',
  'library.libraryImport.copyInTitle': 'Продублировать папку в библиотеку — оригинал останется на месте',
  'library.libraryImport.moveIn': 'Перенести в библиотеку',
  'library.libraryImport.moveInTitle': 'Перенести папку в библиотеку — ничего не останется на прежнем месте',
  'library.libraryImport.workingHint': 'Идёт обработка — проект с дорожками весит несколько сотен МБ, это займёт немного времени…',
  'library.libraryImport.copyMoveHint': 'Копирование не трогает оригинал — то, что нужно для папки, которой пользуется кто-то ещё. Перенос забирает всё с собой, включая дорожки.',

  // ── LogPanel (chrome only — the log lines themselves stay English) ──
  'library.logPanel.title': 'Журнал',
  'library.logPanel.whichLaunch': 'Журнал какого запуска',
  'library.logPanel.thisSession': 'Этот запуск',
  // {shown}/{total}: line counts
  'library.logPanel.linesTail': 'последние {shown} из {total} строк — в файле будут все',
  'library.logPanel.linesCount': '{n} строк',
  'library.logPanel.copy': 'Копировать',
  'library.logPanel.copied': 'Скопировано ✓',
  'library.logPanel.saveToFile': 'Сохранить в файл…',
  'library.logPanel.loading': 'Загрузка…',
  'library.logPanel.nothingLogged': 'Пока ничего не записано.',
  'library.logPanel.savedTo': 'Сохранено в {path}',

  // ── DropScreenRoute (loading / recovery states around the catalog) ──
  'library.route.eyebrow': 'Библиотека песен',
  'library.route.opening': 'Открытие ваших песен…',
  'library.route.loadingStatus': 'Загрузка библиотеки песен.',
  'library.route.didntOpenHeading': 'Ваша библиотека песен не открылась',
  'library.route.didntOpenBody': 'Не удалось загрузить экран библиотеки. Открытая песня и звуковая сессия не изменились.',
  'library.route.retry': 'Повторить',
  'library.route.recoveryFailed': 'Резервную копию тоже не удалось загрузить. Перезапустите SingZ, прежде чем пробовать снова.',
  'library.route.openSongFile': 'Открыть файл песни',
  'library.route.stoppedHeading': 'Ваша библиотека песен остановилась',
  'library.route.stoppedBody': 'В загруженном экране библиотеки произошла ошибка. Перезапустите SingZ перед повторным открытием — начатая синхронизация или удаление могут ещё завершаться.',
  'library.route.openLog': 'Открыть журнал',

  // ── split-workflow (the split progress bar's stage labels) ──
  'library.splitWorkflow.warmingUp': 'Подготовка',
  'library.splitWorkflow.downloadingModel': 'Загрузка модели',
  'library.splitWorkflow.splittingStems': 'Разделение на дорожки',
  'library.splitWorkflow.loadingStems': 'Загрузка дорожек',
  'library.splitWorkflow.loadingVocals': 'Загрузка вокала',
  'library.splitWorkflow.separatingVocals': 'Разделение вокала',
  // {step}: 1 or 2; {label}: one of the stage labels above
  'library.splitWorkflow.combinedLabel': '{step}/2 · {label}',

  // ── playback-error-toast ──
  // {message}: the underlying provider/engine failure text
  'library.playbackErrorToast.couldNotStart': 'Не удалось начать воспроизведение: {message}',

  // ── audio/engine (the one status genuinely shown to the singer, as this toast) ──
  'library.engine.songUnreadable': 'Эту песню не удалось повторно прочитать с диска, поэтому нечего воспроизводить.'
}
