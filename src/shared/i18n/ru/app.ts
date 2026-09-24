/* Русский — the `app` strings, typed against English. */
import type { app as en } from '../en/app'
import type { Translation } from '../types'

export const app: Translation<typeof en> = {
  // ── lazy dialog route copy (LibraryImport / LogPanel / ProjectPicker / SetupModal) ──
  // read through getters on the route object, so they translate at every
  // render rather than freezing at module load — see App.tsx's route setup.
  'app.dialog.libraryImport.name': 'В библиотеку',
  'app.dialog.libraryImport.opening': 'Настройки библиотеки…',
  'app.dialog.libraryImport.failureTitle': 'Библиотека не открылась',
  'app.dialog.libraryImport.failureMessage': 'Не удалось загрузить настройки библиотеки. Проект остался на месте.',
  'app.dialog.logPanel.name': 'Журнал',
  'app.dialog.logPanel.opening': 'Открываю журнал…',
  'app.dialog.logPanel.failureTitle': 'Сбой открытия',
  'app.dialog.logPanel.failureMessage': 'Не удалось загрузить журнал. SingZ продолжает работать.',
  'app.dialog.projectPicker.name': 'Проекты',
  'app.dialog.projectPicker.opening': 'Открытие проектов…',
  'app.dialog.projectPicker.failureTitle': 'Проекты не открылись',
  'app.dialog.projectPicker.failureMessage': 'Не удалось загрузить библиотеку проектов. Проекты не изменились.',
  'app.dialog.setupModal.name': 'Настройка разделения',
  'app.dialog.setupModal.opening': 'Открытие настройки…',
  'app.dialog.setupModal.failureTitle': 'Не открылась',
  'app.dialog.setupModal.failureMessage': 'Не удалось загрузить настройку разделения. Плеер всё ещё доступен.',

  // ── titlebar / section nav ──
  'app.titlebar.sections': 'Разделы SingZ',
  'app.titlebar.songs': 'Песни',
  'app.titlebar.training': 'Тренировка',
  'app.titlebar.catalogBack': 'Назад к песне (Esc)',
  'app.titlebar.catalogBrowse': 'Библиотека проектов — песня останется открытой',
  'app.titlebar.catalog': 'Каталог',
  'app.titlebar.renameProject': 'Переименовать песню и папку',
  'app.titlebar.renameSong': 'Сменить имя',
  'app.titlebar.logTooltip': 'Что приложение делает под капотом — скопируйте журнал, сообщая о проблеме',
  'app.titlebar.log': 'Журнал',
  // the desktop Settings gear button — title AND aria-label both use this
  'app.titlebar.settings': 'Настройки',

  // ── update chip ──
  'app.update.restartTitle': 'Обновление загружено — перезапуск установит его',
  'app.update.restart': 'Перезапустить',
  'app.update.availableTitle': 'Вышла новая версия — откроет страницу загрузки',
  // {version} is the app version number, e.g. "0.23.3"
  'app.update.get': '→ v{version}',
  'app.update.downloadingTitle': 'Загрузка обновления в фоне',
  // {percent} is a 0-100 whole number
  'app.update.downloading': 'грузим {percent}%',

  // ── save / library ──
  'app.save.tooltipProject': 'Сохранить дорожки, текст и настройки в папку проекта',
  'app.save.tooltipLibrary': 'Сохранить песню, дорожки, текст и настройки в библиотеку',
  'app.save.saved': 'Готово ✓',
  'app.save.saving': 'Сохраняю…',
  'app.save.save': 'Сохранить',
  'app.save.unsavedTitle': 'Не сохранено',
  'app.library.addTooltip': 'Проект вне библиотеки — скопируйте или перенесите его',
  'app.library.add': 'В библиотеку…',
  'app.library.open': 'Открыть…',

  // ── engine/splitter status chip ──
  'app.engine.checking': 'проверяем ИИ…',
  // {command} is the splitter binary's own name/version string
  'app.engine.manageTitle': '{command} — управление моделями ИИ',
  'app.engine.ready': 'ИИ готов',
  'app.engine.setup': 'настроить ИИ',

  // ── vocal training empty states ──
  'app.training.loading': 'Загрузка профиля тренировок…',
  'app.training.unavailable': 'Профиль занятий недоступен',
  'app.training.unavailableBody': 'Данные занятий не изменились. Повторите, когда хранилище будет доступно.',
  'app.retry': 'Повторить',
  // {error} is the raw error text from the failed save
  'app.training.saveError': 'Профиль или история занятий не сохранены: {error}',

  // ── drag & drop ──
  'app.drop.release': 'Бросьте сюда',

  // ── analysis progress labels (HUD) ──
  'app.analysis.readingMelody': 'Распознаём мелодию',
  'app.analysis.findingBeat': 'Определяем ритм',

  // ── playback output/route toasts ──
  'app.output.confirmDenied': 'SingZ не разрешили подтвердить маршрут — выберите устройство или повторите',
  'app.output.missingDefault': 'Устройство не подключено — используется системное по умолчанию',
  'app.output.switchDenied': 'SingZ не разрешили переключить устройство — используется прежнее',
  'app.output.switchFailed': 'Не удалось переключить устройство — используется прежнее',

  // {message} is the monitor's own status text
  'app.monitor.stopped': 'Монитор наушников остановлен: {message}',

  // native engine rejected a live control change and the UI rolled back — {error} is the raw error text
  'app.native.beatNotApplied': 'Сетка долей нативного движка отклонена: {error}',
  'app.native.metronomeNotApplied': 'Метроном нативного движка отклонён: {error}',
  'app.native.transposeNotApplied': 'Транспонирование нативного движка отклонено: {error}',
  'app.native.loopNotApplied': 'Петля нативного движка отклонена: {error}',
  'app.native.tempoNotApplied': 'Темп нативного движка отклонён: {error}',
  'app.native.trainingNotApplied': 'Тренировка нативного движка отклонена: {error}',

  // ── first-run / model wizard ──
  'app.wizard.qwenNotice':
    'Распознавание и «Сверить и выровнять» теперь на Qwen3-ASR — модели, обученной на пении: она заметно лучше слышит слова песни. Загрузите её ниже, когда удобно; старая модель удалится, когда новая установится.',

  // ── song open progress ──
  'app.load.opening': 'Грузим…',
  // {label} is the singer's own name for the added track
  'app.load.laneMissing': '«{label}» не удалось прочитать — этой дорожки нет в миксе.',
  'app.load.readingStems': 'Чтение дорожек…',
  'app.load.drawingWaveforms': 'Построение волн…',
  // {list} is the silent stem names joined with "and", e.g. "guitar and piano"
  'app.load.silentStems_one': 'Шесть дорожек — {list} не звучит в песне, дорожка скрыта.',
  'app.load.silentStems_few': 'Шесть дорожек — {list} не звучат в песне, дорожки скрыты.',
  'app.load.silentStems_many': 'Шесть дорожек — {list} не звучат в песне, дорожки скрыты.',
  'app.load.silentStems_other': 'Шесть дорожек — {list} не звучат в песне, дорожки скрыты.',
  'app.load.startingPlayback': 'Запуск плеера…',
  // {message} is the graph loader's own error text
  'app.load.graphError': 'Не удалось загрузить DSP-граф проекта. {message}',
  'app.load.decodeFailed': 'Не удалось декодировать файл.',

  // ── file/track errors ──
  'app.file.resolveFailed': 'Не удалось найти этот файл на диске.',
  // {name} is the file's own name
  'app.tracks.decodeFailed': 'Не удалось прочитать {name} — нужен MP3, WAV, FLAC/M4A.',
  // {names} is the added tracks' labels joined with ", "; {end} is a formatted time like "3:42"
  'app.tracks.addedExtends':
    'Добавлено {names} — начало 0:00, длиннее песни: таймлайн теперь до {end}. Сохраните проект, чтобы сохранить её.',
  'app.tracks.addedAligned': 'Добавлено {names} — начало 0:00, с дорожками. Сохраните проект, чтобы сохранить её.',

  // ── splitting ──
  'app.split.rereadFailed': 'Не удалось прочитать песню для разделения. Откройте её снова.',
  'app.split.loadStemsFailed': 'Разделение завершено, но файлы дорожек не загрузились.',
  // the auto-created lane name for a separated backing-vocal harmony
  'app.split.backingVocalsLabel': 'Бэк-вокал',
  'app.split.backingReady':
    'Ведущий и бэк-вокал готовы, мелодия следует за ведущим. Сохраните проект, чтобы сохранить обе дорожки — гармонии могут остаться.',
  'app.beat.notFound': 'Ритм не найден — задайте темп постукиванием.',

  // ── project save/import/rename ──
  // {dir} is the project's folder path
  'app.project.saved': 'Готово: {dir}',
  // {names} is the lost custom-track labels joined with ", "
  'app.project.savedMissingFile': 'Сохранено в {dir} — но не скопировано: {names}. Файла больше нет там, откуда вы его добавили.',
  'app.project.savedDriveSignedOut':
    'Сохранено в {dir} — вы не вошли в Google Drive на этом компьютере, так телефоны не увидят это до входа (экран «Открыть…»).',
  'app.project.saveFailed': 'Не удалось сохранить: {error}',
  'app.project.moved': 'Перенесено в библиотеку — проект теперь в {dir}',
  'app.project.copied': 'Скопировано в вашу библиотеку — {dir}. Исходная папка не изменена.',
  'app.project.renamed': 'Переименовано — папка теперь {dir}'
}
