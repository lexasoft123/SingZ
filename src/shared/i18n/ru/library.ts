/* Русский — the `library` strings, typed against English. */
import type { library as en } from '../en/library'
import type { Translation } from '../types'

export const library: Translation<typeof en> = {
  // ── shared across the library screens ──
  'library.common.close': 'Закрыть',
  'library.common.browseFiles': 'Обзор файлов…',
  'library.common.yourProjects': 'Ваши проекты',
  // fallback shown when an IPC failure carries no message of its own
  'library.common.unknownError': 'неизвестно',
  'library.common.finishGoogleSignIn': 'Завершите вход в Google в браузере…',
  'library.common.syncFailed': 'Не удалось: {error}',

  // ── DropScreen (the Open/catalog screen) ──
  'library.dropScreen.cloudIcloud': 'Синхронизируется через iCloud',
  'library.dropScreen.cloudOnedrive': 'Синхронизируется через OneDrive',
  'library.dropScreen.cloudLocal': 'Только этот компьютер',
  'library.dropScreen.signInFailed': 'Вход не удался: {error}',
  'library.dropScreen.deleteFailed': 'Не удалось удалить: {error}',
  'library.dropScreen.justNow': 'сейчас',
  // relative time, e.g. "5 min ago"
  'library.dropScreen.minAgo': '{mins} мин назад',
  // relative time, e.g. "3 h ago"
  'library.dropScreen.hAgo': '{h} ч назад',
  'library.dropScreen.uploadingTitle': 'Загрузка в Google Drive',
  'library.dropScreen.upToDateTitle': 'В Google Drive — актуально',
  // {reason}: the sync's own error text, or the "sync failed" fallback below
  'library.dropScreen.notOnDriveTitle': 'Пока не в Google Drive — {reason}',
  'library.dropScreen.syncFailedFallback': 'не удалось',
  'library.dropScreen.waitingTitle': 'Ожидание связи с Google Drive',
  'library.dropScreen.reading': 'Чтение…',
  // {song}: the file name being opened
  'library.dropScreen.readingSong': 'Чтение «{song}»…',
  'library.dropScreen.decodingAudio': 'Декодирование звука и построение шкалы.',
  'library.dropScreen.yourCatalog': 'Ваш каталог.',
  // {song}: the name of the song still open behind this screen
  'library.dropScreen.catalogHint': 'Выберите проект ниже или перетащите сюда другую песню — «{song}» останется, пока вы это не сделаете.',
  'library.dropScreen.escHint': 'или Esc — вернуться к своей песне',
  'library.dropScreen.dropASong': 'Песню сюда.',
  'library.dropScreen.dropHintDesc': 'MP3, WAV, FLAC или M4A — SingZ разделит её на вокал, барабаны, бас и инструменты, приглушаемые при пении.',
  'library.dropScreen.dragHint': 'или перетащите её сюда',
  'library.dropScreen.searchPlaceholder': 'Поиск проектов…',
  // {cloud}: one of the cloudIcloud/cloudOnedrive/cloudLocal lines above
  'library.dropScreen.libraryLivesHere': 'Ваша библиотека здесь · {cloud}',
  'library.dropScreen.change': 'Изменить…',
  // {msg}: the sync's own progress text (already words, not translated twice); {percent}: 0-100
  'library.dropScreen.copyingToDrive': 'Копирование в Google Drive… {msg} {percent}%',
  'library.dropScreen.driveCopyLives': 'Копия также хранится в Google Drive',
  'library.dropScreen.upToDate': 'актуально',
  'library.dropScreen.keepCopyHint': 'Храните копию в Google Drive — телефоны сыграют её оттуда',
  'library.dropScreen.syncLog': 'Журнал',
  'library.dropScreen.syncNow': 'Синхронизировать',
  'library.dropScreen.connect': 'Связать…',
  // always plural in English, even for a single stem — kept as-is on purpose
  'library.dropScreen.stemsCount_one': '{n} дорожка',
  'library.dropScreen.stemsCount_few': '{n} дорожки',
  'library.dropScreen.stemsCount_many': '{n} дорожек',
  'library.dropScreen.stemsCount_other': '{n} дорожки',
  'library.dropScreen.noStems': 'пусто',
  // short badge word appended after the stem count, e.g. "3 stems · lyrics"
  'library.dropScreen.lyricsBadge': 'текст',
  // {name}: the project's name
  'library.dropScreen.deleteTitle': 'Удалить «{name}» из библиотеки',
  'library.dropScreen.deleteAria': 'Удалить {name}',
  // {query}: what the singer typed into the search box
  'library.dropScreen.noMatches': 'Нет совпадений «{query}».',
  'library.dropScreen.deleteHeading': 'Удалить «{name}»?',
  // {stems}: either the stemsCount text above or eraseStemsFallback; {lyrics}: eraseLyricsSuffix or nothing; {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.eraseBody': 'Это удалит всю папку проекта — {stems}{lyrics}, ваш микс, транспонирование и настройки «Веди строку», всего {size}. В корзину она не попадёт, и это нельзя отменить.',
  // stands in for the stem count above when the project has not been split yet
  'library.dropScreen.eraseStemsFallback': 'песню',
  // appended only when the project has synced lyrics — keep the leading comma
  'library.dropScreen.eraseLyricsSuffix': ', текст',
  'library.dropScreen.openSongNote': 'Это открытая сейчас песня — она продолжит играть, пока вы не загрузите другую, но сохранить её больше не во что. ',
  'library.dropScreen.driveTrashNote': 'Копия на Google Drive уйдёт в его корзину при синхронизации — 30 дней на восстановление, на телефонах больше не появится.',
  'library.dropScreen.resplitNote': 'Чтобы разделить снова, нужен повторный запуск разделения.',
  'library.dropScreen.keepIt': 'Хранить',
  'library.dropScreen.deleting': 'Удаление…',
  // {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.deleteSize': 'Удалить {size}',

  // ── ProjectPicker (the "Your projects" dialog) ──
  'library.projectPicker.googleSignInFailed': 'Ошибка входа в Google: {error}',
  'library.projectPicker.syncingToDrive': 'Синхронизация проектов с Drive…',
  // {uploaded}/{unchanged}: project counts
  'library.projectPicker.driveUpToDate': 'Drive актуален — загружено {uploaded}, без изменений {unchanged}. На телефонах они видны в Google Drive.',
  'library.projectPicker.movedIn_one': 'Перенесено — скопирован {n} проект.',
  'library.projectPicker.movedIn_few': 'Перенос: скопировано {n} проекта.',
  'library.projectPicker.movedIn_many': 'Перенос: скопировано {n} проектов.',
  'library.projectPicker.movedIn_other': 'Перенос: скопировано {n} проекта.',
  'library.projectPicker.switchFailed': 'Не переключить: {error}',
  // {root}: the folder path being listed
  'library.projectPicker.looking': 'Поиск в {root}…',
  // stands in for the path while it is still loading
  'library.projectPicker.defaultFolder': 'папку с проектами',
  // **Save project** stays bold; {root}: the library folder path, also bold
  'library.projectPicker.emptyHint': 'Ничего нет. Загрузите песню и нажмите **Сохранить проект** — попадёт в **{root}** с дорожками, текстом и настройками.',
  // small badge word on a project row that has split stems
  'library.projectPicker.stemsBadge': 'дорожки',
  // small badge word on a project row that has synced lyrics
  'library.projectPicker.lyricsBadge': 'текст',
  'library.projectPicker.storedIn': 'В {root}',
  // {path}: a cloud folder's filesystem path
  'library.projectPicker.cloudTitle': '{path} — синхронизируется с другими устройствами и телефоном',
  // {label}: a cloud provider's name, e.g. "iCloud Drive"
  'library.projectPicker.inCloud': 'В {label} ✓',
  'library.projectPicker.useCloud': 'В {label}',
  'library.projectPicker.gdriveConnectTitle': 'Отправляйте проекты в папку SingZ на Google Drive — телефоны проиграют их оттуда без приложения Drive',
  'library.projectPicker.syncToDrive': 'Синхронизация с Google Drive',
  'library.projectPicker.connectDrive': 'Связать Google Drive…',
  'library.projectPicker.signOut': 'Выйти',
  'library.projectPicker.signedOut': 'Вы вышли из Google Drive.',
  'library.projectPicker.chooseFolder': 'Выбрать папку…',
  'library.projectPicker.backToDocuments': 'В «Документы»',
  'library.projectPicker.moving': 'Копируем проекты — старые файлы остаются на месте…',

  // ── LibraryImport (adopt a project found outside the library) ──
  'library.libraryImport.heading': 'Внести в библиотеку',
  // {dir}/{root}: filesystem paths, both stay bold
  'library.libraryImport.body': 'Этот проект в **{dir}**, вне библиотеки. Там он прекрасно работает — добавление поместит его в **{root}**, где он появится на экране «Открыть» и будет подхватываться синхронизацией Drive.',
  'library.libraryImport.copyIn': 'Копия',
  'library.libraryImport.copyInTitle': 'Продублировать папку в библиотеку — оригинал останется на месте',
  'library.libraryImport.moveIn': 'Перенос',
  'library.libraryImport.moveInTitle': 'Перенести папку в библиотеку — ничего не останется на месте',
  'library.libraryImport.workingHint': 'Обработка — проект с дорожками весит сотни МБ, подождите немного…',
  'library.libraryImport.copyMoveHint': 'Копия не трогает оригинал — то, что нужно, если папкой пользуется кто-то ещё. Перенос забирает всё, включая дорожки.',

  // ── LogPanel (chrome only — the log lines themselves stay English) ──
  'library.logPanel.title': 'Журнал',
  'library.logPanel.whichLaunch': 'Какой запуск?',
  'library.logPanel.thisSession': 'Этот запуск',
  // {shown}/{total}: line counts
  'library.logPanel.linesTail': 'последние {shown} из {total} строк — в файле будут все',
  'library.logPanel.linesCount': '{n} строк',
  'library.logPanel.copy': 'Копия',
  'library.logPanel.copied': 'Готово ✓',
  'library.logPanel.saveToFile': 'Сохранить…',
  'library.logPanel.loading': 'Ждите…',
  'library.logPanel.nothingLogged': 'Записей пока нет.',
  'library.logPanel.savedTo': 'Файл: {path}',

  // ── DropScreenRoute (loading / recovery states around the catalog) ──
  'library.route.eyebrow': 'Библиотека',
  'library.route.opening': 'Открытие песен…',
  'library.route.loadingStatus': 'Загрузка библиотеки.',
  'library.route.didntOpenHeading': 'Библиотека не открылась',
  'library.route.didntOpenBody': 'Не удалось загрузить экран библиотеки. Открытая песня и звуковая сессия не изменились.',
  'library.route.retry': 'Снова',
  'library.route.recoveryFailed': 'Резервную копию тоже не загрузить. Перезапустите SingZ и попробуйте снова.',
  'library.route.openSongFile': 'Открыть песню',
  'library.route.stoppedHeading': 'Библиотека остановилась',
  'library.route.stoppedBody': 'В экране библиотеки произошла ошибка. Перезапустите SingZ перед повторным открытием: синхронизация или удаление могут ещё продолжаться.',
  'library.route.openLog': 'Открыть журнал',

  // ── split-workflow (the split progress bar's stage labels) ──
  'library.splitWorkflow.warmingUp': 'Подготовка',
  'library.splitWorkflow.downloadingModel': 'Загрузка модели',
  'library.splitWorkflow.splittingStems': 'Разделение',
  'library.splitWorkflow.loadingStems': 'Дорожки',
  'library.splitWorkflow.loadingVocals': 'Вокал',
  'library.splitWorkflow.separatingVocals': 'Разделение вокала',
  // {step}: 1 or 2; {label}: one of the stage labels above
  'library.splitWorkflow.combinedLabel': '{step}/2 · {label}',

  // ── playback-error-toast ──
  // {message}: the underlying provider/engine failure text
  'library.playbackErrorToast.couldNotStart': 'Ошибка воспроизведения: {message}',

  // ── audio/engine (the one status genuinely shown to the singer, as this toast) ──
  'library.engine.songUnreadable': 'Эту песню не удалось перечитать с диска, так что играть нечего.'
}
