import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { MultitrackEngine } from '../../src/renderer/src/audio/engine'
import { BoxTransport } from '../../src/renderer/src/box/transport'
import type { BoxRetainedPlaybackRestore } from '../../src/shared/box-contract'
import { GRAPH_NODE_TYPES } from '../../src/shared/graph-document'
import type { DesktopPlaybackStatus, ProjectGraphPayload, SingzApi } from '../../src/shared/types'
import {
  retainedItem as item,
  retainedLyrics as lyrics,
  retainedProject as project,
  retainedRecovery,
  retainedRestore,
  retainedStatus
} from '../shared/box-retained-native-fixture'

class Param { value = 0; setTargetAtTime(): void {}; setValueAtTime(): void {}; linearRampToValueAtTime(): void {} }
class Gain { gain = new Param(); connect(): void {}; disconnect(): void {} }
class Source {
  buffer: AudioBuffer | null = null
  playbackRate = { value: 1 }
  loop = false
  loopStart = 0
  loopEnd = 0
  onended: (() => void) | null = null
  connect(): void {}; disconnect(): void {}; start(): void {}; stop(): void {}
}
class Context {
  currentTime = 1
  state = 'running'
  sampleRate = 48000
  outputLatency = 0
  destination = {}
  sinkId: string | { type: 'none' } = { type: 'none' }
  createGain(): Gain { return new Gain() }
  createBufferSource(): Source { return new Source() }
  async setSinkId(sink: string | { type: 'none' }): Promise<void> { this.sinkId = sink }
  async resume(): Promise<void> {}
  async suspend(): Promise<void> {}
  async decodeAudioData(): Promise<AudioBuffer> {
    const samples = new Float32Array(4800).fill(0.01)
    return {
      duration: 10, length: samples.length, sampleRate: 48000, numberOfChannels: 1,
      getChannelData: () => samples,
      copyFromChannel: (destination: Float32Array, _channel: number, start = 0) => {
        destination.set(samples.subarray(start, start + destination.length))
      },
      copyToChannel: (source: Float32Array, _channel: number, start = 0) => {
        samples.set(source, start)
      }
    } as AudioBuffer
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function status(generation: string): DesktopPlaybackStatus {
  return retainedStatus(generation, 'playing', {
    loopEnabled: false, loopStartFrame: '0', loopEndFrame: '0',
    playbackRate: 1.2, transposeSemitones: 3
  })
}

function restore(generation: string, epoch = 'epoch'): BoxRetainedPlaybackRestore {
  return {
    ...retainedRestore(generation, epoch),
    recovery: retainedRecovery(status(generation))
  }
}

function restoreWithIdentity(
  patch: Partial<BoxRetainedPlaybackRestore['recovery']['descriptor']['project']>
): BoxRetainedPlaybackRestore {
  const candidate = restore('7')
  return {
    ...candidate,
    recovery: {
      ...candidate.recovery,
      descriptor: {
        ...candidate.recovery.descriptor,
        project: { ...candidate.recovery.descriptor.project, ...patch }
      }
    }
  }
}

function restoreWithGraph(gain: number): BoxRetainedPlaybackRestore {
  const text = JSON.stringify({
    format: 1,
    engine: 'singz-dsp',
    opaqueEnvelope: { preserve: ['layout', 7] },
    nodes: [{
      id: '1', type: GRAPH_NODE_TYPES.gain, typeVersion: 1, execution: 'builtin', unavailable: 'silence',
      ports: { inputs: [{ id: 'in', channels: 2 }], outputs: [{ id: 'out', channels: 2 }] },
      parameters: { gain }, opaqueNode: { x: 10 }
    }],
    connections: []
  })
  const graph: ProjectGraphPayload = {
    hash: {
      format: 1,
      md5: createHash('md5').update(text).digest('hex'),
      size: Buffer.byteLength(text),
      mtimeMs: 1
    },
    text
  }
  const candidate = restore('7')
  return {
    ...candidate,
    graph,
    recovery: {
      ...candidate.recovery,
      descriptor: {
        ...candidate.recovery.descriptor,
        project: {
          ...candidate.recovery.descriptor.project,
          graphHash: `sha256:${createHash('sha256').update(text).digest('hex')}`
        }
      }
    }
  }
}

const transports: BoxTransport[] = []
function fixture() {
  let current = status('7')
  const lifecycle = {
    prepareDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation })),
    openDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation })),
    startDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation })),
    stopDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation })),
    pauseDesktopPlayback: vi.fn(async () => {
      current = { ...current, transportState: 'paused' as const }
      return { ok: true, generation: current.generation }
    }),
    resumeDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation })),
    seekDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation })),
    unloadDesktopPlayback: vi.fn(async () => ({ ok: true, generation: current.generation, cleanupComplete: true }))
  }
  const dto = restore('7')
  const api = {
    boxAudioPersistent: true,
    box: {
      restoreRetainedPlayback: vi.fn(async () => ({
        ok: true as const,
        value: { ...dto, recovery: { ...dto.recovery, status: current } }
      })),
      retainedPlaybackSnapshot: vi.fn(async () => ({
        ok: true as const,
        value: {
          epoch: dto.epoch,
          playback: { generation: current.generation, state: current.state, transportState: current.transportState },
          recovery: { ...dto.recovery, generation: current.generation, status: current }
        }
      }))
    },
    ...lifecycle,
    desktopPlaybackStatus: vi.fn(async () => current),
    setDesktopPlaybackMasterGain: vi.fn(async () => ({ ok: true })),
    setDesktopPlaybackLane: vi.fn(async () => ({ ok: true })),
    saveProject: vi.fn(async () => ({ ok: true })),
    readAudio: vi.fn(async () => new ArrayBuffer(8)),
    registerSource: vi.fn(),
    setCurrent(next: DesktopPlaybackStatus) { current = next }
  } as unknown as SingzApi & { setCurrent(next: DesktopPlaybackStatus): void }
  vi.stubGlobal('window', { singz: api })
  const engine = new MultitrackEngine({ playback: true, requireNative: true })
  const transport = new BoxTransport(api, engine, { pollMs: 0, saveDelayMs: 600000, nativePlaybackEnabled: true })
  transports.push(transport)
  return { api, engine, transport, lifecycle, dto }
}

beforeEach(() => {
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { platform: 'Linux' })
})
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.teardown()))
  vi.unstubAllGlobals()
})

describe('BoxTransport retained restore', () => {
  it('publishes DTO project/lyrics and live native controls without reads, writes, or lifecycle commands', async () => {
    const h = fixture()
    await expect(h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })).resolves.toBe(true)
    expect(h.api.box.restoreRetainedPlayback).toHaveBeenCalledTimes(2)
    expect(h.api.box.restoreRetainedPlayback).toHaveBeenNthCalledWith(1, { epoch: 'epoch', generation: '7' })
    expect(h.api.box.restoreRetainedPlayback).toHaveBeenNthCalledWith(2, { epoch: 'epoch', generation: '7' })
    const snapshot = h.transport.getSnapshot()
    expect(snapshot.active?.item).toEqual(item)
    expect(snapshot.active?.lyrics).toEqual({ status: 'ready', lines: lyrics })
    expect(snapshot.playing).toBe(true)
    expect(snapshot.position).toBeGreaterThanOrEqual(2)
    expect(snapshot.position).toBeLessThan(2.1)
    expect(snapshot.masterVolume).toBe(0.4)
    expect(snapshot.tempo).toBe(1.2)
    expect(snapshot.transpose).toBe(3)
    expect(snapshot.tracks).toEqual([{ id: 'vocals', volume: 0.35, muted: true, solo: false }])
    expect(snapshot.active?.project.settings).toMatchObject({ masterVolume: 0.4, tempo: 1.2, transpose: 3 })
    expect(h.api.readAudio).not.toHaveBeenCalled()
    expect(h.api.registerSource).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()

    await h.transport.controllerPlayPause()
    expect(h.lifecycle.pauseDesktopPlayback).toHaveBeenCalledWith('7')
    expect(h.transport.getSnapshot().playing).toBe(false)
  })

  it.each(['0', '144000'])('restores a never-played stopped song at frame %s with accepted gain', async frame => {
    const h = fixture()
    const stopped = retainedStatus('7', 'stopped', { renderedProjectFrame: frame, audibleProjectFrame: frame, masterGain: 0.23 })
    h.api.setCurrent(stopped)
    vi.mocked(h.api.box.restoreRetainedPlayback).mockResolvedValue({ ok: true, value: { ...restore('7'), recovery: retainedRecovery(stopped) } })
    await expect(h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })).resolves.toBe(true)
    expect(h.transport.getSnapshot()).toMatchObject({ playing: false, position: Number(frame) / 48000, masterVolume: 0.23 })
    expect(h.transport.getSnapshot().active?.project.settings).toMatchObject({ masterVolume: 0.23, tempo: 1.25, transpose: 2 })
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('commits fresh second-read frames, controls, route, project, and item rather than the initial DTO', async () => {
    const h = fixture()
    const freshStatus: DesktopPlaybackStatus = {
      ...status('7'),
      renderedProjectFrame: '144000', audibleProjectFrame: '144000', continuousFrame: '144000',
      playbackRate: 1.1, transposeSemitones: 4, masterGain: 0.55,
      lanes: [{ ...status('7').lanes[0], cursorFrames: '144000', gain: 0.65, muted: false }]
    }
    const freshRecovery = retainedRecovery(freshStatus)
    const fresh: BoxRetainedPlaybackRestore = {
      ...restore('7'),
      item: { ...item, savedAt: 'fresh-item' },
      project: {
        ...project,
        sourceMissing: true,
        settings: { ...project.settings, view: { s: 4, e: 8 } }
      },
      recovery: {
        ...freshRecovery,
        descriptor: {
          ...freshRecovery.descriptor,
          config: { ...freshRecovery.descriptor.config, outputDeviceUid: 'hw:Fresh' }
        }
      }
    }
    let reads = 0
    h.api.setCurrent(freshStatus)
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => ({
      ok: true as const,
      value: ++reads === 1 ? restore('7') : fresh
    }))

    await expect(h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })).resolves.toBe(true)

    expect(reads).toBe(2)
    const snapshot = h.transport.getSnapshot()
    expect(snapshot.position).toBeGreaterThanOrEqual(3)
    expect(snapshot.position).toBeLessThan(3.1)
    expect(snapshot.tracks).toEqual([{ id: 'vocals', volume: 0.65, muted: false, solo: false }])
    expect(snapshot).toMatchObject({ masterVolume: 0.55, tempo: 1.1, transpose: 4, appliedOutputUid: 'hw:Fresh' })
    expect(snapshot.active?.item.savedAt).toBe('fresh-item')
    expect(snapshot.active?.project.sourceMissing).toBe(true)
    expect(snapshot.active?.project.settings).toMatchObject({
      view: { s: 4, e: 8 }, masterVolume: 0.55, tempo: 1.1, transpose: 4
    })
    expect(h.api.saveProject).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('accepts the same valid non-null graph on both reads without lifecycle or persistence', async () => {
    const h = fixture()
    const withGraph = restoreWithGraph(0.5)
    let reads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => {
      reads++
      return { ok: true as const, value: withGraph }
    })

    await expect(h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })).resolves.toBe(true)

    expect(reads).toBe(2)
    expect(h.engine.nativeActive).toBe(true)
    expect(h.transport.getSnapshot().active?.item).toEqual(item)
    expect(h.transport.getSnapshot().active?.project).toMatchObject({ dir: project.dir, name: project.name })
    expect(h.transport.getSnapshot().active?.lyrics).toEqual({ status: 'ready', lines: lyrics })
    expect(h.api.readAudio).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('rejects a changed non-null graph SHA on the second read before attachment', async () => {
    const h = fixture()
    let reads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => ({
      ok: true as const,
      value: ++reads === 1 ? restoreWithGraph(0.5) : restoreWithGraph(0.6)
    }))
    const restoring = h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })
    await expect(restoring).rejects.toThrow('files or canonical project identity changed')
    expect(reads).toBe(2)
    expect(h.transport.getSnapshot().active).toBeNull()
    expect(h.engine.nativeActive).toBe(false)
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('throws on a host epoch change after the DTO await, with no engine or native mutation', async () => {
    const h = fixture()
    const pending = deferred<ReturnType<typeof restore>>()
    let reads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => {
      if (++reads === 1) return { ok: true as const, value: restore('7') }
      const changed = await pending.promise
      return { ok: true as const, value: changed }
    })
    const restoring = h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })
    const observed = expect(restoring).rejects.toThrow('identity changed before restore')
    await vi.waitFor(() => expect(h.api.box.restoreRetainedPlayback).toHaveBeenCalledTimes(2))
    pending.resolve(restore('7', 'epoch-changed'))
    await observed
    expect(reads).toBe(2)
    expect(h.transport.getSnapshot().active).toBeNull()
    expect(h.engine.nativeActive).toBe(false)
    expect(h.engine.getTrackStates()).toEqual([])
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('rejects a missing second-read recovery after exactly two reads', async () => {
    const h = fixture()
    const malformed = JSON.parse(JSON.stringify({ ...restore('7'), recovery: undefined }))
    let reads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => ({
      ok: true as const,
      value: ++reads === 1 ? restore('7') : malformed
    }))
    const restoring = h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })
    await expect(restoring).rejects.toThrow('recovery is unavailable')
    expect(reads).toBe(2)
    expect(h.transport.getSnapshot().active).toBeNull()
    expect(h.engine.nativeActive).toBe(false)
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it.each(['playing', 'pre-roll', 'paused', 'completed'] as const)('admits running/running %s without lifecycle or DSP commands', async transportState => {
    const h = fixture()
    h.api.setCurrent({ ...status('7'), transportState })
    await expect(h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })).resolves.toBe(true)
    expect(h.transport.getSnapshot().active).not.toBeNull()
    expect(h.transport.getSnapshot().playing).toBe(transportState === 'playing' || transportState === 'pre-roll')
    expect(h.engine.nativeActive).toBe(true)
    expect(h.api.readAudio).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    expect(h.api.setDesktopPlaybackMasterGain).not.toHaveBeenCalled()
    expect(h.api.setDesktopPlaybackLane).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it.each([
    { state: 'output-open', hostState: 'open', transportState: 'paused' },
    { state: 'output-open', hostState: 'open', transportState: 'completed' },
    { state: 'output-open', hostState: 'running', transportState: 'paused' },
    { state: 'running', hostState: 'open', transportState: 'paused' }
  ] as const)('rejects initial $state/$hostState/$transportState before active-state mutation or native calls', async overrides => {
    const h = fixture()
    h.api.setCurrent(retainedStatus('7', 'playing', overrides))
    await expect(h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })).rejects.toThrow('not commandable')
    expect(h.api.box.restoreRetainedPlayback).toHaveBeenCalledOnce()
    expect(h.transport.getSnapshot().active).toBeNull()
    expect(h.engine.nativeActive).toBe(false)
    expect(h.engine.getTrackStates()).toEqual([])
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    expect(h.api.readAudio).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    expect(h.api.setDesktopPlaybackMasterGain).not.toHaveBeenCalled()
    expect(h.api.setDesktopPlaybackLane).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it.each([
    ['output-open/open/paused', () => ({
      ...restore('7'),
      recovery: retainedRecovery(retainedStatus('7', 'paused', { state: 'output-open', hostState: 'open' }))
    }), 'not commandable'],
    ['stopped', () => ({
      ...restore('7'),
      recovery: retainedRecovery(retainedStatus('7', 'stopped', { state: 'stopped', hostState: 'stopped' }))
    }), 'not commandable'],
    ['host closed', () => ({
      ...restore('7'),
      recovery: retainedRecovery(retainedStatus('7', 'paused', { state: 'output-open', hostState: 'closed' }))
    }), 'not commandable'],
    ['terminal reason', () => ({
      ...restore('7'),
      recovery: retainedRecovery(retainedStatus('7', 'playing', { terminalReason: 'device-lost' }))
    }), 'not commandable'],
    ['changed graph', () => restoreWithIdentity({ graphHash: `sha256:${'c'.repeat(64)}` }),
      'identity changed before restore'],
    ['changed lyrics file', () => restoreWithIdentity({ lyricsHash: `sha256:${'c'.repeat(64)}` }),
      'files or canonical project identity changed'],
    ['changed metadata file', () => restoreWithIdentity({ metadataHash: `sha256:${'c'.repeat(64)}` }),
      'files or canonical project identity changed'],
    ['changed media binding', () => restoreWithIdentity({
      media: [{ id: 'vocals', path: '/song/vocals.flac', size: '2', mtimeMs: 1 }]
    }), 'files or canonical project identity changed']
  ])('rejects a second-read %s without partial attach', async (_label, changed, message) => {
    const h = fixture()
    let reads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => ({
      ok: true as const,
      value: ++reads === 1 ? restore('7') : changed()
    }))
    const restoring = h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })
    await expect(restoring).rejects.toThrow(message)
    expect(reads).toBe(2)
    expect(h.transport.getSnapshot().active).toBeNull()
    expect(h.engine.nativeActive).toBe(false)
    expect(h.engine.getTrackStates()).toEqual([])
    expect(h.api.desktopPlaybackStatus).not.toHaveBeenCalled()
    expect(h.api.saveProject).not.toHaveBeenCalled()
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('cannot let an older DTO callback override a newer restored song', async () => {
    const h = fixture()
    const older = deferred<ReturnType<typeof restore>>()
    const newer: BoxRetainedPlaybackRestore = {
      ...restore('8'),
      item: { ...item, savedAt: 'newer-B' },
      project: { ...project, settings: { ...project.settings, view: { s: 7, e: 9 } } }
    }
    let olderReads = 0
    let newerReads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async expected => {
      if (expected.generation === '7') {
        olderReads++
        const value = await older.promise
        return { ok: true as const, value }
      }
      newerReads++
      h.api.setCurrent(status('8'))
      return { ok: true as const, value: newer }
    })
    const first = h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })
    const firstObserved = expect(first).resolves.toBe(false)
    const second = h.transport.restoreRetained({ epoch: 'epoch', generation: '8' })
    await expect(second).resolves.toBe(true)
    older.resolve(restore('7'))
    await firstObserved
    expect(olderReads).toBe(1)
    expect(newerReads).toBe(2)
    expect(h.engine.nativeActive).toBe(true)
    expect((await h.api.desktopPlaybackStatus()).generation).toBe('8')
    expect(h.transport.getSnapshot().active?.item.savedAt).toBe('newer-B')
    expect(h.transport.getSnapshot().active?.project.settings.view).toEqual({ s: 7, e: 9 })
    expect(h.transport.getSnapshot().tempo).toBe(1.2)
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('returns false for disposal while the final host check is awaited', async () => {
    const h = fixture()
    const pending = deferred<void>()
    let reads = 0
    vi.mocked(h.api.box.restoreRetainedPlayback).mockImplementation(async () => {
      if (++reads === 1) return { ok: true as const, value: restore('7') }
      await pending.promise
      return { ok: true as const, value: restore('7') }
    })
    const restoring = h.transport.restoreRetained({ epoch: 'epoch', generation: '7' })
    const observed = expect(restoring).resolves.toBe(false)
    await vi.waitFor(() => expect(h.api.box.restoreRetainedPlayback).toHaveBeenCalledTimes(2))
    const closing = h.transport.teardown()
    pending.resolve()
    await observed
    await closing
    expect(reads).toBe(2)
    expect(h.transport.getSnapshot().active).toBeNull()
    expect(h.engine.nativeActive).toBe(false)
    for (const call of Object.values(h.lifecycle)) expect(call).not.toHaveBeenCalled()
  })

  it('sets normal persistent Box project identity before load', async () => {
    const h = fixture()
    vi.mocked(h.api.box.retainedPlaybackSnapshot).mockResolvedValue({
      ok: true, value: { epoch: 'epoch', playback: null }
    })
    vi.mocked(h.api.registerSource).mockResolvedValue({
      ok: true, path: item.songPath, name: item.name, size: 1, project: {
        ...project,
        settings: { transpose: 0, tempo: 1, masterVolume: 1, tracks: {} }
      }
    })
    Object.assign(h.api, {
      readProjectGraph: vi.fn(async () => ({ ok: true, graph: null })),
      getCachedLyrics: vi.fn(async () => ({ ok: true, cached: true, source: 'edited', lines: lyrics }))
    })
    const ordinary = new MultitrackEngine({ playback: false })
    const ordinaryTransport = new BoxTransport(h.api, ordinary, { pollMs: 0, nativePlaybackEnabled: false })
    transports.push(ordinaryTransport)
    const events: string[] = []
    const identify = ordinary.setRetainedProjectIdentity.bind(ordinary)
    vi.spyOn(ordinary, 'setRetainedProjectIdentity').mockImplementation(identity => {
      events.push(`identity:${identity?.dir}`)
      identify(identity)
    })
    const load = ordinary.load.bind(ordinary)
    vi.spyOn(ordinary, 'load').mockImplementation((tracks, opts) => {
      events.push('load')
      load(tracks, opts)
    })
    await expect(ordinaryTransport.open(item)).resolves.toBe(true)
    expect(events).toEqual(['identity:/song', 'load'])
  })
})
