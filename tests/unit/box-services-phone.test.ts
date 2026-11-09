import { afterEach, describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { BoxControllerHub } from '../../src/main/box/controller'
import { BoxPhoneService, MAX_PHONE_CONNECTIONS_PER_ADDRESS, type BoxPhoneOptions } from '../../src/main/box/phone'
import type { BoxControllerEnvelope, BoxControllerPublish } from '../../src/shared/box-contract'

const fixtures: Array<{ phone: BoxPhoneService; hub: BoxControllerHub }> = []
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const publish: BoxControllerPublish = {
  activeProjectId: 'song1',
  transport: { playing: false, position: 4, duration: 120, masterVolume: 2 },
  songs: [{ id: 'song1', title: 'Song', artist: 'Artist', ready: true }],
  queue: [{ entryId: 'entry1', projectId: 'song1', title: 'Song', artist: 'Artist' }],
  stems: [{ id: 'vocals', label: 'Vocals', volume: 0.8, muted: false, solo: false }],
  activeLocalProjectDir: '/private/source/active-project',
  openingLocalProjectDir: '/private/source/opening-project'
}
async function fixture(commandTimeoutMs = 1000, extra: Partial<BoxPhoneOptions> = {}) {
  const hub = new BoxControllerHub({ commandTimeoutMs })
  expect(hub.publish(publish).ok).toBe(true)
  const envelopes: BoxControllerEnvelope[] = []
  hub.setCommandSender((envelope) => envelopes.push(envelope))
  let now = 1_000_000
  const phone = new BoxPhoneService({
    controller: hub, host: '127.0.0.1', port: 0,
    now: () => now, pendingTtlMs: 1000, sessionTtlMs: 1000, ...extra
  })
  fixtures.push({ phone, hub })
  const started = await phone.start()
  expect(started.ok).toBe(true)
  if (!started.ok) throw new Error('Phone did not start')
  const base = new URL(started.value.url as string).origin
  return { phone, hub, envelopes, base, code: started.value.code as string, advance: (ms: number): void => { now += ms } }
}
async function waitFor(envelopes: BoxControllerEnvelope[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && envelopes.length < count; attempt++) await delay(5)
  expect(envelopes.length).toBeGreaterThanOrEqual(count)
}
async function post(
  base: string,
  path: string,
  body: string | unknown,
  options: { nonce?: string; token?: string; origin?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: options.origin ?? base,
    ...options.headers
  }
  if (options.nonce) headers['X-SingZ-CSRF'] = options.nonce
  if (options.token) headers.Authorization = `Bearer ${options.token}`
  return fetch(`${base}${path}`, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body)
  })
}
async function badHostStatus(base: string, code: string, nonce: string): Promise<number> {
  const { request } = await import('node:http')
  const url = new URL(base)
  const body = JSON.stringify({ invitation: code, name: 'Guest' })
  return new Promise((resolve) => {
    const req = request({
      hostname: url.hostname, port: url.port, path: '/api/pair', method: 'POST',
      headers: {
        Host: 'evil.test', Origin: base, 'Content-Type': 'application/json',
        'X-SingZ-CSRF': nonce, 'Content-Length': Buffer.byteLength(body)
      }
    }, (response) => {
      response.resume()
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    req.once('error', () => resolve(0))
    req.end(body)
  })
}
async function pageNonce(base: string): Promise<{ html: string; nonce: string; csp: string }> {
  const response = await fetch(`${base}/`)
  expect(response.status).toBe(200)
  const html = await response.text()
  const nonce = /const clientNonce="([^"]+)"/.exec(html)?.[1]
  expect(nonce).toBeTruthy()
  return { html, nonce: nonce as string, csp: response.headers.get('content-security-policy') ?? '' }
}
async function pair(base: string, code: string, name = 'Guest') {
  const { nonce } = await pageNonce(base)
  const response = await post(base, '/api/pair', { invitation: code, name }, { nonce })
  expect(response.status).toBe(202)
  const value = await response.json() as { requestId: string; pollSecret: string }
  return { ...value, nonce }
}
async function approved(base: string, code: string, phone: BoxPhoneService) {
  const pairing = await pair(base, code)
  const pending = await post(base, '/api/pair-status', {
    requestId: pairing.requestId, pollSecret: pairing.pollSecret
  }, { nonce: pairing.nonce })
  expect((await pending.json()).status).toBe('pending')
  const tv = phone.approve(pairing.requestId)
  expect(tv.ok).toBe(true)
  if (!tv.ok) throw new Error('Approval failed')
  const sessionId = tv.value.sessions[0].sessionId
  const response = await post(base, '/api/pair-status', {
    requestId: pairing.requestId, pollSecret: pairing.pollSecret
  }, { nonce: pairing.nonce })
  const value = await response.json() as { status: string; sessionToken: string }
  expect(value.status).toBe('approved')
  expect(JSON.stringify(tv.value)).not.toContain(pairing.pollSecret)
  expect(JSON.stringify(tv.value)).not.toContain(value.sessionToken)
  return { ...pairing, ...value, sessionId }
}
const getState = (base: string, token?: string): Promise<Response> => fetch(`${base}/api/state`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {}
})
function rawSocket(base: string): Promise<Socket> {
  const url = new URL(base)
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) }, () => resolve(socket))
    socket.once('error', reject)
  })
}
async function rawStatus(base: string, text: string): Promise<number> {
  const socket = await rawSocket(base)
  return new Promise((resolve) => {
    let reply = ''
    socket.on('data', (chunk) => {
      reply += chunk.toString('latin1')
      const match = /^HTTP\/1\.1 (\d{3})/.exec(reply)
      if (match) { socket.destroy(); resolve(Number(match[1])) }
    })
    socket.once('close', () => resolve(0))
    socket.write(text)
  })
}
const closedWithin = (socket: Socket, ms: number): Promise<boolean> => new Promise((resolve) => {
  if (socket.destroyed) return resolve(true)
  const timer = setTimeout(() => resolve(false), ms)
  socket.once('close', () => { clearTimeout(timer); resolve(true) })
})
async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createTcpServer()
    server.once('error', () => resolve(false))
    server.listen(0, '::1', () => server.close(() => resolve(true)))
  })
}

afterEach(async () => {
  for (const { phone, hub } of fixtures.splice(0).reverse()) {
    await phone.stop()
    hub.dispose()
  }
})

describe('Box phone HTTP', () => {
  it('pairs only after TV approval, waits for authoritative replies, and never leaks paths or owner errors', async () => {
    const { phone, hub, envelopes, base, code } = await fixture()
    expect((await getState(base)).status).toBe(401)
    const auth = await approved(base, code, phone)
    const state = await getState(base, auth.sessionToken)
    expect(state.status).toBe(200)
    const body = JSON.stringify(await state.json())
    expect(body).toContain('Song')
    expect(body).not.toContain('/private/source')
    expect(body).not.toContain('activeLocalProjectDir')
    expect(body).not.toContain(auth.sessionToken)
    let settled = false
    const commandPromise = post(base, '/api/command', { type: 'play-pause' }, {
      nonce: auth.nonce, token: auth.sessionToken
    }).then((response) => { settled = true; return response })
    await waitFor(envelopes, 1)
    await delay(20)
    expect(settled).toBe(false)
    expect(hub.isCommandActive(envelopes[0].id)).toBe(true)
    expect(hub.respond(envelopes[0].id, { ok: true }).ok).toBe(true)
    const command = await commandPromise
    expect((await command.json()).ok).toBe(true)
    const failedPromise = post(base, '/api/command', { type: 'play-pause' }, {
      nonce: auth.nonce, token: auth.sessionToken
    })
    await waitFor(envelopes, 2)
    hub.respond(envelopes[1].id, { ok: false, error: 'native failed at /private/source/active-project' })
    const failed = await failedPromise
    const failure = await failed.json() as { ok: boolean; error: string }
    expect(failure.ok).toBe(false)
    expect(failure.error).not.toContain('/private/source')
    expect(failure.error).not.toContain('native failed')
  })

  it('denies and expires pairing requests and rejects late TV approval', async () => {
    const { phone, base, code, advance } = await fixture()
    const denied = await pair(base, code)
    expect(phone.deny(denied.requestId).ok).toBe(true)
    const deniedStatus = await post(base, '/api/pair-status', {
      requestId: denied.requestId, pollSecret: denied.pollSecret
    }, { nonce: denied.nonce })
    expect((await deniedStatus.json()).status).toBe('denied')
    expect(phone.approve(denied.requestId).ok).toBe(false)
    const expired = await pair(base, code, 'Late guest')
    advance(1001)
    const expiredStatus = await post(base, '/api/pair-status', {
      requestId: expired.requestId, pollSecret: expired.pollSecret
    }, { nonce: expired.nonce })
    expect((await expiredStatus.json()).status).toBe('denied')
    expect(phone.approve(expired.requestId).ok).toBe(false)
  })

  it('withholds stale TV state without revoking the phone and reconnects after fresh publication', async () => {
    const { phone, hub, envelopes, base, code } = await fixture()
    const auth = await approved(base, code, phone)
    hub.setCommandSender(null)
    const unavailable = await getState(base, auth.sessionToken)
    expect(unavailable.status).toBe(503)
    expect(JSON.stringify(await unavailable.json())).not.toContain('snapshot')
    expect(phone.state().sessions).toHaveLength(1)
    hub.publish(publish)
    hub.setCommandSender(envelope => envelopes.push(envelope))
    expect((await getState(base, auth.sessionToken)).status).toBe(200)
  })

  it('drops revoked and expired sessions, including a command awaiting the TV', async () => {
    const { phone, hub, envelopes, base, code, advance } = await fixture()
    const auth = await approved(base, code, phone)
    const pending = post(base, '/api/command', { type: 'play-pause' }, {
      nonce: auth.nonce, token: auth.sessionToken
    })
    await waitFor(envelopes, 1)
    expect(phone.revoke(auth.sessionId).ok).toBe(true)
    expect(hub.isCommandActive(envelopes[0].id)).toBe(false)
    expect(hub.respond(envelopes[0].id, { ok: true }).ok).toBe(false)
    expect((await pending).status).toBe(401)
    expect((await getState(base, auth.sessionToken)).status).toBe(401)
    expect(phone.state().code).not.toBe(code)
    const second = await approved(base, phone.state().code as string, phone)
    advance(1001)
    expect((await getState(base, second.sessionToken)).status).toBe(401)
    expect(phone.state().sessions).toEqual([])
  })

  it('fails closed after command timeout and rejects a late acknowledgement', async () => {
    const { hub, envelopes, base, code, phone } = await fixture(250)
    const auth = await approved(base, code, phone)
    const responsePromise = post(base, '/api/command', { type: 'play-pause' }, {
      nonce: auth.nonce, token: auth.sessionToken
    })
    await waitFor(envelopes, 1)
    const response = await responsePromise
    const result = await response.json() as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/may already have run/i)
    expect(hub.isCommandActive(envelopes[0].id)).toBe(false)
    expect(hub.respond(envelopes[0].id, { ok: true }).ok).toBe(false)
  })

  it('rejects bad Host, Origin, CSRF, JSON, and oversized bodies without CORS access', async () => {
    const { base, code } = await fixture()
    const { nonce } = await pageNonce(base)
    expect(await badHostStatus(base, code, nonce)).toBe(403)
    expect((await post(base, '/api/pair', { invitation: code, name: 'Guest' }, { nonce, origin: 'https://evil.test' })).status).toBe(403)
    expect((await post(base, '/api/pair', { invitation: code, name: 'Guest' })).status).toBe(403)
    expect((await post(base, '/api/pair', '{', { nonce })).status).toBe(400)
    const oversized = await post(base, '/api/pair', JSON.stringify({ invitation: code, name: 'x'.repeat(17_000) }), { nonce })
    expect(oversized.status).toBe(413)
    expect(oversized.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('runs the nonce-authorized page script and exposes no seek or persistent-token mechanism', async () => {
    const { base } = await fixture()
    const { html, nonce, csp } = await pageNonce(base)
    expect(html).toContain(`<script nonce="${nonce}">`)
    expect(csp).toContain(`script-src 'nonce-${nonce}'`)
    expect(html).toContain('Show on TV')
    expect(html).not.toContain("type:'seek'")
    expect(html).not.toMatch(/localStorage|sessionStorage|document\.cookie/)
    const script = new RegExp(`<script nonce="${nonce}">([\\s\\S]*?)</script>`).exec(html)?.[1]
    expect(script).toBeTruthy()
    class Element {
      textContent = ''
      value = ''
      children: unknown[] = []
      classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined }
      addEventListener(): void {}
      append(...nodes: unknown[]): void { this.children.push(...nodes) }
      replaceChildren(...nodes: unknown[]): void { this.children = nodes }
      setAttribute(): void {}
    }
    const ids = new Map<string, Element>()
    for (const id of ['error', 'pairing', 'controller', 'content', 'invitation', 'name', 'pair-form']) ids.set(id, new Element())
    let replaced = ''
    runInNewContext(script as string, {
      document: {
        getElementById: (id: string) => ids.get(id),
        querySelectorAll: () => [],
        createElement: () => new Element()
      },
      location: { hash: '#PUBLICCODE', pathname: '/' },
      history: { replaceState: (_a: unknown, _b: unknown, path: string) => { replaced = path } },
      setInterval: () => 0, setTimeout, clearTimeout, AbortSignal, Date, console
    })
    expect(ids.get('invitation')?.value).toBe('PUBLICCODE')
    expect(replaced).toBe('/')
    expect(ids.get('content')?.children.length).toBeGreaterThan(0)
  })

  it('does not default to loopback when no private LAN interface exists', async () => {
    const hub = new BoxControllerHub()
    const phone = new BoxPhoneService({ controller: hub, interfaceSnapshot: () => ({}) })
    fixtures.push({ phone, hub })
    expect((await phone.start())).toMatchObject({ ok: false, code: 'unavailable' })
    expect(phone.state().running).toBe(false)
  })

  it('rate-limits pairing attempts per address after rejecting wrong invitation codes', async () => {
    const { base } = await fixture()
    const { nonce } = await pageNonce(base)
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await post(base, '/api/pair', { invitation: 'WRONGCODE', name: 'Guest' }, { nonce })).status).toBe(403)
    }
    expect((await post(base, '/api/pair', { invitation: 'WRONGCODE', name: 'Guest' }, { nonce })).status).toBe(429)
  })

  it('rate-limits page loads per address', async () => {
    const { base } = await fixture()
    for (let load = 0; load < 20; load++) expect((await fetch(`${base}/`)).status).toBe(200)
    expect((await fetch(`${base}/`)).status).toBe(429)
  })

  it('rejects commands without Bearer, nonce, own-session nonce or same-origin fetch, and rate-limits bursts', async () => {
    const { phone, hub, base, code } = await fixture()
    hub.setCommandSender((envelope) => setTimeout(() => hub.respond(envelope.id, { ok: true }), 0))
    const first = await approved(base, code, phone)
    const second = await approved(base, phone.state().code as string, phone)
    const command = { type: 'play-pause' }
    expect((await post(base, '/api/command', command, { nonce: first.nonce })).status).toBe(401)
    expect((await post(base, '/api/command', command, { token: first.sessionToken })).status).toBe(403)
    expect((await post(base, '/api/command', command, { token: first.sessionToken, nonce: second.nonce })).status).toBe(403)
    expect((await post(base, '/api/command', command, {
      token: first.sessionToken, nonce: first.nonce, headers: { 'Sec-Fetch-Site': 'cross-site' }
    })).status).toBe(403)
    for (let index = 0; index < 20; index++) {
      const response = await post(base, '/api/command', command, { token: first.sessionToken, nonce: first.nonce })
      expect(response.status).toBe(200)
    }
    expect((await post(base, '/api/command', command, { token: first.sessionToken, nonce: first.nonce })).status).toBe(429)
    expect((await post(base, '/api/command', command, { token: second.sessionToken, nonce: second.nonce })).status).toBe(200)
  })

  it('re-delivers the same token to a retried poll and rotates the invitation after approval', async () => {
    const { phone, base, code } = await fixture()
    const auth = await approved(base, code, phone)
    const again = await post(base, '/api/pair-status', { requestId: auth.requestId, pollSecret: auth.pollSecret }, { nonce: auth.nonce })
    const body = await again.json() as { status?: string; sessionToken?: string }
    expect(body.status).toBe('approved')
    expect(body.sessionToken).toBe(auth.sessionToken)
    const { nonce } = await pageNonce(base)
    expect((await post(base, '/api/pair', { invitation: code, name: 'Late' }, { nonce })).status).toBe(403)
  })

  it('caps pending requests per address and strips bidi controls from names', async () => {
    const { phone, base, code } = await fixture()
    const { nonce } = await pageNonce(base)
    expect((await post(base, '/api/pair', { invitation: code, name: '\u202eA\u2066' }, { nonce })).status).toBe(202)
    expect((await post(base, '/api/pair', { invitation: code, name: 'B' }, { nonce })).status).toBe(202)
    expect((await post(base, '/api/pair', { invitation: code, name: 'C' }, { nonce })).status).toBe(429)
    expect(phone.state().pending.map((item) => item.name)).toEqual(['A', 'B'])
  })

  it('rejects request targets that are not origin-form paths', async () => {
    const { base } = await fixture()
    const host = new URL(base).host
    expect(await rawStatus(base, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).toBe(200)
    expect(await rawStatus(base, `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).toBe(400)
    expect(await rawStatus(base, `GET //${host}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)).toBe(400)
  })

  it('caps concurrent connections per remote address', async () => {
    const { base } = await fixture()
    const sockets: Socket[] = []
    try {
      for (let index = 0; index < MAX_PHONE_CONNECTIONS_PER_ADDRESS; index++) sockets.push(await rawSocket(base))
      const extra = await rawSocket(base)
      sockets.push(extra)
      expect(await closedWithin(extra, 1000)).toBe(true)
      expect(sockets.slice(0, -1).some((socket) => socket.destroyed)).toBe(false)
    } finally {
      for (const socket of sockets) socket.destroy()
    }
  })

  it('stops within its deadline while keep-alive and half-sent requests hold sockets open', async () => {
    const { phone, base } = await fixture()
    const host = new URL(base).host
    const keepAlive = await rawSocket(base)
    await new Promise<void>((resolve) => {
      keepAlive.once('data', () => resolve())
      keepAlive.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`)
    })
    const partial = await rawSocket(base)
    partial.write(`POST /api/pair HTTP/1.1\r\nHost: ${host}\r\n`)
    const idle = await rawSocket(base)
    await delay(20)
    const started = Date.now()
    const stopped = await Promise.race([phone.stop(), delay(1500).then(() => 'timeout' as const)])
    expect(stopped).not.toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1500)
    expect(await closedWithin(keepAlive, 500)).toBe(true)
    expect(await closedWithin(partial, 500)).toBe(true)
    expect(await closedWithin(idle, 500)).toBe(true)
  })

  it('rebinds when the selected host changes so the URL and Host check follow it', async (context) => {
    if (!await ipv6LoopbackAvailable()) return context.skip()
    const hub = new BoxControllerHub()
    const options: BoxPhoneOptions = { controller: hub, host: '127.0.0.1', port: 0 }
    const phone = new BoxPhoneService(options)
    fixtures.push({ phone, hub })
    const first = await phone.start()
    if (!first.ok) throw new Error('Phone did not start')
    expect(first.value.url).toContain('127.0.0.1')
    options.host = '::1'
    const second = await phone.start()
    if (!second.ok) throw new Error('Phone did not rebind')
    expect(second.value.url).toContain('[::1]')
    const base = new URL(second.value.url as string).origin
    expect((await fetch(`${base}/`)).status).toBe(200)
    await expect(fetch(`${new URL(first.value.url as string).origin}/`)).rejects.toThrow()
  })
})
