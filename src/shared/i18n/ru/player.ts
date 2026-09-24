/* Русский — the `player` strings, typed against English. */
import type { player as en } from '../en/player'
import type { Translation } from '../types'

export const player: Translation<typeof en> = {
  // ── transport ──
  'player.transport.backToStart': 'В начало',
  'player.transport.pause': 'Пауза (пробел)',
  'player.transport.play': 'Воспроизвести (пробел)',
  'player.transport.loopSelection': 'Повторять выделенное',
  'player.transport.loopSong': 'Повторять всю песню (потяните по волнам, чтобы повторять участок)',
  'player.transport.karaoke': 'Караоке',
  'player.transport.karaokeTitle': 'Вид караоке: текст, линия мелодии и совпадение с микрофоном (Esc — закрыть)',
  'player.transport.stemFiles': 'Файлы',
  'player.transport.stemFilesTitle': 'Показать файлы дорожек в файловом менеджере',
  'player.transport.cancel': 'Отмена',
  'player.transport.cancelSplit': 'Отменить разделение',
  'player.transport.transposeTitle': 'Транспонировать всю песню (только высота, темп не меняется)',
  'player.transport.resetTranspose': 'Сбросить транспонирование',
  'player.transport.speedTitle': 'Скорость воспроизведения (высота тона не меняется)',
  'player.transport.resetSpeed': 'Сбросить скорость',
  'player.transport.muted': 'Звук выключен — нажмите для регулятора громкости',
  // {percent} is a number already rounded, e.g. "Volume 80% — click for the slider"
  'player.transport.volumeAt': 'Громкость {percent}% — нажмите для регулятора',
  'player.transport.metronomeTitle': 'Метроном — щелчок по доле, сетка для наблюдения, отсчёт перед игрой',
  'player.transport.carryLine': 'Веди строку',
  'player.transport.carryLineTitle': 'Веди строку — опорные дорожки отключаются по расписанию, пока песню ведёте вы',

  // ── shared toggle labels (metronome, training, count-in, grid view, accent) ──
  'player.toggle.off': 'Выкл',
  'player.toggle.on': 'Вкл',

  // ── bpm entry (the tempo readout in the transport) ──
  'player.bpm.detectHint': 'Ударов в минуту — определяется после разделения и анализа песни',
  'player.bpm.setTitle': 'Задать темп воспроизведения в ударах в минуту',

  // ── volume popover ──
  'player.volume.title': 'Громкость',
  'player.volume.muteAll': 'Заглушить всё',
  'player.volume.unmute': 'Вернуть прежний уровень',
  'player.volume.sliderTitle': 'Насколько громко играет весь микс — метроном следует за ним',
  'player.volume.caption':
    'Задаёт собственный вывод приложения — фейдеры дорожек и системная громкость остаются как есть.',

  // ── metronome popover ──
  'player.metronome.title': 'Метроном',
  'player.metronome.clickTitle': 'Щелчок на каждую долю во время воспроизведения',
  'player.metronome.needsTempo': 'Сначала нужен темп',
  'player.metronome.loudness': 'Громкость',
  'player.metronome.loudnessTitle': 'Насколько громкий щелчок — отпустите, чтобы услышать',
  'player.metronome.accent': 'Акцент',
  'player.metronome.accentOnTitle': 'Первая доля каждого такта звучит ярче',
  'player.metronome.accentOn': 'На «раз»',
  'player.metronome.accentOffTitle': 'Каждый щелчок одинаковый — такт ничем не отмечен',
  'player.metronome.gridView': 'Сетка',
  'player.metronome.gridViewOnTitle':
    'Разметить волны по доле: линия на каждую долю, такты оранжевым — чтобы видеть, попадают ли доли в песню',
  'player.metronome.gridViewShow': 'Показать',
  'player.metronome.tapHint': 'Продолжайте постукивать — три ровных удара задают темп.',
  'player.metronome.noBeatCanDetect': 'В барабанах не найдено устойчивого ритма — отсчёт идёт раз в секунду. Задайте темп постукиванием или нажмите «Определить снова».',
  'player.metronome.noBeatCannotDetect': 'Темпа пока нет — отсчёт идёт раз в секунду. Задайте его постукиванием или разделите песню — темп будет считан с барабанов.',
  // e.g. "120.5 bpm · following the drums, drift and all — tap along during playback to re-anchor."
  'player.metronome.gridCaption': '{bpm} bpm · {source} — постукивайте в такт во время игры, чтобы привязать заново.',
  'player.metronome.sourceAuto': 'следует за барабанами, со всем их дрейфом',
  'player.metronome.sourceManual': 'задано вручную',
  'player.metronome.gridData': 'Данные сетки',
  'player.metronome.handTunedTitle':
    'Эта сетка размещена или исправлена вручную — повторное определение её не тронет',
  // {saved}/{current} are detector version numbers, e.g. "Saved with detector v17; this build has v19 and will re-derive on next open"
  'player.metronome.staleTitle':
    'Сохранено детектором v{saved}; в этой сборке v{current}, будет пересчитано при следующем открытии',
  'player.metronome.currentTitle': 'Сохранённая сетка соответствует детектору этой сборки',
  'player.metronome.newerTitle':
    'Сохранено более новым детектором (v{saved}); в этой сборке v{current}, и сетка остаётся без изменений. «Определить снова» заменит её более старой сеткой этой сборки.',
  // the grid-version badge text, e.g. "hand-tuned (v17)"
  'player.metronome.handTuned': 'вручную (v{ver})',
  'player.metronome.staleLabel': 'v{saved} → доступна v{current}',
  'player.metronome.currentLabel': 'v{ver} — актуальная',
  'player.metronome.newerLabel': 'v{ver} — новее этой сборки',
  'player.metronome.userBarsTitle':
    'Линии тактов, перемещённые вручную. Повторное определение подгонит их под новую сетку — они не потеряются.',
  // "· 1 hand-set bar" / "· 3 hand-set bars", next to the grid-version badge
  'player.metronome.userBars_one': '· {n} такт вручную',
  'player.metronome.userBars_few': '· {n} такта вручную',
  'player.metronome.userBars_many': '· {n} тактов вручную',
  'player.metronome.userBars_other': '· {n} такта вручную',
  'player.metronome.countIn': 'Отсчёт',
  'player.metronome.countInBarTitle': 'Один такт щелчков перед началом воспроизведения',
  'player.metronome.countInSecTitle': 'Три щелчка, раз в секунду, перед началом воспроизведения',
  'player.metronome.oneBar': '1 такт',
  'player.metronome.threeSec': '3 с',
  'player.metronome.countIn2BarTitle': 'Два такта щелчков перед началом воспроизведения',
  'player.metronome.countIn2SecTitle': 'Шесть щелчков, раз в секунду, перед началом воспроизведения',
  'player.metronome.twoBars': '2 такта',
  'player.metronome.sixSec': '6 с',
  'player.metronome.tempo': 'Темп',
  'player.metronome.tempoTitle': 'Собственный темп песни (скорость воспроизведения не меняется)',
  'player.metronome.tap': 'Тап',
  'player.metronome.tapTitle': 'Постучите долю, чтобы задать темп (и зафиксировать фазу во время игры)',
  'player.metronome.halfTime': 'Половинный темп',
  'player.metronome.doubleTime': 'Двойной темп',
  'player.metronome.beatsPerBar': 'Долей в такте',
  'player.metronome.align': 'Выровнять',
  'player.metronome.nudgeEarlierTitle': 'Щелчки на 10 мс раньше',
  'player.metronome.nudgeLaterTitle': 'Щелчки на 10 мс позже',
  // “1” refers to the first beat of the bar, kept as a literal digit in quotes
  'player.metronome.rotateAccentTitle': 'Перенести акцент на следующую долю (если «1» не туда попадает)',
  'player.metronome.redetect': 'Определить снова',
  'player.metronome.redetectKeepBarsTitle':
    'Снова считать темп и долю с барабанов — линии тактов, расставленные вручную, сохраняются',
  'player.metronome.redetectTitle': 'Снова считать темп и долю с барабанов',

  // ── training / carry the line popover ──
  'player.training.title': 'Веди строку',
  'player.training.byTime': 'По времени',
  'player.training.byLines': 'По строкам текста',
  'player.training.byLinesTitle': 'Чередовать по строкам текста караоке',
  'player.training.switchEvery': 'Меняться каждые',
  'player.training.hear': 'Слушать',
  'player.training.sing': 'петь',
  // e.g. "Guide plays 10 s, then you take the next 10 s."
  'player.training.captionTime': 'Опорные дорожки звучат {sec} с, затем следующие {sec} с ведёте вы.',
  'player.training.captionLines_one': 'Слушайте {n} строку, затем спойте {sing} сами.',
  'player.training.captionLines_few': 'Слушайте {n} строки, затем спойте {sing} сами.',
  'player.training.captionLines_many': 'Слушайте {n} строк, затем спойте {sing} сами.',
  'player.training.captionLines_other': 'Слушайте {n} строки, затем спойте {sing} сами.',
  'player.training.captionNoLyrics': 'Синхронного текста пока нет — чередование по времени, пока он не загрузится.',
  'player.training.mutedWhileSinging': 'Заглушено во время вашего пения:',
  'player.training.mutedWhileSingingTitle':
    'Эти дорожки замолкают в ваш ход — их исполняете вы',

  // ── split menu (the Split/Re-split control in the transport) ──
  'player.split.title': 'Разделить песню',
  'player.split.optionsTitle': 'Параметры разделения',
  'player.split.button': 'Разделить',
  'player.split.backingHint': 'Нажмите, чтобы разделить на бэк-вокал',
  'player.split.separateBacking': 'Отделить бэк-вокал',
  'player.split.resplitStems': 'Разделить инструментальные дорожки снова',
  'player.split.alreadySeparated': 'Этот вокал уже разделён.',
  'player.split.explain': 'Создать вокал, барабаны, бас, гитару, клавишные и инструменты, затем разделить вокал на ведущий и бэк-вокал.',
  'player.split.hint':
    'Два шага, по несколько минут каждый. Модели загружаются один раз. Дорожки ведущего и бэк-вокала сохраняются без сжатия — около 40 МБ на минуту песни, чтобы оставаться точными.',

  // ── track stack (ruler, zoom controls, add-track) ──
  'player.stack.addTrack': '+ Добавить дорожку…',
  'player.stack.addTrackTitle':
    'Добавить аудиофайл как отдельную дорожку — бэк-трек, записанную вами партию, клик. Она играет с 0:00 и копируется в проект при сохранении.',
  'player.stack.zoomOutTitle': 'Уменьшить масштаб (колесо мыши тоже работает)',
  'player.stack.zoomInTitle': 'Увеличить масштаб вокруг курсора воспроизведения',
  'player.stack.showWholeSongTitle': 'Показать всю песню',
  'player.stack.full': 'Целиком',

  // ── track lane (the per-stem controls beside each waveform) ──
  // "Name of the Vocals track" — {track} is the stem/lane's display label
  'player.lane.nameOf': 'Название дорожки «{track}»',
  'player.lane.renameTitle': 'Дважды нажмите, чтобы переименовать дорожку',
  'player.lane.rename': 'Переименовать {track}',
  'player.lane.remove': 'Убрать {track} из этого проекта (файл, из которого она добавлена, останется на месте)',
  'player.lane.unmute': 'Включить звук',
  'player.lane.mute': 'Заглушить',
  'player.lane.unsolo': 'Убрать соло',
  'player.lane.solo': 'Соло',
  'player.lane.volume': 'Громкость',
  'player.lane.yourTurn': 'ваш ход',

  // ── beat grid (the draggable bar-line handles over the waveforms) ──
  'player.beatGrid.dragTitle':
    'Перетащите линию такта на долю, где такт действительно начинается. Alt-клик по перемещённой линии вернёт её детектору.',

  // ── pitch strip (melody line + mic pitch matching) ──
  'player.pitch.micUnavailableSettings': 'Микрофон недоступен, пока открыты настройки',
  'player.pitch.sing': 'пойте!',
  // e.g. "72% match"
  'player.pitch.matchPercent': 'совпадение {percent}%',
  'player.pitch.resizeTitle': 'Потяните, чтобы изменить размер панели высоты тона',
  // one-word row labels in the info panel: key, tempo, range, length
  'player.pitch.keyLabel': 'тональность',
  'player.pitch.tempoLabel': 'темп',
  'player.pitch.rangeLabel': 'диапазон',
  'player.pitch.lengthLabel': 'длина',
  // e.g. "from C major" — the key name before a transpose was applied
  'player.pitch.fromKey': 'из {key}',
  // e.g. "reading melody… 42%"
  'player.pitch.readingMelody': 'распознаём мелодию… {percent}%',
  'player.pitch.findingBeat': 'определяем ритм… {percent}%',
  'player.pitch.noteBars': 'Полоски нот',
  'player.pitch.noteBarsTitle':
    'Одна ровная полоска на каждую спетую ноту — тонкая линия под ней сохраняет реальную высоту',
  'player.pitch.fit': 'Подогнать',
  'player.pitch.fitTitle': 'Подогнать диапазон высоты тона под мелодию этой песни',
  'player.pitch.micHint': 'Слушайте и оценивайте свою высоту тона относительно мелодии песни',
  'player.pitch.micAriaLabel': 'Сравнить моё пение с мелодией песни',
  'player.pitch.micOn': 'Микрофон включён',
  'player.pitch.micStarting': 'Запуск…',
  'player.pitch.micBlocked': 'Микрофон заблокирован — проверьте настройки системы',
  'player.pitch.micMatch': 'Сравнить моё пение',

  // ── DSP graph visualization (native playback diagnostics panel) ──
  'player.dspGraph.runtimeGraph': 'Граф выполнения',
  'player.dspGraph.songAndReference': 'Нативный граф песни и эталона',
  'player.dspGraph.monitorChain': 'Нативная цепь мониторинга',
  'player.dspGraph.structuredUnavailable': 'Структурированный граф недоступен',
  'player.dspGraph.bufferPending': 'Буфер ожидается',
  'player.dspGraph.chooseInput': 'Выберите вход',
  'player.dspGraph.chooseOutput': 'Выберите выход',
  'player.dspGraph.deviceKind': 'Устройство',
  'player.dspGraph.analyzerKind': 'Анализатор',
  'player.dspGraph.processorKind': 'Процессор',
  'player.dspGraph.routerKind': 'Маршрутизатор',
  'player.dspGraph.input': 'Вход',
  'player.dspGraph.output': 'Выход',
  'player.dspGraph.preMeter': 'Измеритель до',
  'player.dspGraph.preFace': 'До',
  'player.dspGraph.postMeter': 'Измеритель после',
  'player.dspGraph.postFace': 'После',
  'player.dspGraph.gain': 'Усиление',
  'player.dspGraph.channelMap': 'Карта каналов',
  'player.dspGraph.mapFace': 'Карта',
  'player.dspGraph.limiter': 'Лимитер',
  'player.dspGraph.limitFace': 'Лимит',
  'player.dspGraph.beforeProcessing': 'До обработки',
  'player.dspGraph.afterLimiter': 'После лимитера',
  'player.dspGraph.preLevelLabel': 'Уровень DSP-графа до обработки',
  'player.dspGraph.postLevelLabel': 'Уровень DSP-графа после лимитера',
  'player.dspGraph.modulesAriaLabel': 'Модули DSP-графа',
  'player.dspGraph.activeModulesAriaLabel': 'Активные модули и связи DSP-графа песни',
  'player.dspGraph.activeConnectionsAriaLabel': 'Активные связи DSP-графа песни',
  'player.dspGraph.unavailableExplain':
    'Детали графа недоступны, потому что нативное воспроизведение не предоставило корректный ограниченный снимок композиции.',
  'player.dspGraph.floatNativePath': 'Нативный путь Float32',
  'player.dspGraph.stateRunning': 'Работает',
  'player.dspGraph.stateChangingRoute': 'Смена маршрута',
  'player.dspGraph.stateFault': 'Остановлен из-за ошибки',
  'player.dspGraph.stateReady': 'Готов',
  'player.dspGraph.stateBlocked': 'Маршрут заблокирован',

  // ── model.ts: fallback label for an added track with no name left after cleanup ──
  'player.track.untitled': 'Дорожка'
}
