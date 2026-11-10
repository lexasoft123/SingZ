import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DriveDeviceAuthorization, type DeviceOAuthConfig } from '../../src/main/gdrive-device-auth'
import type { DriveOAuthTokens } from '../../src/shared/drive-device'

const scope = 'https://www.googleapis.com/auth/drive.file'
const config: DeviceOAuthConfig = { clientId: 'tv-client', clientSecret: 'tv-secret', codeUrl: 'https://oauth.test/device/code', tokenUrl: 'https://oauth.test/token', verificationOrigin: 'https://verify.test' }
const code = { device_code: 'PRIVATE_DEVICE_CODE', user_code: 'WWWWWWWWWWWWWWW', verification_url: 'https://verify.test/device', expires_in: 120, interval: 5 }
const token = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope }
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
let saved: DriveOAuthTokens[]
let auth: DriveDeviceAuthorization
let requests: { at: number; url: string; body: URLSearchParams }[]
let replies: (() => Promise<Response>)[]

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(100000)
  saved = []; auth = new DriveDeviceAuthorization(t => saved.push(t)); requests = []; replies = []
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    requests.push({ at: Date.now(), url: String(url), body: new URLSearchParams(init.body) })
    const next = replies.shift(); if (!next) throw new Error('Unexpected request')
    return next()
  }))
})
afterEach(() => { auth.cancel(); vi.unstubAllGlobals(); vi.useRealTimers() })
const reply = (data: unknown, status = 200): void => { replies.push(async () => json(data, status)) }
async function start(): Promise<string> {
  reply(code)
  const result = await auth.start(config)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.code)
  expect(result.challenge.userCode).toBe(code.user_code)
  expect(result.challenge.verificationUrl).toBe(code.verification_url)
  expect(result.challenge.qrDataUrl).toMatch(/^data:image\/png;base64,/)
  expect(JSON.stringify(result)).not.toContain('PRIVATE_DEVICE_CODE')
  expect(JSON.stringify(result)).not.toContain('tv-secret')
  expect(JSON.stringify(auth.status(result.challenge.sessionId))).not.toContain('PRIVATE_DEVICE_CODE')
  return result.challenge.sessionId
}

describe('TV Google Drive device authorization', () => {
  it('keeps credentials private, respects pending and slow_down, and binds persisted tokens to the TV client', async () => {
    const id = await start()
    reply({ error: 'authorization_pending' }, 400); reply({ error: 'slow_down' }, 400); reply(token)
    await vi.advanceTimersByTimeAsync(4999); expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000); expect(requests).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(9999); expect(requests).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(requests.map(r => r.at)).toEqual([100000, 105000, 110000, 120000])
    expect(requests[0].body.get('scope')).toBe(scope)
    expect(requests[3].body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
    expect(requests[3].body.get('device_code')).toBe('PRIVATE_DEVICE_CODE')
    expect(saved).toEqual([{ access: 'access', refresh: 'refresh', expiresAt: 3660000, authMode: 'device', clientId: 'tv-client' }])
    expect(auth.status(id)).toEqual({ phase: 'complete' })
    await vi.advanceTimersByTimeAsync(120000); expect(requests).toHaveLength(4)
  })

  it('expires locally without another poll and leaves the previous sign-in intact', async () => {
    reply({ ...code, expires_in: 3 })
    const r = await auth.start(config); if (!r.ok) throw new Error(r.code)
    await vi.advanceTimersByTimeAsync(3000)
    expect(auth.status(r.challenge.sessionId)).toEqual({ phase: 'expired', code: 'expired' })
    expect(requests).toHaveLength(1); expect(saved).toEqual([])
  })

  it.each([['access_denied', 'denied'], ['expired_token', 'expired'], ['invalid_client', 'invalid-client']])('ends cleanly on %s', async (error, expected) => {
    const id = await start(); reply({ error }, 400)
    await vi.advanceTimersByTimeAsync(5000)
    expect(auth.status(id).code).toBe(expected); expect(saved).toEqual([])
  })

  it('cancels while the initial code request is still in flight', async () => {
    let resolve!: (value: Response) => void
    replies.push(() => new Promise(r => { resolve = r }))
    const pending = auth.start(config)
    auth.cancel()
    resolve(json(code))
    expect(await pending).toEqual({ ok: false, code: 'cancelled' })
    await vi.advanceTimersByTimeAsync(10000)
    expect(requests).toHaveLength(1); expect(saved).toEqual([])
  })

  it('never persists an in-flight response after cancellation', async () => {
    const id = await start(); let resolve!: (value: Response) => void
    replies.push(() => new Promise(r => { resolve = r }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(auth.cancel(id)).toBe(true)
    resolve(json(token)); await vi.advanceTimersByTimeAsync(0)
    expect(auth.status(id)).toEqual({ phase: 'cancelled', code: 'cancelled' }); expect(saved).toEqual([])
  })

  it('supersedes an old request and ignores cancellation from its obsolete dialog', async () => {
    const old = await start(); const next = await start()
    expect(auth.cancel(old)).toBe(false)
    reply(token); await vi.advanceTimersByTimeAsync(5000)
    expect(saved).toHaveLength(1); expect(auth.status(next).phase).toBe('complete')
  })

  it('backs off on network failures without abandoning a still-valid code', async () => {
    const id = await start(); replies.push(async () => { throw new Error('offline') }); reply(token)
    await vi.advanceTimersByTimeAsync(14999); expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1); expect(auth.status(id).phase).toBe('complete')
  })

  it('does not count an incomplete or narrower token grant as approval', async () => {
    const id = await start(); reply({ ...token, scope: 'openid' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(auth.status(id)).toEqual({ phase: 'error', code: 'invalid-response' }); expect(saved).toEqual([])
  })

  it('refuses an untrusted verification URL before drawing its QR code', async () => {
    reply({ ...code, verification_url: 'https://evil.test/device' })
    expect(await auth.start(config)).toEqual({ ok: false, code: 'invalid-response' })
    expect(requests).toHaveLength(1); expect(saved).toEqual([])
  })

  it('reports a failed durable save without claiming the user is connected', async () => {
    auth = new DriveDeviceAuthorization(() => { throw new Error('disk full') })
    const id = await start(); reply(token); await vi.advanceTimersByTimeAsync(5000)
    expect(auth.status(id)).toEqual({ phase: 'error', code: 'save-failed' })
  })
})
