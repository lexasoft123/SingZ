/* English phone strings for the `phone.library` namespace — see ../index.ts. */
export const library = {
  // ── add-song errors ──
  // shown when the system file picker returns a file the app then fails to open; {msg} is the raw error text
  'phone.library.pickFailed': "That file couldn't be opened ({msg})",
  'phone.library.folderInactive': 'The picked folder is no longer active. Reopen it and try again.',
  'phone.library.folderIdentityUnavailable':
    'The picked folder identity is unavailable. Reopen the folder and try again.',
  // {error} is the raw picker error text
  'phone.library.folderPickerError': 'Folder picker: {error}',
  // thrown when a native write of project.json silently reports failure; can reach the error banner from any card action that saves
  'phone.library.projectDocumentNotWritten': 'Project document was not written.',
  // thrown when a pick's decode races a 90s deadline and loses; reaches the screen via findLyricsFor's and the add flow's error banners
  'phone.library.decodeTimeout': 'it did not open within 90 seconds',

  // ── forget / free space ──
  // confirm dialog when long-pressing a downloaded song to drop its local files; {size} e.g. "42 MB"
  'phone.library.forgetBody':
    'Remove {size} from this phone? The song stays in your library — opening it again downloads it back.',
  'phone.library.keepIt': 'Keep it',
  'phone.library.remove': 'Remove',
  'phone.library.freeUpSpace': 'Free up space',
  'phone.library.freeUpSpaceBody':
    'Delete {size} of downloaded songs? They stay in your library — you can download them again whenever you have signal.',
  'phone.library.keepThem': 'Keep them',
  'phone.library.delete': 'Delete',

  // ── opening a song ──
  'phone.library.opening': 'Opening…',
  // decoding the bundled sample's lanes one at a time; {id} is a stem name (e.g. "vocals", left untranslated), {i}/{n} = progress
  'phone.library.decoding': 'Decoding {id} · {i}/{n}',
  // loading-card step text while opening a song; {id} is a stem name or an added track's own label, {i}/{n} = progress
  'phone.library.fetchingStep': 'Fetching {id} · {i}/{n}',
  'phone.library.decodingStep': 'Decoding {id} · {i}/{n}',
  'phone.library.lyricsStep': 'Lyrics…',
  'phone.library.fetchingLyricsStep': 'Fetching lyrics…',
  // thrown when a song's decoded audio would exceed this phone's memory budget; {gb} is already formatted, e.g. "1.4"
  'phone.library.songTooBigToPlay':
    'This song needs about {gb} GB of memory to play — too long for this phone. Try a shorter song, or split it up on the computer.',
  // thrown when one of the singer's own added tracks fails to decode; {label} is the track's own name, {detail} the raw decode error
  'phone.library.addedTrackLoadFailed':
    'Could not load the added track "{label}". The song was not opened because every saved lane must be available. {detail}',

  // ── lyrics lookup from the card ──
  'phone.library.lookingForLyrics': 'Looking for lyrics…',
  'phone.library.noLyricsYet': 'No lyrics yet',
  'phone.library.lyricsServiceDown': "The lyrics service didn't answer — try again later.",
  'phone.library.lyricsNoMatch': 'Nothing matched this title. Lyrics can also be added on the computer.',

  // ── beat models (Better beats) ──
  'phone.library.betterBeats': 'Better beats',
  'phone.library.downloadBeatModelsTitle': 'Download the beat models?',
  // {mb} is a number of megabytes
  'phone.library.downloadBeatModelsBody': '{mb} MB, once. Every song analysed afterwards uses them.',
  'phone.library.notNow': 'Not now',
  'phone.library.download': 'Download',
  'phone.library.couldNotDownloadBeatModels': 'Could not download the beat models',
  'phone.library.downloadingBeatModels': 'Downloading the beat models — {got} of {total} MB',
  'phone.library.betterBeatsOfferBody':
    'An {mb} MB download, once, that hears the beat through quiet intros and rubato the drums alone lose. Songs that already have a grid keep it.',
  'phone.library.cancel': 'Cancel',
  // splitter model download waiting on the beat models' own download first; {mb} = splitter size
  'phone.library.waitingThenSplitter': 'Waiting for the beat models to finish — then the splitter ({mb} MB, once)',
  'phone.library.downloadingSplitter': 'Downloading the splitter — {got} of {total} MB, once',
  // the bundled sample's card title; {name} is the sample song's name
  'phone.library.sampleTitle': 'Sample — {name}',

  // ── splitting a song into stems ──
  'phone.library.readingTheSong': 'Reading the song…',
  'phone.library.warmingUp': 'Warming up…',
  'phone.library.splittingChunk': 'Splitting into stems — chunk {done} of {total}',
  'phone.library.splittingEllipsis': 'Splitting into stems…',
  'phone.library.splitFailed': 'The split failed',
  'phone.library.splitNeverStarted': 'The split never started — try again',
  'phone.library.splitInterrupted': 'The split was interrupted',
  'phone.library.tooBigToSplitTitle': 'This song is too big to split here',
  'phone.library.starting': 'Starting…',
  'phone.library.couldNotStartSplitTitle': 'Could not start the split',
  // thrown when this build has no split-job native surface (an old app, or a platform not yet wired up)
  'phone.library.splittingNotAvailable': 'Splitting is not on this phone yet',
  // thrown when iOS refuses a new split because a stalled one still holds the engine
  'phone.library.splitEngineHeldCopy':
    'The last split is still stuck on this phone. Close SingZ completely and open it again, then split.',
  'phone.library.splitThisSongTitle': 'Split this song?',
  'phone.library.splitThisSongBody':
    'The phone separates it into vocals, drums, bass and more — a few minutes of work, and a one-time 136 MB download the first time.',
  // appended to splitThisSongBody when starting this split discards another song's failed one; {name} is that song's title
  'phone.library.failedSplitDiscarded': '\n\nThe failed split of "{name}" will be discarded.',
  'phone.library.splitButton': 'Split',
  'phone.library.almostDoneSplittingTitle': 'Almost done splitting',
  'phone.library.almostDoneSplittingBody': 'This song is being finished — delete it in a moment.',
  'phone.library.finishingUp': 'Finishing up…',
  'phone.library.stopping': 'Stopping…',
  'phone.library.resume': 'Resume',
  'phone.library.discard': 'Discard',
  'phone.library.splitUnavailableBusy': 'Split — unavailable while another split is still working',
  // {name} is the song's title
  'phone.library.splitInto': 'Split {name} into stems',
  'phone.library.notSplitYet': 'not split yet',
  // shown on a failed-split card whose song has failed twice on this phone
  'phone.library.keepsFailingCopy':
    'This song keeps failing on this phone. Add it on your computer instead — it will sync over ready to sing.',
  // shown when the failure looks like a bad file rather than a phone limit
  'phone.library.fileFailingCopy':
    "This phone couldn't read this song's file. Try another copy of it — or add it on your computer, and it will sync over ready to sing.",
  // stem-count badge on a split song's card; e.g. "6 stems"
  'phone.library.stemsCount_one': '{n} stem',
  'phone.library.stemsCount_other': '{n} stems',
  // appended after the stem count when the singer added their own tracks; keep the leading " · "
  'phone.library.addedSuffix': ' · {n} added',
  // appended when the song has synced lyrics; keep the leading " · "
  'phone.library.lyricsSuffix': ' · lyrics',
  // appended to a WAV project's meta line, hinting the desktop can shrink it to FLAC; keep the leading " · "
  'phone.library.updateOnDesktop': ' · update on desktop',

  // ── delete ──
  'phone.library.deleteThisSongTitle': 'Delete this song?',
  // {name} is the song's title
  'phone.library.deleteThisSongBody': '"{name}" and its files go away.',

  // ── header / nav ──
  'phone.library.openSettings': 'Open Settings',
  'phone.library.settings': 'Settings',
  'phone.library.openLog': 'Open the log',
  'phone.library.log': 'Log',
  'phone.library.driveTab': 'Drive',
  'phone.library.folderTab': 'Folder',
  'phone.library.thisIphone': 'This iPhone',
  'phone.library.thisPhone': 'This phone',

  // ── source descriptions (the banner under the three tabs) ──
  'phone.library.driveSrcTitle': 'Your desktop’s library, synced through Drive',
  'phone.library.folderSrcTitle': 'A shared folder this phone can read',
  'phone.library.songsAddedIphone': 'Songs added on this iPhone',
  'phone.library.songsAddedPhone': 'Songs added on this phone',
  'phone.library.noSignalLastSync': 'No signal — showing your last sync',
  'phone.library.signedInToDrive': 'Signed in to Google Drive',
  'phone.library.signOut': 'Sign out',
  'phone.library.signInToSeeIt': 'Sign in to see it',
  'phone.library.signIn': 'Sign in',
  'phone.library.noFolderPicked': 'No folder picked yet',
  'phone.library.change': 'Change…',
  'phone.library.filesCopiedIphone': 'Files you copied onto this iPhone',
  'phone.library.filesCopiedPhone': 'Files you copied onto this phone',
  'phone.library.addASong': 'Add a song',
  // thrown when this build has no Google OAuth client configured; reaches the screen via the sign-in/listing error banner
  'phone.library.driveNotConfigured': 'Google Drive is not configured in this build',
  'phone.library.driveNotSignedIn': 'Not signed in to Google Drive',
  'phone.library.driveSessionExpired': 'Google Drive session expired — sign in again',
  'phone.library.driveNoSingzFolder':
    'No SingZ folder in this Google Drive yet — sync a project from the desktop first',

  // ── crash note banner ──
  // {note} is a phrase describing what the app was doing when it last crashed
  'phone.library.lastOpenCrashed': 'The last open crashed while {note}.',
  'phone.library.openLogToReport': 'Open the log to report this',
  'phone.library.report': 'Report',
  'phone.library.dismissCrashNotice': 'Dismiss the crash notice',
  // {error} is the error text already shown in the banner
  'phone.library.tapToDismiss': '{error}. Tap to dismiss.',

  // ── card ──
  'phone.library.opensTheSong': 'Opens the song.',
  'phone.library.stopOpeningSong': 'Stop opening this song',
  'phone.library.onThisPhone': 'On this phone',
  // {size} e.g. "42 MB"
  'phone.library.notDownloadedSize': 'Not downloaded, {size}',
  'phone.library.notDownloaded': 'Not downloaded',
  // {title} is the song's title
  'phone.library.detectBeatAgainFor': 'Detect the beat again for {title}',
  'phone.library.findLyricsFor': 'Find lyrics for {title}',
  'phone.library.deleteFromPhone': 'Delete {title} from this phone',
  'phone.library.removeDownloadedFiles': "Remove {title}'s downloaded files",

  // ── list groups / empty states ──
  'phone.library.ready': 'Ready',
  'phone.library.notReadyYet': 'Not ready yet',
  'phone.library.bundledAlwaysAvailable': 'bundled · always available',
  'phone.library.loadingFromDrive': 'Loading your library from Google Drive…',
  'phone.library.loadingEllipsis': 'Loading…',
  // {query} is what the singer typed into the search box; keep the curly quotes
  'phone.library.noSongCalled': 'No song here is called “{query}”.',
  'phone.library.noSongsIphone':
    'No songs on this iPhone yet. Add one above — it plays straight away, and can be split into stems here.',
  'phone.library.noSongsPhone':
    'No songs on this phone yet. Add one above — it plays straight away, and can be split into stems here.',
  'phone.library.driveEmptySignedIn':
    'Nothing in your Google Drive library yet. Save a song on your computer and it syncs over.',
  'phone.library.driveEmptySignedOut': 'Sign in above to see the songs your computer put in Google Drive.',
  'phone.library.folderEmptyIos':
    'No projects in this folder. Save one on your computer into the shared folder (iCloud Drive/SingZ), or pick a different folder above.',
  'phone.library.folderEmptyAndroid':
    'No projects in this folder. Copy project folders from your computer onto this phone, or pick a synced folder above.',
  // downloaded-songs storage line above "Free up space"; {size} e.g. "1.2 GB"
  'phone.library.storage_one': '{n} song on this phone · {size} — playable without internet',
  'phone.library.storage_other': '{n} songs on this phone · {size} — playable without internet',

  // ── search ──
  'phone.library.findASong': 'Find a song',
  'phone.library.findASongLabel': 'Find a song by name',
  'phone.library.clearSearch': 'Clear the search',

  // ── add-song sheet ──
  'phone.library.addSongCancelA11y': 'Cancel adding this song',
  'phone.library.addingToPhone': 'Adding it to this phone…',
  'phone.library.copyingFile': 'Copying the file — a few seconds for a normal song.',
  'phone.library.unreadableFile':
    "This file can't be played on this phone — it may be a format SingZ doesn't read. The Log has the details.",
  'phone.library.close': 'Close',
  'phone.library.titleLabel': 'Title',
  'phone.library.songTitlePlaceholder': 'Song title',
  'phone.library.artistLabel': 'Artist',
  'phone.library.artistPlaceholder': 'Helps find the right lyrics',
  // duration + file name under the title/artist fields; {mins} and {secs} are already formatted numbers, {name} the file name
  'phone.library.addSongDuration': '{mins}:{secs} — {name}',
  'phone.library.findLyricsButton': 'Find lyrics',
  'phone.library.addWithoutLyrics': 'Add without lyrics',
  'phone.library.syncedLyricsFound': 'Synced lyrics found',
  'phone.library.useTheseLyrics': 'Use these lyrics',
  'phone.library.skip': 'Skip',
  'phone.library.editTitle': 'Edit title',
  // {n} more lines below the preview
  'phone.library.moreLines': '…{n} lines',
  'phone.library.lyricsServiceDownStillAdds':
    "The lyrics service didn't answer — the song still adds fine, and lyrics can be found later from its card.",
  'phone.library.tryAgain': 'Try again',
  'phone.library.noExactMatch': 'No exact match.',
  'phone.library.closeMatches': 'Close matches:',
  'phone.library.searchAgain': 'Search again',
  // appended to a lyrics candidate's duration; keep the leading " · "
  'phone.library.syncedSuffix': ' · synced',
  'phone.library.textOnlySuffix': ' · text only'
}
