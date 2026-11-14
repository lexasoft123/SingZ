/* English strings for the `settings` namespace — see ../index.ts. */
export const settings = {
  "settings.buffer.mixed": "Mixed buffer sizes",
  "settings.buffer.label": "Buffer size",
  "settings.buffer.option": "{frames} frames · {ms} ms",
  "settings.buffer.savedUnavailable": "{frames} frames (saved, unavailable)",
  "settings.buffer.hint": "Smaller buffers reduce latency and use more CPU. The time shown is one buffer, not the total sound delay.",
  "settings.buffer.pending": "Saved. Applies after playback, monitoring, recording and microphone preview stop.",
  "settings.buffer.outputStatus": "Output: requested {requested}, obtained {actual} frames",
  "settings.buffer.inputStatus": "Input: requested {requested}, obtained {actual} frames",
  "settings.buffer.unsupported": "Buffer size control is available with CoreAudio on macOS.",
  "settings.buffer.failed": "Could not apply buffer size: {error}",

  'settings.route.title': 'Audio route',
  'settings.route.retryNextStart': 'The saved device will be tried again next time SingZ starts.',
  'settings.route.inventoryUnavailable': 'Audio device inventory is unavailable.',
  'settings.route.notOpen': 'No audio route open',
  'settings.route.buffer': 'buffer {frames}',
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
  'settings.mic.unavailableTrainingCleanup': 'Unavailable while Vocal training audio cleanup is unresolved.',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': 'No signal on channel {channel}',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '{dbfs} dBFS on channel {channel}',
  'settings.mic.pausedByOtherOwner': 'Microphone preview is paused by another app audio owner.',
  'settings.mic.sharedWithVoice': 'Shared with the Voice strip · {dbfs} dBFS',
  'settings.mic.sharedWithVoiceRoute': 'The Voice strip is using this microphone. Its level is shown here.',
  'settings.micPreview.owner': 'Another part of SingZ (the Voice strip or training) is using the microphone. Stop it, then choose the input again.',
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

  // channel-count unit abbreviation shown after a device's channel count, e.g. "2 ch"
  'settings.mic.channelsUnit': 'ch',

  // ── subjects for RetainedAudioControl status labels ──
  'settings.subject.microphone': 'Microphone',
  'settings.subject.songPlayback': 'Song playback',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': 'The microphone disconnected. Reconnect it or choose another input.',
  'settings.mic.channelRoutePending': 'Wait for the selected microphone to connect before choosing its channel.',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': 'Opening audio settings…',
  'settings.route.failedTitle': 'Settings didn’t open',
  'settings.route.restartHint': 'Restart SingZ before trying to open Settings again.',
  'settings.route.failure.none': 'Audio settings could not be loaded. No Settings preview was started.',
  'settings.route.stoppedTitle': 'Audio settings stopped',
  'settings.route.offMessage': 'Audio settings hit an error and were closed safely. You can retry audio settings or close this window.',
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

  // ── RetainedAudioControl.tsx ──
  'settings.persistentMonitor.needsAttention': 'Monitor needs attention',
  'settings.persistentMonitor.stopButton': 'Stop',

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
