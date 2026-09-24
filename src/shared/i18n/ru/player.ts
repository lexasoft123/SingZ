/* Русский — the `player` strings, typed against English. */
import type { player as en } from '../en/player'
import type { Translation } from '../types'

export const player: Translation<typeof en> = {
  // ── transport ──
  'player.transport.backToStart': 'В начало',
  'player.transport.pause': 'Пауза (пробел)',
  'player.transport.play': 'Пуск (пробел)',
  'player.transport.loopSelection': 'Повтор выделения',
  'player.transport.loopSong': 'Повторять всю песню (потяните волны — цикл участка)',
  'player.transport.karaoke': 'Караоке',
  'player.transport.karaokeTitle': 'Караоке: текст, мелодия и совпадение с микрофоном (Esc — закрыть)',
  'player.transport.stemFiles': 'Файлы',
  'player.transport.stemFilesTitle': 'Показать дорожки в файловом менеджере',
  'player.transport.cancel': 'Отмена',
  'player.transport.cancelSplit': 'Отменить разделение',
  'player.transport.transposeTitle': 'Транспонировать песню (высота меняется, темп — нет)',
  'player.transport.resetTranspose': 'Сбросить высоту',
  'player.transport.speedTitle': 'Скорость (высота не меняется)',
  'player.transport.resetSpeed': 'Сброс скорости',
  'player.transport.muted': 'Звук выключен — нажмите для громкости',
  // {percent} is a number already rounded, e.g. "Volume 80% — click for the slider"
  'player.transport.volumeAt': 'Звук {percent}% — нажмите для регулятора',
  'player.transport.metronomeTitle': 'Метроном — щелчок по доле, сетка для наблюдения, отсчёт перед игрой',
  'player.transport.carryLine': 'Веди строку',
  'player.transport.carryLineTitle': 'Веди строку — опорные дорожки отключаются по расписанию, пока песню ведёте',

  // ── shared toggle labels (metronome, training, count-in, grid view, accent) ──
  'player.toggle.off': 'Выкл',
  'player.toggle.on': 'Вкл',

  // ── bpm entry (the tempo readout in the transport) ──
  'player.bpm.detectHint': 'Ударов в минуту — определяется после разделения и анализа песни',
  'player.bpm.setTitle': 'Задать темп в ударах в минуту',

  // ── volume popover ──
  'player.volume.title': 'Звук',
  'player.volume.muteAll': 'Заглушить всё',
  'player.volume.unmute': 'К прежнему уровню',
  'player.volume.sliderTitle': 'Насколько громко играет весь микс — метроном следует за ним',
  'player.volume.caption':
    'Меняет только вывод приложения — фейдеры дорожек и системная громкость не трогаются.',

  // ── metronome popover ──
  'player.metronome.title': 'Метроном',
  'player.metronome.clickTitle': 'Щелчок на каждую долю при игре',
  'player.metronome.needsTempo': 'Сначала нужен темп',
  'player.metronome.loudness': 'Сила',
  'player.metronome.loudnessTitle': 'Громкость щелчка — отпустите и услышите',
  'player.metronome.accent': 'Акцент',
  'player.metronome.accentOnTitle': 'Первая доля каждого такта звучит ярче',
  'player.metronome.accentOn': 'На «раз»',
  'player.metronome.accentOffTitle': 'Все щелчки одинаковы — такт не отмечен',
  'player.metronome.gridView': 'Сетка',
  'player.metronome.gridViewOnTitle':
    'Разметить волны по доле: линия на каждую долю, такты оранжевым — чтобы видеть, попадают ли доли в песню',
  'player.metronome.gridViewShow': 'Показ',
  'player.metronome.tapHint': 'Постукивайте — три ровных удара задают темп.',
  'player.metronome.noBeatCanDetect': 'В барабанах нет устойчивого ритма — отсчёт идёт раз в секунду. Задайте темп сами или нажмите «Пересчёт».',
  'player.metronome.noBeatCannotDetect': 'Темпа пока нет — отсчёт идёт раз в секунду. Задайте его сами или разделите песню — темп считают барабаны.',
  // e.g. "120.5 bpm · following the drums, drift and all — tap along during playback to re-anchor."
  'player.metronome.gridCaption': '{bpm} bpm · {source} — постукивайте, чтобы привязать заново.',
  'player.metronome.sourceAuto': 'следует барабанам, включая дрейф',
  'player.metronome.sourceManual': 'вручную',
  'player.metronome.gridData': 'Данные',
  'player.metronome.handTunedTitle': 'Сетка размещена или исправлена вручную — «Пересчёт» её не тронет',
  // {saved}/{current} are detector version numbers, e.g. "Saved with detector v17; this build has v19 and will re-derive on next open"
  'player.metronome.staleTitle':
    'Сохранено детектором v{saved}; сборка v{current} пересчитает при следующем открытии',
  'player.metronome.currentTitle': 'Сетка совпадает с детектором этой сборки',
  'player.metronome.newerTitle':
    'Сохранено более новым детектором (v{saved}); в сборке v{current} сетка не меняется. «Пересчёт» заменит её более старой.',
  // the grid-version badge text, e.g. "hand-tuned (v17)"
  'player.metronome.handTuned': 'вручную (v{ver})',
  'player.metronome.staleLabel': 'v{saved} → доступна v{current}',
  'player.metronome.currentLabel': 'v{ver}: текущая',
  'player.metronome.newerLabel': 'v{ver} — новее этой сборки',
  'player.metronome.userBarsTitle': 'Линии тактов, перемещённые вручную. «Пересчёт» подгонит их под новую сетку — они не потеряются.',
  // "· 1 hand-set bar" / "· 3 hand-set bars", next to the grid-version badge
  'player.metronome.userBars_one': '· {n} такт рукой',
  'player.metronome.userBars_few': '· {n} такта рукой',
  'player.metronome.userBars_many': '· {n} тактов рукой',
  'player.metronome.userBars_other': '· {n} такта рукой',
  'player.metronome.countIn': 'Отсчёт',
  'player.metronome.countInBarTitle': 'Один такт щелчков перед началом игры',
  'player.metronome.countInSecTitle': 'Три щелчка раз в секунду, перед началом игры',
  'player.metronome.oneBar': '1 такт',
  'player.metronome.threeSec': '3 с',
  'player.metronome.countIn2BarTitle': 'Два такта щелчков перед началом игры',
  'player.metronome.countIn2SecTitle': 'Шесть щелчков раз в секунду, перед началом игры',
  'player.metronome.twoBars': '2 такта',
  'player.metronome.sixSec': '6 с',
  'player.metronome.tempo': 'Темп',
  'player.metronome.tempoTitle': 'Темп самой песни (скорость не меняется)',
  'player.metronome.tap': 'Тап',
  'player.metronome.tapTitle': 'Постучите долю, чтобы задать темп (и зафиксировать фазу игры)',
  'player.metronome.halfTime': 'Пол-темпа',
  'player.metronome.doubleTime': 'Темп ×2',
  'player.metronome.beatsPerBar': 'Долей в такте',
  'player.metronome.align': 'Выровнять',
  'player.metronome.nudgeEarlierTitle': 'Щелчки 10 мс раньше',
  'player.metronome.nudgeLaterTitle': 'Щелчки 10 мс позже',
  // “1” refers to the first beat of the bar, kept as a literal digit in quotes
  'player.metronome.rotateAccentTitle': 'Перенести акцент на следующую долю (если «1» не туда)',
  'player.metronome.redetect': 'Пересчёт',
  'player.metronome.redetectKeepBarsTitle':
    'Снова считать темп и долю с барабанов — ручные линии тактов сохраняются',
  'player.metronome.redetectTitle': 'Снова считать темп и долю с барабанов',

  // ── training / carry the line popover ──
  'player.training.title': 'Веди строку',
  'player.training.byTime': 'Время',
  'player.training.byLines': 'Строки',
  'player.training.byLinesTitle': 'Чередовать строки караоке',
  'player.training.switchEvery': 'Каждые',
  'player.training.hear': 'Слушать',
  'player.training.sing': 'петь',
  // e.g. "Guide plays 10 s, then you take the next 10 s."
  'player.training.captionTime': 'Опора играет {sec} с, потом {sec} с ведёте вы.',
  'player.training.captionLines_one': 'Слушайте {n} строку, потом спойте {sing}.',
  'player.training.captionLines_few': 'Слушайте {n} строки, потом спойте {sing}.',
  'player.training.captionLines_many': 'Слушайте {n} строк, потом спойте {sing}.',
  'player.training.captionLines_other': 'Слушайте {n} строки, потом спойте {sing}.',
  'player.training.captionNoLyrics': 'Текста пока нет — чередуем по времени до загрузки.',
  'player.training.mutedWhileSinging': 'Заглушено при пении:',
  'player.training.mutedWhileSingingTitle':
    'Эти дорожки замолкают в ваш ход — их исполняете вы',

  // ── split menu (the Split/Re-split control in the transport) ──
  'player.split.title': 'Разделить',
  'player.split.optionsTitle': 'Параметры',
  'player.split.button': 'Разделить',
  'player.split.backingHint': 'Нажмите — разделить бэк-вокал',
  'player.split.separateBacking': 'Отделить бэк-вокал',
  'player.split.resplitStems': 'Переразделить инструменты',
  'player.split.alreadySeparated': 'Этот вокал уже разделён.',
  'player.split.explain': 'Создать вокал, барабаны, бас, гитару, клавиши и инструменты, затем разделить вокал на лид- и бэк-вокал.',
  'player.split.hint':
    'Два шага, по несколько минут. Модели загружаются один раз. Лид- и бэк-вокал сохраняются без сжатия — 40 МБ на минуту песни, для точности.',

  // ── track stack (ruler, zoom controls, add-track) ──
  'player.stack.addTrack': '+ Дорожка…',
  'player.stack.addTrackTitle':
    'Добавить аудиофайл как отдельную дорожку — бэк-трек, записанную вами партию, клик. Она играет с 0:00 и копируется в проект при сохранении.',
  'player.stack.zoomOutTitle': 'Уменьшить (колесо мыши тоже)',
  'player.stack.zoomInTitle': 'Увеличить у курсора',
  'player.stack.showWholeSongTitle': 'Показать всю песню',
  'player.stack.full': 'Всё',

  // ── track lane (the per-stem controls beside each waveform) ──
  // "Name of the Vocals track" — {track} is the stem/lane's display label
  'player.lane.nameOf': 'Название «{track}»',
  'player.lane.renameTitle': 'Дважды нажмите для переименования',
  'player.lane.rename': 'Назвать {track}',
  'player.lane.remove': 'Убрать {track} из проекта (исходный файл останется на месте)',
  'player.lane.unmute': 'Вернуть звук',
  'player.lane.mute': 'Заглушить',
  'player.lane.unsolo': 'Снять соло',
  'player.lane.solo': 'Соло',
  'player.lane.volume': 'Громкость',
  'player.lane.yourTurn': 'ваш ход',

  // ── beat grid (the draggable bar-line handles over the waveforms) ──
  'player.beatGrid.dragTitle':
    'Перетащите линию такта на долю, где такт начинается. Alt-клик по перемещённой линии вернёт её детектору.',

  // ── pitch strip (melody line + mic pitch matching) ──
  'player.pitch.micUnavailableSettings': 'Микрофон недоступен, пока открыты настройки',
  'player.pitch.sing': 'пойте!',
  // e.g. "72% match"
  'player.pitch.matchPercent': 'точно {percent}%',
  'player.pitch.resizeTitle': 'Потяните — изменить размер',
  // one-word row labels in the info panel: key, tempo, range, length
  'player.pitch.keyLabel': 'тон',
  'player.pitch.tempoLabel': 'темп',
  'player.pitch.rangeLabel': 'охват',
  'player.pitch.lengthLabel': 'длина',
  // e.g. "from C major" — the key name before a transpose was applied
  'player.pitch.fromKey': 'из {key}',
  // e.g. "reading melody… 42%"
  'player.pitch.readingMelody': 'мелодия… {percent}%',
  'player.pitch.findingBeat': 'определяем ритм… {percent}%',
  'player.pitch.noteBars': 'Ноты',
  'player.pitch.noteBarsTitle':
    'Полоска на каждую спетую ноту — линия под ней хранит высоту',
  'player.pitch.fit': 'Подогнать',
  'player.pitch.fitTitle': 'Подогнать диапазон под мелодию песни',
  'player.pitch.micHint': 'Слушайте и сравнивайте высоту с мелодией песни',
  'player.pitch.micAriaLabel': 'Сравнить моё пение с мелодией песни',
  'player.pitch.micOn': 'Микрофон',
  'player.pitch.micStarting': 'Запуск…',
  'player.pitch.micBlocked': 'Микрофон блокирован — настройки',
  'player.pitch.micMatch': 'Сравнить пение',

  // ── DSP graph visualization (native playback diagnostics panel) ──
  'player.dspGraph.runtimeGraph': 'Граф работы',
  'player.dspGraph.songAndReference': 'Нативный граф песни и эталона',
  'player.dspGraph.monitorChain': 'Нативный монитор',
  'player.dspGraph.structuredUnavailable': 'Граф недоступен',
  'player.dspGraph.bufferPending': 'Буфер: ждём',
  'player.dspGraph.chooseInput': 'Выберите вход',
  'player.dspGraph.chooseOutput': 'Выберите выход',
  'player.dspGraph.deviceKind': 'Устройство',
  'player.dspGraph.analyzerKind': 'Анализ',
  'player.dspGraph.processorKind': 'Процессор',
  'player.dspGraph.routerKind': 'Роутер',
  'player.dspGraph.input': 'Вход',
  'player.dspGraph.output': 'Выход',
  'player.dspGraph.preMeter': 'Уровень до',
  'player.dspGraph.preFace': 'До',
  'player.dspGraph.postMeter': 'Метр после',
  'player.dspGraph.postFace': 'Пост',
  'player.dspGraph.gain': 'Гейн',
  'player.dspGraph.channelMap': 'Маппинг',
  'player.dspGraph.mapFace': 'Мап',
  'player.dspGraph.limiter': 'Лимитер',
  'player.dspGraph.limitFace': 'Лимит',
  'player.dspGraph.beforeProcessing': 'До обработки',
  'player.dspGraph.afterLimiter': 'Пост-лимитер',
  'player.dspGraph.preLevelLabel': 'Уровень DSP-графа до обработки',
  'player.dspGraph.postLevelLabel': 'Уровень DSP после лимитера',
  'player.dspGraph.modulesAriaLabel': 'Модули DSP-графа',
  'player.dspGraph.activeModulesAriaLabel': 'Активные модули и связи DSP-графа песни',
  'player.dspGraph.activeConnectionsAriaLabel': 'Активные связи DSP-графа песни',
  'player.dspGraph.unavailableExplain':
    'Детали недоступны — нативное воспроизведение не дало корректный снимок композиции.',
  'player.dspGraph.floatNativePath': 'Нативный Float32',
  'player.dspGraph.stateRunning': 'Активен',
  'player.dspGraph.stateChangingRoute': 'Смена маршрута',
  'player.dspGraph.stateFault': 'Остановлен: ошибка',
  'player.dspGraph.stateReady': 'Готов',
  'player.dspGraph.stateBlocked': 'Путь закрыт',

  // ── model.ts: fallback label for an added track with no name left after cleanup ──
  'player.track.untitled': 'Трек'
}
