/* 简体中文 — the `app` strings, typed against English. */
import type { app as en } from '../en/app'
import type { Translation } from '../types'

export const app: Translation<typeof en> = {
  // ── lazy dialog route copy (LibraryImport / LogPanel / ProjectPicker / SetupModal) ──
  // read through getters on the route object, so they translate at every
  // render rather than freezing at module load — see App.tsx's route setup.
  'app.dialog.libraryImport.name': '添加到你的曲库',
  'app.dialog.libraryImport.opening': '正在打开曲库选项…',
  'app.dialog.libraryImport.failureTitle': '曲库选项未能打开',
  'app.dialog.libraryImport.failureMessage': '曲库选项未能加载。项目保持在原处。',
  'app.dialog.logPanel.name': '日志',
  'app.dialog.logPanel.opening': '正在打开日志…',
  'app.dialog.logPanel.failureTitle': '日志未能打开',
  'app.dialog.logPanel.failureMessage': '日志查看器未能加载。SingZ 仍在正常运行。',
  'app.dialog.projectPicker.name': '项目',
  'app.dialog.projectPicker.opening': '正在打开你的项目…',
  'app.dialog.projectPicker.failureTitle': '项目未能打开',
  'app.dialog.projectPicker.failureMessage': '你的曲库未能加载。没有任何项目被更改。',
  'app.dialog.setupModal.name': '分轨分离设置',
  'app.dialog.setupModal.opening': '正在打开分轨分离设置…',
  'app.dialog.setupModal.failureTitle': '设置未能打开',
  'app.dialog.setupModal.failureMessage': '分轨分离设置未能加载。播放器仍可正常使用。',

  // ── titlebar / section nav ──
  'app.titlebar.sections': 'SingZ 分区',
  'app.titlebar.songs': '歌曲',
  'app.titlebar.training': '声乐训练',
  'app.titlebar.catalogBack': '返回你的歌曲（Esc）',
  'app.titlebar.catalogBrowse': '浏览你的曲库——这首歌会保持加载状态',
  'app.titlebar.catalog': '目录',
  'app.titlebar.renameProject': '重命名歌曲和项目文件夹',
  'app.titlebar.renameSong': '重命名歌曲',
  'app.titlebar.logTooltip': '应用后台正在做什么——报告问题时可以复制或保存它',
  'app.titlebar.log': '日志',
  // the desktop Settings gear button — title AND aria-label both use this
  'app.titlebar.settings': '设置',

  // ── update chip ──
  'app.update.restartTitle': '更新已下载——重启即可安装',
  'app.update.restart': '重启以更新',
  'app.update.availableTitle': '有新版本发布——点击打开下载页面',
  // {version} is the app version number, e.g. "0.23.3"
  'app.update.get': '获取 v{version}',
  'app.update.downloadingTitle': '正在后台下载更新',
  // {percent} is a 0-100 whole number
  'app.update.downloading': '更新 {percent}%',

  // ── save / library ──
  'app.save.tooltipProject': '将分轨、歌词和设置保存到此项目文件夹中',
  'app.save.tooltipLibrary': '将歌曲、分轨、歌词和设置保存到你的曲库中',
  'app.save.saved': '已保存 ✓',
  'app.save.saving': '正在保存…',
  'app.save.save': '保存项目',
  'app.save.unsavedTitle': '未保存的更改',
  'app.library.addTooltip': '这个项目位于你的曲库之外——将它复制或移动进来',
  'app.library.add': '添加到曲库…',
  'app.library.open': '打开…',

  // ── engine/splitter status chip ──
  'app.engine.checking': '正在检查分离引擎…',
  // {command} is the splitter binary's own name/version string
  'app.engine.manageTitle': '{command}——点击以管理 AI 模型',
  'app.engine.ready': '分离引擎已就绪',
  'app.engine.setup': '分离引擎设置',

  // ── vocal training empty states ──
  'app.training.loading': '正在加载你的练习档案…',
  'app.training.unavailable': '练习档案不可用',
  'app.training.unavailableBody': '你保存的训练数据未被更改。等存储可用后重试。',
  'app.retry': '重试',
  // {error} is the raw error text from the failed save
  'app.training.saveError': '训练档案或历史记录未保存：{error}',

  // ── drag & drop ──
  'app.drop.release': '松开以加载',

  // ── analysis progress labels (HUD) ──
  'app.analysis.readingMelody': '正在读取旋律',
  'app.analysis.findingBeat': '正在寻找节拍',

  // ── playback output/route toasts ──
  'app.output.confirmDenied': 'SingZ 未获得确认播放路径的权限——请选择一个输出设备或重试',
  'app.output.missingDefault': '已保存的播放设备未连接——正在使用系统默认设备',
  'app.output.switchDenied': 'SingZ 未获得切换播放设备的权限——仍在使用之前的设备',
  'app.output.switchFailed': '无法切换到该设备——仍在使用之前的设备',

  // {message} is the monitor's own status text
  'app.monitor.stopped': '耳机返听已停止：{message}',

  // native engine rejected a live control change and the UI rolled back — {error} is the raw error text
  'app.native.beatNotApplied': '原生节拍网格更新未生效：{error}',
  'app.native.metronomeNotApplied': '原生节拍器更新未生效：{error}',
  'app.native.transposeNotApplied': '原生移调更新未生效：{error}',
  'app.native.loopNotApplied': '原生循环更新未生效：{error}',
  'app.native.tempoNotApplied': '原生速度更新未生效：{error}',
  'app.native.trainingNotApplied': '原生训练更新未生效：{error}',

  // ── first-run / model wizard ──
  'app.wizard.qwenNotice':
    '歌词识别和“检查并对齐”现在使用 Qwen3-ASR——一个专门针对演唱训练的语音模型，它听清唱出的歌词明显比旧模型更准。方便的时候在下方获取它；一旦它安装完成，旧模型就会被移除。',

  // ── song open progress ──
  'app.load.opening': '正在打开…',
  // {label} is the singer's own name for the added track
  'app.load.laneMissing': '“{label}”未能读取——该音轨已从混音中缺失。',
  'app.load.readingStems': '正在读取分轨…',
  'app.load.drawingWaveforms': '正在绘制波形…',
  // {list} is the silent stem names joined with "and", e.g. "guitar and piano"
  'app.load.silentStems_one': '已分离成六条分轨——这首歌中 {list} 是静音的，因此其音轨已被隐藏。',
  'app.load.silentStems_other': '已分离成六条分轨——这首歌中 {list} 是静音的，因此其音轨已被隐藏。',
  'app.load.startingPlayback': '正在开始播放…',
  // {message} is the graph loader's own error text
  'app.load.graphError': '无法加载该项目的 DSP 图。{message}',
  'app.load.decodeFailed': '无法解码该音频文件。',

  // ── file/track errors ──
  'app.file.resolveFailed': '无法在磁盘上定位该文件。',
  // {name} is the file's own name
  'app.tracks.decodeFailed': '无法解码 {name}——请尝试 MP3、WAV、FLAC 或 M4A 格式。',
  // {names} is the added tracks' labels joined with ", "; {end} is a formatted time like "3:42"
  'app.tracks.addedExtends':
    '已添加 {names}——它从 0:00 开始，时长超出了这首歌，因此时间轴现在延长到 {end}。保存项目以保留它。',
  'app.tracks.addedAligned': '已添加 {names}——它从 0:00 开始，与分轨保持同步。保存项目以保留它。',

  // ── splitting ──
  'app.split.rereadFailed': '无法重新读取这首歌以进行分离。请再次打开它。',
  'app.split.loadStemsFailed': '分离已完成，但加载分轨文件失败。',
  // the auto-created lane name for a separated backing-vocal harmony
  'app.split.backingVocalsLabel': '和声',
  'app.split.backingReady':
    '主唱和和声已分离完成。旋律现在跟随主唱。保存项目以保留这两条音轨；重叠的和声部分可能仍会残留。',
  'app.beat.notFound': '未找到稳定的节拍——请改为敲击测速。',

  // ── project save/import/rename ──
  // {dir} is the project's folder path
  'app.project.saved': '已保存到 {dir}',
  // {names} is the lost custom-track labels joined with ", "
  'app.project.savedMissingFile':
    '已保存到 {dir}——但 {names} 未能复制进来（该文件已不在你添加时的位置）。',
  'app.project.savedDriveSignedOut':
    '已保存到 {dir}——这台电脑上的 Google Drive 已退出登录，因此在你重新登录之前，你的手机不会看到它（在“打开…”界面登录）。',
  'app.project.saveFailed': '无法保存项目：{error}',
  'app.project.moved': '已移入你的曲库——项目现在位于 {dir}',
  'app.project.copied': '已复制到你的曲库——{dir}。原文件夹保持不变。',
  'app.project.renamed': '已重命名——项目文件夹现在是 {dir}'
}
