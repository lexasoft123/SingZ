import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// Scripted sockets let the test deliver an old connection's 'close' after a
// replacement connection exists, which a real local destroy cannot delay.
class FakeSocket extends EventEmitter {
  destroyed = false
  written: string[] = []
  write(data: string, callback?: (error?: Error) => void): boolean { this.written.push(data); callback?.(); return true }
  destroy(error?: Error): this {
    if (this.destroyed) return this
    this.destroyed = true
    process.nextTick(() => { if (error) this.emit('error', error); this.emit('close') })
    return this
  }
  send(value: unknown): void { this.emit('data', Buffer.from(JSON.stringify(value) + '\n')) }
}
const net = vi.hoisted(() => ({ sockets: [] as unknown[] }))
vi.mock('node:net', () => ({ connect: () => { const socket = new FakeSocket(); net.sockets.push(socket); return socket } }))
vi.mock('node:fs/promises', () => ({
  lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, isSocket: () => true, uid: process.getuid?.(), mode: 0o700 })
}))
const { createBoxAudioClient } = await import('../../src/main/box-audio/client')

const sockets = (): FakeSocket[] => net.sockets as FakeSocket[]
const request = async (socket: FakeSocket, index: number): Promise<{ id: string; method: string }> => {
  await vi.waitFor(() => { expect(socket.written.length).toBeGreaterThan(index) }, { timeout: 1000, interval: 1 })
  return JSON.parse(socket.written[index])
}

describe('Box audio client connection ownership', () => {
  it('ignores a late close from a replaced socket', async () => {
    const client = createBoxAudioClient('/private/box/audio.sock', { timeoutMs: 2000 })
    const first = client.call('owner', 'playbackStatus', [])
    await vi.waitFor(() => { expect(sockets()).toHaveLength(1) }, { timeout: 1000, interval: 1 })
    const old = sockets()[0]
    old.send({ version: 1, type: 'ready', epoch: 'E' })
    const firstRequest = await request(old, 0)
    old.send({ version: 1, type: 'reply', epoch: 'E', id: firstRequest.id, ok: true, value: { state: 'playing' } })
    await expect(first).resolves.toEqual({ state: 'playing' })

    // The old socket is gone but has not delivered its close event yet.
    old.destroyed = true
    const second = client.call('owner', 'startPlayback', [1, '1'])
    await vi.waitFor(() => { expect(sockets()).toHaveLength(2) }, { timeout: 1000, interval: 1 })
    const replacement = sockets()[1]
    replacement.send({ version: 1, type: 'ready', epoch: 'E' })
    const started = await request(replacement, 0)
    expect(started.method).toBe('startPlayback')

    old.emit('error', new Error('late reset of the replaced socket'))
    old.emit('close')
    replacement.send({ version: 1, type: 'reply', epoch: 'E', id: started.id, ok: true, value: { ok: true } })
    await expect(second).resolves.toEqual({ ok: true })
    expect(replacement.destroyed).toBe(false)

    // The replacement remains the live connection for later commands.
    const third = client.call('owner', 'playbackStatus', [])
    const next = await request(replacement, 1)
    expect(next.id).not.toBe(started.id)
    replacement.send({ version: 1, type: 'reply', epoch: 'E', id: next.id, ok: true, value: { state: 'paused' } })
    await expect(third).resolves.toEqual({ state: 'paused' })
    expect(sockets()).toHaveLength(2)
    await client.shutdown()
  })

  it('does not let a replaced socket close fail the replacement connection after an earlier error', async () => {
    net.sockets.length = 0
    const client = createBoxAudioClient('/private/box/audio.sock', { timeoutMs: 2000 })
    const first = client.call('owner', 'playbackStatus', [])
    await vi.waitFor(() => { expect(sockets()).toHaveLength(1) }, { timeout: 1000, interval: 1 })
    const old = sockets()[0]
    old.send({ version: 1, type: 'ready', epoch: 'E' })
    const firstRequest = await request(old, 0)
    old.send({ version: 1, type: 'reply', epoch: 'E', id: firstRequest.id, ok: true, value: { state: 'playing' } })
    await first
    // A reset reports 'error' first; its 'close' arrives after a reconnect.
    old.destroyed = true
    old.emit('error', new Error('ECONNRESET'))
    const second = client.call('owner', 'startPlayback', [1, '1'])
    await vi.waitFor(() => { expect(sockets()).toHaveLength(2) }, { timeout: 1000, interval: 1 })
    const replacement = sockets()[1]
    replacement.send({ version: 1, type: 'ready', epoch: 'E' })
    const started = await request(replacement, 0)
    old.emit('close')
    replacement.send({ version: 1, type: 'reply', epoch: 'E', id: started.id, ok: true, value: { ok: true } })
    await expect(second).resolves.toEqual({ ok: true })
    await client.shutdown()
  })
})

describe('host microphone client protocol', () => {
  it('reads microphone state while uncertain and reconciles a new epoch before selection CAS', async () => {
    net.sockets.length = 0
    const client = createBoxAudioClient('/private/box/audio.sock', { timeoutMs: 2000 })
    const initial = client.call('service', 'microphones', [])
    await vi.waitFor(() => expect(sockets()).toHaveLength(1), { interval: 1 })
    const old = sockets()[0]
    old.send({ version: 1, type: 'ready', epoch: 'old' })
    const first = await request(old, 0)
    old.send({ version: 1, type: 'reply', epoch: 'old', id: first.id, ok: true, value: { generation: '1' } })
    await initial
    old.destroyed = true; old.emit('close')
    const read = client.call('service', 'microphones', [])
    await vi.waitFor(() => expect(sockets()).toHaveLength(2), { interval: 1 })
    const socket = sockets()[1]
    socket.send({ version: 1, type: 'ready', epoch: 'new' })
    const query = await request(socket, 0)
    expect(query.method).toBe('microphones')
    socket.send({ version: 1, type: 'reply', epoch: 'new', id: query.id, ok: true, value: { revision: '7' } })
    await expect(read).resolves.toEqual({ revision: '7' })
    const edit = { expectedRevision: '7', device: null, channels: {} }
    const write = client.call('service', 'setMicrophoneSelection', [edit])
    const barrier = await request(socket, 1)
    expect(barrier.method).toBe('reconcile')
    socket.send({ version: 1, type: 'reply', epoch: 'new', id: barrier.id, ok: true, value: {} })
    const command = await request(socket, 2)
    expect(command.method).toBe('setMicrophoneSelection')
    expect(JSON.parse(socket.written[2]).args).toEqual([edit])
    socket.send({ version: 1, type: 'reply', epoch: 'new', id: command.id, ok: true, value: { ok: false, code: 'stale' } })
    await expect(write).resolves.toEqual({ ok: false, code: 'stale' })
    expect(socket.written).toHaveLength(3)
    await client.shutdown()
  })
})
