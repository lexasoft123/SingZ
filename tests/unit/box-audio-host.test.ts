import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoxAudioHost, type BoxAudioHostRuntime } from '../../src/main/box-audio/server'
import { createBoxAudioClient } from '../../src/main/box-audio/client'
import { boxAudioLines, boxAudioEncode } from '../../src/main/box-audio/wire'

function fake() {
  const calls: unknown[][] = []
  const runtime: BoxAudioHostRuntime = {
    owner: { startPlayback: (...args: unknown[]) => { calls.push(['start', ...args]); return { ok: true } },
      playbackStatus: () => ({ state: 'playing', generation: '9007199254740993' }),
      beginMonitor: (...args: unknown[]) => { calls.push(['monitor', ...args]); return { ok: true } },
      rendererDetached: (id: number) => { calls.push(['detach', id]) } },
    binding: {}, routingRequest: () => '{"version":1}', routingCapabilities: () => ({ supported: true }),
    shutdown: () => { calls.push(['shutdown']) }
  }
  return { runtime, calls }
}
describe.skipIf(process.platform === 'win32')('persistent Box audio control', () => {
  it('preserves optional trailing arguments through the real JSON client/server boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-optional-'))
    const { runtime } = fake()
    runtime.owner.hostDevices = (...args: unknown[]) => {
      const [provider = 'alsa'] = args
      return { ok: provider === 'alsa', provider, received: args }
    }
    const host = await startBoxAudioHost(join(dir, 'audio.sock'), runtime)
    const client = createBoxAudioClient(join(dir, 'audio.sock'))
    try {
      expect(await client.call('owner', 'hostDevices', [])).toEqual({ ok: true, provider: 'alsa', received: [] })
      const omitted = [undefined]
      expect(await client.call('owner', 'hostDevices', omitted)).toEqual({ ok: true, provider: 'alsa', received: [] })
      expect(omitted).toEqual([undefined])
      expect(await client.call('owner', 'hostDevices', ['alsa', undefined, undefined])).toEqual({ ok: true, provider: 'alsa', received: ['alsa'] })
      expect(await client.call('owner', 'hostDevices', [null])).toEqual({ ok: false, provider: null, received: [null] })
      // JSON keeps interior omissions as null placeholders; never shift a later argument.
      expect(await client.call('owner', 'hostDevices', [undefined, 'keep-position', undefined])).toEqual({ ok: false, provider: null, received: [null, 'keep-position'] })
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('maps public ownership, detaches only private capture, and survives UI reconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    const host = await startBoxAudioHost(path, runtime)
    try {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      const first = createBoxAudioClient(path)
      await first.call('owner', 'startPlayback', [45, '1'])
      await first.call('owner', 'beginMonitor', [45, {}])
      await first.shutdown()
      const second = createBoxAudioClient(path)
      expect(await second.call('owner', 'playbackStatus', [])).toEqual({ state: 'playing', generation: '9007199254740993' })
      await second.reconcile()
      expect(calls[0]).toEqual(['start', 1, '1'])
      expect(calls.some(row => row[0] === 'detach' && row[1] !== 1)).toBe(true)
      expect(calls.some(row => row[0] === 'shutdown')).toBe(false)
      await second.shutdown()
    } finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
    expect(calls.at(-1)).toEqual(['shutdown'])
  })
  it('never retries uncertain mutation and clears uncertainty only through an idle barrier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    let release!: () => void
    runtime.owner.startPlayback = () => new Promise(resolve => { release = () => resolve({ ok: true }); calls.push(['slow']) })
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path, { timeoutMs: 80 })
    try {
      await expect(client.call('owner', 'startPlayback', [2, '1'])).rejects.toThrow('outcome unknown')
      await expect(client.call('owner', 'startPlayback', [2, '1'])).rejects.toThrow('uncertain')
      release()
      await client.reconcile()
      expect(calls.filter(row => row[0] === 'slow')).toHaveLength(1)
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('fences a reconnected client after a host epoch change without replaying commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-'))
    const path = join(dir, 'audio.sock')
    const firstRuntime = fake()
    const first = await startBoxAudioHost(path, firstRuntime.runtime)
    const client = createBoxAudioClient(path)
    await client.call('owner', 'startPlayback', [9, '1'])
    await first.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    const secondRuntime = fake()
    const second = await startBoxAudioHost(path, secondRuntime.runtime)
    try {
      await expect(client.call('owner', 'startPlayback', [9, '1'])).rejects.toThrow('uncertain')
      expect(secondRuntime.calls).toHaveLength(0)
      await client.reconcile()
      await client.call('owner', 'startPlayback', [9, '2'])
      expect(secondRuntime.calls).toEqual([['start', 1, '2']])
    } finally { await client.shutdown(); await second.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('treats shared initialization as host readiness and rejects raw physical reconfiguration or PCM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    runtime.binding.initializeSharedAudio = () => { throw new Error('must never open legacy physical output') }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    try {
      expect(await client.call('binding', 'initializeSharedAudio', [])).toEqual({ ok: true })
      await expect(client.call('binding', 'initializeSharedAudio', [{ outputDeviceUid: 'alsa:test', provider: 'alsa' }])).rejects.toThrow('reconfiguration')
      await expect(client.call('binding', 'scheduleTrainingCue', [{ channels: [new Float32Array(2)] }, '1'])).rejects.toThrow('PCM')
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('refuses foreign socket paths and duplicate owners', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    await writeFile(path, 'do not replace')
    await expect(startBoxAudioHost(path, runtime)).rejects.toThrow('foreign')
    await rm(path)
    const host = await startBoxAudioHost(path, runtime)
    try { await expect(startBoxAudioHost(path, runtime)).rejects.toThrow('already exists') }
    finally { await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('admits only one physical owner when fresh startups race', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-race-'))
    const path = join(dir, 'audio.sock')
    let opens = 0
    const launch = async () => {
      const host = await startBoxAudioHost(path, fake().runtime)
      ++opens // entry.ts loads/opens native devices only after socket acquisition.
      return host
    }
    const results = await Promise.allSettled([launch(), launch()])
    try {
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(opens).toBe(1)
      const client = createBoxAudioClient(path)
      try { expect(await client.call('owner', 'playbackStatus', [])).toMatchObject({ state: 'playing' }) }
      finally { await client.shutdown() }
    } finally {
      for (const result of results) if (result.status === 'fulfilled') await result.value.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('never deletes an abandoned socket when concurrent startups race', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-stale-'))
    const path = join(dir, 'audio.sock')
    const child = spawn(process.execPath, ['-e',
      'require("node:net").createServer().listen(process.argv[1], () => process.stdout.write("ready"))', path],
    { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await once(child.stdout!, 'data')
      const stopped = once(child, 'exit')
      child.kill('SIGKILL')
      await stopped
      const before = await stat(path)
      let opens = 0
      const launch = async () => {
        const host = await startBoxAudioHost(path, fake().runtime)
        ++opens
        return host
      }
      const results = await Promise.allSettled([launch(), launch()])
      try {
        expect(results.every(result => result.status === 'rejected')).toBe(true)
        expect(opens).toBe(0)
        expect((await stat(path)).ino).toBe(before.ino)
      } finally {
        for (const result of results) if (result.status === 'fulfilled') await result.value.close()
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('retires capture callbacks on refusal, replacement, cancellation and renderer detach', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-sinks-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    const emitters: (() => void)[] = []
    const hits: number[] = Array(8).fill(0)
    let mode: 'ok' | 'refuse' | 'throw' | 'pending' = 'ok'
    let active = ''
    let release: (() => void) | undefined
    let began: (() => void) | undefined
    runtime.owner.begin = (_renderer: number, _config: unknown, generation: string, emit: (value: unknown) => void) => {
      emitters.push(() => emit({ generation }))
      if (mode === 'throw') throw new Error('Fixture transport refusal')
      if (mode === 'refuse') return { ok: false }
      if (mode === 'pending') return new Promise(resolve => {
        release = () => { active = generation; resolve({ ok: true }) }
        began?.()
      })
      active = generation
      return { ok: true }
    }
    runtime.owner.cancel = (_renderer: number, generation: string) => {
      const cancelled = generation === active
      if (cancelled) active = ''
      return { ok: true, cancelled }
    }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    const begin = (renderer: number, generation: number) => client.call('owner', 'begin',
      [renderer, {}, String(generation), () => { ++hits[generation] }])
    const emitAll = async () => { for (const emit of emitters) emit(); await client.reconcile() }
    try {
      await begin(11, 1)
      mode = 'refuse'
      await begin(11, 2)
      mode = 'throw'
      await expect(begin(11, 3)).rejects.toThrow('Fixture transport refusal')
      await emitAll()
      expect(hits.slice(1, 4)).toEqual([1, 0, 0])
      mode = 'pending'
      const started = new Promise<void>(resolve => { began = resolve })
      const replacement = begin(11, 4)
      await started
      emitters[0]() // Prior capture remains subscribed until replacement acknowledgement.
      release!()
      await replacement
      await emitAll()
      expect(hits[1]).toBe(2)
      expect(hits[4]).toBe(1)
      mode = 'ok'
      await begin(22, 5)
      await client.call('owner', 'cancel', [11, '4']) // A stale cancellation cannot retire the current sink.
      await emitAll()
      expect(hits[4]).toBe(1)
      expect(hits[5]).toBe(1)
      await client.call('owner', 'cancel', [22, '5'])
      await emitAll()
      expect(hits[5]).toBe(1)
      await begin(33, 6)
      await client.call('owner', 'rendererDetached', [22])
      await emitAll()
      expect(hits[6]).toBe(1)
      await client.call('owner', 'rendererDetached', [33])
      await emitAll()
      expect(hits[6]).toBe(1)
      await begin(44, 7)
      await client.call('owner', 'rendererGone', [44])
      await emitAll()
      expect(hits[7]).toBe(0)
    } finally { release?.(); await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('recovers a timed-out retained Stop through an authoritative idle barrier without replaying it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    let current: { generation: string; state: string; transportState: string } | null = { generation: '4', state: 'running', transportState: 'playing' }
    let attempts = 0
    let release!: () => void
    runtime.owner.playbackStatus = () => current
    runtime.owner.unloadPlayback = (id: number, generation: string) => {
      expect(id).toBe(1); expect(generation).toBe('4'); attempts++
      if (attempts === 1) return new Promise(resolve => { release = () => resolve({ ok: false, error: 'retained for recovery' }) })
      current = null
      return { ok: true, cleanupComplete: true }
    }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path, { timeoutMs: 80 })
    try {
      const first = await client.reconcile() as { epoch: string }
      const expected = { epoch: first.epoch, generation: '4' }
      await expect(client.call('service', 'stopRetained', [expected])).rejects.toThrow('outcome unknown')
      await expect(client.call('service', 'stopRetained', [expected])).rejects.toThrow('uncertain')
      expect(attempts).toBe(1)
      release()
      const authoritative = await client.reconcile() as { epoch: string; playback: unknown }
      expect(authoritative.playback).toMatchObject({ generation: '4' })
      expect(attempts).toBe(1)
      expect(await client.call('service', 'stopRetained', [expected])).toEqual({ epoch: first.epoch, playback: null })
      expect(attempts).toBe(2)
    } finally { release?.(); await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('cannot stop a reused generation counter in a replacement service epoch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-epoch-'))
    const path = join(dir, 'audio.sock')
    const oldRuntime = fake()
    oldRuntime.runtime.owner.playbackStatus = () => ({ generation: '1', state: 'running', transportState: 'playing' })
    const oldHost = await startBoxAudioHost(path, oldRuntime.runtime)
    const client = createBoxAudioClient(path)
    const original = await client.reconcile() as { epoch: string }
    await oldHost.close()
    await new Promise<void>(resolve => setImmediate(resolve))
    const nextRuntime = fake()
    let current: { generation: string; state: string; transportState: string } | null = { generation: '1', state: 'running', transportState: 'playing' }
    let unloads = 0
    nextRuntime.runtime.owner.playbackStatus = () => current
    nextRuntime.runtime.owner.unloadPlayback = () => { unloads++; current = null; return { ok: true, cleanupComplete: true } }
    const nextHost = await startBoxAudioHost(path, nextRuntime.runtime)
    try {
      const replacement = await client.reconcile() as { epoch: string }
      expect(replacement.epoch).not.toBe(original.epoch)
      await expect(client.call('service', 'stopRetained', [{ epoch: original.epoch, generation: '1' }])).rejects.toThrow('service changed')
      expect(unloads).toBe(0)
      await client.call('service', 'stopRetained', [{ epoch: replacement.epoch, generation: '1' }])
      expect(unloads).toBe(1)
    } finally { await client.shutdown(); await nextHost.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects oversized incomplete frames, PCM and malformed JSON', () => {
    const parse = boxAudioLines(4, () => {})
    expect(() => parse(Buffer.from('12345'))).toThrow('too large')
    expect(() => boxAudioEncode([new Float32Array(1)])).toThrow('PCM')
    expect(() => boxAudioLines(10, () => {})(Buffer.from('{bad}\n'))).toThrow()
  })
})
