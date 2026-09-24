/* Русский — the `library` strings, typed against English. */
import type { library as en } from '../en/library'
import type { Translation } from '../../../../src/shared/i18n/types'

export const library: Translation<typeof en> = {
  // ── add-song errors ──
  'phone.library.pickFailed': 'Не удалось открыть этот файл ({msg})',
  'phone.library.folderInactive': 'Выбранная папка больше не активна. Откройте её заново и попробуйте снова.',
  'phone.library.folderIdentityUnavailable':
    'Идентификатор выбранной папки недоступен. Откройте папку заново и попробуйте снова.',
  'phone.library.folderPickerError': 'Выбор папки: {error}',
  'phone.library.projectDocumentNotWritten': 'Файл проекта не был записан.',
  'phone.library.decodeTimeout': 'он не открылся за 90 секунд',

  // ── forget / free space ──
  'phone.library.forgetBody':
    'Удалить {size} с этого телефона? Песня останется в вашей библиотеке — при повторном открытии она снова загрузится.',
  'phone.library.keepIt': 'Оставить',
  'phone.library.remove': 'Удалить',
  'phone.library.freeUpSpace': 'Освободить место',
  'phone.library.freeUpSpaceBody':
    'Удалить {size} загруженных песен? Они останутся в вашей библиотеке — вы сможете загрузить их снова, как только появится сигнал.',
  'phone.library.keepThem': 'Оставить их',
  'phone.library.delete': 'Удалить',

  // ── opening a song ──
  'phone.library.opening': 'Открытие…',
  'phone.library.decoding': 'Декодирование {id} · {i}/{n}',
  'phone.library.fetchingStep': 'Загрузка {id} · {i}/{n}',
  'phone.library.decodingStep': 'Декодирование {id} · {i}/{n}',
  'phone.library.lyricsStep': 'Текст…',
  'phone.library.fetchingLyricsStep': 'Загрузка текста…',
  'phone.library.songTooBigToPlay':
    'Для воспроизведения этой песни нужно около {gb} ГБ памяти — слишком много для этого телефона. Попробуйте песню покороче или разделите её на компьютере.',
  'phone.library.addedTrackLoadFailed':
    'Не удалось загрузить добавленную дорожку «{label}». Песня не открылась, потому что должны быть доступны все сохранённые дорожки. {detail}',

  // ── lyrics lookup from the card ──
  'phone.library.lookingForLyrics': 'Поиск текста…',
  'phone.library.noLyricsYet': 'Текста пока нет',
  'phone.library.lyricsServiceDown': 'Сервис текстов не ответил — попробуйте позже.',
  'phone.library.lyricsNoMatch': 'По этому названию ничего не нашлось. Текст можно добавить и на компьютере.',

  // ── beat models (Better beats) ──
  'phone.library.betterBeats': 'Точнее биты',
  'phone.library.downloadBeatModelsTitle': 'Загрузить модели для определения ритма?',
  'phone.library.downloadBeatModelsBody': '{mb} МБ, один раз. Каждая песня, проанализированная после этого, будет использовать их.',
  'phone.library.notNow': 'Не сейчас',
  'phone.library.download': 'Загрузить',
  'phone.library.couldNotDownloadBeatModels': 'Не удалось загрузить модели для определения ритма',
  'phone.library.downloadingBeatModels': 'Загрузка моделей для определения ритма — {got} из {total} МБ',
  'phone.library.betterBeatsOfferBody':
    'Разовая загрузка {mb} МБ, которая слышит ритм сквозь тихие вступления и рубато, где одни барабаны его теряют. Песни, у которых уже есть сетка, сохранят её.',
  'phone.library.cancel': 'Отмена',
  'phone.library.waitingThenSplitter': 'Ожидание загрузки моделей ритма — затем разделитель ({mb} МБ, один раз)',
  'phone.library.downloadingSplitter': 'Загрузка разделителя — {got} из {total} МБ, один раз',
  'phone.library.sampleTitle': 'Пример — {name}',

  // ── splitting a song into stems ──
  'phone.library.readingTheSong': 'Чтение песни…',
  'phone.library.warmingUp': 'Подготовка…',
  'phone.library.splittingChunk': 'Разделение на дорожки — часть {done} из {total}',
  'phone.library.splittingEllipsis': 'Разделение на дорожки…',
  'phone.library.splitFailed': 'Разделение не удалось',
  'phone.library.splitNeverStarted': 'Разделение так и не началось — попробуйте снова',
  'phone.library.splitInterrupted': 'Разделение было прервано',
  'phone.library.tooBigToSplitTitle': 'Эта песня слишком большая, чтобы разделить её здесь',
  'phone.library.starting': 'Запуск…',
  'phone.library.couldNotStartSplitTitle': 'Не удалось начать разделение',
  'phone.library.splittingNotAvailable': 'На этом телефоне разделение пока недоступно',
  'phone.library.splitEngineHeldCopy':
    'Предыдущее разделение всё ещё зависло на этом телефоне. Полностью закройте SingZ и откройте снова, затем разделите.',
  'phone.library.splitThisSongTitle': 'Разделить эту песню?',
  'phone.library.splitThisSongBody':
    'Телефон разделит её на вокал, барабаны, бас и другое — несколько минут работы и разовая загрузка 136 МБ в первый раз.',
  'phone.library.failedSplitDiscarded': '\n\nНеудачное разделение «{name}» будет отменено.',
  'phone.library.splitButton': 'Разделить',
  'phone.library.almostDoneSplittingTitle': 'Разделение почти завершено',
  'phone.library.almostDoneSplittingBody': 'Эта песня вот-вот будет готова — удалите её через момент.',
  'phone.library.finishingUp': 'Завершение…',
  'phone.library.stopping': 'Остановка…',
  'phone.library.resume': 'Продолжить',
  'phone.library.discard': 'Отменить',
  'phone.library.splitUnavailableBusy': 'Разделить — недоступно, пока идёт другое разделение',
  'phone.library.splitInto': 'Разделить {name} на дорожки',
  'phone.library.notSplitYet': 'ещё не разделена',
  'phone.library.keepsFailingCopy':
    'Эта песня на этом телефоне всё время не разделяется. Добавьте её на компьютере — она синхронизируется уже готовой к пению.',
  'phone.library.fileFailingCopy':
    'Этот телефон не смог прочитать файл этой песни. Попробуйте другую копию файла — или добавьте её на компьютере, и она синхронизируется уже готовой к пению.',
  'phone.library.stemsCount_one': '{n} дорожка',
  'phone.library.stemsCount_few': '{n} дорожки',
  'phone.library.stemsCount_many': '{n} дорожек',
  'phone.library.stemsCount_other': '{n} дорожки',
  'phone.library.addedSuffix': ' · добавлено {n}',
  'phone.library.lyricsSuffix': ' · текст',
  'phone.library.updateOnDesktop': ' · обновить на компьютере',

  // ── delete ──
  'phone.library.deleteThisSongTitle': 'Удалить эту песню?',
  'phone.library.deleteThisSongBody': '«{name}» и её файлы будут удалены.',

  // ── header / nav ──
  'phone.library.openSettings': 'Открыть настройки',
  'phone.library.settings': 'Настройки',
  'phone.library.openLog': 'Открыть журнал',
  'phone.library.log': 'Журнал',
  'phone.library.driveTab': 'Drive',
  'phone.library.folderTab': 'Папка',
  'phone.library.thisIphone': 'Этот iPhone',
  'phone.library.thisPhone': 'Этот телефон',

  // ── source descriptions (the banner under the three tabs) ──
  'phone.library.driveSrcTitle': 'Библиотека вашего компьютера, синхронизированная через Drive',
  'phone.library.folderSrcTitle': 'Общая папка, которую может читать этот телефон',
  'phone.library.songsAddedIphone': 'Песни, добавленные на этом iPhone',
  'phone.library.songsAddedPhone': 'Песни, добавленные на этом телефоне',
  'phone.library.noSignalLastSync': 'Нет сигнала — показана последняя синхронизация',
  'phone.library.signedInToDrive': 'Вход в Google Drive выполнен',
  'phone.library.signOut': 'Выйти',
  'phone.library.signInToSeeIt': 'Войдите, чтобы увидеть их',
  'phone.library.signIn': 'Войти',
  'phone.library.noFolderPicked': 'Папка пока не выбрана',
  'phone.library.change': 'Изменить…',
  'phone.library.filesCopiedIphone': 'Файлы, скопированные на этот iPhone',
  'phone.library.filesCopiedPhone': 'Файлы, скопированные на этот телефон',
  'phone.library.addASong': 'Добавить песню',
  'phone.library.driveNotConfigured': 'В этой сборке Google Drive не настроен',
  'phone.library.driveNotSignedIn': 'Нет входа в Google Drive',
  'phone.library.driveSessionExpired': 'Сессия Google Drive истекла — войдите снова',
  'phone.library.driveNoSingzFolder':
    'В этом Google Drive пока нет папки SingZ — сначала синхронизируйте проект с компьютера',

  // ── crash note banner ──
  'phone.library.lastOpenCrashed': 'Последний запуск завершился сбоем во время: {note}.',
  'phone.library.openLogToReport': 'Откройте журнал, чтобы сообщить об этом',
  'phone.library.report': 'Сообщить',
  'phone.library.dismissCrashNotice': 'Скрыть уведомление о сбое',
  'phone.library.tapToDismiss': '{error}. Нажмите, чтобы скрыть.',

  // ── card ──
  'phone.library.opensTheSong': 'Открывает песню.',
  'phone.library.stopOpeningSong': 'Остановить открытие этой песни',
  'phone.library.onThisPhone': 'На этом телефоне',
  'phone.library.notDownloadedSize': 'Не загружено, {size}',
  'phone.library.notDownloaded': 'Не загружено',
  'phone.library.detectBeatAgainFor': 'Определить ритм заново для {title}',
  'phone.library.findLyricsFor': 'Найти текст для {title}',
  'phone.library.deleteFromPhone': 'Удалить {title} с этого телефона',
  'phone.library.removeDownloadedFiles': 'Удалить загруженные файлы {title}',

  // ── list groups / empty states ──
  'phone.library.ready': 'Готово',
  'phone.library.notReadyYet': 'Ещё не готово',
  'phone.library.bundledAlwaysAvailable': 'встроено · всегда доступно',
  'phone.library.loadingFromDrive': 'Загрузка вашей библиотеки из Google Drive…',
  'phone.library.loadingEllipsis': 'Загрузка…',
  'phone.library.noSongCalled': 'Здесь нет песни с названием «{query}».',
  'phone.library.noSongsIphone':
    'На этом iPhone пока нет песен. Добавьте песню выше — она сразу заиграет, и её можно будет разделить на дорожки здесь.',
  'phone.library.noSongsPhone':
    'На этом телефоне пока нет песен. Добавьте песню выше — она сразу заиграет, и её можно будет разделить на дорожки здесь.',
  'phone.library.driveEmptySignedIn':
    'В вашей библиотеке Google Drive пока ничего нет. Сохраните песню на компьютере, и она синхронизируется сюда.',
  'phone.library.driveEmptySignedOut': 'Войдите выше, чтобы увидеть песни, которые ваш компьютер поместил в Google Drive.',
  'phone.library.folderEmptyIos':
    'В этой папке нет проектов. Сохраните проект на компьютере в общую папку (iCloud Drive/SingZ) или выберите другую папку выше.',
  'phone.library.folderEmptyAndroid':
    'В этой папке нет проектов. Скопируйте папки проектов с компьютера на этот телефон или выберите синхронизированную папку выше.',
  'phone.library.storage_one': '{n} песня на этом телефоне · {size} — можно слушать без интернета',
  'phone.library.storage_few': '{n} песни на этом телефоне · {size} — можно слушать без интернета',
  'phone.library.storage_many': '{n} песен на этом телефоне · {size} — можно слушать без интернета',
  'phone.library.storage_other': '{n} песни на этом телефоне · {size} — можно слушать без интернета',

  // ── search ──
  'phone.library.findASong': 'Найти песню',
  'phone.library.findASongLabel': 'Найти песню по названию',
  'phone.library.clearSearch': 'Очистить поиск',

  // ── add-song sheet ──
  'phone.library.addSongCancelA11y': 'Отменить добавление этой песни',
  'phone.library.addingToPhone': 'Добавление на этот телефон…',
  'phone.library.copyingFile': 'Копирование файла — для обычной песни это несколько секунд.',
  'phone.library.unreadableFile':
    'Этот файл нельзя воспроизвести на этом телефоне — возможно, это формат, который SingZ не читает. Подробности в журнале.',
  'phone.library.close': 'Закрыть',
  'phone.library.titleLabel': 'Название',
  'phone.library.songTitlePlaceholder': 'Название песни',
  'phone.library.artistLabel': 'Исполнитель',
  'phone.library.artistPlaceholder': 'Помогает найти нужный текст',
  'phone.library.addSongDuration': '{mins}:{secs} — {name}',
  'phone.library.findLyricsButton': 'Найти текст',
  'phone.library.addWithoutLyrics': 'Добавить без текста',
  'phone.library.syncedLyricsFound': 'Найден синхронизированный текст',
  'phone.library.useTheseLyrics': 'Использовать этот текст',
  'phone.library.skip': 'Пропустить',
  'phone.library.editTitle': 'Изменить название',
  'phone.library.moreLines': '…ещё {n} строк',
  'phone.library.lyricsServiceDownStillAdds':
    'Сервис текстов не ответил — песня всё равно нормально добавится, а текст можно будет найти позже с её карточки.',
  'phone.library.tryAgain': 'Попробовать снова',
  'phone.library.noExactMatch': 'Точного совпадения нет.',
  'phone.library.closeMatches': 'Похожие варианты:',
  'phone.library.searchAgain': 'Искать снова',
  'phone.library.syncedSuffix': ' · синхронизировано',
  'phone.library.textOnlySuffix': ' · только текст'
}
