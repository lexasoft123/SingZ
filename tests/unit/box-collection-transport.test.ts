import { nativeLaneMeasureFixture } from '../shared/native-lane-measure-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => { vi.stubGlobal('navigator', { platform: 'Linux aarch64' }) })
import { MultitrackEngine, type EngineTrackInput, type TrackState } from '../../src/renderer/src/audio/engine'
import type { ParsedGraphDocument } from '../../src/shared/graph-document'
import type { ProjectInfo, ProjectListItem, SingzApi } from '../../src/shared/types'
import { BoxTransport, type BoxEngine } from '../../src/renderer/src/box/transport'

class Engine implements BoxEngine {
  duration = 10
  position = 0
  playing = false
  starting = false
  masterVolume = 1
  transpose = 0
  tempo = 1
  playbackError = null
  tracks: TrackState[] = []
  pauseAccepted?: () => Promise<void>
  playAccepted?: () => Promise<void>
  private listeners = new Set<() => void>()
  load(tracks: EngineTrackInput[], opts: { position?: number; play?: boolean; graphDocument?: ParsedGraphDocument | null }): void {
    this.tracks = tracks.map(track => ({ id: track.id, volume: 1, muted: false, solo: false }))
    this.playing = opts.play === true
  }
  async decode(): Promise<AudioBuffer> {
    const samples = new Float32Array(100)
    return { duration: 10, length: 100, sampleRate: 48000, numberOfChannels: 1, getChannelData: () => samples } as unknown as AudioBuffer
  }
  async play(): Promise<void> { this.playing = true }
  pause(): void { this.playing = false }
  toggle(): void { this.playing = !this.playing }
  seek(position: number): void { this.position = position }
  seekBy(delta: number): void { this.position += delta }
  setVolume(id: string, volume: number): void { const track = this.tracks.find(item => item.id === id); if (track) track.volume = volume }
  setMuted(id: string, muted: boolean): void { const track = this.tracks.find(item => item.id === id); if (track) track.muted = muted }
  setSolo(id: string, solo: boolean): void { const track = this.tracks.find(item => item.id === id); if (track) track.solo = solo }
  setMasterVolume(volume: number): void { this.masterVolume = volume }
  async setVolumeAccepted(id: string, volume: number): Promise<void> { this.setVolume(id, volume) }
  async setMutedAccepted(id: string, muted: boolean): Promise<void> { this.setMuted(id, muted) }
  async setSoloAccepted(id: string, solo: boolean): Promise<void> { this.setSolo(id, solo) }
  async setMasterVolumeAccepted(volume: number): Promise<void> { this.setMasterVolume(volume) }
  async setTranspose(): Promise<void> {}
  async setTempo(): Promise<void> {}
  async setBeats(): Promise<void> {}
  async setMetronome(): Promise<void> {}
  async setTraining(): Promise<void> {}
  async setRegion(): Promise<void> {}
  getTrackStates(): TrackState[] { return this.tracks.map(track => ({ ...track })) }
  setLaneReader(): void {}
  retireForSongSwitch(): void { this.playing = false }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  async teardown(): Promise<void> {}
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

const item: ProjectListItem = {
  dir: '/a', name: 'Song A', songPath: '/a/original.wav', savedAt: '', hasStems: true, stemCount: 1, hasLyrics: true, bytes: 1
}
const project: ProjectInfo = {
  dir: '/a', name: 'Song A', sourceMissing: true, settings: { transpose: 0, tracks: {} },
  stems: { vocals: '/a/vocals.flac' }, hasLyrics: true, inLibrary: true
}
const api = {
  ...nativeLaneMeasureFixture(),  registerSource: vi.fn(async () => ({ ok: true, path: item.songPath, name: item.name, size: 0, project })),
  readProjectGraph: vi.fn(async () => ({ ok: true, graph: null })),
  getCachedLyrics: vi.fn(async () => ({
    ok: true, cached: true, source: 'edited',
    lines: [{ start: 0, end: 1, text: 'Lyric', words: [{ w: 'Lyric', s: 0, e: 1 }] }]
  })),
  readAudio: vi.fn(async () => new ArrayBuffer(8)),
  audioHostDevices: vi.fn(async () => ({ ok: false, error: 'not used' })),
  saveProject: vi.fn(async () => ({ ok: true, dir: item.dir, songPath: item.songPath, inLibrary: true }))
} as unknown as SingzApi

const live: BoxTransport[] = []
async function open(): Promise<{ transport: BoxTransport; engine: Engine }> {
  const engine = new Engine()
  const transport = new BoxTransport(api, engine, { pollMs: 0, saveDelayMs: 600000 })
  live.push(transport)
  expect(await transport.open(item)).toBe(true)
  return { transport, engine }
}

afterEach(async () => {
  await Promise.all(live.splice(0).map(transport => transport.teardown()))
})

describe('awaited phone transport receipts', () => {
  it('accepts the real play receipt while the native render snapshot still says paused', async () => {
    const { transport, engine } = await open()
    const receipt = deferred()
    const host = {
      generation: 0, teardownStarted: false, _playing: false,
      nativePlayback: { active: true, transportActive: false },
      play: vi.fn(() => {
        host.generation++
        return receipt.promise.then(() => { host._playing = true })
      })
    }
    vi.spyOn(engine, 'play').mockImplementation(host.play)
    engine.playAccepted = vi.fn(() => MultitrackEngine.prototype.playAccepted.call(host as unknown as MultitrackEngine))
    let accepted = false
    const command = transport.controllerPlayPause().then(() => { accepted = true })
    await vi.waitFor(() => expect(engine.playAccepted).toHaveBeenCalled())
    expect(accepted).toBe(false)
    receipt.resolve()
    await command
    expect(host._playing).toBe(true)
    const presentedPlaying = Object.getOwnPropertyDescriptor(MultitrackEngine.prototype, 'playing')!.get!
    expect(presentedPlaying.call(host)).toBe(false)
    expect(accepted).toBe(true)

    // The former public-snapshot check rejects this same accepted native start.
    engine.playAccepted = undefined
    await expect(transport.controllerPlayPause()).rejects.toThrow('superseded')
  })

  it('rejects an engine play receipt revoked during the pending operation', async () => {
    const receipt = deferred()
    const host = {
      generation: 0, teardownStarted: false, _playing: false,
      play: () => {
        host.generation++
        return receipt.promise.then(() => { host._playing = true })
      }
    }
    const command = MultitrackEngine.prototype.playAccepted.call(host as unknown as MultitrackEngine)
    host.generation++
    receipt.resolve()
    await expect(command).rejects.toThrow('superseded')
  })

  it('does not acknowledge pause before pauseAccepted settles', async () => {
    const { transport, engine } = await open()
    engine.playing = true
    const receipt = deferred()
    engine.pauseAccepted = vi.fn(() => receipt.promise.then(() => { engine.playing = false }))
    let settled = false
    const command = transport.controllerPlayPause().then(() => { settled = true })
    await vi.waitFor(() => expect(engine.pauseAccepted).toHaveBeenCalled())
    expect(settled).toBe(false)
    receipt.resolve()
    await command
    expect(settled).toBe(true)
  })

  it('fails closed when this playback backend has no pause receipt', async () => {
    const { transport, engine } = await open()
    engine.playing = true
    await expect(transport.controllerPlayPause()).rejects.toThrow('Pause is not supported')
  })

  it('rejects a deferred play receipt whose desired state was superseded by TV pause', async () => {
    const { transport, engine } = await open()
    const receipt = deferred()
    vi.spyOn(engine, 'play').mockImplementationOnce(() => receipt.promise)
    const command = transport.controllerPlayPause()
    await vi.waitFor(() => expect(engine.play).toHaveBeenCalled())
    transport.pause()
    receipt.resolve()
    await expect(command).rejects.toThrow('superseded')
  })

  it('awaits the authoritative master gain receipt and still rejects a missing target', async () => {
    const { transport, engine } = await open()
    const receipt = deferred()
    vi.spyOn(engine, 'setMasterVolumeAccepted').mockImplementationOnce(() => receipt.promise.then(() => engine.setMasterVolume(2)))
    let settled = false
    const command = transport.controllerMix({ type: 'volume', target: 'master', value: 2 }).then(() => { settled = true })
    await vi.waitFor(() => expect(engine.setMasterVolumeAccepted).toHaveBeenCalled())
    expect(settled).toBe(false)
    receipt.resolve()
    await command
    expect(engine.masterVolume).toBe(2)
    await expect(transport.controllerMix({ type: 'volume', target: '/private/missing', value: 1 })).rejects.toThrow('not available')
  })
})
