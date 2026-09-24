/* 简体中文 — the `main` strings, typed against English. */
import type { main as en } from '../en/main'
import type { Translation } from '../types'

export const main: Translation<typeof en> = {
  // ── errors ──
  'main.error.fileNotRegistered': '文件未注册。',
  'main.error.folderNotRegistered': '文件夹未注册。',
  'main.error.playbackInvalidConfig': '原生播放需要一个有限的项目和音轨列表。',
  'main.error.playbackLaneSchema': '原生播放音轨未通过严格的结构校验。',
  'main.error.playbackLaneUnauthorized': '每条原生播放音轨都必须获得授权，并由可信的解码运行时支持。',

  // ── dialogs ──
  'main.dialog.chooseProjectsRoot': '选择 SingZ 保存项目的位置',

  // ── projects: format / library errors ──
  'main.error.notProjectFolder': '不是项目文件夹',
  'main.error.stemsNotConverted': '部分分轨无法转换',
  // {dir} is a filesystem path
  'main.error.notReadableProjectFolder': '{dir} 不是可读取的项目文件夹。',
  'main.error.invalidGraphHash': 'project.json 中的 graphHash 无效。',
  // {have}/{supported} are graph document format version numbers
  'main.error.graphFormatUnsupported': '此项目使用图文档格式 {have}；此版本支持的格式为 {supported}。',
  'main.error.invalidGraphFormatOrSize': 'project.json 指定了无效的图文档格式或大小。',
  'main.error.graphMissing': 'graph.json 缺失。',
  'main.error.graphMismatch': 'graph.json 与 project.json 记录的大小和 md5 不匹配。',
  'main.error.graphUnsupportedFormat': 'graph.json 使用了不支持的格式。',
  // {message} is a lower-level parser error, not itself translated
  'main.error.graphInvalid': 'graph.json 无效：{message}',
  'main.error.notSavedProject': '这不是一个已保存的项目。',
  // {format} is a graph document format version number
  'main.error.cannotWriteGraphFormat': '此版本无法写入图文档格式 {format}。',
  'main.error.graphDisappeared': 'graph.json 在发布前消失了。',
  'main.error.songMoved': '这首歌已不在原来的位置——请重新打开并再次保存。',
  'main.error.leadVocalNotIssued': '替换的主唱不是本次会话生成的。请重新分离。',
  'main.error.songNotSavedYet': '这首歌还不是一个已保存的项目。',
  // {name} is the project's (song) name the singer chose
  'main.error.projectNameExists': '已存在名为“{name}”的项目。',
  'main.error.folderNotInLibrary': '该文件夹不是你曲库中的项目。',
  'main.error.folderNotSavedProject': '该文件夹不是一个已保存的项目。',
  'main.error.projectAlreadyInLibrary': '此项目已经在你的曲库中。',
  'main.error.projectNameAlreadyInLibrary': '名为“{name}”的项目已经在你的曲库中。',

  // ── separation (splitter) ──
  'main.error.splitterNotDownloaded': '分离引擎尚未下载。',
  // engine descriptions shown as a tooltip (e.g. "manage splitter pack (ONNX)")
  'main.engine.onnxPack': '分离引擎包（ONNX）',
  'main.engine.cpuPackNoGpu': '分离引擎包（CPU——此引擎包没有 GPU 引擎，请在模型管理器中更新）',
  'main.engine.trtrtxPack': '分离引擎包（TensorRT RTX）',
  'main.engine.cpuPackGpuOff': '分离引擎包（CPU——此处已关闭 GPU 引擎）',
  'main.error.separationAlreadyRunning': '已经有一个分离任务在运行。',
  // {ext} is a file extension, e.g. ".m4a"
  'main.error.splitterUnsupportedFormat': '分离引擎只能读取 WAV/MP3/FLAC/OGG——请先转换 {ext}。',
  // {message} is a low-level OS/process error, not itself translated
  'main.error.couldNotStartDemucs': '无法启动 demucs：{message}',
  'main.error.cancelled': '已取消。',
  'main.error.notStarted': '尚未开始',
  'main.error.couldNotStartGpuPack': '无法启动 GPU 引擎包：{message}',
  'main.error.gpuEngineTooSlow': 'GPU 引擎在这台设备上运行得太慢。',

  // ── separation: friendlyError (parsed from engine stderr) ──
  'main.error.gpuOutOfMemory': '显卡的显存不足以运行此模型。',
  'main.error.gpuDriverHung': '运行此模型时显卡驱动停止响应（Windows 重置了 GPU）。',
  'main.error.gpuDeviceRemoved': '显卡驱动无法运行此模型（GPU 设备已被移除）。',
  'main.error.splitterMissingModel': '分离引擎缺少模型——请打开模型管理器（分离引擎标签）重新下载。',
  'main.error.demucsNeedsTorchCodec':
    '此 demucs 安装已无法读取音频（torchaudio 现在需要 TorchCodec）。请更新它（pipx upgrade demucs）或安装 ffmpeg（brew install ffmpeg）。',
  'main.error.demucsBrokenInstall':
    'demucs 的安装似乎已损坏（缺少 Python 模块）。请尝试：pipx reinstall demucs && pipx inject demucs numpy',
  'main.error.couldNotReadAudioFile': '无法读取该音频文件。请确认已安装 ffmpeg（brew install ffmpeg），并确认该文件可以正常播放。',
  'main.error.splitterOutOfMemory': '分离引擎内存不足。请关闭其他应用后重试。',
  // {tail} is the last few lines of the engine's own error output, not translated
  'main.error.separationFailed': '分离失败：{tail}',
  'main.error.unknownError': '未知错误',
  // {stem} is a stem name, e.g. "vocals"
  'main.error.gpuPackNoStemFile': 'GPU 引擎包没有生成 {stem} 文件',

  // ── model manager: model catalog labels/descriptions ──
  'main.model.splitter.label': '分离引擎 · AI',
  'main.model.splitter.descriptionWin':
    '将歌曲拆分为七条音轨——主唱、和声、鼓、贝斯、吉他、钢琴及其他——在 GPU 上运行时飞快（GeForce RTX 30 系列及以上；否则使用 CPU）。',
  'main.model.splitter.descriptionAppleSilicon':
    '将歌曲拆分为七条音轨——主唱、和声、鼓、贝斯、吉他、钢琴及其他——借助 Apple 芯片的 GPU，只需几秒钟。',
  'main.model.splitter.descriptionGeneric': '将歌曲拆分为七条音轨——主唱、和声、鼓、贝斯、吉他、钢琴及其他。',
  'main.model.qwenAsr.label': '语音模型 · 歌词',
  'main.model.qwenAsr.description':
    '听人声：在没有在线歌词时识别歌词，并对照实际演唱内容检查和对齐已下载的歌词。基于歌声训练，支持 30 种语言，并自带自己的分词对齐器。',
  'main.model.aligner.label': '精确分词对齐器',
  'main.model.aligner.description': '将每个歌词单词对齐到实际演唱的精确时刻——最精准的卡拉 OK 时序，支持 1,100 多种语言。通过分离引擎运行。',

  // ── model manager: download errors ──
  // {status} is an HTTP status code
  'main.error.downloadFailedHttp': '下载失败（HTTP {status}）',
  // {got}/{total} are megabyte amounts already formatted to one decimal
  'main.error.downloadStoppedShort': '下载中断——服务器承诺 {total} MB，实际只收到 {got} MB。请重试。',
  'main.error.downloadOverran': '下载超量——服务器承诺 {total} MB，实际收到了 {got} MB。请重试。',
  'main.error.splitterPackIncompatible': '下载的分离引擎与此版本不兼容。你安装的分离引擎未被改动。',
  'main.error.modelDownloadAlreadyRunning': '已经有一个模型下载在运行。',

  // ── lyrics ──
  'main.error.entryNoUsableSyncedLyrics': '该条目没有可用的同步歌词。',
  'main.error.noLinesToSave': '没有可保存的歌词行。',
  'main.error.couldNotSaveLyrics': '无法保存歌词：{message}',
  'main.error.lyricsJobAlreadyRunning': '已经有一个歌词任务在运行。',
  'main.error.noLinesToAlign': '没有可对齐的歌词行。',
  'main.error.splitFirstAlign': '请先将歌曲拆分为分轨——对齐需要听取人声音轨。',
  'main.error.preciseNeedsPack': '精确对齐需要通过分离引擎包运行——请先在模型管理器中安装它。',
  'main.error.preciseNeedsAlignerModel': '精确对齐需要多语言对齐模型。',
  'main.error.couldNotDownloadAlignerModel': '无法下载对齐模型：{message}',
  'main.error.splitFirstLyrics': '请先将歌曲拆分为分轨——歌词需要从人声音轨中读取。',
  'main.error.lyricsEngineMissing': '此版本中缺少歌词引擎。',
  'main.error.hearingNeedsSpeechModel': '听取人声需要语音模型。',
  'main.error.couldNotDownloadSpeechModel': '无法下载语音模型：{message}',
  'main.error.noSingingFound': '在人声音轨中没有找到歌唱内容。',
  'main.error.couldNotMakeOutVocals': '无法听清人声，不足以核对歌词。精确对齐仍可能成功。',
  'main.error.couldNotTimeWords': '无法根据人声为歌词计时。',
  'main.error.alignmentFailed': '对齐失败：{message}',
  'main.error.noWordsDetected': '在人声中没有检测到任何词语。',
  'main.error.couldNotTimeTranscribedWords': '无法根据人声为识别出的词语计时。',
  'main.error.transcriptionFailed': '识别失败：{message}',
  'main.error.preciseAlignmentFailed': '精确对齐失败：{message}',

  // ── qwen forced aligner (qwen-align.ts) ──
  'main.error.wordAlignerMissing': '此版本中缺少分词对齐器。',
  'main.error.wordAlignerModelNotInstalled': '分词对齐器模型未安装。',

  // ── qwen speech server (qwen-asr.ts) ──
  'main.error.llamaServerMissing': '此版本中缺少识别引擎（llama-server）。',
  'main.error.qwenModelNotInstalled': 'Qwen 语音模型未安装。',
  'main.error.llamaServerStopped': 'llama-server 在准备就绪前停止了',
  // {why} is a short excerpt of the engine's own last log lines, not translated
  'main.error.llamaServerStoppedWithReason': 'llama-server 在准备就绪前停止了：{why}',
  'main.error.llamaServerNotReadyInTime': 'llama-server 在规定时间内未能准备就绪。',
  // {status} is an HTTP status code
  'main.error.llamaServerHttpError': 'llama-server 返回了 HTTP {status}',

  // ── Google Drive sign-in (gdriveSignIn only — gdriveSync's own errors stay
  //    English on purpose: sync-scheduler.ts's classifySyncError pattern-matches
  //    their English text to decide retry behaviour) ──
  'main.error.driveNotConfigured': '此版本未配置 Google Drive',
  // the page shown in the system browser right after Google's OAuth redirect
  'main.drive.signedInPageTitle': 'SingZ 已登录',
  'main.drive.signedInPageBody': '你可以关闭此标签页，回到应用中。',
  'main.error.googleSignInCancelled': 'Google 登录已取消',
  'main.error.googleSignInTimedOut': 'Google 登录超时',
  'main.error.googleNoTokens': 'Google 未发放令牌',

  // ── backing-vocal separation ──
  'main.error.backingVocalSeparationAlreadyRunning': '已经有一个和声分离任务在运行。',
  // note: no trailing period, unlike main.error.cancelled — kept distinct on purpose
  'main.error.cancelledNoDot': '已取消',
  'main.error.downloadSplitterToSeparateVocals': '下载分离引擎即可分离人声。',
  'main.error.vocalFileChangedDuringSeparation': '人声文件在分离过程中发生了变化。请重试。',
  'main.error.vocalFileNotRegistered': '该人声文件未注册。',

  // ── native audio (capture.ts): device inventory, monitoring, mic ──
  'main.error.audioProviderNotAvailable': '所请求的原生音频服务在此平台上不可用。',
  'main.error.nativeAudioHostUnavailable': '原生音频主机不可用',
  'main.error.nativeAudioHostInvalidInventory': '原生音频主机返回的设备清单无效。',
  'main.error.nativeAudioHostInventoryFailed': '原生音频主机清单获取失败：{message}',
  'main.error.nativeCaptureUnavailable': '原生录音不可用',
  'main.error.monitorGenerationExhausted': '原生返听的世代编号已用尽。',
  'main.error.monitorFailedToStart': '原生耳机返听启动失败：{message}',
  'main.error.monitorInvalidResponse': '原生耳机返听返回了无效响应。',
  'main.error.monitorGenerationInactive': '该耳机返听世代已不再有效。',
  'main.error.monitorGainInvalidResponse': '原生耳机增益返回了无效响应。',
  'main.error.monitorGainFailed': '原生耳机增益调整失败：{message}',
  'main.error.monitorInvalidStopResponse': '原生耳机返听返回了无效的停止响应。',
  'main.error.monitorFailedToStop': '原生耳机返听停止失败：{message}',
  'main.error.nativePlaybackUnavailable': '原生播放不可用',
  'main.error.invalidMicOwnershipGeneration': '麦克风归属世代编号无效。',
  'main.error.nativeMicSupportUnavailable': '原生麦克风支持不可用：{message}',
  'main.error.monitorFailedGeneric': '原生耳机返听失败。',
  'main.error.monitorEndActiveFirst': '请先结束当前的耳机返听，再开始新的一次。',

  // ── source registration (drag/drop, file picker) ──
  // {ext} is a file extension (e.g. ".txt") or the fallback "that file"
  'main.error.cantUseFileDrop': '无法使用 {ext}——请拖入 MP3、WAV、FLAC 或 M4A 文件。',
  'main.error.cantUseFilePick': '无法使用 {ext}——请选择 MP3、WAV、FLAC 或 M4A 文件。',
  'main.error.thatFile': '该文件',
  'main.error.notAFile': '这不是一个文件。',
  'main.error.couldNotReadFile': '无法读取该文件。',

  // ── training microphone (audio-input.ts) ──
  'main.error.audioInputNoResult': 'audio-input 清单没有返回结果',
  'main.error.audioInputUnsupportedFormat': 'audio-input 清单的格式不受支持',
  // {index} is a 1-based device number
  'main.error.audioInputDeviceMalformed': 'audio-input 清单中的设备 {index} 格式有误',
  'main.error.audioInputCoreMissing': '此版本中没有原生 audio-input 核心。',
  'main.error.anotherTrainingMicStarting': '另一个训练麦克风正在启动。',
  'main.error.anotherTrainingMicActive': '另一个训练麦克风正在使用中。',
  'main.error.micAccessBlocked': '麦克风访问被阻止。请在系统设置 › 隐私与安全性 › 麦克风 中允许 SingZ 使用，然后重试。',
  'main.error.noMicrophoneAvailable': '没有可用的麦克风。',
  'main.error.micTookTooLongToStart': '麦克风启动耗时过长。',
  'main.error.couldNotStartMicrophone': '无法启动麦克风：{message}',
  'main.error.micDidNotConfirmStop': '原生麦克风未确认已停止。',
  'main.error.invalidMicFallback': '麦克风回退方案无效。',

  // ── Google Drive sync progress: taking a phone's song into the library (Phase 6) ──
  'main.sync.addingFromPhone': '正在从手机添加“{dir}”…',

  // ── Drive sync progress (shown under the library while it runs) ──
  'main.sync.syncing': '正在同步“{dir}”…',
  'main.sync.uploading': '正在上传 {file}…',
  'main.sync.removing': '正在从 Drive 删除 {file}…',
  'main.sync.removingGone': '正在从 Drive 删除 {name}（已在此处重命名或删除）…',
  'main.sync.updatingCatalog': '正在更新手机目录…',
  'main.sync.upToDate': 'Drive 已是最新'
}
