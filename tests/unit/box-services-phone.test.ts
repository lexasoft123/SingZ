import { afterEach, describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { BoxControllerHub } from '../../src/main/box/controller'
import { BoxPhoneService } from '../../src/main/box/phone'
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
async function fixture(commandTimeoutMs = 1000) {
  const hub = new BoxControllerHub({ commandTimeoutMs })
  expect(hub.publish(publish).ok).toBe(true)
  const envelopes: BoxControllerEnvelope[] = []
  hub.setCommandSender((envelope) => envelopes.push(envelope))
  let now = 1_000_000
  const phone = new BoxPhoneService({
    controller: hub, host: '127.0.0.1', port: 0,
    now: () => now, pendingTtlMs: 1000, sessionTtlMs: 1000
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
  options: { nonce?: string; token?: string; origin?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: options.origin ?? base
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
    const second = await approved(base, code, phone)
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
})
