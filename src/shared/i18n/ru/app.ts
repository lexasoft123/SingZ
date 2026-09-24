/* Русский — the `app` strings, typed against English. */
import type { app as en } from '../en/app'
import type { Translation } from '../types'

export const app: Translation<typeof en> = {
  // ── lazy dialog route copy (LibraryImport / LogPanel / ProjectPicker / SetupModal) ──
  // read through getters on the route object, so they translate at every
  // render rather than freezing at module load — see App.tsx's route setup.
  'app.dialog.libraryImport.name': 'Добавить в библиотеку',
  'app.dialog.libraryImport.opening': 'Открытие настроек библиотеки…',
  'app.dialog.libraryImport.failureTitle': 'Настройки библиотеки не открылись',
  'app.dialog.libraryImport.failureMessage': 'Не удалось загрузить настройки библиотеки. Проект остался на месте.',
  'app.dialog.logPanel.name': 'Журнал',
  'app.dialog.logPanel.opening': 'Открытие журнала…',
  'app.dialog.logPanel.failureTitle': 'Журнал не открылся',
  'app.dialog.logPanel.failureMessage': 'Не удалось загрузить окно журнала. SingZ продолжает работать.',
  'app.dialog.projectPicker.name': 'Проекты',
  'app.dialog.projectPicker.opening': 'Открытие ваших проектов…',
  'app.dialog.projectPicker.failureTitle': 'Проекты не открылись',
  'app.dialog.projectPicker.failureMessage': 'Не удалось загрузить библиотеку проектов. Ни один проект не был изменён.',
  'app.dialog.setupModal.name': 'Настройка разделения на дорожки',
  'app.dialog.setupModal.opening': 'Открытие настройки разделения на дорожки…',
  'app.dialog.setupModal.failureTitle': 'Настройка не открылась',
  'app.dialog.setupModal.failureMessage': 'Не удалось загрузить настройку разделения на дорожки. Плеер всё ещё доступен.',

  // ── titlebar / section nav ──
  'app.titlebar.sections': 'Разделы SingZ',
  'app.titlebar.songs': 'Песни',
  'app.titlebar.training': 'Тренировка',
  'app.titlebar.catalogBack': 'Назад к вашей песне (Esc)',
  'app.titlebar.catalogBrowse': 'Просмотр библиотеки проектов — эта песня останется загруженной',
  'app.titlebar.catalog': 'Каталог',
  'app.titlebar.renameProject': 'Переименовать песню и папку проекта',
  'app.titlebar.renameSong': 'Переименовать песню',
  'app.titlebar.logTooltip': 'Что приложение делает под капотом — скопируйте или сохраните журнал, сообщая о проблеме',
  'app.titlebar.log': 'Журнал',
  // the desktop Settings gear button — title AND aria-label both use this
  'app.titlebar.settings': 'Настройки',

  // ── update chip ──
  'app.update.restartTitle': 'Обновление загружено — перезапуск установит его',
  'app.update.restart': 'Перезапустить для обновления',
  'app.update.availableTitle': 'Вышла новая версия — откроет страницу загрузки',
  // {version} is the app version number, e.g. "0.23.3"
  'app.update.get': 'Скачать v{version}',
  'app.update.downloadingTitle': 'Загрузка обновления в фоне',
  // {percent} is a 0-100 whole number
  'app.update.downloading': 'обновление {percent}%',

  // ── save / library ──
  'app.save.tooltipProject': 'Сохранить дорожки, текст и настройки в папку этого проекта',
  'app.save.tooltipLibrary': 'Сохранить песню, дорожки, текст и настройки в библиотеку проектов',
  'app.save.saved': 'Сохранено ✓',
  'app.save.saving': 'Сохранение…',
  'app.save.save': 'Сохранить',
  'app.save.unsavedTitle': 'Несохранённые изменения',
  'app.library.addTooltip': 'Этот проект находится вне вашей библиотеки — скопируйте или перенесите его туда',
  'app.library.add': 'Добавить в библиотеку…',
  'app.library.open': 'Открыть…',

  // ── engine/splitter status chip ──
  'app.engine.checking': 'проверяем ИИ…',
  // {command} is the splitter binary's own name/version string
  'app.engine.manageTitle': '{command} — нажмите, чтобы управлять моделями ИИ',
  'app.engine.ready': 'ИИ готов',
  'app.engine.setup': 'настроить ИИ',

  // ── vocal training empty states ──
  'app.training.loading': 'Загрузка профиля тренировок…',
  'app.training.unavailable': 'Профиль тренировок недоступен',
  'app.training.unavailableBody': 'Ваши сохранённые данные тренировок не изменились. Повторите, когда хранилище станет доступно.',
  'app.retry': 'Повторить',
  // {error} is the raw error text from the failed save
  'app.training.saveError': 'Профиль тренировок или история занятий не сохранены: {error}',

  // ── drag & drop ──
  'app.drop.release': 'Отпустите, чтобы загрузить',

  // ── analysis progress labels (HUD) ──
  'app.analysis.readingMelody': 'Распознаём мелодию',
  'app.analysis.findingBeat': 'Определяем ритм',

  // ── playback output/route toasts ──
  'app.output.confirmDenied': 'SingZ не разрешили подтвердить маршрут воспроизведения — выберите устройство вывода или повторите попытку',
  'app.output.missingDefault': 'Сохранённое устройство воспроизведения не подключено — используется системное по умолчанию',
  'app.output.switchDenied': 'SingZ не разрешили переключить устройство воспроизведения — используется прежнее',
  'app.output.switchFailed': 'Не удалось переключиться на это устройство — используется прежнее',

  // {message} is the monitor's own status text
  'app.monitor.stopped': 'Мониторинг в наушниках остановлен: {message}',

  // native engine rejected a live control change and the UI rolled back — {error} is the raw error text
  'app.native.beatNotApplied': 'Обновление сетки долей в нативном движке не применено: {error}',
  'app.native.metronomeNotApplied': 'Обновление метронома в нативном движке не применено: {error}',
  'app.native.transposeNotApplied': 'Обновление транспонирования в нативном движке не применено: {error}',
  'app.native.loopNotApplied': 'Обновление петли в нативном движке не применено: {error}',
  'app.native.tempoNotApplied': 'Обновление темпа в нативном движке не применено: {error}',
  'app.native.trainingNotApplied': 'Обновление тренировки в нативном движке не применено: {error}',

  // ── first-run / model wizard ──
  'app.wizard.qwenNotice':
    'Распознавание текста и «Проверить и выровнять» теперь используют Qwen3-ASR — речевую модель, обученную на пении: она заметно лучше слышит слова в песне, чем прежняя. Загрузите её ниже, когда вам будет удобно; старая модель будет удалена, как только новая установится.',

  // ── song open progress ──
  'app.load.opening': 'Открытие…',
  // {label} is the singer's own name for the added track
  'app.load.laneMissing': '«{label}» не удалось прочитать — эта дорожка отсутствует в миксе.',
  'app.load.readingStems': 'Чтение дорожек…',
  'app.load.drawingWaveforms': 'Построение волн…',
  // {list} is the silent stem names joined with "and", e.g. "guitar and piano"
  'app.load.silentStems_one': 'Разделено на шесть дорожек — {list} не звучит в этой песне, поэтому её дорожка скрыта.',
  'app.load.silentStems_few': 'Разделено на шесть дорожек — {list} не звучат в этой песне, поэтому их дорожки скрыты.',
  'app.load.silentStems_many': 'Разделено на шесть дорожек — {list} не звучат в этой песне, поэтому их дорожки скрыты.',
  'app.load.silentStems_other': 'Разделено на шесть дорожек — {list} не звучат в этой песне, поэтому их дорожки скрыты.',
  'app.load.startingPlayback': 'Запуск воспроизведения…',
  // {message} is the graph loader's own error text
  'app.load.graphError': 'Не удалось загрузить DSP-граф этого проекта. {message}',
  'app.load.decodeFailed': 'Не удалось декодировать этот аудиофайл.',

  // ── file/track errors ──
  'app.file.resolveFailed': 'Не удалось найти этот файл на диске.',
  // {name} is the file's own name
  'app.tracks.decodeFailed': 'Не удалось декодировать {name} — попробуйте MP3, WAV, FLAC или M4A.',
  // {names} is the added tracks' labels joined with ", "; {end} is a formatted time like "3:42"
  'app.tracks.addedExtends':
    'Добавлено {names} — дорожка начинается с 0:00 и длится дольше песни, поэтому таймлайн теперь заканчивается на {end}. Сохраните проект, чтобы сохранить её.',
  'app.tracks.addedAligned': 'Добавлено {names} — дорожка начинается с 0:00, вместе с остальными дорожками. Сохраните проект, чтобы сохранить её.',

  // ── splitting ──
  'app.split.rereadFailed': 'Не удалось повторно прочитать эту песню для разделения. Попробуйте открыть её снова.',
  'app.split.loadStemsFailed': 'Разделение завершено, но загрузить файлы дорожек не удалось.',
  // the auto-created lane name for a separated backing-vocal harmony
  'app.split.backingVocalsLabel': 'Бэк-вокал',
  'app.split.backingReady':
    'Ведущий вокал и бэк-вокал готовы. Мелодия теперь следует за ведущим вокалом. Сохраните проект, чтобы сохранить обе дорожки — накладывающиеся гармонии всё ещё могут остаться.',
  'app.beat.notFound': 'Устойчивый ритм не найден — задайте темп постукиванием.',

  // ── project save/import/rename ──
  // {dir} is the project's folder path
  'app.project.saved': 'Сохранено в {dir}',
  // {names} is the lost custom-track labels joined with ", "
  'app.project.savedMissingFile':
    'Сохранено в {dir} — но {names} не удалось скопировать (файла больше нет там, откуда вы его добавили).',
  'app.project.savedDriveSignedOut':
    'Сохранено в {dir} — на этом компьютере вы не вошли в Google Drive, поэтому телефоны не увидят это, пока вы не войдёте (экран «Открыть…»).',
  'app.project.saveFailed': 'Не удалось сохранить проект: {error}',
  'app.project.moved': 'Перенесено в вашу библиотеку — теперь проект находится в {dir}',
  'app.project.copied': 'Скопировано в вашу библиотеку — {dir}. Исходная папка не изменена.',
  'app.project.renamed': 'Переименовано — теперь папка проекта называется {dir}'
}
