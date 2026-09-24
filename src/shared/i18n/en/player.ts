/* English strings for the `player` namespace — see ../index.ts. */
export const player = {
  // ── transport ──
  'player.transport.backToStart': 'Back to start',
  'player.transport.pause': 'Pause (space)',
  'player.transport.play': 'Play (space)',
  'player.transport.loopSelection': 'Loop the selection',
  'player.transport.loopSong': 'Loop the whole song (drag on the waveforms to loop a section)',
  'player.transport.karaoke': 'Karaoke',
  'player.transport.karaokeTitle': 'Karaoke view: lyrics, melody line and mic matching (Esc to close)',
  'player.transport.stemFiles': 'Stem files',
  'player.transport.stemFilesTitle': 'Show the stem files in your file manager',
  'player.transport.cancel': 'Cancel',
  'player.transport.cancelSplit': 'Cancel splitting',
  'player.transport.transposeTitle': 'Transpose the whole song (pitch only, tempo unchanged)',
  'player.transport.resetTranspose': 'Reset transpose',
  'player.transport.speedTitle': 'Playback speed (pitch stays put)',
  'player.transport.resetSpeed': 'Reset speed',
  'player.transport.muted': 'Sound is muted — click for the volume slider',
  // {percent} is a number already rounded, e.g. "Volume 80% — click for the slider"
  'player.transport.volumeAt': 'Volume {percent}% — click for the slider',
  'player.transport.metronomeTitle': 'Metronome — click on the beat, a grid to watch, count-in before play',
  'player.transport.carryLine': 'Carry the line',
  'player.transport.carryLineTitle':
    'Carry the line — guide stems drop out on a schedule while you carry the song',

  // ── shared toggle labels (metronome, training, count-in, grid view, accent) ──
  'player.toggle.off': 'Off',
  'player.toggle.on': 'On',

  // ── bpm entry (the tempo readout in the transport) ──
  'player.bpm.detectHint': 'Beats per minute — detected once the song is split and analyzed',
  'player.bpm.setTitle': 'Set the playback tempo in beats per minute',

  // ── volume popover ──
  'player.volume.title': 'Volume',
  'player.volume.muteAll': 'Mute everything',
  'player.volume.unmute': 'Back to the last level',
  'player.volume.sliderTitle': 'How loud the whole mix plays — the metronome follows it too',
  'player.volume.caption':
    "Sets the app's own output — your stem faders and the system volume stay where they are.",

  // ── metronome popover ──
  'player.metronome.title': 'Metronome',
  'player.metronome.clickTitle': 'Click on every beat during playback',
  'player.metronome.needsTempo': 'Needs a tempo first',
  'player.metronome.loudness': 'Loudness',
  'player.metronome.loudnessTitle': 'How loud the click is — release to hear it',
  'player.metronome.accent': 'Accent',
  'player.metronome.accentOnTitle': 'The first beat of every bar rings brighter',
  'player.metronome.accentOn': 'On the 1',
  'player.metronome.accentOffTitle': 'Every click identical — nothing marks the bar',
  'player.metronome.gridView': 'Grid view',
  'player.metronome.gridViewOnTitle':
    'Rule the waveforms with the beat: a line per beat, bars in orange — so you can see whether the beats sit on the song',
  'player.metronome.gridViewShow': 'Show',
  'player.metronome.tapHint': 'Keep tapping — three steady taps set the tempo.',
  'player.metronome.noBeatCanDetect':
    'No steady beat found in the drums — the count-in ticks once a second instead. Tap the tempo yourself, or try Re-detect.',
  'player.metronome.noBeatCannotDetect':
    'No tempo yet — the count-in ticks once a second instead. Tap one, or split the song and it is read from the drums.',
  // e.g. "120.5 bpm · following the drums, drift and all — tap along during playback to re-anchor."
  'player.metronome.gridCaption': '{bpm} bpm · {source} — tap along during playback to re-anchor.',
  'player.metronome.sourceAuto': 'following the drums, drift and all',
  'player.metronome.sourceManual': 'set by hand',
  'player.metronome.gridData': 'Grid data',
  'player.metronome.handTunedTitle':
    'This grid was placed or corrected by hand — re-detection leaves it alone',
  // {saved}/{current} are detector version numbers, e.g. "Saved with detector v17; this build has v19 and will re-derive on next open"
  'player.metronome.staleTitle':
    'Saved with detector v{saved}; this build has v{current} and will re-derive on next open',
  'player.metronome.currentTitle': "The saved grid matches this build's detector",
  'player.metronome.newerTitle':
    "Saved by a newer detector (v{saved}); this build has v{current} and leaves it alone. Re-detect would replace it with this build's older grid.",
  // the grid-version badge text, e.g. "hand-tuned (v17)"
  'player.metronome.handTuned': 'hand-tuned (v{ver})',
  'player.metronome.staleLabel': 'v{saved} → v{current} available',
  'player.metronome.currentLabel': 'v{ver} — current',
  'player.metronome.newerLabel': 'v{ver} — newer than this build',
  'player.metronome.userBarsTitle':
    'Bar lines you moved by hand. Re-detection re-folds them onto the new grid — they are not lost.',
  // "· 1 hand-set bar" / "· 3 hand-set bars", next to the grid-version badge
  'player.metronome.userBars_one': '· {n} hand-set bar',
  'player.metronome.userBars_other': '· {n} hand-set bars',
  'player.metronome.countIn': 'Count-in',
  'player.metronome.countInBarTitle': 'One bar of clicks before playback starts',
  'player.metronome.countInSecTitle': 'Three ticks, one per second, before playback starts',
  'player.metronome.oneBar': '1 bar',
  'player.metronome.threeSec': '3 s',
  'player.metronome.countIn2BarTitle': 'Two bars of clicks before playback starts',
  'player.metronome.countIn2SecTitle': 'Six ticks, one per second, before playback starts',
  'player.metronome.twoBars': '2 bars',
  'player.metronome.sixSec': '6 s',
  'player.metronome.tempo': 'Tempo',
  'player.metronome.tempoTitle': "The song's own tempo (playback speed stays put)",
  'player.metronome.tap': 'Tap',
  'player.metronome.tapTitle': 'Tap the beat to set the tempo (and lock the phase while playing)',
  'player.metronome.halfTime': 'Half time',
  'player.metronome.doubleTime': 'Double time',
  'player.metronome.beatsPerBar': 'Beats per bar',
  'player.metronome.align': 'Align',
  'player.metronome.nudgeEarlierTitle': 'Clicks 10 ms earlier',
  'player.metronome.nudgeLaterTitle': 'Clicks 10 ms later',
  // “1” refers to the first beat of the bar, kept as a literal digit in quotes
  'player.metronome.rotateAccentTitle': 'Move the accent to the next beat (when the “1” lands wrong)',
  'player.metronome.redetect': 'Re-detect',
  'player.metronome.redetectKeepBarsTitle':
    'Read the tempo and beat from the drums again — your hand-placed bar lines are kept',
  'player.metronome.redetectTitle': 'Read the tempo and beat from the drums again',

  // ── training / carry the line popover ──
  'player.training.title': 'Carry the line',
  'player.training.byTime': 'By time',
  'player.training.byLines': 'By lyric lines',
  'player.training.byLinesTitle': 'Alternate by karaoke lyric lines',
  'player.training.switchEvery': 'Switch every',
  'player.training.hear': 'Hear',
  'player.training.sing': 'sing',
  // e.g. "Guide plays 10 s, then you take the next 10 s."
  'player.training.captionTime': 'Guide plays {sec} s, then you take the next {sec} s.',
  'player.training.captionLines_one': 'Hear {n} line, then sing {sing} on your own.',
  'player.training.captionLines_other': 'Hear {n} lines, then sing {sing} on your own.',
  'player.training.captionNoLyrics': 'No synced lyrics yet — alternating by time until they load.',
  'player.training.mutedWhileSinging': 'Muted while you sing:',
  'player.training.mutedWhileSingingTitle':
    'These tracks go silent during your turns — you perform them',

  // ── split menu (the Split/Re-split control in the transport) ──
  'player.split.title': 'Split song',
  'player.split.optionsTitle': 'Split options',
  'player.split.button': 'Split',
  'player.split.backingHint': 'Click to split for backing vocals',
  'player.split.separateBacking': 'Separate backing vocals',
  'player.split.resplitStems': 'Re-split instrument stems',
  'player.split.alreadySeparated': 'These vocals are already separated.',
  'player.split.explain':
    'Create vocals, drums, bass, guitar, piano and instruments, then split the vocals into lead and backing.',
  'player.split.hint':
    'Two steps, a few minutes each. Models are downloaded once. The lead and backing lanes are saved uncompressed — about 40 MB a minute of song, so they stay exact.',

  // ── track stack (ruler, zoom controls, add-track) ──
  'player.stack.addTrack': '+ Add track…',
  'player.stack.addTrackTitle':
    'Add an audio file as an extra lane — a backing track, a harmony you recorded, a click. It plays from 0:00 and is copied into the project when you save.',
  'player.stack.zoomOutTitle': 'Zoom out (scroll wheel works too)',
  'player.stack.zoomInTitle': 'Zoom in around the playhead',
  'player.stack.showWholeSongTitle': 'Show the whole song',
  'player.stack.full': 'Full',

  // ── track lane (the per-stem controls beside each waveform) ──
  // "Name of the Vocals track" — {track} is the stem/lane's display label
  'player.lane.nameOf': 'Name of the {track} track',
  'player.lane.renameTitle': 'Double-click to rename this track',
  'player.lane.rename': 'Rename {track}',
  'player.lane.remove': 'Remove {track} from this project (the file you added it from stays where it is)',
  'player.lane.unmute': 'Unmute',
  'player.lane.mute': 'Mute',
  'player.lane.unsolo': 'Unsolo',
  'player.lane.solo': 'Solo',
  'player.lane.volume': 'Volume',
  'player.lane.yourTurn': 'your turn',

  // ── beat grid (the draggable bar-line handles over the waveforms) ──
  'player.beatGrid.dragTitle':
    'Drag a bar line onto the beat where the bar really starts. Alt-click one you moved to hand it back to the detector.',

  // ── pitch strip (melody line + mic pitch matching) ──
  'player.pitch.micUnavailableSettings': 'Microphone unavailable while Settings is open',
  'player.pitch.sing': 'sing!',
  // e.g. "72% match"
  'player.pitch.matchPercent': '{percent}% match',
  'player.pitch.resizeTitle': 'Drag to resize the pitch view',
  // one-word row labels in the info panel: key, tempo, range, length
  'player.pitch.keyLabel': 'key',
  'player.pitch.tempoLabel': 'tempo',
  'player.pitch.rangeLabel': 'range',
  'player.pitch.lengthLabel': 'length',
  // e.g. "from C major" — the key name before a transpose was applied
  'player.pitch.fromKey': 'from {key}',
  // e.g. "reading melody… 42%"
  'player.pitch.readingMelody': 'reading melody… {percent}%',
  'player.pitch.findingBeat': 'finding the beat… {percent}%',
  'player.pitch.noteBars': 'Note bars',
  'player.pitch.noteBarsTitle':
    'One steady bar per sung note — the faint line underneath keeps the real pitch',
  'player.pitch.fit': 'Fit',
  'player.pitch.fitTitle': "Fit the pitch range to this song's melody",
  'player.pitch.micHint': 'Hear and score your pitch against the song melody',
  'player.pitch.micAriaLabel': 'Match my singing with the song melody',
  'player.pitch.micOn': 'Mic on',
  'player.pitch.micStarting': 'Starting…',
  'player.pitch.micBlocked': 'Mic blocked — check System Settings',
  'player.pitch.micMatch': 'Match my singing',

  // ── DSP graph visualization (native playback diagnostics panel) ──
  'player.dspGraph.runtimeGraph': 'Runtime graph',
  'player.dspGraph.songAndReference': 'Native song and reference graph',
  'player.dspGraph.monitorChain': 'Native monitor chain',
  'player.dspGraph.structuredUnavailable': 'Structured graph unavailable',
  'player.dspGraph.bufferPending': 'Buffer pending',
  'player.dspGraph.chooseInput': 'Choose an input',
  'player.dspGraph.chooseOutput': 'Choose an output',
  'player.dspGraph.deviceKind': 'Device',
  'player.dspGraph.analyzerKind': 'Analyzer',
  'player.dspGraph.processorKind': 'Processor',
  'player.dspGraph.routerKind': 'Router',
  'player.dspGraph.input': 'Input',
  'player.dspGraph.output': 'Output',
  'player.dspGraph.preMeter': 'Pre meter',
  'player.dspGraph.preFace': 'Pre',
  'player.dspGraph.postMeter': 'Post meter',
  'player.dspGraph.postFace': 'Post',
  'player.dspGraph.gain': 'Gain',
  'player.dspGraph.channelMap': 'Channel map',
  'player.dspGraph.mapFace': 'Map',
  'player.dspGraph.limiter': 'Limiter',
  'player.dspGraph.limitFace': 'Limit',
  'player.dspGraph.beforeProcessing': 'Before processing',
  'player.dspGraph.afterLimiter': 'After limiter',
  'player.dspGraph.preLevelLabel': 'DSP graph pre-processing level',
  'player.dspGraph.postLevelLabel': 'DSP graph post-limiter level',
  'player.dspGraph.modulesAriaLabel': 'DSP graph modules',
  'player.dspGraph.activeModulesAriaLabel': 'Active song DSP graph modules and connections',
  'player.dspGraph.activeConnectionsAriaLabel': 'Active song DSP graph connections',
  'player.dspGraph.unavailableExplain':
    'Graph details are unavailable because native playback did not provide a valid bounded composition snapshot.',
  'player.dspGraph.floatNativePath': 'Float32 native path',
  'player.dspGraph.stateRunning': 'Running',
  'player.dspGraph.stateChangingRoute': 'Changing route',
  'player.dspGraph.stateFault': 'Stopped with an error',
  'player.dspGraph.stateReady': 'Ready',
  'player.dspGraph.stateBlocked': 'Route blocked',

  // ── model.ts: fallback label for an added track with no name left after cleanup ──
  'player.track.untitled': 'Track'
}
