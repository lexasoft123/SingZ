/* 简体中文 — the `lyrics` strings, typed against English. */
import type { lyrics as en } from '../en/lyrics'
import type { Translation } from '../types'

export const lyrics: Translation<typeof en> = {
  // ── shared badges/suffixes (used by both the check-verdict text and the panel) ──
  // trailing badge appended when the check ran the precise (CTC) method, e.g. "…heard · precise"
  'lyrics.check.preciseSuffix': ' · 精确',

  // ── lyrics-state.ts: a finished job with no words at all ──
  'lyrics.state.noWordsDetected': '在人声中没有检测到任何歌词。',

  // ── lyrics-edit.ts: describeCheck() — the align verdict line under the editor ──
  // shown when the lyrics text barely matches what was actually sung
  'lyrics.check.mismatchPrecise': '在人声中只听到了 {pct}% 的歌词——请检查歌词，或试试精确对齐。',
  'lyrics.check.mismatchNoPrecise': '在人声中只听到了 {pct}% 的歌词——请对照实际演唱检查歌词。',
  'lyrics.check.wordsHeard': '听到了 {pct}% 的歌词',
  'lyrics.check.everySnapped': '每一行都已对齐演唱',
  // shown when the singer sings more than these lyrics cover, but every line still snapped
  'lyrics.check.extraSungNote': '每一行都已对齐——不过歌手唱的部分超出了这份歌词',
  'lyrics.check.badLines_one': '有 {n} 行无法辨认，保留了估算的时间',
  'lyrics.check.badLines_other': '有 {n} 行无法辨认，保留了估算的时间',

  // ── LyricsPanel.tsx ──
  'lyrics.panel.title': '歌词',
  'lyrics.panel.guide.titleOn': '静音原始人声',
  'lyrics.panel.guide.titleOff': '播放原始人声作为参考',
  'lyrics.panel.guide.label': '原声引导',

  // stage labels while a lyrics job runs (search/download/transcribe)
  'lyrics.panel.stage.preparing': '准备中',
  'lyrics.panel.stage.searching': '正在搜索在线歌词',
  'lyrics.panel.stage.downloadingModel': '正在下载语音模型',
  'lyrics.panel.stage.transcribing': '正在聆听人声',
  'lyrics.panel.stage.starting': '正在启动',

  // the small badge naming where the current lyrics came from
  'lyrics.panel.source.synced': '已同步',
  'lyrics.panel.source.edited': '已编辑',
  'lyrics.panel.source.aiTranscribed': 'AI 识别',
  // fallback credit text when there is no LRCLIB/edit credit string
  'lyrics.panel.credit.own': '你自己写的歌词',
  'lyrics.panel.credit.vocals': '来自人声分轨',
  'lyrics.panel.credit.aiAligned': ' · AI 对齐',

  'lyrics.panel.checkAlign.title': '聆听人声，对照实际演唱检查这份歌词，并将每个字的时间对齐到录音',
  'lyrics.panel.checkAlign.label': '检查并对齐',
  'lyrics.panel.precise.title': '使用多语言语音模型逐字强制对齐（时间最精确；一次性下载 1.2 GB）',
  'lyrics.panel.precise.label': '精确',
  'lyrics.panel.edit.title': '修改歌词，播放时给每行打上时间戳并重新对齐——你的修改会保留',
  'lyrics.panel.edit.label': '编辑',
  'lyrics.panel.change.label': '更换…',

  // the verdict line shown under the lyrics once a check has run
  'lyrics.panel.check.mismatch': '这份歌词似乎和录音不匹配——只听到了 {pct}% 的歌词。试试更换…或 AI 识别。',
  'lyrics.panel.check.match': '歌词与录音匹配 · 听到了 {pct}%',
  'lyrics.panel.check.retimed': '已重新对齐录音 · 听到了 {pct}% 的歌词',
  // "off" as in "the timing was N seconds off" — {sec} already has one decimal, e.g. "1.3"
  'lyrics.panel.check.timingOff': ' · 时间偏差 {sec} 秒',
  'lyrics.panel.check.lineDiffers_one': ' · 有 {n} 行与实际演唱不符',
  'lyrics.panel.check.lineDiffers_other': ' · 有 {n} 行与实际演唱不符',
  'lyrics.panel.check.missingWords': ' · 歌手唱的部分这份歌词没有覆盖',

  'lyrics.panel.variants.back': '‹ 返回',
  'lyrics.panel.variants.aiTranscribeTitle': '用 Qwen3-ASR 聆听人声，从录音本身识别歌词',
  'lyrics.panel.variants.aiTranscribeLabel': '✦ AI 识别',
  'lyrics.panel.variants.searchPlaceholder': '歌手或歌曲名…',
  'lyrics.panel.variants.searchLabel': '搜索',
  'lyrics.panel.variants.nothingFound': '没有找到结果——换个词试试。',
  'lyrics.panel.variants.matches': ' · 匹配',
  'lyrics.panel.variants.synced': ' · 已同步',
  'lyrics.panel.variants.textOnly': ' · 仅文本',

  // consent card before downloading the speech / word-aligner model
  'lyrics.panel.consent.alignerText':
    '精确对齐使用**多语言分词对齐模型**（Meta MMS）聆听录音，将每个字精确定位到演唱的那一刻——全程在你的电脑上，通过分离引擎完成。',
  'lyrics.panel.consent.qwenText':
    'SingZ 用**Qwen3-ASR**聆听人声，这是一个专为演唱训练的语音模型，全程在你的电脑上运行——用来在网上找不到歌词时识别歌词，并检查、对齐已有的歌词。',
  'lyrics.panel.consent.fineprint': '一次性下载约 {mb} MB，保存在本地，每首歌都会复用。也可以稍后在模型管理器中下载。',
  'lyrics.panel.consent.downloadAlignLabel': '下载并精确对齐',
  'lyrics.panel.consent.downloadContinueLabel': '下载模型并继续',
  'lyrics.panel.consent.searchManually': '或手动搜索歌词数据库',

  'lyrics.panel.loading.cancel': '取消',

  'lyrics.panel.error.tryAgain': '重试',
  'lyrics.panel.error.searchManually': '手动搜索歌词数据库',
  'lyrics.panel.error.writeYourself': '或自己写歌词',

  'lyrics.panel.lines.jumpHere': '跳到这里',
  // fine print under AI-transcribed lyrics, followed by a "Fix the words" button — one sentence, two keys
  'lyrics.panel.whisperNote.text': 'AI 从人声中识别——不一定完全准确。',
  'lyrics.panel.whisperNote.fix': '修改歌词',

  // ── LyricsEditor.tsx ──
  'lyrics.editor.title': '编辑歌词',
  'lyrics.editor.unsavedChanges': '未保存的更改',
  'lyrics.editor.play': '播放',
  'lyrics.editor.pause': '暂停',
  'lyrics.editor.helpTitle': '如何使用编辑器',
  'lyrics.editor.cancel': '取消',
  'lyrics.editor.undo': '撤销',
  'lyrics.editor.replaceAll': '替换全部…',

  'lyrics.editor.tools.alignTitle':
    '将歌词与录音匹配，把每行、每个字对齐到演唱的时刻——如果识别结果已经在本地就是瞬间完成，否则会先聆听整首歌',
  'lyrics.editor.tools.alignLabel': '✦ 对齐演唱',
  'lyrics.editor.tools.preciseTitle': '用多语言分词对齐模型将每个字精确定位到演唱的那一刻（一次性下载模型）',
  'lyrics.editor.tools.preciseLabel': '精确',
  'lyrics.editor.tools.replaceTitle': '用剪贴板或笔记中的完整歌词替换——保留不变的行会保留其时间',
  'lyrics.editor.tools.silentTitle': '这些行位于歌曲中没有人唱的部分——几乎都是识别产生的错误',
  // "⌫ N line(s) with no singing" chip — ⌫ is the delete glyph, kept as-is
  'lyrics.editor.tools.silentLines_one': '⌫ {n} 行没有演唱',
  'lyrics.editor.tools.silentLines_other': '⌫ {n} 行没有演唱',

  'lyrics.editor.replace.placeholder': '每行一句——\n把整首歌粘贴到这里',
  'lyrics.editor.replace.use': '使用这份歌词',

  'lyrics.editor.row.stampTitleUntimed': '还没有时间——点击将播放头的时间打在这里（输入时按 {mod}）',
  'lyrics.editor.row.stampTitleTimed': '从这一行开始播放',
  'lyrics.editor.row.printTitleUntimed': '先给这一行计时（打上时间戳或对齐），再逐字微调',
  'lyrics.editor.row.printTitleTimed': '逐字微调时间',
  'lyrics.editor.row.placeholder': '输入或粘贴歌词…',
  'lyrics.editor.row.addTitle': '在这一行后添加新行',
  'lyrics.editor.row.removeTitle': '删除这一行',

  'lyrics.editor.wordstrip.title': '拖动可移动这个字 · 双击将其设为播放头位置 · ←/→ 微调 50 毫秒',

  // stage labels shown in the editor's own status line (distinct wording from the panel's)
  'lyrics.editor.stage.preparing': '准备中',
  'lyrics.editor.stage.searching': '正在搜索',
  'lyrics.editor.stage.downloadingModel': '正在下载模型',
  'lyrics.editor.stage.transcribing': '正在聆听人声',

  'lyrics.editor.consent.aligner': '精确对齐需要分词对齐模型——一次性下载 {mb} MB。',
  'lyrics.editor.consent.speech': '给歌词计时需要语音模型——一次性下载 {mb} MB。',
  'lyrics.editor.consent.download': '下载并对齐',
  'lyrics.editor.consent.notNow': '暂不',

  // the default hint line: "Enter splits a line · {mod} stamps..." plus one of two tails
  'lyrics.editor.hint.base': '按 Enter 分行 · {mod} 将播放头时间打在你正在输入的这行上',
  'lyrics.editor.hint.untimed_one': ' · 有 {n} 行还没有时间——对齐可以一次性全部完成',
  'lyrics.editor.hint.untimed_other': ' · 有 {n} 行还没有时间——对齐可以一次性全部完成',
  'lyrics.editor.hint.voiceprint': ' · 点击某行的声纹可打开逐字计时',

  'lyrics.editor.discard.question': '放弃你的修改吗？',
  'lyrics.editor.discard.keep': '继续编辑',
  'lyrics.editor.discard.discard': '放弃',
  'lyrics.editor.footer.cancelBusyTitle': '有一个对齐任务正在运行——请先取消它',

  'lyrics.editor.save.saving': '正在保存…',
  'lyrics.editor.save.label': '保存歌词',

  'lyrics.editor.help.gotIt': '知道了',
  'lyrics.editor.help.sectionLines': '行',
  'lyrics.editor.help.sectionTiming': '计时',
  'lyrics.editor.help.sectionWords': '字',
  'lyrics.editor.help.sectionOther': '其他',

  'lyrics.editor.help.lineNew': '新行——在光标处拆分文本',
  'lyrics.editor.help.lineAdd': '在这一行后添加一个空行——用于整段缺失的部分',
  'lyrics.editor.help.lineMerge': '在行首按下时，会合并到上一行',
  'lyrics.editor.help.lineRemove': '删除你所在的这一行',
  'lyrics.editor.help.lineMove': '在各行之间移动',
  'lyrics.editor.help.linePaste': '粘贴多行文本会自动分成多行',
  'lyrics.editor.help.labelPaste': '粘贴',

  'lyrics.editor.help.timingStamp': '将播放头时间打在你正在输入的这行上',
  'lyrics.editor.help.timingChip': '从那一行开始播放——或者，如果还没有时间，就打上时间戳',
  'lyrics.editor.help.labelTimeChip': '时间标签',
  'lyrics.editor.help.timingAlign': '一次性将每行、每个字都对齐到演唱',
  'lyrics.editor.help.labelAlign': '✦ 对齐',

  // {mod} is the platform's modifier key glyph (⌘ or Ctrl), kept untranslated
  'lyrics.editor.help.wordsVoiceprint': '点击某行的声纹（或在其中按 {mod} E）打开逐字计时',
  'lyrics.editor.help.labelVoiceprint': '声纹',
  'lyrics.editor.help.wordsDrag': '移动一个字——它的相邻字会限制它的范围',
  'lyrics.editor.help.labelDrag': '拖动',
  'lyrics.editor.help.wordsDoubleClick': '将一个字精确设置在播放头位置',
  'lyrics.editor.help.labelDoubleClick': '双击',
  'lyrics.editor.help.wordsNudge': '将选中的字微调 50 毫秒',

  'lyrics.editor.help.otherUndo': '撤销——按住 Shift 重做',
  'lyrics.editor.help.otherReplace': '粘贴整首歌的歌词；保留的行会保留其时间',
  'lyrics.editor.help.otherClose': '关闭编辑器（如有未保存的修改会先询问）'
}
