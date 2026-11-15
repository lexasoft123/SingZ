import type { DesktopPlaybackStatus, LyricLine, ProjectGraphPayload, ProjectInfo, ProjectListItem } from './types'
import type { BoxMicrophoneLevels, BoxMicrophoneSelectionEdit, BoxMicrophoneSelectionResult, BoxMicrophoneSnapshot } from './box-audio'

export type BoxRetainedPlaybackRestore = {
  epoch: string
  recovery: BoxRetainedPlaybackRecovery
  item: ProjectListItem
  project: ProjectInfo
  lyrics: LyricLine[]
  graph: ProjectGraphPayload | null
}

export type BoxResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string }

export type BoxMetronomeOverride = 'song' | 'off'

export type BoxPreferences = {
  setupComplete: boolean
  safeAreaPercent: 0 | 3 | 5
  language: string
  metronomeOverride?: BoxMetronomeOverride
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

export type BoxCecTelemetry = {
  received: number
  acceptedPress: number
  acceptedRelease: number
  rejectedFormat: number
  rejectedInitiator: number
  rejectedDestination: number
  powerReplyQueued?: number
  powerReplyErrors?: number
  powerReplySuppressed?: number
  powerReplyCompleted?: number
  powerReplyFailed?: number
  powerReplyExpired?: number
  lastPowerReplyTxStatus?: number
  physicalAddress: number
  logicalAddressMask: number
  lastRx?: { initiator: number; destination: number; opcode: number; length: number; rxStatus: number }
  lastStateChange?: { physicalAddress: number; logicalAddressMask: number }
}

export type BoxCecStatus = {
  state: 'disabled' | 'starting' | 'ready' | 'unavailable' | 'error'
  detail?: string
  lastInputAt: number | null
  /** Kernel receive to Electron main, excluding TV transmission/display delay. */
  lastReceiveToMainMs?: number
  lastPressAt?: number
  diagnostics?: {
    helper?: BoxCecTelemetry
    helperReceivedAt?: number
    deliveredEvents: number
    notReadyPresses: number
    blockedPresses: number
  }
}

export type BoxDiagnostics = {
  appVersion: string
  platform: string
  arch: string
  audio: unknown
  cec?: BoxCecStatus
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
  retainedPlaybackSnapshot(): Promise<BoxResult<BoxRetainedPlaybackSnapshot>>
  stopRetainedPlayback(expected: { epoch: string; generation: string }): Promise<BoxResult<BoxRetainedPlaybackSnapshot>>
  restoreRetainedPlayback(expected: { epoch: string; generation: string }): Promise<BoxResult<BoxRetainedPlaybackRestore>>
  routingSnapshot(): Promise<BoxResult<BoxRoutingState>>
  routingEdit(edit: { expected: { epoch: string; generation: string }; commands: unknown[] }): Promise<BoxResult<BoxRoutingState>>
  /** Host-owned microphone analysis: read-only snapshot (levels, pitch, phase, selection). */
  microphones(): Promise<BoxResult<BoxMicrophoneSnapshot>>
  /** Enables bounded developer tracing; absent in normal operation. */
  meterTraceEnabled?: true
  /** Level-only read for visible meters, frame-aligned and capped at 30 Hz. */
  microphoneLevels(): Promise<BoxResult<BoxMicrophoneLevels>>
  /** Optional push extension; old preload/host versions retain fast reads. */
  subscribeMicrophoneLevels?(subscription: string): Promise<BoxResult<null>>
  unsubscribeMicrophoneLevels?(subscription: string): Promise<BoxResult<null>>
  ackMicrophoneLevels?(subscription: string, sequence: number): Promise<BoxResult<null>>
  onMicrophoneLevels?(callback: (value: BoxMicrophoneLevels, subscription: string, sequence: number) => void): () => void
  /** Revision compare-and-set of the persisted input selection; applies immediately. */
  setMicrophoneSelection(edit: BoxMicrophoneSelectionEdit): Promise<BoxResult<BoxMicrophoneSelectionResult>>
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

export type BoxRoutingWire = { sourceChannel: number; outputChannel: number; gain: number }
export type BoxRoutingMeter = {
  valid: boolean
  channels: number
  frames: number
  peak: number[]
  rms: number[]
}
export type BoxRoutingState = {
  version: 1
  inventory: {
    devicesFresh?: boolean
    devicesError?: string
    devices: {
      uid: string; name: string; inputChannels: number; outputChannels: number
      inputChannelNames?: string[]; outputChannelNames?: string[]
      defaultInput?: boolean; defaultOutput?: boolean; rate?: number
    }[]
  }
  snapshot: {
    revision: { epoch: string; generation: string }
    document: null | { devices: {
      id: string; name: string
      routing: { outputChannels: number; sources: { id: string; channels: number; gain: number; enabled: boolean; muted: boolean; connections: BoxRoutingWire[] }[] }
      bindings: { id: string; kind: string; selector: string }[]
      monitors: { id: string; deviceSelector: string; channels: number; gain: number; enabled: boolean; muted: boolean; connections: BoxRoutingWire[] }[]
    }[] }
    restoration: { phase: string; error: string; desiredGeneration: string; activeGeneration: string }
    runtime: {
      metersFresh: boolean
      devices?: { id: string; active: boolean; meter: BoxRoutingMeter; sources: {
        id: string; online: boolean; missingFrames: string; meter: BoxRoutingMeter
      }[] }[]
      monitors: { device: string; monitor: string; sourceOnline: boolean; meter: { valid: boolean; peak?: number[] } }[]
    }
  }
}

export type BoxRetainedProjectMedia = {
  id: string
  path: string
  size: string
  mtimeMs: number
}

export type BoxRetainedProjectDescriptor = {
  version: 1
  project: {
    dir: string
    songPath: string
    name: string
    metadataHash: string
    lyricsHash: string | null
    graphHash: string | null
    media: BoxRetainedProjectMedia[]
  }
  config: import('./types').DesktopPlaybackPrepareConfig
  lanes: import('./types').DesktopPlaybackLaneConfig[]
}

export type BoxRetainedPlaybackRecovery = {
  generation: string
  descriptor: BoxRetainedProjectDescriptor
  status: DesktopPlaybackStatus
}

export type BoxRetainedPlaybackSnapshot = {
  epoch: string
  playback: Pick<DesktopPlaybackStatus, 'generation' | 'state' | 'transportState'> | null
  /** Absent on old hosts and whenever only the explicit Stop fallback is safe. */
  recovery?: BoxRetainedPlaybackRecovery | null
}
