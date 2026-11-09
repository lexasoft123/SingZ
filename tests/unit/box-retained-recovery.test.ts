import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BoxRetainedPlaybackSnapshot,
  BoxRetainedProjectDescriptor
} from '../../src/shared/box-contract'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CONTRACT_VERSION,
  STEMS_6,
  type DesktopPlaybackPrepareConfig,
  type DesktopPlaybackStatus,
  type ProjectGraphHash,
  type ProjectSettings
} from '../../src/shared/types'
import { validateBoxRetainedProject } from '../../src/main/box-audio/retained-project'
import { restoreBoxRetainedPlayback } from '../../src/main/box-audio/retained-recovery'

const roots: string[] = []
const lyricsDocument = {
  source: 'edited',
  lines: [{
    start: 1.25,
    end: 3.75,
    text: 'A cached lyric',
    words: [
      { w: 'A', s: 1.25, e: 1.5 },
      { w: 'cached', s: 1.5, e: 2.5 },
      { w: 'lyric', s: 2.5, e: 3.75 }
    ]
  }]
}

type Metadata = {
  version: number
  name: string
  songFile: string
  savedAt: string
  settings: ProjectSettings
  stemHashes: Record<string, { size: number; md5: string; mtimeMs: number }>
  lyricsHash?: { size: number; md5: string; mtimeMs: number }
  graphHash?: ProjectGraphHash
}

type Fixture = {
  root: string
  libraryRoot: string
  driveProjectsRoot: string
  dir: string
  songPath: string
  config: DesktopPlaybackPrepareConfig
  lanes: BoxRetainedProjectDescriptor['lanes']
  descriptor: BoxRetainedProjectDescriptor
  meta: Metadata
  graphText: string | null
  save(): Promise<void>
  refresh(): Promise<void>
}

function prepareConfig(): DesktopPlaybackPrepareConfig {
  return {
    capability: DESKTOP_PLAYBACK_CAPABILITY,
    provider: 'alsa',
    accessMode: 'exclusive',
    outputDeviceUid: 'hw:Recovery',
    outputChannels: [0, 1],
    sampleRate: 48000,
    bufferFrames: 256,
    maximumFrames: 4096,
    masterGain: 0.8,
    playback: {
      version: DESKTOP_PLAYBACK_CONTRACT_VERSION,
      transport: { entrySeconds: 0, durationSeconds: 10, playbackRate: 1, transposeSemitones: 0 },
      cues: { click: false, countInBars: 0, volume: 0.7, accent: true }
    },
    streamLanes: true
  }
}

function nativeStatus(generation = '7'): DesktopPlaybackStatus {
  return {
    capability: DESKTOP_PLAYBACK_CAPABILITY,
    generation,
    state: 'running',
    hostState: 'running',
    terminalReason: 'none',
    terminalOrdinal: '0',
    transportGeneration: generation,
    transportState: 'playing',
    transportTelemetryQuality: 'current',
    lastTransportBoundary: 'start',
    renderedProjectFrame: '96000',
    audibleProjectFrame: '96000',
    audibleProjectionQuality: 'current',
    durationFrames: '480000',
    presentationLatencyFrames: '0',
    routeGeneration: '1',
    streamGeneration: '1',
    transportDiscontinuities: '0',
    loopEnabled: false,
    loopStartFrame: '0',
    loopEndFrame: '0',
    loopCount: '0',
    seekCount: '0',
    playbackRate: 1,
    transposeSemitones: 0,
    swapPendingGeneration: '0',
    retiringSwapGeneration: '0',
    preRollFrames: '0',
    countInEventCount: 0,
    countInBeatsPerBar: 4,
    masterGain: 0.8,
    trainingEnabled: false,
    trainingLanes: [],
    adapterRenderFailures: 0,
    error: '',
    format: {
      sampleRate: 48000,
      maximumFrames: 4096,
      nominalBufferFrames: 256,
      inputChannels: 0,
      outputChannels: 2
    },
    latency: { inputDeviceFrames: 0, outputDeviceFrames: 0, bufferFrames: 256, externalRouteFrames: 0 },
    lanes: STEMS_6.map(id => ({
      id,
      cursorFrames: '96000',
      totalFrames: '480000',
      gain: 0.5,
      muted: false,
      solo: false,
      streamed: true,
      starvedBlocks: '0'
    }))
  } as unknown as DesktopPlaybackStatus
}

async function fixture(options: { source?: boolean; graph?: boolean; extraFormat?: boolean; drive?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'box-retained-recovery-'))
  roots.push(root)
  const libraryRoot = join(root, 'library')
  const driveProjectsRoot = join(root, 'drive-projects')
  const requestedDir = join(options.drive ? driveProjectsRoot : libraryRoot, 'Song')
  const stemDir = join(requestedDir, 'stems')
  await mkdir(libraryRoot, { recursive: true })
  await mkdir(stemDir, { recursive: true })
  await mkdir(driveProjectsRoot, { recursive: true })
  const requestedSongPath = join(requestedDir, 'source.flac')
  if (options.source !== false) await writeFile(requestedSongPath, 'original-source')

  const stemHashes: Metadata['stemHashes'] = {}
  for (const id of STEMS_6) {
    const path = join(stemDir, `${id}.flac`)
    const bytes = `stem:${id}`
    await writeFile(path, bytes)
    const info = await stat(path)
    stemHashes[`${id}.flac`] = {
      size: info.size,
      md5: createHash('md5').update(bytes).digest('hex'),
      mtimeMs: info.mtimeMs
    }
  }
  if (options.extraFormat) {
    const path = join(stemDir, 'vocals.wav')
    await writeFile(path, 'alternate-vocals')
    const info = await stat(path)
    stemHashes['vocals.wav'] = {
      size: info.size,
      md5: createHash('md5').update('alternate-vocals').digest('hex'),
      mtimeMs: info.mtimeMs
    }
  }

  const lyricsText = JSON.stringify(lyricsDocument)
  await writeFile(join(requestedDir, 'lyrics.json'), lyricsText)
  const lyricsInfo = await stat(join(requestedDir, 'lyrics.json'))
  const graphText = options.graph === false ? null : JSON.stringify({
    format: 1,
    engine: 'singz-dsp',
    nodes: [],
    connections: []
  })
  let graphHash: ProjectGraphHash | undefined
  if (graphText !== null) {
    await writeFile(join(requestedDir, 'graph.json'), graphText)
    const info = await stat(join(requestedDir, 'graph.json'))
    graphHash = {
      format: 1,
      md5: createHash('md5').update(graphText).digest('hex'),
      size: Buffer.byteLength(graphText),
      mtimeMs: info.mtimeMs
    }
  }
  const meta: Metadata = {
    version: 2,
    name: 'Recovered song',
    songFile: 'source.flac',
    savedAt: '2026-11-09T01:02:03.000Z',
    settings: {
      transpose: 3,
      tempo: 1.1,
      masterVolume: 0.4,
      tracks: { vocals: { muted: false, solo: false, volume: 0.8 } }
    },
    stemHashes,
    lyricsHash: {
      size: Buffer.byteLength(lyricsText),
      md5: createHash('md5').update(lyricsText).digest('hex'),
      mtimeMs: lyricsInfo.mtimeMs
    },
    ...(graphHash ? { graphHash } : {})
  }
  await writeFile(join(requestedDir, 'project.json'), JSON.stringify(meta))
  const dir = await realpath(requestedDir)
  const songPath = join(dir, 'source.flac')
  const config = prepareConfig()
  const lanes = STEMS_6.map(id => ({
    id,
    path: join(dir, 'stems', `${id}.flac`),
    gain: 0.5,
    muted: false,
    solo: false
  }))
  const value: Fixture = {
    root,
    libraryRoot: await realpath(libraryRoot),
    driveProjectsRoot: await realpath(driveProjectsRoot),
    dir,
    songPath,
    config,
    lanes,
    descriptor: undefined as unknown as BoxRetainedProjectDescriptor,
    meta,
    graphText,
    save: async () => { await writeFile(join(dir, 'project.json'), JSON.stringify(meta)) },
    refresh: async () => {
      value.descriptor = await validateBoxRetainedProject({
        dir,
        songPath,
        libraryRoot: value.libraryRoot,
        driveProjectsRoot: value.driveProjectsRoot,
        config,
        lanes
      })
    }
  }
  await value.refresh()
  return value
}

function snapshot(
  fixture: Fixture,
  status = nativeStatus(),
  epoch = 'epoch-a',
  descriptor = fixture.descriptor
): BoxRetainedPlaybackSnapshot {
  return {
    epoch,
    playback: { generation: status.generation, state: status.state, transportState: status.transportState },
    recovery: { generation: status.generation, descriptor, status }
  }
}

function restore(
  fixture: Fixture,
  reader: () => Promise<BoxRetainedPlaybackSnapshot> = async () => snapshot(fixture),
  trustedRoots = { libraryRoot: fixture.libraryRoot, driveProjectsRoot: fixture.driveProjectsRoot }
): ReturnType<typeof restoreBoxRetainedPlayback> {
  return restoreBoxRetainedPlayback(
    { epoch: 'epoch-a', generation: '7' },
    { ...trustedRoots, snapshot: reader }
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function fingerprints(fixture: Fixture): Promise<Map<string, { bytes: Buffer; mtimeMs: number }>> {
  const names = await readdir(fixture.dir)
  const paths = names.filter(name => name !== 'stems').map(name => join(fixture.dir, name))
  for (const name of await readdir(join(fixture.dir, 'stems'))) paths.push(join(fixture.dir, 'stems', name))
  const result = new Map<string, { bytes: Buffer; mtimeMs: number }>()
  for (const path of paths) {
    const info = await stat(path)
    if (info.isFile()) result.set(path, { bytes: await readFile(path), mtimeMs: info.mtimeMs })
  }
  return result
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('trusted retained recovery reader', () => {
  it('returns canonical cached DTOs and leaves every project file byte and mtime unchanged', async () => {
    const f = await fixture()
    const before = await fingerprints(f)
    const result = await restore(f)
    expect(result.epoch).toBe('epoch-a')
    expect(result.project.dir).toBe(f.dir)
    expect(result.item.songPath).toBe(f.songPath)
    expect(result.project.sourceMissing).toBe(false)
    expect(result.project.inLibrary).toBe(true)
    expect(result.project.settings).toEqual(f.meta.settings)
    expect(result.project.stems?.vocals).toBe(join(f.dir, 'stems', 'vocals.flac'))
    expect(result.item).toMatchObject({ name: 'Recovered song', hasStems: true, stemCount: 6, hasLyrics: true })
    expect(result.lyrics).toEqual(lyricsDocument.lines)
    expect(result.graph?.text).toBe(f.graphText)
    expect(result.graph?.hash).toEqual(f.meta.graphHash)
    const after = await fingerprints(f)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, previous] of before) {
      expect(after.get(path)?.mtimeMs, path).toBe(previous.mtimeMs)
      expect(after.get(path)?.bytes.equals(previous.bytes), path).toBe(true)
    }
  })

  it('reports a validated Drive-cache project as outside the user library', async () => {
    const f = await fixture({ drive: true })
    const result = await restore(f)
    expect(result.project.dir).toBe(f.dir)
    expect(result.project.inLibrary).toBe(false)
  })

  it('restores a stems-only project without inventing its missing source or a graph', async () => {
    const f = await fixture({ source: false, graph: false })
    const result = await restore(f)
    expect(result.project.sourceMissing).toBe(true)
    expect(result.item.songPath).toBe(f.songPath)
    expect(result.graph).toBeNull()
    expect(result.project.graphHash).toBeUndefined()
    expect(result.lyrics.length).toBeGreaterThan(0)
  })

  it.each([
    { state: 'running', hostState: 'running', transportState: 'playing' },
    { state: 'running', hostState: 'running', transportState: 'pre-roll' },
    { state: 'running', hostState: 'running', transportState: 'paused' },
    { state: 'running', hostState: 'running', transportState: 'completed' }
  ] as const)('admits $state/$hostState/$transportState', async admission => {
    const f = await fixture()
    const status = { ...nativeStatus(), ...admission }
    const result = await restore(f, async () => snapshot(f, status))
    expect(result.recovery.status).toEqual(status)
  })

  it('accepts frame and native-control progression without treating it as stale project identity', async () => {
    const f = await fixture()
    const first = snapshot(f)
    const latestDescriptor = structuredClone(f.descriptor)
    latestDescriptor.config.masterGain = 0.2
    latestDescriptor.config.playback.transport.playbackRate = 1.25
    latestDescriptor.config.playback.transport.transposeSemitones = 2
    latestDescriptor.config.initialTransport = { state: 'paused' }
    latestDescriptor.lanes[0].gain = 0.1
    latestDescriptor.lanes[0].muted = true
    const latestStatus = {
      ...nativeStatus(),
      transportState: 'paused' as const,
      renderedProjectFrame: '144000',
      audibleProjectFrame: '144000',
      masterGain: 0.2,
      playbackRate: 1.25,
      transposeSemitones: 2
    }
    const gate = deferred<BoxRetainedPlaybackSnapshot>()
    const read = vi.fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => gate.promise)
    const pending = restore(f, read)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    gate.resolve(snapshot(f, latestStatus, 'epoch-a', latestDescriptor))
    const result = await pending
    expect(result.recovery.status).toEqual(latestStatus)
    expect(result.recovery.descriptor).toEqual(latestDescriptor)
    expect(result.project.settings).toEqual(f.meta.settings)
  })

  it.each(['epoch', 'generation'] as const)('rejects an initial %s mismatch before touching project files', async kind => {
    const f = await fixture()
    const current = snapshot(f, nativeStatus(kind === 'generation' ? '8' : '7'), kind === 'epoch' ? 'epoch-b' : 'epoch-a')
    await expect(restore(f, async () => current)).rejects.toThrow('Retained playback changed')
  })

  it.each(['epoch', 'generation'] as const)('rejects a late %s replacement at the final host fence', async kind => {
    const f = await fixture()
    const gate = deferred<BoxRetainedPlaybackSnapshot>()
    const read = vi.fn().mockResolvedValueOnce(snapshot(f)).mockImplementationOnce(() => gate.promise)
    const pending = restore(f, read)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const rejection = expect(pending).rejects.toThrow('Retained playback changed')
    gate.resolve(snapshot(f, nativeStatus(kind === 'generation' ? '8' : '7'), kind === 'epoch' ? 'epoch-b' : 'epoch-a'))
    await rejection
  })

  it('rejects a late immutable config replacement even when epoch and generation survive', async () => {
    const f = await fixture()
    const changed = structuredClone(f.descriptor)
    changed.config.outputDeviceUid = 'hw:Replacement'
    const gate = deferred<BoxRetainedPlaybackSnapshot>()
    const read = vi.fn().mockResolvedValueOnce(snapshot(f)).mockImplementationOnce(() => gate.promise)
    const pending = restore(f, read)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    const rejection = expect(pending).rejects.toThrow('Retained playback changed')
    gate.resolve(snapshot(f, nativeStatus(), 'epoch-a', changed))
    await rejection
  })

  it('rejects changed project metadata, lyrics, and selected media bytes', async () => {
    const project = await fixture()
    project.meta.name = 'Replacement project'
    await project.save()
    await expect(restore(project)).rejects.toThrow('Retained playback changed')

    const lyrics = await fixture()
    await writeFile(join(lyrics.dir, 'lyrics.json'), JSON.stringify({
      ...lyricsDocument,
      lines: [{ ...lyricsDocument.lines[0], text: 'Different cached words' }]
    }))
    await expect(restore(lyrics)).rejects.toThrow('changed on disk')

    const media = await fixture()
    await writeFile(join(media.dir, 'stems', 'vocals.flac'), 'replacement-media-with-a-new-size')
    await expect(restore(media)).rejects.toThrow('missing or damaged stems')
  })

  it('rejects changed media stamps', async () => {
    const f = await fixture()
    await utimes(join(f.dir, 'stems', 'vocals.flac'), new Date(), new Date('2030-01-01T00:00:00Z'))
    await expect(restore(f)).rejects.toThrow('changed on disk')
  })

  it('accepts a hash-tracked alternate stem format but still rejects its loss or damage', async () => {
    const valid = await fixture({ extraFormat: true })
    const result = await restore(valid)
    expect(result.project.stems?.vocals).toBe(join(valid.dir, 'stems', 'vocals.flac'))
    expect(result.item.stemCount).toBe(6)

    const missing = await fixture({ extraFormat: true })
    await rm(join(missing.dir, 'stems', 'vocals.wav'))
    await expect(restore(missing)).rejects.toThrow('missing or damaged stems')

    const damaged = await fixture({ extraFormat: true })
    await writeFile(join(damaged.dir, 'stems', 'vocals.wav'), 'bad')
    await expect(restore(damaged)).rejects.toThrow('missing or damaged stems')
  })

  it('rejects projects outside both trusted roots', async () => {
    const trusted = await fixture()
    const outside = await fixture()
    await expect(restore(outside, async () => snapshot(outside), {
      libraryRoot: trusted.libraryRoot,
      driveProjectsRoot: trusted.driveProjectsRoot
    })).rejects.toThrow('outside the configured libraries')
  })

  it.skipIf(process.platform === 'win32')('fails closed on a symlinked lyrics escape', async () => {
    const f = await fixture()
    const outside = join(f.root, 'outside-lyrics.json')
    await writeFile(outside, JSON.stringify(lyricsDocument))
    await rm(join(f.dir, 'lyrics.json'))
    await symlink(outside, join(f.dir, 'lyrics.json'))
    await expect(restore(f)).rejects.toThrow('escapes the retained project')
  })

  it('rejects missing, empty, and corrupt cached lyrics instead of creating an instrumental mode', async () => {
    const missing = await fixture()
    await rm(join(missing.dir, 'lyrics.json'))
    await missing.refresh()
    await expect(restore(missing)).rejects.toThrow()

    const empty = await fixture()
    await writeFile(join(empty.dir, 'lyrics.json'), JSON.stringify({ source: 'edited', lines: [] }))
    await empty.refresh()
    await expect(restore(empty)).rejects.toThrow('missing, empty, or corrupt')

    const corrupt = await fixture()
    await writeFile(join(corrupt.dir, 'lyrics.json'), '{bad')
    await expect(restore(corrupt)).rejects.toThrow('corrupt')
  })

  it('rejects graph bytes and graph metadata that conflict with their bound hashes', async () => {
    const bytes = await fixture()
    await writeFile(join(bytes.dir, 'graph.json'), '{"format":1,"engine":"singz-dsp","nodes":[],"connections":[],"changed":true}')
    await expect(restore(bytes)).rejects.toThrow('changed on disk')

    const metadata = await fixture()
    metadata.meta.graphHash!.md5 = '0'.repeat(32)
    await metadata.save()
    await metadata.refresh()
    await expect(restore(metadata)).rejects.toThrow('does not match its retained identity')
  })

  it.each([
    { state: 'output-open', hostState: 'open', transportState: 'paused', terminalReason: 'none' },
    { state: 'output-open', hostState: 'open', transportState: 'completed', terminalReason: 'none' },
    { state: 'output-open', hostState: 'running', transportState: 'paused', terminalReason: 'none' },
    { state: 'running', hostState: 'open', transportState: 'paused', terminalReason: 'none' },
    { state: 'preparing', hostState: 'closed', transportState: 'stopped', terminalReason: 'none' },
    { state: 'prepared', hostState: 'open', transportState: 'paused', terminalReason: 'none' },
    { state: 'stopped', hostState: 'stopped', transportState: 'stopped', terminalReason: 'none' },
    { state: 'output-open', hostState: 'closed', transportState: 'paused', terminalReason: 'none' },
    { state: 'running', hostState: 'error', transportState: 'playing', terminalReason: 'error' },
    { state: 'running', hostState: 'device-lost', transportState: 'playing', terminalReason: 'device-lost' },
    { state: 'terminal', hostState: 'error', transportState: 'stopped', terminalReason: 'device-lost' },
    { state: 'quarantined', hostState: 'error', transportState: 'stopped', terminalReason: 'error' },
    { state: 'output-open', hostState: 'open', transportState: 'stopped', terminalReason: 'none' },
    { state: 'running', hostState: 'running', transportState: 'playing', terminalReason: 'device-lost' }
  ] as const)('rejects uncommandable $state/$hostState/$transportState/$terminalReason before a second read or project mutation', async replacement => {
    const f = await fixture()
    const before = await fingerprints(f)
    const status = { ...nativeStatus(), ...replacement }
    const read = vi.fn(async () => snapshot(f, status))
    await expect(restore(f, read)).rejects.toThrow('use explicit Stop')
    expect(read).toHaveBeenCalledOnce()
    expect(await fingerprints(f)).toEqual(before)
  })

  it('rejects a host without recovery metadata for the truthful Stop fallback', async () => {
    const f = await fixture()
    const current = snapshot(f)
    current.recovery = null
    await expect(restore(f, async () => current)).rejects.toThrow('recovery is unavailable; use explicit Stop')
  })
})
