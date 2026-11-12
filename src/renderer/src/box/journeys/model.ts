import type { BoxPlatformSnapshot } from '../../../../shared/box-contract'
import type { JourneyPage } from './types'

export type SetupStage = 'boot' | 'welcome' | 'remote' | 'network' | 'audio' | 'account' | 'done'
export type Confirmation =
  | { kind: 'remove-cache'; dir: string; name: string; bytes: number; requireIdle: boolean }
  | { kind: 'phone-revoke'; sessionId: string; name: string }
  | { kind: 'phone-stop' | 'drive-signout' | 'update-install' | 'rollback' | 'reboot' | 'factory-reset' | 'wifi-switch' }
export type PendingConfirmation = Confirmation & { pending: boolean }
export const confirmationSafeChoice = (confirmation: Confirmation): 'keep' | 'cancel' =>
  confirmation.kind === 'remove-cache' ? 'keep' : 'cancel'
export interface JourneyState {
  page: JourneyPage
  setupStage: SetupStage
  /** Stage where Settings opened setup; Back from it returns to Settings instead of an earlier step. */
  setupEntry: SetupStage | null
  networkReturn: 'home' | 'setup'
  confirmation: PendingConfirmation | null
  committed: 'installing' | 'rollback' | null
  focusRevision: number
}
export type JourneyAction =
  | { type: 'open'; page: JourneyPage }
  | { type: 'open-setup'; stage?: SetupStage }
  | { type: 'setup-stage'; stage: SetupStage }
  | { type: 'setup-step'; delta: -1 | 1 }
  | { type: 'confirm'; confirmation: Confirmation }
  | { type: 'confirm-start' | 'confirm-finish' | 'confirm-cancel' }
  | { type: 'platform'; snapshot: BoxPlatformSnapshot }
export const setupStages: readonly SetupStage[] = ['boot', 'welcome', 'remote', 'network', 'audio', 'account', 'done']
/** The Settings row "Setup, remote & display" promises language first (J03: S02 → S03), so a
 * finished owner re-enters at the language step; a first run keeps its own position. */
export const settingsSetupEntry = (setupComplete: boolean | undefined): SetupStage | undefined =>
  setupComplete ? 'welcome' : undefined
export const initialJourney = (page: JourneyPage = 'home'): JourneyState => ({
  page, setupStage: 'boot', setupEntry: null, networkReturn: page === 'setup' ? 'setup' : 'home',
  confirmation: null, committed: null, focusRevision: 0
})
const focus = (state: JourneyState, patch: Partial<JourneyState>): JourneyState =>
  ({ ...state, ...patch, focusRevision: state.focusRevision + 1 })

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyState {
  if (state.committed && !['platform', 'confirm-finish', 'confirm-cancel'].includes(action.type)) return state
  if (state.confirmation && !['platform', 'confirm-start', 'confirm-finish', 'confirm-cancel'].includes(action.type)) return state
  switch (action.type) {
    case 'open': {
      const networkReturn = action.page === 'network' ? (state.page === 'setup' ? 'setup' : 'home') : state.networkReturn
      return focus(state, { page: action.page, confirmation: null, networkReturn })
    }
    case 'open-setup': return focus(state, { page: 'setup', setupStage: action.stage ?? state.setupStage, setupEntry: action.stage ?? null, confirmation: null })
    case 'setup-stage': return focus(state, { page: 'setup', setupStage: action.stage, confirmation: null })
    case 'setup-step': {
      const index = setupStages.indexOf(state.setupStage)
      if (action.delta < 0 && index === 0) return focus(state, { page: 'home' })
      const setupStage = setupStages[Math.max(0, Math.min(setupStages.length - 1, index + action.delta))]
      return setupStage === state.setupStage ? state : focus(state, { setupStage })
    }
    case 'confirm': return state.confirmation ? state : focus(state, { confirmation: { ...action.confirmation, pending: false } })
    case 'confirm-start': return state.confirmation
      ? { ...state, confirmation: { ...state.confirmation, pending: true } } : state
    case 'confirm-finish': return focus(state, { confirmation: null })
    case 'confirm-cancel': return state.confirmation?.pending ? state : focus(state, { confirmation: null })
    case 'platform': {
      const phase = action.snapshot.update.state
      const committed = phase === 'installing' || phase === 'rollback' ? phase : null
      return state.committed === committed ? state : { ...state, committed }
    }
  }
}

export function journeyBack(state: JourneyState): { state: JourneyState; effect: 'consumed' | 'locked' | 'exit' } {
  if (state.confirmation) {
    return state.confirmation.pending ? { state, effect: 'consumed' }
      : { state: focus(state, { confirmation: null }), effect: 'consumed' }
  }
  if (state.committed) return { state, effect: 'locked' }
  if (state.page === 'network' && state.networkReturn === 'setup') {
    return { state: focus(state, { page: 'setup', setupStage: 'network' }), effect: 'consumed' }
  }
  if (state.page === 'setup' && state.setupEntry === state.setupStage) {
    return { state: focus(state, { page: 'home', setupEntry: null }), effect: 'consumed' }
  }
  if (state.page === 'setup' && state.setupStage !== 'boot') {
    const index = setupStages.indexOf(state.setupStage)
    return { state: focus(state, { setupStage: setupStages[index - 1] }), effect: 'consumed' }
  }
  return state.page === 'home' ? { state, effect: 'exit' }
    : { state: focus(state, { page: 'home' }), effect: 'consumed' }
}

export function journeyInteractionLocked(state: JourneyState, busy: {
  preferences: boolean
  platform: boolean
  phones: boolean
  storage: boolean
  drive: boolean
}, snapshot: BoxPlatformSnapshot | null = null): boolean {
  return state.confirmation !== null || state.committed !== null ||
    snapshot?.update.state === 'installing' || snapshot?.update.state === 'rollback' ||
    busy.preferences || busy.platform || busy.phones || busy.storage || busy.drive
}

/** S18: starting Wi-Fi setup while a network is connected is a disruptive switch. */
export function wifiStartNeedsConfirmation(snapshot: BoxPlatformSnapshot | null): boolean {
  return snapshot?.network.state === 'connected'
}

export type SystemCommand = 'update-check' | 'update-stage' | 'update-install' | 'rollback' | 'reboot' | 'reset'
export type CommandIssue = 'platform-unavailable' | 'capability-unavailable' | 'playback-active' | 'committed' | 'invalid-state' | null
export function systemCommandIssue(command: SystemCommand, snapshot: BoxPlatformSnapshot | null, playing: boolean): CommandIssue {
  if (!snapshot?.available) return 'platform-unavailable'
  if (snapshot.update.state === 'installing' || snapshot.update.state === 'rollback') return 'committed'
  if (command === 'reboot' || command === 'reset') {
    if (!(command === 'reboot' ? snapshot.capabilities.reboot : snapshot.capabilities.reset)) return 'capability-unavailable'
    return playing ? 'playback-active' : null
  }
  if (!snapshot.capabilities.updates) return 'capability-unavailable'
  if (command === 'update-check') return ['checking', 'staging'].includes(snapshot.update.state) ? 'invalid-state' : null
  if (command === 'update-stage') return snapshot.update.state === 'available' ? null : 'invalid-state'
  if (command === 'update-install') {
    if (snapshot.update.state !== 'staged') return 'invalid-state'
    return playing ? 'playback-active' : null
  }
  return playing ? 'playback-active' : null
}
export function cacheRemovalIssue(dir: string, active: string | null, playing: boolean, requireIdle = false): 'active-project' | 'playback-active' | 'invalid-project' | null {
  if (!dir) return 'invalid-project'
  if (dir === active) return 'active-project'
  return requireIdle && playing ? 'playback-active' : null
}
export class RequestEpoch {
  private value = 0
  begin(): number { return ++this.value }
  current(token: number): boolean { return token === this.value }
  invalidate(): void { this.value++ }
}
export function validBackendUrl(raw?: string): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.toString() : null
  } catch { return null }
}
export function backendExpiry(expiresAt: number | undefined, now: number): { expired: boolean; seconds: number | null } {
  if (expiresAt === undefined || !Number.isFinite(expiresAt)) return { expired: false, seconds: null }
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return { expired: seconds === 0, seconds }
}
