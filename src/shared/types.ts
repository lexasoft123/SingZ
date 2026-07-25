export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemName = (typeof STEMS)[number]

export type EngineStatus = { ok: true; command: string } | { ok: false; message: string }

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
  | { ok: true; cached: boolean; lines: LyricLine[]; source: LyricsSource; credit?: string }
  | {
      ok: false
      cancelled?: boolean
      /** The bundled whisper-cli binary is missing (broken build / dev without vendor). */
      needsEngine?: boolean
      /** No online lyrics found; AI transcription needs model weights — ask the user first. */
      needsModel?: { sizeMb: number }
      error: string
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
    prefer?: 'auto' | 'whisper'
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
  /** Save the current song + stems + lyrics + settings into ~/Music/SingZ/<name>/. */
  saveProject(
    songPath: string,
    name: string,
    settings: ProjectSettings
  ): Promise<{ ok: true; dir: string } | { ok: false; error: string }>
}
