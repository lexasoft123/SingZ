/* English strings for the `main` namespace — see ../index.ts. */
export const main = {
  // ── errors ──
  'main.error.fileNotRegistered': 'File is not registered.',
  'main.error.folderNotRegistered': 'Folder is not registered.',
  'main.error.playbackInvalidConfig': 'Native playback requires a bounded project and lane list.',
  'main.error.playbackLaneSchema': 'Native playback lanes failed strict schema validation.',
  'main.error.playbackLaneUnauthorized':
    'Every native playback lane must be authorized and supported by the proven decoder runtime.',

  // ── dialogs ──
  'main.dialog.chooseProjectsRoot': 'Choose where SingZ keeps your projects',

  // ── projects: format / library errors ──
  'main.error.notProjectFolder': 'not a project folder',
  'main.error.stemsNotConverted': 'some stems could not be converted',
  // {dir} is a filesystem path
  'main.error.notReadableProjectFolder': '{dir} is not a readable project folder.',
  'main.error.invalidGraphHash': 'project.json has an invalid graphHash.',
  // {have}/{supported} are graph document format version numbers
  'main.error.graphFormatUnsupported': 'This project uses graph format {have}; this build supports format {supported}.',
  'main.error.invalidGraphFormatOrSize': 'project.json names an invalid graph format or size.',
  'main.error.graphMissing': 'graph.json is missing.',
  'main.error.graphMismatch': 'graph.json does not match the size and md5 recorded by project.json.',
  'main.error.graphUnsupportedFormat': 'graph.json uses an unsupported format.',
  // {message} is a lower-level parser error, not itself translated
  'main.error.graphInvalid': 'graph.json is invalid: {message}',
  'main.error.notSavedProject': 'This is not a saved project.',
  // {format} is a graph document format version number
  'main.error.cannotWriteGraphFormat': 'This build cannot write graph format {format}.',
  'main.error.graphDisappeared': 'graph.json disappeared before it could be published.',
  'main.error.songMoved': 'That song is no longer where it was — reopen it and save again.',
  'main.error.leadVocalNotIssued': 'The replacement vocal was not produced by this session. Separate it again.',
  'main.error.songNotSavedYet': 'This song is not a saved project yet.',
  // {name} is the project's (song) name the singer chose
  'main.error.projectNameExists': 'A project called “{name}” already exists.',
  'main.error.folderNotInLibrary': 'That folder is not a project in your library.',
  'main.error.folderNotSavedProject': 'That folder is not a saved project.',
  'main.error.projectAlreadyInLibrary': 'This project is already in your library.',
  'main.error.projectNameAlreadyInLibrary': 'A project called “{name}” is already in your library.',

  // ── separation (splitter) ──
  'main.error.splitterNotDownloaded': 'The stem splitter has not been downloaded yet.',
  // engine descriptions shown as a tooltip (e.g. "manage splitter pack (ONNX)")
  'main.engine.onnxPack': 'splitter pack (ONNX)',
  'main.engine.cpuPackNoGpu': 'splitter pack (CPU — this pack has no GPU engine, update it in the model manager)',
  'main.engine.trtrtxPack': 'splitter pack (TensorRT RTX)',
  'main.engine.cpuPackGpuOff': 'splitter pack (CPU — the GPU engine is switched off here)',
  'main.error.separationAlreadyRunning': 'A separation is already running.',
  // {ext} is a file extension, e.g. ".m4a"
  'main.error.splitterUnsupportedFormat': 'The splitter reads WAV/MP3/FLAC/OGG — convert {ext} first.',
  // {message} is a low-level OS/process error, not itself translated
  'main.error.couldNotStartDemucs': 'Could not start demucs: {message}',
  'main.error.cancelled': 'Cancelled.',
  'main.error.notStarted': 'not started',
  'main.error.couldNotStartGpuPack': 'Could not start the GPU pack: {message}',
  'main.error.gpuEngineTooSlow': 'The GPU engine ran too slowly on this machine.',

  // ── separation: friendlyError (parsed from engine stderr) ──
  'main.error.gpuOutOfMemory': 'The graphics card ran out of memory for this model.',
  'main.error.gpuDriverHung': 'The graphics driver stopped responding while running this model (Windows reset the GPU).',
  'main.error.gpuDeviceRemoved': 'The graphics driver could not run this model (GPU device removed).',
  'main.error.splitterMissingModel':
    'The splitter is missing its model — open the model manager (splitter chip) and download it again.',
  'main.error.demucsNeedsTorchCodec':
    'This demucs install cannot read audio any more (torchaudio now needs TorchCodec). Update it (pipx upgrade demucs) or install ffmpeg (brew install ffmpeg).',
  'main.error.demucsBrokenInstall':
    'The demucs install looks broken (missing Python module). Try: pipx reinstall demucs && pipx inject demucs numpy',
  'main.error.couldNotReadAudioFile':
    'Could not read the audio file. Make sure ffmpeg is installed (brew install ffmpeg) and the file plays normally.',
  'main.error.splitterOutOfMemory': 'The splitter ran out of memory. Close other apps and try again.',
  // {tail} is the last few lines of the engine's own error output, not translated
  'main.error.separationFailed': 'Separation failed: {tail}',
  'main.error.unknownError': 'unknown error',
  // {stem} is a stem name, e.g. "vocals"
  'main.error.gpuPackNoStemFile': 'GPU pack produced no {stem} file',

  // ── model manager: model catalog labels/descriptions ──
  'main.model.splitter.label': 'Stem splitter · AI',
  'main.model.splitter.descriptionWin':
    'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — on your GPU when it can (GeForce RTX 30xx or newer; CPU otherwise).',
  'main.model.splitter.descriptionAppleSilicon':
    'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest — in seconds on the Apple Silicon GPU.',
  'main.model.splitter.descriptionGeneric':
    'Splits songs into seven tracks — lead and backing vocals, drums, bass, guitar, piano and the rest.',
  'main.model.qwenAsr.label': 'Speech model · lyrics',
  'main.model.qwenAsr.description':
    'Hears the vocals: transcribes lyrics when none are online, and checks & aligns downloaded lyrics against what is actually sung. Trained on singing, in 30 languages, with its own word aligner.',
  'main.model.aligner.label': 'Precise word aligner',
  'main.model.aligner.description':
    'Snaps every lyric word to the exact moment it is sung — the sharpest karaoke timing, in 1,100+ languages. Runs through the stem splitter.',

  // ── model manager: download errors ──
  // {status} is an HTTP status code
  'main.error.downloadFailedHttp': 'download failed (HTTP {status})',
  // {got}/{total} are megabyte amounts already formatted to one decimal
  'main.error.downloadStoppedShort':
    'the download stopped short — {got} MB of the {total} MB the server promised. Try again.',
  'main.error.downloadOverran': 'the download overran — {got} MB of the {total} MB the server promised. Try again.',
  'main.error.splitterPackIncompatible':
    'The downloaded stem splitter is not one this version can use. Your installed splitter was left alone.',
  'main.error.modelDownloadAlreadyRunning': 'A model download is already running.',

  // ── lyrics ──
  'main.error.entryNoUsableSyncedLyrics': 'That entry has no usable synced lyrics.',
  'main.error.noLinesToSave': 'There are no lines to save.',
  'main.error.couldNotSaveLyrics': 'Could not save the lyrics: {message}',
  'main.error.lyricsJobAlreadyRunning': 'A lyrics job is already running.',
  'main.error.noLinesToAlign': 'There are no lines to align.',
  'main.error.splitFirstAlign': 'Split the song into stems first — alignment listens to the vocals track.',
  'main.error.preciseNeedsPack': 'Precise alignment runs through the splitter pack — install it in the model manager first.',
  'main.error.preciseNeedsAlignerModel': 'Precise alignment needs the multilingual aligner model.',
  'main.error.couldNotDownloadAlignerModel': 'Could not download the aligner model: {message}',
  'main.error.splitFirstLyrics': 'Split the song into stems first — lyrics are read from the vocals track.',
  'main.error.lyricsEngineMissing': 'The lyrics engine is missing from this build.',
  'main.error.hearingNeedsSpeechModel': 'Hearing the vocals needs the speech model.',
  'main.error.couldNotDownloadSpeechModel': 'Could not download the speech model: {message}',
  'main.error.noSingingFound': 'No singing was found in the vocals track.',
  'main.error.couldNotMakeOutVocals':
    'Could not make out the vocals well enough to check the words. Precise alignment may still work.',
  'main.error.couldNotTimeWords': 'Could not time the words against the vocals.',
  'main.error.alignmentFailed': 'Alignment failed: {message}',
  'main.error.noWordsDetected': 'No words were detected in the vocals.',
  'main.error.couldNotTimeTranscribedWords': 'Could not time the transcribed words against the vocals.',
  'main.error.transcriptionFailed': 'Transcription failed: {message}',
  'main.error.preciseAlignmentFailed': 'Precise alignment failed: {message}',

  // ── qwen forced aligner (qwen-align.ts) ──
  'main.error.wordAlignerMissing': 'The word aligner is missing from this build.',
  'main.error.wordAlignerModelNotInstalled': 'The word aligner model is not installed.',

  // ── qwen speech server (qwen-asr.ts) ──
  'main.error.llamaServerMissing': 'The transcription engine (llama-server) is missing from this build.',
  'main.error.qwenModelNotInstalled': 'The Qwen speech model is not installed.',
  'main.error.llamaServerStopped': 'llama-server stopped before it was ready',
  // {why} is a short excerpt of the engine's own last log lines, not translated
  'main.error.llamaServerStoppedWithReason': 'llama-server stopped before it was ready: {why}',
  'main.error.llamaServerNotReadyInTime': 'llama-server did not become ready in time.',
  // {status} is an HTTP status code
  'main.error.llamaServerHttpError': 'llama-server answered HTTP {status}',

  // ── Google Drive sign-in (gdriveSignIn only — gdriveSync's own errors stay
  //    English on purpose: sync-scheduler.ts's classifySyncError pattern-matches
  //    their English text to decide retry behaviour) ──
  'main.error.driveNotConfigured': 'Google Drive is not configured in this build',
  // the page shown in the system browser right after Google's OAuth redirect
  'main.drive.signedInPageTitle': 'SingZ is signed in',
  'main.drive.signedInPageBody': 'You can close this tab and go back to the app.',
  'main.error.googleSignInCancelled': 'Google sign-in was cancelled',
  'main.error.googleSignInTimedOut': 'Google sign-in timed out',
  'main.error.googleNoTokens': 'Google did not issue tokens',

  // ── backing-vocal separation ──
  'main.error.backingVocalSeparationAlreadyRunning': 'Backing vocal separation is already running.',
  // note: no trailing period, unlike main.error.cancelled — kept distinct on purpose
  'main.error.cancelledNoDot': 'Cancelled',
  'main.error.downloadSplitterToSeparateVocals': 'Download the stem splitter to separate vocals.',
  'main.error.vocalFileChangedDuringSeparation': 'The vocal file changed during separation. Please try again.',
  'main.error.vocalFileNotRegistered': 'That vocal file is not registered.',

  // ── native audio (capture.ts): device inventory, monitoring, mic ──
  'main.error.audioProviderNotAvailable': 'The requested native audio provider is not available on this platform.',
  'main.error.nativeAudioHostUnavailable': 'Native audio host unavailable',
  'main.error.nativeAudioHostInvalidInventory': 'Native audio host returned an invalid device inventory.',
  'main.error.nativeAudioHostInventoryFailed': 'Native audio host inventory failed: {message}',
  'main.error.nativeCaptureUnavailable': 'Native capture unavailable',
  'main.error.monitorGenerationExhausted': 'The native monitor generation range is exhausted.',
  'main.error.monitorFailedToStart': 'Native headphone monitoring failed to start: {message}',
  'main.error.monitorInvalidResponse': 'Native headphone monitoring returned an invalid response.',
  'main.error.monitorGenerationInactive': 'The headphone monitor generation is no longer active.',
  'main.error.monitorGainInvalidResponse': 'Native headphone gain returned an invalid response.',
  'main.error.monitorGainFailed': 'Native headphone gain failed: {message}',
  'main.error.monitorInvalidStopResponse': 'Native headphone monitoring returned an invalid stop response.',
  'main.error.monitorFailedToStop': 'Native headphone monitoring failed to stop: {message}',
  'main.error.nativePlaybackUnavailable': 'Native playback unavailable',
  'main.error.invalidMicOwnershipGeneration': 'Invalid microphone ownership generation.',
  'main.error.nativeMicSupportUnavailable': 'Native microphone support is unavailable: {message}',
  'main.error.monitorFailedGeneric': 'Native headphone monitoring failed.',
  'main.error.monitorEndActiveFirst': 'End the active headphone monitor before starting another.',

  // ── source registration (drag/drop, file picker) ──
  // {ext} is a file extension (e.g. ".txt") or the fallback "that file"
  'main.error.cantUseFileDrop': "Can't use {ext} — drop an MP3, WAV, FLAC or M4A.",
  'main.error.cantUseFilePick': "Can't use {ext} — pick an MP3, WAV, FLAC or M4A.",
  'main.error.thatFile': 'that file',
  'main.error.notAFile': 'That is not a file.',
  'main.error.couldNotReadFile': 'Could not read that file.',

  // ── training microphone (audio-input.ts) ──
  'main.error.audioInputNoResult': 'audio-input inventory returned no result',
  'main.error.audioInputUnsupportedFormat': 'audio-input inventory has an unsupported format',
  // {index} is a 1-based device number
  'main.error.audioInputDeviceMalformed': 'audio-input inventory device {index} is malformed',
  'main.error.audioInputCoreMissing': 'The native audio-input core is not in this build.',
  'main.error.anotherTrainingMicStarting': 'Another training microphone is starting.',
  'main.error.anotherTrainingMicActive': 'Another training microphone is active.',
  'main.error.micAccessBlocked':
    'Microphone access is blocked. Allow SingZ in System Settings › Privacy & Security › Microphone, then try again.',
  'main.error.noMicrophoneAvailable': 'No microphone is available.',
  'main.error.micTookTooLongToStart': 'The microphone took too long to start.',
  'main.error.couldNotStartMicrophone': 'Could not start the microphone: {message}',
  'main.error.micDidNotConfirmStop': 'The native microphone did not confirm that it stopped.',
  'main.error.invalidMicFallback': 'Invalid microphone fallback.'
}
