/* English phone strings for the `phone.training` namespace — see ../index.ts. */
export const training = {
  // ── errors ──
  // {detail} is an underlying message (storage/parse error) that is not itself translated.
  'phone.training.loadError': 'Could not load training progress: {detail}',
  'phone.training.interrupted': 'Audio was interrupted. Tap Start when you are ready.',
  'phone.training.micStopped': 'The microphone stopped. Tap Start to try again.',
  'phone.training.micUnavailable': 'Native audio input is unavailable on this device.',
  'phone.training.micPermissionOff': 'Microphone access is off. Allow it in Settings, then tap Start again.',
  'phone.training.micStartCancelled': 'Microphone start was cancelled.',
  // {detail} is the underlying cleanup failure message, not translated.
  'phone.training.micCleanupFailed': 'The previous microphone session could not close cleanly: {detail}. Tap Start to retry.',
  'phone.training.chooseSongKey': 'Choose the song key, then tap Start.',
  'phone.training.setupSessionFirst': 'Set up a session first.',

  // ── accessibility announcements ──
  'phone.training.noteLocked': 'Note locked',
  'phone.training.noteSkipped': 'Note skipped',
  // {note} is a note name, e.g. "C#4" — not translated.
  'phone.training.nextNote': 'Next note {note}',

  // ── home screen ──
  'phone.training.heroEyebrow': 'VOCAL TRAINING',
  'phone.training.heroTitle': 'Tune the ear.\nSteady the voice.',
  'phone.training.heroLede': 'Short exercises built around the notes you actually sing.',
  'phone.training.loadedSongEyebrow': 'LOADED SONG',
  // {song} is the song's title.
  'phone.training.prepareFor': 'Prepare for “{song}”',
  // {key} is a musical key, e.g. "A minor".
  'phone.training.keyWithTranspose': '{key} · live transpose included',
  'phone.training.noCurrentKey': 'No current key — choose it in setup.',
  'phone.training.prepChoiceNotes': 'Notes',
  'phone.training.prepChoiceIntervals': 'Intervals',
  'phone.training.prepChoiceChords': 'Chords',
  'phone.training.prepChoiceMixed': 'Mixed',
  'phone.training.progressEntryTitle': 'Progress',
  'phone.training.progressEmpty': 'Your completed sessions will appear here.',
  // {n} sessions and {landed} is either an em dash or "{pct}% landed".
  'phone.training.progressSummary_one': '{n} session · {landed}',
  'phone.training.progressSummary_other': '{n} sessions · {landed}',
  'phone.training.landedPercent': '{pct}% landed',

  // ── exercise titles/copy — shared between the home cards and the setup header ──
  'phone.training.exerciseNoteTitle': 'Single notes',
  'phone.training.exerciseNoteCopy': 'Hear it, then place it cleanly.',
  'phone.training.exerciseIntervalTitle': 'Intervals',
  'phone.training.exerciseIntervalCopy': 'Build reliable distance between notes.',
  'phone.training.exerciseChordToneTitle': 'Notes in a chord',
  'phone.training.exerciseChordToneCopy': 'Find roots, thirds, and fifths.',
  'phone.training.exerciseArpeggioTitle': 'Carry the line',
  'phone.training.exerciseArpeggioCopy': 'Connect chord tones without a break.',
  'phone.training.exerciseScaleDegreeTitle': 'Scale degrees',
  'phone.training.exerciseMixedTitle': 'Mixed practice',

  // ── setup ──
  // musical key of the song, e.g. "A minor"
  'phone.training.setupKey': 'Key',
  'phone.training.setupMajor': 'Major',
  'phone.training.setupMinor': 'Minor',
  'phone.training.setupPractice': 'Practice',
  'phone.training.setupImitate': 'Imitate',
  'phone.training.setupIdentify': 'Identify',
  'phone.training.setupVoiceRange': 'Voice range',
  'phone.training.setupLow': 'Low',
  'phone.training.setupHigh': 'High',
  'phone.training.setupDirection': 'Direction',
  'phone.training.directionAscending': 'ascending',
  'phone.training.directionDescending': 'descending',
  'phone.training.directionBoth': 'both',
  'phone.training.setupChordDegrees': 'Chord degrees',
  'phone.training.setupSession': 'Session',
  'phone.training.unitNotes_one': '{n} note',
  'phone.training.unitNotes_other': '{n} notes',
  'phone.training.unitExercises_one': '{n} exercise',
  'phone.training.unitExercises_other': '{n} exercises',
  // {minutes} is an estimated duration, e.g. "≈ 3 min".
  'phone.training.approxMinutes': '≈ {minutes} min',
  'phone.training.startPractice': 'Start practice',

  // ── reference sound ──
  // {note} is a note name, e.g. "C#4" — not translated.
  'phone.training.testNote': 'Test {note}',
  'phone.training.referenceVolumeHint': '20–200% · saved for every exercise',

  // ── session ──
  'phone.training.backToSong': 'Back to song',
  'phone.training.endSession': 'End session',
  'phone.training.readyIdentifyCopy': 'Listen, then choose what you heard.',
  'phone.training.readyImitateCopy': 'The microphone starts only when you tap below.',
  'phone.training.startExercise': 'Start exercise',
  'phone.training.listen': 'Listen',
  'phone.training.seeSummary': 'See summary',
  'phone.training.nextExercise': 'Next exercise',
  // eyebrow above the pitch target, e.g. "SINGLE NOTE"
  'phone.training.singleNotePracticeLabel': 'Single note',
  // {n} is a scale degree number, e.g. "Degree 3".
  'phone.training.degreeN': 'Degree {n}',
  'phone.training.roleRoot': 'root',
  'phone.training.roleThird': 'third',
  'phone.training.roleFifth': 'fifth',

  // ── single-note transport ──
  'phone.training.tapStartWhenReady': 'Tap Start when you are ready',
  'phone.training.nextNoteAutomatic': 'The next note starts automatically',
  'phone.training.swipeHint': 'Swipe right to replay · left to skip',
  'phone.training.loadingNextNote': 'Loading next note',
  'phone.training.listenNowHint': 'Listen now · sing when the countdown ends',
  'phone.training.hearAgain': 'Hear again',
  'phone.training.replay': 'Replay',
  'phone.training.start': 'Start',
  'phone.training.preparingNextNoteAria': 'Preparing next note',
  'phone.training.playingTargetNoteAria': 'Playing target note',
  'phone.training.micListeningAria': 'Microphone listening',
  'phone.training.preparing': 'Preparing',
  'phone.training.playing': 'Playing',
  'phone.training.listening': 'Listening',
  'phone.training.nextNoteCaption': 'Next note',
  'phone.training.skip': 'Skip',
  'phone.training.preparingNextNoteEllipsis': 'Preparing next note…',
  'phone.training.listenToReferenceNote': 'Listen to the reference note',

  // ── mic hearing copy ──
  'phone.training.noSoundReading': 'No sound from the mic',
  'phone.training.noSoundInstruction': 'Tap Replay to restart the microphone',
  'phone.training.silentReading': 'The mic is delivering silence',
  'phone.training.silentInstruction': 'Check microphone access in Settings',
  'phone.training.tooQuietReading': 'Too quiet to hear',
  'phone.training.tooQuietInstruction': 'Sing a little louder, or move closer',
  'phone.training.waitingReading': 'Waiting for your voice',
  'phone.training.singTheNote': 'Sing the note',

  // ── pitch meter ──
  'phone.training.centered': 'Centered',
  // {cents} is a number of cents off pitch.
  'phone.training.centsFlat': '{cents}¢ flat',
  'phone.training.centsSharp': '{cents}¢ sharp',
  'phone.training.locked': 'Locked',
  'phone.training.holdIt': 'Hold it…',
  'phone.training.aLittleHigher': 'A little higher',
  'phone.training.aLittleLower': 'A little lower',
  'phone.training.steadyTheNote': 'Steady the note',
  // {note} is a note name, e.g. "C#4" — not translated. Accessibility sentence.
  'phone.training.youAreSinging': 'You are singing {note}.',
  // {percent} is a whole-number percentage. Accessibility sentence.
  'phone.training.holdProgress': 'Hold progress {percent} percent.',
  // {cents} is the width of the target pitch window in cents.
  'phone.training.centerWithinHint': 'Center within ±{cents}¢ and hold for 1.5 seconds.',
  'phone.training.singWhenReady': 'Sing when ready',

  // ── feedback ──
  'phone.training.skipped': 'Skipped',
  'phone.training.correct': 'Correct',
  'phone.training.keepListening': 'Keep listening',
  'phone.training.onTargetFeedback': 'On target',
  // Short per-target result labels, joined with " · " when a multi-note attempt misses.
  'phone.training.classificationOnTarget': 'on target',
  'phone.training.classificationClose': 'close',
  'phone.training.classificationWrongNote': 'wrong note',
  'phone.training.classificationWrongOctave': 'wrong octave',
  'phone.training.classificationOtherChordTone': 'other chord tone',
  'phone.training.classificationNonChordTone': 'non chord tone',
  'phone.training.classificationUnstable': 'unstable',
  'phone.training.classificationUnvoiced': 'unvoiced',
  'phone.training.classificationOutOfRange': 'out of range',

  // ── summary / progress ──
  'phone.training.sessionComplete': 'Session complete',
  'phone.training.landedOnOrNear': 'landed on or near the target',
  'phone.training.metricOnTarget': 'On target',
  'phone.training.metricClose': 'Close',
  'phone.training.metricSessions': 'Sessions',
  'phone.training.trainSomethingElse': 'Train something else',
  'phone.training.completedSessions': 'completed sessions',
  'phone.training.metricAttempts': 'Attempts',
  'phone.training.metricLanded': 'Landed',
  'phone.training.metricTendency': 'Tendency',
  'phone.training.usefulNextFocus': 'Useful next focus',
  'phone.training.recent': 'Recent',
  'phone.training.completeSessionToStart': 'Complete a session to start your history.',
  // {landed} and {attempts} are counts, e.g. "3/5 landed".
  'phone.training.landedOfAttempts': '{landed}/{attempts} landed',
  // Lowercase exercise-kind labels used in the progress history.
  'phone.training.kindNote': 'note',
  'phone.training.kindInterval': 'interval',
  'phone.training.kindChordTone': 'chord tone',
  'phone.training.kindScaleDegree': 'scale degree',
  // a prompt label: {role} is root/third/fifth, {chord} e.g. "C major"
  'phone.training.roleOfChord': '{role} of {chord}',

  // ── words drawn by the kit's ReferenceControls / PitchMeter (labels prop) ──
  // title, pitchWindow, flat, sharp and youAreSinging are shown upper-cased
  'phone.training.kit.referenceSound': 'Reference sound',
  'phone.training.kit.pitchWindow': 'Pitch window',
  'phone.training.kit.referenceVolume': 'Reference sound volume',
  'phone.training.kit.percent': '{percent} percent',
  'phone.training.kit.decreaseVolume': 'Decrease reference volume',
  'phone.training.kit.increaseVolume': 'Increase reference volume',
  'phone.training.kit.flat': 'Flat',
  'phone.training.kit.sharp': 'Sharp',
  'phone.training.kit.youAreSinging': 'You are singing',
  'phone.training.kit.holdProgress': '{instruction}. {percent} percent complete.'
}
