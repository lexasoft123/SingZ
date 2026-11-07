import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { BoxPhoneState, BoxResult } from '../../shared/box-contract'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_PENDING = 16
const MAX_SESSIONS = 8
const MAX_REQUESTS = 64
const MAX_NONCES = 256
const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
const secret = (): string => randomBytes(32).toString('base64url')
const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
const validName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 &&
  !/[\u0000-\u001f\u007f]/.test(value)
type RequestRecord = {
  requestId: string
  pollSecret: string
  name: string
  clientNonce: string
  status: 'pending' | 'denied' | 'approved'
  expiresAt: number
  cleanupAt: number
  sessionId?: string
}
export type PhoneSession = {
  sessionId: string
  name: string
  token: string
  clientNonce: string
  expiresAt: number
}
type PairStatus =
  | { status: 'pending'; expiresAt: number }
  | { status: 'denied'; error: string }
  | { status: 'approved'; sessionToken: string; expiresAt: number }
export type BoxPhoneSessionOptions = {
  now?: () => number
  invitationTtlMs?: number
  pendingTtlMs?: number
  sessionTtlMs?: number
}
export class BoxPhoneSessions {
  private readonly now: () => number
  private readonly invitationTtlMs: number
  private readonly pendingTtlMs: number
  private readonly sessionTtlMs: number
  private running = false
  private baseUrl = ''
  private invitation: { code: string; expiresAt: number } | null = null
  private readonly requests = new Map<string, RequestRecord>()
  private readonly sessions = new Map<string, PhoneSession>()
  private readonly nonces = new Map<string, number>()
  private readonly rates = new Map<string, { expiresAt: number; count: number }>()
  constructor(options: BoxPhoneSessionOptions = {}) {
    this.now = options.now ?? Date.now
    this.invitationTtlMs = options.invitationTtlMs ?? 5 * 60_000
    this.pendingTtlMs = options.pendingTtlMs ?? 2 * 60_000
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000
  }
  start(baseUrl: string): void {
    if (!this.running) {
      this.requests.clear()
      this.sessions.clear()
      this.nonces.clear()
      this.rates.clear()
      this.invitation = null
    }
    this.running = true
    this.baseUrl = baseUrl
    this.renewInvitation()
  }
  renewInvitation(): void {
    if (this.invitation && this.invitation.expiresAt > this.now()) return
    const bytes = randomBytes(8)
    const code = Array.from(bytes, (byte) => ALPHABET[byte & 31]).join('')
    this.invitation = { code, expiresAt: this.now() + this.invitationTtlMs }
  }
  stop(): void {
    this.running = false
    this.baseUrl = ''
    this.invitation = null
    this.requests.clear()
    this.sessions.clear()
    this.nonces.clear()
    this.rates.clear()
  }
  state(): BoxPhoneState {
    this.prune()
    if (!this.running || !this.invitation) {
      return { running: false, pending: [], sessions: [], reason: 'Phone controller is stopped.' }
    }
    return {
      running: true,
      url: `${this.baseUrl}/#${this.invitation.code}`,
      code: this.invitation.code,
      expiresAt: this.invitation.expiresAt,
      pending: [...this.requests.values()].filter((item) => item.status === 'pending').map((item) => ({
        requestId: item.requestId, name: item.name, expiresAt: item.expiresAt
      })),
      sessions: [...this.sessions.values()].map((item) => ({
        sessionId: item.sessionId, name: item.name, expiresAt: item.expiresAt
      })),
      ...(this.invitation.expiresAt <= this.now() ? { reason: 'The invitation expired; start pairing again.' } : {})
    }
  }
  issueNonce(): string {
    this.prune()
    const nonce = secret()
    this.nonces.set(nonce, this.now() + 10 * 60_000)
    while (this.nonces.size > MAX_NONCES) this.nonces.delete(this.nonces.keys().next().value as string)
    return nonce
  }
  validNonce(nonce: string): boolean {
    return this.running && (this.nonces.get(nonce) ?? 0) > this.now()
  }
  pair(invitation: unknown, name: unknown, clientNonce: string): BoxResult<{ requestId: string; pollSecret: string; expiresAt: number }> {
    this.prune()
    if (!this.running || !this.invitation || typeof invitation !== 'string') return failure('Pairing is unavailable.', 'unavailable')
    if (this.invitation.expiresAt <= this.now() || !equal(invitation, this.invitation.code)) {
      return failure('The invitation is invalid or expired.', 'pairing-failed')
    }
    if (!validName(name) || !this.validNonce(clientNonce)) return failure('The pairing request is invalid.', 'invalid-input')
    const pending = [...this.requests.values()].filter((item) => item.status === 'pending').length
    if (pending >= MAX_PENDING || this.requests.size >= MAX_REQUESTS) return failure('Too many phones are waiting for approval.', 'rate-limited')
    const requestId = randomUUID()
    const pollSecret = secret()
    const expiresAt = this.now() + this.pendingTtlMs
    this.requests.set(requestId, {
      requestId, pollSecret, name: name.trim(), clientNonce, status: 'pending', expiresAt,
      cleanupAt: expiresAt + 5 * 60_000
    })
    return { ok: true, value: { requestId, pollSecret, expiresAt } }
  }
  pairStatus(requestId: unknown, pollSecret: unknown): BoxResult<PairStatus> {
    this.prune()
    if (typeof requestId !== 'string' || typeof pollSecret !== 'string') return failure('Pair polling is unauthorized.', 'unauthorized')
    const request = this.requests.get(requestId)
    if (!request || !equal(pollSecret, request.pollSecret)) return failure('Pair polling is unauthorized.', 'unauthorized')
    if (request.status === 'pending') return { ok: true, value: { status: 'pending', expiresAt: request.expiresAt } }
    if (request.status === 'denied') return { ok: true, value: { status: 'denied', error: 'The TV denied or expired this pairing request.' } }
    const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined
    if (!session || session.expiresAt <= this.now()) {
      return { ok: true, value: { status: 'denied', error: 'The phone session is no longer authorized.' } }
    }
    return { ok: true, value: { status: 'approved', sessionToken: session.token, expiresAt: session.expiresAt } }
  }
  approve(requestId: string): BoxResult<BoxPhoneState> {
    this.prune()
    const request = this.requests.get(requestId)
    if (!request || request.status !== 'pending' || request.expiresAt <= this.now()) {
      return failure('The pairing request is denied, expired, or unknown.', 'invalid-request')
    }
    if (this.sessions.size >= MAX_SESSIONS) return failure('The phone session limit is reached.', 'session-limit')
    const sessionId = randomUUID()
    const expiresAt = this.now() + this.sessionTtlMs
    this.sessions.set(sessionId, {
      sessionId, name: request.name, token: secret(), clientNonce: request.clientNonce, expiresAt
    })
    request.status = 'approved'
    request.sessionId = sessionId
    request.cleanupAt = expiresAt + 5 * 60_000
    return { ok: true, value: this.state() }
  }
  deny(requestId: string): BoxResult<BoxPhoneState> {
    const request = this.requests.get(requestId)
    if (!request || request.status !== 'pending' || request.expiresAt <= this.now()) {
      return failure('The pairing request is denied, expired, or unknown.', 'invalid-request')
    }
    request.status = 'denied'
    request.cleanupAt = this.now() + 5 * 60_000
    return { ok: true, value: this.state() }
  }
  revoke(sessionId: string): BoxResult<BoxPhoneState> {
    if (!this.sessions.delete(sessionId)) return failure('The phone session is unknown or expired.', 'invalid-session')
    return { ok: true, value: this.state() }
  }
  authenticate(token: string): PhoneSession | null {
    this.prune()
    for (const session of this.sessions.values()) {
      if (session.expiresAt > this.now() && equal(token, session.token)) return session
    }
    return null
  }
  validSession(sessionId: string): boolean {
    return this.running && (this.sessions.get(sessionId)?.expiresAt ?? 0) > this.now()
  }
  validSessionNonce(session: PhoneSession, nonce: string): boolean {
    return this.validSession(session.sessionId) && equal(nonce, session.clientNonce)
  }
  allow(key: string, limit: number, windowMs: number): boolean {
    const now = this.now()
    for (const [id, bucket] of this.rates) if (bucket.expiresAt <= now) this.rates.delete(id)
    const bucket = this.rates.get(key)
    if (!bucket) {
      if (this.rates.size >= 512) return false
      this.rates.set(key, { expiresAt: now + windowMs, count: 1 })
      return true
    }
    bucket.count++
    return bucket.count <= limit
  }
  private prune(): void {
    const now = this.now()
    for (const [id, request] of this.requests) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'denied'
        request.cleanupAt = now + 5 * 60_000
      }
      if (request.cleanupAt <= now) this.requests.delete(id)
    }
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id)
    for (const [nonce, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(nonce)
  }
}
