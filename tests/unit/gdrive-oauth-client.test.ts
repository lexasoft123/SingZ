import { describe, expect, it } from 'vitest'
import { driveTokenClient } from '../../src/main/gdrive-oauth-client'
import type { DriveOAuthTokens } from '../../src/shared/drive-device'
const cfg = { clientId: 'desktop', clientSecret: 'desktop-secret', tvClientId: 'tv', tvClientSecret: 'tv-secret' }
const old: DriveOAuthTokens = { access: 'access', refresh: 'refresh', expiresAt: 0 }
describe('Google Drive refresh client identity', () => {
  it('preserves existing Desktop sessions without a new sign-in', () => {
    expect(driveTokenClient(old, cfg)).toEqual({ clientId: 'desktop', clientSecret: 'desktop-secret' })
  })
  it('refreshes a TV grant with its TV credentials, never the Desktop credentials', () => {
    expect(driveTokenClient({ ...old, authMode: 'device', clientId: 'tv' }, cfg)).toEqual({ clientId: 'tv', clientSecret: 'tv-secret' })
  })
  it('refuses to send a refresh token to a replaced or missing client', () => {
    expect(() => driveTokenClient({ ...old, authMode: 'device', clientId: 'other-tv' }, cfg)).toThrow('client changed')
    expect(() => driveTokenClient({ ...old, authMode: 'device' }, cfg)).toThrow('client changed')
    expect(() => driveTokenClient({ ...old, authMode: 'device', clientId: 'tv' }, { clientId: 'desktop' })).toThrow('client changed')
    expect(() => driveTokenClient({ ...old, authMode: 'browser', clientId: 'other-desktop' }, cfg)).toThrow('client changed')
  })
})
