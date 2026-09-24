/* Русский — the `library` strings, typed against English. */
import type { library as en } from '../en/library'
import type { Translation } from '../../../../src/shared/i18n/types'

export const library: Translation<typeof en> = {
  // ── add-song errors ──
  'phone.library.pickFailed': 'Не удалось открыть этот файл ({msg})',
  'phone.library.folderInactive': 'Папка больше не активна. Откройте её заново и попробуйте снова.',
  'phone.library.folderIdentityUnavailable':
    'Идентификатор папки недоступен. Откройте её заново и попробуйте снова.',
  'phone.library.folderPickerError': 'Выбор папки: {error}',
  'phone.library.projectDocumentNotWritten': 'Файл проекта не был записан.',
  'phone.library.decodeTimeout': 'он не открылся за 90 секунд',

  // ── forget / free space ──
  'phone.library.forgetBody':
    'Удалить {size} с телефона? Песня останется в библиотеке — при повторном открытии загрузится снова.',
  'phone.library.keepIt': 'Оставить',
  'phone.library.remove': 'Удалить',
  'phone.library.freeUpSpace': 'Освободить место',
  'phone.library.freeUpSpaceBody':
    'Удалить {size} загруженных песен? Они останутся в библиотеке — загрузите их снова, как только будет сигнал.',
  'phone.library.keepThem': 'Оставить их',
  'phone.library.delete': 'Удалить',

  // ── opening a song ──
  'phone.library.opening': 'Открытие…',
  'phone.library.decoding': 'Чтение {id} · {i}/{n}',
  'phone.library.fetchingStep': 'Загрузка {id} · {i}/{n}',
  'phone.library.decodingStep': 'Чтение {id} · {i}/{n}',
  'phone.library.lyricsStep': 'Текст…',
  'phone.library.fetchingLyricsStep': 'Загрузка текста…',
  'phone.library.songTooBigToPlay':
    'Нужно около {gb} ГБ памяти — слишком много для телефона. Попробуйте песню покороче или разделите на компьютере.',
  'phone.library.addedTrackLoadFailed':
    'Не удалось загрузить дорожку «{label}». Песня не открылась — нужны все сохранённые дорожки. {detail}',

  // ── lyrics lookup from the card ──
  'phone.library.lookingForLyrics': 'Поиск текста…',
  'phone.library.noLyricsYet': 'Текста пока нет',
  'phone.library.lyricsServiceDown': 'Сервис текстов не ответил — попробуйте позже.',
  'phone.library.lyricsNoMatch': 'По названию ничего не нашлось. Текст можно добавить на компьютере.',

  // ── beat models (Better beats) ──
  'phone.library.betterBeats': 'Точнее биты',
  'phone.library.downloadBeatModelsTitle': 'Загрузить модели ритма?',
  'phone.library.downloadBeatModelsBody': '{mb} МБ, один раз. Каждая песня потом использует их.',
  'phone.library.notNow': 'Не сейчас',
  'phone.library.download': 'Загрузить',
  'phone.library.couldNotDownloadBeatModels': 'Не удалось загрузить модели ритма',
  'phone.library.downloadingBeatModels': 'Загрузка моделей ритма — {got} из {total} МБ',
  'phone.library.betterBeatsOfferBody':
    'Разовая загрузка {mb} МБ — слышит ритм сквозь тихие вступления и рубато, где барабаны его теряют. Песни с готовой сеткой её сохранят.',
  'phone.library.cancel': 'Отмена',
  'phone.library.waitingThenSplitter': 'Ожидание загрузки моделей ритма — затем разделитель ({mb} МБ, один раз)',
  'phone.library.downloadingSplitter': 'Загрузка разделителя — {got} из {total} МБ, один раз',
  'phone.library.sampleTitle': 'Пример — {name}',

  // ── splitting a song into stems ──
  'phone.library.readingTheSong': 'Чтение песни…',
  'phone.library.warmingUp': 'Подготовка…',
  'phone.library.splittingChunk': 'Разделение на дорожки — часть {done}/{total}',
  'phone.library.splittingEllipsis': 'Разделение…',
  'phone.library.splitFailed': 'Сбой разделения',
  'phone.library.splitNeverStarted': 'Разделение не началось — ещё раз',
  'phone.library.splitInterrupted': 'Разделение было прервано',
  'phone.library.tooBigToSplitTitle': 'Песня велика для разделения',
  'phone.library.starting': 'Запуск…',
  'phone.library.couldNotStartSplitTitle': 'Разделение не запустилось',
  'phone.library.splittingNotAvailable': 'На телефоне разделение недоступно',
  'phone.library.splitEngineHeldCopy':
    'Предыдущее разделение зависло на телефоне. Закройте SingZ полностью, откройте снова и разделите.',
  'phone.library.splitThisSongTitle': 'Разделить песню?',
  'phone.library.splitThisSongBody':
    'Телефон разделит её на вокал, барабаны, бас и другое — несколько минут работы и разовая загрузка 136 МБ в первый раз.',
  'phone.library.failedSplitDiscarded': '\n\nНеудачное разделение «{name}» будет отменено.',
  'phone.library.splitButton': 'Разбить',
  'phone.library.almostDoneSplittingTitle': 'Разделение почти готово',
  'phone.library.almostDoneSplittingBody': 'Эта песня почти готова — удалите её через момент.',
  'phone.library.finishingUp': 'Завершение…',
  'phone.library.stopping': 'Остановка…',
  'phone.library.resume': 'Дальше',
  'phone.library.discard': 'Сброс',
  'phone.library.splitUnavailableBusy': 'Разделить — недоступно, пока идёт другое разделение',
  'phone.library.splitInto': 'Разбить {name}',
  'phone.library.notSplitYet': 'не разделена',
  'phone.library.keepsFailingCopy':
    'Эта песня всё время не разделяется на телефоне. Добавьте её на компьютере — придёт уже готовой к пению.',
  'phone.library.fileFailingCopy':
    'Телефон не смог прочитать файл песни. Попробуйте другую копию — или добавьте её на компьютере, и она придёт уже готовой к пению.',
  'phone.library.stemsCount_one': '{n} дорожка',
  'phone.library.stemsCount_few': '{n} дорожки',
  'phone.library.stemsCount_many': '{n} дорожек',
  'phone.library.stemsCount_other': '{n} дорожки',
  'phone.library.addedSuffix': ' · +{n}',
  'phone.library.lyricsSuffix': ' · текст',
  'phone.library.updateOnDesktop': ' · обновить на ПК',

  // ── delete ──
  'phone.library.deleteThisSongTitle': 'Удалить песню?',
  'phone.library.deleteThisSongBody': '«{name}» и её файлы удалятся.',

  // ── header / nav ──
  'phone.library.openSettings': 'К настройкам',
  'phone.library.settings': 'Настройки',
  'phone.library.openLog': 'К журналу',
  'phone.library.log': 'Журнал',
  'phone.library.driveTab': 'Drive',
  'phone.library.folderTab': 'Папка',
  'phone.library.thisIphone': 'Этот iPhone',
  'phone.library.thisPhone': 'Телефон',

  // ── source descriptions (the banner under the three tabs) ──
  'phone.library.driveSrcTitle': 'Библиотека компьютера, синхронизация Drive',
  'phone.library.folderSrcTitle': 'Общая папка, доступная телефону',
  'phone.library.songsAddedIphone': 'Песни на этом iPhone',
  'phone.library.songsAddedPhone': 'Песни на этом телефоне',
  'phone.library.noSignalLastSync': 'Нет сигнала — старая синхронизация',
  'phone.library.signedInToDrive': 'Вход в Google Drive есть',
  'phone.library.signOut': 'Выйти',
  'phone.library.signInToSeeIt': 'Войдите — увидите',
  'phone.library.signIn': 'Войти',
  'phone.library.noFolderPicked': 'Папка не выбрана',
  'phone.library.change': 'Изменить…',
  'phone.library.filesCopiedIphone': 'Файлы на этом iPhone',
  'phone.library.filesCopiedPhone': 'Файлы на этом телефоне',
  'phone.library.addASong': 'Добавить',
  'phone.library.driveNotConfigured': 'В этой сборке Google Drive не настроен',
  'phone.library.driveNotSignedIn': 'Нет входа в Google Drive',
  'phone.library.driveSessionExpired': 'Сессия Google Drive истекла — войдите снова',
  'phone.library.driveNoSingzFolder':
    'В Google Drive пока нет папки SingZ — синхронизируйте проект с компьютера',

  // ── crash note banner ──
  'phone.library.lastOpenCrashed': 'Сбой при последнем запуске: {note}.',
  'phone.library.openLogToReport': 'Откройте журнал, чтобы сообщить',
  'phone.library.report': 'Сообщить',
  'phone.library.dismissCrashNotice': 'Скрыть сообщение о сбое',
  'phone.library.tapToDismiss': '{error}. Нажмите — скрыть.',

  // ── card ──
  'phone.library.opensTheSong': 'Открывает песню',
  'phone.library.stopOpeningSong': 'Прервать открытие',
  'phone.library.onThisPhone': 'На телефоне',
  'phone.library.notDownloadedSize': 'Не загружено, {size}',
  'phone.library.notDownloaded': 'Не загружено',
  'phone.library.detectBeatAgainFor': 'Найти ритм заново для {title}',
  'phone.library.findLyricsFor': 'Найти текст для {title}',
  'phone.library.deleteFromPhone': 'Удалить {title} с телефона',
  'phone.library.removeDownloadedFiles': 'Удалить загруженные файлы {title}',

  // ── list groups / empty states ──
  'phone.library.ready': 'Готово',
  'phone.library.notReadyYet': 'Ещё не готово',
  'phone.library.bundledAlwaysAvailable': 'встроено · всегда есть',
  'phone.library.loadingFromDrive': 'Загрузка библиотеки из Google Drive…',
  'phone.library.loadingEllipsis': 'Загрузка…',
  'phone.library.noSongCalled': 'Нет песни с названием «{query}».',
  'phone.library.noSongsIphone':
    'На этом iPhone пока нет песен. Добавьте песню выше — она сразу заиграет и разделится на дорожки здесь.',
  'phone.library.noSongsPhone':
    'На телефоне пока нет песен. Добавьте песню выше — она сразу заиграет и разделится на дорожки здесь.',
  'phone.library.driveEmptySignedIn':
    'В библиотеке Google Drive ничего нет. Сохраните песню на компьютере — она придёт сюда.',
  'phone.library.driveEmptySignedOut': 'Войдите выше, чтобы увидеть песни компьютера в Google Drive.',
  'phone.library.folderEmptyIos':
    'В этой папке нет проектов. Сохраните проект на компьютере в общую папку (iCloud Drive/SingZ) или выберите другую папку выше.',
  'phone.library.folderEmptyAndroid':
    'В папке нет проектов. Скопируйте папки проектов с компьютера на телефон или выберите папку выше.',
  'phone.library.storage_one': '{n} песня на телефоне · {size} — можно слушать без сети',
  'phone.library.storage_few': '{n} песни на телефоне · {size} — можно слушать без сети',
  'phone.library.storage_many': '{n} песен на телефоне · {size} — можно слушать без сети',
  'phone.library.storage_other': '{n} песни на телефоне · {size} — можно слушать без сети',

  // ── search ──
  'phone.library.findASong': 'Найти песню',
  'phone.library.findASongLabel': 'Поиск по названию',
  'phone.library.clearSearch': 'Очистить поиск',

  // ── add-song sheet ──
  'phone.library.addSongCancelA11y': 'Отменить добавление',
  'phone.library.addingToPhone': 'Добавление на телефон…',
  'phone.library.copyingFile': 'Копирование файла — обычно несколько секунд.',
  'phone.library.unreadableFile':
    'Файл не воспроизвести на телефоне — возможно, формат, который SingZ не читает. Подробности в журнале.',
  'phone.library.close': 'Закрыть',
  'phone.library.titleLabel': 'Название',
  'phone.library.songTitlePlaceholder': 'Название',
  'phone.library.artistLabel': 'Артист',
  'phone.library.artistPlaceholder': 'Помогает найти нужный текст',
  'phone.library.addSongDuration': '{mins}:{secs} — {name}',
  'phone.library.findLyricsButton': 'Найти текст',
  'phone.library.addWithoutLyrics': 'Без текста',
  'phone.library.syncedLyricsFound': 'Текст синхронен',
  'phone.library.useTheseLyrics': 'Взять текст',
  'phone.library.skip': 'Пропуск',
  'phone.library.editTitle': 'Изменить',
  'phone.library.moreLines': '…всего строк: {n}',
  'phone.library.lyricsServiceDownStillAdds':
    'Сервис текстов не ответил — песня всё равно добавится, а текст можно будет найти позже с её карточки.',
  'phone.library.tryAgain': 'Ещё раз',
  'phone.library.noExactMatch': 'Совпадений нет.',
  'phone.library.closeMatches': 'Похожие:',
  'phone.library.searchAgain': 'Искать снова',
  'phone.library.syncedSuffix': ' · тайминг',
  'phone.library.textOnlySuffix': ' · текст',

  // ── moving songs to Google Drive (Phase 6) ──
  'phone.library.moveBusyTitle': 'Добавление в Google Drive',
  'phone.library.moveBusyBody': 'Остановите или дайте закончить — потом папка откроется.',
  'phone.library.onItsWayTitle': 'В пути в Google Drive',
  'phone.library.onItsWayBody': 'Остановите перенос или подождите немного.',
  'phone.library.addingASongToDrive': 'Песня — в Google Drive',
  'phone.library.addingSongsToDrive': 'Песни — в Google Drive',
  'phone.library.stoppingAfterFile': 'Остановка после файла…',
  'phone.library.songOfCountPct': '№{index} из {count} · {pct}%',
  'phone.library.stop': 'Стоп',
  'phone.library.movingToDrive': 'Перенос в Google Drive…',
  'phone.library.alsoInDriveSuffix': 'Также в Google Drive · ',

  // ── moving songs to Google Drive: the offer ──
  'phone.library.driveOfferTitle': 'Google Drive',
  'phone.library.deviceIphone': 'iPhone',
  'phone.library.devicePhone': 'телефоне',
  'phone.library.offerLeadPartialOne':
    '1 песня на {device}, примерно {bytes}. Она перейдёт в библиотеку Drive и будет играть из вкладки Drive, уже загруженная.',
  'phone.library.offerLeadPartialOther':
    '{n} песен на {device}, примерно {bytes}. Они перейдут в библиотеку Drive и будут играть из вкладки Drive, уже загруженными.',
  'phone.library.offerLeadAllOne':
    'Песня на {device}, примерно {bytes}. Она перейдёт в библиотеку Drive и будет играть из вкладки Drive, уже загруженная.',
  'phone.library.offerLeadAllTwo':
    'Обе песни на {device}, примерно {bytes}. Они перейдут в библиотеку Drive и будут играть из вкладки Drive, уже загруженными.',
  'phone.library.offerLeadAllOther':
    'Все {n} песен на {device}, примерно {bytes}. Они перейдут в библиотеку Drive и будут играть из вкладки Drive, уже загруженными.',
  'phone.library.offerUnsplit_one': ' Неразделённая песня — тут.',
  'phone.library.offerUnsplit_few': ' Неразделённые {n} песни — тут.',
  'phone.library.offerUnsplit_many': ' Неразделённых {n} песен — тут.',
  'phone.library.offerUnsplit_other': ' Неразделённые {n} песни — тут.',
  'phone.library.offerCopies_one': ' Песня, уже в библиотеке Drive, останется здесь.',
  'phone.library.offerCopies_few': ' {n} песни, уже в библиотеке Drive, останутся здесь.',
  'phone.library.offerCopies_many': ' {n} песен, уже в библиотеке Drive, останутся здесь.',
  'phone.library.offerCopies_other': ' {n} песни, уже в библиотеке Drive, останутся здесь.',
  'phone.library.addAllLocalSongs': 'Добавить все песни в Google Drive',

  // ── moving songs to Google Drive: the confirm ──
  'phone.library.addConfirmTitleOne': 'Добавить песню в Google Drive?',
  'phone.library.addConfirmTitleTwo': 'Добавить обе в Google Drive?',
  'phone.library.addConfirmTitleOther_one': 'Добавить {n} песню в Google Drive?',
  'phone.library.addConfirmTitleOther_few': 'Добавить {n} песни в Google Drive?',
  'phone.library.addConfirmTitleOther_many': 'Добавить {n} песен в Google Drive?',
  'phone.library.addConfirmTitleOther_other': 'Добавить {n} песни в Google Drive?',
  'phone.library.addConfirmBodyOne':
    '{bytes} отправится. Песня покинет {here}, как только окажется в Drive, и будет играть из вкладки Drive, уже загруженная. Стоп — когда угодно: до отправки она остаётся здесь.',
  'phone.library.addConfirmBodyMany':
    '{bytes} отправится. Каждая покинет {here}, как только окажется в Drive, и будет играть из вкладки Drive, уже загруженная. Стоп — когда угодно: что не отправилось, остаётся здесь.',
  'phone.library.add': 'Добавить',
  'phone.library.addAll': 'Добавить все',
  'phone.library.hereIphone': 'этот iPhone',
  'phone.library.herePhone': 'этот телефон',

  // ── moving songs to Google Drive: how a batch ended ──
  'phone.library.songsCount_one': '{n} песня',
  'phone.library.songsCount_few': '{n} песни',
  'phone.library.songsCount_many': '{n} песен',
  'phone.library.songsCount_other': '{n} песни',
  'phone.library.showMe': 'Показать',
  'phone.library.openDrive': 'Открыть Drive',
  'phone.library.ok': 'ОК',
  'phone.library.twoInARowFailed':
    'Две песни подряд не отправились ({message}) — скорее всего, пропала связь. Попробуйте снова, когда будете онлайн.',
  'phone.library.stoppedPartWay': 'Прервано',
  'phone.library.notAddedYet': 'Не добавлено',
  'phone.library.wentUpBeforeStopped': '\n\n{songs} загрузились до остановки; остальные остаются на {here}.',
  'phone.library.everythingStillOn': '\n\nВсё остаётся на {here}.',
  'phone.library.nothingLeftToAdd': 'Нечего добавлять',
  'phone.library.thoseSongsGone': 'Этих песен больше нет на {here}.',
  'phone.library.addedToGoogleDrive': 'Уже в Google Drive',
  'phone.library.nothingWentUp': 'Ничего не ушло',
  'phone.library.movedOneWithSkip':
    '1 песня теперь в вашей библиотеке Google Drive — уже загружена, поэтому сразу заиграет. ',
  'phone.library.movedOneNoSkip':
    'Песня теперь в вашей библиотеке Google Drive — уже загружена, поэтому сразу заиграет. ',
  'phone.library.movedManyWithSkip_one': '{n} песня теперь в вашей библиотеке Google Drive — уже загружена, поэтому сразу заиграет. ',
  'phone.library.movedManyWithSkip_few': '{n} песни теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.movedManyWithSkip_many': '{n} песен теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.movedManyWithSkip_other': '{n} песни теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.movedTwoNoSkip':
    'Обе песни теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.movedAllNoSkip_one': 'Все {n} песня теперь в вашей библиотеке Google Drive — уже загружена, поэтому сразу заиграет. ',
  'phone.library.movedAllNoSkip_few': 'Все {n} песни теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.movedAllNoSkip_many': 'Все {n} песен теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.movedAllNoSkip_other': 'Все {n} песни теперь в вашей библиотеке Google Drive — уже загружены, поэтому сразу заиграют. ',
  'phone.library.syncsNextTimeOne': 'Компьютер добавит её в библиотеку при следующей синхронизации. ',
  'phone.library.syncsNextTimeMany': 'Ваш компьютер добавит их в библиотеку при следующей синхронизации. ',
  'phone.library.stayedOnPhone': '{songs} — на {here}: {reasons}',
  'phone.library.moreInLog': ' — и другие, список в журнале.',

  // ── moving songs to Google Drive: skip / stop reasons (also used by publish.ts) ──
  'phone.library.skipInUse': 'она занята — открыта, делится или анализируется',
  'phone.library.skipAlreadyInDrive': 'она уже в вашей библиотеке Google Drive',
  'phone.library.notSplitForMove': 'Разделите песню на дорожки — тогда она переместится в Google Drive.',
  'phone.library.signInFirstForMove': 'Войдите в Google Drive — откройте вкладку Drive выше.',
  'phone.library.updateDesktopForMove':
    'Обновите SingZ на компьютере. Версия, синхронизирующая этот Drive, удалит песни, которые не создавала, — и они будут потеряны.',
  'phone.library.stoppedSongStill': 'Остановлено — песня всё ещё на телефоне.',
  'phone.library.stoppedRestStill': 'Остановлено — остальные на телефоне.',
  'phone.library.connectionDroppedSkip': 'связь пропала, пока она загружалась — попадёт в следующее «Добавить все»'
}
