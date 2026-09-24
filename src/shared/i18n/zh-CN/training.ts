/* 简体中文 — the `training` strings, typed against English. */
import type { training as en } from '../en/training'
import type { Translation } from '../types'

export const training: Translation<typeof en> = {
  // ── exercise picker (home) ──
  'training.exercise.note.label': '听音配唱',
  'training.exercise.note.description': '先听一个音，再让你的声音落在它上面。',
  'training.exercise.scaleDegree.label': '调内音级',
  'training.exercise.scaleDegree.description': '听音符如何融入一个调。',
  'training.exercise.interval.label': '音程',
  'training.exercise.interval.description': '唱出两个音之间的距离，向上或向下。',
  'training.exercise.chordTone.label': '和弦音',
  'training.exercise.chordTone.description': '找到和弦的根音、三音或五音。',
  'training.exercise.arpeggio.label': '琶音',
  'training.exercise.arpeggio.description': '逐个音描出一个和弦。',
  'training.exercise.mixed.label': '综合练习',
  'training.exercise.mixed.description': '在一次简短练习中轮换所有练习类型。',

  // ── home screen ──
  'training.home.eyebrow': '专注音准练习',
  'training.home.heading': '你想更清楚地听到什么？',
  'training.home.subheading': '选择一项技能。SingZ 会让练习保持在你舒适的音域内。',
  'training.home.exercisesAriaLabel': '训练练习',
  'training.home.progressEntry.label': '进度',
  'training.home.progressEntry.empty': '你的练习记录会显示在这里。',
  // "{n} completed session(s) · 84% landed" on the home screen's Progress entry
  'training.home.progressEntry.summary_one': '已完成 {n} 次练习 · 命中 {percent}',
  'training.home.progressEntry.summary_other': '已完成 {n} 次练习 · 命中 {percent}',
  'training.home.micNote': '麦克风音频会实时分析，且从不保存。',

  // ── "loaded song" preparation card on the home screen ──
  'training.home.songPrep.eyebrow': '已加载的歌曲',
  // {name} is the song title; keep the curly quotes
  'training.home.songPrep.title': '为“{name}”做准备',
  // appended after the key name, e.g. "A minor · transposed +2"
  'training.home.songPrep.transposedSuffix': ' · 已移调 {sign}{amount}',
  'training.home.songPrep.confirmKeyFirst': '请先确认歌曲的调',
  'training.home.songPrep.tagline': '练习它的音符、音程和和弦。',
  'training.home.songPrep.ariaPrepareFor': '为 {name} 做准备',
  'training.home.songPrep.choice.notes': '音符',
  'training.home.songPrep.choice.intervals': '音程',
  'training.home.songPrep.choice.chords': '和弦',
  'training.home.songPrep.choice.mixed': '综合热身',
  'training.home.songPrep.chooseFocusHelp':
    '选择任意一个练习方向以打开设置，然后确认或手动更改调。',

  // ── progress screen ──
  'training.progress.eyebrow': '练习记录',
  'training.progress.heading': '进度',
  'training.progress.subheading': '仅统计已完成的练习。你的麦克风音频不会被保存。',
  'training.progress.empty.heading': '还没有已完成的练习',
  'training.progress.empty.body': '完成一次练习即可生成你的第一份记录。',
  'training.progress.empty.cta': '选择一项练习',
  'training.progress.metric.completedSessions': '已完成的练习',
  'training.progress.metric.onTargetOrClose': '准确或接近',
  'training.progress.metric.pitchTendency': '音高倾向',
  'training.progress.ariaStatistics': '训练进度统计',
  'training.progress.focus.heading': '值得关注的下一个方向',
  'training.progress.focus.exerciseTypes': '练习类型',
  'training.progress.focus.scaleDegrees': '音级',
  // "Degree 3" — a single scale degree named in the weak-spots list
  'training.progress.focus.degree': '第 {n} 级',
  'training.progress.focus.chordRoles': '和弦音角色',
  'training.progress.weakness.needMore': '还需要更多练习数据',
  'training.progress.recent.heading': '最近的练习',
  'training.progress.recent.landed': '命中 {attempts} 次中的 {landed} 次',

  // ── metrics shared by the progress and summary screens ──
  'training.metric.voiceDetected': '检测到声音',
  'training.metric.pitchHeldSteady': '音高保持稳定',
  'training.metric.close': '接近',
  'training.metric.averageError': '平均误差 · 准确或接近',

  // pitch tendency, e.g. "Usually sharp"
  'training.tendency.notEnough': '音高数据还不够',
  'training.tendency.centered': '整体音准良好',
  // {word} is training.word.sharp/flat
  'training.tendency.usually': '通常偏{word}',

  // ── session setup screen ──
  'training.setup.eyebrow': '练习设置',
  'training.setup.legend.musicalContext': '音乐背景',
  'training.setup.label.key': '调',
  'training.setup.ariaLabel.keyMode': '调式',
  'training.setup.option.major': '大调',
  'training.setup.option.minor': '小调',
  'training.setup.label.task': '任务',
  'training.setup.ariaLabel.taskMode': '任务模式',
  'training.setup.task.imitate': '模仿',
  'training.setup.task.find': '自己找音',
  'training.setup.task.identify': '听音选择',
  'training.setup.taskHelp.imitate': '先听完整答案，再唱回来。',
  'training.setup.taskHelp.find': '先听主音或起始音，再自己找出答案。',
  'training.setup.taskHelp.identify': '听问题并选择答案。麦克风保持关闭。',
  'training.setup.error.noMic': '没有可用的麦克风。听音选择仍可作为纯听力练习使用。',
  'training.setup.label.direction': '方向',
  'training.setup.ariaLabel.direction': '方向',
  'training.setup.legend.range': '你的演唱音域',
  'training.setup.rangeHelp': '使用今天轻松够到的音域，而不是你的极限音域。',
  'training.setup.label.lowestNote': '最低音',
  'training.setup.label.highestNote': '最高音',
  'training.setup.legend.chordDegrees': '和弦音级',
  // checkbox label, e.g. "Scale degree 3"
  'training.setup.chordDegreeLabel': '第 {n} 音级',
  'training.setup.legend.practiceSettings': '常用练习设置',
  'training.setup.label.notePlaybackVolume': '音符播放音量',
  'training.setup.testNote.playing': '正在播放 C4…',
  'training.setup.testNote.idle': '▶ 试听 C4',
  'training.setup.ariaLabel.lowerVolume': '降低参考音量',
  'training.setup.ariaLabel.raiseVolume': '提高参考音量',
  'training.setup.ariaLabel.notePlaybackVolume': '音符播放音量',
  'training.setup.help.volumeRange': '20–200% · 对每次练习都会保存',
  'training.setup.label.pitchTolerance': '音准容差',
  'training.setup.ariaLabel.pitchTolerance': '音准容差',
  'training.setup.help.pitchTolerance': '在此容差范围内保持 {seconds} 秒即可进入下一题。',
  'training.setup.error.chooseOne': '请为本次练习至少选择一项内容。',
  'training.setup.label.exercises': '练习内容',
  'training.setup.startPractice': '开始练习',
  // number of exercises in a session, e.g. "1 exercise" / "6 exercises"
  'training.exerciseCount_one': '{n} 项练习',
  'training.exerciseCount_other': '{n} 项练习',

  // ── in-session screen ──
  'training.nav.backToTraining': '← 训练',
  'training.session.aria.backToSong': '返回歌曲',
  'training.session.aria.endSession': '结束练习',
  'training.session.aria.exerciseProgress': '第 {current} / {total} 项练习',
  'training.session.aria.targetNotes': '目标音',
  'training.session.ready.paused': '练习已暂停。准备好后继续。',
  'training.session.ready.preparing': '正在准备你的练习…',
  'training.session.readyAction.continue': '继续练习',
  'training.session.error.sessionInactive': '此训练已不再进行中。',
  'training.session.error.noMicUseListen': '没有可用的麦克风。请使用听音选择进行纯听力练习。',
  'training.session.error.micDisconnected': '麦克风已断开连接。请重新连接后再次开始这项练习。',
  'training.session.identify.legend': '你听到了什么？',

  // ── cue / countdown instructions ──
  'training.cue.identify': '准备好。倒计时结束后听音选择。',
  'training.cue.imitate': '准备好。现在听，倒计时结束后开始唱。',
  'training.cue.find': '准备好。记住起始音，倒计时结束后开始唱。',

  // ── transport controls during a response ──
  'training.transport.ariaControls': '练习控制',
  'training.transport.aria.replay': '重新播放目标音',
  'training.transport.label.replay': '重播',
  'training.transport.aria.listeningStatus': '麦克风正在聆听',
  'training.transport.listening': '正在聆听',
  'training.transport.aria.skip': '跳过此音',
  'training.transport.label.skip': '跳过',

  // ── pitch runway (live intonation feedback) ──
  'training.session.pitch.onTarget': '准确',
  'training.session.pitch.sharp': '偏高',
  'training.session.pitch.flat': '偏低',
  'training.session.pitch.listening': '正在聆听',
  // initial/reset state before any pitch has been read
  'training.session.guidance.listeningDefault': '正在聆听你的声音。',
  'training.session.runway.youAreSinging': '你正在唱',
  'training.session.runway.holdInstruction': '唱出这个音，在 ±{cents}¢ 范围内保持 {seconds} 秒。',
  'training.session.runway.inTune': '音准正确——继续保持',
  'training.session.runway.lower': '稍微低一点',
  'training.session.runway.higher': '稍微高一点',
  'training.session.runway.ariaHoldProgress': '保持进度',

  // screen-reader only announcements of the live pitch, e.g. "Listening for
  // A4. No voice detected yet." — {target} is a note name, left untranslated
  'training.session.accessible.listeningFor': '正在聆听 {target}。尚未检测到声音。',
  'training.session.accessible.voiceDetected': '已检测到 {target} 的声音。保持音高稳定。',
  // {guidance} is training.session.pitch.onTarget/sharp/flat
  'training.session.accessible.pitchSteady': '{target}：{guidance}。音高稳定。',

  // ── errors surfaced while training audio/mic is starting ──
  'training.error.mic.blocked': '麦克风访问被阻止。请在系统隐私设置中允许 SingZ 使用麦克风，然后重试。',
  'training.error.mic.notFound': '未找到麦克风。请连接麦克风，或使用听音选择进行纯听力练习。',
  'training.error.mic.busy': '麦克风正被另一个应用占用。请关闭该应用后重试。',
  'training.error.audio.startFailedWithMessage': '训练音频未能启动：{message}',
  'training.error.audio.startFailedGeneric': '训练音频未能启动。请检查你的音频设备后重试。',

  // ── session summary screen ──
  'training.summary.eyebrow': '练习完成',
  'training.summary.ariaMetrics': '练习指标',
  'training.summary.headingTemplate': '命中 {attempts} 次中的 {landed} 次',
  'training.summary.noPitchMetrics': '这次纯听力练习没有使用音高指标。',
  'training.summary.noSteadyNotes': '本次练习没有检测到稳定在音准内的音符。',
  'training.summary.stayedInTune': '你的平均音高保持在音准内。',
  // {word} is training.word.sharp/flat
  'training.summary.tended': '你的平均音高偏{word}。',
  'training.summary.restart': '重新开始',
  'training.summary.backToTraining': '返回训练',
  'training.summary.backToSong': '返回歌曲',

  // ── empty state (no exercise ready) ──
  'training.empty.heading': '还没有准备好的练习',
  'training.empty.body': '请先选择训练方向和一个舒适的音域。',

  // ── per-attempt outcome labels (session summary outcomes list) ──
  'training.outcome.none': '无结果',
  'training.outcome.skipped': '已跳过',
  'training.outcome.correct': '正确',
  'training.outcome.tryAgain': '下次再试',
  'training.outcome.exerciseFallback': '第 {n} 项练习',
  'training.outcome.wrongNote': '音不对',
  'training.outcome.wrongOctave': '八度不对',
  'training.outcome.otherChordTone': '是其他和弦音',
  'training.outcome.nonChordTone': '不是和弦音',
  'training.outcome.unstable': '不稳定',
  'training.outcome.unvoiced': '未检测到声音',
  'training.outcome.outOfRange': '超出音域',

  // ── feedback shown right after an attempt ──
  'training.feedback.skipped.detail': '这项练习未被计分。',
  'training.feedback.identifyCorrect.detail': '记住这个声音，准备下一题。',
  'training.feedback.identifyWrong.heading': '这次不对',
  'training.feedback.identifyWrong.detail': '听清主音，再比较一下这些音符。',
  'training.feedback.onTarget.detail': '音高清晰地落在了中心位置。',
  'training.feedback.close.heading': '非常接近',
  'training.feedback.close.detail': '音基本对了，再往中心靠一点。',
  'training.feedback.wrong.detail': '松开这个音，重新调整，听下一个提示。',

  // Longer per-classification headings used as feedback when a vocal attempt
  // misses ("wrong note", "unstable", …) — distinct from the short
  // training.outcome.* labels used in the summary's outcomes list.
  'training.classification.close': '接近——再来一次就能稳住',
  'training.classification.wrongNote': '唱到了另一个音',
  'training.classification.wrongOctave': '音名对了，八度不对',
  'training.classification.otherChordTone': '唱到了和弦里的另一个音',
  'training.classification.nonChordTone': '这个音落在了和弦之外',
  'training.classification.unstable': '音高还没有稳定下来',
  'training.classification.unvoiced': '未检测到稳定的声音',
  'training.classification.outOfRange': '检测到的音超出了你选择的音域',

  // ── "Listen and choose" prompt kind labels, before the answer is revealed ──
  'training.kindLabel.identifyNote': '听音选择一个音',
  'training.kindLabel.identifyNumber': '听音选择一个数字',
  'training.kindLabel.identifyInterval': '听音选择一个音程',
  'training.kindLabel.identifyChordNote': '听音选择一个和弦音',
  'training.kindLabel.identifyChord': '听音选择一个和弦',

  // ── identify-mode answer reveal / detail text ──
  // {note} is a bare note name (untranslated), e.g. "Answer: A"
  'training.identify.answerNote': '答案：{note}',
  'training.identify.answerScaleDegree': '答案：第 {n} 音级',
  // {interval} is a lowercase interval word (training.word.*), {direction} likewise
  'training.identify.answerInterval': '答案：{direction}{interval}',
  // {role} is training.word.root/third/fifth, {chord} is "{note} {quality}"
  'training.identify.answerChordTone': '答案：{chord} 的{role}',
  'training.identify.answerArpeggio': '答案：第 {degree} 级 — {chord}',
  // detail text under an identify answer choice, e.g. "Scale degree 3"
  'training.identify.scaleDegreeDetail': '第 {n} 音级',
  // arpeggio identify-answer label, e.g. "Degree 3"
  'training.identify.degreeLabel': '第 {n} 级',
  // "{chord} arpeggio" — the word appended after a chord name
  'training.label.arpeggioOf': '{chord} 琶音',

  // ── generic single music-theory words, interpolated lowercase ──
  'training.word.major': '大三和弦',
  'training.word.minor': '小三和弦',
  'training.word.diminished': '减三和弦',
  'training.word.augmented': '增三和弦',
  'training.word.root': '根音',
  'training.word.third': '三音',
  'training.word.fifth': '五音',
  'training.word.ascending': '上行',
  'training.word.descending': '下行',
  'training.word.both': '双向',
  'training.word.arpeggio': '琶音',
  'training.word.sharp': '高',
  'training.word.flat': '低',
  'training.word.unison': '同度',
  'training.word.second': '二度',
  'training.word.fourth': '四度',
  'training.word.sixth': '六度',
  'training.word.seventh': '七度',
  'training.word.octave': '八度',
  // fallback for an interval number outside the named set
  'training.word.intervalGeneric': '{n} 度音程',

  // ── short nouns for weak-spot / kind labels ──
  'training.kind.note': '音符',
  'training.kind.scaleDegree': '音级',
  'training.kind.interval': '音程',
  'training.kind.chordTone': '和弦音',
  'training.kind.arpeggio': '琶音',

  // ── vocal training route (module load / error states) ──
  'training.route.eyebrow': '声乐训练',
  'training.route.opening': '正在打开练习…',
  'training.route.openingStatus': '正在打开声乐训练。',
  'training.route.failure.heading': '练习未能打开',
  'training.route.failure.body': '练习界面未能加载。歌曲播放仍处于暂停状态。',
  'training.route.retry': '重试',
  'training.route.failure.recoveryFailed': '恢复副本也未能加载。请重启 SingZ 后再试。',
  'training.route.returnToSongs': '返回歌曲列表',
  'training.route.runtimeFailure.heading': '练习已停止',
  'training.route.runtimeFailure.stopping': '正在停止练习音频并确认麦克风已释放…',
  'training.route.runtimeFailure.unsafe':
    '练习音频或麦克风的清理未能确认。请重试清理，并在离开练习前保持 SingZ 处于打开状态。',
  'training.route.runtimeFailure.safe':
    '练习音频和麦克风采集已停止，歌曲播放已暂停。',
  'training.route.retryCleanup': '重试清理',
  'training.route.cleanupGate.stoppingHeading': '正在完成音频清理…',
  'training.route.cleanupGate.attentionHeading': '音频清理需要注意',
  'training.route.cleanupGate.stoppingBody':
    '正在确认练习音频和麦克风在离开练习前已停止。',
  'training.route.cleanupGate.attentionBody':
    '麦克风或练习音频未能确认清理完成。请留在声乐训练界面并重试，再打开其他音频路径。',

  // ── session generator (shared/training-session.ts instructions) ──
  'training.session.instruction.identifyNote': '识别这个音。',
  // {note} is a bare note name, untranslated
  'training.session.instruction.matchNote': '配唱 {note}。',
  'training.session.instruction.identifyScaleDegree': '识别这个音级。',
  'training.session.instruction.singScaleDegree': '唱出第 {degree} 音级 — {note}。',
  'training.session.instruction.identifyInterval': '识别这个音程。',
  // {interval} is prompt.intervalName (a music-theory term, untranslated)
  'training.session.instruction.singInterval': '唱出{direction}{interval} — 从 {from} 到 {to}。',
  'training.session.instruction.identifyChordTone': '识别这个和弦音。',
  'training.session.instruction.singChordTone': '唱出 {chord} 的{role} — {note}。',
  'training.session.instruction.identifyArpeggio': '识别这个琶音和弦。',
  'training.session.instruction.arpeggiate': '以{direction}方式琶奏 {chord}。',

  // ── session generator validation error reachable from normal setup ──
  'training.session.error.rangeTooNarrow': '在这个舒适音域内没有合适的练习。',
  'training.session.error.confirmKeyThenReview': '确认或更改歌曲的调式，然后查看准备会话。',
  'training.session.error.setUpSessionFirst': '请先设置一个训练会话，然后再开始。',
  'training.session.error.exerciseNoLongerActive': '这个练习已不再进行。',

  // ── audio/training-cleanup.ts: cross-feature audio-safety notices ──
  'training.cleanup.songBlocked':
    '在声乐训练确认其麦克风和练习音频已停止之前，歌曲播放不可用。请在声乐训练中重试清理。',
  'training.cleanup.settingsBlocked':
    '在声乐训练确认其麦克风和练习音频已停止之前，音频设置不可用。请在声乐训练中重试清理。',
  'training.cleanup.audioBlocked':
    '在上一次麦克风和练习音频清理尚未完成之前，声乐训练音频不可用。请先重试清理，然后再继续。',
  // thrown as an Error message when cleanup fails with a non-Error cause;
  // surfaces wherever that error's .message is displayed
  'training.cleanup.couldNotConfirm': '无法确认训练音频已清理。',

  // ── misc ──
  'training.error.couldNotOpenFile': '无法打开该文件。'
}
