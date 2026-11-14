/* 简体中文 — the `player` strings, typed against English. */
import type { player as en } from '../en/player'
import type { Translation } from '../types'

export const player: Translation<typeof en> = {
  "player.failure.copy": "复制详情",
  "player.failure.copied": "已复制",
  "player.failure.title": "播放需要处理",
  "player.failure.retry": "重试",
  "player.failure.retrying": "正在重试…",
  "player.failure.choose": "选择设备",
  "player.failure.retryHelp": "使用同一音频提供程序重新准备歌曲",
  "player.failure.chooseHelp": "打开设置中的“音频路由”",
  "player.failure.details": "技术详情",
  "player.failure.lane": "音轨：{lane} · 格式：{format}",
  "player.failure.addon": "无法加载音频引擎。",
  "player.failure.provider": "所选音频提供程序不可用。",
  "player.failure.noDevice": "没有可用的输出设备。",
  "player.failure.deviceLost": "所选输出设备已断开。",
  "player.failure.route": "设备拒绝了音频格式或缓冲区大小。",
  "player.failure.graph": "无法播放此歌曲的音频图。",
  "player.failure.recovery": "重试前需要清理上一次音频会话。",
  "player.failure.generation": "音频会话已过期。",
  "player.failure.state": "音频引擎状态异常。",
  "player.failure.configuration": "音频配置无效。",
  "player.failure.argument": "音频请求包含无效值。",
  "player.failure.cancelled": "音频准备已取消。",
  "player.failure.decode": "无法解码歌曲中的音轨。",
  "player.failure.limit": "此歌曲超出音频引擎限制。",
  "player.failure.resources": "音频引擎资源不足。",
  "player.failure.graphFailure": "无法准备歌曲的音频图。",
  "player.failure.host": "无法打开或启动音频设备。",
  "player.failure.providerFailure": "音频提供程序停止响应。",
  "player.failure.queue": "音频命令队列已满。",
  "player.failure.teardown": "无法安全关闭上一次音频会话。",
  "player.failure.rate": "不支持此播放速度。",
  "player.failure.busy": "另一音频会话仍占用设备。",
  "player.failure.platform": "音频系统尚未就绪。",
  "player.failure.path": "歌曲音轨的访问被拒绝。",
  "player.failure.pathLength": "音轨文件路径过长。",
  "player.failure.prepare": "音频引擎无法准备此歌曲。",
  "player.failure.permission": "音频设备的访问被拒绝。",
  "player.failure.routeRefused": "所选音频路由被拒绝。",
  "player.failure.format": "无法读取音轨的音频格式。",
  // ── transport ──
  'player.transport.backToSelection': '转到选区开头；再次点击转到歌曲开头',
  'player.transport.backToStart': '回到开头',
  'player.transport.pause': '暂停（空格）',
  'player.transport.play': '播放（空格）',
  'player.transport.loopSelection': '循环选中区域',
  'player.transport.loopSong': '循环整首歌（在波形上拖动可循环某一段）',
  'player.transport.karaoke': '卡拉 OK',
  'player.transport.karaokeTitle': '卡拉 OK 视图：歌词、旋律线与麦克风匹配（按 Esc 关闭）',
  'player.transport.stemFiles': '分轨文件',
  'player.transport.stemFilesTitle': '在文件管理器中显示分轨文件',
  'player.transport.cancel': '取消',
  'player.transport.cancelSplit': '取消分离',
  'player.transport.transposeTitle': '为整首歌移调（仅改变音高，速度不变）',
  'player.transport.resetTranspose': '重置移调',
  'player.transport.speedTitle': '播放速度（音高保持不变）',
  'player.transport.resetSpeed': '重置速度',
  'player.transport.muted': '声音已静音——点击打开音量滑块',
  // {percent} is a number already rounded, e.g. "Volume 80% — click for the slider"
  'player.transport.volumeAt': '音量 {db}——点击打开滑块',
  'player.transport.metronomeTitle': '节拍器——随节拍敲击、查看节拍网格、播放前预备拍',
  'player.transport.carryLine': '接唱',
  'player.transport.carryLineTitle': '接唱——引导音轨按计划间歇消音，由你接唱',

  // ── shared toggle labels (metronome, training, count-in, grid view, accent) ──
  'player.toggle.off': '关',
  'player.toggle.on': '开',

  // ── bpm entry (the tempo readout in the transport) ──
  'player.bpm.detectHint': '每分钟节拍数——歌曲分离并分析后自动检测',
  'player.bpm.setTitle': '以每分钟节拍数设置播放速度',

  // ── volume popover ──
  'player.volume.title': '歌曲输出',
  'player.volume.saved': '随歌曲保存',
  'player.volume.perSong': '单曲',
  'player.volume.reset': '重置',
  'player.volume.peak': '峰值电平',
  'player.volume.muteAll': '全部静音',
  'player.volume.unmute': '恢复到之前的音量',
  'player.volume.sliderTitle': '整体混音的播放音量——节拍器音量也随之变化',
  'player.volume.caption': '随歌曲保存。最多增益 +12 dB；峰值表显示削波时请降低音量。',
  'player.volume.clipped': '削波',
  'player.volume.peakTitle': '安全限幅前的输出峰值（dBFS）。点击重置削波提示。',

  // ── metronome popover ──
  'player.metronome.title': '节拍器',
  'player.metronome.clickTitle': '播放时每个节拍都发出声音',
  'player.metronome.needsTempo': '需要先设置速度',
  'player.metronome.loudness': '音量',
  'player.metronome.loudnessTitle': '节拍声的音量——松开即可听到',
  'player.metronome.accent': '重音',
  'player.metronome.accentOnTitle': '每小节的第一拍声音更响亮',
  'player.metronome.accentOn': '强调第 1 拍',
  'player.metronome.accentOffTitle': '每个节拍声音相同——不标记小节',
  'player.metronome.gridView': '节拍网格',
  'player.metronome.gridViewOnTitle':
    '在波形上标出节拍线：每拍一条线，小节线为橙色——方便查看节拍是否对准歌曲',
  'player.metronome.gridViewShow': '显示',
  'player.metronome.tapHint': '继续敲击——连续稳定敲三次即可设定速度。',
  'player.metronome.noBeatCanDetect':
    '鼓声中没有找到稳定的节拍——预备拍将改为每秒一次。你可以自己敲击测速，或者试试重新检测。',
  'player.metronome.noBeatCannotDetect':
    '还没有速度——预备拍将改为每秒一次。敲击设定一个，或者分离这首歌后从鼓声中读取。',
  // e.g. "120.5 bpm · following the drums, drift and all — tap along during playback to re-anchor."
  'player.metronome.gridCaption': '{bpm} bpm · {source}——播放时跟着敲击即可重新校准。',
  'player.metronome.sourceAuto': '跟随鼓声，包括其漂移',
  'player.metronome.sourceManual': '手动设置',
  'player.metronome.gridData': '网格数据',
  'player.metronome.handTunedTitle': '此网格已经手动放置或修正——重新检测不会改动它',
  // {saved}/{current} are detector version numbers, e.g. "Saved with detector v17; this build has v19 and will re-derive on next open"
  'player.metronome.staleTitle':
    '保存时使用的是检测器 v{saved}；此版本为 v{current}，下次打开时会重新计算',
  'player.metronome.currentTitle': '保存的网格与此版本的检测器一致',
  'player.metronome.newerTitle':
    '由更新的检测器保存（v{saved}）；此版本为 v{current}，不会改动它。重新检测会用此版本较旧的网格替换它。',
  // the grid-version badge text, e.g. "hand-tuned (v17)"
  'player.metronome.handTuned': '手动调整（v{ver}）',
  'player.metronome.staleLabel': 'v{saved} → 有 v{current} 可用',
  'player.metronome.currentLabel': 'v{ver}——当前版本',
  'player.metronome.newerLabel': 'v{ver}——比此版本更新',
  'player.metronome.userBarsTitle':
    '你手动移动过的小节线。重新检测会将它们重新对齐到新的网格上——不会丢失。',
  // "· 1 hand-set bar" / "· 3 hand-set bars", next to the grid-version badge
  'player.metronome.userBars_one': '· {n} 条手动设置的小节线',
  'player.metronome.userBars_other': '· {n} 条手动设置的小节线',
  'player.metronome.countIn': '预备拍',
  'player.metronome.countInBarTitle': '播放开始前敲一个小节的预备拍',
  'player.metronome.countInSecTitle': '播放开始前敲三次，每秒一次',
  'player.metronome.oneBar': '1 小节',
  'player.metronome.threeSec': '3 秒',
  'player.metronome.countIn2BarTitle': '播放开始前敲两个小节的预备拍',
  'player.metronome.countIn2SecTitle': '播放开始前敲六次，每秒一次',
  'player.metronome.twoBars': '2 小节',
  'player.metronome.sixSec': '6 秒',
  'player.metronome.tempo': '速度',
  'player.metronome.tempoTitle': '歌曲本身的速度（播放速度不受影响）',
  'player.metronome.tap': '敲击',
  'player.metronome.tapTitle': '敲击节拍来设定速度（播放时还会锁定节拍相位）',
  'player.metronome.halfTime': '减半速度',
  'player.metronome.doubleTime': '倍速',
  'player.metronome.beatsPerBar': '每小节拍数',
  'player.metronome.align': '对齐',
  'player.metronome.nudgeEarlierTitle': '节拍声提前 10 毫秒',
  'player.metronome.nudgeLaterTitle': '节拍声延后 10 毫秒',
  // “1” refers to the first beat of the bar, kept as a literal digit in quotes
  'player.metronome.rotateAccentTitle': '将重音移到下一拍（当“1”落在错误的位置时）',
  'player.metronome.redetect': '重新检测',
  'player.metronome.redetectKeepBarsTitle':
    '重新从鼓声中读取速度和节拍——你手动放置的小节线会被保留',
  'player.metronome.redetectTitle': '重新从鼓声中读取速度和节拍',

  // ── training / carry the line popover ──
  'player.training.title': '接唱',
  'player.training.byTime': '按时间',
  'player.training.byLines': '按歌词行',
  'player.training.byLinesTitle': '按卡拉 OK 歌词行轮流切换',
  'player.training.switchEvery': '每隔',
  'player.training.hear': '聆听',
  'player.training.sing': '演唱',
  // e.g. "Guide plays 10 s, then you take the next 10 s."
  'player.training.captionTime': '引导演唱 {sec} 秒，然后由你接唱接下来的 {sec} 秒。',
  'player.training.captionLines_one': '聆听 {n} 行，然后自己演唱 {sing}。',
  'player.training.captionLines_other': '聆听 {n} 行，然后自己演唱 {sing}。',
  'player.training.captionNoLyrics': '还没有同步歌词——在加载完成前将按时间轮流切换。',
  'player.training.mutedWhileSinging': '你演唱时静音的音轨：',
  'player.training.mutedWhileSingingTitle': '轮到你演唱时，这些音轨会静音——由你自己演唱它们',

  // ── split menu (the Split/Re-split control in the transport) ──
  'player.split.title': '分离歌曲',
  'player.split.optionsTitle': '分离选项',
  'player.split.button': '分离',
  'player.split.backingHint': '点击以分离和声',
  'player.split.separateBacking': '分离和声',
  'player.split.resplitStems': '重新分离乐器分轨',
  'player.split.alreadySeparated': '这首歌的人声已经分离过了。',
  'player.split.explain':
    '生成人声、鼓、贝斯、吉他、钢琴和其他乐器分轨，然后将人声分离为主唱和和声。',
  'player.split.hint':
    '共两步，每步几分钟。模型只需下载一次。主唱和和声音轨以无压缩格式保存——每分钟歌曲约 40 MB，以保证精确。',

  // ── track stack (ruler, zoom controls, add-track) ──
  'player.stack.unmuteAll': '取消所有音轨静音',
  'player.stack.unsoloAll': '取消所有独奏',
  'player.stack.export': '导出音轨',
  'player.stack.exportTitle': '导出音轨',
  'player.stack.exportMode': '导出模式',
  'player.stack.exportStems': '独立音轨',
  'player.stack.exportFormat': '文件格式',
  'player.stack.exportOriginal': '原始音轨，不应用混音设置。',
  'player.stack.exportMp3Hint': '立体声 320 kbps / 单声道 160 kbps。',
  'player.stack.exportLosslessHint': '无损音频，16 位。',
  'player.stack.exportSelect': '选择音轨',
  'player.stack.exportKaraoke': '伴奏',
  'player.stack.exportKaraokeHint': '伴奏合并乐器和和声，不含主唱。仅在必要时降低音量以避免削波。',
  'player.stack.exportKaraokeNoBacking': '伴奏仅导出乐器。请先分离和声以将其包含在内。',
  'player.stack.exportHint': '原始音轨，不应用混音设置。WAV / FLAC：16 位；MP3：立体声 320 kbps / 单声道 160 kbps。',
  'player.stack.exportChoose': '选择文件夹并导出',
  'player.stack.exportCancel': '取消',
  'player.stack.exportDone': '音轨已导出',
  'player.stack.exportProgress': '正在导出',
  'player.stack.exportError': '无法导出音轨',
  'player.stack.addTrack': '+ 添加音轨…',
  'player.stack.addTrackTitle':
    '添加一个音频文件作为额外音轨——伴奏、你录制的和声，或节拍声。它从 0:00 开始播放，保存项目时会被复制进项目中。',
  'player.stack.zoomOutTitle': '缩小（也可用滚轮）',
  'player.stack.zoomInTitle': '以播放头为中心放大',
  'player.stack.showWholeSongTitle': '显示整首歌',
  'player.stack.full': '全部',

  // ── track lane (the per-stem controls beside each waveform) ──
  // "Name of the Vocals track" — {track} is the stem/lane's display label
  'player.lane.nameOf': '{track} 音轨的名称',
  'player.lane.renameTitle': '双击以重命名此音轨',
  'player.lane.rename': '重命名 {track}',
  'player.lane.remove': '从此项目中移除 {track}（你添加它时使用的文件仍保留在原处）',
  'player.lane.unmute': '取消静音',
  'player.lane.mute': '静音',
  'player.lane.unsolo': '取消独奏',
  'player.lane.solo': '独奏',
  'player.lane.volume': '音量',
  'player.lane.yourTurn': '轮到你了',

  // ── beat grid (the draggable bar-line handles over the waveforms) ──
  'player.beatGrid.dragTitle':
    '将小节线拖到小节真正开始的节拍上。Alt 点击你移动过的线可将其交还给检测器。',

  // ── pitch strip (melody line + mic pitch matching) ──
  'player.pitch.micUnavailableSettings': '设置窗口打开时麦克风不可用',
  'player.pitch.sing': '唱起来！',
  // e.g. "72% match"
  'player.pitch.matchPercent': '匹配度 {percent}%',
  'player.pitch.resizeTitle': '拖动以调整音高视图大小',
  // one-word row labels in the info panel: key, tempo, range, length
  'player.pitch.keyLabel': '调',
  'player.pitch.tempoLabel': '速度',
  'player.pitch.rangeLabel': '音域',
  'player.pitch.lengthLabel': '时长',
  // e.g. "from C major" — the key name before a transpose was applied
  'player.pitch.fromKey': '原调 {key}',
  // e.g. "reading melody… 42%"
  'player.pitch.readingMelody': '正在读取旋律… {percent}%',
  'player.pitch.findingBeat': '正在寻找节拍… {percent}%',
  'player.pitch.noteBars': '音符条',
  'player.pitch.noteBarsTitle': '每个唱出的音符对应一条稳定的条形——下方的细线保留真实音高',
  'player.pitch.fit': '适配',
  'player.pitch.fitTitle': '让音高范围适配这首歌的旋律',
  'player.pitch.micHint': '听到并对照歌曲旋律为你的音高打分',
  'player.pitch.micAriaLabel': '将我的演唱与歌曲旋律匹配',
  'player.pitch.micOn': '麦克风已开启',
  'player.pitch.micStarting': '正在启动…',
  'player.pitch.micBlocked': '麦克风被阻止——请检查系统设置',
  'player.pitch.micMatch': '匹配我的演唱',

  // ── DSP graph visualization (native playback diagnostics panel) ──

  // ── model.ts: fallback label for an added track with no name left after cleanup ──
  'player.track.untitled': '音轨',

  // ── DSP graph card: format line and the transport badge (Settings › Audio) ──
}
