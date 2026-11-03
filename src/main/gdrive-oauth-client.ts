import type { DriveOAuthTokens } from '../shared/drive-device'
export interface DriveClientConfig { clientId?: string; clientSecret?: string; tvClientId?: string; tvClientSecret?: string }

/** Legacy tokens belong to Desktop. A device grant must name its issuing TV client. */
export function driveTokenClient(tokens: DriveOAuthTokens, config: DriveClientConfig | null): { clientId: string; clientSecret: string } {
  if (tokens.authMode !== undefined && tokens.authMode !== 'browser' && tokens.authMode !== 'device') throw new Error('Unknown Google Drive sign-in type — connect again')
  const device = tokens.authMode === 'device'
  const clientId = device ? config?.tvClientId : config?.clientId
  const clientSecret = device ? config?.tvClientSecret : config?.clientSecret
  if (!clientId || (device && (!clientSecret || tokens.clientId !== clientId)) || (tokens.clientId && tokens.clientId !== clientId)) {
    throw new Error('Google Drive client changed — connect again')
  }
  return { clientId, clientSecret: clientSecret ?? '' }
}
