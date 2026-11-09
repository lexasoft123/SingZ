import { describe, it, expect, vi, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { chmod, mkdtemp, stat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBoxAudioHost, type BoxAudioHostRuntime } from '../../src/main/box-audio/server'
import { createBoxAudioClient } from '../../src/main/box-audio/client'
import { boxAudioLines, boxAudioEncode } from '../../src/main/box-audio/wire'
import { BOX_AUDIO_PENDING, BOX_AUDIO_REQUEST_BYTES } from '../../src/shared/box-audio'

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
  const retainedFixture = () => {
    const nativeConfig = { masterGain: 0.8, playback: { transport: { playbackRate: 1, transposeSemitones: 0 } } }
    const lane = { id: 'vocals', path: '/library/song/stems/vocals.flac', gain: 0.5, muted: false, solo: false }
    const descriptor = {
      version: 1,
      project: {
        dir: '/library/song', songPath: '/library/song/source.flac', name: 'Song',
        metadataHash: `sha256:${'0'.repeat(64)}`, lyricsHash: null, graphHash: null,
        media: [{ id: lane.id, path: lane.path, size: '1', mtimeMs: 1 }]
      },
      config: nativeConfig,
      lanes: [lane]
    }
    const status = (generation: string) => ({
      generation, state: 'running', transportState: 'playing', masterGain: 0.8,
      playbackRate: 1, transposeSemitones: 0, loopEnabled: false, loopStartFrame: '0', loopEndFrame: '0',
      lanes: [{ id: lane.id, gain: 0.5, muted: false, solo: false }]
    })
    return { nativeConfig, descriptor, status }
  }
  it('retains exact generation context and projects only native-acknowledged controls', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-controls-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = (id: number, config: unknown, lanes: unknown) => {
      calls.push(['prepare', id, config, lanes])
      current = status('7')
      return { ok: true, generation: '7' }
    }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    try {
      const prepared = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      expect(prepared.epoch).toBe(host.epoch)
      expect(prepared.value).toMatchObject({ ok: true, generation: '7' })
      expect(await client.call('service', 'associateRetainedProject', [{
        expected: { epoch: prepared.epoch, generation: '7' }, descriptor
      }])).toMatchObject({ associated: true, generation: '7' })
      calls.length = 0
      let snapshot = await client.reconcile() as { recovery?: { generation: string; descriptor: typeof descriptor } }
      expect(snapshot.recovery?.generation).toBe('7')
      expect(calls).toEqual([])

      runtime.owner.setPlaybackLane = () => { current!.lanes[0] = { id: 'vocals', gain: 0.91, muted: true, solo: false }; return { ok: true } }
      runtime.owner.setPlaybackMasterGain = () => { current!.masterGain = 0.33; return { ok: true } }
      runtime.owner.reanchorPlayback = () => { current!.playbackRate = 1.25; current!.transposeSemitones = -2; return { ok: true } }
      runtime.owner.setPlaybackLoop = () => {
        current!.loopEnabled = true; current!.loopStartFrame = '12'; current!.loopEndFrame = '120'; return { ok: true }
      }
      await client.call('owner', 'setPlaybackLane', [42, '7', 'vocals', 0.2, false, false])
      await client.call('owner', 'setPlaybackMasterGain', [42, '7', 0.9])
      await client.call('owner', 'reanchorPlayback', [42, '7'])
      await client.call('owner', 'setPlaybackLoop', [42, '7', 100, 200])
      snapshot = await client.reconcile() as { recovery?: { generation: string; descriptor: typeof descriptor } }
      expect(snapshot.recovery?.descriptor.config.masterGain).toBe(0.33)
      expect(snapshot.recovery?.descriptor.config.playback.transport).toMatchObject({ playbackRate: 1.25, transposeSemitones: -2 })
      expect(snapshot.recovery?.descriptor.config).toHaveProperty('initialTransport.loop', { startProjectFrame: 12, endProjectFrame: 120 })
      expect(snapshot.recovery?.descriptor.lanes[0]).toMatchObject({ gain: 0.91, muted: true })
      current = { ...current!, state: 'prepared', transportState: 'stopped' }
      snapshot = await client.reconcile() as { recovery?: { generation: string; descriptor: typeof descriptor } }
      expect(snapshot.recovery?.descriptor.config).toHaveProperty('initialTransport.state', 'paused')
      current = { ...current!, state: 'stopped', transportState: 'playing' }
      snapshot = await client.reconcile() as { recovery?: { generation: string; descriptor: typeof descriptor } }
      expect(snapshot.recovery?.descriptor.config).toHaveProperty('initialTransport.state', 'paused')

      // A benign refusal or a thrown mutation leaves the generation live, so
      // recovery stays and keeps projecting the unchanged native controls.
      runtime.owner.setPlaybackMasterGain = () => ({ ok: false })
      await client.call('owner', 'setPlaybackMasterGain', [42, '7', 0.1])
      runtime.owner.seekPlayback = () => { throw new Error('Seek target is outside the song') }
      await expect(client.call('owner', 'seekPlayback', [42, '7', 1e12])).rejects.toThrow('outside the song')
      runtime.owner.setPlaybackLane = () => ({ ok: false, error: 'unknown lane' })
      await client.call('owner', 'setPlaybackLane', [42, '7', 'missing', 0.2, false, false])
      snapshot = await client.reconcile() as { recovery?: { generation: string; descriptor: typeof descriptor } }
      expect(snapshot.recovery?.generation).toBe('7')
      expect(snapshot.recovery?.descriptor.config.masterGain).toBe(0.33)

      // A failed mutation whose generation is no longer live drops recovery.
      runtime.owner.startPlayback = () => { current = { ...current!, state: 'terminal' }; return { ok: false } }
      await client.call('owner', 'startPlayback', [42, '7'])
      current = { ...current!, state: 'running' }
      snapshot = await client.reconcile() as { recovery?: { generation: string; descriptor: typeof descriptor } }
      expect(snapshot.recovery).toBeUndefined()
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects delayed A association after newer B prepare and binds only B', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-ab-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    let generation = 6
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = (id: number, config: unknown, lanes: unknown) => {
      calls.push(['prepare', id, config, lanes]); current = status(String(++generation))
      return { ok: true, generation: String(generation) }
    }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    try {
      const a = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      const b = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      expect(a.value).toMatchObject({ generation: '7' })
      expect(b.value).toMatchObject({ generation: '8' })
      await expect(client.call('service', 'associateRetainedProject', [{
        expected: { epoch: a.epoch, generation: '7' }, descriptor
      }])).rejects.toThrow('prepare changed')
      await client.call('service', 'associateRetainedProject', [{
        expected: { epoch: b.epoch, generation: '8' }, descriptor
      }])
      const snapshot = await client.reconcile() as { recovery?: { generation: string } }
      expect(snapshot.recovery?.generation).toBe('8')
      expect(calls.filter(row => row[0] === 'prepare')).toHaveLength(2)
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects association when unload happens during project validation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-unload-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = () => { current = status('7'); return { ok: true, generation: '7' } }
    runtime.owner.unloadPlayback = () => { current = null; return { ok: true, cleanupComplete: true } }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    try {
      const prepared = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      await client.call('owner', 'unloadPlayback', [42, '7'])
      await expect(client.call('service', 'associateRetainedProject', [{
        expected: { epoch: prepared.epoch, generation: '7' }, descriptor
      }])).rejects.toThrow('prepare changed')
      const snapshot = await client.reconcile() as { recovery?: unknown }
      expect(snapshot.recovery).toBeUndefined()
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects an old reply epoch when a replacement host reuses the generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-restart-'))
    const path = join(dir, 'audio.sock')
    const oldRuntime = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    oldRuntime.runtime.owner.preparePlayback = () => ({ ok: true, generation: '7' })
    const oldHost = await startBoxAudioHost(path, oldRuntime.runtime)
    const client = createBoxAudioClient(path)
    let replacementHost: Awaited<ReturnType<typeof startBoxAudioHost>> | undefined
    try {
      const old = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      await oldHost.close()
      await new Promise<void>(resolve => setImmediate(resolve))
      const nextRuntime = fake()
      let current: ReturnType<typeof status> | null = null
      nextRuntime.runtime.owner.playbackStatus = () => current
      nextRuntime.runtime.owner.preparePlayback = () => { current = status('7'); return { ok: true, generation: '7' } }
      replacementHost = await startBoxAudioHost(path, nextRuntime.runtime)
      await client.reconcile()
      const currentPrepare = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      await expect(client.call('service', 'associateRetainedProject', [{
        expected: { epoch: old.epoch, generation: '7' }, descriptor
      }])).rejects.toThrow('service changed')
      await client.call('service', 'associateRetainedProject', [{
        expected: { epoch: currentPrepare.epoch, generation: '7' }, descriptor
      }])
      const snapshot = await client.reconcile() as { recovery?: { generation: string } }
      expect(snapshot.recovery?.generation).toBe('7')
    } finally { await client.shutdown(); await replacementHost?.close(); await oldHost.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('preserves bound recovery across UI reconnect but clears unbound origin context', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-reconnect-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    let generation = 6
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = () => { current = status(String(++generation)); return { ok: true, generation: String(generation) } }
    const host = await startBoxAudioHost(path, runtime)
    const first = createBoxAudioClient(path)
    const second = createBoxAudioClient(path)
    const third = createBoxAudioClient(path)
    try {
      const bound = await first.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      await first.call('service', 'associateRetainedProject', [{
        expected: { epoch: bound.epoch, generation: '7' }, descriptor
      }])
      await first.shutdown()
      expect(await second.reconcile()).toMatchObject({ recovery: { generation: '7' } })
      const pending = await second.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      await second.shutdown()
      await expect(third.call('service', 'associateRetainedProject', [{
        expected: { epoch: pending.epoch, generation: '8' }, descriptor
      }])).rejects.toThrow('prepare changed')
    } finally {
      await first.shutdown(); await second.shutdown(); await third.shutdown()
      await host.close(); await rm(dir, { recursive: true, force: true })
    }
  })
  it('does not let association timeout poison native mutation fencing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-timeout-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = () => { current = status('7'); return { ok: true, generation: '7' } }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path, { timeoutMs: 30 })
    let release!: () => void
    try {
      const prepared = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      runtime.owner.playbackStatus = () => new Promise(resolve => { release = () => resolve(current) })
      await expect(client.call('service', 'associateRetainedProject', [{
        expected: { epoch: prepared.epoch, generation: '7' }, descriptor
      }])).rejects.toThrow('Box audio query timed out')
      release()
      await new Promise<void>(resolve => setImmediate(resolve))
      await expect(client.call('owner', 'startPlayback', [42, '7'])).resolves.toMatchObject({ ok: true })
    } finally { release?.(); await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects mismatched descriptor config without another native prepare', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-mismatch-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = (id: number, config: unknown, lanes: unknown) => {
      calls.push(['prepare', id, config, lanes]); current = status('7'); return { ok: true, generation: '7' }
    }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    try {
      const prepared = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      const changed = { ...descriptor, config: { ...nativeConfig, masterGain: 0.99 } }
      await expect(client.call('service', 'associateRetainedProject', [{
        expected: { epoch: prepared.epoch, generation: '7' }, descriptor: changed
      }])).rejects.toThrow('no longer matches')
      const snapshot = await client.reconcile() as { recovery?: unknown }
      expect(snapshot.recovery).toBeUndefined()
      expect(calls.filter(row => row[0] === 'prepare')).toHaveLength(1)
      runtime.owner.preparePlayback = () => ({ ok: false, generation: '0', errorCode: 'invalid-configuration' })
      expect(await client.call('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])).toMatchObject({ ok: false })
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('does not clear recovery for private monitor or capture teardown with a coincident generation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-retained-private-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    const { nativeConfig, descriptor, status } = retainedFixture()
    let current: ReturnType<typeof status> | null = null
    runtime.owner.playbackStatus = () => current
    runtime.owner.preparePlayback = () => { current = status('7'); return { ok: true, generation: '7' } }
    runtime.owner.endMonitor = (id: number, generation: string) => {
      calls.push(['endMonitor', id, generation]); return { ok: false }
    }
    runtime.owner.cancel = (id: number, generation: string) => {
      calls.push(['cancel', id, generation]); return undefined
    }
    runtime.owner.unloadPlayback = () => { throw new Error('Private teardown must not unload public playback') }
    const host = await startBoxAudioHost(path, runtime)
    const client = createBoxAudioClient(path)
    try {
      const prepared = await client.callStamped('owner', 'preparePlayback', [42, nativeConfig, descriptor.lanes])
      await client.call('service', 'associateRetainedProject', [{
        expected: { epoch: prepared.epoch, generation: '7' }, descriptor
      }])
      await client.call('owner', 'endMonitor', [51, '7'])
      await client.call('owner', 'cancel', [51, '7'])
      const snapshot = await client.reconcile() as { recovery?: { generation: string } }
      expect(snapshot.recovery?.generation).toBe('7')
      expect(current).toMatchObject({ generation: '7' })
      expect(calls).toEqual([['endMonitor', 1001, '7'], ['cancel', 1001, '7']])
    } finally { await client.shutdown(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
  it('rejects oversized incomplete frames, PCM and malformed JSON', () => {
    const parse = boxAudioLines(4, () => {})
    expect(() => parse(Buffer.from('12345'))).toThrow('too large')
    expect(() => boxAudioEncode([new Float32Array(1)])).toThrow('PCM')
    expect(() => boxAudioLines(10, () => {})(Buffer.from('{bad}\n'))).toThrow()
  })
})

/** A raw protocol peer: lets tests send malformed, partial and replayed frames. */
async function rawPeer(path: string) {
  const socket: Socket = connect(path)
  const lines: { type: string; epoch: string; id?: string; ok?: boolean; error?: string }[] = []
  let buffered = ''
  let closed = false
  socket.on('error', () => {})
  socket.on('close', () => { closed = true })
  socket.on('data', chunk => {
    buffered += chunk.toString('utf8')
    for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
      lines.push(JSON.parse(buffered.slice(0, end))); buffered = buffered.slice(end + 1)
    }
  })
  await vi.waitFor(() => { expect(closed || lines[0]?.type === 'ready').toBe(true) }, { timeout: 2000, interval: 2 })
  const epoch = lines[0]?.epoch ?? ''
  return {
    socket, lines, epoch, closed: () => closed,
    frame: (id: number | string, method = 'playbackStatus', args: unknown[] = []) =>
      JSON.stringify({ version: 1, type: 'request', epoch, id: String(id), target: 'owner', method, args }) + '\n',
    reply: (id: number | string) => lines.find(line => line.type === 'reply' && line.id === String(id)),
    waitReply: (id: number | string) => vi.waitFor(() => {
      const found = lines.find(line => line.type === 'reply' && line.id === String(id))
      expect(found).toBeDefined()
      return found!
    }, { timeout: 2000, interval: 2 }),
    waitClosed: () => vi.waitFor(() => { expect(closed).toBe(true) }, { timeout: 2000, interval: 2 })
  }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
describe.skipIf(process.platform === 'win32')('Box audio host framing and admission over a real socket', () => {
  const withHost = async (body: (path: string, runtime: BoxAudioHostRuntime, dir: string) => Promise<void>,
    setup: (runtime: BoxAudioHostRuntime) => void = () => {}) => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-wire-'))
    const path = join(dir, 'audio.sock')
    const { runtime } = fake()
    setup(runtime)
    const host = await startBoxAudioHost(path, runtime)
    try { await body(path, runtime, dir) } finally { vi.useRealTimers(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  }
  it('destroys a connection whose line exceeds the request bound', () => withHost(async path => {
    const peer = await rawPeer(path)
    const control = await rawPeer(path)
    peer.socket.write(Buffer.alloc(BOX_AUDIO_REQUEST_BYTES + 1, 0x20))
    await peer.waitClosed()
    control.socket.write(control.frame(1))
    expect((await control.waitReply(1)).ok).toBe(true)
    control.socket.destroy()
  }))
  it('closes a stalled partial frame after two seconds', () => withHost(async path => {
    const peer = await rawPeer(path)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const partial = peer.frame(2)
    peer.socket.write(peer.frame(1) + partial.slice(0, 20))
    await peer.waitReply(1) // The server parsed this chunk and armed its frame deadline.
    vi.advanceTimersByTime(1999)
    await new Promise(resolve => setImmediate(resolve))
    expect(peer.closed()).toBe(false)
    vi.advanceTimersByTime(2)
    await peer.waitClosed()
  }))
  it('restarts the frame deadline for each completed frame followed by another partial', () => withHost(async path => {
    const peer = await rawPeer(path)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const second = peer.frame(2)
    const third = peer.frame(3)
    peer.socket.write(peer.frame(1) + second.slice(0, 20))
    await peer.waitReply(1)
    vi.advanceTimersByTime(1500)
    peer.socket.write(second.slice(20) + third.slice(0, 20))
    await peer.waitReply(2)
    vi.advanceTimersByTime(1500) // 3 s since the first partial, 1.5 s since the current one.
    await new Promise(resolve => setImmediate(resolve))
    expect(peer.closed()).toBe(false)
    peer.socket.write(third.slice(20))
    expect((await peer.waitReply(3)).ok).toBe(true)
    expect(peer.closed()).toBe(false)
    peer.socket.destroy()
  }))
  it('admits at most sixteen concurrent clients', () => withHost(async path => {
    const peers = []
    for (let index = 0; index < 16; ++index) peers.push(await rawPeer(path))
    expect(peers.every(peer => !peer.closed() && peer.lines[0]?.type === 'ready')).toBe(true)
    const rejected = await rawPeer(path)
    await rejected.waitClosed()
    expect(rejected.lines).toEqual([])
    peers[0].socket.destroy()
    await peers[0].waitClosed()
    await new Promise(resolve => setTimeout(resolve, 20))
    const admitted = await rawPeer(path)
    expect(admitted.lines[0]?.type).toBe('ready')
    for (const peer of [...peers, admitted]) peer.socket.destroy()
  }))
  it.each([['replayed', 5, 5], ['decreasing', 5, 4]])('closes a connection that sends a %s request id', (_label, first, second) => withHost(async path => {
    const peer = await rawPeer(path)
    peer.socket.write(peer.frame(first))
    expect((await peer.waitReply(first)).ok).toBe(true)
    peer.socket.write(peer.frame(second))
    await peer.waitClosed()
    expect(peer.lines.filter(line => line.type === 'reply')).toHaveLength(1)
  }))
  it('rejects a connection that overflows the shared command queue', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    await withHost(async path => {
      const filler = await rawPeer(path)
      const overflow = await rawPeer(path)
      let frames = ''
      for (let id = 1; id <= BOX_AUDIO_PENDING; ++id) frames += filler.frame(id, 'startPlayback', [1, '1'])
      filler.socket.write(frames)
      await new Promise(resolve => setTimeout(resolve, 50))
      overflow.socket.write(overflow.frame(1))
      await overflow.waitClosed()
      expect(overflow.reply(1)).toBeUndefined()
      expect(filler.closed()).toBe(false)
      release()
      await vi.waitFor(() => { expect(filler.lines.filter(line => line.type === 'reply')).toHaveLength(BOX_AUDIO_PENDING) }, { timeout: 2000, interval: 5 })
      filler.socket.destroy()
    }, runtime => { runtime.owner.startPlayback = async () => { await blocked; return { ok: true } } })
  })
  it('rejects a group-accessible socket directory for both host and client', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-perm-'))
    const path = join(dir, 'audio.sock')
    try {
      await chmod(dir, 0o755)
      await expect(startBoxAudioHost(path, fake().runtime)).rejects.toThrow('must be private')
      await chmod(dir, 0o700)
      const host = await startBoxAudioHost(path, fake().runtime)
      const client = createBoxAudioClient(path)
      try {
        await chmod(dir, 0o755)
        await expect(client.call('owner', 'playbackStatus', [])).rejects.toThrow('Untrusted Box audio socket')
        await chmod(dir, 0o700)
        await expect(client.call('owner', 'playbackStatus', [])).resolves.toMatchObject({ state: 'playing' })
      } finally { await client.shutdown(); await chmod(dir, 0o700); await host.close() }
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('bounds close when an admitted native command never settles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-wedged-'))
    const path = join(dir, 'audio.sock')
    const { runtime, calls } = fake()
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    runtime.owner.startPlayback = () => { started(); return new Promise(() => {}) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = await startBoxAudioHost(path, runtime, { shutdownDeadlineMs: 50 })
    const client = createBoxAudioClient(path, { timeoutMs: 5000 })
    try {
      const wedged = client.call('owner', 'startPlayback', [1, '1']).catch(error => error)
      await entered
      const outcome = await Promise.race([host.close().then(() => 'closed'),
        new Promise(resolve => setTimeout(() => resolve('hung'), 3000))])
      expect(outcome).toBe('closed')
      expect(calls.at(-1)).toEqual(['shutdown'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('draining admitted commands exceeded 50 ms'))
      await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      await wedged
    } finally { await client.shutdown(); await rm(dir, { recursive: true, force: true }) }
  })
})
