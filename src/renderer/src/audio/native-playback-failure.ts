import type { DesktopPlaybackErrorCode } from '../../../shared/types'
import { t } from '../i18n'

/** Preserve bridge codes rather than guessing a cause from diagnostic text. */
export type DesktopNativePlaybackFailureCode = Exclude<DesktopPlaybackErrorCode, 'none'>
  | 'addon-unavailable' | 'provider-unavailable' | 'no-device' | 'device-lost'
  | 'route-rejected' | 'graph-rejected' | 'recovery-required'
  | 'invalid-argument' | 'prepare-failed' | 'permission' | 'route-refused' | 'format-unreadable'
  | 'not-compiled' | 'runtime-unavailable' | 'wrong-platform'
  | 'io-error' | 'unsupported-format' | 'malformed-data' | 'unknown'

export interface DesktopNativePlaybackFailure {
  code: DesktopNativePlaybackFailureCode
  detail: string
  laneId?: string
  format?: string
}

/** Exhaustive over the shared desktop bridge union, including main-only errors. */
export const NATIVE_PLAYBACK_FAILURE_KEYS = {
  'addon-unavailable': 'player.failure.addon',
  'provider-unavailable': 'player.failure.provider',
  'no-device': 'player.failure.noDevice',
  'device-lost': 'player.failure.deviceLost',
  'route-rejected': 'player.failure.route',
  'graph-rejected': 'player.failure.graph',
  'recovery-required': 'player.failure.recovery',
  'invalid-generation': 'player.failure.generation',
  'invalid-state': 'player.failure.state',
  'invalid-configuration': 'player.failure.configuration',
  'invalid-argument': 'player.failure.argument',
  'cancelled': 'player.failure.cancelled',
  'decode-failure': 'player.failure.decode',
  'limit-exceeded': 'player.failure.limit',
  'resource-exhausted': 'player.failure.resources',
  'graph-failure': 'player.failure.graphFailure',
  'host-failure': 'player.failure.host',
  'provider-failure': 'player.failure.providerFailure',
  'queue-full': 'player.failure.queue',
  'teardown-uncertain': 'player.failure.teardown',
  'unsupported-playback-rate': 'player.failure.rate',
  'native-audio-busy': 'player.failure.busy',
  'platform-not-ready': 'player.failure.platform',
  'unauthorized-path': 'player.failure.path',
  'path-too-long': 'player.failure.pathLength',
  'prepare-failed': 'player.failure.prepare',
  'permission': 'player.failure.permission',
  'route-refused': 'player.failure.routeRefused',
  'format-unreadable': 'player.failure.format',
  'not-compiled': 'player.failure.provider',
  'runtime-unavailable': 'player.failure.provider',
  'wrong-platform': 'player.failure.platform',
  'io-error': 'player.failure.format',
  'unsupported-format': 'player.failure.format',
  'malformed-data': 'player.failure.decode',
  'unknown': 'player.failure.prepare'
} as const satisfies Record<DesktopNativePlaybackFailureCode, string>

export function nativePlaybackFailureCopy(failure: DesktopNativePlaybackFailure): string {
  return t(NATIVE_PLAYBACK_FAILURE_KEYS[failure.code])
}
