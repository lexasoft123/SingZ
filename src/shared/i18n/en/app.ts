/* English strings for the `app` namespace — see ../index.ts. */
export const app = {
  // ── lazy dialog route copy (LibraryImport / LogPanel / ProjectPicker / SetupModal) ──
  // read through getters on the route object, so they translate at every
  // render rather than freezing at module load — see App.tsx's route setup.
  'app.dialog.libraryImport.name': 'Add to your library',
  'app.dialog.libraryImport.opening': 'Opening library options…',
  'app.dialog.libraryImport.failureTitle': 'Library options didn’t open',
  'app.dialog.libraryImport.failureMessage': 'The library options could not be loaded. The project stays where it is.',
  'app.dialog.logPanel.name': 'Log',
  'app.dialog.logPanel.opening': 'Opening the log…',
  'app.dialog.logPanel.failureTitle': 'Log didn’t open',
  'app.dialog.logPanel.failureMessage': 'The log viewer could not be loaded. SingZ is still running.',
  'app.dialog.projectPicker.name': 'Projects',
  'app.dialog.projectPicker.opening': 'Opening your projects…',
  'app.dialog.projectPicker.failureTitle': 'Projects didn’t open',
  'app.dialog.projectPicker.failureMessage': 'Your project library could not be loaded. No projects were changed.',
  'app.dialog.setupModal.name': 'Stem splitting setup',
  'app.dialog.setupModal.opening': 'Opening stem splitting setup…',
  'app.dialog.setupModal.failureTitle': 'Setup didn’t open',
  'app.dialog.setupModal.failureMessage': 'Stem splitting setup could not be loaded. The player is still available.',

  // ── titlebar / section nav ──
  'app.titlebar.sections': 'SingZ sections',
  'app.titlebar.songs': 'Songs',
  'app.titlebar.training': 'Vocal training',
  'app.titlebar.catalogBack': 'Back to your song (Esc)',
  'app.titlebar.catalogBrowse': 'Browse your project library — this song stays loaded',
  'app.titlebar.catalog': 'Catalog',
  'app.titlebar.renameProject': 'Rename song and project folder',
  'app.titlebar.renameSong': 'Rename song',
  'app.titlebar.logTooltip': 'What the app is doing under the hood — copy or save it when reporting a problem',
  'app.titlebar.log': 'Log',
  // the desktop Settings gear button — title AND aria-label both use this
  'app.titlebar.settings': 'Settings',

  // ── update chip ──
  'app.update.restartTitle': 'The update is downloaded — restarting installs it',
  'app.update.restart': 'Restart to update',
  'app.update.availableTitle': 'A newer version is out — opens the download page',
  // {version} is the app version number, e.g. "0.23.3"
  'app.update.get': 'Get v{version}',
  'app.update.downloadingTitle': 'Downloading the update in the background',
  // {percent} is a 0-100 whole number
  'app.update.downloading': 'update {percent}%',

  // ── save / library ──
  'app.save.tooltipProject': 'Save stems, lyrics and settings into this project folder',
  'app.save.tooltipLibrary': 'Save song, stems, lyrics and settings into your project library',
  'app.save.saved': 'Saved ✓',
  'app.save.saving': 'Saving…',
  'app.save.save': 'Save project',
  'app.save.unsavedTitle': 'Unsaved changes',
  'app.library.addTooltip': 'This project sits outside your library — copy or move it in',
  'app.library.add': 'Add to library…',
  'app.library.open': 'Open…',

  // ── engine/splitter status chip ──
  'app.engine.checking': 'checking splitter…',
  // {command} is the splitter binary's own name/version string
  'app.engine.manageTitle': '{command} — click to manage AI models',
  'app.engine.ready': 'splitter ready',
  'app.engine.setup': 'splitter setup',

  // ── vocal training empty states ──
  'app.training.loading': 'Loading your practice profile…',
  'app.training.unavailable': 'Practice profile unavailable',
  'app.training.unavailableBody': 'Your saved training data was not changed. Retry when storage is available.',
  'app.retry': 'Retry',
  // {error} is the raw error text from the failed save
  'app.training.saveError': 'Training profile or session history was not saved: {error}',

  // ── drag & drop ──
  'app.drop.release': 'Release to load',

  // ── analysis progress labels (HUD) ──
  'app.analysis.readingMelody': 'Reading the melody',
  'app.analysis.findingBeat': 'Finding the beat',

  // ── playback output/route toasts ──
  "app.output.confirmDenied": "SingZ wasn't allowed to confirm the playback route — choose an output or retry",
  'app.output.missingDefault': 'Saved playback device not connected — using the system default',
  "app.output.switchDenied": "SingZ wasn't allowed to switch playback devices — still on the previous one",
  'app.output.switchFailed': 'Could not switch to that device — still on the previous one',

  // {message} is the monitor's own status text
  'app.monitor.stopped': 'Headphone monitoring stopped: {message}',

  // native engine rejected a live control change and the UI rolled back — {error} is the raw error text
  'app.native.beatNotApplied': 'The native beat-grid update was not applied: {error}',
  'app.native.metronomeNotApplied': 'The native metronome update was not applied: {error}',
  'app.native.transposeNotApplied': 'The native transpose update was not applied: {error}',
  'app.native.loopNotApplied': 'The native loop update was not applied: {error}',
  'app.native.tempoNotApplied': 'The native tempo update was not applied: {error}',
  'app.native.trainingNotApplied': 'The native training update was not applied: {error}',

  // ── first-run / model wizard ──
  'app.wizard.qwenNotice':
    'Lyrics transcription and Check & align now use Qwen3-ASR, a speech model trained on singing — it hears sung words markedly better than the old one. Get it below when it suits you; the old model is removed once it is in.',

  // ── song open progress ──
  'app.load.opening': 'Opening…',
  // {label} is the singer's own name for the added track
  'app.load.laneMissing': '“{label}” could not be read — that lane is missing from the mix.',
  'app.load.readingStems': 'Reading the stems…',
  'app.load.drawingWaveforms': 'Drawing the waveforms…',
  // {list} is the silent stem names joined with "and", e.g. "guitar and piano"
  'app.load.silentStems_one': 'Split into six stems — {list} is silent in this song, so its lane is hidden.',
  'app.load.silentStems_other': 'Split into six stems — {list} are silent in this song, so their lanes are hidden.',
  'app.load.startingPlayback': 'Starting playback…',
  // {message} is the graph loader's own error text
  'app.load.graphError': 'Could not load this project’s DSP graph. {message}',
  'app.load.decodeFailed': 'Could not decode that audio file.',

  // ── file/track errors ──
  'app.file.resolveFailed': 'Could not resolve that file on disk.',
  // {name} is the file's own name
  'app.tracks.decodeFailed': 'Could not decode {name} — try an MP3, WAV, FLAC or M4A.',
  // {names} is the added tracks' labels joined with ", "; {end} is a formatted time like "3:42"
  'app.tracks.addedExtends':
    'Added {names} — it starts at 0:00 and runs past the song, so the timeline now ends at {end}. Save the project to keep it.',
  'app.tracks.addedAligned': 'Added {names} — it starts at 0:00, alongside the stems. Save the project to keep it.',

  // ── splitting ──
  'app.split.rereadFailed': 'That song could not be re-read for splitting. Try opening it again.',
  'app.split.loadStemsFailed': 'Separation finished, but loading the stem files failed.',
  // the auto-created lane name for a separated backing-vocal harmony
  'app.split.backingVocalsLabel': 'Backing vocals',
  'app.split.backingReady':
    'Lead and backing vocals are ready. The melody now follows the lead. Save the project to keep both lanes; overlapping harmonies may still remain.',
  'app.beat.notFound': 'No steady beat found — tap the tempo instead.',

  // ── project save/import/rename ──
  // {dir} is the project's folder path
  'app.project.saved': 'Saved to {dir}',
  // {names} is the lost custom-track labels joined with ", "
  'app.project.savedMissingFile':
    'Saved to {dir} — but {names} could not be copied in (the file is no longer where you added it from).',
  "app.project.savedDriveSignedOut":
    "Saved to {dir} — Google Drive is signed out on this computer, so your phones won't see this until you sign in (Open… screen).",
  'app.project.saveFailed': 'Could not save the project: {error}',
  'app.project.moved': 'Moved into your library — the project now lives in {dir}',
  'app.project.copied': 'Copied into your library — {dir}. The original folder is untouched.',
  'app.project.renamed': 'Renamed — the project folder is now {dir}'
}
