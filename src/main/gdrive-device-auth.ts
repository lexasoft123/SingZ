import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import type { DriveDeviceChallenge, DriveDeviceFailure, DriveDeviceStart, DriveDeviceStatus, DriveOAuthTokens } from '../shared/drive-device'

export interface DeviceOAuthConfig {
  clientId: string
  clientSecret: string
  codeUrl: string
  tokenUrl: string
  /** Production accepts Google HTTPS URLs only. Tests explicitly inject their mock origin. */
  verificationOrigin?: string
}
interface Session {
  id: string
  abort: AbortController
  state: DriveDeviceStatus
  expiresAt: number
}
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

/** One pending device authorization. Never log server responses: they contain credentials. */
export class DriveDeviceAuthorization {
  private session: Session | null = null
  constructor(private readonly persist: (tokens: DriveOAuthTokens) => void) {}

  status(id: string): DriveDeviceStatus {
    const session = this.session
    if (!session || session.id !== id) return { phase: 'error', code: 'unknown-session' }
    if (session.state.phase === 'pending' && Date.now() >= session.expiresAt) this.finish(session, 'expired')
    return { ...session.state }
  }

  cancel(id?: string): boolean {
    const session = this.session
    if (!session || (id && id !== session.id)) return false
    if (session.state.phase === 'pending') this.finish(session, 'cancelled')
    return true
  }

  private finish(session: Session, code: DriveDeviceFailure): void {
    session.state = { phase: code === 'cancelled' ? 'cancelled' : code === 'expired' ? 'expired' : 'error', code }
    session.abort.abort()
  }
  private current(session: Session): boolean {
    return this.session === session && !session.abort.signal.aborted
  }

  async start(config: DeviceOAuthConfig): Promise<DriveDeviceStart> {
    this.cancel()
    const session: Session = { id: randomUUID(), abort: new AbortController(), state: { phase: 'pending' }, expiresAt: Date.now() + 30_000 }
    this.session = session
    try {
      const res = await fetch(config.codeUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, scope: SCOPE }),
        signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(30_000)])
      })
      const data = await res.json() as Record<string, unknown>
      if (!this.current(session)) return { ok: false, code: 'cancelled' }
      if (!res.ok) {
        const code = data.error === 'invalid_client' || data.error === 'unauthorized_client' ? 'invalid-client' : 'network'
        this.finish(session, code); return { ok: false, code }
      }
      const { device_code: deviceCode, user_code: userCode, verification_url: verificationUrl, expires_in: expires, interval } = data
      const seconds = Number(expires)
      const period = interval === undefined ? 5 : Number(interval)
      if (typeof deviceCode !== 'string' || !deviceCode || typeof userCode !== 'string' ||
          !/^[\x20-\x7e]{1,64}$/.test(userCode) || typeof verificationUrl !== 'string' || verificationUrl.length > 2048 ||
          !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400 || !Number.isFinite(period) || period <= 0 || period > 3600) {
        this.finish(session, 'invalid-response'); return { ok: false, code: 'invalid-response' }
      }
      const url = new URL(verificationUrl)
      const allowed = config.verificationOrigin ? url.origin === config.verificationOrigin :
        url.protocol === 'https:' && ['www.google.com', 'accounts.google.com', 'google.com'].includes(url.hostname)
      if (!allowed || url.username || url.password || url.hash) {
        this.finish(session, 'invalid-response'); return { ok: false, code: 'invalid-response' }
      }
      session.expiresAt = Date.now() + seconds * 1000
      // Encode the exact verification URL; Google requires the displayed URL/code to remain unchanged.
      const qrDataUrl = await QRCode.toDataURL(verificationUrl, { width: 360, margin: 4, errorCorrectionLevel: 'M' })
      if (!this.current(session)) return { ok: false, code: 'cancelled' }
      const challenge: DriveDeviceChallenge = { sessionId: session.id, userCode, verificationUrl, qrDataUrl, expiresAt: session.expiresAt }
      void this.poll(session, config, deviceCode, period * 1000)
      return { ok: true, challenge }
    } catch {
      if (!this.current(session)) return { ok: false, code: session.state.code ?? 'cancelled' }
      this.finish(session, 'network'); return { ok: false, code: 'network' }
    }
  }

  private wait(session: Session, ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(timer); session.abort.signal.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, ms); timer.unref?.()
      session.abort.signal.addEventListener('abort', done, { once: true })
    })
  }

  private async poll(session: Session, config: DeviceOAuthConfig, deviceCode: string, initialInterval: number): Promise<void> {
    let interval = initialInterval
    let retryDelay = interval
    while (this.current(session)) {
      const remaining = session.expiresAt - Date.now()
      if (remaining <= 0) { this.finish(session, 'expired'); return }
      await this.wait(session, Math.min(retryDelay, remaining))
      if (!this.current(session)) return
      if (Date.now() >= session.expiresAt) { this.finish(session, 'expired'); return }
      try {
        const res = await fetch(config.tokenUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
          signal: AbortSignal.any([session.abort.signal, AbortSignal.timeout(Math.max(1, Math.floor(Math.min(30_000, session.expiresAt - Date.now()))))])
        })
        const data = await res.json() as Record<string, unknown>
        if (!this.current(session)) return
        if (Date.now() >= session.expiresAt) { this.finish(session, 'expired'); return }
        if (res.ok) {
          if (typeof data.access_token !== 'string' || !data.access_token || typeof data.refresh_token !== 'string' || !data.refresh_token ||
              !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0 ||
              typeof data.scope !== 'string' || !data.scope.split(/\s+/).includes(SCOPE)) {
            this.finish(session, 'invalid-response'); return
          }
          try {
            this.persist({ access: data.access_token, refresh: data.refresh_token, expiresAt: Date.now() + Math.max(0, Number(data.expires_in) * 1000 - 60_000), authMode: 'device', clientId: config.clientId })
            session.state = { phase: 'complete' }
          } catch { this.finish(session, 'save-failed') }
          return
        }
        if (data.error === 'authorization_pending') { retryDelay = interval; continue }
        if (data.error === 'slow_down') { interval += 5000; retryDelay = interval; continue }
        if (res.status === 429 || res.status >= 500) { retryDelay = Math.max(interval, Math.min(60_000, retryDelay * 2)); continue }
        const code: DriveDeviceFailure = data.error === 'access_denied' ? 'denied' : data.error === 'expired_token' ? 'expired' : 'invalid-client'
        this.finish(session, code); return
      } catch {
        if (!this.current(session)) return
        retryDelay = Math.max(interval, Math.min(60_000, retryDelay * 2))
      }
    }
  }
}
