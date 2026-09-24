/* 简体中文 — the `player` strings, typed against English. */
import type { player as en } from '../en/player'
import type { Translation } from '../../../../src/shared/i18n/types'

export const player: Translation<typeof en> = {
  // ── "not available in native playback yet" alert ──
  'phone.player.unsupported.title': '原生播放暂不支持',
  'phone.player.unsupported.message': '在原生 DSP 控制接入之前，{operation}将保持禁用。',
  'phone.player.playbackStopped.title': '播放已停止',
  'phone.player.metronomeSaveFailed.title': '节拍器设置未能保存',
  // names of a PlaybackOperation, for the message above
  'phone.player.operation.pause': '暂停',
  'phone.player.operation.seek': '跳转',
  'phone.player.operation.loopRegion': '循环区间',
  'phone.player.operation.metronome': '节拍器',
  'phone.player.operation.mixer': '混音器',
  'phone.player.operation.pitchTempo': '音高与速度',
  'phone.player.operation.training': '训练',
  'phone.player.operation.previewClick': '试听节拍声',

  // ── stem lane names (STEM_META ids: original/vocals/drums/bass/guitar/piano/other) ──
  'phone.player.stem.original': '完整混音',
  'phone.player.stem.vocals': '人声',
  'phone.player.stem.drums': '鼓',
  'phone.player.stem.bass': '贝斯',
  'phone.player.stem.guitar': '吉他',
  'phone.player.stem.piano': '钢琴',
  'phone.player.stem.other': '乐器',

  // ── count-in display (playback/count-in-display.ts) ──
  'phone.player.countIn.beatLabel': '预备拍，第 {done} 拍，共 {total} 拍',
  'phone.player.countIn.secondsLabel': '预备拍，剩余 {seconds} 秒',
  // the compact on-screen readout, e.g. "3s"
  'phone.player.countIn.secondsText': '{seconds} 秒',

  // ── song format line (ui/song-sheet-copy.ts) ──
  'phone.player.songSheet.formatFlac': 'FLAC 分轨',
  'phone.player.songSheet.formatWav': 'WAV 分轨',
  'phone.player.songSheet.formatFlacWav': 'FLAC + WAV 分轨',
  'phone.player.songSheet.formatNone': '无分轨',

  // ── shared UI kit accessibility strings (ui/bits.tsx) ──
  'phone.player.bits.decrease': '减少{label}',
  'phone.player.bits.increase': '增加{label}',
  // e.g. "Hear, 3" — a stepper's screen-reader label followed by its value
  'phone.player.bits.labelValue': '{label}，{value}',
  // fallback screen-reader value for an adjustable bar with no custom formatter
  'phone.player.bits.percentValue': '{percent}%',
  // VoiceOver rotor action names for the adjustable Bar control
  'phone.player.bits.increaseAction': '增加',
  'phone.player.bits.decreaseAction': '减少',

  // ── lyric column (ui/SkiaLyrics.tsx + the tap-target overlay in PlayerScreen) ──
  // drawn by Skia with the lyrics' face, which has no CJK glyphs on Android —
  // a Chinese character here would render as a box
  'phone.player.lyrics.waitSeconds': '{sec} s',
  'phone.player.lyrics.jumpHint': '跳到这一行',
  'phone.player.lyrics.empty': '此项目暂无歌词。',
  // {text} is the lyric line itself; said for a line the singer performs solo
  'phone.player.lyrics.lineTurn': '{text}。轮到你了。',

  // ── header (song title bar) ──
  'phone.player.header.back': '返回曲库',
  'phone.player.header.about': '关于这首歌',
  'phone.player.header.notSplit': '尚未分离',
  'phone.player.header.stemsCount': '{n} 条分轨',
  'phone.player.header.added': '已添加 {n} 条',
  'phone.player.header.bpm': '{bpm} bpm',
  // musical key quality, abbreviated (header subtitle and the transpose suffix)
  'phone.player.header.keyMinor': '小',
  'phone.player.header.keyMajor': '大',
  'phone.player.header.youSing': '你来唱 🎤',

  // ── loop (A-B repeat) button ──
  'phone.player.loop.markStart': '循环一段。点这里标记起点。',
  // {time} e.g. "1:23"
  'phone.player.loop.startMarked': '循环起点已标记在 {time}。点这里标记终点。',
  'phone.player.loop.looping': '正在循环 {a} 到 {b}。点这里清除循环。',
  'phone.player.loop.buttonA': 'A',
  'phone.player.loop.buttonAB': 'A–B',

  // ── transport (footer controls) ──
  'phone.player.transport.position': '位置',
  'phone.player.transport.mixer': '混音器',
  'phone.player.transport.backToStart': '回到开头',
  'phone.player.transport.back5': '后退 5 秒',
  'phone.player.transport.forward5': '快进 5 秒',
  'phone.player.transport.practice': '练习',
  'phone.player.transport.play': '播放',
  'phone.player.transport.skipBackLabel': '−5秒',
  'phone.player.transport.skipForwardLabel': '+5秒',
  'phone.player.transport.pause': '暂停',

  // ── mixer sheet ──
  'phone.player.mixer.title': '混音器',
  'phone.player.mixer.fullMix': '完整混音',
  'phone.player.mixer.noVocals': '无人声',
  'phone.player.mixer.vocalsOnly': '仅人声',
  // header over the singer's own added tracks, below the song's own stems
  'phone.player.mixer.added': '已添加',
  'phone.player.mixer.yourTurn': '轮到你了',
  'phone.player.mixer.mute': '静音 {label}',
  'phone.player.mixer.solo': '独奏 {label}',
  'phone.player.mixer.volumeLabel': '{label}音量',

  // ── song sheet: Beat row ──
  'phone.player.songSheet.beat': '节拍',
  // e.g. "120 bpm · 4/4 · 32 bars"
  'phone.player.songSheet.bpmMeterBars': '{bpm} bpm · {meter} · {bars} 小节',
  'phone.player.songSheet.noBeatVerdict': '这段鼓声中没有节拍',
  'phone.player.songSheet.readingSong': '正在读取歌曲…',
  'phone.player.songSheet.notDetectedYet': '尚未检测',
  'phone.player.songSheet.handMade': '在电脑上手动制作',
  'phone.player.songSheet.detectorVersion': '检测器 v{ver}',
  'phone.player.songSheet.handSetBars_one': ' · {n} 条手动设置的小节线',
  'phone.player.songSheet.handSetBars_other': ' · {n} 条手动设置的小节线',
  'phone.player.songSheet.beatHintProgress':
    '正在聆听——节拍声和预备拍会在找到节拍的那一刻立即跟上。',
  'phone.player.songSheet.beatHintHandTuned':
    '已在电脑上手动调整——这里的任何操作都不会重新检测覆盖它。',
  'phone.player.songSheet.beatHintUserBars':
    '你自己设置的小节线已经在这个网格上，并会保留在上面。',
  'phone.player.songSheet.beatHintFollow':
    '节拍声、预备拍和小节线都会跟随它。',
  'phone.player.songSheet.beatHintVerdict':
    '检测器已经聆听，但没有找到可以打点的稳定节拍——这是一首自由节奏或无鼓的歌。这个结果会被记住，所以再次打开这首歌不会白白重新读取分轨。',
  'phone.player.songSheet.beatHintDetectAgain': ' 重新检测可以再问一次。',
  'phone.player.songSheet.beatHintBusy':
    '正在读取中——网格会在读取调之后写入，所以这一行会在节拍本身被找到后稍晚一点填上。',
  'phone.player.songSheet.beatHintNothingRead': '还没有读取过分轨。',
  'phone.player.songSheet.beatHintNotSplit':
    '尚未分离——节拍是从鼓声中读取的，所以要等分离完成。',
  'phone.player.songSheet.beatHintFromComputer':
    '从电脑传来的歌曲自带节拍信息。',
  'phone.player.songSheet.timeEstimateWithMl':
    '节拍、调和旋律加起来，每分钟歌曲大约需要十秒',
  'phone.player.songSheet.timeEstimateMlSuffix':
    '——用更精准节拍模型聆听时大约需要十五秒。',
  'phone.player.songSheet.timeEstimateNoMlSuffix': '。',
  'phone.player.songSheet.timeEstimateFlacJs':
    '这首歌的分轨是 FLAC 格式，此版本用 JavaScript 读取——需要几分钟，而不是几秒。',
  'phone.player.songSheet.detecting': '正在检测…',
  'phone.player.songSheet.detectAgain': '重新检测',

  // ── song sheet: Better beats row ──
  'phone.player.songSheet.betterBeats': '更精准节拍',
  'phone.player.songSheet.downloading': '正在下载——{mb}/{total} MB',
  'phone.player.songSheet.sizeMb': '{n} MB',
  'phone.player.songSheet.sizeKb': '{n} kB',
  'phone.player.songSheet.onThisPhone': '已在此手机上',
  'phone.player.songSheet.notDownloaded': '尚未下载——{mb} MB',
  'phone.player.songSheet.checking': '正在检查…',
  'phone.player.songSheet.betterBeatsHint':
    '一个神经网络模型，能听出无鼓前奏和自由节奏中普通鼓声检测器会漏掉的节拍。只需下载一次，之后每首歌都能使用。',
  'phone.player.songSheet.betterBeatsHintDetectAgain': ' 重新检测即可在这首歌上使用它。',
  'phone.player.songSheet.cancel': '取消',
  'phone.player.songSheet.downloadMb': '下载 {mb} MB',

  // ── song sheet: Key row ──
  'phone.player.songSheet.key': '调',
  'phone.player.songSheet.noKeyVerdict': '这些分轨中没有调',
  'phone.player.songSheet.keyVerdictHint':
    '调是从和声——吉他、钢琴和贝斯音轨——中读取的，但这里没有声音，因此无从读取。这个结果会被记住，而不会每次打开都重新读取。',
  // full words, unlike the header's abbreviated min/maj
  'phone.player.songSheet.keyMinor': '小调',
  'phone.player.songSheet.keyMajor': '大调',

  // ── song sheet: Melody row ──
  'phone.player.songSheet.melody': '旋律',
  'phone.player.songSheet.trackedFromVocals': '从人声中跟踪',
  'phone.player.songSheet.notTrackedYet': '尚未跟踪',
  'phone.player.songSheet.melodyDetector': '检测器 v{ver} · 每 {ms} 毫秒一帧',
  'phone.player.songSheet.melodyHint':
    '演唱的旋律线，随歌曲一起保存。手机不会绘制它——电脑上的音高条会。',

  // ── song sheet: Lyrics row ──
  'phone.player.songSheet.lyrics': '歌词',
  'phone.player.songSheet.linesCount': '{n} 行',
  'phone.player.songSheet.wordTimings': ' · 逐字时间',
  'phone.player.songSheet.lineTimingsOnly': ' · 仅逐行时间',
  'phone.player.songSheet.none': '无',

  // ── song sheet: Stems + Project rows ──
  'phone.player.songSheet.stems': '分轨',
  'phone.player.songSheet.project': '项目',
  // e.g. "Format v2 · FLAC stems"
  'phone.player.songSheet.formatVersion': '格式 v{ver} · {format}',
  'phone.player.songSheet.onDisk': '占用 {size}',
  'phone.player.songSheet.playsAtKhz': '以 {khz} kHz 播放',
  'phone.player.songSheet.savedOn': '保存于 {date}',
  'phone.player.songSheet.fromGoogleDrive': '来自 Google Drive',
  'phone.player.songSheet.fromFolder': '来自文件夹',
  'phone.player.songSheet.onThisPhoneSource': '在此手机上',
  'phone.player.songSheet.bundledSample': '内置示例',
  'phone.player.songSheet.gettingReady': '正在准备…',

  // ── practice sheet: Key & speed ──
  'phone.player.practice.title': '练习',
  'phone.player.practice.keySpeed': '调与速度',
  'phone.player.practice.reset': '重置',
  'phone.player.practice.pitch': '音高',
  'phone.player.practice.semitones': '{st} 半音',
  // {key} is a musical key name (untranslated), {quality} is minor/major short form
  'phone.player.practice.pitchSuffix': '→ {key} {quality}',
  'phone.player.practice.tempo': '速度',
  'phone.player.practice.tempoSuffix': '→ {bpm} bpm',

  // ── practice sheet: Metronome ──
  'phone.player.practice.metronome': '节拍器',
  'phone.player.practice.bpmFromSong': '{bpm} bpm，来自歌曲',
  'phone.player.practice.noCountIn': '无预备拍',
  'phone.player.practice.oneBar': '1 小节',
  'phone.player.practice.twoBars': '2 小节',
  'phone.player.practice.threeSec': '3 秒',
  'phone.player.practice.sixSec': '6 秒',
  'phone.player.practice.click': '节拍声',
  'phone.player.practice.accent': '重音',
  'phone.player.practice.loudness': '音量',
  'phone.player.practice.readOnlyHint':
    '节拍器设置为只读，因为此项目是在未经验证的曲库位置下打开的。请从曲库重新打开它以保存更改。',
  // {step} is a progress line such as "Finding the beat…"
  'phone.player.practice.beatHintStep':
    '{step}——节拍声和预备拍会在找到节拍的那一刻立即跟上。',
  'phone.player.practice.beatHintBusy':
    '歌曲正在被读取——节拍声和预备拍会在节拍落定的那一刻立即跟上。',
  'phone.player.practice.beatHintPhoneNoTrack':
    '没有节拍轨——播放开始前预备拍会每秒响一次。如果这首歌有稳定的节拍，在这里打开它、分离完成后就会从鼓声中读取一个。',
  'phone.player.practice.beatHintDesktopNoTrack':
    '没有节拍轨——播放开始前预备拍会每秒响一次。如果这首歌有稳定的节拍，在电脑上打开它会从鼓声中读取一个。',

  // ── practice sheet: Vocal training ──
  'phone.player.practice.vocalTraining': '声乐训练',
  'phone.player.practice.training': '训练',
  'phone.player.practice.byTime': '按时间',
  'phone.player.practice.byLyricLines': '按歌词行',
  'phone.player.practice.interval': '间隔',
  'phone.player.practice.hear': '聆听',
  'phone.player.practice.sing': '演唱',
  'phone.player.practice.decreaseHear': '减少聆听',
  'phone.player.practice.increaseHear': '增加聆听',
  'phone.player.practice.decreaseSing': '减少演唱',
  'phone.player.practice.increaseSing': '增加演唱',
  'phone.player.practice.hearValue': '聆听，{n}',
  'phone.player.practice.singValue': '演唱，{n}',
  'phone.player.practice.scheduleTime':
    '与原唱一起唱 {sec} 秒，然后轮到你唱 {sec} 秒，如此循环',
  'phone.player.practice.scheduleLines_one':
    '与原唱一起听 {n} 行，然后自己唱 {sing}，如此循环——歌词中以 🎤 标记',
  'phone.player.practice.scheduleLines_other':
    '与原唱一起听 {n} 行，然后自己唱 {sing}，如此循环——歌词中以 🎤 标记',
  'phone.player.practice.withTheSinger': '与原唱一起',
  'phone.player.practice.yourTurn': '轮到你了',
  'phone.player.practice.yourTurnMic': '轮到你了 🎤',
  'phone.player.practice.dropOutHint': '你演唱时静音的音轨：',

  // ── practice sheet: Lyric timing ──
  'phone.player.practice.lyricTiming': '歌词时间',
  // {route} e.g. " · Bluetooth, auto 120 ms" — appended to the section label above
  'phone.player.practice.lyricTimingRoute': ' · {label}，自动 {ms} 毫秒',
  'phone.player.practice.trim': '微调',
  'phone.player.practice.highlightsShifted':
    '高亮显示会偏移 {ms} 毫秒，以配合你听到的声音。如果文字在你听到之前就已经亮起（车载音响、蓝牙），可以增加这个值。',

  // ── analysis progress (analysis/pipeline.ts → the Song/Practice sheets) ──
  'phone.player.analysis.listeningForBeat': '正在聆听节拍…',
  'phone.player.analysis.findingBeat': '正在寻找节拍…',
  'phone.player.analysis.readingStems': '正在读取分轨…',
  'phone.player.analysis.readingKey': '正在读取调…',
  'phone.player.analysis.trackingMelody': '正在跟踪旋律…',
  'phone.player.analysis.trackingMelodyPercent': '正在跟踪旋律 · {percent}%'
}
