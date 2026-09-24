/* Simplified Chinese — the `app` strings, typed against English. */
import type { app as en } from '../en/app'
import type { Translation } from '../../../../src/shared/i18n/types'

export const app: Translation<typeof en> = {
  // ── bottom tabs (App.tsx tab screens + ui/BottomTabs.tsx fallback labels) ──
  'phone.app.tab.songs': '歌曲',
  'phone.app.tab.train': '训练',

  // ── root navigator (ui/RootNavigator.tsx) ──
  'phone.app.metronomeNotSaved': '节拍器设置未能保存',

  // ── settings screen (ui/SettingsScreen.tsx) ──
  'phone.app.settings.title': '设置',
  'phone.app.settings.checking': '正在检查原生播放…',
  'phone.app.settings.closeA11y': '关闭设置',
  'phone.app.settings.done': '完成',
  'phone.app.settings.sectionAudio': '音频',
  'phone.app.settings.nativePlaybackName': '原生播放',
  'phone.app.settings.nativePlaybackBadge': '默认',
  'phone.app.settings.nativePlaybackDescription':
    '通过 zcore + zdsp 播放符合条件的分轨和已添加音轨的项目。原生播放包含播放控制、音高、速度、循环、节拍器、预备拍和声乐训练；不支持的文件格式仍使用普通播放器。',
  'phone.app.settings.unsupportedPlatform': '此平台不支持原生播放。',
  'phone.app.settings.nativePlaybackA11y': '原生播放',
  'phone.app.settings.nativePlaybackNote':
    '符合条件的歌曲使用普通播放器控件，底层由原生 DSP 驱动。其他歌曲仍完全使用普通播放器。',

  // ── log panel chrome (ui/LogPanel.tsx) — log LINES themselves stay English ──
  'phone.app.log.title': '日志',
  'phone.app.log.lines_one': '{n} 行',
  'phone.app.log.lines_other': '{n} 行',
  'phone.app.log.share': '分享',
  'phone.app.log.shareA11y': '分享日志',
  'phone.app.log.clear': '清除',
  'phone.app.log.clearA11y': '清除日志',
  'phone.app.log.close': '关闭',
  'phone.app.log.closeA11y': '关闭日志',
  'phone.app.log.confirmTitle': '要清除日志吗？',
  'phone.app.log.confirmBody': '这是应用所做操作的唯一记录。',
  'phone.app.log.keepIt': '保留',
  'phone.app.log.empty': '目前还没有日志。',

  // ── training cue errors (engine.ts playTrainingCues) — read out by
  //    ui/TrainingScreen.tsx when a reference tone or training cue fails ──
  'phone.app.engine.pausedInBackground': 'SingZ 在后台运行时音频已暂停。',
  'phone.app.engine.outputOwnedBySong': '歌曲播放当前占用着 iPhone 的音频输出。',
  'phone.app.engine.cueCancelled': '训练提示音已取消。',

  // ── native playback status (playback/native.ts settingsStatus(), read by
  //    ui/SettingsScreen.tsx as the status line under the toggle) ──
  'phone.app.native.status.unavailablePlatform': '此平台不支持原生播放。',
  'phone.app.native.status.noBridge': '此构建版本不包含原生播放桥接。',
  'phone.app.native.status.missingCapability': '所链接的原生运行时缺少一项必需的播放能力。',
  // {message} is the caught error's own text
  'phone.app.native.status.failed': '原生状态获取失败：{message}',

  // ── native playback load/prepare failures (playback/native.ts load()),
  //    surfaced by ui/CatalogScreen.tsx's error banner when opening a song ──
  'phone.app.native.cleanupBlockedLegacy': '原生播放清理状态不确定，普通播放仍被阻止。',
  'phone.app.native.cleanupNextNotOpened': '原生播放清理状态不确定，下一首歌曲未被打开。',
  // {message} is the caught error's own text
  'phone.app.native.prepareFailed': '原生准备失败：{message}',
  // {message} is the native core's own refusal text
  'phone.app.native.prepareRefused': '原生准备拒绝了该歌曲：{message}',
  // {message} is the caught error's own text
  'phone.app.native.prepareStatusFailed': '原生准备状态获取失败：{message}',
  'phone.app.native.prepareInconsistent': '原生准备返回了不一致的会话状态。',
  // internal state also compared with === elsewhere in native.ts; keep in
  // sync if this value's shape ever changes
  // {reason} is a short internal cause (e.g. "cancelled prepare")
  'phone.app.native.cleanupUncertain':
    '原生播放清理状态不确定（{reason}）。为防止音频占用方重叠，已阻止回退到普通播放。',
  // {detail} is the caught error's own text
  'phone.app.native.suspendLegacyFailed': '原生播放未能在占用音频会话前暂停普通输出：{detail}',
  'phone.app.native.noOutput': '没有可用的原生音频输出。',
  'phone.app.native.unavailable': '原生播放不可用。',
  'phone.app.native.focusLost': '原生音频已停止，因为 Android 改变了音频焦点或输出路径。点按播放以重试。',
  // {reason} is a short internal cause reported by the native session
  'phone.app.native.stoppedReasonRetry': '原生音频已停止：{reason}。点按播放以重试。',
  // {reason} is a short internal cause; the sentence continues with a fixed tail
  'phone.app.native.outputDidNotOpen': '原生输出未能打开：{reason}。原生播放引擎上的播放仍处于停止状态。',
  'phone.app.native.unloadUncertainPublished': '原生卸载状态不确定，原生所有权仍处于已发布状态。',
  'phone.app.native.unloadUncertainNotStarted': '原生卸载状态不确定，另一个播放引擎未启动。',
  'phone.app.native.unloadUncertainBlocked': '原生卸载状态不确定，原生所有权仍处于阻止状态。',
  'phone.app.native.outputStreamNotReleased': '后台驻留后，原生输出流未能释放。',

  // ── native playback loading progress (playback/native.ts materializeNativeProject,
  //    read by ui/CatalogScreen.tsx's loading banner while a song opens) ──
  'phone.app.native.progress.releasingLastSong': '正在释放上一首歌曲…',
  'phone.app.native.progress.buildingGraph': '正在构建音频图…',
  // {label} is a track/lane name (already resolved and translated elsewhere), {index}/{count} are 1-based
  'phone.app.native.progress.fetchingTrack': '正在获取 {label} · {index}/{count}',
  'phone.app.native.progress.fetchingLyrics': '正在获取歌词…'
}
