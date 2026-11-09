import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineTrackInput, TrackState } from '../../src/renderer/src/audio/engine'
import type { ParsedGraphDocument } from '../../src/shared/graph-document'
import type { DesktopAudioHostDevice, DesktopAudioHostInventoryResult, ProjectInfo, ProjectListItem, ProjectSettings, SingzApi } from '../../src/shared/types'
import { BoxTransport, type BoxEngine } from '../../src/renderer/src/box/transport'
import { LatestOpenIntent } from '../../src/renderer/src/box/open-intent'

class FakeEngine implements BoxEngine {
  duration = 0
  position = 0
  playing = false
  starting = false
  masterVolume = 1
  transpose = 0
  tempo = 1
  playbackError = null
  outputDeviceId = ''
  tracks: TrackState[] = []
  loaded: { tracks: EngineTrackInput[]; opts: { position?: number; play?: boolean; graphDocument?: ParsedGraphDocument | null } }[] = []
  outputCalls: string[] = []
  retireCount = 0
  teardownCount = 0
  private listeners = new Set<() => void>()

  load(tracks: EngineTrackInput[], opts: { position?: number; play?: boolean; graphDocument?: ParsedGraphDocument | null }): void {
    this.loaded.push({ tracks, opts })
    this.duration = Math.max(...tracks.map(track => track.duration))
    this.position = opts.position ?? 0
    this.playing = opts.play === true
    this.tracks = tracks.map(track => ({ id: track.id, volume: 1, muted: false, solo: false }))
  }
  async decode(): Promise<AudioBuffer> {
    const samples = new Float32Array(1200)
    return {
      duration: 12,
      length: samples.length,
      sampleRate: 48000,
      numberOfChannels: 1,
      getChannelData: () => samples,
      copyFromChannel: (destination: Float32Array, _channel: number, start = 0, end = samples.length) => {
        destination.set(samples.subarray(start, end))
      },
      copyToChannel: (source: Float32Array, _channel: number, start = 0) => {
        samples.set(source, start)
      }
    } as AudioBuffer
  }
  async play(): Promise<void> { this.playing = true }
  pause(): void { this.playing = false }
  toggle(): void { this.playing = !this.playing }
  seek(position: number): void { this.position = Math.max(0, Math.min(this.duration, position)) }
  seekBy(delta: number): void { this.seek(this.position + delta) }
  setVolume(id: string, volume: number): void { const track = this.tracks.find(t => t.id === id); if (track) track.volume = volume }
  setMuted(id: string, muted: boolean): void { const track = this.tracks.find(t => t.id === id); if (track) track.muted = muted }
  setSolo(id: string, solo: boolean): void { const track = this.tracks.find(t => t.id === id); if (track) track.solo = solo }
  setMasterVolume(volume: number): void { this.masterVolume = volume }
  async setVolumeAccepted(id: string, volume: number): Promise<void> { this.setVolume(id, volume) }
  async setMutedAccepted(id: string, muted: boolean): Promise<void> { this.setMuted(id, muted) }
  async setSoloAccepted(id: string, solo: boolean): Promise<void> { this.setSolo(id, solo) }
  async setMasterVolumeAccepted(volume: number): Promise<void> { this.setMasterVolume(volume) }
  async setTranspose(value: number): Promise<void> { this.transpose = value }
  async setTempo(value: number): Promise<void> { this.tempo = value }
  async setBeats(): Promise<void> {}
  async setMetronome(): Promise<void> {}
  async setTraining(): Promise<void> {}
  async setRegion(): Promise<void> {}
  getTrackStates(): TrackState[] { return this.tracks.map(track => ({ ...track })) }
  setLaneReader(): void {}
  retireForSongSwitch(): void { this.retireCount++; this.playing = false }
  async setOutput(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId
    this.outputCalls.push(deviceId)
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async teardown(): Promise<void> { this.teardownCount++ }
  async detachPersistentPlayback(): Promise<void> {}
}

const stems = { vocals: '/a/vocals.flac', drums: '/a/drums.flac', bass: '/a/bass.flac', other: '/a/other.flac' }
const item = (dir = '/a', name = 'Song A'): ProjectListItem => ({ dir, name, songPath: `${dir}/original.wav`, savedAt: '', hasStems: true, stemCount: 4, hasLyrics: true, bytes: 1 })
const project = (dir = '/a', overrides: Partial<ProjectInfo> = {}): ProjectInfo => ({
  dir, name: `Song ${dir.slice(-1).toUpperCase()}`, sourceMissing: true, formatVersion: 2,
  settings: { transpose: 2, tempo: 0.95, masterVolume: 0.8, tracks: { vocals: { volume: 0.5, muted: true, solo: false } } },
  stems: Object.fromEntries(Object.entries(stems).map(([id, path]) => [id, path.replace('/a/', `${dir}/`)])),
  hasLyrics: true, inLibrary: true, ...overrides
})
const lines = [{ start: 0, end: 2, text: 'Actual lyric', words: [{ w: 'Actual', s: 0, e: 0.8 }, { w: 'lyric', s: 0.9, e: 1.5 }] }]
const lyricResult = { ok: true as const, cached: true as const, source: 'edited' as const, lines }

const outputDevice = (uid: string): DesktopAudioHostDevice => ({
  uid,
  label: `Output ${uid}`,
  defaultInput: false,
  defaultOutput: false,
  inputChannels: 0,
  outputChannels: 2,
  inputChannelLabels: [],
  outputChannelLabels: ['Left', 'Right'],
  nominalSampleRate: 48000,
  direction: 'output',
  accessMode: 'shared',
  transport: 'usb',
  monitoringSuitability: 'unknown',
  sampleRateRanges: [{ minimumHz: 44100, maximumHz: 48000 }],
  bufferFrames: { minimumFrames: 64, maximumFrames: 1024, preferredFrames: 256, fundamentalFrames: 64 }
})

const alsaInventory = (...uids: string[]): DesktopAudioHostInventoryResult => ({
  ok: true,
  platform: 'linux',
  provider: 'alsa',
  defaultInputUid: '',
  defaultOutputUid: uids[0] ?? '',
  devices: uids.map(outputDevice)
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function host(registrations: Record<string, () => ReturnType<typeof deferred<unknown>>['promise'] | unknown> = {}) {
  const saves: { songPath: string; settings: ProjectSettings }[] = []
  const api = {
    registerSource: vi.fn(async (path: string) => {
      const dir = path.split('/')[1]
      const custom = registrations[dir]
      if (custom) return await custom()
      return { ok: true, path, name: `Song ${dir.slice(-1).toUpperCase()}`, size: 0, project: project(`/${dir}`) }
    }),
    readProjectGraph: vi.fn(async () => ({ ok: true as const, graph: null })),
    getCachedLyrics: vi.fn(async () => lyricResult),
    readAudio: vi.fn(async () => new ArrayBuffer(8)),
    audioHostDevices: vi.fn(async () => alsaInventory('flow', 'hdmi')),
    saveProject: vi.fn(async (songPath: string, _name: string, settings: ProjectSettings) => {
      saves.push({ songPath, settings })
      return { ok: true as const, dir: songPath.split('/').slice(0, -1).join('/'), songPath, inLibrary: true }
    })
  }
  return { api: api as unknown as SingzApi, saves }
}

const live: BoxTransport[] = []
function makeTransport(api: SingzApi): { transport: BoxTransport; engine: FakeEngine } {
  const engine = new FakeEngine()
  const transport = new BoxTransport(api, engine, { pollMs: 0, saveDelayMs: 600000 })
  live.push(transport)
  return { transport, engine }
}

afterEach(async () => {
  await Promise.all(live.splice(0).map(transport => transport.teardown()))
})

describe('BoxTransport', () => {
  it('opens stem-only projects paused and restores actual lyrics and saved settings', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    const snapshot = transport.getSnapshot()
    expect(snapshot.active?.project.sourceMissing).toBe(true)
    expect(snapshot.active?.lyrics).toEqual({ status: 'ready', lines })
    expect(snapshot.playing).toBe(false)
    expect(snapshot.position).toBe(0)
    expect(snapshot.transpose).toBe(2)
    expect(snapshot.tempo).toBe(0.95)
    expect(snapshot.masterVolume).toBe(0.8)
    expect(snapshot.tracks.find(track => track.id === 'vocals')).toMatchObject({ volume: 0.5, muted: true })
    expect(engine.loaded).toHaveLength(1)
    expect(engine.loaded[0].opts).toMatchObject({ play: false, position: 0, graphDocument: null })
  })

  it('drops a late generation instead of replacing the newer paused song', async () => {
    const slow = deferred<unknown>()
    const { api } = host({ a: () => slow.promise })
    const { transport, engine } = makeTransport(api)
    const first = transport.open(item('/a', 'Slow A'))
    const second = transport.open(item('/b', 'New B'))
    expect(await second).toBe(true)
    slow.resolve({ ok: true, path: '/a/original.wav', name: 'Slow A', size: 0, project: project('/a') })
    expect(await first).toBe(false)
    expect(engine.loaded).toHaveLength(1)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
    expect(transport.getSnapshot().playing).toBe(false)
  })

  it('keeps the active transport when a replacement fails validation', async () => {
    const { api } = host({
      b: () => ({ ok: true, path: '/b/original.wav', name: 'Bad B', size: 0, project: project('/b', { damaged: ['vocals.flac'] }) })
    })
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.toggle()
    const retires = engine.retireCount
    expect(await transport.open(item('/b', 'Bad B'))).toBe(false)
    expect(transport.getSnapshot().active?.item.dir).toBe('/a')
    expect(transport.getSnapshot().playing).toBe(true)
    expect(engine.retireCount).toBe(retires)
    expect(engine.loaded).toHaveLength(1)
    expect(transport.getSnapshot().lastError).toContain('vocals.flac')
  })

  it('persists absolute mix values without allowing a late save to restore an old song or gain', async () => {
    const { api, saves } = host()
    const { transport } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.setVolume('vocals', 0.35)
    transport.setMuted('drums', true)
    transport.setSolo('bass', true)
    transport.setMasterVolume(0.65)
    await transport.flushPersistence()
    expect(saves).toHaveLength(1)
    expect(saves[0].settings.tracks.vocals).toMatchObject({ volume: 0.35, muted: true })
    expect(saves[0].settings.tracks.drums).toMatchObject({ muted: true })
    expect(saves[0].settings.tracks.bass).toMatchObject({ solo: true })
    expect(saves[0].settings.masterVolume).toBe(0.65)

    const pending = deferred<{ ok: true; dir: string; songPath: string; inLibrary: boolean }>()
    vi.mocked(api.saveProject).mockImplementationOnce(() => pending.promise as ReturnType<SingzApi['saveProject']>)
    transport.setVolume('vocals', 0.9)
    const save = transport.flushPersistence()
    const opening = transport.open(item('/b', 'New B'))
    await opening
    pending.resolve({ ok: true, dir: '/a', songPath: '/a/original.wav', inLibrary: true })
    await save
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
    expect(transport.getSnapshot().active?.project.settings.masterVolume).toBe(0.8)
    expect(transport.getSnapshot().tracks.find(track => track.id === 'vocals')?.volume).toBe(0.5)
  })
})


describe('BoxTransport ownership and failure regressions', () => {
  it('keeps the winning song identity and engine state when a structural setter finishes late', async () => {
    const { api } = host({
      b: () => ({
        ok: true,
        path: '/b/original.wav',
        name: 'Winning B',
        size: 0,
        project: project('/b', { settings: { transpose: 6, tempo: 1.1, masterVolume: 0.4, tracks: {} } })
      })
    })
    const { transport, engine } = makeTransport(api)
    const slow = deferred<void>()
    vi.spyOn(engine, 'setTranspose').mockImplementationOnce(async value => {
      engine.transpose = value
      await slow.promise
    })
    const first = transport.open(item('/a', 'Stale A'))
    await vi.waitFor(() => expect(transport.getSnapshot().committing).toBe(true))
    expect(transport.cancelOpen()).toBe(false)
    const second = transport.open(item('/b', 'Winning B'))
    await Promise.resolve()
    expect(engine.loaded).toHaveLength(0)
    slow.resolve()
    expect(await first).toBe(false)
    expect(await second).toBe(true)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
    expect(engine.transpose).toBe(6)
    expect(engine.tempo).toBe(1.1)
    expect(engine.masterVolume).toBe(0.4)
    expect(engine.loaded).toHaveLength(1)
  })

  it('reports a rejected structural operation and lets the next project own the engine', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    vi.spyOn(engine, 'setTempo').mockRejectedValueOnce(new Error('stretch failed'))
    expect(await transport.open(item('/a', 'Rejected A'))).toBe(false)
    expect(transport.getSnapshot().lastError).toBe('stretch failed')
    expect(await transport.open(item('/b', 'Healthy B'))).toBe(true)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
    expect(engine.tempo).toBe(0.95)
  })

  it('saves only an accepted delayed gain and never treats a rejected gain as accepted', async () => {
    const { api, saves } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    const receipt = deferred<void>()
    vi.spyOn(engine, 'setVolumeAccepted').mockImplementationOnce(() => receipt.promise)
    transport.setVolume('vocals', 0.9)
    const flushing = transport.flushPersistence()
    expect(saves).toHaveLength(0)
    engine.setVolume('vocals', 0.9)
    receipt.resolve()
    await flushing
    expect(saves).toHaveLength(1)
    expect(saves[0].settings.tracks.vocals.volume).toBe(0.9)

    vi.spyOn(engine, 'setVolumeAccepted').mockRejectedValueOnce(new Error('gain refused'))
    transport.setVolume('vocals', 0.2)
    await transport.flushPersistence()
    expect(saves).toHaveLength(1)
    expect(transport.getSnapshot().saveError).toBe('gain refused')
    expect(transport.getSnapshot().tracks.find(track => track.id === 'vocals')?.volume).toBe(0.9)
  })

  it('includes controls queued after a flush begins but never lets them touch the next song', async () => {
    const { api, saves } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    const first = deferred<void>()
    const second = deferred<void>()
    const control = vi.spyOn(engine, 'setVolumeAccepted')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    transport.setVolume('vocals', 0.6)
    const flushing = transport.flushPersistence()
    transport.setVolume('vocals', 0.4)
    const opening = transport.open(item('/b', 'Next B'))
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1))
    engine.setVolume('vocals', 0.6)
    first.resolve()
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(2))
    engine.setVolume('vocals', 0.4)
    second.resolve()
    expect(await opening).toBe(true)
    await flushing
    const savedA = saves.find(save => save.songPath.startsWith('/a/'))
    expect(savedA?.settings.tracks.vocals.volume).toBe(0.4)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
    expect(transport.getSnapshot().tracks.find(track => track.id === 'vocals')?.volume).toBe(0.5)
    expect(engine.tempo).toBe(0.95)
  })

  it('refuses a queued old-owner control after a replacement open has begun', async () => {
    const slow = deferred<unknown>()
    const { api } = host({ b: () => slow.promise })
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    const opening = transport.open(item('/b', 'Next B'))
    const control = vi.spyOn(engine, 'setVolumeAccepted')
    transport.setVolume('vocals', 0.1)
    expect(control).not.toHaveBeenCalled()
    slow.resolve({ ok: true, path: '/b/original.wav', name: 'Next B', size: 0, project: project('/b') })
    expect(await opening).toBe(true)
    expect(transport.getSnapshot().tracks.find(track => track.id === 'vocals')?.volume).toBe(0.5)
  })

  it('continues a pending B save after A fails and retains A for an explicit retry', async () => {
    const { api, saves } = host()
    vi.mocked(api.saveProject).mockImplementation(async (songPath, _name, settings) => {
      saves.push({ songPath, settings })
      if (songPath.startsWith('/a/')) return { ok: false as const, error: 'A write refused' }
      return { ok: true as const, dir: '/b', songPath, inLibrary: true }
    })
    const { transport } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.setVolume('vocals', 0.7)
    await transport.flushPersistence()
    expect(transport.getSnapshot().saveError).toBe('A write refused')
    await transport.open(item('/b', 'Next B'))
    transport.setVolume('vocals', 0.4)
    await transport.flushPersistence()
    expect(saves.some(save => save.songPath.startsWith('/b/') && save.settings.tracks.vocals.volume === 0.4)).toBe(true)
    expect(transport.getSnapshot().saveError).toBeNull()

    vi.mocked(api.saveProject).mockImplementation(async (songPath, _name, settings) => {
      saves.push({ songPath, settings })
      return { ok: true as const, dir: '/a', songPath, inLibrary: true }
    })
    await transport.open(item('/a', 'Retry A'))
    await transport.flushPersistence()
    expect(transport.getSnapshot().saveError).toBeNull()
    expect(saves.filter(save => save.songPath.startsWith('/a/')).some(save => save.settings.tracks.vocals.volume === 0.7)).toBe(true)
  })

  it('flushes final accepted settings on immediate teardown and releases the engine after save failure', async () => {
    const { api, saves } = host()
    vi.mocked(api.saveProject).mockRejectedValue(new Error('disk full'))
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.setVolume('vocals', 0.8)
    await transport.teardown()
    expect(vi.mocked(api.saveProject).mock.calls[0]?.[2].tracks.vocals.volume).toBe(0.8)
    expect(engine.teardownCount).toBe(1)
  })

  it('rejects missing cached lyrics without retiring a valid playing song and blocks controller play', async () => {
    const { api } = host()
    vi.mocked(api.getCachedLyrics).mockResolvedValue({ ok: true as const, cached: false as const })
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item('/a', 'Missing A'))).toBe(false)
    transport.toggle()
    expect(engine.playing).toBe(false)

    vi.mocked(api.getCachedLyrics).mockResolvedValue(lyricResult)
    await transport.open(item('/a', 'Valid A'))
    transport.toggle()
    expect(engine.playing).toBe(true)
    vi.mocked(api.getCachedLyrics).mockImplementation(async path => path.startsWith('/b/')
      ? { ok: true as const, cached: false as const }
      : lyricResult)
    expect(await transport.open(item('/b', 'Missing B'))).toBe(false)
    expect(transport.getSnapshot().active?.item.dir).toBe('/a')
    expect(engine.playing).toBe(true)
    expect(engine.loaded).toHaveLength(1)
  })

  it('cancels navigation intent before commit without replacing the current song or route owner', async () => {
    const slow = deferred<unknown>()
    const { api } = host({ b: () => slow.promise })
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.toggle()
    const navigation = new LatestOpenIntent()
    const intent = navigation.begin()
    const opening = transport.open(item('/b', 'Cancelled B'))
    navigation.cancel()
    expect(transport.cancelOpen()).toBe(true)
    slow.resolve({ ok: true, path: '/b/original.wav', name: 'Cancelled B', size: 0, project: project('/b') })
    expect(await opening).toBe(false)
    expect(navigation.isCurrent(intent)).toBe(false)
    expect(transport.getSnapshot().active?.item.dir).toBe('/a')
    expect(engine.playing).toBe(true)
    expect(engine.loaded).toHaveLength(1)
  })

  async function expectActiveSongControllable(transport: BoxTransport, engine: FakeEngine): Promise<void> {
    Object.assign(engine, { pauseAccepted: async () => { engine.playing = false } })
    await transport.controllerPlayPause()
    expect(engine.playing).toBe(false)
    await transport.controllerPlay('/a')
    expect(engine.playing).toBe(true)
    await transport.controllerMix({ type: 'volume', target: 'drums', value: 0.3 })
    transport.setVolume('bass', 0.2)
    transport.setMasterVolume(0.6)
    await transport.flushPersistence()
    const tracks = transport.getSnapshot().tracks
    expect(tracks.find(track => track.id === 'drums')?.volume).toBe(0.3)
    expect(tracks.find(track => track.id === 'bass')?.volume).toBe(0.2)
    expect(engine.masterVolume).toBe(0.6)
  }

  it('keeps the still-active song controllable after a replacement open fails', async () => {
    const { api } = host()
    vi.mocked(api.getCachedLyrics).mockImplementation(async path => path.startsWith('/b/')
      ? { ok: true as const, cached: false as const }
      : lyricResult)
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.toggle()
    expect(await transport.open(item('/b', 'Missing B'))).toBe(false)
    expect(transport.getSnapshot().active?.item.dir).toBe('/a')
    await expectActiveSongControllable(transport, engine)
  })

  it('keeps the still-active song controllable after a replacement open is cancelled', async () => {
    const slow = deferred<unknown>()
    const { api } = host({ b: () => slow.promise })
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    transport.toggle()
    const opening = transport.open(item('/b', 'Cancelled B'))
    expect(transport.cancelOpen()).toBe(true)
    await expectActiveSongControllable(transport, engine)
    slow.resolve({ ok: true, path: '/b/original.wav', name: 'Cancelled B', size: 0, project: project('/b') })
    expect(await opening).toBe(false)
    expect(transport.getSnapshot().active?.item.dir).toBe('/a')
    transport.setVolume('other', 0.4)
    await transport.flushPersistence()
    expect(transport.getSnapshot().tracks.find(track => track.id === 'other')?.volume).toBe(0.4)
  })
})

describe('Box output routing', () => {
  it('pauses without autoplay and publishes the opaque UID only after accepted setOutput', async () => {
    const rawUid = 'usb:FLOW 8/left'
    const { api } = host()
    vi.mocked(api.audioHostDevices).mockResolvedValue(alsaInventory(rawUid))
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    transport.toggle()
    const receipt = deferred<void>()
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      await receipt.promise
    })

    const applying = transport.applyOutput(rawUid)
    expect(engine.playing).toBe(false)
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith(`native:${rawUid}`))
    expect(transport.getSnapshot().applyingOutput).toBe(true)
    expect(transport.getSnapshot().appliedOutputUid).toBeNull()
    expect(engine.outputDeviceId).toBe(`native:${rawUid}`)
    expect(engine.playing).toBe(false)
    transport.toggle()
    expect(engine.playing).toBe(false)
    const position = engine.position
    transport.seek(position + 1)
    transport.seekBy(1)
    expect(engine.position).toBe(position)

    receipt.resolve()
    await applying
    expect(transport.getSnapshot()).toMatchObject({
      applyingOutput: false,
      appliedOutputUid: rawUid,
      outputError: null,
      routingBlocked: false,
      playing: false
    })
    expect(api.audioHostDevices).toHaveBeenCalledWith('alsa')
  })

  it('rejects a disappeared device without a default-route fallback', async () => {
    const { api } = host()
    vi.mocked(api.audioHostDevices).mockResolvedValue(alsaInventory('another-output'))
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    transport.toggle()
    const setOutput = vi.spyOn(engine, 'setOutput')

    await expect(transport.applyOutput('missing-output')).rejects.toThrow('no longer connected')
    expect(setOutput).not.toHaveBeenCalled()
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: null,
      applyingOutput: false,
      routingBlocked: false,
      playing: false
    })
    expect(engine.outputDeviceId).toBe('')
  })

  it('keeps the committed route and permits Play after a confirmed rollback', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    await transport.applyOutput('flow')
    engine.outputCalls = []
    vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      if (deviceId === 'native:hdmi') throw new Error('HDMI refused')
    })

    await expect(transport.applyOutput('hdmi')).rejects.toThrow('HDMI refused')
    expect(engine.outputCalls).toEqual(['native:hdmi', 'native:flow'])
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: 'flow',
      outputError: 'HDMI refused',
      routingBlocked: false,
      playing: false
    })
    transport.toggle()
    expect(engine.playing).toBe(true)
  })

  it('clears the visible UID after rollback failure and permits an explicit same-device retry', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    await transport.applyOutput('flow')
    let rollbackFailed = false
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      if (deviceId === 'native:hdmi') throw new Error('HDMI handoff failed')
      if (deviceId === 'native:flow' && !rollbackFailed) {
        rollbackFailed = true
        throw new Error('FLOW rollback failed')
      }
    })

    await expect(transport.applyOutput('hdmi')).rejects.toThrow('HDMI handoff failed')
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: null,
      outputError: 'HDMI handoff failed',
      routingBlocked: true,
      restartRequired: false,
      playing: false
    })
    transport.toggle()
    expect(engine.playing).toBe(false)
    const position = engine.position
    transport.seek(position + 1)
    transport.seekBy(1)
    expect(engine.position).toBe(position)

    setOutput.mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
    })
    await transport.applyOutput('flow')
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: 'flow',
      outputError: null,
      routingBlocked: false,
      restartRequired: false,
      playing: false
    })
    transport.toggle()
    expect(engine.playing).toBe(true)
  })

  it('makes a direct typed native quarantine sticky and restart-only', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    await transport.applyOutput('flow')
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      if (deviceId === 'native:hdmi') {
        throw Object.assign(new Error('ALSA cleanup incomplete'), { code: 'provider-cleanup-incomplete' })
      }
    })

    await expect(transport.applyOutput('hdmi')).rejects.toThrow('ALSA cleanup incomplete')
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: null,
      outputError: 'ALSA cleanup incomplete',
      routingBlocked: true,
      restartRequired: true,
      playing: false
    })
    transport.toggle()
    expect(engine.playing).toBe(false)
    const position = engine.position
    transport.seek(position + 1)
    transport.seekBy(1)
    expect(engine.position).toBe(position)

    const physicalCalls = setOutput.mock.calls.length
    await expect(transport.applyOutput('flow')).rejects.toThrow('Restart SingZ Box')
    expect(setOutput.mock.calls).toHaveLength(physicalCalls)
    expect(transport.getSnapshot().restartRequired).toBe(true)
  })

  it('captures a typed native quarantine hidden in the arbiter rollback', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    await transport.applyOutput('flow')
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      if (deviceId === 'native:hdmi') throw new Error('HDMI handoff failed')
      if (deviceId === 'native:flow') {
        throw Object.assign(new Error('ALSA recovery unavailable'), { code: 'provider-recovery-unavailable' })
      }
    })

    await expect(transport.applyOutput('hdmi')).rejects.toThrow('HDMI handoff failed')
    expect(setOutput.mock.calls.map(([deviceId]) => deviceId)).toEqual(['native:hdmi', 'native:flow'])
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: null,
      outputError: 'HDMI handoff failed',
      routingBlocked: true,
      restartRequired: true,
      playing: false
    })
    transport.toggle()
    expect(engine.playing).toBe(false)

    await expect(transport.applyOutput('hdmi')).rejects.toThrow('Restart SingZ Box')
    expect(setOutput).toHaveBeenCalledTimes(2)
  })

  it('deduplicates only the same UID and rejects a different concurrent choice receipt', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    const receipt = deferred<void>()
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      if (deviceId === 'native:flow') await receipt.promise
    })

    const applying = transport.applyOutput('flow')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith('native:flow'))
    expect(transport.applyOutput('flow')).toBe(applying)
    await expect(transport.applyOutput('hdmi')).rejects.toThrow('Applying output')
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: null,
      applyingOutput: true
    })

    receipt.resolve()
    await applying
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: 'flow',
      applyingOutput: false,
      outputError: null
    })
    expect(setOutput.mock.calls.map(([deviceId]) => deviceId)).toEqual(['native:flow'])
  })

  it('serializes a replacement song commit behind the pending output operation', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item('/a', 'Current A'))
    const receipt = deferred<void>()
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      await receipt.promise
    })
    const applying = transport.applyOutput('flow')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalled())

    const opening = transport.open(item('/b', 'Next B'))
    await vi.waitFor(() => expect(vi.mocked(api.readAudio)).toHaveBeenCalledTimes(8))
    await Promise.resolve()
    expect(engine.loaded).toHaveLength(1)
    expect(transport.getSnapshot().active?.item.dir).toBe('/a')

    receipt.resolve()
    await applying
    expect(await opening).toBe(true)
    expect(engine.loaded).toHaveLength(2)
    expect(transport.getSnapshot()).toMatchObject({
      appliedOutputUid: 'flow',
      playing: false
    })
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
  })

  it('drains pending routing before engine teardown even when the save flush fails', async () => {
    const { api } = host()
    const { transport, engine } = makeTransport(api)
    await transport.open(item())
    vi.spyOn(transport, 'flushPersistence').mockRejectedValue(new Error('save flush failed'))
    const receipt = deferred<void>()
    const setOutput = vi.spyOn(engine, 'setOutput').mockImplementation(async deviceId => {
      engine.outputDeviceId = deviceId
      engine.outputCalls.push(deviceId)
      await receipt.promise
    })
    const applying = transport.applyOutput('flow')
    await vi.waitFor(() => expect(setOutput).toHaveBeenCalled())

    const closing = transport.teardown()
    await Promise.resolve()
    expect(engine.teardownCount).toBe(0)
    receipt.resolve()
    await applying
    await closing
    expect(engine.teardownCount).toBe(1)
  })
})


describe('fresh persistent UI admission', () => {
  function persistent() {
    const fixture = host()
    Object.defineProperty(fixture.api, 'boxAudioPersistent', { value: true })
    const status = vi.fn(async () => ({ generation: '9', state: 'running' }))
    fixture.api.box = { retainedPlaybackSnapshot: async () => ({ ok: true, value: { epoch: 'service-e', playback: { ...await status(), transportState: 'playing' } } }) } as unknown as SingzApi['box']
    return { ...fixture, ...makeTransport(fixture.api), status }
  }
  it('blocks fresh song selection before project/lyrics loading while an unknown public song is retained', async () => {
    const { api, transport, engine, status } = persistent()
    expect(await transport.open(item('/b', 'Another song'))).toBe(false)
    expect(status).toHaveBeenCalledOnce()
    expect(api.registerSource).not.toHaveBeenCalled()
    expect(engine.loaded).toHaveLength(0)
    expect(engine.retireCount).toBe(0)
    expect(transport.getSnapshot()).toMatchObject({ active: null, loadingName: null, lastError: 'Stop the previous song before opening another song.' })
  })
  it('allows an unloaded service then preserves normal transitions for a known active project', async () => {
    const { api, transport, engine, status } = persistent()
    status.mockResolvedValueOnce({ generation: '0', state: 'unloaded' })
    expect(await transport.open(item('/a', 'First song'))).toBe(true)
    expect(await transport.open(item('/b', 'Next known song'))).toBe(true)
    expect(status).toHaveBeenCalledOnce()
    expect(api.registerSource).toHaveBeenCalledTimes(2)
    expect(engine.loaded).toHaveLength(2)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
  })
  it('ignores an old unloaded preflight after a newer selection was denied', async () => {
    const { api, transport, engine, status } = persistent()
    const older = deferred<{ generation: string; state: string }>()
    status.mockImplementationOnce(() => older.promise)
    const first = transport.open(item('/a', 'Older choice'))
    expect(await transport.open(item('/b', 'Newer choice'))).toBe(false)
    older.resolve({ generation: '0', state: 'unloaded' })
    expect(await first).toBe(false)
    expect(api.registerSource).not.toHaveBeenCalled()
    expect(engine.loaded).toHaveLength(0)
    expect(transport.getSnapshot().lastError).toContain('Stop the previous song')
  })
  it('cannot publish a project when close wins the authoritative preflight race', async () => {
    const { api, transport, engine, status } = persistent()
    const pending = deferred<{ generation: string; state: string }>()
    status.mockImplementationOnce(() => pending.promise)
    const opening = transport.open(item('/a', 'Closing choice'))
    await transport.teardown()
    pending.resolve({ generation: '0', state: 'unloaded' })
    expect(await opening).toBe(false)
    expect(api.registerSource).not.toHaveBeenCalled()
    expect(engine.loaded).toHaveLength(0)
    expect(transport.getSnapshot().active).toBeNull()
  })
  it('keeps ordinary Box opening independent of service status', async () => {
    const { api } = host()
    api.desktopPlaybackStatus = vi.fn(async () => { throw new Error('must not query a daemon') })
    const { transport } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    expect(api.desktopPlaybackStatus).not.toHaveBeenCalled()
  })
})

describe('Box global metronome policy', () => {
  const cue = { click: true, countInBars: 2, volume: 0.75, accent: true, grid: false }
  const registration = (dir: string, metronome = cue) => ({
    ok: true, path: `${dir}/original.wav`, name: dir, size: 0,
    project: project(dir, { settings: { ...project(dir).settings, metronome } })
  })

  it('disables current and future click/count-in cues and restores original song settings without saving the override', async () => {
    const otherCue = { ...cue, countInBars: 1, volume: 0.4 }
    const { api, saves } = host({ a: () => registration('/a'), b: () => registration('/b', otherCue) })
    const { transport, engine } = makeTransport(api)
    const metronome = vi.spyOn(engine, 'setMetronome')
    expect(await transport.open(item())).toBe(true)
    expect(metronome).toHaveBeenLastCalledWith(cue)
    await transport.setMetronomeOverride('off')
    expect(metronome).toHaveBeenLastCalledWith({ ...cue, click: false, countInBars: 0, volume: 0 })
    transport.setMasterVolume(0.3)
    await transport.flushPersistence()
    expect(saves.at(-1)?.settings.metronome).toEqual(cue)
    expect(await transport.open(item('/b'))).toBe(true)
    expect(metronome).toHaveBeenLastCalledWith({ ...otherCue, click: false, countInBars: 0, volume: 0 })
    await transport.setMetronomeOverride('song')
    expect(metronome).toHaveBeenLastCalledWith(otherCue)
    expect(transport.getSnapshot().active?.project.settings.metronome).toEqual(otherCue)
  })

  it('blocks local and phone Play while disabling is pending or failed, and retries the same off mode', async () => {
    const { api } = host({ a: () => registration('/a') })
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    const pending = deferred<void>()
    const metronome = vi.spyOn(engine, 'setMetronome').mockImplementationOnce(() => pending.promise)
    const changing = transport.setMetronomeOverride('off')
    await vi.waitFor(() => expect(metronome).toHaveBeenCalledTimes(1))
    transport.toggle()
    expect(engine.playing).toBe(false)
    await expect(transport.controllerPlayPause()).rejects.toThrow('metronome policy')
    pending.resolve()
    await changing
    await transport.controllerPlayPause()
    expect(engine.playing).toBe(true)
    metronome.mockRejectedValueOnce(new Error('Native cues refused disable'))
    await expect(transport.setMetronomeOverride('off')).rejects.toThrow('Native cues refused disable')
    expect(engine.playing).toBe(false)
    transport.toggle()
    expect(engine.playing).toBe(false)
    await expect(transport.controllerPlayPause()).rejects.toThrow('metronome policy')
    await transport.setMetronomeOverride('off')
    await transport.controllerPlayPause()
    expect(engine.playing).toBe(true)
  })

  it('captures one accepted pause receipt and coalesces policy requests while native pause is pending', async () => {
    const { api } = host({ a: () => registration('/a') })
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    const pause = deferred<void>()
    let parked = false
    let pausing = false
    let nativePauseRequests = 0
    const acceptedPause = vi.fn(() => {
      if (parked) return Promise.resolve()
      if (pausing) return Promise.reject(new Error('Native duplicate pause refused'))
      pausing = true
      ++nativePauseRequests
      return pause.promise.then(() => { parked = true; pausing = false; engine.playing = false })
    })
    Object.assign(engine, { pauseAccepted: acceptedPause })
    // Match the real Engine: pause() starts the SAME accepted native pause.
    vi.spyOn(engine, 'pause').mockImplementation(() => { void acceptedPause().catch(() => undefined) })
    const metronome = vi.spyOn(engine, 'setMetronome')
    engine.playing = true
    const disabling = transport.setMetronomeOverride('off').then(() => null, error => error as Error)
    const restoring = transport.setMetronomeOverride('song')
    expect(acceptedPause).toHaveBeenCalledTimes(1)
    transport.toggle()
    await expect(transport.controllerPlayPause()).rejects.toThrow('metronome policy')
    expect(metronome).not.toHaveBeenCalled()
    pause.resolve()
    await restoring
    expect((await disabling)?.message).toContain('superseded')
    expect(nativePauseRequests).toBe(1)
    expect(engine.playing).toBe(false)
    await transport.setMetronomeOverride('off')
    expect(nativePauseRequests).toBe(1) // already parked: no duplicate core command
  })

  it('rejects a previously queued phone pause before it can duplicate the policy pause receipt', async () => {
    const { api } = host({ a: () => registration('/a') })
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    engine.playing = true
    const mixed = deferred<void>()
    const volume = vi.spyOn(engine, 'setMasterVolumeAccepted').mockImplementationOnce(() => mixed.promise)
    const mixing = transport.controllerMix({ type: 'volume', target: 'master', value: 0.3 })
    await vi.waitFor(() => expect(volume).toHaveBeenCalledTimes(1))
    const phone = transport.controllerPlayPause().then(() => null, error => error as Error)
    const paused = deferred<void>()
    let pauseCalls = 0
    const acceptedPause = vi.fn(() => {
      if (++pauseCalls > 1) return Promise.reject(new Error('Duplicate phone pause'))
      return paused.promise.then(() => { engine.playing = false })
    })
    Object.assign(engine, { pauseAccepted: acceptedPause })
    const metronome = vi.spyOn(engine, 'setMetronome')
    const disabling = transport.setMetronomeOverride('off')
    expect(acceptedPause).toHaveBeenCalledTimes(1)
    mixed.resolve()
    await mixing
    expect((await phone)?.message).toContain('metronome policy')
    expect(acceptedPause).toHaveBeenCalledTimes(1)
    expect(metronome).not.toHaveBeenCalled()
    paused.resolve()
    await disabling
    expect(engine.playing).toBe(false)
  })

  it('reports an accepted pause failure and keeps Play blocked before any cue update', async () => {
    const { api } = host({ a: () => registration('/a') })
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    const acceptedPause = vi.fn().mockRejectedValue(new Error('Native pause unavailable'))
    Object.assign(engine, { pauseAccepted: acceptedPause })
    const metronome = vi.spyOn(engine, 'setMetronome')
    await expect(transport.setMetronomeOverride('off')).rejects.toThrow('Native pause unavailable')
    expect(acceptedPause).toHaveBeenCalledTimes(1)
    expect(metronome).not.toHaveBeenCalled()
    transport.toggle()
    expect(engine.playing).toBe(false)
    await expect(transport.controllerPlayPause()).rejects.toThrow('metronome policy')
  })

  it('applies a changed policy to the newly committed song rather than a stale song captured before open', async () => {
    const otherCue = { ...cue, countInBars: 1, volume: 0.4 }
    const { api } = host({ a: () => registration('/a'), b: () => registration('/b', otherCue) })
    const { transport, engine } = makeTransport(api)
    await transport.setMetronomeOverride('off')
    expect(await transport.open(item())).toBe(true)
    const pending = deferred<void>()
    const metronome = vi.spyOn(engine, 'setMetronome').mockImplementationOnce(() => pending.promise)
    const opening = transport.open(item('/b'))
    await vi.waitFor(() => expect(metronome).toHaveBeenCalledTimes(1))
    const restoring = transport.setMetronomeOverride('song')
    transport.toggle()
    expect(engine.playing).toBe(false)
    pending.resolve()
    expect(await opening).toBe(true)
    await restoring
    expect(metronome).toHaveBeenLastCalledWith(otherCue)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
  })

  it('rejects unknown policy modes and failed future opens without allowing old cues to play', async () => {
    const { api } = host({ a: () => registration('/a'), b: () => registration('/b') })
    const { transport, engine } = makeTransport(api)
    expect(await transport.open(item())).toBe(true)
    await expect(transport.setMetronomeOverride('bad' as 'off')).rejects.toThrow('Invalid')
    transport.toggle()
    expect(engine.playing).toBe(false)
    await expect(transport.controllerPlayPause()).rejects.toThrow('metronome policy')
    expect(await transport.open(item('/b'))).toBe(true)
    transport.toggle()
    expect(engine.playing).toBe(false)
    await expect(transport.controllerPlayPause()).rejects.toThrow('metronome policy')
    await transport.setMetronomeOverride('off')
    vi.spyOn(engine, 'setMetronome').mockRejectedValueOnce(new Error('Off receipt failed'))
    expect(await transport.open(item('/b'))).toBe(false)
    expect(transport.getSnapshot().active).toBeNull()
    transport.toggle()
    expect(engine.playing).toBe(false)
  })
})

describe('explicit preview start', () => {
  it('resumes the same paused song exactly once and never toggles already playing audio', async () => {
    const { transport, engine } = makeTransport(host().api)
    await transport.open(item())
    const play = vi.spyOn(engine, 'play')
    const pause = vi.spyOn(engine, 'pause')
    await Promise.all([transport.controllerPlay('/a'), transport.controllerPlay('/a')])
    await transport.controllerPlay('/a')
    expect(engine.playing).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
    expect(pause).not.toHaveBeenCalled()
    expect(engine.loaded).toHaveLength(1)
  })

  it('rejects a different owner and a canceled intent before dispatch', async () => {
    const { transport, engine } = makeTransport(host().api)
    await transport.open(item())
    const play = vi.spyOn(engine, 'play')
    await expect(transport.controllerPlay('/b')).rejects.toThrow('changed')
    await expect(transport.controllerPlay('/a', () => false)).rejects.toThrow('changed')
    expect(play).not.toHaveBeenCalled()
  })

  it('revokes a canceled preview after a deferred native start receipt', async () => {
    const { transport, engine } = makeTransport(host().api)
    await transport.open(item())
    const ack = deferred<void>()
    let current = true
    const accepted = vi.fn(async () => { await ack.promise; engine.playing = true })
    const pause = vi.fn(async () => { engine.playing = false })
    Object.assign(engine, { playAccepted: accepted, pauseAccepted: pause })
    const pending = transport.controllerPlay('/a', () => current)
    const rejected = expect(pending).rejects.toThrow('superseded')
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1))
    current = false
    ack.resolve()
    await rejected
    expect(pause).toHaveBeenCalledTimes(1)
    expect(engine.playing).toBe(false)
  })

  it('revokes a deferred old start before a replacement owns the engine', async () => {
    const { transport, engine } = makeTransport(host().api)
    await transport.open(item())
    const ack = deferred<void>()
    const accepted = vi.fn(async () => { await ack.promise; engine.playing = true })
    const pause = vi.fn(async () => { engine.playing = false })
    Object.assign(engine, { playAccepted: accepted, pauseAccepted: pause })
    const pending = transport.controllerPlay('/a')
    const rejected = expect(pending).rejects.toThrow('superseded')
    await vi.waitFor(() => expect(accepted).toHaveBeenCalledTimes(1))
    const replacement = transport.open(item('/b'))
    ack.resolve()
    await rejected
    expect(await replacement).toBe(true)
    expect(transport.getSnapshot().active?.item.dir).toBe('/b')
    expect(engine.playing).toBe(false)
    expect(pause).toHaveBeenCalledTimes(1)
  })

  it('does not start a preview blocked by a failed metronome policy', async () => {
    const { transport, engine } = makeTransport(host().api)
    await transport.open(item())
    vi.spyOn(engine, 'setMetronome').mockRejectedValueOnce(new Error('policy failed'))
    await expect(transport.setMetronomeOverride('off')).rejects.toThrow('policy failed')
    const play = vi.spyOn(engine, 'play')
    await expect(transport.controllerPlay('/a')).rejects.toThrow('blocked')
    expect(play).not.toHaveBeenCalled()
  })

  it('keeps generic open paused and starts a newly selected song only explicitly', async () => {
    const { transport, engine } = makeTransport(host().api)
    await transport.open(item())
    await transport.controllerPlay('/a')
    await transport.open(item('/b'))
    expect(engine.playing).toBe(false)
    await expect(transport.controllerPlay('/a')).rejects.toThrow('changed')
    await transport.controllerPlay('/b')
    expect(engine.playing).toBe(true)
  })
})
