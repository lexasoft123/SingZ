export const STEMS = ['vocals', 'drums', 'bass', 'other'] as const
export type StemName = (typeof STEMS)[number]

export type EngineStatus = { ok: true; command: string } | { ok: false; message: string }

export interface SeparationProgress {
  stage: 'preparing' | 'downloading-model' | 'separating' | 'loading-stems'
  percent: number
  detail?: string
}

export type RegisterResult =
  | { ok: true; path: string; name: string; size: number }
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
  stage: 'preparing' | 'downloading-model' | 'transcribing'
  percent: number
}

export type LyricsResult =
  | { ok: true; cached: boolean; lines: LyricLine[] }
  | {
      ok: false
      cancelled?: boolean
      /** The bundled whisper-cli binary is missing (broken build / dev without vendor). */
      needsEngine?: boolean
      /** Model weights not downloaded yet — ask the user before pulling them. */
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
   * Transcribe the song's vocals stem into word-timed lyrics (cached per song).
   * Runs the bundled whisper-cli; pass allowDownload to fetch model weights.
   */
  getLyrics(songPath: string, durationSec: number, allowDownload?: boolean): Promise<LyricsResult>
  cancelLyrics(): Promise<void>
  onLyricsProgress(cb: (p: LyricsProgress) => void): () => void
  /** Ask the OS for microphone permission (macOS prompts; other platforms return true). */
  askMicAccess(): Promise<boolean>
}
