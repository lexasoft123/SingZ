/* Русский — the `lyrics` strings, typed against English. */
import type { lyrics as en } from '../en/lyrics'
import type { Translation } from '../types'

export const lyrics: Translation<typeof en> = {
  // ── shared badges/suffixes (used by both the check-verdict text and the panel) ──
  // trailing badge appended when the check ran the precise (CTC) method, e.g. "…heard · precise"
  'lyrics.check.preciseSuffix': ' · точно',

  // ── lyrics-state.ts: a finished job with no words at all ──
  'lyrics.state.noWordsDetected': 'В вокале не удалось распознать слов.',

  // ── lyrics-edit.ts: describeCheck() — the align verdict line under the editor ──
  // shown when the lyrics text barely matches what was actually sung
  'lyrics.check.mismatchPrecise': 'В вокале расслышано только {pct}% этих слов — проверьте текст или попробуйте «Точно».',
  'lyrics.check.mismatchNoPrecise': 'В вокале расслышано только {pct}% этих слов — сравните текст с тем, что поётся.',
  'lyrics.check.wordsHeard': '{pct}% слов расслышано',
  'lyrics.check.everySnapped': 'все строки привязаны к пению',
  // shown when the singer sings more than these lyrics cover, but every line still snapped
  'lyrics.check.extraSungNote': 'все строки привязаны — хотя в песне есть части, не отражённые в этом тексте',
  'lyrics.check.badLines_one': '{n} строка не распознана и сохранила приблизительное время',
  'lyrics.check.badLines_few': '{n} строки не распознаны и сохранили приблизительное время',
  'lyrics.check.badLines_many': '{n} строк не распознаны и сохранили приблизительное время',
  'lyrics.check.badLines_other': '{n} строки не распознаны и сохранили приблизительное время',

  // ── LyricsPanel.tsx ──
  'lyrics.panel.title': 'Текст',
  'lyrics.panel.guide.titleOn': 'Заглушить оригинальный вокал',
  'lyrics.panel.guide.titleOff': 'Включить оригинальный вокал как подсказку',
  'lyrics.panel.guide.label': 'Вокал-подсказка',

  // stage labels while a lyrics job runs (search/download/transcribe)
  'lyrics.panel.stage.preparing': 'Подготовка',
  'lyrics.panel.stage.searching': 'Поиск текста в сети',
  'lyrics.panel.stage.downloadingModel': 'Загрузка речевой модели',
  'lyrics.panel.stage.transcribing': 'Прослушивание вокала',
  'lyrics.panel.stage.starting': 'Запуск',

  // the small badge naming where the current lyrics came from
  'lyrics.panel.source.synced': 'Синхронизировано',
  'lyrics.panel.source.edited': 'Изменено',
  'lyrics.panel.source.aiTranscribed': 'Распознано ИИ',
  // fallback credit text when there is no LRCLIB/edit credit string
  'lyrics.panel.credit.own': 'ваши слова',
  'lyrics.panel.credit.vocals': 'из вокальной дорожки',
  'lyrics.panel.credit.aiAligned': ' · выровнено ИИ',

  'lyrics.panel.checkAlign.title':
    'Прослушать вокал и сравнить текст с тем, что реально поётся, привязав время каждого слова к записи',
  'lyrics.panel.checkAlign.label': 'Проверить и выровнять',
  'lyrics.panel.precise.title': 'Пословное выравнивание многоязычной речевой моделью (самая точная синхронизация; разовая загрузка 1.2 GB)',
  'lyrics.panel.precise.label': 'Точно',
  'lyrics.panel.edit.title': 'Исправьте слова, отмечайте время строк во время воспроизведения и заново выравнивайте — ваши правки сохраняются',
  'lyrics.panel.edit.label': 'Редактировать',
  'lyrics.panel.change.label': 'Изменить…',

  // the verdict line shown under the lyrics once a check has run
  'lyrics.panel.check.mismatch':
    'Похоже, этот текст не совпадает с записью — расслышано только {pct}% слов. Попробуйте «Изменить…» или распознавание ИИ.',
  'lyrics.panel.check.match': 'Слова совпадают с записью · расслышано {pct}%',
  'lyrics.panel.check.retimed': 'Синхронизировано с записью · расслышано {pct}% слов',
  // "off" as in "the timing was N seconds off" — {sec} already has one decimal, e.g. "1.3"
  'lyrics.panel.check.timingOff': ' · время сместилось на {sec} с',
  'lyrics.panel.check.lineDiffers_one': ' · {n} строка отличается от того, что поётся',
  'lyrics.panel.check.lineDiffers_few': ' · {n} строки отличаются от того, что поётся',
  'lyrics.panel.check.lineDiffers_many': ' · {n} строк отличаются от того, что поётся',
  'lyrics.panel.check.lineDiffers_other': ' · {n} строки отличаются от того, что поётся',
  'lyrics.panel.check.missingWords': ' · в песне есть части, не отражённые в этом тексте',

  'lyrics.panel.variants.back': '‹ Назад',
  'lyrics.panel.variants.aiTranscribeTitle':
    'Прослушать вокал с Qwen3-ASR и распознать текст прямо из записи',
  'lyrics.panel.variants.aiTranscribeLabel': '✦ Распознавание ИИ',
  'lyrics.panel.variants.searchPlaceholder': 'исполнитель или название песни…',
  'lyrics.panel.variants.searchLabel': 'Поиск',
  'lyrics.panel.variants.nothingFound': 'Ничего не найдено — попробуйте другие слова.',
  'lyrics.panel.variants.matches': ' · совпадает',
  'lyrics.panel.variants.synced': ' · синхронизировано',
  'lyrics.panel.variants.textOnly': ' · только текст',

  // consent card before downloading the speech / word-aligner model
  'lyrics.panel.consent.alignerText': 'Точное выравнивание слушает вокал с помощью **многоязычного выравнивателя слов** (Meta MMS) и привязывает каждое слово к моменту, когда оно поётся, — полностью на вашем компьютере, через модуль разделения дорожек.',
  'lyrics.panel.consent.qwenText':
    'SingZ слушает вокал с помощью **Qwen3-ASR** — речевой модели, обученной на пении и работающей полностью на вашем компьютере, — чтобы распознать текст, если его нет в сети, и проверить и выровнять тот, что есть.',
  'lyrics.panel.consent.fineprint':
    'Разовая загрузка примерно {mb} MB, хранится локально и используется для каждой песни. Также доступно позже в менеджере моделей.',
  'lyrics.panel.consent.downloadAlignLabel': 'Загрузить и точно выровнять',
  'lyrics.panel.consent.downloadContinueLabel': 'Загрузить модель и продолжить',
  'lyrics.panel.consent.searchManually': 'Или найти текст в базе вручную',

  'lyrics.panel.loading.cancel': 'Отмена',

  'lyrics.panel.error.tryAgain': 'Повторить',
  'lyrics.panel.error.searchManually': 'Найти текст в базе вручную',
  'lyrics.panel.error.writeYourself': 'Или написать текст самостоятельно',

  'lyrics.panel.lines.jumpHere': 'Перейти сюда',
  // fine print under AI-transcribed lyrics, followed by a "Fix the words" button — one sentence, two keys
  'lyrics.panel.whisperNote.text': 'Распознано ИИ из вокала — не всегда точно.',
  'lyrics.panel.whisperNote.fix': 'Исправить слова',

  // ── LyricsEditor.tsx ──
  'lyrics.editor.title': 'Редактировать текст',
  'lyrics.editor.unsavedChanges': 'Несохранённые изменения',
  'lyrics.editor.play': 'Воспроизвести',
  'lyrics.editor.pause': 'Пауза',
  'lyrics.editor.helpTitle': 'Как пользоваться редактором',
  'lyrics.editor.cancel': 'Отмена',
  'lyrics.editor.undo': 'Отменить',
  'lyrics.editor.replaceAll': 'Заменить всё…',

  'lyrics.editor.tools.alignTitle':
    'Сопоставить слова с записью и привязать строки и слова к моменту, когда они поются — мгновенно, если распознавание уже есть на диске, иначе сначала прослушивается песня',
  'lyrics.editor.tools.alignLabel': '✦ Выровнять по пению',
  'lyrics.editor.tools.preciseTitle':
    'Привязать каждое слово к точному моменту, когда оно поётся, с помощью многоязычного выравнивателя слов (разовая загрузка модели)',
  'lyrics.editor.tools.preciseLabel': 'Точно',
  'lyrics.editor.tools.replaceTitle':
    'Заменить весь текст из буфера обмена или заметок — оставшиеся строки сохранят своё время',
  'lyrics.editor.tools.silentTitle':
    'Эти строки приходятся на части песни, где никто не поёт — почти всегда это артефакты распознавания',
  // "⌫ N line(s) with no singing" chip — ⌫ is the delete glyph, kept as-is
  'lyrics.editor.tools.silentLines_one': '⌫ {n} строка без пения',
  'lyrics.editor.tools.silentLines_few': '⌫ {n} строки без пения',
  'lyrics.editor.tools.silentLines_many': '⌫ {n} строк без пения',
  'lyrics.editor.tools.silentLines_other': '⌫ {n} строки без пения',

  'lyrics.editor.replace.placeholder': 'Одна строка текста на строку —\nвставьте сюда всю песню',
  'lyrics.editor.replace.use': 'Использовать этот текст',

  'lyrics.editor.row.stampTitleUntimed': 'Ещё не привязано — нажмите, чтобы отметить здесь время воспроизведения ({mod} во время набора текста)',
  'lyrics.editor.row.stampTitleTimed': 'Играть с этой строки',
  'lyrics.editor.row.printTitleUntimed': 'Сначала привяжите время к этой строке (отметьте её или выровняйте), затем настройте каждое слово',
  'lyrics.editor.row.printTitleTimed': 'Точная настройка времени каждого слова',
  'lyrics.editor.row.placeholder': 'Введите или вставьте текст…',
  'lyrics.editor.row.addTitle': 'Добавить новую строку после этой',
  'lyrics.editor.row.removeTitle': 'Удалить эту строку',

  'lyrics.editor.wordstrip.title': 'Перетащите, чтобы сдвинуть слово · двойной клик ставит его на позицию воспроизведения · ←/→ сдвиг на 50 ms',

  // stage labels shown in the editor's own status line (distinct wording from the panel's)
  'lyrics.editor.stage.preparing': 'Подготовка',
  'lyrics.editor.stage.searching': 'Поиск',
  'lyrics.editor.stage.downloadingModel': 'Загрузка модели',
  'lyrics.editor.stage.transcribing': 'Прослушивание вокала',

  'lyrics.editor.consent.aligner': 'Для точного выравнивания нужна модель выравнивания слов — разовая загрузка {mb} MB.',
  'lyrics.editor.consent.speech': 'Для определения времени слов нужна речевая модель — разовая загрузка {mb} MB.',
  'lyrics.editor.consent.download': 'Загрузить и выровнять',
  'lyrics.editor.consent.notNow': 'Не сейчас',

  // the default hint line: "Enter splits a line · {mod} stamps..." plus one of two tails
  'lyrics.editor.hint.base': 'Enter разбивает строку · {mod} отмечает время воспроизведения на строке, которую вы редактируете',
  'lyrics.editor.hint.untimed_one': ' · {n} строка ещё без времени — «Выровнять» сделает это сразу для всех',
  'lyrics.editor.hint.untimed_few': ' · {n} строки ещё без времени — «Выровнять» сделает это сразу для всех',
  'lyrics.editor.hint.untimed_many': ' · {n} строк ещё без времени — «Выровнять» сделает это сразу для всех',
  'lyrics.editor.hint.untimed_other': ' · {n} строки ещё без времени — «Выровнять» сделает это сразу для всех',
  'lyrics.editor.hint.voiceprint': ' · звуковой отпечаток строки открывает пословную синхронизацию',

  'lyrics.editor.discard.question': 'Отменить изменения?',
  'lyrics.editor.discard.keep': 'Продолжить редактирование',
  'lyrics.editor.discard.discard': 'Отбросить',
  'lyrics.editor.footer.cancelBusyTitle': 'Выравнивание уже выполняется — сначала отмените его',

  'lyrics.editor.save.saving': 'Сохранение…',
  'lyrics.editor.save.label': 'Сохранить текст',

  'lyrics.editor.help.gotIt': 'Понятно',
  'lyrics.editor.help.sectionLines': 'Строки',
  'lyrics.editor.help.sectionTiming': 'Время',
  'lyrics.editor.help.sectionWords': 'Слова',
  'lyrics.editor.help.sectionOther': 'Всё остальное',

  'lyrics.editor.help.lineNew': 'Новая строка — разбивает текст в месте курсора',
  'lyrics.editor.help.lineAdd': 'Добавить пустую строку после этой — для целого пропущенного раздела',
  'lyrics.editor.help.lineMerge': 'В начале строки объединяет её со строкой выше',
  'lyrics.editor.help.lineRemove': 'Удалить текущую строку',
  'lyrics.editor.help.lineMove': 'Переход между строками',
  'lyrics.editor.help.linePaste': 'Несколько строк текста превращаются в отдельные строки',
  'lyrics.editor.help.labelPaste': 'Вставка',

  'lyrics.editor.help.timingStamp': 'Отметить время воспроизведения на строке, которую вы редактируете',
  'lyrics.editor.help.timingChip': 'Играть с этой строки — или отметить время, если его ещё нет',
  'lyrics.editor.help.labelTimeChip': 'Метка времени',
  'lyrics.editor.help.timingAlign': 'Привязать время всех строк и слов к пению сразу',
  'lyrics.editor.help.labelAlign': '✦ Выровнять',

  // {mod} is the platform's modifier key glyph (⌘ or Ctrl), kept untranslated
  'lyrics.editor.help.wordsVoiceprint': 'Нажмите на звуковой отпечаток строки (или {mod} E в ней) для пословной синхронизации',
  'lyrics.editor.help.labelVoiceprint': 'Отпечаток',
  'lyrics.editor.help.wordsDrag': 'Переместить слово — соседние слова ограничивают его',
  'lyrics.editor.help.labelDrag': 'Перетаскивание',
  'lyrics.editor.help.wordsDoubleClick': 'Поставить слово точно на позицию воспроизведения',
  'lyrics.editor.help.labelDoubleClick': 'Двойной клик',
  'lyrics.editor.help.wordsNudge': 'Сдвинуть выбранное слово на 50 ms',

  'lyrics.editor.help.otherUndo': 'Отменить — добавьте Shift для повтора',
  'lyrics.editor.help.otherReplace': 'Вставить всю песню; сохранённые строки сохраняют время',
  'lyrics.editor.help.otherClose': 'Закрыть редактор (сначала спросит о несохранённых изменениях)'
}
