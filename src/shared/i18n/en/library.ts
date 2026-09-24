/* English strings for the `library` namespace — see ../index.ts. */
export const library = {
  // ── shared across the library screens ──
  'library.common.close': 'Close',
  'library.common.browseFiles': 'Browse files…',
  'library.common.yourProjects': 'Your projects',
  // fallback shown when an IPC failure carries no message of its own
  'library.common.unknownError': 'unknown error',
  'library.common.finishGoogleSignIn': 'Finish signing in to Google in your browser…',
  'library.common.syncFailed': 'Sync failed: {error}',

  // ── DropScreen (the Open/catalog screen) ──
  'library.dropScreen.cloudIcloud': 'Syncs across your devices via iCloud',
  'library.dropScreen.cloudOnedrive': 'Syncs across your devices via OneDrive',
  'library.dropScreen.cloudLocal': 'On this computer only',
  'library.dropScreen.signInFailed': 'Sign-in failed: {error}',
  'library.dropScreen.deleteFailed': 'Could not delete it: {error}',
  'library.dropScreen.justNow': 'just now',
  // relative time, e.g. "5 min ago"
  'library.dropScreen.minAgo': '{mins} min ago',
  // relative time, e.g. "3 h ago"
  'library.dropScreen.hAgo': '{h} h ago',
  'library.dropScreen.uploadingTitle': 'Uploading to Google Drive',
  'library.dropScreen.upToDateTitle': 'On Google Drive — up to date',
  // {reason}: the sync's own error text, or the "sync failed" fallback below
  'library.dropScreen.notOnDriveTitle': 'Not on Google Drive yet — {reason}',
  'library.dropScreen.syncFailedFallback': 'sync failed',
  'library.dropScreen.waitingTitle': 'Waiting to reach Google Drive',
  'library.dropScreen.reading': 'Reading…',
  // {song}: the file name being opened
  'library.dropScreen.readingSong': 'Reading “{song}”…',
  'library.dropScreen.decodingAudio': 'Decoding audio and drawing the timeline.',
  'library.dropScreen.yourCatalog': 'Your catalog.',
  // {song}: the name of the song still open behind this screen
  'library.dropScreen.catalogHint': 'Pick a project below, or drop another song anywhere in this window — “{song}” stays loaded until you do.',
  'library.dropScreen.escHint': 'or press Esc to go back to your song',
  'library.dropScreen.dropASong': 'Drop a song.',
  'library.dropScreen.dropHintDesc': 'MP3, WAV, FLAC or M4A — SingZ splits it into vocals, drums, bass & instruments you can mute while you sing.',
  'library.dropScreen.dragHint': 'or drag it anywhere into this window',
  'library.dropScreen.searchPlaceholder': 'Search projects…',
  // {cloud}: one of the cloudIcloud/cloudOnedrive/cloudLocal lines above
  'library.dropScreen.libraryLivesHere': 'Your library lives here · {cloud}',
  'library.dropScreen.change': 'Change…',
  // {msg}: the sync's own progress text (already words, not translated twice); {percent}: 0-100
  'library.dropScreen.copyingToDrive': 'Copying to your Google Drive… {msg} {percent}%',
  'library.dropScreen.driveCopyLives': 'A copy also lives in your Google Drive',
  'library.dropScreen.upToDate': 'up to date',
  'library.dropScreen.keepCopyHint': 'Keep a copy in your Google Drive, so phones can stream it',
  'library.dropScreen.syncLog': 'Sync log',
  'library.dropScreen.syncNow': 'Sync now',
  'library.dropScreen.connect': 'Connect…',
  // always plural in English, even for a single stem — kept as-is on purpose
  'library.dropScreen.stemsCount_one': '{n} stem',
  'library.dropScreen.stemsCount_other': '{n} stems',
  'library.dropScreen.noStems': 'no stems',
  // short badge word appended after the stem count, e.g. "3 stems · lyrics"
  'library.dropScreen.lyricsBadge': 'lyrics',
  // {name}: the project's name
  'library.dropScreen.deleteTitle': 'Delete “{name}” from your library',
  'library.dropScreen.deleteAria': 'Delete {name}',
  // {query}: what the singer typed into the search box
  'library.dropScreen.noMatches': 'Nothing matches “{query}”.',
  'library.dropScreen.deleteHeading': 'Delete “{name}”?',
  // {stems}: either the stemsCount text above or eraseStemsFallback; {lyrics}: eraseLyricsSuffix or nothing; {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.eraseBody': 'This erases the whole project folder — {stems}{lyrics}, your mix, transpose and Carry the line settings, {size} in all. It does not go to the Trash and it cannot be undone here.',
  // stands in for the stem count above when the project has not been split yet
  'library.dropScreen.eraseStemsFallback': 'the song',
  // appended only when the project has synced lyrics — keep the leading comma
  'library.dropScreen.eraseLyricsSuffix': ', its lyrics',
  'library.dropScreen.openSongNote': 'This is the song you have open — it keeps playing until you load another one, but there is nothing left to save it into. ',
  'library.dropScreen.driveTrashNote': 'The copy in Google Drive moves to Drive’s trash on the next sync, where it is recoverable for 30 days — your phones stop listing it.',
  'library.dropScreen.resplitNote': 'Splitting it again later means another run of the splitter.',
  'library.dropScreen.keepIt': 'Keep it',
  'library.dropScreen.deleting': 'Deleting…',
  // {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.deleteSize': 'Delete {size}',

  // ── ProjectPicker (the "Your projects" dialog) ──
  'library.projectPicker.googleSignInFailed': 'Google sign-in failed: {error}',
  'library.projectPicker.syncingToDrive': 'Syncing your projects to Drive…',
  // {uploaded}/{unchanged}: project counts
  'library.projectPicker.driveUpToDate': 'Drive is up to date — {uploaded} uploaded, {unchanged} unchanged. Your phones see them under Google Drive.',
  'library.projectPicker.movedIn_one': 'Moved in — {n} project copied over.',
  'library.projectPicker.movedIn_other': 'Moved in — {n} projects copied over.',
  'library.projectPicker.switchFailed': 'Could not switch: {error}',
  // {root}: the folder path being listed
  'library.projectPicker.looking': 'Looking in {root}…',
  // stands in for the path while it is still loading
  'library.projectPicker.defaultFolder': 'your project folder',
  // **Save project** stays bold; {root}: the library folder path, also bold
  'library.projectPicker.emptyHint': 'Nothing saved yet. Load a song and press **Save project** — it lands in **{root}** with its stems, lyrics and settings.',
  // small badge word on a project row that has split stems
  'library.projectPicker.stemsBadge': 'stems',
  // small badge word on a project row that has synced lyrics
  'library.projectPicker.lyricsBadge': 'lyrics',
  'library.projectPicker.storedIn': 'Stored in {root}',
  // {path}: a cloud folder's filesystem path
  'library.projectPicker.cloudTitle': '{path} — syncs to your other devices, including the phone app',
  // {label}: a cloud provider's name, e.g. "iCloud Drive"
  'library.projectPicker.inCloud': 'In {label} ✓',
  'library.projectPicker.useCloud': 'Use {label}',
  'library.projectPicker.gdriveConnectTitle': 'Push your projects to a SingZ folder in Google Drive — phones stream them from there, no Drive app needed',
  'library.projectPicker.syncToDrive': 'Sync to Google Drive',
  'library.projectPicker.connectDrive': 'Connect Google Drive…',
  'library.projectPicker.signOut': 'Sign out',
  'library.projectPicker.signedOut': 'Signed out of Google Drive.',
  'library.projectPicker.chooseFolder': 'Choose folder…',
  'library.projectPicker.backToDocuments': 'Back to Documents',
  'library.projectPicker.moving': 'Copying your projects over — existing files stay put…',

  // ── LibraryImport (adopt a project found outside the library) ──
  'library.libraryImport.heading': 'Add to your library',
  // {dir}/{root}: filesystem paths, both stay bold
  'library.libraryImport.body': 'This project lives in **{dir}**, outside your library. It plays and saves perfectly well there — adding it puts it in **{root}**, where the Open screen lists it and Drive sync picks it up.',
  'library.libraryImport.copyIn': 'Copy it in',
  'library.libraryImport.copyInTitle': 'Duplicate the folder into your library — the original stays where it is',
  'library.libraryImport.moveIn': 'Move it in',
  'library.libraryImport.moveInTitle': 'Relocate the folder into your library — nothing is left behind',
  'library.libraryImport.workingHint': 'Working — a project with stems is a few hundred MB, so give it a moment…',
  'library.libraryImport.copyMoveHint': 'Copying leaves the original alone, which is what you want for a folder someone else also uses. Moving takes it with you, stems and all.',

  // ── LogPanel (chrome only — the log lines themselves stay English) ──
  'library.logPanel.title': 'Log',
  'library.logPanel.whichLaunch': "Which launch's log",
  'library.logPanel.thisSession': 'This session',
  // {shown}/{total}: line counts
  'library.logPanel.linesTail': 'last {shown} of {total} lines — Save to file has them all',
  'library.logPanel.linesCount': '{n} lines',
  'library.logPanel.copy': 'Copy',
  'library.logPanel.copied': 'Copied ✓',
  'library.logPanel.saveToFile': 'Save to file…',
  'library.logPanel.loading': 'Loading…',
  'library.logPanel.nothingLogged': 'Nothing logged yet.',
  'library.logPanel.savedTo': 'Saved to {path}',

  // ── DropScreenRoute (loading / recovery states around the catalog) ──
  'library.route.eyebrow': 'Song library',
  'library.route.opening': 'Opening your songs…',
  'library.route.loadingStatus': 'Loading the song library.',
  'library.route.didntOpenHeading': 'Your song library didn’t open',
  'library.route.didntOpenBody': 'The library screen could not be loaded. Any open song and audio session remain unchanged.',
  'library.route.retry': 'Retry',
  'library.route.recoveryFailed': 'The recovery copy also could not be loaded. Restart SingZ before trying again.',
  'library.route.openSongFile': 'Open a song file',
  'library.route.stoppedHeading': 'Your song library stopped',
  'library.route.stoppedBody': 'The loaded library view encountered a problem. Restart SingZ before reopening it; any sync or delete already started may still be finishing.',
  'library.route.openLog': 'Open Log',

  // ── split-workflow (the split progress bar's stage labels) ──
  'library.splitWorkflow.warmingUp': 'Warming up',
  'library.splitWorkflow.downloadingModel': 'Downloading model',
  'library.splitWorkflow.splittingStems': 'Splitting stems',
  'library.splitWorkflow.loadingStems': 'Loading stems',
  'library.splitWorkflow.loadingVocals': 'Loading vocals',
  'library.splitWorkflow.separatingVocals': 'Separating vocals',
  // {step}: 1 or 2; {label}: one of the stage labels above
  'library.splitWorkflow.combinedLabel': '{step}/2 · {label}',

  // ── playback-error-toast ──
  // {message}: the underlying provider/engine failure text
  'library.playbackErrorToast.couldNotStart': 'Playback could not start: {message}',

  // ── audio/engine (the one status genuinely shown to the singer, as this toast) ──
  'library.engine.songUnreadable': 'This song could not be re-read from disk, so playback has nothing to play.'
}
