import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { BoxControllerHub } from '../../src/main/box/controller'
import { BoxPlatformService } from '../../src/main/box/platform'
import { BoxPhoneSessions } from '../../src/main/box/phone-sessions'
import { SONG_VOLUME_MAX_DB } from '../../src/shared/song-volume'
import type { BoxControllerPublish, BoxPlatformSnapshot } from '../../src/shared/box-contract'

const cleanups: Array<() => Promise<void>> = []
const activeProjectDir = join(tmpdir(), 'box-active')
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const interfaces = (): ReturnType<typeof networkInterfaces> => ({
  lan0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.20/24' }],
  wan0: [{ address: '8.8.8.8', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '8.8.8.8/8' }]
})
const publish = (masterVolume = 1): BoxControllerPublish => ({
  activeProjectId: 'song1',
  transport: { playing: false, position: 0, duration: 120, masterVolume },
  songs: [{ id: 'song1', title: 'Song', artist: 'Artist', ready: true }],
  queue: [{ entryId: 'entry1', projectId: 'song1', title: 'Song', artist: 'Artist' }],
  stems: [{ id: 'vocals', label: 'Vocals', volume: 0.8, muted: false, solo: false }],
  activeLocalProjectDir: activeProjectDir,
  openingLocalProjectDir: null
})
const agentSnapshot = (now: number): BoxPlatformSnapshot => ({
  available: true,
  capabilities: { wifi: true, updates: true, reboot: true, reset: true },
  connectivity: { interfaces: [], internet: 'unknown' },
  network: {
    state: 'connected', ssid: 'Private LAN',
    handoff: { url: 'http://192.168.1.20:8080/setup', code: 'PUBLIC1', expiresAt: now + 60_000 }
  },
  update: { state: 'idle', currentVersion: 'actual-box-os-7' }
})
async function fakeAgent(respond: (request: Record<string, unknown>) => unknown, delayMs = 10) {
  const dir = await mkdtemp(join(tmpdir(), 'box-agent-'))
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\singz-box-agent-${randomUUID()}`
    : join(dir, 'agent.sock')
  const sockets = new Set<Socket>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const requests: Record<string, unknown>[] = []
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>
      requests.push(request)
      const timer = setTimeout(() => {
        timers.delete(timer)
        if (!socket.destroyed) socket.write(`${JSON.stringify(respond(request))}\n`)
      }, delayMs)
      timers.add(timer)
    })
  })
  await new Promise<void>((resolve) => server.listen(path, resolve))
  cleanups.push(async () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })
  return { path, requests }
}

describe('Box controller authority', () => {
  it('accepts shared +12 dB master gain but keeps stems bounded and rejects excess', async () => {
    const maximum = 10 ** (SONG_VOLUME_MAX_DB / 20)
    const hub = new BoxControllerHub()
    const envelopes: unknown[] = []
    hub.setCommandSender((envelope) => envelopes.push(envelope))
    expect(hub.publish(publish(2)).ok).toBe(true)
    expect(hub.publish(publish(maximum + 0.01)).ok).toBe(false)
    expect(hub.guardedLocalDirs().active).toBe(activeProjectDir)
    const result = hub.execute({ type: 'volume', target: 'master', value: 2 })
    const envelope = envelopes[0] as { id: string; command: { value: number } }
    expect(envelope.command.value).toBe(2)
    expect(hub.isCommandActive(envelope.id)).toBe(true)
    expect(hub.respond(envelope.id, { ok: true }).ok).toBe(true)
    expect((await result).ok).toBe(true)
    expect((await hub.execute({ type: 'volume', target: 'master', value: maximum + 0.01 })).ok).toBe(false)
    expect((await hub.execute({ type: 'volume', target: 'vocals', value: 2 })).ok).toBe(false)
  })

  it('rejects an acknowledgement when injected time makes the command stale before its timer fires', async () => {
    let now = 1000
    const hub = new BoxControllerHub({ now: () => now, commandTimeoutMs: 10_000, snapshotMaxAgeMs: 5000 })
    const envelopes: { id: string }[] = []
    hub.setCommandSender((envelope) => envelopes.push(envelope))
    expect(hub.publish(publish()).ok).toBe(true)
    const execution = hub.execute({ type: 'play-pause' })
    now += 5001
    expect(hub.isCommandActive(envelopes[0].id)).toBe(false)
    expect(hub.respond(envelopes[0].id, { ok: true })).toMatchObject({ ok: false, code: 'stale-command' })
    expect((await execution).ok).toBe(false)
  })

  it('rejects revoked pending commands and expires them with a truthful timeout', async () => {
    let valid = true
    const hub = new BoxControllerHub({ commandTimeoutMs: 250 })
    const envelopes: { id: string }[] = []
    hub.setCommandSender((envelope) => envelopes.push(envelope))
    hub.publish(publish())
    const revoked = hub.execute({ type: 'play-pause' }, () => valid)
    valid = false
    expect(hub.isCommandActive(envelopes[0].id)).toBe(false)
    expect(hub.respond(envelopes[0].id, { ok: true }).ok).toBe(false)
    expect((await revoked).ok).toBe(false)
    valid = true
    hub.publish(publish())
    const timedOut = hub.execute({ type: 'play-pause' }, () => valid)
    const result = await timedOut
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/may already have run/i)
    expect(hub.isCommandActive(envelopes[1].id)).toBe(false)
  })

  it('retains active/opening guards on disconnect but refuses stale commands', async () => {
    let now = 0
    const hub = new BoxControllerHub({ now: () => now, snapshotMaxAgeMs: 5000 })
    hub.publish(publish())
    hub.setCommandSender(null)
    expect(hub.beginCacheRemoval(activeProjectDir)).toMatchObject({ ok: false, code: 'project-active' })
    now += 5001
    hub.setCommandSender(() => undefined)
    expect((await hub.execute({ type: 'play-pause' })).ok).toBe(false)
    hub.publish(publish())
    expect((await hub.execute({ type: 'queue-remove', entryId: 'missing' })).ok).toBe(false)
  })

  it('does not revive queued commands when a replacement TV owner publishes fresh state', async () => {
    const hub = new BoxControllerHub()
    const envelopes: { id: string }[] = []
    hub.publish(publish())
    hub.setCommandSender(envelope => envelopes.push(envelope))
    const pending = hub.execute({ type: 'play-pause' })
    const oldId = envelopes[0].id
    hub.setCommandSender(null)
    expect(hub.snapshot()).toBeNull()
    hub.publish(publish())
    hub.setCommandSender(envelope => envelopes.push(envelope))
    expect(hub.isCommandActive(oldId)).toBe(false)
    expect(hub.respond(oldId, { ok: true })).toMatchObject({ ok: false, code: 'stale-command' })
    expect((await pending).ok).toBe(false)
    expect(hub.guardedLocalDirs().active).toBe(activeProjectDir)
    const current = hub.execute({ type: 'play-pause' })
    hub.setCommandSender(envelope => envelopes.push(envelope)) // An ordinary heartbeat keeps this owner.
    expect(hub.isCommandActive(envelopes[1].id)).toBe(true)
    expect(hub.respond(envelopes[1].id, { ok: true }).ok).toBe(true)
    expect((await current).ok).toBe(true)
  })
})

describe('Box platform adapter', () => {
  it('reports honest unavailable capabilities and actual private interfaces without an agent', async () => {
    const service = new BoxPlatformService({ currentVersion: 'app-dev', interfaceSnapshot: interfaces })
    const result = await service.snapshot()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.available).toBe(false)
    expect(result.value.capabilities).toEqual({ wifi: false, updates: false, reboot: false, reset: false })
    expect(result.value.connectivity).toEqual({ interfaces: [{ name: 'lan0', address: '192.168.1.20' }], internet: 'unknown' })
    expect(result.value.update.state).toBe('unavailable')
  })

  it('validates asynchronous agent replies, preserves OS version, and forces disruptive capabilities off', async () => {
    const now = 100_000
    const agent = await fakeAgent((request) => ({ ok: true, snapshot: request.type === 'command' ? agentSnapshot(now) : agentSnapshot(now) }))
    const service = new BoxPlatformService({
      socketPath: agent.path, currentVersion: 'app-dev', now: () => now, interfaceSnapshot: interfaces
    })
    const result = await service.snapshot()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.update.currentVersion).toBe('actual-box-os-7')
    expect(result.value.capabilities).toEqual({ wifi: true, updates: true, reboot: false, reset: false })
    expect(result.value.network.handoff?.url).toBe('http://192.168.1.20:8080/setup')
    expect((await service.command({ type: 'reboot' }))).toMatchObject({ ok: false, code: 'unsupported' })
    expect((await service.command({ type: 'wifi-start', requestId: 'request-1' })).ok).toBe(true)
    expect(agent.requests.some((request) => request.type === 'command')).toBe(true)
  })

  it.each(['https://example.com/setup', 'http://127.0.0.1:8080/setup'])(
    'rejects a handoff that is not on the phone-accessible private LAN: %s', async (url) => {
    const now = 100_000
    const invalid = agentSnapshot(now)
    invalid.network.handoff = { url, code: 'PUBLIC1', expiresAt: now + 60_000 }
    const agent = await fakeAgent(() => ({ ok: true, snapshot: invalid }))
    const service = new BoxPlatformService({ socketPath: agent.path, currentVersion: 'app', now: () => now, interfaceSnapshot: interfaces })
    expect((await service.snapshot())).toMatchObject({ ok: false, code: 'invalid-response' })
  })

  it('does not dispatch commands when the configured agent reports unavailable', async () => {
    const now = 100_000
    const unavailable = { ...agentSnapshot(now), available: false }
    const agent = await fakeAgent(() => ({ ok: true, snapshot: unavailable }))
    const service = new BoxPlatformService({ socketPath: agent.path, currentVersion: 'app', now: () => now })
    expect(await service.command({ type: 'wifi-start' })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(agent.requests.some(request => request.type === 'command')).toBe(false)
  })

  it.each(['installing', 'rollback'] as const)(
    'reads status but dispatches no platform commands once the agent enters %s', async (committedPhase) => {
      const now = 100_000
      let phase: BoxPlatformSnapshot['update']['state'] = 'idle'
      const agent = await fakeAgent(() => {
        const snapshot = agentSnapshot(now)
        snapshot.update.state = phase
        return { ok: true, snapshot }
      })
      const service = new BoxPlatformService({ socketPath: agent.path, currentVersion: 'app', now: () => now })
      expect((await service.snapshot()).ok).toBe(true)
      phase = committedPhase
      for (const type of ['wifi-start', 'wifi-cancel', 'update-check', 'update-stage'] as const) {
        expect(await service.command({ type })).toMatchObject({ ok: false, code: 'update-committed' })
      }
      const current = await service.snapshot()
      expect(current.ok).toBe(true)
      if (current.ok) expect(current.value.update.state).toBe(committedPhase)
      expect(agent.requests).toHaveLength(6)
      expect(agent.requests.every(request => request.type === 'snapshot')).toBe(true)
    }
  )

  it('times out a silent configured agent without claiming success', async () => {
    const agent = await fakeAgent(() => ({ ok: true }), 5000)
    const service = new BoxPlatformService({ socketPath: agent.path, currentVersion: 'app', timeoutMs: 1000, interfaceSnapshot: interfaces })
    const result = await service.snapshot()
    expect(result).toMatchObject({ ok: false, code: 'platform-timeout' })
  })
})

describe('Phone rate windows', () => {
  it('expires each bucket by its own window when short and long limits interleave', () => {
    let now = 0
    const sessions = new BoxPhoneSessions({ now: () => now })
    sessions.start('http://127.0.0.1:1234')
    expect(sessions.allow('pair', 2, 60_000)).toBe(true)
    expect(sessions.allow('pair', 2, 60_000)).toBe(true)
    expect(sessions.allow('command', 1, 1000)).toBe(true)
    now = 1001
    expect(sessions.allow('command', 1, 1000)).toBe(true)
    expect(sessions.allow('pair', 2, 60_000)).toBe(false)
  })
})
