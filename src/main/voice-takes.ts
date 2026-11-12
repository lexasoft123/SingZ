import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fsyncDirectorySync, writeAllSync } from './atomic-file'
import type {
  VoiceRecordSettingsChange,
  VoiceRecordStartRequest,
  VoiceRecordStartResult,
  VoiceRecordStopResult,
  VoiceTakeSettingsPoint,
  VoiceTakeSidecar,
  VoiceTakeSummary,
  VoicePlayTakeRequest,
  VoiceInputLevel
} from '../shared/voice-take'
import { VOICE_TAKE_SIDECAR_VERSION } from '../shared/voice-take'

export type VoiceTakeNative = {
  recordTake(args: { dir: string; takeId: string; generation: bigint; deviceName?: string; channelIndex?: number }): Promise<{ ok: boolean; error?: string }>
  finishTake(args: { generation: bigint }): Promise<{ ok: boolean; path?: string; frames?: number; sampleRate?: number; droppedBlocks?: number; firstSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; deviceLost?: boolean; reason?: string; error?: string; message?: string }>
  cancelTake(args: { generation: bigint }): Promise<{ ok: boolean; error?: string }>
  stopCapture?(generation: bigint): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  captureStats?(): Promise<{ firstSampleCaptured?: boolean; firstSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; sampleRate?: number; lastSampleHostNs?: string; inputLatencyFrames?: number; inputLevel?: VoiceInputLevel; takeActive?: boolean }>
  presentationQuery(args: { songId: string; firstSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; inputLatencyFrames?: number; outputLatencyFrames?: number; graphLatencyFrames?: number; sampleRate?: number; initialDiscontinuitySerial?: number }): Promise<{ ok: boolean; found?: boolean; paused?: boolean; startPositionSec?: number; songSeconds?: number; projectFrame?: number; inputLatencyFrames?: number; outputLatencyFrames?: number; graphLatencyFrames?: number; latencySource?: 'reported' | 'measured-trim'; discontinuitySerial?: number; seekDuringCallback?: boolean; error?: string }>
  playTake(args: { takeId: string; path: string; startPositionSec: number; mode: VoicePlayTakeRequest['mode']; generation: bigint; gain?: number; tempo?: number }): Promise<{ ok: boolean; error?: string; startHostTimeNs?: string }>
  stopTake(generation?: bigint): Promise<{ ok: boolean; error?: string }>
  level(): Promise<VoiceInputLevel>
}

export type VoiceTakeStoreOptions = {
  rootDir?: string
  now?: () => Date
  native: VoiceTakeNative
  placementQuery?: VoiceTakeNative['presentationQuery']
}

const validId = (id: string): boolean =>
  /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,127})$/.test(id) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)

export const isSafeVoiceTakeId = validId

type Active = {
  request: VoiceRecordStartRequest
  takeId: string
  dir: string
  wavPath: string
  createdAt: string
  startPositionSec: number
  inputLatencyFrames: number
  outputLatencyFrames: number
  graphLatencyFrames: number
  latencySource: 'reported' | 'measured-trim'
  settings: VoiceTakeSettingsPoint[]
  generation: bigint
  firstSampleHostNs?: string
  firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'
  sampleRate?: number
  discontinuitySerial?: number
  placementFault?: boolean
  monitor?: ReturnType<typeof setInterval>
  lastSampleHostNs?: string
  finalized?: VoiceTakeSummary
}

const summary = (sidecar: VoiceTakeSidecar): VoiceTakeSummary => ({
  takeId: sidecar.takeId, songId: sidecar.songId, createdAt: sidecar.createdAt,
  startPositionSec: sidecar.startPositionSec, durationSec: sidecar.durationSec,
  status: sidecar.status, name: sidecar.name, tempo: sidecar.settings[0]?.tempo ?? 1,
  transposeSemitones: sidecar.settings[0]?.transposeSemitones ?? 0,
  settingsChanged: sidecar.settings.length > 1
})

const wavDuration = (bytes: number, sampleRate: number): number => Math.max(0, bytes - 44) / 2 / sampleRate

const readWavInfo = async (path: string): Promise<{ sampleRate: number; dataBytes: number }> => {
  const bytes = await readFile(path)
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('Invalid WAV header')
  const sampleRate = bytes.readUInt32LE(24)
  const dataBytes = bytes.toString('ascii', 36, 40) === 'data' ? bytes.readUInt32LE(40) : Math.max(0, bytes.length - 44)
  if (!sampleRate) throw new Error('Invalid WAV sample rate')
  return { sampleRate, dataBytes }
}

export class VoiceTakeStore {
  private active: Active | null = null
  private playGeneration: bigint | null = null
  private finalizedTake: VoiceTakeSummary | null = null
  private readonly root: string
  private readonly now: () => Date
  private readonly query: VoiceTakeNative['presentationQuery']

  constructor(private readonly options: VoiceTakeStoreOptions) {
    this.root = options.rootDir ?? join(app.getPath('userData'), 'voice-takes')
    this.now = options.now ?? (() => new Date())
    this.query = options.placementQuery ?? options.native.presentationQuery
  }

  private songDir(songId: string): string {
    if (!validId(songId)) throw new Error('Invalid song id')
    return join(this.root, songId)
  }

  private takePaths(songId: string, takeId: string): { dir: string; wav: string; sidecar: string } {
    if (!validId(songId) || !validId(takeId)) throw new Error('Invalid take id')
    const dir = this.songDir(songId)
    return { dir, wav: join(dir, `${takeId}.wav`), sidecar: join(dir, `${takeId}.json`) }
  }

  async start(request: VoiceRecordStartRequest): Promise<VoiceRecordStartResult> {
    if (this.active) return { ok: false, reason: 'busy', message: 'A voice take is already recording.' }
    if (!validId(request.songId) || !request.input || !Number.isFinite(request.input.channelIndex) || request.input.channelIndex < 0 || !Number.isFinite(request.tempo) || !Number.isFinite(request.transposeSemitones)) return { ok: false, reason: 'error', message: 'Invalid recording request.' }
    const takeId = randomUUID()
    const paths = this.takePaths(request.songId, takeId)
    await mkdir(paths.dir, { recursive: true })
    const generation = BigInt(`0x${takeId.replace(/-/g, '').slice(0, 15)}`)
    let captureAttempted = false
    try {
      captureAttempted = true
      const result = await this.options.native.recordTake({ dir: paths.dir, takeId, generation, deviceName: request.input.deviceName, channelIndex: request.input.channelIndex })
      if (!result.ok) return { ok: false, reason: 'error', message: result.error ?? 'Recording could not start.' }
      const active: Active = {
      request, takeId, dir: paths.dir, wavPath: paths.wav, createdAt: this.now().toISOString(),
      startPositionSec: 0, inputLatencyFrames: 0, outputLatencyFrames: 0, graphLatencyFrames: 0,
      latencySource: 'reported',
      settings: [{ atSec: 0, tempo: request.tempo, transposeSemitones: request.transposeSemitones }], generation
      }
      if (this.options.native.captureStats) {
        const stamp = await this.waitForFirstSample()
        if (!stamp || !stamp.firstSampleHostNs || !stamp.sampleRate) { active.placementFault = true }
        else {
          active.firstSampleHostNs = stamp.firstSampleHostNs
          active.lastSampleHostNs = stamp.lastSampleHostNs ?? stamp.firstSampleHostNs
          active.firstSampleQuality = stamp.firstSampleQuality
          active.sampleRate = stamp.sampleRate
          const raw = await this.query({ songId: request.songId, firstSampleHostNs: stamp.firstSampleHostNs, firstSampleQuality: stamp.firstSampleQuality, sampleRate: stamp.sampleRate })
          if (!raw.ok || raw.found === false || raw.paused || raw.seekDuringCallback) active.placementFault = true
          else {
            active.inputLatencyFrames = stamp.inputLatencyFrames ?? 0
            active.outputLatencyFrames = raw.outputLatencyFrames ?? 0
            active.graphLatencyFrames = raw.graphLatencyFrames ?? 0
            const placed = await this.query({ songId: request.songId, firstSampleHostNs: stamp.firstSampleHostNs, firstSampleQuality: stamp.firstSampleQuality, sampleRate: stamp.sampleRate, inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames, graphLatencyFrames: active.graphLatencyFrames })
            if (!placed.ok || placed.found === false || placed.paused || placed.seekDuringCallback) active.placementFault = true
            else {
              active.startPositionSec = placed.startPositionSec ?? placed.songSeconds ?? 0
              active.latencySource = placed.latencySource ?? (stamp.firstSampleQuality === 'unknown' ? 'measured-trim' : 'reported')
              active.discontinuitySerial = placed.discontinuitySerial
            }
          }
          if (active.placementFault) active.latencySource = 'measured-trim'
        }
      }
      this.active = active
      this.finalizedTake = null
      if (active.firstSampleHostNs && this.options.native.captureStats) {
        active.monitor = setInterval(() => { void this.checkDiscontinuity(active) }, 250)
        active.monitor.unref()
      }
      return { ok: true, takeId }
    } finally {
      if (captureAttempted && !this.active && this.options.native.stopCapture) await this.options.native.stopCapture(generation).catch(() => undefined)
    }
  }

  private async waitForFirstSample(): Promise<{ firstSampleHostNs?: string; lastSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; sampleRate?: number; inputLatencyFrames?: number } | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const stats = await this.options.native.captureStats!().catch(() => undefined)
      if (stats?.firstSampleCaptured && stats.firstSampleHostNs !== undefined) {
        try { return { firstSampleHostNs: BigInt(stats.firstSampleHostNs).toString(), lastSampleHostNs: stats.lastSampleHostNs, firstSampleQuality: stats.firstSampleQuality, sampleRate: stats.sampleRate, inputLatencyFrames: stats.inputLatencyFrames } } catch { return null }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return null
  }

  private async checkDiscontinuity(active: Active): Promise<void> {
    if (this.active !== active || !active.firstSampleHostNs) return
    const stats = await this.options.native.captureStats!().catch(() => undefined)
    if (!stats?.lastSampleHostNs) return
    active.lastSampleHostNs = stats.lastSampleHostNs
    const placement = await this.query({ songId: active.request.songId, firstSampleHostNs: stats.lastSampleHostNs, firstSampleQuality: stats.firstSampleQuality, inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames, graphLatencyFrames: active.graphLatencyFrames, sampleRate: stats.sampleRate ?? active.sampleRate, initialDiscontinuitySerial: active.discontinuitySerial })
    if (!placement.found) return
    if (placement.ok && active.discontinuitySerial !== undefined && placement.discontinuitySerial !== undefined && placement.discontinuitySerial !== active.discontinuitySerial) {
      await this.stop(undefined, 'seek')
    }
  }

  async settings(change: VoiceRecordSettingsChange): Promise<{ ok: boolean; error?: string }> {
    if (!this.active || this.active.takeId !== change.takeId) return { ok: false, error: 'No matching recording.' }
    const last = this.active.settings.at(-1)
    if (last?.tempo === change.tempo && last.transposeSemitones === change.transposeSemitones) return { ok: true }
    const elapsed = Math.max(0, (this.now().getTime() - Date.parse(this.active.createdAt)) / 1000)
    this.active.settings.push({ atSec: elapsed, tempo: change.tempo, transposeSemitones: change.transposeSemitones })
    return { ok: true }
  }

  async stop(reason?: 'device-lost' | 'error', note?: 'seek'): Promise<VoiceRecordStopResult> {
    const active = this.active
    if (!active) return this.finalizedTake ? { ok: true, take: this.finalizedTake } : { ok: false, reason: 'error', message: 'No recording is active.' }
    this.active = null
    if (active.monitor) clearInterval(active.monitor)
    try {
      const finished = await this.options.native.finishTake({ generation: active.generation })
      const wavPath = finished.path ?? active.wavPath
      let file: Awaited<ReturnType<typeof stat>>
      try { file = await stat(wavPath) } catch {
        return { ok: false, reason: finished.deviceLost ? 'device-lost' : 'error', message: finished.error ?? finished.message ?? 'The take file could not be read.' }
      }
      const sampleRate = finished.sampleRate ?? active.sampleRate ?? 44100
      const durationSec = finished.frames !== undefined ? finished.frames / sampleRate : wavDuration(file.size, sampleRate)
      const placementMiss = active.placementFault === true
      const sidecar: VoiceTakeSidecar = {
        version: VOICE_TAKE_SIDECAR_VERSION, takeId: active.takeId, songId: active.request.songId,
        songTitle: active.request.songTitle, songArtist: active.request.songArtist, createdAt: active.createdAt,
        startPositionSec: active.startPositionSec, durationSec, sampleRate, channels: 1,
        inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames,
        graphLatencyFrames: active.graphLatencyFrames, latencySource: placementMiss ? 'measured-trim' : active.latencySource, input: active.request.input,
        settings: active.settings, matchPercent: null, monitoring: false,
        status: finished.deviceLost || reason === 'device-lost' ? 'partial-device-lost' : !finished.ok || reason === 'error' || placementMiss ? 'partial-error' : 'complete',
        name: null, audio: { fileName: basename(wavPath), format: 'wav-pcm16', byteSize: file.size, checksum: null }
      }
      await this.writeSidecar(active.dir, active.takeId, sidecar)
      this.finalizedTake = summary(sidecar)
      return { ok: true, take: this.finalizedTake }
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error && !error.message.includes('/') ? error.message : 'The take could not be finalized.' }
    } finally {
      if (this.options.native.stopCapture) await this.options.native.stopCapture(active.generation).catch(() => undefined)
    }
  }

  async cancel(): Promise<{ ok: boolean; error?: string }> {
    if (!this.active) return { ok: false, error: 'No recording is active.' }
    const active = this.active
    this.active = null
    if (active.monitor) clearInterval(active.monitor)
    try {
      const result = await this.options.native.cancelTake({ generation: active.generation })
      await Promise.all([rm(active.wavPath, { force: true }), rm(join(active.dir, `${active.takeId}.json`), { force: true })])
      return result
    } finally {
      if (this.options.native.stopCapture) await this.options.native.stopCapture(active.generation).catch(() => undefined)
    }
  }

  async list(songId: string): Promise<VoiceTakeSummary[]> {
    let dir: string
    try { dir = this.songDir(songId) } catch { return [] }
    let names: string[]
    try { names = await readdir(dir) } catch { return [] }
    const result: VoiceTakeSummary[] = []
    for (const name of names.filter(n => n.endsWith('.json'))) {
      try {
        const sidecar = JSON.parse(await readFile(join(dir, name), 'utf8')) as VoiceTakeSidecar
        if (sidecar.version !== VOICE_TAKE_SIDECAR_VERSION) continue
        result.push(summary(sidecar))
      } catch { /* malformed sidecars remain untouched */ }
    }
    for (const name of names.filter(n => n.endsWith('.wav'))) {
      const takeId = name.slice(0, -4)
      if (this.active?.request.songId === songId && this.active.takeId === takeId) continue
      const sidecarPath = join(dir, `${takeId}.json`)
      try { await stat(sidecarPath); continue } catch { /* recover below */ }
      try {
        const wavPath = join(dir, name)
        const file = await stat(wavPath)
        const wav = await readWavInfo(wavPath)
        const recovered: VoiceTakeSidecar = {
        version: VOICE_TAKE_SIDECAR_VERSION, takeId, songId, songTitle: '', songArtist: '', createdAt: this.now().toISOString(),
        startPositionSec: 0, durationSec: wav.dataBytes / 2 / wav.sampleRate, sampleRate: wav.sampleRate, channels: 1,
        inputLatencyFrames: 0, outputLatencyFrames: 0, graphLatencyFrames: 0, latencySource: 'measured-trim',
        input: { deviceName: '', channelIndex: 0 }, settings: [{ atSec: 0, tempo: 1, transposeSemitones: 0 }],
        matchPercent: null, monitoring: false, status: 'recovered', name: null,
        audio: { fileName: name, format: 'wav-pcm16', byteSize: file.size, checksum: null }
        }
        await this.writeSidecar(dir, takeId, recovered)
        result.push(summary(recovered))
      } catch { /* incomplete or malformed WAVs remain for a later recovery */ }
    }
    return result.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }

  async remove(songId: string, takeId: string): Promise<{ ok: boolean; error?: string }> {
    let paths: { dir: string; wav: string; sidecar: string }
    try { paths = this.takePaths(songId, takeId) } catch { return { ok: false, error: 'Invalid take id.' } }
    await Promise.all([rm(paths.wav, { force: true }), rm(paths.sidecar, { force: true })])
    return { ok: true }
  }

  async play(request: VoicePlayTakeRequest): Promise<{ ok: boolean; error?: string }> {
    if (!validId(request.takeId)) return { ok: false, error: 'Invalid take id.' }
    const matches = await this.findTake(request.takeId)
    if (!matches) return { ok: false, error: 'Take not found.' }
    if (matches.sidecar.version !== VOICE_TAKE_SIDECAR_VERSION) return { ok: false, error: 'This take was made by a newer version.' }
    const generation = BigInt(`0x${request.takeId.replace(/-/g, '').slice(0, 15)}`)
    const result = await this.options.native.playTake({ takeId: request.takeId, path: matches.wav, startPositionSec: matches.sidecar.startPositionSec, mode: request.mode, generation, tempo: matches.sidecar.settings[0]?.tempo ?? 1 })
    if (result.ok) this.playGeneration = generation
    return result
  }
  stopPlay(): Promise<{ ok: boolean; error?: string }> {
    const generation = this.playGeneration
    this.playGeneration = null
    return this.options.native.stopTake(generation ?? undefined)
  }
  async level(): Promise<VoiceInputLevel> {
    const level = await this.options.native.level()
    return { ...level, takeActive: this.active !== null }
  }

  private async findTake(takeId: string): Promise<{ wav: string; sidecar: VoiceTakeSidecar } | null> {
    let songs: string[]
    try { songs = await readdir(this.root) } catch { return null }
    for (const songId of songs) {
      if (!validId(songId)) continue
      const paths = this.takePaths(songId, takeId)
      try { return { wav: paths.wav, sidecar: JSON.parse(await readFile(paths.sidecar, 'utf8')) as VoiceTakeSidecar } } catch { /* next song */ }
    }
    return null
  }

  private async writeSidecar(dir: string, takeId: string, sidecar: VoiceTakeSidecar): Promise<void> {
    await mkdir(dir, { recursive: true })
    const target = join(dir, `${takeId}.json`)
    const temp = `${target}.${randomUUID()}.tmp`
    const bytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`)
    const { openSync, closeSync, fsyncSync } = await import('node:fs')
    const fd = openSync(temp, 'wx', 0o600)
    try { writeAllSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    await rename(temp, target)
    fsyncDirectorySync(dirname(target))
  }
}

export const createUnavailableVoiceNative = (): VoiceTakeNative => ({
  async recordTake() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async finishTake() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async cancelTake() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async presentationQuery() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async playTake() { return { ok: false, error: 'Voice playback is unavailable.' } },
  async stopTake() { return { ok: false, error: 'Voice playback is unavailable.' } },
  async level() { return { peakDb: -120, rmsDb: -120 } }
})

