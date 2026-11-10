import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult
} from '../../../shared/types'

export type SettingsPhase = 'idle' | 'applying' | 'awaiting-readback'

export type SettingsLocalError =
  | { kind: 'apply-failed'; message: string }
  | { kind: 'device-disconnected' }

export interface SettingsModelState {
  committedOutputUid: string | null
  draftOutputUid: string | null
  pendingOutputUid: string | null
  acceptedOutputUid: string | null
  phase: SettingsPhase
  error: SettingsLocalError | null
}

export type OutputApplyIssue =
  | 'unavailable'
  | 'pending'
  | 'loading'
  | 'no-outputs'
  | 'no-selection'
  | 'missing'
  | 'unchanged'

export type SettingsAction =
  | {
      type: 'sync'
      currentOutputUid: string | null
      outputUids: readonly string[] | null
    }
  | {
      type: 'select-output'
      uid: string
      outputs: readonly DesktopAudioHostDevice[]
      canApplyOutput: boolean
      loading: boolean
    }
  | {
      type: 'apply-started'
      outputs: readonly DesktopAudioHostDevice[]
      canApplyOutput: boolean
      loading: boolean
    }
  | { type: 'apply-resolved'; uid: string }
  | { type: 'apply-rejected'; uid: string; message: string }
  | { type: 'cancel'; outputUids: readonly string[] | null }

export function outputDevices(
  inventory: DesktopAudioHostInventoryResult | null
): DesktopAudioHostDevice[] {
  return inventory?.ok ? inventory.devices.filter(device => device.outputChannels > 0) : []
}

export function inputDevices(
  inventory: DesktopAudioHostInventoryResult | null
): DesktopAudioHostDevice[] {
  return inventory?.ok ? inventory.devices.filter(device => device.inputChannels > 0) : []
}

export function initialSettingsState(currentOutputUid: string | null): SettingsModelState {
  return {
    committedOutputUid: currentOutputUid,
    draftOutputUid: currentOutputUid,
    pendingOutputUid: null,
    acceptedOutputUid: null,
    phase: 'idle',
    error: null
  }
}

export function outputApplyIssue({
  uid,
  committedOutputUid,
  outputs,
  canApplyOutput,
  loading,
  pending
}: {
  uid: string | null
  committedOutputUid: string | null
  outputs: readonly DesktopAudioHostDevice[]
  canApplyOutput: boolean
  loading: boolean
  pending: boolean
}): OutputApplyIssue | null {
  if (!canApplyOutput) return 'unavailable'
  if (pending) return 'pending'
  if (loading) return 'loading'
  if (!outputs.some(device => device.outputChannels > 0)) return 'no-outputs'
  if (uid === null) return 'no-selection'
  if (!outputs.some(device => device.outputChannels > 0 && device.uid === uid)) return 'missing'
  if (uid === committedOutputUid) return 'unchanged'
  return null
}

function disconnectedError(
  draftOutputUid: string | null,
  outputUids: readonly string[] | null,
  error: SettingsLocalError | null
): SettingsLocalError | null {
  if (draftOutputUid !== null && outputUids !== null && !outputUids.includes(draftOutputUid)) {
    return { kind: 'device-disconnected' }
  }
  if (outputUids === null) return error
  return error?.kind === 'device-disconnected' ? null : error
}

export function settingsReducer(
  state: SettingsModelState,
  action: SettingsAction
): SettingsModelState {
  switch (action.type) {
    case 'sync': {
      if (state.pendingOutputUid !== null) {
        const requestedUid = state.pendingOutputUid
        const error = disconnectedError(state.draftOutputUid, action.outputUids, state.error)
        const disconnected = error?.kind === 'device-disconnected'
        const confirmed = action.currentOutputUid === requestedUid && !disconnected
        if (state.phase === 'awaiting-readback' && (confirmed || disconnected)) {
          return {
            committedOutputUid: action.currentOutputUid,
            draftOutputUid: requestedUid,
            pendingOutputUid: null,
            acceptedOutputUid: confirmed ? requestedUid : null,
            phase: 'idle',
            error
          }
        }
        return {
          ...state,
          committedOutputUid: action.currentOutputUid,
          acceptedOutputUid: !disconnected && state.acceptedOutputUid === action.currentOutputUid
            ? state.acceptedOutputUid
            : null,
          error
        }
      }

      const followsCommitted = state.draftOutputUid === state.committedOutputUid
      const draftOutputUid = followsCommitted ? action.currentOutputUid : state.draftOutputUid
      const currentChanged = action.currentOutputUid !== state.committedOutputUid
      const error = disconnectedError(
        draftOutputUid,
        action.outputUids,
        followsCommitted && currentChanged ? null : state.error
      )
      return {
        ...state,
        committedOutputUid: action.currentOutputUid,
        draftOutputUid,
        acceptedOutputUid: error?.kind === 'device-disconnected'
          ? null
          : state.acceptedOutputUid === action.currentOutputUid
            ? state.acceptedOutputUid
            : null,
        error
      }
    }

    case 'select-output': {
      if (
        state.pendingOutputUid !== null || action.loading || !action.canApplyOutput ||
        !action.outputs.some(device => device.outputChannels > 0 && device.uid === action.uid)
      ) return state
      return {
        ...state,
        draftOutputUid: action.uid,
        acceptedOutputUid: action.uid === state.committedOutputUid
          ? state.acceptedOutputUid
          : null,
        error: null
      }
    }

    case 'apply-started': {
      const issue = outputApplyIssue({
        uid: state.draftOutputUid,
        committedOutputUid: state.committedOutputUid,
        outputs: action.outputs,
        canApplyOutput: action.canApplyOutput,
        loading: action.loading,
        pending: state.pendingOutputUid !== null
      })
      if (issue !== null || state.draftOutputUid === null) return state
      return {
        ...state,
        pendingOutputUid: state.draftOutputUid,
        acceptedOutputUid: null,
        phase: 'applying',
        error: null
      }
    }

    case 'apply-resolved': {
      if (state.pendingOutputUid !== action.uid) return state
      const disconnected = state.error?.kind === 'device-disconnected'
      if (state.committedOutputUid === action.uid || disconnected) {
        return {
          ...state,
          draftOutputUid: action.uid,
          pendingOutputUid: null,
          acceptedOutputUid: state.committedOutputUid === action.uid && !disconnected ? action.uid : null,
          phase: 'idle',
          error: disconnected ? state.error : null
        }
      }
      return { ...state, phase: 'awaiting-readback' }
    }

    case 'apply-rejected': {
      if (state.pendingOutputUid !== action.uid) return state
      return {
        ...state,
        pendingOutputUid: null,
        acceptedOutputUid: null,
        phase: 'idle',
        error: { kind: 'apply-failed', message: action.message }
      }
    }

    case 'cancel': {
      if (state.pendingOutputUid !== null) return state
      const previousDisconnection = state.error?.kind === 'device-disconnected' ? state.error : null
      const error = disconnectedError(state.committedOutputUid, action.outputUids, previousDisconnection)
      return {
        ...state,
        draftOutputUid: state.committedOutputUid,
        acceptedOutputUid: error?.kind !== 'device-disconnected' &&
          state.acceptedOutputUid === state.committedOutputUid
          ? state.acceptedOutputUid
          : null,
        phase: 'idle',
        error
      }
    }
  }
}

export function formatSampleRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return '—'
  const khz = Math.round(hz / 10) / 100
  return `${khz} kHz`
}

export function formatSampleRateRanges(device: DesktopAudioHostDevice): string {
  const ranges = device.sampleRateRanges.filter(range =>
    Number.isFinite(range.minimumHz) && Number.isFinite(range.maximumHz) &&
    range.minimumHz > 0 && range.maximumHz >= range.minimumHz
  )
  if (ranges.length === 0) return '—'
  return ranges.map(range => range.minimumHz === range.maximumHz
    ? formatSampleRate(range.minimumHz)
    : `${formatSampleRate(range.minimumHz)} – ${formatSampleRate(range.maximumHz)}`
  ).join(', ')
}
