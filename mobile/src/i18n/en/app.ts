/* English phone strings for the `phone.app` namespace — see ../index.ts. */
export const app = {
  // ── bottom tabs (App.tsx tab screens + ui/BottomTabs.tsx fallback labels) ──
  'phone.app.tab.songs': 'Songs',
  'phone.app.tab.train': 'Train',

  // ── root navigator (ui/RootNavigator.tsx) ──
  // Alert title shown when a metronome edit could not be written to disk.
  'phone.app.metronomeNotSaved': 'Metronome setting was not saved',

  // ── settings screen (ui/SettingsScreen.tsx) ──
  'phone.app.settings.title': 'Settings',
  'phone.app.settings.checking': 'Checking native playback…',
  'phone.app.settings.closeA11y': 'Close Settings',
  'phone.app.settings.done': 'Done',
  // section header, all caps by design
  'phone.app.settings.sectionAudio': 'AUDIO',
  'phone.app.settings.nativePlaybackName': 'Native playback',
  // small badge next to the feature name, all caps by design
  'phone.app.settings.nativePlaybackBadge': 'DEFAULT',
  'phone.app.settings.nativePlaybackDescription':
    'Play eligible stem and added-track projects through zcore + zdsp. Native playback includes transport, pitch, tempo, loop, metronome, count-in and training; unsupported file formats stay on the regular player.',
  'phone.app.settings.unsupportedPlatform': 'Native playback is unavailable on this platform.',
  'phone.app.settings.nativePlaybackA11y': 'Native playback',
  'phone.app.settings.nativePlaybackNote':
    'Eligible songs use the ordinary player controls with native DSP underneath. Other songs remain entirely on the regular player.',

  // ── log panel chrome (ui/LogPanel.tsx) — log LINES themselves stay English ──
  'phone.app.log.title': 'Log',
  'phone.app.log.lines_one': '{n} line',
  'phone.app.log.lines_other': '{n} lines',
  'phone.app.log.share': 'Share',
  'phone.app.log.shareA11y': 'Share the log',
  'phone.app.log.clear': 'Clear',
  'phone.app.log.clearA11y': 'Clear the log',
  'phone.app.log.close': 'Close',
  'phone.app.log.closeA11y': 'Close the log',
  'phone.app.log.confirmTitle': 'Clear the log?',
  'phone.app.log.confirmBody': 'This is the only record of what the app has done.',
  'phone.app.log.keepIt': 'Keep it',
  'phone.app.log.empty': 'Nothing logged yet.',

  // ── training cue errors (engine.ts playTrainingCues) — read out by
  //    ui/TrainingScreen.tsx when a reference tone or training cue fails ──
  'phone.app.engine.pausedInBackground': 'Audio is paused while SingZ is in the background.',
  'phone.app.engine.outputOwnedBySong': 'Song playback currently owns the iPhone audio output.',
  'phone.app.engine.cueCancelled': 'Training cue was cancelled.',

  // ── native playback status (playback/native.ts settingsStatus(), read by
  //    ui/SettingsScreen.tsx as the status line under the toggle) ──
  'phone.app.native.status.unavailablePlatform': 'Native playback is unavailable on this platform.',
  'phone.app.native.status.noBridge': 'This build does not contain the native playback bridge.',
  'phone.app.native.status.missingCapability':
    'The linked native runtime is missing a required playback capability.',
  // {message} is the caught error's own text
  'phone.app.native.status.failed': 'Native status failed: {message}',

  // ── native playback load/prepare failures (playback/native.ts load()),
  //    surfaced by ui/CatalogScreen.tsx's error banner when opening a song ──
  'phone.app.native.cleanupBlockedLegacy':
    'Native playback cleanup is uncertain. Legacy playback remains blocked.',
  'phone.app.native.cleanupNextNotOpened':
    'Native playback cleanup is uncertain. The next song was not opened.',
  // {message} is the caught error's own text
  'phone.app.native.prepareFailed': 'Native prepare failed: {message}',
  // {message} is the native core's own refusal text
  'phone.app.native.prepareRefused': 'Native prepare refused the song: {message}',
  // {message} is the caught error's own text
  'phone.app.native.prepareStatusFailed': 'Native prepare status failed: {message}',
  'phone.app.native.prepareInconsistent': 'Native prepare returned inconsistent session status.',
  // internal state also compared with === elsewhere in native.ts; keep in
  // sync if this value's shape ever changes
  // {reason} is a short internal cause (e.g. "cancelled prepare")
  'phone.app.native.cleanupUncertain':
    'Native playback cleanup is uncertain ({reason}). Legacy fallback was blocked to prevent overlapping audio owners.',
  // {detail} is the caught error's own text
  'phone.app.native.suspendLegacyFailed':
    'Native playback could not suspend legacy output before claiming the audio session: {detail}',
  'phone.app.native.noOutput': 'No native audio output is available.',
  'phone.app.native.unavailable': 'Native playback is unavailable.',
  'phone.app.native.focusLost':
    'Native audio stopped because Android changed audio focus or the output route. Tap Play to retry.',
  // {reason} is a short internal cause reported by the native session
  'phone.app.native.stoppedReasonRetry': 'Native audio stopped: {reason}. Tap Play to retry.',
  // {reason} is a short internal cause; the sentence continues with a fixed tail
  'phone.app.native.outputDidNotOpen':
    'Native output did not open: {reason}. Playback remains stopped on the native backend.',
  'phone.app.native.unloadUncertainPublished':
    'Native unload is uncertain; native ownership remains published.',
  'phone.app.native.unloadUncertainNotStarted':
    'Native unload is uncertain; another playback backend was not started.',
  'phone.app.native.unloadUncertainBlocked':
    'Native unload is uncertain; native ownership remains blocked.',
  'phone.app.native.outputStreamNotReleased':
    'The native output stream could not be released after the background park.',

  // ── native playback loading progress (playback/native.ts materializeNativeProject,
  //    read by ui/CatalogScreen.tsx's loading banner while a song opens) ──
  'phone.app.native.progress.releasingLastSong': 'Releasing the last song…',
  'phone.app.native.progress.buildingGraph': 'Building the audio graph…',
  // {label} is a track/lane name (already resolved and translated elsewhere), {index}/{count} are 1-based
  'phone.app.native.progress.fetchingTrack': 'Fetching {label} · {index}/{count}',
  'phone.app.native.progress.fetchingLyrics': 'Fetching lyrics…'
}
