/* 简体中文 — the `library` strings, typed against English. */
import type { library as en } from '../en/library'
import type { Translation } from '../../../../src/shared/i18n/types'

export const library: Translation<typeof en> = {
  // ── add-song errors ──
  'phone.library.pickFailed': '无法打开该文件（{msg}）',
  'phone.library.folderInactive': '所选文件夹已失效。请重新打开它并重试。',
  'phone.library.folderIdentityUnavailable': '无法获取所选文件夹的身份信息。请重新打开该文件夹并重试。',
  'phone.library.folderPickerError': '文件夹选择器：{error}',
  'phone.library.projectDocumentNotWritten': '项目文档未能写入。',
  'phone.library.decodeTimeout': '它没有在 90 秒内打开',

  // ── forget / free space ──
  'phone.library.forgetBody': '从此手机中移除 {size}？这首歌仍会留在你的曲库中——再次打开时会重新下载。',
  'phone.library.keepIt': '保留',
  'phone.library.remove': '移除',
  'phone.library.freeUpSpace': '释放空间',
  'phone.library.freeUpSpaceBody': '删除 {size} 已下载的歌曲？它们仍会留在你的曲库中——只要有网络信号，你可以随时重新下载。',
  'phone.library.keepThem': '保留',
  'phone.library.delete': '删除',

  // ── opening a song ──
  'phone.library.opening': '正在打开…',
  'phone.library.decoding': '正在解码 {id} · {i}/{n}',
  'phone.library.fetchingStep': '正在获取 {id} · {i}/{n}',
  'phone.library.decodingStep': '正在解码 {id} · {i}/{n}',
  'phone.library.lyricsStep': '歌词…',
  'phone.library.fetchingLyricsStep': '正在获取歌词…',
  'phone.library.songTooBigToPlay':
    '播放这首歌大约需要 {gb} GB 内存——对这台手机来说太长了。请尝试较短的歌曲，或在电脑上先分离它。',
  'phone.library.addedTrackLoadFailed':
    '无法加载已添加的音轨“{label}”。由于每条已保存的音轨都必须可用，这首歌未能打开。{detail}',

  // ── lyrics lookup from the card ──
  'phone.library.lookingForLyrics': '正在查找歌词…',
  'phone.library.noLyricsYet': '暂无歌词',
  'phone.library.lyricsServiceDown': '歌词服务没有响应——请稍后再试。',
  'phone.library.lyricsNoMatch': '没有找到与这个标题匹配的结果。也可以在电脑上添加歌词。',

  // ── beat models (Better beats) ──
  'phone.library.betterBeats': '更精准的节拍',
  'phone.library.downloadBeatModelsTitle': '下载节拍模型？',
  'phone.library.downloadBeatModelsBody': '{mb} MB，仅需一次。之后分析的每首歌都会用到它们。',
  'phone.library.notNow': '暂不',
  'phone.library.download': '下载',
  'phone.library.couldNotDownloadBeatModels': '无法下载节拍模型',
  'phone.library.downloadingBeatModels': '正在下载节拍模型 — {got}/{total} MB',
  'phone.library.betterBeatsOfferBody':
    '一次 {mb} MB 的下载，能听出安静前奏和自由节奏中鼓声单独无法捕捉的节拍。已经有节拍网格的歌曲会保留原有的网格。',
  'phone.library.cancel': '取消',
  'phone.library.waitingThenSplitter': '正在等待节拍模型下载完成——之后是分离引擎（{mb} MB，仅需一次）',
  'phone.library.downloadingSplitter': '正在下载分离引擎 — {got}/{total} MB，仅需一次',
  'phone.library.sampleTitle': '示例 — {name}',

  // ── splitting a song into stems ──
  'phone.library.readingTheSong': '正在读取歌曲…',
  'phone.library.warmingUp': '正在预热…',
  'phone.library.splittingChunk': '正在分离分轨 — 第 {done}/{total} 段',
  'phone.library.splittingEllipsis': '正在分离分轨…',
  'phone.library.splitFailed': '分离失败',
  'phone.library.splitNeverStarted': '分离从未开始——请重试',
  'phone.library.splitInterrupted': '分离被中断了',
  'phone.library.tooBigToSplitTitle': '这首歌太大，无法在这里分离',
  'phone.library.starting': '正在开始…',
  'phone.library.couldNotStartSplitTitle': '无法开始分离',
  'phone.library.splittingNotAvailable': '此手机上尚不支持分离',
  'phone.library.splitEngineHeldCopy':
    '上一次的分离仍卡在这台手机上。请完全退出 SingZ 后重新打开，再进行分离。',
  'phone.library.splitThisSongTitle': '分离这首歌？',
  'phone.library.splitThisSongBody':
    '手机会把它分离成人声、鼓、贝斯等——需要几分钟时间，首次还需一次性下载 136 MB。',
  'phone.library.failedSplitDiscarded': '\n\n“{name}”失败的分离将被丢弃。',
  'phone.library.splitButton': '分离',
  'phone.library.almostDoneSplittingTitle': '分离即将完成',
  'phone.library.almostDoneSplittingBody': '这首歌正在收尾——请稍后再删除。',
  'phone.library.finishingUp': '正在收尾…',
  'phone.library.stopping': '正在停止…',
  'phone.library.resume': '继续',
  'phone.library.discard': '丢弃',
  'phone.library.splitUnavailableBusy': '分离 — 另一项分离正在进行，暂不可用',
  'phone.library.splitInto': '将 {name} 分离成分轨',
  'phone.library.notSplitYet': '尚未分离',
  'phone.library.keepsFailingCopy':
    '这首歌在此手机上一直分离失败。请改在电脑上添加它——它会同步过来，随时可以演唱。',
  'phone.library.fileFailingCopy':
    '这台手机无法读取这首歌的文件。请换一份文件试试——或在电脑上添加它，它会同步过来，随时可以演唱。',
  'phone.library.stemsCount_one': '{n} 条分轨',
  'phone.library.stemsCount_other': '{n} 条分轨',
  'phone.library.addedSuffix': ' · 已添加 {n} 条',
  'phone.library.lyricsSuffix': ' · 歌词',
  'phone.library.updateOnDesktop': ' · 请在电脑上更新',

  // ── delete ──
  'phone.library.deleteThisSongTitle': '删除这首歌？',
  'phone.library.deleteThisSongBody': '“{name}”及其文件将被删除。',

  // ── header / nav ──
  'phone.library.openSettings': '打开设置',
  'phone.library.settings': '设置',
  'phone.library.openLog': '打开日志',
  'phone.library.log': '日志',
  'phone.library.driveTab': 'Drive',
  'phone.library.folderTab': '文件夹',
  'phone.library.thisIphone': '此 iPhone',
  'phone.library.thisPhone': '此手机',

  // ── source descriptions (the banner under the three tabs) ──
  'phone.library.driveSrcTitle': '你电脑上的曲库，通过 Drive 同步',
  'phone.library.folderSrcTitle': '此手机可以读取的共享文件夹',
  'phone.library.songsAddedIphone': '在此 iPhone 上添加的歌曲',
  'phone.library.songsAddedPhone': '在此手机上添加的歌曲',
  'phone.library.noSignalLastSync': '无信号——显示上次同步的内容',
  'phone.library.signedInToDrive': '已登录 Google Drive',
  'phone.library.signOut': '退出登录',
  'phone.library.signInToSeeIt': '登录即可查看',
  'phone.library.signIn': '登录',
  'phone.library.noFolderPicked': '尚未选择文件夹',
  'phone.library.change': '更改…',
  'phone.library.filesCopiedIphone': '你复制到此 iPhone 上的文件',
  'phone.library.filesCopiedPhone': '你复制到此手机上的文件',
  'phone.library.addASong': '添加歌曲',
  'phone.library.driveNotConfigured': '此版本未配置 Google Drive',
  'phone.library.driveNotSignedIn': '未登录 Google Drive',
  'phone.library.driveSessionExpired': 'Google Drive 会话已过期——请重新登录',
  'phone.library.driveNoSingzFolder':
    '此 Google Drive 中还没有 SingZ 文件夹——请先从电脑同步一个项目',

  // ── crash note banner ──
  'phone.library.lastOpenCrashed': '上次打开时，应用在{note}期间崩溃了。',
  'phone.library.openLogToReport': '打开日志以报告此问题',
  'phone.library.report': '报告',
  'phone.library.dismissCrashNotice': '关闭崩溃提示',
  'phone.library.tapToDismiss': '{error}。点按即可关闭。',

  // ── card ──
  'phone.library.opensTheSong': '打开这首歌。',
  'phone.library.stopOpeningSong': '停止打开这首歌',
  'phone.library.onThisPhone': '在此手机上',
  'phone.library.notDownloadedSize': '未下载，{size}',
  'phone.library.notDownloaded': '未下载',
  'phone.library.detectBeatAgainFor': '重新检测“{title}”的节拍',
  'phone.library.findLyricsFor': '查找“{title}”的歌词',
  'phone.library.deleteFromPhone': '从此手机删除“{title}”',
  'phone.library.removeDownloadedFiles': '移除“{title}”已下载的文件',

  // ── list groups / empty states ──
  'phone.library.ready': '就绪',
  'phone.library.notReadyYet': '尚未就绪',
  'phone.library.bundledAlwaysAvailable': '内置 · 始终可用',
  'phone.library.loadingFromDrive': '正在从 Google Drive 加载你的曲库…',
  'phone.library.loadingEllipsis': '正在加载…',
  'phone.library.noSongCalled': '这里没有名为“{query}”的歌曲。',
  'phone.library.noSongsIphone':
    '此 iPhone 上还没有歌曲。请在上方添加一首——它会立即可以播放，也可以在这里分离成分轨。',
  'phone.library.noSongsPhone':
    '此手机上还没有歌曲。请在上方添加一首——它会立即可以播放，也可以在这里分离成分轨。',
  'phone.library.driveEmptySignedIn':
    '你的 Google Drive 曲库中还没有内容。在电脑上保存一首歌，它就会同步过来。',
  'phone.library.driveEmptySignedOut': '请在上方登录，即可查看你电脑放到 Google Drive 中的歌曲。',
  'phone.library.folderEmptyIos':
    '此文件夹中没有项目。请在电脑上把项目保存到共享文件夹（iCloud Drive/SingZ）中，或在上方选择其他文件夹。',
  'phone.library.folderEmptyAndroid':
    '此文件夹中没有项目。请将项目文件夹从电脑复制到此手机，或在上方选择一个已同步的文件夹。',
  'phone.library.storage_one': '{n} 首歌在此手机上 · {size} — 无需联网即可播放',
  'phone.library.storage_other': '{n} 首歌在此手机上 · {size} — 无需联网即可播放',

  // ── search ──
  'phone.library.findASong': '查找歌曲',
  'phone.library.findASongLabel': '按名称查找歌曲',
  'phone.library.clearSearch': '清除搜索',

  // ── add-song sheet ──
  'phone.library.addSongCancelA11y': '取消添加这首歌',
  'phone.library.addingToPhone': '正在添加到此手机…',
  'phone.library.copyingFile': '正在复制文件——普通歌曲只需几秒钟。',
  'phone.library.unreadableFile':
    '此文件在这台手机上无法播放——可能是 SingZ 不支持的格式。详情见日志。',
  'phone.library.close': '关闭',
  'phone.library.titleLabel': '标题',
  'phone.library.songTitlePlaceholder': '歌曲标题',
  'phone.library.artistLabel': '艺人',
  'phone.library.artistPlaceholder': '有助于找到正确的歌词',
  'phone.library.addSongDuration': '{mins}:{secs} — {name}',
  'phone.library.findLyricsButton': '查找歌词',
  'phone.library.addWithoutLyrics': '不添加歌词',
  'phone.library.syncedLyricsFound': '找到了同步歌词',
  'phone.library.useTheseLyrics': '使用这些歌词',
  'phone.library.skip': '跳过',
  'phone.library.editTitle': '编辑标题',
  'phone.library.moreLines': '……{n} 行',
  'phone.library.lyricsServiceDownStillAdds':
    '歌词服务没有响应——歌曲仍会正常添加，之后可以从它的卡片中查找歌词。',
  'phone.library.tryAgain': '重试',
  'phone.library.noExactMatch': '没有完全匹配的结果。',
  'phone.library.closeMatches': '相近的结果：',
  'phone.library.searchAgain': '重新搜索',
  'phone.library.syncedSuffix': ' · 已同步',
  'phone.library.textOnlySuffix': ' · 仅文本',

  // ── moving songs to Google Drive (Phase 6) ──
  'phone.library.moveBusyTitle': '正在将歌曲添加到 Google Drive',
  'phone.library.moveBusyBody': '请先停止，或等它完成——之后文件夹才会打开。',
  'phone.library.onItsWayTitle': '正在发送到 Google Drive',
  'phone.library.onItsWayBody': '请先停止迁移，或稍等片刻。',
  'phone.library.addingASongToDrive': '正在将一首歌曲添加到 Google Drive',
  'phone.library.addingSongsToDrive': '正在将歌曲添加到 Google Drive',
  'phone.library.stoppingAfterFile': '完成此文件后停止…',
  'phone.library.songOfCountPct': '第 {index}/{count} 首 · {pct}%',
  'phone.library.stop': '停止',
  'phone.library.movingToDrive': '正在迁移到 Google Drive…',
  'phone.library.alsoInDriveSuffix': '也在 Google Drive 中 · ',

  // ── moving songs to Google Drive: the offer ──
  'phone.library.driveOfferTitle': 'Google Drive',
  'phone.library.deviceIphone': 'iPhone',
  'phone.library.devicePhone': '手机',
  'phone.library.offerLeadPartialOne':
    '此 {device} 上的 1 首歌曲，约 {bytes}。它将迁移到你的 Drive 曲库，从 Drive 标签页播放，且已下载好。',
  'phone.library.offerLeadPartialOther':
    '此 {device} 上的 {n} 首歌曲，约 {bytes}。它们将迁移到你的 Drive 曲库，从 Drive 标签页播放，且已下载好。',
  'phone.library.offerLeadAllOne':
    '此 {device} 上的这首歌曲，约 {bytes}。它将迁移到你的 Drive 曲库，从 Drive 标签页播放，且已下载好。',
  'phone.library.offerLeadAllTwo':
    '此 {device} 上的这两首歌曲，约 {bytes}。它们将迁移到你的 Drive 曲库，从 Drive 标签页播放，且已下载好。',
  'phone.library.offerLeadAllOther':
    '此 {device} 上的全部 {n} 首歌曲，约 {bytes}。它们将迁移到你的 Drive 曲库，从 Drive 标签页播放，且已下载好。',
  'phone.library.offerUnsplit_one': ' 还有一首尚未分离的歌曲会留在这里。',
  'phone.library.offerUnsplit_other': ' 还有 {n} 首尚未分离的歌曲会留在这里。',
  'phone.library.offerCopies_one': ' 还有一首已在你 Drive 曲库中的歌曲也会留在这里。',
  'phone.library.offerCopies_other': ' 还有 {n} 首已在你 Drive 曲库中的歌曲也会留在这里。',
  'phone.library.addAllLocalSongs': '将全部本地歌曲添加到 Google Drive',

  // ── moving songs to Google Drive: the confirm ──
  'phone.library.addConfirmTitleOne': '将这首歌曲添加到 Google Drive？',
  'phone.library.addConfirmTitleTwo': '将这两首歌曲添加到 Google Drive？',
  'phone.library.addConfirmTitleOther_one': '将全部 {n} 首歌曲添加到 Google Drive？',
  'phone.library.addConfirmTitleOther_other': '将全部 {n} 首歌曲添加到 Google Drive？',
  'phone.library.addConfirmBodyOne':
    '将上传 {bytes}。这首歌曲一旦安全存入 Drive 就会从 {here} 移除，并改由 Drive 标签页播放，且已下载好。随时可以停止——只要还没上传完，它就会留在这里。',
  'phone.library.addConfirmBodyMany':
    '将上传 {bytes}。每首歌曲一旦安全存入 Drive 就会从 {here} 移除，并改由 Drive 标签页播放，且已下载好。随时可以停止——尚未上传的都会留在这里。',
  'phone.library.add': '添加',
  'phone.library.addAll': '全部添加',
  'phone.library.hereIphone': '此 iPhone',
  'phone.library.herePhone': '此手机',

  // ── moving songs to Google Drive: how a batch ended ──
  'phone.library.songsCount_one': '{n} 首歌曲',
  'phone.library.songsCount_other': '{n} 首歌曲',
  'phone.library.showMe': '带我去看看',
  'phone.library.openDrive': '打开 Drive',
  'phone.library.ok': '好',
  'phone.library.twoInARowFailed':
    '接连两首歌曲上传失败（{message}）——很可能是网络断开了。等重新联网后再试一次。',
  'phone.library.stoppedPartWay': '中途已停止',
  'phone.library.notAddedYet': '还没有添加',
  'phone.library.alreadyAdding': '已经在将歌曲添加到 Google Drive。',
  'phone.library.sizeMb': '{n} MB',
  'phone.library.sizeGb': '{n} GB',
  'phone.library.wentUpBeforeStopped': '\n\n{songs}在停止前已上传；其余的仍在{here}上。',
  'phone.library.everythingStillOn': '\n\n一切都仍在{here}上。',
  'phone.library.nothingLeftToAdd': '没有可添加的了',
  'phone.library.thoseSongsGone': '这些歌曲已不在{here}上了。',
  'phone.library.addedToGoogleDrive': '已添加到 Google Drive',
  'phone.library.nothingWentUp': '没有任何内容上传',
  'phone.library.movedOneWithSkip': '1 首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.movedOneNoSkip': '这首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.movedManyWithSkip_one': '{n} 首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.movedManyWithSkip_other': '{n} 首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.movedTwoNoSkip': '这两首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.movedAllNoSkip_one': '全部 {n} 首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.movedAllNoSkip_other': '全部 {n} 首歌曲现已在你的 Google Drive 曲库中——已下载好，可以立即播放。',
  'phone.library.syncsNextTimeOne': '你的电脑会在下次同步时把它加入自己的曲库。',
  'phone.library.syncsNextTimeMany': '你的电脑会在下次同步时把它们加入自己的曲库。',
  'phone.library.stayedOnPhone': '{songs}留在了{here}上：{reasons}',
  'phone.library.moreInLog': '——还有更多，详见日志。',

  // ── moving songs to Google Drive: skip / stop reasons (also used by publish.ts) ──
  'phone.library.skipInUse': '它正在使用中——已打开、正在分离或正在分析',
  'phone.library.skipAlreadyInDrive': '它已经在你的 Google Drive 曲库中',
  'phone.library.notSplitForMove': '请先将这首歌曲分离成分轨——之后才能迁移到 Google Drive。',
  'phone.library.signInFirstForMove': '请先登录 Google Drive——打开上方的 Drive 标签页。',
  'phone.library.updateDesktopForMove':
    '请先在电脑上更新 SingZ。同步此 Drive 的旧版本会移除它没有创建的歌曲，这些歌曲将从 Drive 中丢失。',
  'phone.library.stoppedSongStill': '已停止——这首歌曲仍在此手机上。',
  'phone.library.stoppedRestStill': '已停止——其余的仍在此手机上。',
  'phone.library.connectionDroppedSkip': '还没上传完网络就断开了——它会随下一次"全部添加"一起处理'
}
