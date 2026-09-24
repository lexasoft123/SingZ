/* 简体中文 — the `settings` strings, typed against English. */
import type { settings as en } from '../en/settings'
import type { Translation } from '../types'

export const settings: Translation<typeof en> = {
  // ── shared actions/labels, reused across dialogs in this namespace ──
  'settings.action.close': '关闭',
  'settings.common.systemDefault': '系统默认',
  'settings.common.savedDeviceMissing': '已保存的设备（未连接）',

  // ── SettingsModal: shell ──
  'settings.title': '设置',
  'settings.tab.audio': '音频',
  'settings.devicesLoading': '正在查找音频设备…',
  'settings.inputLabelsHiddenHint': '在系统设置中允许麦克风访问，即可看到设备名称。',
  'settings.nonDefaultSpeakerTip': '提示：使用非默认扬声器时请戴耳机演唱——回声消除只跟踪系统默认输出。',

  // ── SettingsModal: playback output device ──
  'settings.output.label': '播放设备',
  'settings.output.confirming': '正在确认播放路径…',
  // fallback status text when there is no more specific route error to show
  'settings.output.unconfirmedFallback': '播放路径尚未确认。',
  'settings.output.retrying': '正在重试…',
  'settings.output.retryRoute': '重试输出路由',
  'settings.output.unconfirmedStatus': '无法确认播放路由——请选择输出设备或重试',
  'settings.output.stillUnconfirmed': '路径仍未确认。你可以再次重试。',
  'settings.output.retryBlocked': '在确认音频清理之前，无法重试播放路径。',

  // ── SettingsModal: native DSP playback checkbox ──
  'settings.playback.useNativeLabel': '使用原生 DSP 播放',
  'settings.playback.hint': '仅当歌曲的特性与原生图完全匹配时，才会使用所选的原生提供方。',

  // ── SettingsModal: Windows audio provider ──
  'settings.windows.providerLabel': 'Windows 音频提供方',
  // "WASAPI" is the Windows audio API's own name, kept as-is
  'settings.windows.wasapiOption': '系统音频（WASAPI）',
  // {detail} is a technical reason string reported by the OS, not translated
  'settings.windows.asioUnavailable': 'ASIO 不可用：{detail}',

  // ── SettingsModal: microphone strip ──
  'settings.mic.label': '麦克风',
  'settings.mic.channelLabel': '输入通道',
  'settings.mic.monoInput': '单声道输入 · 通道 1',
  'settings.mic.levelLabel': '输入电平',
  'settings.mic.channelLevelAriaLabel': '所选麦克风声道的电平',
  // shown while the mic preview is still connecting
  'settings.mic.startingPreview': '正在启动麦克风预览…',
  'settings.mic.usedByMonitoring': '正被耳机返听使用',
  'settings.mic.unavailableTrainingCleanup': '声乐训练音频清理未完成时不可用。',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': '通道 {channel} 上没有信号',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '通道 {channel} 上为 {dbfs} dBFS',
  'settings.mic.pausedByOtherOwner': '麦克风预览已被另一个音频占用方暂停。',
  'settings.mic.pausedByMonitoring': '耳机返听启用期间，麦克风预览已暂停。',
  // {device} is the microphone's label, {channel}/{count} are 1-based channel numbers
  'settings.mic.listeningThrough': '正在通过 {device} 拾音 · 通道 {channel}/{count}',
  // fallback device name when the microphone has no label
  'settings.mic.theMicrophoneFallback': '该麦克风',
  'settings.mic.previewOpening': '麦克风预览正在打开。',
  'settings.mic.fallbackWarning': '已保存的麦克风不可用——正在预览系统默认设备。',
  // {channel} is a 1-based channel number
  'settings.mic.channelFallbackWarning': '该声道不可用——正在预览通道 {channel}。',
  // {reason} is a short technical explanation reported by the OS
  'settings.mic.fallbackNotice':
    '正在使用浏览器麦克风采集，而非原生采集。{reason} 浏览器采集暴露的输入通道可能更少。当前输入：{label}，通道 {channel}/{count}。',
  // fallback label when the active input device has no name
  'settings.mic.fallbackDeviceLabel': '麦克风',
  'settings.mic.nativeCapture': '原生麦克风采集',
  // {error} is a technical reason string reported by the OS
  'settings.mic.nativeUnavailable': '原生麦克风采集不可用：{error} 浏览器采集暴露的输入通道可能更少。',

  // ── SettingsModal: headphone monitoring section ──
  'settings.monitor.heading': '耳机返听',
  'settings.monitor.subheading': '通过原生 DSP 图听这个麦克风',
  'settings.monitor.experimentalBadge': '实验性',
  'settings.monitor.nativeInputLabel': '原生返听输入',
  'settings.monitor.chooseNativeDevice': '选择一个确切的原生设备…',
  'settings.monitor.savedInputMissing': '已保存的原生输入（未连接）',
  'settings.monitor.osUidHint': '这是一个操作系统音频 UID。SingZ 绝不会用 Chromium 的设备名称来匹配它。',
  'settings.monitor.outputLabel': '音频接口播放',
  'settings.monitor.choosePlaybackDevice': '选择播放设备…',
  'settings.monitor.savedOutputMissing': '已保存的原生输出（未连接）',
  'settings.monitor.micChannelLabel': '麦克风通道',
  'settings.monitor.playbackLeft': '播放左',
  'settings.monitor.playbackRight': '播放右',
  'settings.monitor.playbackGeneric': '播放',
  'settings.monitor.playbackLeftChannel': '播放左声道',
  'settings.monitor.playbackRightChannel': '播放右声道',
  'settings.monitor.playbackChannelGeneric': '播放声道',
  'settings.monitor.gainLabel': '返听增益',
  'settings.monitor.headphonesConfirmLabel': '有线耳机已连接到此设备',
  'settings.monitor.stopButton': '停止返听',
  'settings.monitor.preparingButton': '正在准备…',
  'settings.monitor.startButton': '开始返听',
  'settings.monitor.notReported': '未报告',
  // {frames} is a frame count
  'settings.monitor.framesValue': '{frames} 帧',
  'settings.monitor.framesProviderReported': '{frames} 帧 · 由提供方报告',
  'settings.monitor.unknownNotMeasured': '未知 · 未测量',
  // channel-count unit abbreviations, e.g. "2 ch", "3 in", "2 out"
  'settings.monitor.channelsUnit': '声道',
  'settings.monitor.inputsUnit': '入',
  'settings.monitor.outputsUnit': '出',
  // the joining word in a list of channel numbers, e.g. "1, 2 and 3"
  'settings.monitor.channelListAnd': '和',
  'settings.monitor.chooseChannels': '选择此设备上可用的物理输入和输出通道。',
  'settings.monitor.previewMustConfirm': '麦克风预览必须先确认这个确切的原生设备和通道，返听才能开始。',
  'settings.monitor.unavailableCleanup': '另一个音频占用方完成清理之前，返听不可用。',
  // {channels} is a formatted list of playback channel numbers, e.g. "1 and 2"
  'settings.monitor.zenQuadroHelp':
    'Zen Quadro：在 Antelope Control Panel → Monitors & Headphones 中，将 USB 1 PLAY {channels} 分配给你使用的 Monitor/HP1 或 Headphones 2 混音通道。',
  'settings.monitor.playbackLanesHelp':
    '这些是播放通道，不是物理接口名称。请在你的音频接口混音器中，将 OUT {channels} 路由到你使用的耳机总线。',
  // {channel} is an input channel label, {db} a level in dBFS
  'settings.monitor.signalNearSilenceInput':
    '返听正在运行，但 {channel} 几乎无信号（{db} dBFS）。请检查输入通道和接口前置放大器，然后对着麦克风演唱。',
  'settings.monitor.signalNearSilenceOutput':
    '麦克风信号已到达 DSP 图，但其输出几乎无信号（{db} dBFS）。请提高返听增益。',
  // {channels} is a formatted list of output channel labels, e.g. "OUT 1 and OUT 2"
  'settings.monitor.signalLive':
    'DSP 音频在 {channels} 上实时输出，电平为 {db} dBFS。如果耳机没有声音，请在接口混音器中把这些播放通道路由到耳机总线。',
  'settings.monitor.routeInspecting': '正在检查原生音频路径…',
  'settings.monitor.routeWindowsUnavailable':
    'Windows 上暂不支持耳机返听。已显示 WASAPI 设备清单，但此版本中原生输出仍保持关闭。',
  'settings.monitor.routePlatformUnavailable': '此桌面平台暂不支持耳机返听。',
  'settings.monitor.routeChooseInput': '选择一个原生返听输入。SingZ 不会根据设备名称猜测。',
  'settings.monitor.routeChooseOutput': '选择一个原生播放设备。',
  'settings.monitor.routeNeedsSameDuplexDevice': 'macOS 上的返听需要麦克风和耳机在同一台双工音频设备上。',
  'settings.monitor.routeHighLatency': '这是一条延迟较高的无线或车载式路径。请选择一台低延迟设备上的有线耳机。',
  'settings.monitor.routeNotApproved': '此路径未获批准用于低延迟返听。请选择一个经提供方确认的有线设备。',
  // {device} is the playback device's label
  'settings.monitor.routeApproved': '{device} 已获批准用于低延迟双工返听。',
  // {subject} is a translated word/phrase supplied by the caller at call
  // time (see settings.subject.* below).
  'settings.monitor.audioSafetyBlocked':
    '{subject} 在另一个音频占用方或路径变更进行时不可用。请打开设置查看音频占用方，或重试播放路径。',

  // ── audioSafetyBlockedCopy() subjects: the {subject} passed into settings.monitor.audioSafetyBlocked ──
  'settings.subject.microphone': '麦克风',
  'settings.subject.trainingAudio': '训练音频',
  'settings.subject.songPlayback': '歌曲播放',

  // ── SettingsModal: native host diagnostics panel ──
  'settings.monitor.diagnosticsAriaLabel': '原生主机诊断',
  'settings.monitor.diagnostic.inputDevice': '输入设备',
  'settings.monitor.diagnostic.buffer': '缓冲区',
  'settings.monitor.diagnostic.outputDevice': '输出设备',
  'settings.monitor.diagnostic.externalRoute': '外部路径',
  'settings.monitor.diagnostic.xruns': 'Xruns',
  'settings.monitor.diagnostic.deadlineMisses': '错过截止时间的次数',
  'settings.monitor.diagnostic.renderFailures': '渲染失败次数',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': '麦克风已断开连接。请重新连接，或选择另一个输入设备。',
  'settings.mic.channelRoutePending': '请等待所选麦克风连接后再选择其声道。',
  'settings.output.channelRoutePending': '请等待所选播放设备连接后再选择其声道。',

  // ── audio/monitoring.ts: DesktopMonitorCoordinator status messages ──
  'settings.monitorCoordinator.idle': '返听已关闭。',
  'settings.monitorCoordinator.releasing': '正在释放麦克风和歌曲输出…',
  'settings.monitorCoordinator.startingNative': '正在启动原生 DSP 路径…',
  'settings.monitorCoordinator.active': '原生 DSP 返听正在运行。',
  'settings.monitorCoordinator.generationChanged': '原生返听在就绪前，其世代已发生变化。',
  'settings.monitorCoordinator.deviceDisconnected': '返听设备已断开连接。请重新连接后再次开始。',
  'settings.monitorCoordinator.hostStopped': '原生返听主机已停止。',
  'settings.monitorCoordinator.callbackTimeout': '原生 DSP 路径未能及时确认音频回调。',
  'settings.monitorCoordinator.routeStopped': '原生返听路径已停止。',
  'settings.monitorCoordinator.stopping': '正在停止原生返听…',
  'settings.monitorCoordinator.shutdownUnconfirmed': '原生返听未确认已关闭。为安全起见，歌曲输出仍保持释放状态。',
  // {error} is the underlying error's message
  'settings.monitorCoordinator.outputRestoreFailed': '无法恢复歌曲输出：{error}',
  'settings.monitorCoordinator.error.platformNotReady': 'Windows 上暂不支持耳机返听。原生输出保持关闭。',
  'settings.monitorCoordinator.error.unsupportedRoute': '该路径未获批准用于低延迟返听。请选择一台有线音频设备。',
  'settings.monitorCoordinator.error.micBusy': '麦克风仍在使用中。请先停止预览或训练，然后再试。',
  'settings.monitorCoordinator.error.queueFull': 'DSP 控制队列正忙。请稍候再试。',
  'settings.monitorCoordinator.error.couldNotStart': '原生耳机返听无法启动。',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': '正在打开音频设置…',
  'settings.route.failedTitle': '设置未能打开',
  'settings.route.restartHint': '请重启 SingZ 后再尝试打开设置。',
  'settings.route.failure.none': '无法加载音频设置。未启动任何设置预览。',
  'settings.route.failure.appShellStop':
    '无法加载音频设置。麦克风或耳机音频仍被占用；请使用顶部栏的停止控件释放它。',
  'settings.route.failure.routeOnly':
    '无法加载音频设置。输出路径仍需处理；重启 SingZ 后，请打开设置以完成或重试该路径，然后再开始播放音频。',
  'settings.route.failure.settingsPreview':
    '无法加载音频设置。设置中的麦克风预览仍占用该设备；请重启 SingZ 后再重新打开设置。',
  'settings.route.failure.unknown':
    '另一个音频占用方尚未解决，无法加载音频设置。请重启 SingZ 后再重新打开设置。',
  'settings.route.unavailableTitle': '音频设置不可用',
  'settings.route.stoppedTitle': '音频设置已停止',
  'settings.route.confirmingStopped': '正在确认原生耳机返听已停止…',
  'settings.route.unsafeCleanup':
    '麦克风或原生返听的清理仍未确认。请重试停止音频，以释放其确切的占用方。如果仍无法确认清理完成，请在断开设备之前先退出 SingZ。',
  'settings.route.pendingMessage':
    '音频路径变更仍在进行中。此处无法安全取消；请等待它完成后再重新打开设置。',
  'settings.route.unconfirmedMessage':
    '物理播放路径仍未确认。请重试设置以选择或确认输出。在该路径修复之前，音频将一直无法启动。',
  'settings.route.offMessage': '原生耳机返听已关闭。你可以重试音频设置，或关闭此窗口。',
  'settings.route.retryStopButton': '重试停止音频',
  'settings.route.retrySettingsButton': '重试设置',

  // ── SetupWizard.tsx: model manager / first-run setup ──
  'settings.wizard.settingUpTitle': '正在设置 SingZ',
  'settings.wizard.aiModelsTitle': 'AI 模型',
  'settings.wizard.intro': 'SingZ 在本地运行其 AI。模型只需下载一次到共享文件夹，之后每首歌都会重复使用。',
  // shown next to a model that has finished installing; keep the ✓ mark
  'settings.wizard.installedBadge': '已安装 ✓',
  'settings.wizard.reinstallTitle': '重新下载并安装——用于修复一个存在但无法运行的安装',
  'settings.wizard.reinstallButton': '重新安装',
  // {mb} is a download size in megabytes
  'settings.wizard.getButton': '获取 · {mb} MB',
  'settings.wizard.engineLabel': '分离引擎',
  'settings.wizard.gpuTitle': '优先尝试显卡，如果出现异常则回退到处理器',
  'settings.wizard.cpuTitle': '仅在处理器上分离',
  // {reason} is a short technical reason code reported by the app, not translated
  'settings.wizard.gpuAutoOff': '显卡已被自动关闭（{reason}）——选择 GPU 可再次尝试。',
  'settings.wizard.cpuOnly': '分离仅使用处理器。',
  'settings.wizard.autoDescription': '分离会优先尝试显卡，如果出现异常则回退到处理器。',
  'settings.wizard.tryAgainButton': '再试一次',
  'settings.wizard.skipButton': '暂时跳过',

  // ── SetupModal.tsx: Demucs one-time setup ──
  'settings.demucs.title': '分离分轨需要 Demucs',
  // first half of a sentence that continues with a bolded "Demucs" (<strong>)
  // and then settings.demucs.introAfter — the three form one sentence
  'settings.demucs.introBefore': 'SingZ 使用',
  'settings.demucs.introAfter':
    '——一个完全在你的电脑上运行的免费开源 AI 模型——来将歌曲分离成分轨。一次性设置，在终端中：',
  'settings.demucs.copiedBadge': '已复制 ✓',
  'settings.demucs.copyButton': '复制',
  // first half of a sentence that continues with a <code>brew install pipx</code>
  // and then settings.demucs.pipxAfter — the three form one sentence
  'settings.demucs.pipxBefore': '需要 Python 3.10–3.13 和 pipx（',
  'settings.demucs.pipxAfter': '）。首次分离会下载模型（约 80 MB）；一首常见长度的歌曲需要几分钟的 CPU 时间。',
  'settings.demucs.checkingButton': '正在检查…',
  'settings.demucs.recheckButton': '重新检查',
  'settings.demucs.githubLink': 'Demucs 的 GitHub 页面 ↗',

  // ── PersistentMonitorControl.tsx ──
  'settings.persistentMonitor.routeNeedsAttention': '音频路径需要处理',
  'settings.persistentMonitor.changingRoute': '正在更改音频路径…',
  'settings.persistentMonitor.cleanupNeeded': '需要清理麦克风',
  'settings.persistentMonitor.starting': '正在启动返听',
  'settings.persistentMonitor.stopping': '正在停止返听',
  'settings.persistentMonitor.needsAttention': '返听需要处理',
  'settings.persistentMonitor.micMonitoring': '麦克风返听',
  'settings.persistentMonitor.openCleanupSettings': '打开音频清理设置',
  'settings.persistentMonitor.openRouteSettings': '打开音频路径设置',
  'settings.persistentMonitor.openMonitoringSettings': '打开耳机返听设置',
  // {label} is the status label above (e.g. "Mic monitoring")
  'settings.persistentMonitor.ariaLabel': '{label}。新歌曲和训练音频的启动均被阻止。请打开音频设置。',
  'settings.persistentMonitor.retryCleanupAria': '重试麦克风清理并释放音频',
  'settings.persistentMonitor.stopAria': '停止返听并释放麦克风音频',
  'settings.persistentMonitor.stopButton': '停止',
  'settings.persistentMonitor.groupAriaLabel': '耳机返听控制',

  // ── LazyDialogRoute.tsx: generic lazy-loaded dialog scaffolding ──
  'settings.dialogRoute.retryButton': '重试',
  'settings.dialogRoute.recoveryFailed': '恢复副本也未能加载。请重启 SingZ 后再试。',
  // {name} is the dialog's own name (e.g. "Settings")
  'settings.dialogRoute.stoppedTitle': '{name} 已停止',
  'settings.dialogRoute.runtimeProblem': '此界面遇到了问题。它已经开始的工作可能仍在进行中。',
  'settings.dialogRoute.keepOpenHint': '在当前操作完成之前，请保持 SingZ 处于打开状态。',

  // ── audio/devices.ts: placeholder names for unnamed devices ──
  'settings.devices.microphone': '麦克风',
  'settings.devices.speakers': '扬声器',

  // ── audio/mic-preview.ts: microphone preview errors ──
  'settings.micPreview.accessBlockedShort': '麦克风访问被阻止。',
  'settings.micPreview.failed': '麦克风预览失败。',
  'settings.micPreview.accessBlocked': '麦克风访问被阻止。请在系统隐私设置中允许 SingZ。',
  'settings.micPreview.busy': '麦克风正被另一个应用占用。请关闭那个应用后重新选择输入。',
  'settings.micPreview.unavailable': '该麦克风不可用。请重新连接它，或选择另一个输入。',
  'settings.micPreview.unknown': '麦克风无法启动。请检查设备连接后重试。'
}
