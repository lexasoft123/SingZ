/* Русский — the `training` strings, typed against English. */
import type { training as en } from '../en/training'
import type { Translation } from '../types'

export const training: Translation<typeof en> = {
  // ── exercise picker (home) ──
  'training.exercise.note.label': 'Спойте ноту',
  'training.exercise.note.description': 'Услышьте ноту и попадите в неё голосом.',
  'training.exercise.scaleDegree.label': 'Ноты гаммы',
  'training.exercise.scaleDegree.description': 'Услышьте ноты одной тональности.',
  'training.exercise.interval.label': 'Интервалы',
  'training.exercise.interval.description': 'Спойте расстояние между нотами, вверх или вниз.',
  'training.exercise.chordTone.label': 'Тон аккорда',
  'training.exercise.chordTone.description': 'Найдите тон, терцию или квинту аккорда.',
  'training.exercise.arpeggio.label': 'Арпеджио',
  'training.exercise.arpeggio.description': 'Спойте аккорд по одной ноте.',
  'training.exercise.mixed.label': 'Микс-практика',
  'training.exercise.mixed.description': 'Пройдите по кругу упражнения в короткой сессии.',

  // ── home screen ──
  'training.home.eyebrow': 'Фокус на интонации',
  'training.home.heading': 'Что вы хотите слышать чётче?',
  'training.home.subheading': 'Выберите один навык. SingZ удержит сессию в вашем удобном диапазоне.',
  'training.home.exercisesAriaLabel': 'Список упражнений',
  'training.home.progressEntry.label': 'Прогресс',
  'training.home.progressEntry.empty': 'Здесь появится история ваших занятий.',
  // "{n} completed session(s) · 84% landed" on the home screen's Progress entry
  'training.home.progressEntry.summary_one': '{n} сессия завершена · попало {percent}',
  'training.home.progressEntry.summary_few': '{n} сессии завершены · попало {percent}',
  'training.home.progressEntry.summary_many': '{n} сессий завершено · попало {percent}',
  'training.home.progressEntry.summary_other': '{n} сессии завершено · попало {percent}',
  'training.home.micNote': 'Звук микрофона анализируется, но не сохраняется.',

  // ── "loaded song" preparation card on the home screen ──
  'training.home.songPrep.eyebrow': 'Эта песня',
  // {name} is the song title; keep the curly quotes
  'training.home.songPrep.title': 'Готовы к «{name}»',
  // appended after the key name, e.g. "A minor · transposed +2"
  'training.home.songPrep.transposedSuffix': ' · смещено {sign}{amount}',
  'training.home.songPrep.confirmKeyFirst': 'Подтвердите тональность',
  'training.home.songPrep.tagline': 'Потренируйте ноты, интервалы и аккорды.',
  'training.home.songPrep.ariaPrepareFor': 'Готовы к {name}',
  'training.home.songPrep.choice.notes': 'Ноты',
  'training.home.songPrep.choice.intervals': 'Интервалы',
  'training.home.songPrep.choice.chords': 'Аккорд',
  'training.home.songPrep.choice.mixed': 'Микс-разминка',
  'training.home.songPrep.chooseFocusHelp':
    'Выберите фокус подготовки, откройте настройку, затем подтвердите тональность.',

  // ── progress screen ──
  'training.progress.eyebrow': 'История занятий',
  'training.progress.heading': 'Прогресс',
  'training.progress.subheading': 'Только завершённые сессии. Звук микрофона не сохраняется.',
  'training.progress.empty.heading': 'Нет завершённых сессий',
  'training.progress.empty.body': 'Завершите упражнение, чтобы увидеть прогресс.',
  'training.progress.empty.cta': 'Выбрать упражнение',
  'training.progress.metric.completedSessions': 'Завершённые сессии',
  'training.progress.metric.onTargetOrClose': 'Точно или близко',
  'training.progress.metric.pitchTendency': 'Тенденция тона',
  'training.progress.ariaStatistics': 'Статистика тренировки',
  'training.progress.focus.heading': 'Следующий фокус',
  'training.progress.focus.exerciseTypes': 'Тип упражнений',
  'training.progress.focus.scaleDegrees': 'Ступени гаммы',
  // "Degree 3" — a single scale degree named in the weak-spots list
  'training.progress.focus.degree': 'Ступень {n}',
  'training.progress.focus.chordRoles': 'Роли аккорда',
  'training.progress.weakness.needMore': 'Нужно больше сессий',
  'training.progress.recent.heading': 'Недавние сессии',
  'training.progress.recent.landed': '{landed}/{attempts} попаданий',

  // ── metrics shared by the progress and summary screens ──
  'training.metric.voiceDetected': 'Голос найден',
  'training.metric.pitchHeldSteady': 'Тон стабилен',
  'training.metric.close': 'Рядом',
  'training.metric.averageError': 'Средняя ошибка · точно или близко',

  // pitch tendency, e.g. "Usually sharp"
  'training.tendency.notEnough': 'Пока мало данных о тоне',
  'training.tendency.centered': 'В целом чисто',
  // {word} is training.word.sharp/flat
  'training.tendency.usually': 'Обычно {word}',

  // ── session setup screen ──
  'training.setup.eyebrow': 'Настройка',
  'training.setup.legend.musicalContext': 'Контекст лада',
  'training.setup.label.key': 'Тональность',
  'training.setup.ariaLabel.keyMode': 'Лад',
  'training.setup.option.major': 'Мажор',
  'training.setup.option.minor': 'Минор',
  'training.setup.label.task': 'Вид',
  'training.setup.ariaLabel.taskMode': 'Режим',
  'training.setup.task.imitate': 'Повтор',
  'training.setup.task.find': 'Найти ноту без помощи',
  'training.setup.task.identify': 'Слушать и выбрать',
  'training.setup.taskHelp.imitate': 'Услышьте ответ и повторите его голосом.',
  'training.setup.taskHelp.find': 'Услышьте тональность или ноту, затем найдите ответ сами.',
  'training.setup.taskHelp.identify': 'Услышьте вопрос и выберите ответ. Микрофон остаётся выключенным.',
  'training.setup.error.noMic': 'Нет микрофона. «Слушать и выбрать» работает как практика на слух.',
  'training.setup.label.direction': 'Ход',
  'training.setup.ariaLabel.direction': 'Ход',
  'training.setup.legend.range': 'Певческий диапазон',
  'training.setup.rangeHelp': 'Используйте удобные рабочие ноты, не весь диапазон.',
  'training.setup.label.lowestNote': 'Нижняя нота',
  'training.setup.label.highestNote': 'Верхняя нота',
  'training.setup.legend.chordDegrees': 'Ноты аккорда',
  // checkbox label, e.g. "Scale degree 3"
  'training.setup.chordDegreeLabel': 'Ступень лада {n}',
  'training.setup.legend.practiceSettings': 'Общие настройки практики',
  'training.setup.label.notePlaybackVolume': 'Громкость ноты',
  'training.setup.testNote.playing': 'Играет C4…',
  'training.setup.testNote.idle': '▶ Тест C4',
  'training.setup.ariaLabel.lowerVolume': 'Уменьшить громкость',
  'training.setup.ariaLabel.raiseVolume': 'Увеличить громкость',
  'training.setup.ariaLabel.notePlaybackVolume': 'Громкость ноты',
  'training.setup.help.volumeRange': '20–200% · для всех упражнений',
  'training.setup.label.pitchTolerance': 'Допуск по тону',
  'training.setup.ariaLabel.pitchTolerance': 'Допуск по тону',
  'training.setup.help.pitchTolerance': 'Удержитесь в допуске {seconds} секунд, чтобы продолжить.',
  'training.setup.error.chooseOne': 'Выберите хотя бы один пункт для сессии.',
  'training.setup.label.exercises': 'Задания',
  'training.setup.startPractice': 'Начать сессию',
  // number of exercises in a session, e.g. "1 exercise" / "6 exercises"
  'training.exerciseCount_one': '{n} упражнение',
  'training.exerciseCount_few': '{n} упражнения',
  'training.exerciseCount_many': '{n} упражнений',
  'training.exerciseCount_other': '{n} упражнения',

  // ── in-session screen ──
  'training.nav.backToTraining': '← Практика',
  'training.session.aria.backToSong': '← Песня',
  'training.session.aria.endSession': 'Завершить',
  'training.session.aria.exerciseProgress': '№{current} из {total}',
  'training.session.aria.targetNotes': 'Целевые ноты',
  'training.session.ready.paused': 'Практика на паузе. Продолжите, когда готовы.',
  'training.session.ready.preparing': 'Готовим ваше упражнение…',
  'training.session.readyAction.continue': 'Продолжить сессию',
  'training.session.error.sessionInactive': 'Тренировочная сессия больше не активна.',
  'training.session.error.noMicUseListen': 'Нет микрофона. Используйте «Слушать и выбрать» для практики на слух.',
  'training.session.error.micDisconnected': 'Микрофон отключился. Подключите его снова и начните это упражнение заново.',
  'training.session.identify.legend': 'Что вы услышали?',

  // ── cue / countdown instructions ──
  'training.cue.identify': 'Приготовьтесь. Слушайте и выбирайте после отсчёта.',
  'training.cue.imitate': 'Приготовьтесь. Слушайте, затем спойте после отсчёта.',
  'training.cue.find': 'Приготовьтесь. Запомните ноту, затем спойте после отсчёта.',

  // ── transport controls during a response ──
  'training.transport.ariaControls': 'Управление',
  'training.transport.aria.replay': 'Повторить ноту',
  'training.transport.label.replay': 'Заново',
  'training.transport.aria.listeningStatus': 'Микрофон слушает',
  'training.transport.listening': 'Слушаю',
  'training.transport.aria.skip': 'Пропуск ноты',
  'training.transport.label.skip': 'Пропустить',

  // ── pitch runway (live intonation feedback) ──
  'training.session.pitch.onTarget': 'Точно',
  'training.session.pitch.sharp': 'Выше',
  'training.session.pitch.flat': 'Ниже',
  'training.session.pitch.listening': 'Слушаю',
  // initial/reset state before any pitch has been read
  'training.session.guidance.listeningDefault': 'Слушаю ваш голос.',
  'training.session.runway.youAreSinging': 'Вы поёте',
  'training.session.runway.holdInstruction': 'Спойте ноту. Держите ±{cents}¢ {seconds} секунд.',
  'training.session.runway.inTune': 'Чисто — держите',
  'training.session.runway.lower': 'Чуть ниже',
  'training.session.runway.higher': 'Чуть выше',
  'training.session.runway.ariaHoldProgress': 'Удержание',

  // screen-reader only announcements of the live pitch, e.g. "Listening for
  // A4. No voice detected yet." — {target} is a note name, left untranslated
  'training.session.accessible.listeningFor': 'Слушаю {target}. Голос пока не обнаружен.',
  'training.session.accessible.voiceDetected': 'Голос найден для {target}. Держите тон стабильно.',
  // {guidance} is training.session.pitch.onTarget/sharp/flat
  'training.session.accessible.pitchSteady': '{guidance} для {target}. Тон стабилен.',

  // ── errors surfaced while training audio/mic is starting ──
  'training.error.mic.blocked': 'Микрофон заблокирован. Разрешите SingZ в настройках приватности и повторите.',
  'training.error.mic.notFound': 'Микрофон не найден. Подключите его или используйте «Слушать и выбрать».',
  'training.error.mic.busy': 'Микрофон занят в другом приложении. Закройте его и повторите.',
  'training.error.audio.startFailedWithMessage': 'Не удалось запустить звук: {message}',
  'training.error.audio.startFailedGeneric': 'Не удалось запустить звук. Проверьте аудиоустройства и повторите.',

  // ── session summary screen ──
  'training.summary.eyebrow': 'Сессия завершена',
  'training.summary.ariaMetrics': 'Метрики сессии',
  'training.summary.headingTemplate': '{landed}/{attempts} попаданий',
  'training.summary.noPitchMetrics': 'В сессии на слух метрики тона не использовались.',
  'training.summary.noSteadyNotes': 'В этой сессии не обнаружено стабильных чистых нот.',
  'training.summary.stayedInTune': 'В среднем вы пели чисто.',
  // {word} is training.word.sharp/flat
  'training.summary.tended': 'В среднем вы пели {word}.',
  'training.summary.restart': 'Заново',
  'training.summary.backToTraining': 'К тренировке',
  'training.summary.backToSong': '← Песня',

  // ── empty state (no exercise ready) ──
  'training.empty.heading': 'Упражнение не готово',
  'training.empty.body': 'Сначала выберите фокус тренировки и удобный диапазон.',

  // ── per-attempt outcome labels (session summary outcomes list) ──
  'training.outcome.none': 'Итога нет',
  'training.outcome.skipped': 'Пропуск',
  'training.outcome.correct': 'Верно',
  'training.outcome.tryAgain': 'Попробуйте ещё раз',
  'training.outcome.exerciseFallback': '№{n}',
  'training.outcome.wrongNote': 'Не та нота',
  'training.outcome.wrongOctave': 'Не та октава',
  'training.outcome.otherChordTone': 'Иной тон аккорда',
  'training.outcome.nonChordTone': 'Не тон аккорда',
  'training.outcome.unstable': 'Неточно',
  'training.outcome.unvoiced': 'Молчание',
  'training.outcome.outOfRange': 'Вне зоны',

  // ── feedback shown right after an attempt ──
  'training.feedback.skipped.detail': 'Упражнение не оценивалось.',
  'training.feedback.identifyCorrect.detail': 'Запомните этот звук перед следующим вопросом.',
  'training.feedback.identifyWrong.heading': 'Не в этот раз',
  'training.feedback.identifyWrong.detail': 'Прослушайте тональность и сравните ноты снова.',
  'training.feedback.onTarget.detail': 'Тон отчётливо устоялся в центре.',
  'training.feedback.close.heading': 'Уже рядом',
  'training.feedback.close.detail': 'Нужные ноты есть; сделайте их чуть точнее по центру.',
  'training.feedback.wrong.detail': 'Отпустите ноту и слушайте следующую подсказку.',

  // Longer per-classification headings used as feedback when a vocal attempt
  // misses ("wrong note", "unstable", …) — distinct from the short
  // training.outcome.* labels used in the summary's outcomes list.
  'training.classification.close': 'Близко — ещё один заход, и получится',
  'training.classification.wrongNote': 'Прозвучала другая нота',
  'training.classification.wrongOctave': 'Верная нота, другая октава',
  'training.classification.otherChordTone': 'Спет другой тон аккорда',
  'training.classification.nonChordTone': 'Нота вышла за пределы аккорда',
  'training.classification.unstable': 'Тон пока не устоялся',
  'training.classification.unvoiced': 'Голос не обнаружен',
  'training.classification.outOfRange': 'Обнаруженная нота была вне выбранного диапазона',

  // ── "Listen and choose" prompt kind labels, before the answer is revealed ──
  'training.kindLabel.identifyNote': 'Слушайте и выберите ноту',
  'training.kindLabel.identifyNumber': 'Слушайте и выберите число',
  'training.kindLabel.identifyInterval': 'Слушайте и выберите интервал',
  'training.kindLabel.identifyChordNote': 'Слушайте и укажите тон аккорда',
  'training.kindLabel.identifyChord': 'Слушайте и укажите аккорд',

  // ── identify-mode answer reveal / detail text ──
  // {note} is a bare note name (untranslated), e.g. "Answer: A"
  'training.identify.answerNote': 'Ответ: {note}',
  'training.identify.answerScaleDegree': 'Ответ: ступень гаммы {n}',
  // {interval} is a lowercase interval word (training.word.*), {direction} likewise
  'training.identify.answerInterval': 'Ответ: {interval} {direction}',
  // {role} is training.word.root/third/fifth, {chord} is "{note} {quality}"
  'training.identify.answerChordTone': 'Ответ: {role} {chord}',
  'training.identify.answerArpeggio': 'Ответ: ступень {degree} — {chord}',
  // detail text under an identify answer choice, e.g. "Scale degree 3"
  'training.identify.scaleDegreeDetail': 'Ступень лада {n}',
  // arpeggio identify-answer label, e.g. "Degree 3"
  'training.identify.degreeLabel': 'Ступень {n}',
  // "{chord} arpeggio" — the word appended after a chord name
  'training.label.arpeggioOf': 'арпеджио {chord}',

  // ── generic single music-theory words, interpolated lowercase ──
  'training.word.major': 'мажор',
  'training.word.minor': 'минор',
  'training.word.diminished': 'уменьшённый',
  'training.word.augmented': 'увеличенный',
  'training.word.root': 'прима',
  'training.word.third': 'терция',
  'training.word.fifth': 'квинта',
  'training.word.ascending': 'вверх',
  'training.word.descending': 'вниз',
  'training.word.both': 'обе',
  'training.word.arpeggio': 'арпеджио',
  'training.word.sharp': 'выше',
  'training.word.flat': 'ниже',
  'training.word.unison': 'унисон',
  'training.word.second': 'секунда',
  'training.word.fourth': 'кварта',
  'training.word.sixth': 'секста',
  'training.word.seventh': 'септима',
  'training.word.octave': 'октава',
  // fallback for an interval number outside the named set
  'training.word.intervalGeneric': 'интервал {n}',

  // ── short nouns for weak-spot / kind labels ──
  'training.kind.note': 'Нота',
  'training.kind.scaleDegree': 'Ступень лада',
  'training.kind.interval': 'Интервал',
  'training.kind.chordTone': 'Тон аккорда',
  'training.kind.arpeggio': 'Арпеджио',

  // ── vocal training route (module load / error states) ──
  'training.route.eyebrow': 'Тренировка',
  'training.route.opening': 'Открываем сессию…',
  'training.route.openingStatus': 'Открытие тренировки.',
  'training.route.failure.heading': 'Практика не открыта',
  'training.route.failure.body': 'Не удалось загрузить экран практики. Песня остаётся на паузе.',
  'training.route.retry': 'Снова',
  'training.route.failure.recoveryFailed': 'Резервную копию тоже не удалось загрузить. Перезапустите SingZ и повторите.',
  'training.route.returnToSongs': 'К песням',
  'training.route.runtimeFailure.heading': 'Сессия прервана',
  'training.route.runtimeFailure.stopping': 'Останавливаем звук и освобождаем микрофон…',
  'training.route.runtimeFailure.unsafe':
    'Не удалось подтвердить остановку звука или микрофона. Повторите очистку и не закрывайте SingZ перед выходом.',
  'training.route.runtimeFailure.safe':
    'Звук упражнения и микрофон остановлены, песня поставлена на паузу.',
  'training.route.retryCleanup': 'Очистить',
  'training.route.cleanupGate.stoppingHeading': 'Завершаем очистку звука…',
  'training.route.cleanupGate.attentionHeading': 'Очистке нужно внимание',
  'training.route.cleanupGate.stoppingBody':
    'Подтверждаем, что звук упражнения и микрофон остановились, перед выходом.',
  'training.route.cleanupGate.attentionBody':
    'Микрофон или звук упражнения не подтвердили очистку. Останьтесь здесь и повторите попытку перед другим аудиопутём.',

  // ── session generator (shared/training-session.ts instructions) ──
  'training.session.instruction.identifyNote': 'Определите ноту.',
  // {note} is a bare note name, untranslated
  'training.session.instruction.matchNote': 'Спойте {note}',
  'training.session.instruction.identifyScaleDegree': 'Определите ступень гаммы.',
  'training.session.instruction.singScaleDegree': 'Спойте ступень {degree} — {note}.',
  'training.session.instruction.identifyInterval': 'Определите интервал.',
  // {interval} is prompt.intervalName (a music-theory term, untranslated)
  'training.session.instruction.singInterval': 'Интервал: {interval} {direction} — {from}→{to}',
  'training.session.instruction.identifyChordTone': 'Определите тон аккорда.',
  'training.session.instruction.singChordTone': 'Спойте {note} — {role} {chord}.',
  'training.session.instruction.identifyArpeggio': 'Определите аккорд арпеджио.',
  'training.session.instruction.arpeggiate': 'Арпеджио {chord} {direction}.',

  // ── session generator validation error reachable from normal setup ──
  'training.session.error.rangeTooNarrow': 'Ни одно упражнение не вписывается в рабочий диапазон.',
  'training.session.error.confirmKeyThenReview': 'Подтвердите или измените тональность, затем просмотрите подготовку.',
  'training.session.error.setUpSessionFirst': 'Настройте сессию перед началом.',
  'training.session.error.exerciseNoLongerActive': 'Это упражнение больше не активно.',

  // ── audio/training-cleanup.ts: cross-feature audio-safety notices ──
  'training.cleanup.songBlocked':
    'Песня недоступна, пока вокальная тренировка не подтвердит остановку микрофона и звука упражнения. Повторите очистку там.',
  'training.cleanup.settingsBlocked':
    'Настройки звука недоступны, пока вокальная тренировка не подтвердит остановку микрофона и звука упражнения. Повторите очистку там.',
  'training.cleanup.audioBlocked':
    'Звук вокальной тренировки недоступен, пока не разрешена прежняя очистка микрофона и звука упражнения. Повторите очистку перед продолжением.',
  // thrown as an Error message when cleanup fails with a non-Error cause;
  // surfaces wherever that error's .message is displayed
  'training.cleanup.couldNotConfirm': 'Не удалось подтвердить очистку тренировки.',

  // ── misc ──
  'training.error.couldNotOpenFile': 'Не удалось открыть файл.'
}
