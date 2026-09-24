/* English strings for the `settings` namespace — see ../index.ts. */
export const settings = {
  // ── shared actions/labels, reused across dialogs in this namespace ──
  'settings.action.close': 'Close',
  'settings.common.systemDefault': 'System default',
  'settings.common.savedDeviceMissing': 'Saved device (not connected)',

  // ── SettingsModal: shell ──
  'settings.title': 'Settings',
  'settings.tab.audio': 'Audio',
  'settings.devicesLoading': 'Looking for audio devices…',
  'settings.inputLabelsHiddenHint': 'Allow microphone access in System Settings to see device names.',
  'settings.nonDefaultSpeakerTip': 'Tip: on a non-default speaker, sing with headphones — echo cancellation only tracks the system default output.',

  // ── SettingsModal: playback output device ──
  'settings.output.label': 'Playback device',
  'settings.output.confirming': 'Confirming the playback route…',
  // fallback status text when there is no more specific route error to show
  'settings.output.unconfirmedFallback': 'Playback route is unconfirmed.',
  'settings.output.retrying': 'Retrying…',
  'settings.output.retryRoute': 'Retry output route',
  'settings.output.unconfirmedStatus': 'Playback route could not be confirmed — choose an output or retry',
  'settings.output.stillUnconfirmed': 'Route is still unconfirmed. You can retry again.',
  'settings.output.retryBlocked': 'Playback route retry could not start until audio cleanup is confirmed.',

  // ── SettingsModal: native DSP playback checkbox ──
  'settings.playback.useNativeLabel': 'Use native DSP playback',
  'settings.playback.hint': "Uses the selected native provider when the song's features exactly match the native graph.",

  // ── SettingsModal: Windows audio provider ──
  'settings.windows.providerLabel': 'Windows audio provider',
  // "WASAPI" is the Windows audio API's own name, kept as-is
  'settings.windows.wasapiOption': 'System audio (WASAPI)',
  // {detail} is a technical reason string reported by the OS, not translated
  'settings.windows.asioUnavailable': 'ASIO unavailable: {detail}',

  // ── SettingsModal: microphone strip ──
  'settings.mic.label': 'Microphone',
  'settings.mic.channelLabel': 'Input channel',
  'settings.mic.monoInput': 'Mono input · channel 1',
  'settings.mic.levelLabel': 'Input level',
  // aria-label for the level meter under the mic preview
  'settings.mic.channelLevelAriaLabel': 'Selected microphone channel level',
  // shown while the mic preview is still connecting
  'settings.mic.startingPreview': 'Starting microphone preview…',
  'settings.mic.usedByMonitoring': 'Used by headphone monitoring',
  'settings.mic.unavailableTrainingCleanup': 'Unavailable while Vocal training audio cleanup is unresolved.',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': 'No signal on channel {channel}',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '{dbfs} dBFS on channel {channel}',
  'settings.mic.pausedByOtherOwner': 'Microphone preview is paused by another app audio owner.',
  'settings.mic.pausedByMonitoring': 'Microphone preview is paused while headphone monitoring is active.',
  // {device} is the microphone's label, {channel}/{count} are 1-based channel numbers
  'settings.mic.listeningThrough': 'Listening through {device} · channel {channel} of {count}',
  // fallback device name when the microphone has no label
  'settings.mic.theMicrophoneFallback': 'the microphone',
  'settings.mic.previewOpening': 'Microphone preview is opening.',
  'settings.mic.fallbackWarning': 'The saved microphone is unavailable — previewing the system default.',
  // {channel} is a 1-based channel number
  'settings.mic.channelFallbackWarning': 'That lane is unavailable — previewing channel {channel}.',
  // {reason} is a short technical explanation reported by the OS
  'settings.mic.fallbackNotice':
    'Using browser microphone capture instead of native capture. {reason} Browser capture may expose fewer input channels. Active input: {label}, channel {channel} of {count}.',
  // fallback label when the active input device has no name
  'settings.mic.fallbackDeviceLabel': 'microphone',
  'settings.mic.nativeCapture': 'Native microphone capture',
  // {error} is a technical reason string reported by the OS
  'settings.mic.nativeUnavailable': 'Native microphone capture unavailable: {error} Browser capture may expose fewer input channels.',

  // ── SettingsModal: headphone monitoring section ──
  'settings.monitor.heading': 'Headphone monitoring',
  'settings.monitor.subheading': 'Hear this mic through the native DSP graph',
  'settings.monitor.experimentalBadge': 'Experimental',
  'settings.monitor.nativeInputLabel': 'Native monitoring input',
  'settings.monitor.chooseNativeDevice': 'Choose an exact native device…',
  'settings.monitor.savedInputMissing': 'Saved native input (not connected)',
  'settings.monitor.osUidHint': 'This is an OS audio UID. SingZ never matches it from a Chromium device name.',
  'settings.monitor.outputLabel': 'Audio interface playback',
  'settings.monitor.choosePlaybackDevice': 'Choose playback device…',
  'settings.monitor.savedOutputMissing': 'Saved native output (not connected)',
  'settings.monitor.micChannelLabel': 'Mic channel',
  'settings.monitor.playbackLeft': 'Playback L',
  'settings.monitor.playbackRight': 'Playback R',
  'settings.monitor.playbackGeneric': 'Playback',
  'settings.monitor.playbackLeftChannel': 'Playback left channel',
  'settings.monitor.playbackRightChannel': 'Playback right channel',
  'settings.monitor.playbackChannelGeneric': 'Playback channel',
  'settings.monitor.gainLabel': 'Monitor gain',
  'settings.monitor.headphonesConfirmLabel': 'Wired headphones are connected to this device',
  'settings.monitor.stopButton': 'Stop monitoring',
  'settings.monitor.preparingButton': 'Preparing…',
  'settings.monitor.startButton': 'Start monitoring',
  'settings.monitor.notReported': 'Not reported',
  // {frames} is a frame count
  'settings.monitor.framesValue': '{frames} frames',
  'settings.monitor.framesProviderReported': '{frames} frames · provider-reported',
  'settings.monitor.unknownNotMeasured': 'Unknown · not measured',
  // channel-count unit abbreviations, e.g. "2 ch", "3 in", "2 out"
  'settings.monitor.channelsUnit': 'ch',
  'settings.monitor.inputsUnit': 'in',
  'settings.monitor.outputsUnit': 'out',
  // the joining word in a list of channel numbers, e.g. "1, 2 and 3"
  'settings.monitor.channelListAnd': 'and',
  'settings.monitor.chooseChannels': 'Choose physical input and output channels that are available on this device.',
  'settings.monitor.previewMustConfirm': 'The microphone preview must confirm this exact native device and channel before monitoring can start.',
  'settings.monitor.unavailableCleanup': 'Monitoring is unavailable while another app audio owner finishes cleanup.',
  // {channels} is a formatted list of playback channel numbers, e.g. "1 and 2"
  'settings.monitor.zenQuadroHelp':
    'Zen Quadro: in Antelope Control Panel → Monitors & Headphones, assign USB 1 PLAY {channels} to the Monitor/HP1 or Headphones 2 mixer you use.',
  'settings.monitor.playbackLanesHelp':
    'These are playback lanes, not physical jack names. In your interface mixer, route OUT {channels} to the headphone bus you use.',
  // {channel} is an input channel label, {db} a level in dBFS
  'settings.monitor.signalNearSilenceInput':
    'Monitoring is running, but {channel} is near silence ({db} dBFS). Check the input channel and interface preamp, then sing into the microphone.',
  'settings.monitor.signalNearSilenceOutput':
    'The microphone reaches the DSP graph, but its output is near silence ({db} dBFS). Raise Monitor gain.',
  // {channels} is a formatted list of output channel labels, e.g. "OUT 1 and OUT 2"
  'settings.monitor.signalLive':
    'DSP audio is live at {db} dBFS on {channels}. If the headphones are silent, route those playback lanes to their headphone bus in the interface mixer.',
  'settings.monitor.routeInspecting': 'Inspecting native audio routes…',
  'settings.monitor.routeWindowsUnavailable':
    'Headphone monitoring is not available on Windows yet. WASAPI inventory is shown, but native output stays off in this version.',
  'settings.monitor.routePlatformUnavailable': 'Headphone monitoring is not available on this desktop platform yet.',
  'settings.monitor.routeChooseInput': 'Choose a native monitoring input. SingZ will not guess from a device name.',
  'settings.monitor.routeChooseOutput': 'Choose a native playback device.',
  'settings.monitor.routeNeedsSameDuplexDevice': 'macOS monitoring needs the microphone and headphones on the same duplex audio device.',
  'settings.monitor.routeHighLatency': 'This is a delayed wireless or vehicle-style route. Choose wired headphones on a low-latency device.',
  'settings.monitor.routeNotApproved': 'This route is not approved for low-latency monitoring. Choose a provider-confirmed wired device.',
  // {device} is the playback device's label
  'settings.monitor.routeApproved': '{device} is approved for low-latency duplex monitoring.',
  // {subject} is a translated word/phrase supplied by the caller at call
  // time (see settings.subject.* below) — e.g. "Microphone", "Training
  // audio", "Song playback".
  'settings.monitor.audioSafetyBlocked':
    '{subject} is unavailable while another audio owner or route change is active. Open Settings to review the audio owner or retry the output route.',

  // ── audioSafetyBlockedCopy() subjects: the {subject} passed into settings.monitor.audioSafetyBlocked ──
  'settings.subject.microphone': 'Microphone',
  'settings.subject.trainingAudio': 'Training audio',
  'settings.subject.songPlayback': 'Song playback',

  // ── SettingsModal: native host diagnostics panel ──
  'settings.monitor.diagnosticsAriaLabel': 'Native host diagnostics',
  'settings.monitor.diagnostic.inputDevice': 'Input device',
  'settings.monitor.diagnostic.buffer': 'Buffer',
  'settings.monitor.diagnostic.outputDevice': 'Output device',
  'settings.monitor.diagnostic.externalRoute': 'External route',
  'settings.monitor.diagnostic.xruns': 'Xruns',
  'settings.monitor.diagnostic.deadlineMisses': 'Deadline misses',
  'settings.monitor.diagnostic.renderFailures': 'Render failures',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': 'The microphone disconnected. Reconnect it or choose another input.',
  'settings.mic.channelRoutePending': 'Wait for the selected microphone to connect before choosing its channel.',
  'settings.output.channelRoutePending': 'Wait for the selected playback device to connect before choosing its channels.',

  // ── audio/monitoring.ts: DesktopMonitorCoordinator status messages ──
  'settings.monitorCoordinator.idle': 'Monitoring is off.',
  'settings.monitorCoordinator.releasing': 'Releasing the microphone and song output…',
  'settings.monitorCoordinator.startingNative': 'Starting the native DSP path…',
  'settings.monitorCoordinator.active': 'Native DSP monitoring is active.',
  'settings.monitorCoordinator.generationChanged': 'The native monitor generation changed before it became ready.',
  'settings.monitorCoordinator.deviceDisconnected': 'The monitoring device disconnected. Reconnect it and start again.',
  'settings.monitorCoordinator.hostStopped': 'The native monitoring host stopped.',
  'settings.monitorCoordinator.callbackTimeout': 'The native DSP path did not confirm an audio callback in time.',
  'settings.monitorCoordinator.routeStopped': 'The native monitoring route stopped.',
  'settings.monitorCoordinator.stopping': 'Stopping native monitoring…',
  'settings.monitorCoordinator.shutdownUnconfirmed': 'Native monitoring did not confirm shutdown. Song output remains released for safety.',
  // {error} is the underlying error's message
  'settings.monitorCoordinator.outputRestoreFailed': 'Song output could not be restored: {error}',
  'settings.monitorCoordinator.error.platformNotReady': 'Headphone monitoring is not available on Windows yet. Native output stayed off.',
  'settings.monitorCoordinator.error.unsupportedRoute': 'That route is not approved for low-latency monitoring. Choose a wired audio device.',
  'settings.monitorCoordinator.error.micBusy': 'The microphone is still in use. Stop the preview or exercise, then try again.',
  'settings.monitorCoordinator.error.queueFull': 'The DSP control queue is busy. Wait a moment, then try again.',
  'settings.monitorCoordinator.error.couldNotStart': 'Native headphone monitoring could not start.',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': 'Opening audio settings…',
  'settings.route.failedTitle': 'Settings didn’t open',
  'settings.route.restartHint': 'Restart SingZ before trying to open Settings again.',
  'settings.route.failure.none': 'Audio settings could not be loaded. No Settings preview was started.',
  'settings.route.failure.appShellStop':
    'Audio settings could not be loaded. Microphone or headphone audio is still owned; use the top-bar Stop control to release it.',
  'settings.route.failure.routeOnly':
    'Audio settings could not be loaded. The output route still needs attention; after restarting SingZ, open Settings to finish or retry the route before starting audio.',
  'settings.route.failure.settingsPreview':
    'Audio settings could not be loaded. A Settings microphone preview still owns the device; restart SingZ before reopening Settings.',
  'settings.route.failure.unknown':
    'Audio settings could not be loaded while another audio owner is unresolved. Restart SingZ before reopening Settings.',
  'settings.route.unavailableTitle': 'Audio settings unavailable',
  'settings.route.stoppedTitle': 'Audio settings stopped',
  'settings.route.confirmingStopped': 'Confirming that native headphone monitoring has stopped…',
  'settings.route.unsafeCleanup':
    'Microphone or native monitoring cleanup is still unconfirmed. Retry audio stop to release its exact owner. If cleanup still cannot be confirmed, quit SingZ before disconnecting devices.',
  'settings.route.pendingMessage':
    'An audio route change is still in progress. It cannot be cancelled safely here; wait for it to finish before reopening Settings.',
  'settings.route.unconfirmedMessage':
    'The physical playback route is still unconfirmed. Retry settings to choose or confirm the output. Audio starts stay blocked until that route is repaired.',
  'settings.route.offMessage': 'Native headphone monitoring is off. You can retry audio settings or close this window.',
  'settings.route.retryStopButton': 'Retry audio stop',
  'settings.route.retrySettingsButton': 'Retry settings',

  // ── SetupWizard.tsx: model manager / first-run setup ──
  'settings.wizard.settingUpTitle': 'Setting up SingZ',
  'settings.wizard.aiModelsTitle': 'AI models',
  'settings.wizard.intro': 'SingZ runs its AI locally. Models download once into a shared folder and are reused for every song.',
  // shown next to a model that has finished installing; keep the ✓ mark
  'settings.wizard.installedBadge': 'installed ✓',
  'settings.wizard.reinstallTitle': "Download and install this again — fixes an install that exists but won't run",
  'settings.wizard.reinstallButton': 'Reinstall',
  // {mb} is a download size in megabytes
  'settings.wizard.getButton': 'Get · {mb} MB',
  'settings.wizard.engineLabel': 'Splitting engine',
  'settings.wizard.gpuTitle': 'Try the graphics card first, fall back to the processor if it misbehaves',
  'settings.wizard.cpuTitle': 'Split on the processor only',
  // {reason} is a short technical reason code reported by the app, not translated
  'settings.wizard.gpuAutoOff': 'The graphics card was turned off automatically ({reason}) — pick GPU to try it again.',
  'settings.wizard.cpuOnly': 'Splits use the processor only.',
  'settings.wizard.autoDescription': 'Splits try the graphics card first and fall back to the processor if it misbehaves.',
  'settings.wizard.tryAgainButton': 'Try again',
  'settings.wizard.skipButton': 'Skip for now',

  // ── SetupModal.tsx: Demucs one-time setup ──
  'settings.demucs.title': 'Stem splitting needs Demucs',
  // first half of a sentence that continues with a bolded "Demucs" (<strong>)
  // and then settings.demucs.introAfter — the three form one sentence
  'settings.demucs.introBefore': 'SingZ uses',
  'settings.demucs.introAfter':
    '— a free, open-source AI model that runs entirely on your machine — to split songs into stems. One-time setup, in Terminal:',
  'settings.demucs.copiedBadge': 'Copied ✓',
  'settings.demucs.copyButton': 'Copy',
  // first half of a sentence that continues with a <code>brew install pipx</code>
  // and then settings.demucs.pipxAfter — the three form one sentence
  'settings.demucs.pipxBefore': 'Needs Python 3.10–3.13 and pipx (',
  'settings.demucs.pipxAfter': '). The first split downloads the model (~80 MB); a typical song takes a few minutes of CPU time.',
  'settings.demucs.checkingButton': 'Checking…',
  'settings.demucs.recheckButton': 'Re-check',
  'settings.demucs.githubLink': 'Demucs on GitHub ↗',

  // ── PersistentMonitorControl.tsx ──
  'settings.persistentMonitor.routeNeedsAttention': 'Audio route needs attention',
  'settings.persistentMonitor.changingRoute': 'Changing audio route…',
  'settings.persistentMonitor.cleanupNeeded': 'Microphone cleanup needed',
  'settings.persistentMonitor.starting': 'Starting monitor',
  'settings.persistentMonitor.stopping': 'Stopping monitor',
  'settings.persistentMonitor.needsAttention': 'Monitor needs attention',
  'settings.persistentMonitor.micMonitoring': 'Mic monitoring',
  'settings.persistentMonitor.openCleanupSettings': 'Open audio cleanup settings',
  'settings.persistentMonitor.openRouteSettings': 'Open audio route settings',
  'settings.persistentMonitor.openMonitoringSettings': 'Open headphone monitoring settings',
  // {label} is the status label above (e.g. "Mic monitoring")
  'settings.persistentMonitor.ariaLabel': '{label}. New song and training audio starts are blocked. Open audio settings.',
  'settings.persistentMonitor.retryCleanupAria': 'Retry microphone cleanup and release audio',
  'settings.persistentMonitor.stopAria': 'Stop monitoring and release microphone audio',
  'settings.persistentMonitor.stopButton': 'Stop',
  // aria-label for the group wrapping the status button + stop button
  'settings.persistentMonitor.groupAriaLabel': 'Headphone monitoring controls',

  // ── LazyDialogRoute.tsx: generic lazy-loaded dialog scaffolding ──
  'settings.dialogRoute.retryButton': 'Retry',
  'settings.dialogRoute.recoveryFailed': 'The recovery copy also could not be loaded. Restart SingZ before trying again.',
  // {name} is the dialog's own name (e.g. "Settings")
  'settings.dialogRoute.stoppedTitle': '{name} stopped',
  'settings.dialogRoute.runtimeProblem': 'This view encountered a problem. Any work it already started may still be running.',
  'settings.dialogRoute.keepOpenHint': 'Keep SingZ open while the current operation finishes.',

  // ── audio/devices.ts: placeholder names for unnamed devices ──
  'settings.devices.microphone': 'Microphone',
  'settings.devices.speakers': 'Speakers',

  // ── audio/mic-preview.ts: microphone preview errors ──
  'settings.micPreview.accessBlockedShort': 'Microphone access is blocked.',
  'settings.micPreview.failed': 'Microphone preview failed.',
  'settings.micPreview.accessBlocked': 'Microphone access is blocked. Allow SingZ in system privacy settings.',
  'settings.micPreview.busy': 'The microphone is busy in another app. Close that app, then choose the input again.',
  'settings.micPreview.unavailable': 'That microphone is not available. Reconnect it or choose another input.',
  'settings.micPreview.unknown': 'The microphone could not start. Check the device connection and try again.'
}
