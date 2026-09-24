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
  'lyrics.check.wordsHeard': '{pct}% слов услышано',
  'lyrics.check.everySnapped': 'все строки привязаны к пению',
  // shown when the singer sings more than these lyrics cover, but every line still snapped
  'lyrics.check.extraSungNote': 'все строки привязаны — но в песне есть части без текста',
  'lyrics.check.badLines_one': '{n} строка не распознана, время оставлено примерным',
  'lyrics.check.badLines_few': '{n} строки не распознаны, время оставлено примерным',
  'lyrics.check.badLines_many': '{n} строк не распознано, время оставлено примерным',
  'lyrics.check.badLines_other': '{n} строки не распознаны, время оставлено примерным',

  // ── LyricsPanel.tsx ──
  'lyrics.panel.title': 'Текст',
  'lyrics.panel.guide.titleOn': 'Заглушить вокал',
  'lyrics.panel.guide.titleOff': 'Вокал как подсказка',
  'lyrics.panel.guide.label': 'Подсказка',

  // stage labels while a lyrics job runs (search/download/transcribe)
  'lyrics.panel.stage.preparing': 'Подготовка',
  'lyrics.panel.stage.searching': 'Поиск текста в сети',
  'lyrics.panel.stage.downloadingModel': 'Загрузка речевой модели',
  'lyrics.panel.stage.transcribing': 'Прослушивание вокала',
  'lyrics.panel.stage.starting': 'Запуск',

  // the small badge naming where the current lyrics came from
  'lyrics.panel.source.synced': 'Синхрон',
  'lyrics.panel.source.edited': 'Правка',
  'lyrics.panel.source.aiTranscribed': 'Распознано ИИ',
  // fallback credit text when there is no LRCLIB/edit credit string
  'lyrics.panel.credit.own': 'ваши слова',
  'lyrics.panel.credit.vocals': 'из вокальной дорожки',
  'lyrics.panel.credit.aiAligned': ' · с ИИ',

  'lyrics.panel.checkAlign.title':
    'Прослушать вокал и сравнить текст с тем, что реально поётся, привязав время каждого слова к записи',
  'lyrics.panel.checkAlign.label': 'Сверить и выровнять',
  'lyrics.panel.precise.title': 'Пословное выравнивание многоязычной речевой моделью (самая точная синхронизация; разовая загрузка 1.2 GB)',
  'lyrics.panel.precise.label': 'Точно',
  'lyrics.panel.edit.title': 'Исправляйте слова, отмечайте время строк и заново выравнивайте — правки сохраняются',
  'lyrics.panel.edit.label': 'Правка',
  'lyrics.panel.change.label': 'Изменить…',

  // the verdict line shown under the lyrics once a check has run
  'lyrics.panel.check.mismatch':
    'Похоже, этот текст не совпадает с записью — расслышано только {pct}% слов. Попробуйте «Изменить…» или распознавание ИИ.',
  'lyrics.panel.check.match': 'Слова совпали с записью · слышно {pct}%',
  'lyrics.panel.check.retimed': 'Синхронизировано с записью · слышно {pct}% слов',
  // "off" as in "the timing was N seconds off" — {sec} already has one decimal, e.g. "1.3"
  'lyrics.panel.check.timingOff': ' · сдвиг на {sec} с',
  'lyrics.panel.check.lineDiffers_one': ' · {n} строка не совпадает с записью',
  'lyrics.panel.check.lineDiffers_few': ' · {n} строки не совпадают с записью',
  'lyrics.panel.check.lineDiffers_many': ' · {n} строк не совпадают с записью',
  'lyrics.panel.check.lineDiffers_other': ' · {n} строки не совпадают с записью',
  'lyrics.panel.check.missingWords': ' · в песне есть части без этого текста',

  'lyrics.panel.variants.back': '‹Назад',
  'lyrics.panel.variants.aiTranscribeTitle':
    'Прослушать вокал с Qwen3-ASR и распознать текст прямо из записи',
  'lyrics.panel.variants.aiTranscribeLabel': '✦ Распознавание ИИ',
  'lyrics.panel.variants.searchPlaceholder': 'автор или песня…',
  'lyrics.panel.variants.searchLabel': 'Поиск',
  'lyrics.panel.variants.nothingFound': 'Не найдено — попробуйте иначе.',
  'lyrics.panel.variants.matches': ' · совпало',
  'lyrics.panel.variants.synced': ' · синхро',
  'lyrics.panel.variants.textOnly': ' · текст',

  // consent card before downloading the speech / word-aligner model
  'lyrics.panel.consent.alignerText': 'Точное выравнивание слушает вокал **многоязычным выравнивателем слов** (Meta MMS) и привязывает слово к моменту пения — на вашем компьютере, через разделитель дорожек.',
  'lyrics.panel.consent.qwenText':
    'SingZ слушает вокал моделью **Qwen3-ASR**, обученной на пении и работающей прямо на вашем компьютере, — чтобы распознать текст, если его нет в сети, и проверить и выровнять тот, что есть.',
  'lyrics.panel.consent.fineprint':
    'Разовая загрузка ~{mb} MB, хранится локально и используется для каждой песни. Доступно и позже, в менеджере моделей.',
  'lyrics.panel.consent.downloadAlignLabel': 'Загрузить, выровнять точно',
  'lyrics.panel.consent.downloadContinueLabel': 'Загрузить и продолжить',
  'lyrics.panel.consent.searchManually': 'Или найти текст в базе вручную',

  'lyrics.panel.loading.cancel': 'Отмена',

  'lyrics.panel.error.tryAgain': 'Повторить',
  'lyrics.panel.error.searchManually': 'Найти текст в базе вручную',
  'lyrics.panel.error.writeYourself': 'Или напишите текст сами',

  'lyrics.panel.lines.jumpHere': 'Перейти',
  // fine print under AI-transcribed lyrics, followed by a "Fix the words" button — one sentence, two keys
  'lyrics.panel.whisperNote.text': 'Распознано ИИ из вокала — не всегда точно.',
  'lyrics.panel.whisperNote.fix': 'Править слова',

  // ── LyricsEditor.tsx ──
  'lyrics.editor.title': 'Правка слов',
  'lyrics.editor.unsavedChanges': 'Есть изменения',
  'lyrics.editor.play': 'Пуск',
  'lyrics.editor.pause': 'Пауза',
  'lyrics.editor.helpTitle': 'Как работает редактор',
  'lyrics.editor.cancel': 'Отмена',
  'lyrics.editor.undo': 'Отменить',
  'lyrics.editor.replaceAll': 'Заменить всё',

  'lyrics.editor.tools.alignTitle':
    'Сопоставить слова с записью и привязать строки и слова к моменту, когда они поются — мгновенно, если распознавание уже есть на диске, иначе сначала прослушивается песня',
  'lyrics.editor.tools.alignLabel': '✦ Выровнять по пению',
  'lyrics.editor.tools.preciseTitle':
    'Привязать каждое слово к моменту, когда оно поётся, многоязычным выравнивателем (разовая загрузка модели)',
  'lyrics.editor.tools.preciseLabel': 'Точно',
  'lyrics.editor.tools.replaceTitle':
    'Заменить весь текст из буфера обмена или заметок — оставшиеся строки сохранят своё время',
  'lyrics.editor.tools.silentTitle':
    'Эти строки приходятся на части песни, где никто не поёт — почти всегда артефакты распознавания',
  // "⌫ N line(s) with no singing" chip — ⌫ is the delete glyph, kept as-is
  'lyrics.editor.tools.silentLines_one': '⌫ {n} строка без пения',
  'lyrics.editor.tools.silentLines_few': '⌫ {n} строки без пения',
  'lyrics.editor.tools.silentLines_many': '⌫ {n} строк без пения',
  'lyrics.editor.tools.silentLines_other': '⌫ {n} строки без пения',

  'lyrics.editor.replace.placeholder': 'По строке в строку —\nвставьте всю песню',
  'lyrics.editor.replace.use': 'Применить текст',

  'lyrics.editor.row.stampTitleUntimed': 'Ещё без времени — нажмите, чтобы отметить его тут ({mod} во время набора)',
  'lyrics.editor.row.stampTitleTimed': 'Играть отсюда',
  'lyrics.editor.row.printTitleUntimed': 'Сначала привяжите время (меткой или «Выровнять»), потом слова',
  'lyrics.editor.row.printTitleTimed': 'Настройка времени слов',
  'lyrics.editor.row.placeholder': 'Введите или вставьте',
  'lyrics.editor.row.addTitle': 'Добавить строку после этой',
  'lyrics.editor.row.removeTitle': 'Удалить строку',

  'lyrics.editor.wordstrip.title': 'Перетащите слово · двойной клик ставит на позицию плеера · ←/→ на 50 ms',

  // stage labels shown in the editor's own status line (distinct wording from the panel's)
  'lyrics.editor.stage.preparing': 'Подготовка',
  'lyrics.editor.stage.searching': 'Поиск',
  'lyrics.editor.stage.downloadingModel': 'Загрузка модели',
  'lyrics.editor.stage.transcribing': 'Прослушивание вокала',

  'lyrics.editor.consent.aligner': 'Для точного выравнивания нужна модель выравнивания слов — загрузка {mb} MB.',
  'lyrics.editor.consent.speech': 'Для времени слов нужна речевая модель — разовая загрузка {mb} MB.',
  'lyrics.editor.consent.download': 'Скачать и выровнять',
  'lyrics.editor.consent.notNow': 'Позже',

  // the default hint line: "Enter splits a line · {mod} stamps..." plus one of two tails
  'lyrics.editor.hint.base': 'Enter разбивает строку · {mod} отмечает время на строке, которую вы редактируете',
  'lyrics.editor.hint.untimed_one': ' · {n} строка без времени — «Выровнять» сделает всё сразу',
  'lyrics.editor.hint.untimed_few': ' · {n} строки без времени — «Выровнять» сделает всё сразу',
  'lyrics.editor.hint.untimed_many': ' · {n} строк без времени — «Выровнять» сделает всё сразу',
  'lyrics.editor.hint.untimed_other': ' · {n} строки без времени — «Выровнять» сделает всё сразу',
  'lyrics.editor.hint.voiceprint': ' · отпечаток строки — пословная синхронизация',

  'lyrics.editor.discard.question': 'Отменить изменения?',
  'lyrics.editor.discard.keep': 'Остаться',
  'lyrics.editor.discard.discard': 'Сброс',
  'lyrics.editor.footer.cancelBusyTitle': 'Выравнивание идёт — сначала отмените его',

  'lyrics.editor.save.saving': 'Сохраняю…',
  'lyrics.editor.save.label': 'Сохранить',

  'lyrics.editor.help.gotIt': 'Ясно',
  'lyrics.editor.help.sectionLines': 'Строки',
  'lyrics.editor.help.sectionTiming': 'Время',
  'lyrics.editor.help.sectionWords': 'Слова',
  'lyrics.editor.help.sectionOther': 'Всё остальное',

  'lyrics.editor.help.lineNew': 'Новая строка — разбивает текст у курсора',
  'lyrics.editor.help.lineAdd': 'Пустая строка после этой — для пропущенного раздела',
  'lyrics.editor.help.lineMerge': 'В начале строки объединяет её со строкой выше',
  'lyrics.editor.help.lineRemove': 'Удалить текущую строку',
  'lyrics.editor.help.lineMove': 'Переход по строкам',
  'lyrics.editor.help.linePaste': 'Строки текста становятся строками',
  'lyrics.editor.help.labelPaste': 'Вклей',

  'lyrics.editor.help.timingStamp': 'Отметить время на строке, которую вы редактируете',
  'lyrics.editor.help.timingChip': 'Играть с этой строки — или отметить время, если его нет',
  'lyrics.editor.help.labelTimeChip': 'Метка',
  'lyrics.editor.help.timingAlign': 'Привязать время всех строк и слов к пению сразу',
  'lyrics.editor.help.labelAlign': '✦ Выровнять',

  // {mod} is the platform's modifier key glyph (⌘ or Ctrl), kept untranslated
  'lyrics.editor.help.wordsVoiceprint': 'Нажмите на отпечаток строки (или {mod} E) для пословной синхронизации',
  'lyrics.editor.help.labelVoiceprint': 'Отпечаток',
  'lyrics.editor.help.wordsDrag': 'Передвинуть слово — соседи его ограничат',
  'lyrics.editor.help.labelDrag': 'Тянуть',
  'lyrics.editor.help.wordsDoubleClick': 'Поставить слово на позицию плеера',
  'lyrics.editor.help.labelDoubleClick': 'Двойной клик',
  'lyrics.editor.help.wordsNudge': 'Сдвинуть слово на 50 ms',

  'lyrics.editor.help.otherUndo': 'Отменить, Shift — повтор',
  'lyrics.editor.help.otherReplace': 'Вставить песню; сохранённые строки хранят время',
  'lyrics.editor.help.otherClose': 'Закрыть редактор (спросит про изменения)'
}
