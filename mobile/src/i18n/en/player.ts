/* English phone strings for the `phone.player` namespace — see ../index.ts. */
export const player = {
  // ── "not available in native playback yet" alert ──
  'phone.player.unsupported.title': 'Not available in native playback yet',
  'phone.player.unsupported.message': '{operation} stays disabled until its native DSP control is connected.',
  'phone.player.playbackStopped.title': 'Playback stopped',
  'phone.player.metronomeSaveFailed.title': 'Metronome setting was not saved',
  // names of a PlaybackOperation, for the message above
  'phone.player.operation.pause': 'pause',
  'phone.player.operation.seek': 'seek',
  'phone.player.operation.loopRegion': 'loop region',
  'phone.player.operation.metronome': 'metronome',
  'phone.player.operation.mixer': 'mixer',
  'phone.player.operation.pitchTempo': 'pitch tempo',
  'phone.player.operation.training': 'training',
  'phone.player.operation.previewClick': 'preview click',

  // ── stem lane names (STEM_META ids: original/vocals/drums/bass/guitar/piano/other) ──
  'phone.player.stem.original': 'Full mix',
  'phone.player.stem.vocals': 'Vocals',
  'phone.player.stem.drums': 'Drums',
  'phone.player.stem.bass': 'Bass',
  'phone.player.stem.guitar': 'Guitar',
  'phone.player.stem.piano': 'Piano',
  'phone.player.stem.other': 'Instruments',

  // ── count-in display (playback/count-in-display.ts) ──
  'phone.player.countIn.beatLabel': 'Count-in, beat {done} of {total}',
  'phone.player.countIn.secondsLabel': 'Count-in, {seconds} seconds remaining',
  // the compact on-screen readout, e.g. "3s"
  'phone.player.countIn.secondsText': '{seconds}s',

  // ── song format line (ui/song-sheet-copy.ts) ──
  'phone.player.songSheet.formatFlac': 'FLAC stems',
  'phone.player.songSheet.formatWav': 'WAV stems',
  'phone.player.songSheet.formatFlacWav': 'FLAC + WAV stems',
  'phone.player.songSheet.formatNone': 'no stems',

  // ── shared UI kit accessibility strings (ui/bits.tsx) ──
  'phone.player.bits.decrease': 'Decrease {label}',
  'phone.player.bits.increase': 'Increase {label}',
  // e.g. "Hear, 3" — a stepper's screen-reader label followed by its value
  'phone.player.bits.labelValue': '{label}, {value}',
  // fallback screen-reader value for an adjustable bar with no custom formatter
  'phone.player.bits.percentValue': '{percent} percent',
  // VoiceOver rotor action names for the adjustable Bar control
  'phone.player.bits.increaseAction': 'Increase',
  'phone.player.bits.decreaseAction': 'Decrease',

  // ── lyric column (ui/SkiaLyrics.tsx + the tap-target overlay in PlayerScreen) ──
  'phone.player.lyrics.waitSeconds': '{sec} s',
  'phone.player.lyrics.empty': 'No lyrics in this project yet.',
  // {text} is the lyric line itself; said for a line the singer performs solo
  'phone.player.lyrics.lineTurn': '{text}. Your turn.',

  // ── header (song title bar) ──
  'phone.player.header.back': 'Back to library',
  'phone.player.header.about': 'About this song',
  'phone.player.header.notSplit': 'Not split yet',
  'phone.player.header.stemsCount': '{n} stems',
  'phone.player.header.added': '{n} added',
  'phone.player.header.bpm': '{bpm} bpm',
  // musical key quality, abbreviated (header subtitle and the transpose suffix)
  'phone.player.header.keyMinor': 'min',
  'phone.player.header.keyMajor': 'maj',
  'phone.player.header.youSing': 'YOU SING 🎤',

  // ── loop (A-B repeat) button ──
  'phone.player.loop.markStart': 'Loop a section. Marks the start here.',
  // {time} e.g. "1:23"
  'phone.player.loop.startMarked': 'Loop start marked at {time}. Marks the end here.',
  'phone.player.loop.looping': 'Looping {a} to {b}. Clears the loop.',
  'phone.player.loop.buttonA': 'A',
  'phone.player.loop.buttonAB': 'A–B',

  // ── transport (footer controls) ──
  'phone.player.transport.position': 'Position',
  'phone.player.transport.mixer': 'Mixer',
  'phone.player.transport.backToStart': 'Back to start',
  'phone.player.transport.back5': 'Back 5 seconds',
  'phone.player.transport.forward5': 'Forward 5 seconds',
  'phone.player.transport.practice': 'Practice',
  'phone.player.transport.play': 'Play',
  'phone.player.transport.skipBackLabel': '−5s',
  'phone.player.transport.skipForwardLabel': '+5s',
  'phone.player.transport.pause': 'Pause',

  // ── mixer sheet ──
  'phone.player.mixer.title': 'Mixer',
  'phone.player.mixer.fullMix': 'Full mix',
  'phone.player.mixer.noVocals': 'No vocals',
  'phone.player.mixer.vocalsOnly': 'Vocals only',
  // header over the singer's own added tracks, below the song's own stems
  'phone.player.mixer.added': 'Added',
  'phone.player.mixer.yourTurn': 'your turn',
  'phone.player.mixer.mute': 'Mute {label}',
  'phone.player.mixer.solo': 'Solo {label}',
  'phone.player.mixer.volumeLabel': '{label} volume',

  // ── song sheet: Beat row ──
  'phone.player.songSheet.beat': 'Beat',
  // e.g. "120 bpm · 4/4 · 32 bars"
  'phone.player.songSheet.bpmMeterBars': '{bpm} bpm · {meter} · {bars} bars',
  'phone.player.songSheet.noBeatVerdict': 'No beat in these drums',
  'phone.player.songSheet.readingSong': 'Reading the song…',
  'phone.player.songSheet.notDetectedYet': 'Not detected yet',
  'phone.player.songSheet.handMade': 'hand-made on the computer',
  'phone.player.songSheet.detectorVersion': 'detector v{ver}',
  'phone.player.songSheet.handSetBars_one': ' · {n} hand-set bar',
  'phone.player.songSheet.handSetBars_other': ' · {n} hand-set bars',
  'phone.player.songSheet.beatHintProgress':
    'Listening now — the click and the count-in pick the beat up the moment it is found.',
  'phone.player.songSheet.beatHintHandTuned':
    'Hand-tuned on the computer — nothing here will re-detect over it. ',
  'phone.player.songSheet.beatHintUserBars':
    'Your own bar lines are on this grid and stay on it. ',
  'phone.player.songSheet.beatHintFollow':
    'The click, the count-in and the bar lines all follow this.',
  'phone.player.songSheet.beatHintVerdict':
    'The detector listened and found no steady beat it would put a click on — a free-time or drumless song. That answer is remembered, so opening the song again does not read the stems for nothing.',
  'phone.player.songSheet.beatHintDetectAgain': ' Detect again to ask once more.',
  'phone.player.songSheet.beatHintBusy':
    'Being read right now — the grid is written after the key is read, so this row fills in a moment after the beat itself is found.',
  'phone.player.songSheet.beatHintNothingRead': 'Nothing has read the stems yet.',
  'phone.player.songSheet.beatHintNotSplit':
    'Not split yet — the beat is read from the drums, so it waits for the split.',
  'phone.player.songSheet.beatHintFromComputer':
    'Songs from the computer arrive with their beat already in them.',
  'phone.player.songSheet.timeEstimateWithMl':
    'The beat, the key and the melody together take about ten seconds for every minute of song',
  'phone.player.songSheet.timeEstimateMlSuffix':
    ' — about fifteen with the better-beats model listening.',
  'phone.player.songSheet.timeEstimateNoMlSuffix': '.',
  'phone.player.songSheet.timeEstimateFlacJs':
    "This song's stems are FLAC and this build reads them in JavaScript — minutes rather than seconds.",
  'phone.player.songSheet.detecting': 'Detecting…',
  'phone.player.songSheet.detectAgain': 'Detect again',

  // ── song sheet: Better beats row ──
  'phone.player.songSheet.betterBeats': 'Better beats',
  'phone.player.songSheet.downloading': 'Downloading — {mb} of {total} MB',
  'phone.player.songSheet.onThisPhone': 'On this phone',
  'phone.player.songSheet.notDownloaded': 'Not downloaded — {mb} MB',
  'phone.player.songSheet.checking': 'Checking…',
  'phone.player.songSheet.betterBeatsHint':
    'A neural model that hears the beat through drumless intros and rubato the drums-first reader loses. Downloaded once, used by every song afterwards.',
  'phone.player.songSheet.betterBeatsHintDetectAgain': ' Detect again to use it on this one.',
  'phone.player.songSheet.cancel': 'Cancel',
  'phone.player.songSheet.downloadMb': 'Download {mb} MB',

  // ── song sheet: Key row ──
  'phone.player.songSheet.key': 'Key',
  'phone.player.songSheet.noKeyVerdict': 'No key in these stems',
  'phone.player.songSheet.keyVerdictHint':
    'The harmony the key is read from — the guitar, piano and bass lanes — is silent here, so there is nothing to read it off. That answer is remembered rather than re-read on every open.',
  // full words, unlike the header's abbreviated min/maj
  'phone.player.songSheet.keyMinor': 'minor',
  'phone.player.songSheet.keyMajor': 'major',

  // ── song sheet: Melody row ──
  'phone.player.songSheet.melody': 'Melody',
  'phone.player.songSheet.trackedFromVocals': 'Tracked from the vocals',
  'phone.player.songSheet.notTrackedYet': 'Not tracked yet',
  'phone.player.songSheet.melodyDetector': 'detector v{ver} · one frame every {ms} ms',
  'phone.player.songSheet.melodyHint':
    'The sung line, saved with the song. The phone does not draw it — the computer\'s pitch strip does.',

  // ── song sheet: Lyrics row ──
  'phone.player.songSheet.lyrics': 'Lyrics',
  'phone.player.songSheet.linesCount': '{n} lines',
  'phone.player.songSheet.wordTimings': ' · word timings',
  'phone.player.songSheet.lineTimingsOnly': ' · line timings only',
  'phone.player.songSheet.none': 'None',

  // ── song sheet: Stems + Project rows ──
  'phone.player.songSheet.stems': 'Stems',
  'phone.player.songSheet.project': 'Project',
  // e.g. "Format v2 · FLAC stems"
  'phone.player.songSheet.formatVersion': 'Format v{ver} · {format}',
  'phone.player.songSheet.onDisk': '{size} on disk',
  'phone.player.songSheet.playsAtKhz': 'plays at {khz} kHz',
  'phone.player.songSheet.savedOn': 'saved {date}',
  'phone.player.songSheet.fromGoogleDrive': 'from Google Drive',
  'phone.player.songSheet.fromFolder': 'from a folder',
  'phone.player.songSheet.onThisPhoneSource': 'on this phone',
  'phone.player.songSheet.bundledSample': 'bundled sample',
  'phone.player.songSheet.gettingReady': 'Getting ready…',

  // ── practice sheet: Key & speed ──
  'phone.player.practice.title': 'Practice',
  'phone.player.practice.keySpeed': 'Key & speed',
  'phone.player.practice.reset': 'Reset',
  'phone.player.practice.pitch': 'Pitch',
  // {key} is a musical key name (untranslated), {quality} is minor/major short form
  'phone.player.practice.pitchSuffix': '→ {key} {quality}',
  'phone.player.practice.tempo': 'Tempo',
  'phone.player.practice.tempoSuffix': '→ {bpm} bpm',

  // ── practice sheet: Metronome ──
  'phone.player.practice.metronome': 'Metronome',
  'phone.player.practice.bpmFromSong': '{bpm} bpm, from the song',
  'phone.player.practice.noCountIn': 'No count-in',
  'phone.player.practice.oneBar': '1 bar',
  'phone.player.practice.twoBars': '2 bars',
  'phone.player.practice.threeSec': '3 s',
  'phone.player.practice.sixSec': '6 s',
  'phone.player.practice.click': 'Click',
  'phone.player.practice.accent': 'Accent',
  'phone.player.practice.loudness': 'Loudness',
  'phone.player.practice.readOnlyHint':
    'Metronome settings are read-only because this project was opened without a verified library location. Reopen it from the library to save changes.',
  // {step} is a progress line such as "Finding the beat…"
  'phone.player.practice.beatHintStep':
    '{step} — the click and the count-in pick the beat up the moment it is found.',
  'phone.player.practice.beatHintBusy':
    'The song is being read now — the click and the count-in pick the beat up the moment it lands.',
  'phone.player.practice.beatHintPhoneNoTrack':
    'No beat track — the count-in ticks once a second before playback starts. If the song has a steady beat, opening it here reads one from the drums once it is split.',
  'phone.player.practice.beatHintDesktopNoTrack':
    'No beat track — the count-in ticks once a second before playback starts. If the song has a steady beat, opening it on desktop reads one from the drums.',

  // ── practice sheet: Vocal training ──
  'phone.player.practice.vocalTraining': 'Vocal training',
  'phone.player.practice.training': 'Training',
  'phone.player.practice.byTime': 'By time',
  'phone.player.practice.byLyricLines': 'By lyric lines',
  'phone.player.practice.interval': 'Interval',
  'phone.player.practice.hear': 'Hear',
  'phone.player.practice.sing': 'Sing',
  'phone.player.practice.decreaseHear': 'Decrease Hear',
  'phone.player.practice.increaseHear': 'Increase Hear',
  'phone.player.practice.decreaseSing': 'Decrease Sing',
  'phone.player.practice.increaseSing': 'Increase Sing',
  'phone.player.practice.hearValue': 'Hear, {n}',
  'phone.player.practice.singValue': 'Sing, {n}',
  'phone.player.practice.scheduleTime':
    'With the singer {sec} seconds, then your turn {sec} seconds, repeating',
  'phone.player.practice.scheduleLines_one':
    'Hear {n} line with the singer, then sing {sing} on your own, repeating — marked 🎤 in the lyrics',
  'phone.player.practice.scheduleLines_other':
    'Hear {n} lines with the singer, then sing {sing} on your own, repeating — marked 🎤 in the lyrics',
  'phone.player.practice.withTheSinger': 'with the singer',
  'phone.player.practice.yourTurn': 'your turn',
  'phone.player.practice.yourTurnMic': 'your turn 🎤',
  'phone.player.practice.dropOutHint': 'Lanes that drop out when you sing:',

  // ── practice sheet: Lyric timing ──
  'phone.player.practice.lyricTiming': 'Lyric timing',
  // {route} e.g. " · Bluetooth, auto 120 ms" — appended to the section label above
  'phone.player.practice.lyricTimingRoute': ' · {label}, auto {ms} ms',
  'phone.player.practice.trim': 'Trim',
  'phone.player.practice.highlightsShifted':
    'Highlights are shifted {ms} ms to match what you hear. If words light up before you hear them (car audio, Bluetooth), add more.',

  // ── analysis progress (analysis/pipeline.ts → the Song/Practice sheets) ──
  'phone.player.analysis.listeningForBeat': 'Listening for the beat…',
  'phone.player.analysis.findingBeat': 'Finding the beat…',
  'phone.player.analysis.readingStems': 'Reading the stems…',
  'phone.player.analysis.readingKey': 'Reading the key…',
  'phone.player.analysis.trackingMelody': 'Tracking the melody…',
  'phone.player.analysis.trackingMelodyPercent': 'Tracking the melody · {percent}%'
}
