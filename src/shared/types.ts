export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemName = (typeof STEMS)[number]

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

export type ModelId = 'gpu-splitter'

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

export interface ProjectSettings {
  transpose: number
  tracks: Record<string, { muted: boolean; solo: boolean; volume: number }>
}

export interface ProjectInfo {
  dir: string
  name: string
  settings: ProjectSettings
  /** All four stem files, when the project has them. */
  stems?: Record<StemName, string>
  hasLyrics: boolean
}

export interface ProjectListItem {
  dir: string
  name: string
  songPath: string
  savedAt: string
  hasStems: boolean
  hasLyrics: boolean
}

export type RenameResult =
  | { ok: true; name: string; dir: string; songPath: string; stems?: Record<StemName, string> }
  | { ok: false; error: string }

export type RegisterResult =
  | { ok: true; path: string; name: string; size: number; project?: ProjectInfo }
  | { ok: false; error: string }

export type SeparateResult =
  | { ok: true; cached: boolean; stems: Record<StemName, string> }
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
      /** Word timing was refined against a Whisper transcription of the vocals. */
      aligned?: boolean
    }
  | {
      ok: false
      cancelled?: boolean
      /** The bundled whisper-cli binary is missing (broken build / dev without vendor). */
      needsEngine?: boolean
      /** No online lyrics found; AI transcription needs model weights — ask the user first. */
      needsModel?: { sizeMb: number }
      error: string
    }

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  source: string
  line: string
}

export interface SingzApi {
  /** Resolve the on-disk path of a dropped/picked File (empty string if none). */
  pathForFile(file: File): string
  /** Read a registered audio file's bytes (source song or produced stem). */
  readAudio(path: string): Promise<ArrayBuffer>
  registerSource(path: string): Promise<RegisterResult>
  checkEngine(force?: boolean): Promise<EngineStatus>
  separate(path: string): Promise<SeparateResult>
  cancelSeparation(): Promise<void>
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
    prefer?: 'auto' | 'whisper' | 'align'
  ): Promise<LyricsResult>
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
   * Save the current song + stems + lyrics + settings into
   * ~/Documents/SingZ/<name>/; the song then lives at the returned songPath.
   */
  saveProject(
    songPath: string,
    name: string,
    settings: ProjectSettings
  ): Promise<{ ok: true; dir: string; songPath: string } | { ok: false; error: string }>
  /** Saved-project library for the in-app Open screen. */
  listProjects(): Promise<{ root: string; projects: ProjectListItem[] }>
  /** Rename a saved project's folder + metadata; returns the moved paths. */
  renameProject(songPath: string, newName: string): Promise<RenameResult>
}
