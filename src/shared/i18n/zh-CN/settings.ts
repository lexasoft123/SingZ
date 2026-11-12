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
  'settings.mic.unavailableTrainingCleanup': '声乐训练音频清理未完成时不可用。',
  // {channel} is a 1-based channel number
  'settings.mic.noSignal': '通道 {channel} 上没有信号',
  // {dbfs} is a signal level in dBFS (a negative number), {channel} a 1-based channel number
  'settings.mic.dbfsOnChannel': '通道 {channel} 上为 {dbfs} dBFS',
  'settings.mic.pausedByOtherOwner': '麦克风预览已被另一个音频占用方暂停。',
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

  // channel-count unit abbreviation shown after a device's channel count, e.g. "2 ch"
  'settings.mic.channelsUnit': '声道',

  // ── subjects for RetainedAudioControl status labels ──
  'settings.subject.microphone': '麦克风',
  'settings.subject.songPlayback': '歌曲播放',

  // ── SettingsModal: microphone/output disconnect + channel-route waits ──
  'settings.mic.disconnected': '麦克风已断开连接。请重新连接，或选择另一个输入设备。',
  'settings.mic.channelRoutePending': '请等待所选麦克风连接后再选择其声道。',

  // ── SettingsRoute.tsx: lazy-load / runtime failure states ──
  'settings.route.opening': '正在打开音频设置…',
  'settings.route.failedTitle': '设置未能打开',
  'settings.route.restartHint': '请重启 SingZ 后再尝试打开设置。',
  'settings.route.failure.none': '无法加载音频设置。未启动任何设置预览。',
  'settings.route.stoppedTitle': '音频设置已停止',
  'settings.route.offMessage': '音频设置出现错误，已安全关闭。你可以重试，或关闭此窗口。',
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

  // ── RetainedAudioControl.tsx ──
  'settings.persistentMonitor.needsAttention': '返听需要处理',
  'settings.persistentMonitor.stopButton': '停止',

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
