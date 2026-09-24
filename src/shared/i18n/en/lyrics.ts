/* English strings for the `lyrics` namespace — see ../index.ts. */
export const lyrics = {
  // ── shared badges/suffixes (used by both the check-verdict text and the panel) ──
  // trailing badge appended when the check ran the precise (CTC) method, e.g. "…heard · precise"
  'lyrics.check.preciseSuffix': ' · precise',

  // ── lyrics-state.ts: a finished job with no words at all ──
  'lyrics.state.noWordsDetected': 'No words were detected in the vocals.',

  // ── lyrics-edit.ts: describeCheck() — the align verdict line under the editor ──
  // shown when the lyrics text barely matches what was actually sung
  'lyrics.check.mismatchPrecise': 'Only {pct}% of these words were heard in the vocals — check the text, or try Precise.',
  'lyrics.check.mismatchNoPrecise': "Only {pct}% of these words were heard in the vocals — check the text against what's sung.",
  'lyrics.check.wordsHeard': '{pct}% of words heard',
  'lyrics.check.everySnapped': 'every line snapped to the singing',
  // shown when the singer sings more than these lyrics cover, but every line still snapped
  'lyrics.check.extraSungNote': "every line snapped — though the singer has parts these lyrics don't cover",
  'lyrics.check.badLines_one': "{n} line couldn't be made out and kept estimated timing",
  'lyrics.check.badLines_other': "{n} lines couldn't be made out and kept estimated timing",

  // ── LyricsPanel.tsx ──
  'lyrics.panel.title': 'Lyrics',
  'lyrics.panel.guide.titleOn': 'Mute the original vocals',
  'lyrics.panel.guide.titleOff': 'Play the original vocals as a guide',
  'lyrics.panel.guide.label': 'Guide vocals',

  // stage labels while a lyrics job runs (search/download/transcribe)
  'lyrics.panel.stage.preparing': 'Warming up',
  'lyrics.panel.stage.searching': 'Searching online lyrics',
  'lyrics.panel.stage.downloadingModel': 'Downloading speech model',
  'lyrics.panel.stage.transcribing': 'Listening to the vocals',
  'lyrics.panel.stage.starting': 'Starting',

  // the small badge naming where the current lyrics came from
  'lyrics.panel.source.synced': 'Synced',
  'lyrics.panel.source.edited': 'Edited',
  'lyrics.panel.source.aiTranscribed': 'AI transcribed',
  // fallback credit text when there is no LRCLIB/edit credit string
  'lyrics.panel.credit.own': 'your own words',
  'lyrics.panel.credit.vocals': 'from the vocals stem',
  'lyrics.panel.credit.aiAligned': ' · AI-aligned',

  'lyrics.panel.checkAlign.title':
    "Listen to the vocals and check these lyrics against what is actually sung, snapping every word's timing to the recording",
  'lyrics.panel.checkAlign.label': 'Check & align',
  'lyrics.panel.precise.title':
    'Word-by-word forced alignment with the multilingual speech model (sharpest timing; one-time 1.2 GB download)',
  'lyrics.panel.precise.label': 'Precise',
  'lyrics.panel.edit.title': "Fix the words, stamp line times while the song plays, and re-align — your edits stick",
  'lyrics.panel.edit.label': 'Edit',
  'lyrics.panel.change.label': 'Change…',

  // the verdict line shown under the lyrics once a check has run
  'lyrics.panel.check.mismatch':
    "These lyrics don't seem to match this recording — only {pct}% of the words were heard. Try Change… or AI transcription.",
  'lyrics.panel.check.match': 'Words match the recording · {pct}% heard',
  'lyrics.panel.check.retimed': 'Re-timed to the recording · {pct}% of words heard',
  // "off" as in "the timing was N seconds off" — {sec} already has one decimal, e.g. "1.3"
  'lyrics.panel.check.timingOff': ' · timing was {sec}s off',
  'lyrics.panel.check.lineDiffers_one': " · {n} line differs from what's sung",
  'lyrics.panel.check.lineDiffers_other': " · {n} lines differ from what's sung",
  'lyrics.panel.check.missingWords': ' · the singer has parts these lyrics are missing',

  'lyrics.panel.variants.back': '‹ Back',
  'lyrics.panel.variants.aiTranscribeTitle':
    'Listen to the vocals with Qwen3-ASR and transcribe the lyrics from the recording itself',
  'lyrics.panel.variants.aiTranscribeLabel': '✦ AI transcription',
  'lyrics.panel.variants.searchPlaceholder': 'artist or song title…',
  'lyrics.panel.variants.searchLabel': 'Search',
  'lyrics.panel.variants.nothingFound': 'Nothing found — try other words.',
  'lyrics.panel.variants.matches': ' · matches',
  'lyrics.panel.variants.synced': ' · synced',
  'lyrics.panel.variants.textOnly': ' · text only',

  // consent card before downloading the speech / word-aligner model
  'lyrics.panel.consent.alignerText':
    'Precise alignment listens with a **multilingual word aligner** (Meta MMS) and pins every word to the exact moment it is sung — entirely on your machine, through the stem splitter.',
  'lyrics.panel.consent.qwenText':
    'SingZ listens to the vocals with **Qwen3-ASR**, a speech model trained on singing, running entirely on your machine — to transcribe lyrics when none are online, and to check & align the ones that are.',
  'lyrics.panel.consent.fineprint':
    'One-time download of about {mb} MB, stored locally and reused for every song. Also available later in the model manager.',
  'lyrics.panel.consent.downloadAlignLabel': 'Download & align precisely',
  'lyrics.panel.consent.downloadContinueLabel': 'Download model & continue',
  'lyrics.panel.consent.searchManually': 'Or search the lyrics database manually',

  'lyrics.panel.loading.cancel': 'Cancel',

  'lyrics.panel.error.tryAgain': 'Try again',
  'lyrics.panel.error.searchManually': 'Search the lyrics database manually',
  'lyrics.panel.error.writeYourself': 'Or write the lyrics yourself',

  'lyrics.panel.lines.jumpHere': 'Jump here',
  // fine print under AI-transcribed lyrics, followed by a "Fix the words" button — one sentence, two keys
  'lyrics.panel.whisperNote.text': 'AI-transcribed from the vocals — not always perfect.',
  'lyrics.panel.whisperNote.fix': 'Fix the words',

  // ── LyricsEditor.tsx ──
  'lyrics.editor.title': 'Edit lyrics',
  'lyrics.editor.unsavedChanges': 'Unsaved changes',
  'lyrics.editor.play': 'Play',
  'lyrics.editor.pause': 'Pause',
  'lyrics.editor.helpTitle': 'How to use the editor',
  'lyrics.editor.cancel': 'Cancel',
  'lyrics.editor.undo': 'Undo',
  'lyrics.editor.replaceAll': 'Replace all…',

  'lyrics.editor.tools.alignTitle':
    'Match the words to the recording and snap lines and words to when they are sung — instant when a transcription is already on disk, otherwise the song is listened to first',
  'lyrics.editor.tools.alignLabel': '✦ Align to the singing',
  'lyrics.editor.tools.preciseTitle':
    'Pin every word to the exact moment it is sung, with the multilingual word aligner (a one-time model download)',
  'lyrics.editor.tools.preciseLabel': 'Precise',
  'lyrics.editor.tools.replaceTitle':
    "Swap in the full lyrics from your clipboard or notes — lines that stay keep their timing",
  'lyrics.editor.tools.silentTitle':
    'These lines sit over parts of the song where nobody sings — almost always transcription artifacts',
  // "⌫ N line(s) with no singing" chip — ⌫ is the delete glyph, kept as-is
  'lyrics.editor.tools.silentLines_one': '⌫ {n} line with no singing',
  'lyrics.editor.tools.silentLines_other': '⌫ {n} lines with no singing',

  'lyrics.editor.replace.placeholder': 'One line per row —\npaste the whole song here',
  'lyrics.editor.replace.use': 'Use these lyrics',

  'lyrics.editor.row.stampTitleUntimed': 'Not timed yet — press to stamp the playhead time here ({mod} while typing)',
  'lyrics.editor.row.stampTitleTimed': 'Play from this line',
  'lyrics.editor.row.printTitleUntimed': 'Time this line first (stamp it or Align), then fine-tune each word',
  'lyrics.editor.row.printTitleTimed': "Fine-tune each word's timing",
  'lyrics.editor.row.placeholder': 'Type or paste the lyrics…',
  'lyrics.editor.row.addTitle': 'Add a new line after this one',
  'lyrics.editor.row.removeTitle': 'Remove this line',

  'lyrics.editor.wordstrip.title': 'Drag to move this word · double-click sets it at the playhead · ←/→ nudge 50 ms',

  // stage labels shown in the editor's own status line (distinct wording from the panel's)
  'lyrics.editor.stage.preparing': 'Warming up',
  'lyrics.editor.stage.searching': 'Searching',
  'lyrics.editor.stage.downloadingModel': 'Downloading model',
  'lyrics.editor.stage.transcribing': 'Listening to the vocals',

  'lyrics.editor.consent.aligner': 'Precise alignment needs the word-aligner model — a one-time {mb} MB download.',
  'lyrics.editor.consent.speech': 'Timing the words needs the speech model — a one-time {mb} MB download.',
  'lyrics.editor.consent.download': 'Download & align',
  'lyrics.editor.consent.notNow': 'Not now',

  // the default hint line: "Enter splits a line · {mod} stamps..." plus one of two tails
  'lyrics.editor.hint.base': "Enter splits a line · {mod} stamps the playhead time on the line you're typing in",
  'lyrics.editor.hint.untimed_one': ' · {n} line has no time yet — Align does them all at once',
  'lyrics.editor.hint.untimed_other': ' · {n} lines have no time yet — Align does them all at once',
  'lyrics.editor.hint.voiceprint': " · a line's voiceprint opens word-by-word timing",

  'lyrics.editor.discard.question': 'Discard your edits?',
  'lyrics.editor.discard.keep': 'Keep editing',
  'lyrics.editor.discard.discard': 'Discard',
  'lyrics.editor.footer.cancelBusyTitle': 'An alignment is running — cancel it first',

  'lyrics.editor.save.saving': 'Saving…',
  'lyrics.editor.save.label': 'Save lyrics',

  'lyrics.editor.help.gotIt': 'Got it',
  'lyrics.editor.help.sectionLines': 'Lines',
  'lyrics.editor.help.sectionTiming': 'Timing',
  'lyrics.editor.help.sectionWords': 'Words',
  'lyrics.editor.help.sectionOther': 'Everything else',

  'lyrics.editor.help.lineNew': 'New line — splits the text at the cursor',
  'lyrics.editor.help.lineAdd': 'Add an empty line after this one — for a whole missing section',
  'lyrics.editor.help.lineMerge': "At a line's start, merges into the line above",
  'lyrics.editor.help.lineRemove': "Remove the line you're in",
  'lyrics.editor.help.lineMove': 'Move between lines',
  'lyrics.editor.help.linePaste': 'Several lines of text become rows',
  'lyrics.editor.help.labelPaste': 'Paste',

  'lyrics.editor.help.timingStamp': "Stamp the playhead time on the line you're typing in",
  'lyrics.editor.help.timingChip': 'Play from that line — or stamp it, while it has no time',
  'lyrics.editor.help.labelTimeChip': 'Time chip',
  'lyrics.editor.help.timingAlign': 'Time every line and word against the singing at once',
  'lyrics.editor.help.labelAlign': '✦ Align',

  // {mod} is the platform's modifier key glyph (⌘ or Ctrl), kept untranslated
  'lyrics.editor.help.wordsVoiceprint': "Click a line's voiceprint (or press {mod} E in it) for word-by-word timing",
  'lyrics.editor.help.labelVoiceprint': 'Voiceprint',
  'lyrics.editor.help.wordsDrag': 'Move a word — its neighbours fence it in',
  'lyrics.editor.help.labelDrag': 'Drag',
  'lyrics.editor.help.wordsDoubleClick': 'Set a word exactly at the playhead',
  'lyrics.editor.help.labelDoubleClick': 'Double-click',
  'lyrics.editor.help.wordsNudge': 'Nudge a focused word by 50 ms',

  'lyrics.editor.help.otherUndo': 'Undo — add Shift to redo',
  'lyrics.editor.help.otherReplace': 'Paste the whole song; kept lines keep their timing',
  'lyrics.editor.help.otherClose': 'Close the editor (asks first about unsaved edits)'
}
