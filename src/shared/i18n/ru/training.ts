/* Русский — the `training` strings, typed against English. */
import type { training as en } from '../en/training'
import type { Translation } from '../types'

export const training: Translation<typeof en> = {
  // ── exercise picker (home) ──
  'training.exercise.note.label': 'Попасть в ноту',
  'training.exercise.note.description': 'Услышьте ноту и попадите в неё голосом.',
  'training.exercise.scaleDegree.label': 'Ноты в тональности',
  'training.exercise.scaleDegree.description': 'Услышьте, как ноты вписываются в тональность.',
  'training.exercise.interval.label': 'Интервалы',
  'training.exercise.interval.description': 'Спойте расстояние между двумя нотами, вверх или вниз.',
  'training.exercise.chordTone.label': 'Тоны аккорда',
  'training.exercise.chordTone.description': 'Найдите основной тон, терцию или квинту аккорда.',
  'training.exercise.arpeggio.label': 'Арпеджио',
  'training.exercise.arpeggio.description': 'Пройдите аккорд по одной ноте за раз.',
  'training.exercise.mixed.label': 'Смешанная практика',
  'training.exercise.mixed.description': 'Пройдите по кругу все упражнения в короткой репетиции.',

  // ── home screen ──
  'training.home.eyebrow': 'Точечная тренировка интонации',
  'training.home.heading': 'Что вы хотите слышать чётче?',
  'training.home.subheading': 'Выберите один навык. SingZ удержит сессию в вашем удобном диапазоне.',
  'training.home.exercisesAriaLabel': 'Упражнения тренировки',
  'training.home.progressEntry.label': 'Прогресс',
  'training.home.progressEntry.empty': 'Здесь появится история ваших занятий.',
  // "{n} completed session(s) · 84% landed" on the home screen's Progress entry
  'training.home.progressEntry.summary_one': '{n} завершённая сессия · попадание {percent}',
  'training.home.progressEntry.summary_few': '{n} завершённые сессии · попадание {percent}',
  'training.home.progressEntry.summary_many': '{n} завершённых сессий · попадание {percent}',
  'training.home.progressEntry.summary_other': '{n} завершённой сессии · попадание {percent}',
  'training.home.micNote': 'Звук с микрофона анализируется в реальном времени и никогда не сохраняется.',

  // ── "loaded song" preparation card on the home screen ──
  'training.home.songPrep.eyebrow': 'Загруженная песня',
  // {name} is the song title; keep the curly quotes
  'training.home.songPrep.title': 'Подготовиться к «{name}»',
  // appended after the key name, e.g. "A minor · transposed +2"
  'training.home.songPrep.transposedSuffix': ' · транспонировано {sign}{amount}',
  'training.home.songPrep.confirmKeyFirst': 'Сначала подтвердите тональность песни',
  'training.home.songPrep.tagline': 'Потренируйте её ноты, интервалы и аккорды.',
  'training.home.songPrep.ariaPrepareFor': 'Подготовиться к {name}',
  'training.home.songPrep.choice.notes': 'Ноты',
  'training.home.songPrep.choice.intervals': 'Интервалы',
  'training.home.songPrep.choice.chords': 'Аккорды',
  'training.home.songPrep.choice.mixed': 'Смешанная разминка',
  'training.home.songPrep.chooseFocusHelp':
    'Выберите любой фокус подготовки, чтобы открыть настройку, затем подтвердите или измените тональность вручную.',

  // ── progress screen ──
  'training.progress.eyebrow': 'История занятий',
  'training.progress.heading': 'Прогресс',
  'training.progress.subheading': 'Только завершённые сессии. Звук с вашего микрофона никогда не сохраняется.',
  'training.progress.empty.heading': 'Пока нет завершённых сессий',
  'training.progress.empty.body': 'Завершите упражнение, чтобы получить первый снимок прогресса.',
  'training.progress.empty.cta': 'Выбрать упражнение',
  'training.progress.metric.completedSessions': 'Завершённые сессии',
  'training.progress.metric.onTargetOrClose': 'Точно или близко',
  'training.progress.metric.pitchTendency': 'Тенденция интонации',
  'training.progress.ariaStatistics': 'Статистика прогресса тренировки',
  'training.progress.focus.heading': 'Полезный следующий фокус',
  'training.progress.focus.exerciseTypes': 'Типы упражнений',
  'training.progress.focus.scaleDegrees': 'Ступени гаммы',
  // "Degree 3" — a single scale degree named in the weak-spots list
  'training.progress.focus.degree': 'Ступень {n}',
  'training.progress.focus.chordRoles': 'Роли в аккорде',
  'training.progress.weakness.needMore': 'Нужно больше сессий',
  'training.progress.recent.heading': 'Недавние сессии',
  'training.progress.recent.landed': '{landed} из {attempts} попаданий',

  // ── metrics shared by the progress and summary screens ──
  'training.metric.voiceDetected': 'Голос обнаружен',
  'training.metric.pitchHeldSteady': 'Высота тона держалась стабильно',
  'training.metric.close': 'Близко',
  'training.metric.averageError': 'Средняя погрешность · точно или близко',

  // pitch tendency, e.g. "Usually sharp"
  'training.tendency.notEnough': 'Пока недостаточно данных о высоте тона',
  'training.tendency.centered': 'В целом чисто',
  // {word} is training.word.sharp/flat
  'training.tendency.usually': 'Обычно {word}',

  // ── session setup screen ──
  'training.setup.eyebrow': 'Настройка сессии',
  'training.setup.legend.musicalContext': 'Музыкальный контекст',
  'training.setup.label.key': 'Тональность',
  'training.setup.ariaLabel.keyMode': 'Лад тональности',
  'training.setup.option.major': 'Мажор',
  'training.setup.option.minor': 'Минор',
  'training.setup.label.task': 'Задание',
  'training.setup.ariaLabel.taskMode': 'Режим задания',
  'training.setup.task.imitate': 'Повторить',
  'training.setup.task.find': 'Найти ноту самостоятельно',
  'training.setup.task.identify': 'Слушать и выбрать',
  'training.setup.taskHelp.imitate': 'Услышьте полный ответ, затем повторите его голосом.',
  'training.setup.taskHelp.find': 'Услышьте тональность или начальную ноту, затем найдите ответ самостоятельно.',
  'training.setup.taskHelp.identify': 'Услышьте вопрос и выберите ответ. Микрофон остаётся выключенным.',
  'training.setup.error.noMic': 'Микрофон недоступен. «Слушать и выбрать» всё равно работает как практика только на слух.',
  'training.setup.label.direction': 'Направление',
  'training.setup.ariaLabel.direction': 'Направление',
  'training.setup.legend.range': 'Ваш певческий диапазон',
  'training.setup.rangeHelp': 'Используйте сегодняшние удобные рабочие ноты, а не свой максимальный диапазон.',
  'training.setup.label.lowestNote': 'Самая низкая нота',
  'training.setup.label.highestNote': 'Самая высокая нота',
  'training.setup.legend.chordDegrees': 'Ступени аккорда',
  // checkbox label, e.g. "Scale degree 3"
  'training.setup.chordDegreeLabel': 'Ступень гаммы {n}',
  'training.setup.legend.practiceSettings': 'Общие настройки практики',
  'training.setup.label.notePlaybackVolume': 'Громкость воспроизведения ноты',
  'training.setup.testNote.playing': 'Играет C4…',
  'training.setup.testNote.idle': '▶ Проверить C4',
  'training.setup.ariaLabel.lowerVolume': 'Уменьшить эталонную громкость',
  'training.setup.ariaLabel.raiseVolume': 'Увеличить эталонную громкость',
  'training.setup.ariaLabel.notePlaybackVolume': 'Громкость воспроизведения ноты',
  'training.setup.help.volumeRange': '20–200% · сохраняется для каждого упражнения',
  'training.setup.label.pitchTolerance': 'Допуск по высоте тона',
  'training.setup.ariaLabel.pitchTolerance': 'Допуск по высоте тона',
  'training.setup.help.pitchTolerance': 'Удержитесь в этом допуске {seconds} секунд, чтобы перейти дальше.',
  'training.setup.error.chooseOne': 'Выберите хотя бы один пункт для этой сессии.',
  'training.setup.label.exercises': 'Упражнения',
  'training.setup.startPractice': 'Начать практику',
  // number of exercises in a session, e.g. "1 exercise" / "6 exercises"
  'training.exerciseCount_one': '{n} упражнение',
  'training.exerciseCount_few': '{n} упражнения',
  'training.exerciseCount_many': '{n} упражнений',
  'training.exerciseCount_other': '{n} упражнения',

  // ── in-session screen ──
  'training.nav.backToTraining': '← Тренировка',
  'training.session.aria.backToSong': 'Назад к песне',
  'training.session.aria.endSession': 'Завершить сессию',
  'training.session.aria.exerciseProgress': 'Упражнение {current} из {total}',
  'training.session.aria.targetNotes': 'Целевые ноты',
  'training.session.ready.paused': 'Практика на паузе. Продолжите, когда будете готовы.',
  'training.session.ready.preparing': 'Готовим ваше упражнение…',
  'training.session.readyAction.continue': 'Продолжить практику',
  'training.session.error.sessionInactive': 'Эта тренировочная сессия больше не активна.',
  'training.session.error.noMicUseListen': 'Микрофон недоступен. Используйте «Слушать и выбрать» для практики только на слух.',
  'training.session.error.micDisconnected': 'Микрофон отключился. Подключите его снова и начните это упражнение заново.',
  'training.session.identify.legend': 'Что вы услышали?',

  // ── cue / countdown instructions ──
  'training.cue.identify': 'Приготовьтесь. Слушайте и выбирайте, когда закончится отсчёт.',
  'training.cue.imitate': 'Приготовьтесь. Слушайте сейчас, затем спойте, когда закончится отсчёт.',
  'training.cue.find': 'Приготовьтесь. Запомните начальную ноту, затем спойте, когда закончится отсчёт.',

  // ── transport controls during a response ──
  'training.transport.ariaControls': 'Элементы управления практикой',
  'training.transport.aria.replay': 'Повторить целевую ноту',
  'training.transport.label.replay': 'Повторить',
  'training.transport.aria.listeningStatus': 'Микрофон слушает',
  'training.transport.listening': 'Слушаю',
  'training.transport.aria.skip': 'Пропустить эту ноту',
  'training.transport.label.skip': 'Пропустить',

  // ── pitch runway (live intonation feedback) ──
  'training.session.pitch.onTarget': 'Точно',
  'training.session.pitch.sharp': 'Выше',
  'training.session.pitch.flat': 'Ниже',
  'training.session.pitch.listening': 'Слушаю',
  // initial/reset state before any pitch has been read
  'training.session.guidance.listeningDefault': 'Слушаю ваш голос.',
  'training.session.runway.youAreSinging': 'Вы поёте',
  'training.session.runway.holdInstruction': 'Спойте ноту. Удержите в пределах ±{cents}¢ {seconds} секунд.',
  'training.session.runway.inTune': 'Чисто — продолжайте держать',
  'training.session.runway.lower': 'Чуть ниже',
  'training.session.runway.higher': 'Чуть выше',
  'training.session.runway.ariaHoldProgress': 'Прогресс удержания',

  // screen-reader only announcements of the live pitch, e.g. "Listening for
  // A4. No voice detected yet." — {target} is a note name, left untranslated
  'training.session.accessible.listeningFor': 'Слушаю {target}. Голос пока не обнаружен.',
  'training.session.accessible.voiceDetected': 'Голос обнаружен для {target}. Удержите высоту тона стабильной.',
  // {guidance} is training.session.pitch.onTarget/sharp/flat
  'training.session.accessible.pitchSteady': '{guidance} для {target}. Высота тона стабильна.',

  // ── errors surfaced while training audio/mic is starting ──
  'training.error.mic.blocked': 'Доступ к микрофону заблокирован. Разрешите SingZ в настройках приватности системы и попробуйте снова.',
  'training.error.mic.notFound': 'Микрофон не найден. Подключите его или используйте «Слушать и выбрать» для практики только на слух.',
  'training.error.mic.busy': 'Микрофон занят в другом приложении. Закройте это приложение и попробуйте снова.',
  'training.error.audio.startFailedWithMessage': 'Не удалось запустить звук тренировки: {message}',
  'training.error.audio.startFailedGeneric': 'Не удалось запустить звук тренировки. Проверьте аудиоустройства и попробуйте снова.',

  // ── session summary screen ──
  'training.summary.eyebrow': 'Сессия завершена',
  'training.summary.ariaMetrics': 'Метрики сессии',
  'training.summary.headingTemplate': '{landed} из {attempts} попаданий',
  'training.summary.noPitchMetrics': 'В этой сессии только на слух метрики высоты тона не использовались.',
  'training.summary.noSteadyNotes': 'В этой сессии не было обнаружено стабильных чистых нот.',
  'training.summary.stayedInTune': 'В среднем вы пели чисто.',
  // {word} is training.word.sharp/flat
  'training.summary.tended': 'В среднем вы пели {word}.',
  'training.summary.restart': 'Начать заново',
  'training.summary.backToTraining': 'Назад к тренировке',
  'training.summary.backToSong': 'Назад к песне',

  // ── empty state (no exercise ready) ──
  'training.empty.heading': 'Упражнение не готово',
  'training.empty.body': 'Сначала выберите фокус тренировки и удобный диапазон.',

  // ── per-attempt outcome labels (session summary outcomes list) ──
  'training.outcome.none': 'Нет результата',
  'training.outcome.skipped': 'Пропущено',
  'training.outcome.correct': 'Верно',
  'training.outcome.tryAgain': 'Попробуйте в следующий раз',
  'training.outcome.exerciseFallback': 'Упражнение {n}',
  'training.outcome.wrongNote': 'Неверная нота',
  'training.outcome.wrongOctave': 'Неверная октава',
  'training.outcome.otherChordTone': 'Другой тон аккорда',
  'training.outcome.nonChordTone': 'Не тон аккорда',
  'training.outcome.unstable': 'Нестабильно',
  'training.outcome.unvoiced': 'Голос не обнаружен',
  'training.outcome.outOfRange': 'Вне диапазона',

  // ── feedback shown right after an attempt ──
  'training.feedback.skipped.detail': 'Это упражнение не оценивалось.',
  'training.feedback.identifyCorrect.detail': 'Запомните этот звук перед следующим вопросом.',
  'training.feedback.identifyWrong.heading': 'Не в этот раз',
  'training.feedback.identifyWrong.detail': 'Прослушайте тональность и сравните ноты ещё раз.',
  'training.feedback.onTarget.detail': 'Высота тона отчётливо устоялась в центре.',
  'training.feedback.close.heading': 'Очень близко',
  'training.feedback.close.detail': 'Нужные ноты есть; сделайте их чуть точнее по центру.',
  'training.feedback.wrong.detail': 'Отпустите ноту, соберитесь и слушайте следующую подсказку.',

  // Longer per-classification headings used as feedback when a vocal attempt
  // misses ("wrong note", "unstable", …) — distinct from the short
  // training.outcome.* labels used in the summary's outcomes list.
  'training.classification.close': 'Близко — ещё один заход, и получится',
  'training.classification.wrongNote': 'Прозвучала другая нота',
  'training.classification.wrongOctave': 'Верное название ноты, другая октава',
  'training.classification.otherChordTone': 'Прозвучал другой тон аккорда',
  'training.classification.nonChordTone': 'Нота вышла за пределы аккорда',
  'training.classification.unstable': 'Высота тона пока не устоялась',
  'training.classification.unvoiced': 'Стабильный голос не обнаружен',
  'training.classification.outOfRange': 'Обнаруженная нота была вне выбранного диапазона',

  // ── "Listen and choose" prompt kind labels, before the answer is revealed ──
  'training.kindLabel.identifyNote': 'Слушайте и выберите ноту',
  'training.kindLabel.identifyNumber': 'Слушайте и выберите число',
  'training.kindLabel.identifyInterval': 'Слушайте и выберите интервал',
  'training.kindLabel.identifyChordNote': 'Слушайте и выберите тон аккорда',
  'training.kindLabel.identifyChord': 'Слушайте и выберите аккорд',

  // ── identify-mode answer reveal / detail text ──
  // {note} is a bare note name (untranslated), e.g. "Answer: A"
  'training.identify.answerNote': 'Ответ: {note}',
  'training.identify.answerScaleDegree': 'Ответ: ступень гаммы {n}',
  // {interval} is a lowercase interval word (training.word.*), {direction} likewise
  'training.identify.answerInterval': 'Ответ: {interval} {direction}',
  // {role} is training.word.root/third/fifth, {chord} is "{note} {quality}"
  'training.identify.answerChordTone': 'Ответ: {role} аккорда {chord}',
  'training.identify.answerArpeggio': 'Ответ: ступень {degree} — {chord}',
  // detail text under an identify answer choice, e.g. "Scale degree 3"
  'training.identify.scaleDegreeDetail': 'Ступень гаммы {n}',
  // arpeggio identify-answer label, e.g. "Degree 3"
  'training.identify.degreeLabel': 'Ступень {n}',
  // "{chord} arpeggio" — the word appended after a chord name
  'training.label.arpeggioOf': 'арпеджио {chord}',

  // ── generic single music-theory words, interpolated lowercase ──
  'training.word.major': 'мажор',
  'training.word.minor': 'минор',
  'training.word.diminished': 'уменьшённый',
  'training.word.augmented': 'увеличенный',
  'training.word.root': 'основной тон',
  'training.word.third': 'терция',
  'training.word.fifth': 'квинта',
  'training.word.ascending': 'вверх',
  'training.word.descending': 'вниз',
  'training.word.both': 'в обе стороны',
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
  'training.kind.scaleDegree': 'Ступень гаммы',
  'training.kind.interval': 'Интервал',
  'training.kind.chordTone': 'Тон аккорда',
  'training.kind.arpeggio': 'Арпеджио',

  // ── vocal training route (module load / error states) ──
  'training.route.eyebrow': 'Вокальная тренировка',
  'training.route.opening': 'Открываем практику…',
  'training.route.openingStatus': 'Открытие вокальной тренировки.',
  'training.route.failure.heading': 'Практика не открылась',
  'training.route.failure.body': 'Не удалось загрузить экран практики. Воспроизведение песни остаётся на паузе.',
  'training.route.retry': 'Повторить',
  'training.route.failure.recoveryFailed': 'Резервную копию тоже не удалось загрузить. Перезапустите SingZ, прежде чем пробовать снова.',
  'training.route.returnToSongs': 'Вернуться к песням',
  'training.route.runtimeFailure.heading': 'Практика остановлена',
  'training.route.runtimeFailure.stopping': 'Останавливаем звук упражнения и подтверждаем освобождение микрофона…',
  'training.route.runtimeFailure.unsafe':
    'Не удалось подтвердить остановку звука упражнения или микрофона. Повторите очистку и не закрывайте SingZ перед выходом из практики.',
  'training.route.runtimeFailure.safe':
    'Звук упражнения и захват с микрофона были остановлены, воспроизведение песни поставлено на паузу.',
  'training.route.retryCleanup': 'Повторить очистку',
  'training.route.cleanupGate.stoppingHeading': 'Завершаем очистку звука…',
  'training.route.cleanupGate.attentionHeading': 'Очистка звука требует внимания',
  'training.route.cleanupGate.stoppingBody':
    'Подтверждаем, что звук упражнения и микрофон остановились, перед выходом из практики.',
  'training.route.cleanupGate.attentionBody':
    'Микрофон или звук упражнения не подтвердили очистку. Останьтесь в вокальной тренировке и повторите попытку, прежде чем открывать другой аудиопуть.',

  // ── session generator (shared/training-session.ts instructions) ──
  'training.session.instruction.identifyNote': 'Определите ноту.',
  // {note} is a bare note name, untranslated
  'training.session.instruction.matchNote': 'Спойте {note}.',
  'training.session.instruction.identifyScaleDegree': 'Определите ступень гаммы.',
  'training.session.instruction.singScaleDegree': 'Спойте ступень гаммы {degree} — {note}.',
  'training.session.instruction.identifyInterval': 'Определите интервал.',
  // {interval} is prompt.intervalName (a music-theory term, untranslated)
  'training.session.instruction.singInterval': 'Интервал: {interval} {direction} — спойте от {from} до {to}.',
  'training.session.instruction.identifyChordTone': 'Определите тон аккорда.',
  'training.session.instruction.singChordTone': 'Спойте ноту аккорда {chord} ({role}) — {note}.',
  'training.session.instruction.identifyArpeggio': 'Определите арпеджированный аккорд.',
  'training.session.instruction.arpeggiate': 'Спойте арпеджио {chord} {direction}.',

  // ── session generator validation error reachable from normal setup ──
  'training.session.error.rangeTooNarrow': 'Ни одно из запрошенных упражнений не вписывается в удобный рабочий диапазон.',
  'training.session.error.confirmKeyThenReview': 'Подтвердите или измените тональность песни, затем просмотрите сессию подготовки.',
  'training.session.error.setUpSessionFirst': 'Настройте сессию, прежде чем начинать.',
  'training.session.error.exerciseNoLongerActive': 'Это упражнение больше не активно.',

  // ── audio/training-cleanup.ts: cross-feature audio-safety notices ──
  'training.cleanup.songBlocked':
    'Воспроизведение песни недоступно, пока вокальная тренировка не подтвердит, что её микрофон и звук упражнения остановлены. Повторите очистку в вокальной тренировке.',
  'training.cleanup.settingsBlocked':
    'Настройки звука недоступны, пока вокальная тренировка не подтвердит, что её микрофон и звук упражнения остановлены. Повторите очистку в вокальной тренировке.',
  'training.cleanup.audioBlocked':
    'Звук вокальной тренировки недоступен, пока не разрешена предыдущая очистка микрофона и звука упражнения. Повторите очистку, прежде чем продолжить.',
  // thrown as an Error message when cleanup fails with a non-Error cause;
  // surfaces wherever that error's .message is displayed
  'training.cleanup.couldNotConfirm': 'Не удалось подтвердить очистку звука тренировки.',

  // ── misc ──
  'training.error.couldNotOpenFile': 'Не удалось открыть этот файл.'
}
