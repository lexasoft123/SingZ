export type BoxResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

export type BoxPreferences = {
  setupComplete: boolean
  safeAreaPercent: 0 | 3 | 5
  language: string
}

export type BoxQueueRef = { kind: 'local'; dir: string } | { kind: 'drive'; id: string }

export type BoxState = {
  version: 1
  preferences: BoxPreferences
  queue: BoxQueueRef[]
}

export type BoxPlatformSnapshot = {
  available: boolean
  capabilities: { wifi: boolean; updates: boolean; reboot: boolean; reset: boolean }
  connectivity: {
    interfaces: { name: string; address: string }[]
    internet: 'unknown'
  }
  network: {
    state: 'unavailable' | 'disconnected' | 'connected' | 'connecting' | 'error'
    ssid?: string
    error?: string
    handoff?: { url: string; code: string; expiresAt: number }
  }
  update: {
    state: 'unavailable' | 'idle' | 'checking' | 'available' | 'staging' | 'staged' | 'installing' | 'rollback' | 'error'
    currentVersion: string
    version?: string
    error?: string
  }
  reason?: string
}

export type BoxPlatformCommand = {
  type: 'wifi-start' | 'wifi-cancel' | 'update-check' | 'update-stage' | 'update-install' | 'rollback' | 'reboot' | 'reset'
  requestId?: string
}

export type BoxStorageSnapshot = {
  totalBytes: number
  freeBytes: number
  cacheBytes: number
  projects: { dir: string; name: string; bytes: number; driveId: string }[]
}

export type BoxDiagnostics = {
  appVersion: string
  platform: string
  arch: string
  audio: unknown
}

export type BoxPhoneState = {
  running: boolean
  url?: string
  code?: string
  expiresAt?: number
  pending: { requestId: string; name: string; expiresAt: number }[]
  sessions: { sessionId: string; name: string; expiresAt: number }[]
  reason?: string
}

export type BoxControllerCommand =
  | { type: 'play-pause' }
  | { type: 'seek'; position: number }
  | { type: 'volume'; target: string; value: number }
  | { type: 'mute' | 'solo'; target: string; value: boolean }
  | { type: 'select' | 'queue-add'; projectId: string }
  | { type: 'queue-remove'; entryId: string }
  | { type: 'queue-move'; entryId: string; delta: -1 | 1 }

export type BoxControllerSnapshot = {
  activeProjectId: string | null
  transport: {
    playing: boolean
    position: number
    duration: number
    masterVolume: number
  }
  songs: { id: string; title: string; artist: string; ready: boolean }[]
  queue: { entryId: string; projectId: string; title: string; artist: string }[]
  stems: { id: string; label: string; volume: number; muted: boolean; solo: boolean }[]
}

export type BoxControllerPublish = BoxControllerSnapshot & {
  activeLocalProjectDir: string | null
  openingLocalProjectDir?: string | null
}

export type BoxControllerEnvelope = { id: string; command: BoxControllerCommand }
export type BoxControllerResponse = { ok: boolean; error?: string }

export type BoxAPI = {
  getState(): Promise<BoxResult<BoxState>>
  setPreferences(preferences: Partial<BoxPreferences>): Promise<BoxResult<BoxState>>
  saveQueue(queue: BoxQueueRef[]): Promise<BoxResult<BoxState>>
  platformSnapshot(): Promise<BoxResult<BoxPlatformSnapshot>>
  platformCommand(command: BoxPlatformCommand): Promise<BoxResult<BoxPlatformSnapshot>>
  storageSnapshot(): Promise<BoxResult<BoxStorageSnapshot>>
  removeCachedProject(dir: string): Promise<BoxResult<null>>
  diagnostics(): Promise<BoxResult<BoxDiagnostics>>
  phoneStart(): Promise<BoxResult<BoxPhoneState>>
  phoneState(): Promise<BoxResult<BoxPhoneState>>
  phoneApprove(requestId: string): Promise<BoxResult<BoxPhoneState>>
  phoneDeny(requestId: string): Promise<BoxResult<BoxPhoneState>>
  phoneRevoke(sessionId: string): Promise<BoxResult<BoxPhoneState>>
  phoneStop(): Promise<BoxResult<null>>
  publishControllerSnapshot(snapshot: BoxControllerPublish): Promise<BoxResult<null>>
  respondControllerCommand(id: string, result: BoxControllerResponse): Promise<BoxResult<null>>
  isControllerCommandActive(id: string): Promise<BoxResult<boolean>>
  onControllerCommand(callback: (envelope: BoxControllerEnvelope) => void): () => void
}
