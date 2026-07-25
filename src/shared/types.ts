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
}
