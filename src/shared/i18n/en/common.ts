/*
 * English — the source dictionary, split by namespace (one file per area of
 * the app). Every other language is typed against these keys, so a string
 * added here without its translations fails the typecheck.
 *
 * Markup, and only this much: `{name}` interpolates; `**bold**` is turned
 * into <b> by the renderer's rich(). Plurals are `_one` / `_other` pairs,
 * picked by tn(). Product and proper names — SingZ, Google Drive, LRCLIB,
 * Qwen3-ASR, Demucs, song titles — are never translated.
 */
export const common = {
  'lang.en': 'English',
  'lang.ru': 'Russian',
  'lang.zh-CN': 'Chinese (Simplified)',
  'lang.system': 'System',
  'lang.systemHint': 'Follows {os} · {name}',
  'lang.auto': 'auto',
  'lang.label': 'Language',

  // ── stems (lane names; the kit's STEM_META holds the English) ──
  'stem.original': 'Full mix',
  'stem.vocals': 'Vocals',
  'stem.drums': 'Drums',
  'stem.bass': 'Bass',
  'stem.guitar': 'Guitar',
  'stem.piano': 'Piano',
  // everything that is not vocals/drums/bass/guitar/piano
  'stem.other': 'Instruments',

  // a key: {tonic} is a note letter (C, F♯, B♭)
  'key.major': '{tonic} major',
  'key.minor': '{tonic} minor',

  // interval names, lowercase as they appear mid-sentence
  'interval.perfect.unison': 'perfect unison',
  'interval.augmented.unison': 'augmented unison',
  'interval.diminished.unison': 'diminished unison',
  'interval.major.second': 'major second',
  'interval.minor.second': 'minor second',
  'interval.augmented.second': 'augmented second',
  'interval.diminished.second': 'diminished second',
  'interval.major.third': 'major third',
  'interval.minor.third': 'minor third',
  'interval.augmented.third': 'augmented third',
  'interval.diminished.third': 'diminished third',
  'interval.perfect.fourth': 'perfect fourth',
  'interval.augmented.fourth': 'augmented fourth',
  'interval.diminished.fourth': 'diminished fourth',
  'interval.perfect.fifth': 'perfect fifth',
  'interval.augmented.fifth': 'augmented fifth',
  'interval.diminished.fifth': 'diminished fifth',
  'interval.major.sixth': 'major sixth',
  'interval.minor.sixth': 'minor sixth',
  'interval.augmented.sixth': 'augmented sixth',
  'interval.diminished.sixth': 'diminished sixth',
  'interval.major.seventh': 'major seventh',
  'interval.minor.seventh': 'minor seventh',
  'interval.augmented.seventh': 'augmented seventh',
  'interval.diminished.seventh': 'diminished seventh',
  'interval.perfect.octave': 'perfect octave',
  'interval.augmented.octave': 'augmented octave',
  'interval.diminished.octave': 'diminished octave'
}
