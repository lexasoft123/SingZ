/* 简体中文 — the `library` strings, typed against English. */
import type { library as en } from '../en/library'
import type { Translation } from '../types'

export const library: Translation<typeof en> = {
  // ── shared across the library screens ──
  'library.common.close': '关闭',
  'library.common.browseFiles': '浏览文件…',
  'library.common.yourProjects': '你的项目',
  // fallback shown when an IPC failure carries no message of its own
  'library.common.unknownError': '未知错误',
  'library.common.finishGoogleSignIn': '请在浏览器中完成 Google 登录…',
  'library.common.syncFailed': '同步失败：{error}',

  // ── DropScreen (the Open/catalog screen) ──
  'library.dropScreen.cloudIcloud': '通过 iCloud 在你的设备间同步',
  'library.dropScreen.cloudOnedrive': '通过 OneDrive 在你的设备间同步',
  'library.dropScreen.cloudLocal': '仅保存在这台电脑上',
  'library.dropScreen.signInFailed': '登录失败：{error}',
  'library.dropScreen.deleteFailed': '无法删除：{error}',
  'library.dropScreen.justNow': '刚刚',
  // relative time, e.g. "5 min ago"
  'library.dropScreen.minAgo': '{mins} 分钟前',
  // relative time, e.g. "3 h ago"
  'library.dropScreen.hAgo': '{h} 小时前',
  'library.dropScreen.uploadingTitle': '正在上传到 Google Drive',
  'library.dropScreen.upToDateTitle': '已在 Google Drive 上——已是最新',
  // {reason}: the sync's own error text, or the "sync failed" fallback below
  'library.dropScreen.notOnDriveTitle': '尚未同步到 Google Drive——{reason}',
  'library.dropScreen.syncFailedFallback': '同步失败',
  'library.dropScreen.waitingTitle': '正在等待连接 Google Drive',
  'library.dropScreen.reading': '正在读取…',
  // {song}: the file name being opened
  'library.dropScreen.readingSong': '正在读取“{song}”…',
  'library.dropScreen.decodingAudio': '正在解码音频并绘制时间轴。',
  'library.dropScreen.yourCatalog': '你的目录。',
  // {song}: the name of the song still open behind this screen
  'library.dropScreen.catalogHint': '从下方选择一个项目，或将另一首歌拖到窗口的任意位置——在此之前，“{song}”会保持加载状态。',
  'library.dropScreen.escHint': '或按 Esc 回到当前歌曲',
  'library.dropScreen.dropASong': '拖入一首歌。',
  'library.dropScreen.dropHintDesc': 'MP3、WAV、FLAC 或 M4A——SingZ 会将它分离成人声、鼓、贝斯和其他乐器，让你在演唱时静音其中任意一条。',
  'library.dropScreen.dragHint': '或将它拖到窗口的任意位置',
  'library.dropScreen.searchPlaceholder': '搜索项目…',
  // {cloud}: one of the cloudIcloud/cloudOnedrive/cloudLocal lines above
  'library.dropScreen.libraryLivesHere': '你的曲库保存在这里 · {cloud}',
  'library.dropScreen.change': '更改…',
  // {msg}: the sync's own progress text (already words, not translated twice); {percent}: 0-100
  'library.dropScreen.copyingToDrive': '正在复制到你的 Google Drive… {msg} {percent}%',
  'library.dropScreen.driveCopyLives': '还有一份副本保存在你的 Google Drive 中',
  'library.dropScreen.upToDate': '已是最新',
  'library.dropScreen.keepCopyHint': '在 Google Drive 中保留一份副本，方便手机流式播放',
  'library.dropScreen.syncLog': '同步日志',
  'library.dropScreen.syncNow': '立即同步',
  'library.dropScreen.connect': '连接…',
  // always plural in English, even for a single stem — kept as-is on purpose
  'library.dropScreen.stemsCount_one': '{n} 条分轨',
  'library.dropScreen.stemsCount_other': '{n} 条分轨',
  'library.dropScreen.noStems': '没有分轨',
  // short badge word appended after the stem count, e.g. "3 stems · lyrics"
  'library.dropScreen.lyricsBadge': '歌词',
  // {name}: the project's name
  'library.dropScreen.deleteTitle': '从你的曲库中删除“{name}”',
  'library.dropScreen.deleteAria': '删除 {name}',
  // {query}: what the singer typed into the search box
  'library.dropScreen.noMatches': '没有与“{query}”匹配的结果。',
  'library.dropScreen.deleteHeading': '删除“{name}”？',
  // {stems}: either the stemsCount text above or eraseStemsFallback; {lyrics}: eraseLyricsSuffix or nothing; {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.eraseBody': '这会删除整个项目文件夹——{stems}{lyrics}，以及你的混音、移调和“接唱”设置，共计 {size}。它不会进入回收站，且在这里无法撤销。',
  // stands in for the stem count above when the project has not been split yet
  'library.dropScreen.eraseStemsFallback': '这首歌',
  // appended only when the project has synced lyrics — keep the leading comma
  'library.dropScreen.eraseLyricsSuffix': '、它的歌词',
  'library.dropScreen.openSongNote': '这是你当前打开的歌曲——它会一直播放，直到你加载另一首歌，但已经没有地方可以保存它了。',
  'library.dropScreen.driveTrashNote': 'Google Drive 中的副本会在下次同步时移入 Drive 的回收站，30 天内可以恢复——你的手机将不再列出它。',
  'library.dropScreen.resplitNote': '以后再次分离它意味着分离引擎要再运行一次。',
  'library.dropScreen.keepIt': '保留它',
  'library.dropScreen.deleting': '正在删除…',
  // {size}: a formatted byte size, e.g. "240 MB"
  'library.dropScreen.deleteSize': '删除 {size}',

  // ── ProjectPicker (the "Your projects" dialog) ──
  'library.projectPicker.googleSignInFailed': 'Google 登录失败：{error}',
  'library.projectPicker.syncingToDrive': '正在将你的项目同步到 Drive…',
  // {uploaded}/{unchanged}: project counts
  'library.projectPicker.driveUpToDate': 'Drive 已是最新——已上传 {uploaded} 个，{unchanged} 个未变化。你的手机会在 Google Drive 下看到它们。',
  'library.projectPicker.movedIn_one': '已移入——复制了 {n} 个项目。',
  'library.projectPicker.movedIn_other': '已移入——复制了 {n} 个项目。',
  'library.projectPicker.switchFailed': '无法切换：{error}',
  // {root}: the folder path being listed
  'library.projectPicker.looking': '正在查找 {root}…',
  // stands in for the path while it is still loading
  'library.projectPicker.defaultFolder': '你的项目文件夹',
  // **Save project** stays bold; {root}: the library folder path, also bold
  'library.projectPicker.emptyHint': '还没有保存任何内容。加载一首歌并点击**保存项目**——它会连同分轨、歌词和设置存放到**{root}**中。',
  // small badge word on a project row that has split stems
  'library.projectPicker.stemsBadge': '分轨',
  // small badge word on a project row that has synced lyrics
  'library.projectPicker.lyricsBadge': '歌词',
  'library.projectPicker.storedIn': '存放在 {root}',
  // {path}: a cloud folder's filesystem path
  'library.projectPicker.cloudTitle': '{path} ——同步到你的其他设备，包括手机应用',
  // {label}: a cloud provider's name, e.g. "iCloud Drive"
  'library.projectPicker.inCloud': '已在 {label} 中 ✓',
  'library.projectPicker.useCloud': '使用 {label}',
  'library.projectPicker.gdriveConnectTitle': '将你的项目推送到 Google Drive 中的一个 SingZ 文件夹——手机可以直接从那里流式播放，不需要安装 Drive 应用',
  'library.projectPicker.syncToDrive': '同步到 Google Drive',
  'library.projectPicker.connectDrive': '连接 Google Drive…',
  'library.projectPicker.signOut': '退出登录',
  'library.projectPicker.signedOut': '已退出 Google Drive 登录。',
  'library.projectPicker.chooseFolder': '选择文件夹…',
  'library.projectPicker.backToDocuments': '返回“文档”',
  'library.projectPicker.moving': '正在复制你的项目——已有的文件保持不变…',

  // ── LibraryImport (adopt a project found outside the library) ──
  'library.libraryImport.heading': '添加到你的曲库',
  // {dir}/{root}: filesystem paths, both stay bold
  'library.libraryImport.body': '这个项目位于 **{dir}**，在你的曲库之外。它在那里也能正常播放和保存——添加它会把它放进 **{root}**，Open 界面会列出它，Drive 同步也会拾取它。',
  'library.libraryImport.copyIn': '复制进来',
  'library.libraryImport.copyInTitle': '将文件夹复制一份到你的曲库中——原件保留在原处',
  'library.libraryImport.moveIn': '移动进来',
  'library.libraryImport.moveInTitle': '将文件夹迁移到你的曲库中——不会留下任何原件',
  'library.libraryImport.workingHint': '正在处理——一个带分轨的项目有几百 MB，请稍等…',
  'library.libraryImport.copyMoveHint': '复制不会影响原件，如果这个文件夹还有别人在用，就选复制。移动会把它连同分轨一起带走。',

  // ── LogPanel (chrome only — the log lines themselves stay English) ──
  'library.logPanel.title': '日志',
  'library.logPanel.whichLaunch': '选择哪次启动的日志',
  'library.logPanel.thisSession': '本次会话',
  // {shown}/{total}: line counts
  'library.logPanel.linesTail': '显示最后 {shown} 行，共 {total} 行——“保存到文件”会包含全部内容',
  'library.logPanel.linesCount': '{n} 行',
  'library.logPanel.copy': '复制',
  'library.logPanel.copied': '已复制 ✓',
  'library.logPanel.saveToFile': '保存到文件…',
  'library.logPanel.loading': '正在加载…',
  'library.logPanel.nothingLogged': '还没有任何日志。',
  'library.logPanel.savedTo': '已保存到 {path}',

  // ── DropScreenRoute (loading / recovery states around the catalog) ──
  'library.route.eyebrow': '曲库',
  'library.route.opening': '正在打开你的歌曲…',
  'library.route.loadingStatus': '正在加载曲库。',
  'library.route.didntOpenHeading': '你的曲库没有打开',
  'library.route.didntOpenBody': '曲库界面未能加载。当前打开的歌曲和音频会话都不受影响。',
  'library.route.retry': '重试',
  'library.route.recoveryFailed': '恢复副本也未能加载。请重启 SingZ 后再试。',
  'library.route.openSongFile': '打开一个歌曲文件',
  'library.route.stoppedHeading': '你的曲库已停止',
  'library.route.stoppedBody': '已加载的曲库界面遇到了问题。请重启 SingZ 后再重新打开它；已经开始的同步或删除操作可能仍在完成中。',
  'library.route.openLog': '打开日志',

  // ── split-workflow (the split progress bar's stage labels) ──
  'library.splitWorkflow.warmingUp': '正在预热',
  'library.splitWorkflow.downloadingModel': '正在下载模型',
  'library.splitWorkflow.splittingStems': '正在分离分轨',
  'library.splitWorkflow.loadingStems': '正在加载分轨',
  'library.splitWorkflow.loadingVocals': '正在加载人声',
  'library.splitWorkflow.separatingVocals': '正在分离人声',
  // {step}: 1 or 2; {label}: one of the stage labels above
  'library.splitWorkflow.combinedLabel': '{step}/2 · {label}',

  // ── playback-error-toast ──
  // {message}: the underlying provider/engine failure text
  'library.playbackErrorToast.couldNotStart': '无法开始播放：{message}',

  // ── audio/engine (the one status genuinely shown to the singer, as this toast) ──
  'library.engine.songUnreadable': '无法从磁盘重新读取这首歌，因此没有内容可以播放。'
}
