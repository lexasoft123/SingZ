/* Русский — the `phone.player` strings, typed against English. */
import type { player as en } from '../en/player'
import type { Translation } from '../../../../src/shared/i18n/types'

export const player: Translation<typeof en> = {
  // ── "not available in native playback yet" alert ──
  'phone.player.unsupported.title': 'Пока нет в нативном режиме',
  'phone.player.unsupported.message': '«{operation}» недоступно, пока не подключено нативное DSP-управление.',
  'phone.player.playbackStopped.title': 'Плеер остановлен',
  'phone.player.metronomeSaveFailed.title': 'Метроном не сохранён',
  // names of a PlaybackOperation, for the message above
  'phone.player.operation.pause': 'пауза',
  'phone.player.operation.seek': 'перемотка',
  'phone.player.operation.loopRegion': 'повтор',
  'phone.player.operation.metronome': 'метроном',
  'phone.player.operation.mixer': 'микс',
  'phone.player.operation.pitchTempo': 'тон и темп',
  'phone.player.operation.training': 'занятие',
  'phone.player.operation.previewClick': 'проба щелчка',

  // ── stem lane names (STEM_META ids: original/vocals/drums/bass/guitar/piano/other) ──
  'phone.player.stem.original': 'Оригинал',
  'phone.player.stem.vocals': 'Вокал',
  'phone.player.stem.drums': 'Барабаны',
  'phone.player.stem.bass': 'Бас',
  'phone.player.stem.guitar': 'Гитара',
  'phone.player.stem.piano': 'Клавиши',
  'phone.player.stem.other': 'Инструменты',

  // ── count-in display (playback/count-in-display.ts) ──
  'phone.player.countIn.beatLabel': 'Отсчёт, доля {done} из {total}',
  'phone.player.countIn.secondsLabel': 'Отсчёт, осталось {seconds} с',
  // the compact on-screen readout, e.g. "3s"
  'phone.player.countIn.secondsText': '{seconds}с',

  // ── song format line (ui/song-sheet-copy.ts) ──
  'phone.player.songSheet.formatFlac': 'FLAC',
  'phone.player.songSheet.formatWav': 'WAV',
  'phone.player.songSheet.formatFlacWav': 'FLAC + WAV',
  'phone.player.songSheet.formatNone': 'нет',

  // ── shared UI kit accessibility strings (ui/bits.tsx) ──
  'phone.player.bits.decrease': 'Меньше {label}',
  'phone.player.bits.increase': 'Больше {label}',
  // e.g. "Hear, 3" — a stepper's screen-reader label followed by its value
  'phone.player.bits.labelValue': '{label}, {value}',
  // fallback screen-reader value for an adjustable bar with no custom formatter
  'phone.player.bits.percentValue': '{percent}%',
  // VoiceOver rotor action names for the adjustable Bar control
  'phone.player.bits.increaseAction': 'Больше',
  'phone.player.bits.decreaseAction': 'Меньше',

  // ── lyric column (ui/SkiaLyrics.tsx + the tap-target overlay in PlayerScreen) ──
  'phone.player.lyrics.waitSeconds': '{sec} с',
  'phone.player.lyrics.empty': 'В проекте нет текста песни.',
  // {text} is the lyric line itself; said for a line the singer performs solo
  'phone.player.lyrics.lineTurn': '{text}. Ваш ход.',

  // ── header (song title bar) ──
  'phone.player.header.back': 'В библиотеку',
  'phone.player.header.about': 'Об этой песне',
  'phone.player.header.notSplit': 'Не разделена',
  'phone.player.header.stemsCount': 'дорожек: {n}',
  'phone.player.header.added': '+{n}',
  'phone.player.header.bpm': '{bpm} bpm',
  // musical key quality, abbreviated (header subtitle and the transpose suffix)
  'phone.player.header.keyMinor': 'мин',
  'phone.player.header.keyMajor': 'маж',
  'phone.player.header.youSing': 'ВЫ ПОЁТЕ 🎤',

  // ── loop (A-B repeat) button ──
  'phone.player.loop.markStart': 'Повтор участка. Отметить начало тут.',
  // {time} e.g. "1:23"
  'phone.player.loop.startMarked': 'Начало повтора: {time}. Отметить конец тут.',
  'phone.player.loop.looping': 'Повтор {a}–{b}. Убрать повтор.',
  'phone.player.loop.buttonA': 'A',
  'phone.player.loop.buttonAB': 'A–B',

  // ── transport (footer controls) ──
  'phone.player.transport.position': 'Позиция',
  'phone.player.transport.mixer': 'Микс',
  'phone.player.transport.backToStart': 'В начало',
  'phone.player.transport.back5': 'Назад 5 с',
  'phone.player.transport.forward5': 'Вперёд 5 с',
  'phone.player.transport.practice': 'Занятие',
  'phone.player.transport.play': 'Воспроизвести',
  'phone.player.transport.pause': 'Пауза',

  // ── mixer sheet ──
  'phone.player.mixer.title': 'Микс',
  'phone.player.mixer.fullMix': 'Оригинал',
  'phone.player.mixer.noVocals': 'Без пения',
  'phone.player.mixer.vocalsOnly': 'Один вокал',
  // header over the singer's own added tracks, below the song's own stems
  'phone.player.mixer.added': 'Свои',
  'phone.player.mixer.yourTurn': 'ваш ход',
  'phone.player.mixer.mute': 'Заглушить {label}',
  'phone.player.mixer.solo': 'Соло {label}',
  'phone.player.mixer.volumeLabel': '{label}: звук',

  // ── song sheet: Beat row ──
  'phone.player.songSheet.beat': 'Ритм',
  // e.g. "120 bpm · 4/4 · 32 bars"
  'phone.player.songSheet.bpmMeterBars': '{bpm} bpm · {meter} · тактов: {bars}',
  'phone.player.songSheet.noBeatVerdict': 'В барабанах нет ритма',
  'phone.player.songSheet.readingSong': 'Читаем песню…',
  'phone.player.songSheet.notDetectedYet': 'Не определено',
  'phone.player.songSheet.handMade': 'вручную на компьютере',
  'phone.player.songSheet.detectorVersion': 'детектор v{ver}',
  'phone.player.songSheet.handSetBars_one': ' · {n} такт вручную',
  'phone.player.songSheet.handSetBars_few': ' · {n} такта вручную',
  'phone.player.songSheet.handSetBars_many': ' · {n} тактов вручную',
  'phone.player.songSheet.handSetBars_other': ' · {n} такта вручную',
  'phone.player.songSheet.beatHintProgress':
    'Слушаем прямо сейчас — щелчок и отсчёт подхватят ритм, как только он найден.',
  'phone.player.songSheet.beatHintHandTuned':
    'Настроено вручную на компьютере — новое определение не тронет. ',
  'phone.player.songSheet.beatHintUserBars':
    'Ваши линии тактов на этой сетке останутся. ',
  'phone.player.songSheet.beatHintFollow':
    'Щелчок, отсчёт и линии тактов следуют за этим.',
  'phone.player.songSheet.beatHintVerdict':
    'Детектор не нашёл устойчивого ритма для щелчка — свободный темп или песня без барабанов. Ответ запоминается, чтобы повторное открытие не читало дорожки впустую.',
  'phone.player.songSheet.beatHintDetectAgain': ' Нажмите «Найти снова».',
  'phone.player.songSheet.beatHintBusy':
    'Читается прямо сейчас — сетка записывается после тональности, поэтому эта строка заполнится чуть позже, чем найден сам ритм.',
  'phone.player.songSheet.beatHintNothingRead': 'Дорожки ещё никто не читал.',
  'phone.player.songSheet.beatHintNotSplit':
    'Ещё не разделена — ритм читается с барабанов, поэтому он ждёт разделения.',
  'phone.player.songSheet.beatHintFromComputer':
    'Песни с компьютера приходят уже с готовым ритмом.',
  'phone.player.songSheet.timeEstimateWithMl':
    'Ритм, тональность и мелодия вместе занимают около десяти секунд на каждую минуту песни',
  'phone.player.songSheet.timeEstimateMlSuffix':
    ' — около пятнадцати с более точной моделью ритма.',
  'phone.player.songSheet.timeEstimateNoMlSuffix': '.',
  'phone.player.songSheet.timeEstimateFlacJs':
    'Дорожки этой песни в FLAC, и эта сборка читает их на JavaScript — минуты, а не секунды.',
  'phone.player.songSheet.detecting': 'Ищем…',
  'phone.player.songSheet.detectAgain': 'Найти снова',

  // ── song sheet: Better beats row ──
  'phone.player.songSheet.betterBeats': 'Точный ритм',
  'phone.player.songSheet.downloading': 'Загрузка — {mb} из {total} МБ',
  'phone.player.songSheet.onThisPhone': 'На телефоне',
  'phone.player.songSheet.notDownloaded': 'Не загружено — {mb} МБ',
  'phone.player.songSheet.checking': 'Проверка…',
  'phone.player.songSheet.betterBeatsHint':
    'Нейросеть слышит ритм сквозь вступления без барабанов и свободный темп, которые обычный способ теряет. Загружается раз, работает для всех песен.',
  'phone.player.songSheet.betterBeatsHintDetectAgain': ' Примените к этой песне.',
  'phone.player.songSheet.cancel': 'Отмена',
  'phone.player.songSheet.downloadMb': 'Скачать {mb} МБ',

  // ── song sheet: Key row ──
  'phone.player.songSheet.key': 'Тональность',
  'phone.player.songSheet.noKeyVerdict': 'Тональности нет',
  'phone.player.songSheet.keyVerdictHint':
    'Гармония, по которой читается тональность, — гитара, клавишные и бас — здесь беззвучна, читать нечего. Этот ответ запоминается, а не читается заново при каждом открытии.',
  // full words, unlike the header's abbreviated min/maj
  'phone.player.songSheet.keyMinor': 'минор',
  'phone.player.songSheet.keyMajor': 'мажор',

  // ── song sheet: Melody row ──
  'phone.player.songSheet.melody': 'Мотив',
  'phone.player.songSheet.trackedFromVocals': 'Распознана по вокалу',
  'phone.player.songSheet.notTrackedYet': 'Не распознана',
  'phone.player.songSheet.melodyDetector': 'детектор v{ver} · кадр каждые {ms} мс',
  'phone.player.songSheet.melodyHint':
    'Спетая линия сохраняется с песней. Телефон её не рисует — это делает полоска тона на компьютере.',

  // ── song sheet: Lyrics row ──
  'phone.player.songSheet.lyrics': 'Текст',
  'phone.player.songSheet.linesCount': '{n} строк',
  'phone.player.songSheet.wordTimings': ' · тайминг слов',
  'phone.player.songSheet.lineTimingsOnly': ' · тайминг строк',
  'phone.player.songSheet.none': 'Нет',

  // ── song sheet: Stems + Project rows ──
  'phone.player.songSheet.stems': 'Треки',
  'phone.player.songSheet.project': 'Проект',
  // e.g. "Format v2 · FLAC stems"
  'phone.player.songSheet.formatVersion': 'Формат v{ver} · {format}',
  'phone.player.songSheet.onDisk': '{size} — диск',
  'phone.player.songSheet.playsAtKhz': 'звучит {khz} кГц',
  'phone.player.songSheet.savedOn': 'от {date}',
  'phone.player.songSheet.fromGoogleDrive': 'из Google Drive',
  'phone.player.songSheet.fromFolder': 'из папки',
  'phone.player.songSheet.onThisPhoneSource': 'на телефоне',
  'phone.player.songSheet.bundledSample': 'готовый пример',
  'phone.player.songSheet.gettingReady': 'Готовим…',

  // ── practice sheet: Key & speed ──
  'phone.player.practice.title': 'Занятие',
  'phone.player.practice.keySpeed': 'Тон и темп',
  'phone.player.practice.reset': 'Сброс',
  'phone.player.practice.pitch': 'Тон',
  // {key} is a musical key name (untranslated), {quality} is minor/major short form
  'phone.player.practice.pitchSuffix': '→ {key} {quality}',
  'phone.player.practice.tempo': 'Темп',
  'phone.player.practice.tempoSuffix': '→ {bpm} bpm',

  // ── practice sheet: Metronome ──
  'phone.player.practice.metronome': 'Метроном',
  'phone.player.practice.bpmFromSong': '{bpm} bpm, из песни',
  'phone.player.practice.noCountIn': 'Без отсчёта',
  'phone.player.practice.oneBar': '1 такт',
  'phone.player.practice.twoBars': '2 такта',
  'phone.player.practice.threeSec': '3 с',
  'phone.player.practice.sixSec': '6 с',
  'phone.player.practice.click': 'Клик',
  'phone.player.practice.accent': 'Акцент',
  'phone.player.practice.loudness': 'Уровень',
  'phone.player.practice.readOnlyHint':
    'Настройки метронома только для чтения — проект открыт без подтверждённого пути в библиотеке. Откройте из библиотеки, чтобы сохранять изменения.',
  // {step} is a progress line such as "Finding the beat…"
  'phone.player.practice.beatHintStep':
    '{step} — щелчок и отсчёт подхватят ритм, как только он найден.',
  'phone.player.practice.beatHintBusy':
    'Песня сейчас читается — щелчок и отсчёт подхватят ритм, как только он появится.',
  'phone.player.practice.beatHintPhoneNoTrack':
    'Нет сетки ритма — отсчёт идёт раз в секунду перед началом. Если у песни устойчивый ритм, при открытии здесь он будет считан с барабанов после разделения.',
  'phone.player.practice.beatHintDesktopNoTrack':
    'Нет сетки ритма — отсчёт идёт раз в секунду перед началом. Если у песни устойчивый ритм, на компьютере он будет считан с барабанов.',

  // ── practice sheet: Vocal training ──
  'phone.player.practice.vocalTraining': 'Тренировка',
  'phone.player.practice.training': 'Занятие',
  'phone.player.practice.byTime': 'Время',
  'phone.player.practice.byLyricLines': 'Строки',
  'phone.player.practice.interval': 'Интервал',
  'phone.player.practice.hear': 'Слух',
  'phone.player.practice.sing': 'Петь',
  'phone.player.practice.decreaseHear': 'Меньше слуха',
  'phone.player.practice.increaseHear': 'Больше слуха',
  'phone.player.practice.decreaseSing': 'Меньше пения',
  'phone.player.practice.increaseSing': 'Больше пения',
  'phone.player.practice.hearValue': 'Слух, {n}',
  'phone.player.practice.singValue': 'Петь, {n}',
  'phone.player.practice.scheduleTime':
    'Певец ведёт {sec} с, затем ваш ход {sec} с, и так по кругу',
  'phone.player.practice.scheduleLines_one':
    'Слушайте {n} строку с певцом, затем спойте {sing} сами — отмечено 🎤 в тексте',
  'phone.player.practice.scheduleLines_few':
    'Слушайте {n} строки с певцом, затем спойте {sing} сами — отмечено 🎤 в тексте',
  'phone.player.practice.scheduleLines_many':
    'Слушайте {n} строк с певцом, затем спойте {sing} сами — отмечено 🎤 в тексте',
  'phone.player.practice.scheduleLines_other':
    'Слушайте {n} строки с певцом, затем спойте {sing} сами — отмечено 🎤 в тексте',
  'phone.player.practice.withTheSinger': 'с певцом',
  'phone.player.practice.yourTurn': 'ваш ход',
  'phone.player.practice.yourTurnMic': 'ваш ход 🎤',
  'phone.player.practice.dropOutHint': 'Что отключится, когда поёте вы:',

  // ── practice sheet: Lyric timing ──
  'phone.player.practice.lyricTiming': 'Тайминг слов',
  // {route} e.g. " · Bluetooth, auto 120 ms" — appended to the section label above
  'phone.player.practice.lyricTimingRoute': ' · {label}, авто {ms} мс',
  'phone.player.practice.trim': 'Трим',
  'phone.player.practice.highlightsShifted':
    'Подсветка сдвинута на {ms} мс под то, что вы слышите. Если слова загораются раньше звука (авто, Bluetooth), увеличьте сдвиг.',

  // ── analysis progress (analysis/pipeline.ts → the Song/Practice sheets) ──
  'phone.player.analysis.listeningForBeat': 'Слушаем ритм…',
  'phone.player.analysis.findingBeat': 'Определяем ритм…',
  'phone.player.analysis.readingStems': 'Читаем дорожки…',
  'phone.player.analysis.readingKey': 'Тональность…',
  'phone.player.analysis.trackingMelody': 'Распознаём мелодию…',
  'phone.player.analysis.trackingMelodyPercent': 'Распознаём мелодию · {percent}%'
}
