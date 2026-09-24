/* English strings for the `training` namespace — see ../index.ts.
 *
 * Vocal training: pitch-matching exercises (notes, scale degrees, intervals,
 * chord tones, arpeggios). `training.word.*` are single generic music-theory
 * words (chord quality, chord-tone role, direction, interval size) that get
 * interpolated — lowercase — into several different sentences; callers
 * capitalize them with a plain JS transform where a capitalized form is
 * needed (button labels), so translate them as the bare word.
 */
export const training = {
  // ── exercise picker (home) ──
  'training.exercise.note.label': 'Match a note',
  'training.exercise.note.description': 'Hear one note, then settle your voice onto it.',
  'training.exercise.scaleDegree.label': 'Notes in a key',
  'training.exercise.scaleDegree.description': 'Hear how notes fit inside one key.',
  'training.exercise.interval.label': 'Intervals',
  'training.exercise.interval.description': 'Sing the distance between two notes, up or down.',
  'training.exercise.chordTone.label': 'Chord tones',
  'training.exercise.chordTone.description': 'Find the root, third, or fifth of a chord.',
  'training.exercise.arpeggio.label': 'Arpeggios',
  'training.exercise.arpeggio.description': 'Trace a chord one note at a time.',
  'training.exercise.mixed.label': 'Mixed practice',
  'training.exercise.mixed.description': 'Rotate through every exercise in a short rehearsal.',

  // ── home screen ──
  'training.home.eyebrow': 'A focused pitch rehearsal',
  'training.home.heading': 'What do you want to hear more clearly?',
  'training.home.subheading': 'Choose one skill. SingZ will keep the session inside your comfortable range.',
  'training.home.exercisesAriaLabel': 'Training exercises',
  'training.home.progressEntry.label': 'Progress',
  'training.home.progressEntry.empty': 'Your practice history will appear here.',
  // "{n} completed session(s) · 84% landed" on the home screen's Progress entry
  'training.home.progressEntry.summary_one': '{n} completed session · {percent} landed',
  'training.home.progressEntry.summary_other': '{n} completed sessions · {percent} landed',
  'training.home.micNote': 'Microphone audio is analysed live and is never saved.',

  // ── "loaded song" preparation card on the home screen ──
  'training.home.songPrep.eyebrow': 'Loaded song',
  // {name} is the song title; keep the curly quotes
  'training.home.songPrep.title': 'Prepare for “{name}”',
  // appended after the key name, e.g. "A minor · transposed +2"
  'training.home.songPrep.transposedSuffix': ' · transposed {sign}{amount}',
  'training.home.songPrep.confirmKeyFirst': 'Confirm the song key first',
  'training.home.songPrep.tagline': 'Practise its notes, intervals and chords.',
  'training.home.songPrep.ariaPrepareFor': 'Prepare for {name}',
  'training.home.songPrep.choice.notes': 'Notes',
  'training.home.songPrep.choice.intervals': 'Intervals',
  'training.home.songPrep.choice.chords': 'Chords',
  'training.home.songPrep.choice.mixed': 'Mixed warm-up',
  'training.home.songPrep.chooseFocusHelp':
    'Choose any preparation focus to open setup, then confirm or change the key manually.',

  // ── progress screen ──
  'training.progress.eyebrow': 'Practice history',
  'training.progress.heading': 'Progress',
  'training.progress.subheading': 'Completed sessions only. Your microphone audio is never stored.',
  'training.progress.empty.heading': 'No completed sessions yet',
  'training.progress.empty.body': 'Complete an exercise to build your first snapshot.',
  'training.progress.empty.cta': 'Choose an exercise',
  'training.progress.metric.completedSessions': 'Completed sessions',
  'training.progress.metric.onTargetOrClose': 'On target or close',
  'training.progress.metric.pitchTendency': 'Pitch tendency',
  'training.progress.ariaStatistics': 'Training progress statistics',
  'training.progress.focus.heading': 'Useful next focus',
  'training.progress.focus.exerciseTypes': 'Exercise types',
  'training.progress.focus.scaleDegrees': 'Scale degrees',
  // "Degree 3" — a single scale degree named in the weak-spots list
  'training.progress.focus.degree': 'Degree {n}',
  'training.progress.focus.chordRoles': 'Chord roles',
  'training.progress.weakness.needMore': 'More sessions needed',
  'training.progress.recent.heading': 'Recent sessions',
  'training.progress.recent.landed': '{landed} of {attempts} landed',

  // ── metrics shared by the progress and summary screens ──
  'training.metric.voiceDetected': 'Voice detected',
  'training.metric.pitchHeldSteady': 'Pitch held steady',
  'training.metric.close': 'Close',
  'training.metric.averageError': 'Average error · on target or close',

  // pitch tendency, e.g. "Usually sharp"
  'training.tendency.notEnough': 'Not enough pitch data yet',
  'training.tendency.centered': 'In tune overall',
  // {word} is training.word.sharp/flat
  'training.tendency.usually': 'Usually {word}',

  // ── session setup screen ──
  'training.setup.eyebrow': 'Session setup',
  'training.setup.legend.musicalContext': 'Musical context',
  'training.setup.label.key': 'Key',
  'training.setup.ariaLabel.keyMode': 'Key mode',
  'training.setup.option.major': 'Major',
  'training.setup.option.minor': 'Minor',
  'training.setup.label.task': 'Task',
  'training.setup.ariaLabel.taskMode': 'Task mode',
  'training.setup.task.imitate': 'Imitate',
  'training.setup.task.find': 'Find the note yourself',
  'training.setup.task.identify': 'Listen and choose',
  'training.setup.taskHelp.imitate': 'Hear the complete answer, then sing it back.',
  'training.setup.taskHelp.find': 'Hear the key or starting note, then find the answer yourself.',
  'training.setup.taskHelp.identify': 'Hear the question and choose an answer. The microphone stays off.',
  'training.setup.error.noMic': 'No microphone is available. Listen and choose still works as ear-only practice.',
  'training.setup.label.direction': 'Direction',
  'training.setup.ariaLabel.direction': 'Direction',
  'training.setup.legend.range': 'Your singing range',
  'training.setup.rangeHelp': 'Use today’s easy working notes, not your maximum range.',
  'training.setup.label.lowestNote': 'Lowest note',
  'training.setup.label.highestNote': 'Highest note',
  'training.setup.legend.chordDegrees': 'Chord degrees',
  // checkbox label, e.g. "Scale degree 3"
  'training.setup.chordDegreeLabel': 'Scale degree {n}',
  'training.setup.legend.practiceSettings': 'Common practice settings',
  'training.setup.label.notePlaybackVolume': 'Note playback volume',
  'training.setup.testNote.playing': 'Playing C4…',
  'training.setup.testNote.idle': '▶ Test C4',
  'training.setup.ariaLabel.lowerVolume': 'Lower reference volume',
  'training.setup.ariaLabel.raiseVolume': 'Raise reference volume',
  'training.setup.ariaLabel.notePlaybackVolume': 'Note playback volume',
  'training.setup.help.volumeRange': '20–200% · saved for every exercise',
  'training.setup.label.pitchTolerance': 'Pitch tolerance',
  'training.setup.ariaLabel.pitchTolerance': 'Pitch tolerance',
  'training.setup.help.pitchTolerance': 'Stay inside this tolerance for {seconds} seconds to advance.',
  'training.setup.error.chooseOne': 'Choose at least one item for this session.',
  'training.setup.label.exercises': 'Exercises',
  'training.setup.startPractice': 'Start practice',
  // number of exercises in a session, e.g. "1 exercise" / "6 exercises"
  'training.exerciseCount_one': '{n} exercise',
  'training.exerciseCount_other': '{n} exercises',

  // ── in-session screen ──
  'training.nav.backToTraining': '← Training',
  'training.session.aria.backToSong': 'Back to song',
  'training.session.aria.endSession': 'End session',
  'training.session.aria.exerciseProgress': 'Exercise {current} of {total}',
  'training.session.aria.targetNotes': 'Target notes',
  'training.session.ready.paused': 'Practice paused. Continue when you are ready.',
  'training.session.ready.preparing': 'Preparing your exercise…',
  'training.session.readyAction.continue': 'Continue practice',
  'training.session.error.sessionInactive': 'This training session is no longer active.',
  'training.session.error.noMicUseListen': 'No microphone is available. Use Listen and choose for ear-only practice.',
  'training.session.error.micDisconnected': 'The microphone disconnected. Reconnect it, then start this exercise again.',
  'training.session.identify.legend': 'What did you hear?',

  // ── cue / countdown instructions ──
  'training.cue.identify': 'Get ready. Listen and choose when the countdown ends.',
  'training.cue.imitate': 'Get ready. Listen now, then sing when the countdown ends.',
  'training.cue.find': 'Get ready. Remember the starting note, then sing when the countdown ends.',

  // ── transport controls during a response ──
  'training.transport.ariaControls': 'Practice controls',
  'training.transport.aria.replay': 'Replay target note',
  'training.transport.label.replay': 'Replay',
  'training.transport.aria.listeningStatus': 'Microphone listening',
  'training.transport.listening': 'Listening',
  'training.transport.aria.skip': 'Skip this note',
  'training.transport.label.skip': 'Skip',

  // ── pitch runway (live intonation feedback) ──
  'training.session.pitch.onTarget': 'On target',
  'training.session.pitch.sharp': 'Sharp',
  'training.session.pitch.flat': 'Flat',
  'training.session.pitch.listening': 'Listening',
  // initial/reset state before any pitch has been read
  'training.session.guidance.listeningDefault': 'Listening for your voice.',
  'training.session.runway.youAreSinging': 'You are singing',
  'training.session.runway.holdInstruction': 'Sing the note. Hold within ±{cents}¢ for {seconds} seconds.',
  'training.session.runway.inTune': 'In tune — keep holding',
  'training.session.runway.lower': 'A little lower',
  'training.session.runway.higher': 'A little higher',
  'training.session.runway.ariaHoldProgress': 'Hold progress',

  // screen-reader only announcements of the live pitch, e.g. "Listening for
  // A4. No voice detected yet." — {target} is a note name, left untranslated
  'training.session.accessible.listeningFor': 'Listening for {target}. No voice detected yet.',
  'training.session.accessible.voiceDetected': 'Voice detected for {target}. Hold the pitch steady.',
  // {guidance} is training.session.pitch.onTarget/sharp/flat
  'training.session.accessible.pitchSteady': '{guidance} for {target}. Pitch steady.',

  // ── errors surfaced while training audio/mic is starting ──
  'training.error.mic.blocked': 'Microphone access is blocked. Allow SingZ in system privacy settings, then try again.',
  'training.error.mic.notFound': 'No microphone was found. Connect one or use Listen and choose for ear-only practice.',
  'training.error.mic.busy': 'The microphone is busy in another app. Close that app, then try again.',
  'training.error.audio.startFailedWithMessage': 'Training audio could not start: {message}',
  'training.error.audio.startFailedGeneric': 'Training audio could not start. Check your audio devices and try again.',

  // ── session summary screen ──
  'training.summary.eyebrow': 'Session complete',
  'training.summary.ariaMetrics': 'Session metrics',
  'training.summary.headingTemplate': '{landed} of {attempts} landed',
  'training.summary.noPitchMetrics': 'This ear-only session did not use pitch metrics.',
  'training.summary.noSteadyNotes': 'No steady in-tune notes were detected in this session.',
  'training.summary.stayedInTune': 'Your average pitch stayed in tune.',
  // {word} is training.word.sharp/flat
  'training.summary.tended': 'Your average pitch tended {word}.',
  'training.summary.restart': 'Restart',
  'training.summary.backToTraining': 'Back to training',
  'training.summary.backToSong': 'Back to song',

  // ── empty state (no exercise ready) ──
  'training.empty.heading': 'No exercise is ready',
  'training.empty.body': 'Choose a training focus and a comfortable range first.',

  // ── per-attempt outcome labels (session summary outcomes list) ──
  'training.outcome.none': 'No result',
  'training.outcome.skipped': 'Skipped',
  'training.outcome.correct': 'Correct',
  'training.outcome.tryAgain': 'Try again next time',
  'training.outcome.exerciseFallback': 'Exercise {n}',
  'training.outcome.wrongNote': 'Wrong note',
  'training.outcome.wrongOctave': 'Wrong octave',
  'training.outcome.otherChordTone': 'Other chord tone',
  'training.outcome.nonChordTone': 'Non chord tone',
  'training.outcome.unstable': 'Unstable',
  'training.outcome.unvoiced': 'Unvoiced',
  'training.outcome.outOfRange': 'Out of range',

  // ── feedback shown right after an attempt ──
  'training.feedback.skipped.detail': 'This exercise was not scored.',
  'training.feedback.identifyCorrect.detail': 'Keep that sound in mind before the next question.',
  'training.feedback.identifyWrong.heading': 'Not this time',
  'training.feedback.identifyWrong.detail': 'Listen for the key and compare the notes again.',
  'training.feedback.onTarget.detail': 'The pitch settled clearly in the center.',
  'training.feedback.close.heading': 'Very close',
  'training.feedback.close.detail': 'The right notes are there; give them a little more center.',
  'training.feedback.wrong.detail': 'Release the note, reset, and listen for the next cue.',

  // Longer per-classification headings used as feedback when a vocal attempt
  // misses ("wrong note", "unstable", …) — distinct from the short
  // training.outcome.* labels used in the summary's outcomes list.
  'training.classification.close': 'Close — one more pass will settle it',
  'training.classification.wrongNote': 'A different note landed',
  'training.classification.wrongOctave': 'Right note name, different octave',
  'training.classification.otherChordTone': 'Another chord tone landed',
  'training.classification.nonChordTone': 'The note landed outside the chord',
  'training.classification.unstable': 'The pitch did not settle yet',
  'training.classification.unvoiced': 'No steady voice was detected',
  'training.classification.outOfRange': 'The detected note was outside your chosen range',

  // ── "Listen and choose" prompt kind labels, before the answer is revealed ──
  'training.kindLabel.identifyNote': 'Listen and choose a note',
  'training.kindLabel.identifyNumber': 'Listen and choose a number',
  'training.kindLabel.identifyInterval': 'Listen and choose an interval',
  'training.kindLabel.identifyChordNote': 'Listen and choose a chord note',
  'training.kindLabel.identifyChord': 'Listen and choose a chord',

  // ── identify-mode answer reveal / detail text ──
  // {note} is a bare note name (untranslated), e.g. "Answer: A"
  'training.identify.answerNote': 'Answer: {note}',
  'training.identify.answerScaleDegree': 'Answer: scale degree {n}',
  // {interval} is a lowercase interval word (training.word.*), {direction} likewise
  'training.identify.answerInterval': 'Answer: {interval} {direction}',
  // {role} is training.word.root/third/fifth, {chord} is "{note} {quality}"
  'training.identify.answerChordTone': 'Answer: {role} of {chord}',
  'training.identify.answerArpeggio': 'Answer: degree {degree} — {chord}',
  // detail text under an identify answer choice, e.g. "Scale degree 3"
  'training.identify.scaleDegreeDetail': 'Scale degree {n}',
  // arpeggio identify-answer label, e.g. "Degree 3"
  'training.identify.degreeLabel': 'Degree {n}',
  // "{chord} arpeggio" — the word appended after a chord name
  'training.label.arpeggioOf': '{chord} arpeggio',

  // ── generic single music-theory words, interpolated lowercase ──
  'training.word.major': 'major',
  'training.word.minor': 'minor',
  'training.word.diminished': 'diminished',
  'training.word.augmented': 'augmented',
  'training.word.root': 'root',
  'training.word.third': 'third',
  'training.word.fifth': 'fifth',
  'training.word.ascending': 'ascending',
  'training.word.descending': 'descending',
  'training.word.both': 'both',
  'training.word.arpeggio': 'arpeggio',
  'training.word.sharp': 'sharp',
  'training.word.flat': 'flat',
  'training.word.unison': 'unison',
  'training.word.second': 'second',
  'training.word.fourth': 'fourth',
  'training.word.sixth': 'sixth',
  'training.word.seventh': 'seventh',
  'training.word.octave': 'octave',
  // fallback for an interval number outside the named set
  'training.word.intervalGeneric': 'interval {n}',

  // ── short nouns for weak-spot / kind labels ──
  'training.kind.note': 'Note',
  'training.kind.scaleDegree': 'Scale degree',
  'training.kind.interval': 'Interval',
  'training.kind.chordTone': 'Chord tone',
  'training.kind.arpeggio': 'Arpeggio',

  // ── vocal training route (module load / error states) ──
  'training.route.eyebrow': 'Vocal training',
  'training.route.opening': 'Opening practice…',
  'training.route.openingStatus': 'Opening vocal training.',
  'training.route.failure.heading': 'Practice didn’t open',
  'training.route.failure.body': 'The practice screen could not be loaded. Song playback remains paused.',
  'training.route.retry': 'Retry',
  'training.route.failure.recoveryFailed': 'The recovery copy also could not be loaded. Restart SingZ before trying again.',
  'training.route.returnToSongs': 'Return to Songs',
  'training.route.runtimeFailure.heading': 'Practice stopped',
  'training.route.runtimeFailure.stopping': 'Stopping exercise audio and confirming microphone release…',
  'training.route.runtimeFailure.unsafe':
    'Exercise audio or microphone cleanup could not be confirmed. Retry cleanup and keep SingZ open before leaving practice.',
  'training.route.runtimeFailure.safe':
    'Exercise audio and microphone capture were stopped, and song playback was paused.',
  'training.route.retryCleanup': 'Retry cleanup',
  'training.route.cleanupGate.stoppingHeading': 'Finishing audio cleanup…',
  'training.route.cleanupGate.attentionHeading': 'Audio cleanup needs attention',
  'training.route.cleanupGate.stoppingBody':
    'Confirming that exercise audio and the microphone stopped before leaving practice.',
  'training.route.cleanupGate.attentionBody':
    'The microphone or exercise audio did not confirm cleanup. Stay in Vocal training and retry before opening another audio path.',

  // ── session generator (shared/training-session.ts instructions) ──
  'training.session.instruction.identifyNote': 'Identify the note.',
  // {note} is a bare note name, untranslated
  'training.session.instruction.matchNote': 'Match {note}.',
  'training.session.instruction.identifyScaleDegree': 'Identify the scale degree.',
  'training.session.instruction.singScaleDegree': 'Sing scale degree {degree} — {note}.',
  'training.session.instruction.identifyInterval': 'Identify the interval.',
  // {interval} is prompt.intervalName (a music-theory term, untranslated)
  'training.session.instruction.singInterval': 'Sing {interval} {direction} — {from} to {to}.',
  'training.session.instruction.identifyChordTone': 'Identify the chord tone.',
  'training.session.instruction.singChordTone': 'Sing the {role} of {chord} — {note}.',
  'training.session.instruction.identifyArpeggio': 'Identify the arpeggiated chord.',
  'training.session.instruction.arpeggiate': 'Arpeggiate {chord} {direction}.',

  // ── session generator validation error reachable from normal setup ──
  'training.session.error.rangeTooNarrow': 'No requested exercises fit the comfortable working range.',
  'training.session.error.confirmKeyThenReview': 'Confirm or change the song key, then review the preparation session.',
  'training.session.error.setUpSessionFirst': 'Set up a session before starting.',
  'training.session.error.exerciseNoLongerActive': 'This exercise is no longer active.',

  // ── audio/training-cleanup.ts: cross-feature audio-safety notices ──
  'training.cleanup.songBlocked':
    'Song playback is unavailable until Vocal training confirms that its microphone and exercise audio stopped. Retry cleanup in Vocal training.',
  'training.cleanup.settingsBlocked':
    'Audio settings are unavailable until Vocal training confirms that its microphone and exercise audio stopped. Retry cleanup in Vocal training.',
  'training.cleanup.audioBlocked':
    'Vocal training audio is unavailable while its previous microphone and exercise audio cleanup is unresolved. Retry cleanup before continuing.',
  // thrown as an Error message when cleanup fails with a non-Error cause;
  // surfaces wherever that error's .message is displayed
  'training.cleanup.couldNotConfirm': 'Training audio cleanup could not be confirmed.',

  // ── misc ──
  'training.error.couldNotOpenFile': 'Could not open that file.'
}
