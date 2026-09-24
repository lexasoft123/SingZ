/* Русский — the `phone.player` strings, typed against English. */
import type { player as en } from '../en/player'
import type { Translation } from '../../../../src/shared/i18n/types'

export const player: Translation<typeof en> = {
  // ── "not available in native playback yet" alert ──
  'phone.player.unsupported.title': 'Пока недоступно в нативном воспроизведении',
  'phone.player.unsupported.message': '«{operation}» останется отключено, пока не подключено к нативному DSP-управлению.',
  'phone.player.playbackStopped.title': 'Воспроизведение остановлено',
  'phone.player.metronomeSaveFailed.title': 'Настройка метронома не сохранена',
  // names of a PlaybackOperation, for the message above
  'phone.player.operation.pause': 'пауза',
  'phone.player.operation.seek': 'перемотка',
  'phone.player.operation.loopRegion': 'область повтора',
  'phone.player.operation.metronome': 'метроном',
  'phone.player.operation.mixer': 'микшер',
  'phone.player.operation.pitchTempo': 'высота тона и темп',
  'phone.player.operation.training': 'тренировка',
  'phone.player.operation.previewClick': 'предпрослушивание щелчка',

  // ── stem lane names (STEM_META ids: original/vocals/drums/bass/guitar/piano/other) ──
  'phone.player.stem.original': 'Полный микс',
  'phone.player.stem.vocals': 'Вокал',
  'phone.player.stem.drums': 'Барабаны',
  'phone.player.stem.bass': 'Бас',
  'phone.player.stem.guitar': 'Гитара',
  'phone.player.stem.piano': 'Клавишные',
  'phone.player.stem.other': 'Инструменты',

  // ── count-in display (playback/count-in-display.ts) ──
  'phone.player.countIn.beatLabel': 'Отсчёт, доля {done} из {total}',
  'phone.player.countIn.secondsLabel': 'Отсчёт, осталось {seconds} с',
  // the compact on-screen readout, e.g. "3s"
  'phone.player.countIn.secondsText': '{seconds} с',

  // ── song format line (ui/song-sheet-copy.ts) ──
  'phone.player.songSheet.formatFlac': 'дорожки FLAC',
  'phone.player.songSheet.formatWav': 'дорожки WAV',
  'phone.player.songSheet.formatFlacWav': 'дорожки FLAC + WAV',
  'phone.player.songSheet.formatNone': 'без дорожек',

  // ── shared UI kit accessibility strings (ui/bits.tsx) ──
  'phone.player.bits.decrease': 'Уменьшить «{label}»',
  'phone.player.bits.increase': 'Увеличить «{label}»',
  // e.g. "Hear, 3" — a stepper's screen-reader label followed by its value
  'phone.player.bits.labelValue': '{label}, {value}',
  // fallback screen-reader value for an adjustable bar with no custom formatter
  'phone.player.bits.percentValue': '{percent} процентов',
  // VoiceOver rotor action names for the adjustable Bar control
  'phone.player.bits.increaseAction': 'Увеличить',
  'phone.player.bits.decreaseAction': 'Уменьшить',

  // ── lyric column (ui/SkiaLyrics.tsx + the tap-target overlay in PlayerScreen) ──
  'phone.player.lyrics.waitSeconds': '{sec} с',
  'phone.player.lyrics.empty': 'В этом проекте пока нет текста песни.',
  // {text} is the lyric line itself; said for a line the singer performs solo
  'phone.player.lyrics.lineTurn': '{text}. Ваш ход.',

  // ── header (song title bar) ──
  'phone.player.header.back': 'Назад в библиотеку',
  'phone.player.header.about': 'Об этой песне',
  'phone.player.header.notSplit': 'Ещё не разделена',
  'phone.player.header.stemsCount': '{n} дорожек',
  'phone.player.header.added': '{n} добавлено',
  'phone.player.header.bpm': '{bpm} bpm',
  // musical key quality, abbreviated (header subtitle and the transpose suffix)
  'phone.player.header.keyMinor': 'мин',
  'phone.player.header.keyMajor': 'маж',
  'phone.player.header.youSing': 'ВЫ ПОЁТЕ 🎤',

  // ── loop (A-B repeat) button ──
  'phone.player.loop.markStart': 'Повтор участка. Отметить начало здесь.',
  // {time} e.g. "1:23"
  'phone.player.loop.startMarked': 'Начало повтора отмечено на {time}. Отметить конец здесь.',
  'phone.player.loop.looping': 'Повтор {a}–{b}. Убрать повтор.',
  'phone.player.loop.buttonA': 'A',
  'phone.player.loop.buttonAB': 'A–B',

  // ── transport (footer controls) ──
  'phone.player.transport.position': 'Позиция',
  'phone.player.transport.mixer': 'Микшер',
  'phone.player.transport.backToStart': 'В начало',
  'phone.player.transport.back5': 'Назад на 5 секунд',
  'phone.player.transport.forward5': 'Вперёд на 5 секунд',
  'phone.player.transport.practice': 'Тренировка',
  'phone.player.transport.play': 'Воспроизвести',
  'phone.player.transport.pause': 'Пауза',

  // ── mixer sheet ──
  'phone.player.mixer.title': 'Микшер',
  'phone.player.mixer.fullMix': 'Полный микс',
  'phone.player.mixer.noVocals': 'Без вокала',
  'phone.player.mixer.vocalsOnly': 'Только вокал',
  // header over the singer's own added tracks, below the song's own stems
  'phone.player.mixer.added': 'Добавленные',
  'phone.player.mixer.yourTurn': 'ваш ход',
  'phone.player.mixer.mute': 'Заглушить «{label}»',
  'phone.player.mixer.solo': 'Соло «{label}»',
  'phone.player.mixer.volumeLabel': 'Громкость «{label}»',

  // ── song sheet: Beat row ──
  'phone.player.songSheet.beat': 'Ритм',
  // e.g. "120 bpm · 4/4 · 32 bars"
  'phone.player.songSheet.bpmMeterBars': '{bpm} bpm · {meter} · тактов: {bars}',
  'phone.player.songSheet.noBeatVerdict': 'В этих барабанах нет ритма',
  'phone.player.songSheet.readingSong': 'Читаем песню…',
  'phone.player.songSheet.notDetectedYet': 'Ещё не определено',
  'phone.player.songSheet.handMade': 'сделано вручную на компьютере',
  'phone.player.songSheet.detectorVersion': 'детектор v{ver}',
  'phone.player.songSheet.handSetBars_one': ' · {n} такт вручную',
  'phone.player.songSheet.handSetBars_few': ' · {n} такта вручную',
  'phone.player.songSheet.handSetBars_many': ' · {n} тактов вручную',
  'phone.player.songSheet.handSetBars_other': ' · {n} такта вручную',
  'phone.player.songSheet.beatHintProgress':
    'Слушаем прямо сейчас — щелчок и отсчёт подхватят ритм, как только он найден.',
  'phone.player.songSheet.beatHintHandTuned':
    'Настроено вручную на компьютере — повторное определение это не тронет. ',
  'phone.player.songSheet.beatHintUserBars':
    'На этой сетке есть ваши собственные линии тактов, и они останутся. ',
  'phone.player.songSheet.beatHintFollow':
    'Щелчок, отсчёт и линии тактов следуют за этим.',
  'phone.player.songSheet.beatHintVerdict':
    'Детектор прослушал песню и не нашёл устойчивого ритма, под который можно поставить щелчок, — свободный темп или песня без барабанов. Этот ответ запоминается, чтобы повторное открытие песни не читало дорожки впустую.',
  'phone.player.songSheet.beatHintDetectAgain': ' Нажмите «Определить снова», чтобы спросить ещё раз.',
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
  'phone.player.songSheet.detecting': 'Определяем…',
  'phone.player.songSheet.detectAgain': 'Определить снова',

  // ── song sheet: Better beats row ──
  'phone.player.songSheet.betterBeats': 'Точный ритм',
  'phone.player.songSheet.downloading': 'Загрузка — {mb} из {total} МБ',
  'phone.player.songSheet.onThisPhone': 'На этом телефоне',
  'phone.player.songSheet.notDownloaded': 'Не загружено — {mb} МБ',
  'phone.player.songSheet.checking': 'Проверяем…',
  'phone.player.songSheet.betterBeatsHint':
    'Нейросетевая модель, которая слышит ритм сквозь вступления без барабанов и свободный темп, теряемые обычным способом чтения. Загружается один раз и используется потом для любой песни.',
  'phone.player.songSheet.betterBeatsHintDetectAgain': ' Нажмите «Определить снова», чтобы применить её к этой песне.',
  'phone.player.songSheet.cancel': 'Отмена',
  'phone.player.songSheet.downloadMb': 'Загрузить {mb} МБ',

  // ── song sheet: Key row ──
  'phone.player.songSheet.key': 'Тональность',
  'phone.player.songSheet.noKeyVerdict': 'В этих дорожках нет тональности',
  'phone.player.songSheet.keyVerdictHint':
    'Гармония, по которой читается тональность, — гитара, клавишные и бас — здесь беззвучна, читать нечего. Этот ответ запоминается, а не читается заново при каждом открытии.',
  // full words, unlike the header's abbreviated min/maj
  'phone.player.songSheet.keyMinor': 'минор',
  'phone.player.songSheet.keyMajor': 'мажор',

  // ── song sheet: Melody row ──
  'phone.player.songSheet.melody': 'Мелодия',
  'phone.player.songSheet.trackedFromVocals': 'Распознана по вокалу',
  'phone.player.songSheet.notTrackedYet': 'Ещё не распознана',
  'phone.player.songSheet.melodyDetector': 'детектор v{ver} · один кадр каждые {ms} мс',
  'phone.player.songSheet.melodyHint':
    'Спетая линия, сохранённая вместе с песней. Телефон её не рисует — это делает полоска высоты тона на компьютере.',

  // ── song sheet: Lyrics row ──
  'phone.player.songSheet.lyrics': 'Текст песни',
  'phone.player.songSheet.linesCount': '{n} строк',
  'phone.player.songSheet.wordTimings': ' · тайминги слов',
  'phone.player.songSheet.lineTimingsOnly': ' · только тайминги строк',
  'phone.player.songSheet.none': 'Нет',

  // ── song sheet: Stems + Project rows ──
  'phone.player.songSheet.stems': 'Дорожки',
  'phone.player.songSheet.project': 'Проект',
  // e.g. "Format v2 · FLAC stems"
  'phone.player.songSheet.formatVersion': 'Формат v{ver} · {format}',
  'phone.player.songSheet.onDisk': '{size} на диске',
  'phone.player.songSheet.playsAtKhz': 'играет на {khz} кГц',
  'phone.player.songSheet.savedOn': 'сохранено {date}',
  'phone.player.songSheet.fromGoogleDrive': 'из Google Drive',
  'phone.player.songSheet.fromFolder': 'из папки',
  'phone.player.songSheet.onThisPhoneSource': 'на этом телефоне',
  'phone.player.songSheet.bundledSample': 'встроенный пример',
  'phone.player.songSheet.gettingReady': 'Готовим…',

  // ── practice sheet: Key & speed ──
  'phone.player.practice.title': 'Тренировка',
  'phone.player.practice.keySpeed': 'Тональность и скорость',
  'phone.player.practice.reset': 'Сбросить',
  'phone.player.practice.pitch': 'Высота тона',
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
  'phone.player.practice.click': 'Щелчок',
  'phone.player.practice.accent': 'Акцент',
  'phone.player.practice.loudness': 'Громкость',
  'phone.player.practice.readOnlyHint':
    'Настройки метронома доступны только для чтения, потому что этот проект открыт без подтверждённого расположения библиотеки. Откройте его из библиотеки заново, чтобы сохранять изменения.',
  // {step} is a progress line such as "Finding the beat…"
  'phone.player.practice.beatHintStep':
    '{step} — щелчок и отсчёт подхватят ритм, как только он найден.',
  'phone.player.practice.beatHintBusy':
    'Песня сейчас читается — щелчок и отсчёт подхватят ритм, как только он появится.',
  'phone.player.practice.beatHintPhoneNoTrack':
    'Нет сетки ритма — отсчёт идёт раз в секунду перед началом воспроизведения. Если у песни устойчивый ритм, при открытии здесь он будет считан с барабанов после разделения.',
  'phone.player.practice.beatHintDesktopNoTrack':
    'Нет сетки ритма — отсчёт идёт раз в секунду перед началом воспроизведения. Если у песни устойчивый ритм, при открытии на компьютере он будет считан с барабанов.',

  // ── practice sheet: Vocal training ──
  'phone.player.practice.vocalTraining': 'Вокальная тренировка',
  'phone.player.practice.training': 'Тренировка',
  'phone.player.practice.byTime': 'По времени',
  'phone.player.practice.byLyricLines': 'По строкам текста',
  'phone.player.practice.interval': 'Интервал',
  'phone.player.practice.hear': 'Слушать',
  'phone.player.practice.sing': 'Петь',
  'phone.player.practice.decreaseHear': 'Уменьшить «Слушать»',
  'phone.player.practice.increaseHear': 'Увеличить «Слушать»',
  'phone.player.practice.decreaseSing': 'Уменьшить «Петь»',
  'phone.player.practice.increaseSing': 'Увеличить «Петь»',
  'phone.player.practice.hearValue': 'Слушать, {n}',
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
  'phone.player.practice.dropOutHint': 'Дорожки, которые отключаются, когда поёте вы:',

  // ── practice sheet: Lyric timing ──
  'phone.player.practice.lyricTiming': 'Синхронизация текста',
  // {route} e.g. " · Bluetooth, auto 120 ms" — appended to the section label above
  'phone.player.practice.lyricTimingRoute': ' · {label}, авто {ms} мс',
  'phone.player.practice.trim': 'Сдвиг',
  'phone.player.practice.highlightsShifted':
    'Подсветка сдвинута на {ms} мс, чтобы совпасть с тем, что вы слышите. Если слова загораются раньше, чем вы их слышите (автомагнитола, Bluetooth), увеличьте сдвиг.',

  // ── analysis progress (analysis/pipeline.ts → the Song/Practice sheets) ──
  'phone.player.analysis.listeningForBeat': 'Слушаем ритм…',
  'phone.player.analysis.findingBeat': 'Определяем ритм…',
  'phone.player.analysis.readingStems': 'Читаем дорожки…',
  'phone.player.analysis.readingKey': 'Читаем тональность…',
  'phone.player.analysis.trackingMelody': 'Распознаём мелодию…',
  'phone.player.analysis.trackingMelodyPercent': 'Распознаём мелодию · {percent}%'
}
