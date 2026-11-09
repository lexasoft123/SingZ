import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { BoxPhoneState, BoxResult } from '../../shared/box-contract'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_PENDING = 16
const MAX_PENDING_PER_ADDRESS = 2
const MAX_SESSIONS = 8
const MAX_NONCES_PER_ADDRESS = 8
const MAX_NONCE_ADDRESSES = 64
const MAX_UNAUTHENTICATED_RATE_KEYS = 512
const NONCE_TTL_MS = 10 * 60_000
// Long enough for a polling page (~1 s cadence) to read a denial, short enough
// that settled requests never hold pairing capacity.
const SETTLED_RETENTION_MS = 30_000
const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
const secret = (): string => randomBytes(32).toString('base64url')
const equal = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
// Invisible format characters (bidi overrides/isolates, zero-width, line
// separators) would let a guest disguise their name on the TV approval list.
const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g
export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null
  const name = value.replace(INVISIBLE, '').trim()
  return name.length > 0 && name.length <= 80 ? name : null
}
export function normalizeAddress(address: string | undefined): string {
  if (!address) return 'unknown'
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address) ? address.slice(7) : address
}
type RequestRecord = {
  requestId: string
  pollSecret: string
  name: string
  clientNonce: string
  address: string
  status: 'pending' | 'denied' | 'approved'
  expiresAt: number
  cleanupAt: number
  sessionId?: string
  delivered?: boolean
}
export type PhoneSession = {
  sessionId: string
  name: string
  token: string
  clientNonce: string
  address: string
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
export type BoxPhoneRateKind = 'page' | 'pair' | 'command'

class RateLimiter {
  private readonly buckets = new Map<string, { expiresAt: number; count: number }>()
  constructor(private readonly cap: number) {}
  allow(key: string, limit: number, windowMs: number, now: number): boolean {
    for (const [id, bucket] of this.buckets) if (bucket.expiresAt <= now) this.buckets.delete(id)
    const bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= this.cap) return false
      this.buckets.set(key, { expiresAt: now + windowMs, count: 1 })
      return limit >= 1
    }
    bucket.count++
    return bucket.count <= limit
  }
  clear(): void { this.buckets.clear() }
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
  // Nonces are bound to the address that loaded the page, with per-address
  // eviction, so one host's page reloads cannot evict another phone's nonce.
  private readonly nonces = new Map<string, Map<string, number>>()
  // Unauthenticated limiters never share capacity with authenticated sessions.
  private readonly rates: Record<BoxPhoneRateKind, RateLimiter> = {
    page: new RateLimiter(MAX_UNAUTHENTICATED_RATE_KEYS),
    pair: new RateLimiter(MAX_UNAUTHENTICATED_RATE_KEYS),
    command: new RateLimiter(Number.POSITIVE_INFINITY)
  }
  constructor(options: BoxPhoneSessionOptions = {}) {
    this.now = options.now ?? Date.now
    this.invitationTtlMs = options.invitationTtlMs ?? 5 * 60_000
    this.pendingTtlMs = options.pendingTtlMs ?? 2 * 60_000
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000
  }
  start(baseUrl: string): void {
    if (!this.running) this.clear()
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
    this.clear()
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
  issueNonce(address: string): string {
    const now = this.now()
    const own = this.nonces.get(address) ?? new Map<string, number>()
    this.nonces.delete(address)
    for (const [nonce, expiry] of own) if (expiry <= now) own.delete(nonce)
    const nonce = secret()
    own.set(nonce, now + NONCE_TTL_MS)
    while (own.size > MAX_NONCES_PER_ADDRESS) own.delete(own.keys().next().value as string)
    this.nonces.set(address, own)
    while (this.nonces.size > MAX_NONCE_ADDRESSES) this.nonces.delete(this.nonces.keys().next().value as string)
    return nonce
  }
  validNonce(nonce: string, address: string): boolean {
    return this.running && (this.nonces.get(address)?.get(nonce) ?? 0) > this.now()
  }
  pair(
    invitation: unknown, name: unknown, clientNonce: string, address: string
  ): BoxResult<{ requestId: string; pollSecret: string; expiresAt: number }> {
    this.prune()
    if (!this.running || !this.invitation || typeof invitation !== 'string') return failure('Pairing is unavailable.', 'unavailable')
    if (this.invitation.expiresAt <= this.now() || !equal(invitation, this.invitation.code)) {
      return failure('The invitation is invalid or expired.', 'pairing-failed')
    }
    const displayName = cleanDisplayName(name)
    if (!displayName || !this.validNonce(clientNonce, address)) return failure('The pairing request is invalid.', 'invalid-input')
    const pending = [...this.requests.values()].filter((item) => item.status === 'pending')
    if (pending.length >= MAX_PENDING || pending.filter((item) => item.address === address).length >= MAX_PENDING_PER_ADDRESS) {
      return failure('Too many phones are waiting for approval.', 'rate-limited')
    }
    const requestId = randomUUID()
    const pollSecret = secret()
    const expiresAt = this.now() + this.pendingTtlMs
    this.requests.set(requestId, {
      requestId, pollSecret, name: displayName, clientNonce, address, status: 'pending', expiresAt,
      cleanupAt: expiresAt + SETTLED_RETENTION_MS
    })
    return { ok: true, value: { requestId, pollSecret, expiresAt } }
  }
  pairStatus(requestId: unknown, pollSecret: unknown, address: string): BoxResult<PairStatus> {
    this.prune()
    if (typeof requestId !== 'string' || typeof pollSecret !== 'string') return failure('Pair polling is unauthorized.', 'unauthorized')
    const request = this.requests.get(requestId)
    if (!request || !equal(pollSecret, request.pollSecret) || request.address !== address) {
      return failure('Pair polling is unauthorized.', 'unauthorized')
    }
    if (request.status === 'pending') return { ok: true, value: { status: 'pending', expiresAt: request.expiresAt } }
    if (request.status === 'denied') return { ok: true, value: { status: 'denied', error: 'The TV denied or expired this pairing request.' } }
    const session = request.sessionId ? this.sessions.get(request.sessionId) : undefined
    if (!session || session.expiresAt <= this.now()) {
      return { ok: true, value: { status: 'denied', error: 'The phone session is no longer authorized.' } }
    }
    // The token is re-deliverable to the same address and poll secret for a short
    // window after the first delivery, so a response lost on flaky Wi-Fi does not
    // force a re-pair; the record then retires and polling becomes unauthorized.
    if (!request.delivered) {
      request.delivered = true
      request.cleanupAt = this.now() + SETTLED_RETENTION_MS
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
      sessionId, name: request.name, token: secret(), clientNonce: request.clientNonce, address: request.address, expiresAt
    })
    request.status = 'approved'
    request.sessionId = sessionId
    request.cleanupAt = Math.min(expiresAt, this.now() + this.pendingTtlMs + SETTLED_RETENTION_MS)
    // Each approval retires the shown code; the TV renders the next one from
    // the returned state, so later guests scan a code earlier viewers lack.
    this.invitation = null
    this.renewInvitation()
    return { ok: true, value: this.state() }
  }
  deny(requestId: string): BoxResult<BoxPhoneState> {
    const request = this.requests.get(requestId)
    if (!request || request.status !== 'pending' || request.expiresAt <= this.now()) {
      return failure('The pairing request is denied, expired, or unknown.', 'invalid-request')
    }
    request.status = 'denied'
    request.cleanupAt = this.now() + SETTLED_RETENTION_MS
    return { ok: true, value: this.state() }
  }
  revoke(sessionId: string): BoxResult<BoxPhoneState> {
    if (!this.sessions.delete(sessionId)) return failure('The phone session is unknown or expired.', 'invalid-session')
    return { ok: true, value: this.state() }
  }
  authenticate(token: string, address: string): PhoneSession | null {
    this.prune()
    for (const session of this.sessions.values()) {
      if (session.expiresAt > this.now() && equal(token, session.token)) return session.address === address ? session : null
    }
    return null
  }
  validSession(sessionId: string): boolean {
    return this.running && (this.sessions.get(sessionId)?.expiresAt ?? 0) > this.now()
  }
  validSessionNonce(session: PhoneSession, nonce: string): boolean {
    return this.validSession(session.sessionId) && equal(nonce, session.clientNonce)
  }
  allow(kind: BoxPhoneRateKind, key: string, limit: number, windowMs: number): boolean {
    return this.rates[kind].allow(key, limit, windowMs, this.now())
  }
  private clear(): void {
    this.invitation = null
    this.requests.clear()
    this.sessions.clear()
    this.nonces.clear()
    for (const limiter of Object.values(this.rates)) limiter.clear()
  }
  private prune(): void {
    const now = this.now()
    for (const [id, request] of this.requests) {
      if (request.status === 'pending' && request.expiresAt <= now) {
        request.status = 'denied'
        request.cleanupAt = now + SETTLED_RETENTION_MS
      }
      if (request.cleanupAt <= now) this.requests.delete(id)
    }
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id)
    for (const [address, own] of this.nonces) {
      for (const [nonce, expiry] of own) if (expiry <= now) own.delete(nonce)
      if (own.size === 0) this.nonces.delete(address)
    }
  }
}
