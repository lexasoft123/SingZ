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
  'phone.library.textOnlySuffix': ' · text only',

  // ── moving songs to Google Drive (Phase 6) ──
  'phone.library.moveBusyTitle': 'Adding songs to Google Drive',
  'phone.library.moveBusyBody': 'Stop it first, or let it finish — then the folder opens.',
  'phone.library.onItsWayTitle': 'On its way to Google Drive',
  'phone.library.onItsWayBody': 'Stop the move first, or give it a moment.',
  // progress card title while a batch runs
  'phone.library.addingASongToDrive': 'Adding a song to Google Drive',
  'phone.library.addingSongsToDrive': 'Adding songs to Google Drive',
  'phone.library.stoppingAfterFile': 'Stopping after this file…',
  // {index} and {count} are 1-based song numbers in the batch; {pct} is 0-100
  'phone.library.songOfCountPct': 'Song {index} of {count} · {pct}%',
  'phone.library.stop': 'Stop',
  // shown on a song's card while it is mid-upload
  'phone.library.movingToDrive': 'Moving to Google Drive…',
  // prefixed onto a card also held by the Drive library; keep the trailing " · "
  'phone.library.alsoInDriveSuffix': 'Also in Google Drive · ',

  // ── moving songs to Google Drive: the offer ──
  'phone.library.driveOfferTitle': 'Google Drive',
  // bare device word inside "on this {device}" — not a title, lowercase
  'phone.library.deviceIphone': 'iPhone',
  'phone.library.devicePhone': 'phone',
  // {device} = deviceIphone/devicePhone, {bytes} is an already-formatted size like "42 MB"
  'phone.library.offerLeadPartialOne':
    '1 song on this {device}, about {bytes}. It moves into your Drive library and plays from the Drive tab, already downloaded.',
  // {n} is the song count (2+, when some songs stay behind so this is not "all")
  'phone.library.offerLeadPartialOther':
    '{n} songs on this {device}, about {bytes}. They move into your Drive library and play from the Drive tab, already downloaded.',
  'phone.library.offerLeadAllOne':
    'The song on this {device}, about {bytes}. It moves into your Drive library and plays from the Drive tab, already downloaded.',
  'phone.library.offerLeadAllTwo':
    'Both songs on this {device}, about {bytes}. They move into your Drive library and play from the Drive tab, already downloaded.',
  // {n} is the song count (3+)
  'phone.library.offerLeadAllOther':
    'All {n} songs on this {device}, about {bytes}. They move into your Drive library and play from the Drive tab, already downloaded.',
  // appended sentence when some songs are not split yet; keep the leading space
  'phone.library.offerUnsplit_one': ' A song not split yet stays here.',
  'phone.library.offerUnsplit_other': ' {n} songs not split yet stay here.',
  // appended sentence when some songs are already in the Drive library; keep the leading space
  'phone.library.offerCopies_one': ' A song already in your Drive library stays here too.',
  'phone.library.offerCopies_other': ' {n} songs already in your Drive library stay here too.',
  'phone.library.addAllLocalSongs': 'Add all local songs to Google Drive',

  // ── moving songs to Google Drive: the confirm ──
  'phone.library.addConfirmTitleOne': 'Add this song to Google Drive?',
  'phone.library.addConfirmTitleTwo': 'Add both songs to Google Drive?',
  // {n} is the song count (3+)
  'phone.library.addConfirmTitleOther_one': 'Add all {n} songs to Google Drive?',
  'phone.library.addConfirmTitleOther_other': 'Add all {n} songs to Google Drive?',
  // {bytes} is an already-formatted size, {here} = hereIphone/herePhone
  'phone.library.addConfirmBodyOne':
    '{bytes} goes up. The song leaves {here} once it is safely in Drive and plays from the Drive tab instead, already downloaded. Stop at any time — until it has gone up, it stays here.',
  'phone.library.addConfirmBodyMany':
    '{bytes} goes up. Each song leaves {here} once it is safely in Drive and plays from the Drive tab instead, already downloaded. Stop at any time — whatever has not gone up stays here.',
  'phone.library.add': 'Add',
  'phone.library.addAll': 'Add all',
  // lowercase "this iPhone" / "this phone" used mid-sentence
  'phone.library.hereIphone': 'this iPhone',
  'phone.library.herePhone': 'this phone',

  // ── moving songs to Google Drive: how a batch ended ──
  'phone.library.songsCount_one': '{n} song',
  'phone.library.songsCount_other': '{n} songs',
  'phone.library.showMe': 'Show me',
  'phone.library.openDrive': 'Open Drive',
  'phone.library.ok': 'OK',
  // {message} is the raw reason two songs in a row failed for
  'phone.library.twoInARowFailed':
    'Two songs in a row could not go up ({message}) — most likely the connection dropped. Try again once you are back online.',
  'phone.library.stoppedPartWay': 'Stopped part way',
  'phone.library.notAddedYet': 'Not added yet',
  // {songs} = songsCount, {here} = hereIphone/herePhone; keep the leading blank line
  'phone.library.wentUpBeforeStopped': '\n\n{songs} went up before it stopped; the rest are still on {here}.',
  'phone.library.everythingStillOn': '\n\nEverything is still on {here}.',
  'phone.library.nothingLeftToAdd': 'Nothing left to add',
  // {here} = hereIphone/herePhone
  'phone.library.thoseSongsGone': 'Those songs are no longer on {here}.',
  'phone.library.addedToGoogleDrive': 'Added to Google Drive',
  'phone.library.nothingWentUp': 'Nothing went up',
  // one moved song, and other songs were skipped
  'phone.library.movedOneWithSkip':
    '1 song is in your Google Drive library now — already downloaded, so it plays straight away. ',
  // one moved song, and nothing was skipped
  'phone.library.movedOneNoSkip':
    'The song is in your Google Drive library now — already downloaded, so it plays straight away. ',
  // several moved songs (any count), and other songs were skipped; {n} is the moved count
  'phone.library.movedManyWithSkip_one': '{n} songs are in your Google Drive library now — already downloaded, so they play straight away. ',
  'phone.library.movedManyWithSkip_other': '{n} songs are in your Google Drive library now — already downloaded, so they play straight away. ',
  // exactly two moved songs, nothing skipped
  'phone.library.movedTwoNoSkip':
    'Both songs are in your Google Drive library now — already downloaded, so they play straight away. ',
  // three or more moved songs, nothing skipped; {n} is the moved count
  'phone.library.movedAllNoSkip_one': 'All {n} songs are in your Google Drive library now — already downloaded, so they play straight away. ',
  'phone.library.movedAllNoSkip_other': 'All {n} songs are in your Google Drive library now — already downloaded, so they play straight away. ',
  'phone.library.syncsNextTimeOne': 'Your computer adds it to its own library the next time it syncs. ',
  'phone.library.syncsNextTimeMany': 'Your computer adds them to its own library the next time it syncs. ',
  // {songs} = songsCount, {here} = hereIphone/herePhone, {reasons} = up to two skip reasons joined with "; "
  'phone.library.stayedOnPhone': '{songs} stayed on {here}: {reasons}',
  'phone.library.moreInLog': ' — and more, listed in the Log.',

  // ── moving songs to Google Drive: skip / stop reasons (also used by publish.ts) ──
  'phone.library.skipInUse': 'it was in use — open, splitting or being analysed',
  'phone.library.skipAlreadyInDrive': 'it is already in your Google Drive library',
  'phone.library.notSplitForMove': 'Split this song into stems first — then it can move to Google Drive.',
  'phone.library.signInFirstForMove': 'Sign in to Google Drive first — open the Drive tab above.',
  'phone.library.updateDesktopForMove':
    'Update SingZ on your computer first. The version syncing this Drive would remove songs it did not make, and these would be lost from Drive.',
  'phone.library.stoppedSongStill': 'Stopped — the song is still on this phone.',
  'phone.library.stoppedRestStill': 'Stopped — the rest are still on this phone.',
  'phone.library.connectionDroppedSkip': 'the connection dropped before it was up — it goes with the next "Add all"'
}
