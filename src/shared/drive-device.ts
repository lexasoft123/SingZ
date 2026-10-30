/** Public sign-in state. Device codes, OAuth credentials and tokens never cross IPC. */
export type DriveDeviceFailure = 'not-configured' | 'invalid-client' | 'denied' | 'expired' |
  'network' | 'invalid-response' | 'cancelled' | 'save-failed' | 'unknown-session'
export interface DriveDeviceChallenge {
  sessionId: string
  userCode: string
  verificationUrl: string
  qrDataUrl: string
  expiresAt: number
}
export type DriveDeviceStart = { ok: true; challenge: DriveDeviceChallenge } |
  { ok: false; code: DriveDeviceFailure }
export type DriveDeviceStatus = { phase: 'pending' | 'complete' | 'cancelled' | 'expired' | 'error'; code?: DriveDeviceFailure }
export interface DriveOAuthTokens {
  access: string
  refresh: string
  expiresAt: number
  authMode?: 'browser' | 'device'
  clientId?: string
}
