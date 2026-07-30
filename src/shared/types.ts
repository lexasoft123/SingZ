export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemName = (typeof STEMS)[number]

/** Six-stem model adds guitar and piano (order = display order). */
export const STEMS_6 = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const
export type StemName6 = (typeof STEMS_6)[number]

export type EngineStatus =
  | {
      ok: true
      command: string
      /** Renderer should provide a rendered 44.1k WAV before splitting. */
      needsPcm?: boolean
    }
  | {
      ok: false
      message: string
      /** The engine binary is there but its model weights are not downloaded yet. */
      needsModels?: boolean
    }

export type ModelId = 'gpu-splitter' | 'whisper' | 'aligner'

export interface ModelInfo {
  id: ModelId
  label: string
  description: string
  sizeMb: number
  present: boolean
  required: boolean
  optional: boolean
}

export interface ModelsProgress {
  id: ModelId
  percent: number
}

export interface SeparationProgress {
  stage: 'preparing' | 'downloading-model' | 'separating' | 'loading-stems'
  percent: number
  detail?: string
}

/**
 * The song's beat track: every beat's time in seconds, ascending. Real
 * recordings drift, so beats are tracked (auto, from the drums stem) rather
 * than derived from one constant tempo; tapped/typed tempos materialize to
 * a constant track. bpm is the median tempo, kept fractional for display
 * and target-rate math.
 */
export interface BeatInfo {
  beats: number[]
  bpm: number
  beatsPerBar: number
  /** Index into beats of a downbeat — bar accents count from it. */
  downbeat: number
  /**
   * Explicit bar starts: strictly increasing beat INDICES into `beats`, each
   * starting a bar. A bar's length is the distance to the next entry; bars
   * continue past the last entry at the last bar's length, and bars before
   * `downbeats[0]` extrapolate backward at the first bar's length. Absent =
   * uniform bars (every manual track; auto tracks from detectors ≤ v4).
   *
   * When present this is the source of truth for accents and bar lengths —
   * it can say what the legacy pair cannot: phase changes (a song re-entering
   * after a fermata on a different bar parity gets one odd-length boundary
   * bar, with the beat times left honest) and, later, real meter changes.
   * The legacy pair MUST stay populated for old readers (phones in the
   * field, which drop unknown fields): `beatsPerBar` = the dominant bar
   * length (mode of the gaps), `downbeat` = `downbeats[0] % beatsPerBar` —
   * a best-effort uniform view that is exact up to the first phase change.
   */
  downbeats?: number[]
  /** auto = tracked from the drums stem; manual = tapped, typed or nudged. */
  source: 'auto' | 'manual'
  /** Detector stamp for auto tracks — older stamps re-detect on load. */
  detVersion?: number
}

/** Metronome preferences: click along playback, count-in bars, click loudness. */
export interface MetronomeConfig {
  click: boolean
  countInBars: number
  volume: number
  /** Ring the "1" brighter. Off = every click identical (wrong-downbeat
   *  escape hatch, and some singers just prefer a flat click). */
  accent: boolean
}

/**
 * An audio file the singer added to the project themselves — a backing track,
 * a harmony they recorded, a click, a spoken cue. It plays as one more lane
 * alongside the stems; its mute/solo/volume live in `settings.tracks` under
 * the same id, exactly like a stem's.
 *
 * `file` is **absolute** everywhere in memory and over IPC, and
 * **project-relative** (`stems/custom-harmony.mp3`) inside project.json — the
 * project folder moves (rename, import, another machine, a cloud library) and
 * absolute paths saved into it would rot. Custom tracks live in `stems/` on
 * purpose: that is the folder Drive sync uploads and the phones already fetch.
 */
export interface CustomTrack {
  /** `custom-<slug>`; unique per project and the mixer key in settings.tracks. */
  id: string
  label: string
  color: string
  file: string
}

export interface ProjectSettings {
  transpose: number
  /** Playback speed (1 = original); optional for projects saved before it existed. */
  tempo?: number
  /** Beat track driving the metronome and count-in. */
  beat?: BeatInfo
  /** Metronome preferences (click on/off, count-in bars, loudness 0–1). */
  metronome?: MetronomeConfig
  /** Saved timeline zoom viewport (seconds). */
  view?: { s: number; e: number }
  /** Saved loop/selection range (seconds). */
  selection?: { s: number; e: number }
  /** Loop button armed. */
  loop?: boolean
  /** Vocal training: chosen stems drop out on a schedule so the singer carries them. */
  training?: {
    on?: boolean
    mode: 'time' | 'lines'
    periodSec: number
    hear: number
    sing: number
    stems: string[]
  }
  /** Audio files the singer added as extra lanes (absolute over IPC). */
  custom?: CustomTrack[]
  tracks: Record<string, { muted: boolean; solo: boolean; volume: number }>
}

export interface ProjectInfo {
  dir: string
  name: string
  /** 1 = WAV stems (pre-0.7), 2 = FLAC stems. Missing on old metas = 1. */
  formatVersion?: number
  settings: ProjectSettings
  /** Stem files on disk (at least the core four), when the project has them. */
  stems?: Partial<Record<StemName6, string>>
  hasLyrics: boolean
  /**
   * False for a project folder opened from outside the library root — a copied,
   * shared or other-machine folder. It saves and renames where it lives; the
   * Add-to-library action is what brings it in.
   */
  inLibrary: boolean
}

/** A cloud-synced folder detected on this machine (offered as a library home). */
export interface CloudRoot {
  label: string
  path: string
}

export interface ProjectListItem {
  dir: string
  name: string
  songPath: string
  savedAt: string
  hasStems: boolean
  stemCount: number
  hasLyrics: boolean
}

export type RenameResult =
  | {
      ok: true
      name: string
      dir: string
      songPath: string
      stems?: Partial<Record<StemName6, string>>
      /** Custom-track paths under the new folder (the old ones no longer exist). */
      custom?: CustomTrack[]
    }
  | { ok: false; error: string }

/** Result of bringing an outside project folder into the library. */
export type ImportResult =
  | {
      ok: true
      dir: string
      songPath: string
      stems?: Partial<Record<StemName6, string>>
      /** Custom-track paths in the library copy. */
      custom?: CustomTrack[]
      /** True when the original folder was relocated, false when it was copied. */
      moved: boolean
    }
  | { ok: false; error: string }

export type RegisterResult =
  | { ok: true; path: string; name: string; size: number; project?: ProjectInfo }
  | { ok: false; error: string }

export type SeparateResult =
  | { ok: true; cached: boolean; stems: Partial<Record<StemName6, string>> }
  | { ok: false; cancelled?: boolean; error: string }

export interface LyricWord {
  w: string
  s: number
  e: number
}

export interface LyricLine {
  start: number
  end: number
  text: string
  words: LyricWord[]
}

export interface LyricsProgress {
  stage: 'preparing' | 'searching' | 'downloading-model' | 'transcribing'
  percent: number
}

export type LyricsSource = 'lrclib' | 'whisper'

/** How word timing was produced: whisper transcription match or CTC forced alignment. */
export type AlignMethod = 'whisper' | 'ctc'

/**
 * Verdict of checking database lyrics against what is actually sung.
 * - match: text fits the recording and the original timing was already close
 * - retimed: text fits; word timing was re-snapped to the recording
 * - mismatch: the text largely is not what is sung — lyrics left untouched
 */
export interface AlignCheck {
  verdict: 'match' | 'retimed' | 'mismatch'
  method: AlignMethod
  /** Percent of lyric words confidently heard in the vocals (0-100). */
  matchedPct: number
  /** Median start shift applied to lines, seconds (signed; retimed vs original). */
  medianShift: number
  /** Indexes of lines where most words were not heard as written. */
  badLines: number[]
  /** A long sung passage has no counterpart in the lyrics (missing verse?). */
  extraSung?: boolean
}

export interface LyricsCandidate {
  id: number
  artist: string
  track: string
  album?: string
  duration: number
  synced: boolean
}

export type LyricsResult =
  | {
      ok: true
      cached: boolean
      lines: LyricLine[]
      source: LyricsSource
      credit?: string
      /** Word timing was refined against the vocals stem. */
      aligned?: boolean
      /** Result of the words-vs-recording check (align runs only). */
      check?: AlignCheck
    }
  | {
      ok: false
      cancelled?: boolean
      /** The bundled whisper-cli binary is missing (broken build / dev without vendor). */
      needsEngine?: boolean
      /** A model download is needed first — ask the user (what tells which). */
      needsModel?: { sizeMb: number; what?: 'speech' | 'aligner' }
      error: string
    }

/**
 * ML beat analysis from the splitter pack's Beat This! runner: peak-picked
 * beat/downbeat times (downbeats snapped onto beats) plus the framewise
 * sigmoid head probabilities at `fps` (50) — the phase arbiter samples those
 * as one cue among the stem votes.
 */
export type BeatsMlResult =
  | {
      ok: true
      beats: number[]
      downbeats: number[]
      beatProb: number[]
      downbeatProb: number[]
      fps: number
    }
  | { ok: false; error: string }

export type UpdateState =
  | { state: 'none' }
  | { state: 'checking' }
  | { state: 'available'; version: string; url: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  source: string
  line: string
}

export interface SingzApi {
  /** Windows splitting engine preference (backed by the dml-disabled marker). */
  getSplitterMode(): Promise<{ mode: 'auto' | 'cpu'; reason?: string }>
  setSplitterMode(mode: 'auto' | 'cpu'): Promise<{ ok: boolean; error?: string }>
  updateStateNow: () => Promise<UpdateState>
  installUpdate: () => void
  onUpdateState: (cb: (s: UpdateState) => void) => () => void
  winMinimize: () => void
  winMaximizeToggle: () => void
  winClose: () => void
  winIsMaximized: () => Promise<boolean>
  onWinMaximized: (cb: (maximized: boolean) => void) => () => void
  /** Resolve the on-disk path of a dropped/picked File (empty string if none). */
  pathForFile(file: File): string
  /** Read a registered audio file's bytes (source song or produced stem). */
  readAudio(path: string): Promise<ArrayBuffer>
  registerSource(path: string): Promise<RegisterResult>
  /**
   * Make an audio file readable as an extra lane. Unlike registerSource this
   * allowlists the one file only — a custom track picked from inside someone
   * else's project folder must not open that folder up.
   */
  registerTrack(
    path: string
  ): Promise<{ ok: true; path: string; name: string; size: number } | { ok: false; error: string }>
  checkEngine(force?: boolean): Promise<EngineStatus>
  separate(path: string): Promise<SeparateResult>
  cancelSeparation(): Promise<void>
  /** Does the installed splitter pack include the Beat This! beat model? */
  beatsMlAvailable(): Promise<{ ok: true; available: boolean }>
  /** Run ML beat/downbeat detection on raw mono float32 PCM at `sr` (22050). */
  beatsMlDetect(pcm: ArrayBuffer, sr: number): Promise<BeatsMlResult>
  revealInFolder(path: string): Promise<void>
  openExternal(url: string): Promise<void>
  /** Subscribe to separation progress. Returns an unsubscribe function. */
  onSeparationProgress(cb: (p: SeparationProgress) => void): () => void
  /**
   * Resolve word-timed lyrics (cached per song): LRCLIB synced lyrics first,
   * then the bundled whisper-cli as fallback (allowDownload fetches weights,
   * prefer:'whisper' forces a fresh AI transcription).
   */
  getLyrics(
    songPath: string,
    durationSec: number,
    allowDownload?: boolean,
    prefer?: 'auto' | 'whisper' | 'align' | 'precise'
  ): Promise<LyricsResult>
  /** Whether the precise (CTC forced-alignment) aligner can run on this machine. */
  alignCaps(): Promise<{ precise: boolean }>
  /** Manual LRCLIB search for the variant picker. */
  searchLyrics(
    query: { artist?: string; title?: string; free?: string },
    durationSec: number
  ): Promise<LyricsCandidate[]>
  /** Apply a specific LRCLIB record as this song's lyrics (overwrites cache). */
  applyLyrics(songPath: string, id: number, durationSec: number): Promise<LyricsResult>
  cancelLyrics(): Promise<void>
  onLyricsProgress(cb: (p: LyricsProgress) => void): () => void
  /** Ask the OS for microphone permission (macOS prompts; other platforms return true). */
  askMicAccess(): Promise<boolean>
  /** First-run setup: model inventory and the shared download flow. */
  modelsStatus(): Promise<ModelInfo[]>
  downloadModels(
    ids?: ModelId[]
  ): Promise<{ ok: true } | { ok: false; cancelled?: boolean; error: string }>
  cancelModels(): Promise<void>
  onModelsProgress(cb: (p: ModelsProgress) => void): () => void
  /** 44.1k stereo PCM of the current song for the bundled splitter. */
  provideSplitInput(songPath: string, ch0: Float32Array, ch1: Float32Array): Promise<void>
  /** Diagnostic log: current buffer, live stream, save-to-file (dialog unless path given). */
  getLog(): Promise<LogEntry[]>
  saveLog(
    path?: string
  ): Promise<{ ok: true; path: string } | { ok: false; cancelled?: boolean; error: string }>
  onLogLine(cb: (e: LogEntry) => void): () => void
  /** App version for the titlebar ("dev" outside packaged builds). */
  appVersion(): Promise<string>
  /**
   * Save the current song + stems + lyrics + settings. A loose song lands in a
   * new folder under the library root; a song already inside a project folder
   * is saved in place, wherever that folder lives.
   */
  saveProject(
    songPath: string,
    name: string,
    settings: ProjectSettings
  ): Promise<
    | {
        ok: true
        dir: string
        songPath: string
        inLibrary: boolean
        /** Custom tracks as they now live inside the project folder. */
        custom?: CustomTrack[]
        /** Drive is configured but signed out — the library did NOT sync. */
        driveSignedOut?: boolean
      }
    | { ok: false; error: string }
  >
  /** Saved-project library for the in-app Open screen. */
  listProjects(): Promise<{ root: string; projects: ProjectListItem[] }>
  /** Rename a saved project's folder + metadata in place; returns the moved paths. */
  renameProject(songPath: string, newName: string): Promise<RenameResult>
  /**
   * Bring a project opened from outside the library into it — 'copy' leaves the
   * original folder alone, 'move' relocates it. Returns the project's new home.
   */
  importProject(songPath: string, mode: 'copy' | 'move'): Promise<ImportResult>
  /**
   * Upgrade a v1 project (WAV stems) to v2 (FLAC, ~4x smaller) in place.
   * Runs after a v1 project opens; WAVs are deleted only once every stem
   * converted.
   */
  upgradeProject(dir: string): Promise<{ ok: boolean; converted?: boolean; error?: string }>
  /** Where the library lives + cloud folders detected on this machine. */
  getStorage(): Promise<{ root: string; isDefault: boolean; cloud: CloudRoot[] }>
  /** Move the library (null = back to Documents/SingZ); existing projects are copied over. */
  setProjectsRoot(
    path: string | null
  ): Promise<{ ok: true; root: string; copied: number } | { ok: false; error: string }>
  /** OS folder picker for a custom library location. */
  chooseProjectsRoot(): Promise<
    { ok: true; root: string; copied: number } | { ok: false; cancelled?: boolean; error?: string }
  >

  /** Google Drive sync (drive.file scope — no Drive client needed anywhere). */
  gdriveStatus(): Promise<{ configured: boolean; signedIn: boolean; lastSync?: number | null }>
  gdriveSignIn(): Promise<{ ok: true } | { ok: false; error: string }>
  gdriveSignOut(): Promise<{ ok: boolean }>
  gdriveSync(): Promise<{
    ok: boolean
    uploaded: number
    unchanged: number
    projects: number
    error?: string
  }>
  onGdriveProgress(cb: (p: { msg: string; frac: number }) => void): () => void
}
