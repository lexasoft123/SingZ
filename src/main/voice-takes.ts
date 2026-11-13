import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
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
  VoiceInputLevel,
  VoiceTakeMoveRequest,
  VoiceTakeMoveResult,
  VoiceTakePeaksRequest,
  VoiceTakePeaksResult,
  VoiceTakeAnchor
} from '../shared/voice-take'
import { VOICE_TAKE_MAX_OFFSET_SEC, VOICE_TAKE_PEAKS_MAX, VOICE_TAKE_SIDECAR_VERSION, VOICE_TAKE_ANCHORS_MAX, defaultVoiceTakeEffects, isVoiceTakeAnchors, isVoiceTakeEffects } from '../shared/voice-take'

export type VoiceTakeNative = {
  armCapture(args: { deviceName: string; channelIndex: number }): Promise<{ ok: boolean; reason?: 'no-input' | 'busy' | 'error'; error?: string; generation?: bigint; deviceName?: string }>
  disarmCapture(generation?: bigint): Promise<{ ok: boolean; error?: string }>
  recordTake(args: { dir: string; takeId: string; generation?: bigint; deviceName?: string; channelIndex?: number }): Promise<{ ok: boolean; reason?: 'no-input' | 'busy' | 'error'; error?: string; generation?: bigint; deviceName?: string }>
  finishTake(args: { generation: bigint }): Promise<{ ok: boolean; path?: string; frames?: number; sampleRate?: number; droppedBlocks?: number; firstSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; deviceLost?: boolean; reason?: string; error?: string; message?: string }>
  cancelTake(args: { generation: bigint }): Promise<{ ok: boolean; error?: string }>
  stopCapture?(generation: bigint): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  captureStats(): Promise<{ takeFrameHostNs?: string; takeFrame?: string | number; gapOverflow?: boolean; gapRegressions?: string | number; firstSampleCaptured?: boolean; firstSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; sampleRate?: number; lastSampleHostNs?: string; inputLatencyFrames?: number; inputLatencySource?: 'reported' | 'unknown'; inputLatencyStable?: boolean; inputBufferFrames?: number; inputLevel?: VoiceInputLevel; takeActive?: boolean }>
  presentationQuery(args: { songId: string; firstSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; inputLatencyFrames?: number; outputLatencyFrames?: number; graphLatencyFrames?: number; sampleRate?: number; outputSampleRate?: number; trimInputLatency?: boolean; initialDiscontinuitySerial?: number }): Promise<{ ok: boolean; found?: boolean; paused?: boolean; sampleRate?: number; startPositionSec?: number; songSeconds?: number; projectFrame?: number; inputLatencyFrames?: number; outputLatencyFrames?: number; graphLatencyFrames?: number; latencySource?: 'reported' | 'measured-trim'; discontinuitySerial?: number | string; faultSerial?: number | string; transposeSemitones?: number; generation?: number | string; rate?: number; mappingStartCaptureHostNs?: string; mappingStartSongSeconds?: number; seekDuringCallback?: boolean; error?: string }>
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
  outputSampleRate?: number
  latencySource: 'reported' | 'measured-trim'
  settings: VoiceTakeSettingsPoint[]
  generation: bigint
  firstSampleHostNs?: string
  firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'
  sampleRate?: number
  discontinuitySerial?: number | string
  faultSerial?: number | string
  anchors: VoiceTakeAnchor[]
  timelineApproximate?: boolean
  lastAnchorHostNs?: string
  lastRate?: number
  sampling?: Promise<void>
  placementFault?: boolean
  timelineEnded?: boolean
  monitor?: ReturnType<typeof setInterval>
  lastSampleHostNs?: string
  finalized?: VoiceTakeSummary
  actualDeviceName?: string
  provisional?: VoiceTakeSidecar
}
type ArmedCapture = { generation: bigint; deviceName: string; channelIndex: number }

const summary = (sidecar: VoiceTakeSidecar): VoiceTakeSummary => ({
  takeId: sidecar.takeId, songId: sidecar.songId, createdAt: sidecar.createdAt,
  startPositionSec: sidecar.startPositionSec, userOffsetSec: sidecar.userOffsetSec ?? 0, durationSec: sidecar.durationSec,
  status: sidecar.status, name: sidecar.name, tempo: sidecar.settings[0]?.tempo ?? 1,
  transposeSemitones: sidecar.settings[0]?.transposeSemitones ?? 0,
  settingsChanged: sidecar.settings.length > 1,
  effects: sidecar.effects ?? defaultVoiceTakeEffects(),
  timelineApproximate: sidecar.timelineApproximate === true || !sidecar.anchors
})

/** Bound legacy wall-clock changes, preserving the initial state and latest state.
 * Once full, intermediate changes are approximate and the newest replaces the tail. */
export function appendLegacySetting(settings: VoiceTakeSettingsPoint[], point: VoiceTakeSettingsPoint): boolean {
  const last = settings.at(-1)
  if (last && last.tempo === point.tempo && last.transposeSemitones === point.transposeSemitones) return false
  if (last && point.atSec <= last.atSec) {
    if (settings.length > 1) settings[settings.length - 1] = { ...point, atSec: last.atSec }
    return true
  }
  if (settings.length < VOICE_TAKE_ANCHORS_MAX) settings.push(point)
  else settings[settings.length - 1] = point
  return true
}

const validSettings = (point: { tempo: number; transposeSemitones: number }): boolean =>
  Number.isFinite(point.tempo) && point.tempo >= .25 && point.tempo <= 4 &&
  Number.isFinite(point.transposeSemitones) && Math.abs(point.transposeSemitones) <= 24

const validTimelineFields = (sidecar: VoiceTakeSidecar): boolean =>
  (sidecar.anchors === undefined || isVoiceTakeAnchors(sidecar.anchors)) &&
  (sidecar.effects === undefined || isVoiceTakeEffects(sidecar.effects)) &&
  (sidecar.timelineApproximate === undefined || typeof sidecar.timelineApproximate === 'boolean')

const wavDuration = (bytes: number, sampleRate: number): number => Math.max(0, bytes - 44) / 2 / sampleRate

const readWavInfo = async (path: string): Promise<{ sampleRate: number; dataBytes: number; frames: number }> => {
  const file = await stat(path)
  const bytes = Buffer.alloc(44)
  const handle = await open(path, 'r')
  try { const read = await handle.read(bytes, 0, 44, 0); if (read.bytesRead < 44) throw new Error('Invalid WAV header') } finally { await handle.close() }
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV header')
  const sampleRate = bytes.readUInt32LE(24)
  if (!sampleRate) throw new Error('Invalid WAV sample rate')
  const available = Math.max(0, file.size - 44)
  const declared = bytes.toString('ascii', 36, 40) === 'data' ? bytes.readUInt32LE(40) : 0
  const dataBytes = Math.max(0, Math.min(available, declared === 0 || declared > available ? available : declared)) & ~1
  return { sampleRate, dataBytes, frames: dataBytes / 2 }
}

/**
 * Waveform peaks of a pcm16 mono WAV: the loudest absolute sample (0..1) per slice, one slice per ~10 ms,
 * coarser only when that would exceed `maxPeaks`. Streamed in chunks; never holds the whole file.
 */
export async function computeWavPeaks(path: string, maxPeaks = VOICE_TAKE_PEAKS_MAX, startFrame = 0, endFrame?: number): Promise<{ stepSec: number; durationSec: number; peaks: number[] }> {
  const info = await readWavInfo(path)
  const start = Math.max(0, Math.min(info.frames, Math.floor(startFrame)))
  const frames = Math.max(0, Math.min(info.frames, endFrame ?? info.frames) - start)
  const stepFrames = Math.max(1, Math.round(info.sampleRate * 0.01), Math.ceil(frames / Math.max(1, maxPeaks)))
  const peaks: number[] = new Array(Math.ceil(frames / stepFrames)).fill(0)
  const handle = await open(path, 'r')
  try {
    const chunk = Buffer.alloc(64 * 1024)
    let frame = 0
    let position = 44 + start * 2
    while (frame < frames) {
      const want = Math.min(chunk.length, (frames - frame) * 2)
      const { bytesRead } = await handle.read(chunk, 0, want, position)
      if (bytesRead < 2) break
      const samples = bytesRead >> 1
      for (let i = 0; i < samples; i++, frame++) {
        const v = Math.abs(chunk.readInt16LE(i * 2)) / 32768
        const slot = Math.floor(frame / stepFrames)
        if (v > peaks[slot]!) peaks[slot] = v
      }
      position += samples * 2
    }
  } finally { await handle.close() }
  return { stepSec: stepFrames / info.sampleRate, durationSec: frames / info.sampleRate, peaks: peaks.map(p => Math.round(Math.min(1, p) * 1000) / 1000) }
}

const PEAK_CACHE_MAX = 16

export class VoiceTakeStore {
  private readonly takeEdits = new Map<string, Promise<unknown>>()
  private editTake<T>(songId: string, takeId: string, edit: () => Promise<T>): Promise<T> {
    const key = `${songId}/${takeId}`
    const run = (this.takeEdits.get(key) ?? Promise.resolve()).catch(() => {}).then(edit)
    this.takeEdits.set(key, run)
    return run.finally(() => { if (this.takeEdits.get(key) === run) this.takeEdits.delete(key) })
  }
  private readonly peakCache = new Map<string, { stepSec: number; durationSec: number; peaks: number[] }>()
  /** Takes whose WAV and sidecar are still being finalized: peaks and moves wait (stop() clears `active` first). */
  private readonly finalizing = new Set<string>()
  private active: Active | null = null
  private starting = false
  private arming = false
  private armed: ArmedCapture | null = null
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

  async arm(request: { input: { deviceName: string; channelIndex: number } }): Promise<{ ok: boolean; reason?: 'no-input' | 'busy' | 'error'; message?: string }> {
    if (this.active || this.starting || this.arming) return { ok: false, reason: 'busy', message: 'A voice take is already recording or arming.' }
    if (!Number.isInteger(request.input.channelIndex) || request.input.channelIndex < 0) return { ok: false, reason: 'no-input', message: 'The selected microphone is unavailable.' }
    this.arming = true
    try {
      const result = await this.options.native.armCapture(request.input)
      if (!result.ok || result.generation === undefined) {
        if (this.armed) {
          const released = await this.options.native.disarmCapture(this.armed.generation)
          if (!released.ok) return { ok: false, reason: 'error', message: 'The microphone could not be released.' }
          this.armed = null
        }
        return { ok: false, reason: result.reason ?? 'error', message: result.error ?? 'The microphone could not be armed.' }
      }
      this.armed = { generation: result.generation, deviceName: result.deviceName ?? request.input.deviceName, channelIndex: request.input.channelIndex }
      return { ok: true }
    } finally { this.arming = false }
  }

  async disarm(): Promise<{ ok: boolean; error?: string }> {
    if (this.active || this.starting || this.arming) return { ok: false, error: 'A voice take is active or starting.' }
    const armed = this.armed
    this.armed = null
    return this.options.native.disarmCapture(armed?.generation)
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
    if (this.active || this.starting || this.arming) return { ok: false, reason: 'busy', message: 'A voice take is already recording.' }
    this.finalizedTake = null
    if (!validId(request.songId) || !request.input || !validSettings(request)) return { ok: false, reason: 'error', message: 'Invalid recording request.' }
    if (!Number.isInteger(request.input.channelIndex) || request.input.channelIndex < 0) return { ok: false, reason: 'no-input', message: 'The selected microphone is unavailable.' }
    const takeId = randomUUID()
    const paths = this.takePaths(request.songId, takeId)
    const generation = BigInt(`0x${takeId.replace(/-/g, '').slice(0, 15)}`)
    let captureAttempted = false
    let captureGeneration = generation
    this.starting = true
    try {
      if (this.armed) {
        const selected = await this.options.native.armCapture(request.input)
        if (!selected.ok || selected.generation === undefined) {
          const released = await this.options.native.disarmCapture(this.armed.generation)
          if (!released.ok) return { ok: false, reason: 'error', message: 'The microphone could not be released.' }
          this.armed = null
          return { ok: false, reason: selected.reason ?? 'error', message: selected.reason === 'no-input' ? 'The selected microphone is unavailable.' : 'The microphone could not be armed.' }
        }
        this.armed = { generation: selected.generation, deviceName: selected.deviceName ?? request.input.deviceName, channelIndex: request.input.channelIndex }
      }
      await mkdir(paths.dir, { recursive: true })
      captureAttempted = true
      const result = await this.options.native.recordTake({ dir: paths.dir, takeId, generation: this.armed?.generation ?? generation, deviceName: request.input.deviceName, channelIndex: request.input.channelIndex })
      captureGeneration = result.generation ?? this.armed?.generation ?? generation
      if (!result.ok) return { ok: false, reason: result.reason ?? 'error', message: result.reason === 'no-input' ? 'The selected microphone is unavailable.' : result.error ?? 'Recording could not start.' }
      const active: Active = {
      request, takeId, dir: paths.dir, wavPath: paths.wav, createdAt: this.now().toISOString(),
      startPositionSec: 0, inputLatencyFrames: 0, outputLatencyFrames: 0, graphLatencyFrames: 0,
      latencySource: 'reported', anchors: [],
      settings: [{ atSec: 0, tempo: request.tempo, transposeSemitones: request.transposeSemitones }], generation: result.generation ?? this.armed?.generation ?? generation
      }
      active.actualDeviceName = result.deviceName ?? this.armed?.deviceName ?? request.input.deviceName
      {
        const stamp = await this.waitForFirstSample()
        if (!stamp || !stamp.firstSampleHostNs || !stamp.sampleRate) { active.placementFault = true }
        else {
          active.firstSampleHostNs = stamp.firstSampleHostNs
          active.lastSampleHostNs = stamp.lastSampleHostNs ?? stamp.firstSampleHostNs
          active.firstSampleQuality = stamp.firstSampleQuality
          active.sampleRate = stamp.sampleRate
          const raw = await this.query({ songId: request.songId, firstSampleHostNs: stamp.firstSampleHostNs, firstSampleQuality: stamp.firstSampleQuality, sampleRate: stamp.sampleRate, trimInputLatency: false })
          if (!raw.ok || raw.found === false || raw.paused || raw.seekDuringCallback) active.placementFault = true
          else {
            const reported = stamp.inputLatencySource === 'reported' && stamp.inputLatencyStable !== false
            active.inputLatencyFrames = reported ? stamp.inputLatencyFrames ?? 0 : 0
            active.outputLatencyFrames = raw.outputLatencyFrames ?? 0
            active.graphLatencyFrames = raw.graphLatencyFrames ?? 0
            // Freeze this take's latency basis (ADR 0016, WP1): switching the
            // graph-delay subtraction at a tempo seam can regress the map.
            // Hardware gate: tone across 1 -> .5, error before/at/after <=5 ms.
            active.outputSampleRate = raw.sampleRate
            const placed = await this.query({ songId: request.songId, firstSampleHostNs: stamp.firstSampleHostNs, firstSampleQuality: stamp.firstSampleQuality, sampleRate: stamp.sampleRate, outputSampleRate: raw.sampleRate, inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames, graphLatencyFrames: active.graphLatencyFrames, trimInputLatency: true })
            if (!placed.ok || placed.found === false || placed.paused || placed.seekDuringCallback) active.placementFault = true
            else {
              const startPositionSec = placed.startPositionSec ?? placed.songSeconds
              if (!Number.isFinite(startPositionSec)) active.placementFault = true
              else active.startPositionSec = startPositionSec!
              active.latencySource = reported ? 'reported' : 'measured-trim'
              active.discontinuitySerial = placed.discontinuitySerial
              active.faultSerial = placed.faultSerial
              active.lastRate = placed.rate ?? request.tempo
              active.lastAnchorHostNs = stamp.firstSampleHostNs
              active.timelineApproximate = stamp.firstSampleQuality !== 'hardware'
              this.appendAnchor(active, { takeFrame: 0, projectFrame: Math.round(active.startPositionSec * stamp.sampleRate) })
            }
          }
          if (active.placementFault) active.latencySource = 'measured-trim'
        }
      }
      if (!active.placementFault && active.firstSampleHostNs && active.sampleRate) {
        active.provisional = {
          version: VOICE_TAKE_SIDECAR_VERSION, takeId: active.takeId, songId: request.songId,
          songTitle: request.songTitle, songArtist: request.songArtist, createdAt: active.createdAt,
          startPositionSec: active.startPositionSec, durationSec: 0, sampleRate: active.sampleRate, channels: 1,
          inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames,
          graphLatencyFrames: active.graphLatencyFrames, latencySource: active.latencySource, input: { ...request.input, deviceName: active.actualDeviceName ?? request.input.deviceName },
          settings: active.settings, anchors: active.anchors, effects: defaultVoiceTakeEffects(), timelineApproximate: active.timelineApproximate, matchPercent: null, monitoring: false, status: 'recovered', name: null,
          audio: { fileName: `${active.takeId}.wav`, format: 'wav-pcm16', byteSize: 0, checksum: null }
        }
        await this.writeSidecar(active.dir, active.takeId, active.provisional)
      }
      this.active = active
      this.finalizedTake = null
      if (active.firstSampleHostNs) {
        active.monitor = setInterval(() => { void this.checkDiscontinuity(active).catch(() => { this.endTimeline(active); void this.stop(undefined, 'seek') }) }, 250)
        active.monitor.unref()
      }
      return { ok: true, takeId }
    } finally {
      if (captureAttempted && !this.active && !this.armed && this.options.native.stopCapture) await this.options.native.stopCapture(captureGeneration).catch(() => undefined)
      this.starting = false
    }
  }

  private async waitForFirstSample(): Promise<{ firstSampleHostNs?: string; lastSampleHostNs?: string; firstSampleQuality?: 'hardware' | 'estimated' | 'unknown'; sampleRate?: number; inputLatencyFrames?: number; inputLatencySource?: 'reported' | 'unknown'; inputLatencyStable?: boolean; inputBufferFrames?: number } | null> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const stats = await this.options.native.captureStats().catch(() => undefined)
      if (stats?.firstSampleCaptured && stats.firstSampleHostNs !== undefined) {
        try { return { firstSampleHostNs: BigInt(stats.firstSampleHostNs).toString(), lastSampleHostNs: stats.lastSampleHostNs, firstSampleQuality: stats.firstSampleQuality, sampleRate: stats.sampleRate, inputLatencyFrames: stats.inputLatencyFrames, inputLatencySource: stats.inputLatencySource, inputLatencyStable: stats.inputLatencyStable, inputBufferFrames: stats.inputBufferFrames } } catch { return null }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return null
  }

  /** Poll faster than the journal's ~2.7 s retention. Never await a wall-clock settings timer. */
  private async checkDiscontinuity(active: Active, force = false): Promise<void> {
    if (this.active !== active || !active.firstSampleHostNs) return
    if (active.sampling) { await active.sampling; return }
    active.sampling = this.sampleAnchors(active, force)
    try { await active.sampling } finally { active.sampling = undefined }
    if (active.placementFault && this.active === active) await this.stop('error')
    else if (active.timelineEnded && this.active === active) await this.stop(undefined, 'seek')
  }

  private endTimeline(active: Active): void {
    // After placement, transport boundaries end the valid recording timeline;
    // they do not invalidate its measured start or the anchors already captured.
    if (active.anchors.length) active.timelineEnded = true
    else active.placementFault = true
  }

  private async sampleAnchors(active: Active, force: boolean): Promise<void> {
    if (active.timelineEnded) return
    const stats = await this.options.native.captureStats()
    const host = stats.takeFrameHostNs ?? stats.lastSampleHostNs
    if (!host || !active.sampleRate) return
    if (stats.gapOverflow || Number(stats.gapRegressions ?? 0) > 0 ||
        stats.sampleRate !== undefined && stats.sampleRate !== active.sampleRate) { active.placementFault = true; return }
    const rate = active.sampleRate
    const frame = stats.takeFrame === undefined ?
      Math.round(Number(BigInt(host) - BigInt(active.firstSampleHostNs!)) * rate / 1e9) : Number(stats.takeFrame)
    if (!Number.isSafeInteger(frame) || frame < 0) { active.placementFault = true; return }
    // An older addon has no exact file cursor. Keep the compatibility map explicitly approximate.
    if (stats.takeFrame === undefined) active.timelineApproximate = true
    const queryAt = (at: string) => this.query({ songId: active.request.songId,
      firstSampleHostNs: at, firstSampleQuality: stats.firstSampleQuality,
      inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames,
      graphLatencyFrames: active.graphLatencyFrames, sampleRate: rate,
      outputSampleRate: active.outputSampleRate, trimInputLatency: true })
    const placement = await queryAt(host)
    const faulty = (p: Awaited<ReturnType<typeof queryAt>>) =>
      !p.ok || p.found === false || p.paused || p.seekDuringCallback ||
      (active.faultSerial !== undefined && p.faultSerial !== active.faultSerial) ||
      (p.discontinuitySerial !== active.discontinuitySerial &&
        (active.faultSerial === undefined || p.faultSerial === undefined))
    if (faulty(placement)) { this.endTimeline(active); return }
    // Walk back through every landed mapping epoch, even several fast changes
    // between polls. The boundary coordinates come from the presentation journal.
    const seams: Array<VoiceTakeAnchor & { tempo?: number; transposeSemitones?: number }> = []
    let epoch = placement
    let upperHost = BigInt(host) + 1n
    const lowerHost = BigInt(active.lastAnchorHostNs ?? active.firstSampleHostNs!)
    for (let count = 0; epoch.mappingStartCaptureHostNs; count++) {
      const edge = BigInt(epoch.mappingStartCaptureHostNs)
      if (edge <= lowerHost) break
      if (count >= 64 || edge >= upperHost || !Number.isFinite(epoch.mappingStartSongSeconds)) { active.placementFault = true; return }
      const takeFrame = frame + Math.round(Number(edge - BigInt(host)) * rate / 1e9)
      seams.push({ takeFrame, projectFrame: Math.round(epoch.mappingStartSongSeconds! * rate), tempo: epoch.rate, transposeSemitones: epoch.transposeSemitones })
      upperHost = edge
      epoch = await queryAt((edge - 1n).toString())
      if (faulty(epoch)) { this.endTimeline(active); return }
    }
    for (const anchor of seams.reverse()) {
      this.appendAnchor(active, { takeFrame: anchor.takeFrame, projectFrame: anchor.projectFrame })
      if (anchor.tempo !== undefined && anchor.transposeSemitones !== undefined) {
        const lastSetting = active.settings.at(-1)!
        if (active.settings.length >= VOICE_TAKE_ANCHORS_MAX) { active.placementFault = true; return }
        if (lastSetting.tempo !== anchor.tempo || lastSetting.transposeSemitones !== anchor.transposeSemitones)
          active.settings.push({ atSec: anchor.takeFrame / rate, tempo: anchor.tempo, transposeSemitones: anchor.transposeSemitones })
      }
    }
    const seconds = placement.startPositionSec ?? placement.songSeconds
    if (!Number.isFinite(seconds)) { active.placementFault = true; return }
    const previousCount = active.anchors.length
    const last = active.anchors.at(-1)
    if (force || seams.length || !last || frame - last.takeFrame >= rate * 2)
      this.appendAnchor(active, { takeFrame: frame, projectFrame: Math.round(seconds! * rate) })
    active.lastAnchorHostNs = host
    active.lastSampleHostNs = host
    active.lastRate = placement.rate ?? active.lastRate
    active.discontinuitySerial = placement.discontinuitySerial
    if (active.provisional && (force || seams.length || active.anchors.length !== previousCount)) {
      await this.writeSidecar(active.dir, active.takeId, { ...active.provisional,
        anchors: [...active.anchors], settings: [...active.settings], timelineApproximate: active.timelineApproximate })
    }
  }

  private appendAnchor(active: Active, anchor: VoiceTakeAnchor): void {
    const last = active.anchors.at(-1)
    if (last && anchor.takeFrame === last.takeFrame && anchor.projectFrame === last.projectFrame) return
    if (!Number.isSafeInteger(anchor.takeFrame) || !Number.isSafeInteger(anchor.projectFrame) ||
        anchor.takeFrame < 0 || anchor.projectFrame < 0 ||
        last && (anchor.takeFrame <= last.takeFrame || anchor.projectFrame <= last.projectFrame) ||
        active.anchors.length >= VOICE_TAKE_ANCHORS_MAX) { active.placementFault = true; return }
    active.anchors.push(anchor)
  }

  async settings(change: VoiceRecordSettingsChange): Promise<{ ok: boolean; error?: string }> {
    if (!this.active || this.active.takeId !== change.takeId) return { ok: false, error: 'No matching recording.' }
    if (!validSettings(change)) return { ok: false, error: 'Invalid recording settings.' }
    const last = this.active.settings.at(-1)
    if (last?.tempo === change.tempo && last.transposeSemitones === change.transposeSemitones) return { ok: true }
    const elapsed = Math.max(0, (this.now().getTime() - Date.parse(this.active.createdAt)) / 1000)
    const active = this.active
    await this.checkDiscontinuity(active, true)
    if (this.active !== active) return { ok: false, error: 'Recording timing was interrupted.' }
    // With native epoch telemetry the landed generation owns the settings time.
    // Older addons retain the historical wall-clock fallback, visibly approximate.
    if (active.faultSerial === undefined) {
      active.timelineApproximate = true
      appendLegacySetting(active.settings, { atSec: elapsed, tempo: change.tempo, transposeSemitones: change.transposeSemitones })
    }
    return { ok: true }
  }

  async stop(reason?: 'device-lost' | 'error', note?: 'seek'): Promise<VoiceRecordStopResult> {
    const active = this.active
    if (!active) return this.finalizedTake ? { ok: true, take: this.finalizedTake } : { ok: false, reason: 'error', message: 'No recording is active.' }
    if (active.monitor) clearInterval(active.monitor)
    if (active.sampling) await active.sampling.catch(() => this.endTimeline(active))
    if (this.active !== active) return this.stop(reason, note)
    this.active = null
    this.finalizing.add(active.takeId)
    if (active.monitor) clearInterval(active.monitor)
    try {
      const finished = await this.options.native.finishTake({ generation: active.generation })
      // The writer is drained now. Include the last committed block (and any
      // seam after the final timer tick) before extrapolating its short tail.
      if (!active.placementFault) {
        try { await this.sampleAnchors(active, true) } catch { this.endTimeline(active) }
      }
      const wavPath = finished.path ?? active.wavPath
      let file: Awaited<ReturnType<typeof stat>>
      try { file = await stat(wavPath) } catch {
        return { ok: false, reason: finished.deviceLost ? 'device-lost' : 'error', message: finished.error ?? finished.message ?? 'The take file could not be read.' }
      }
      const sampleRate = finished.sampleRate ?? active.sampleRate ?? 44100
      if (active.sampleRate !== undefined && sampleRate !== active.sampleRate) {
        active.placementFault = true
        active.anchors = []
      }
      const durationSec = finished.frames !== undefined ? finished.frames / sampleRate : wavDuration(file.size, sampleRate)
      const frames = Math.round(durationSec * sampleRate)
      active.anchors = active.anchors.filter(anchor => anchor.takeFrame <= frames)
      const last = active.anchors.at(-1)
      if (last && frames > last.takeFrame && active.lastRate && !active.placementFault && !active.timelineEnded)
        this.appendAnchor(active, { takeFrame: frames, projectFrame: last.projectFrame + Math.round((frames - last.takeFrame) * active.lastRate) })
      const placementMiss = active.placementFault === true
      const sidecar: VoiceTakeSidecar = {
        version: VOICE_TAKE_SIDECAR_VERSION, takeId: active.takeId, songId: active.request.songId,
        songTitle: active.request.songTitle, songArtist: active.request.songArtist, createdAt: active.createdAt,
        startPositionSec: active.startPositionSec, durationSec, sampleRate, channels: 1,
        inputLatencyFrames: active.inputLatencyFrames, outputLatencyFrames: active.outputLatencyFrames,
        graphLatencyFrames: active.graphLatencyFrames, latencySource: placementMiss ? 'measured-trim' : active.latencySource, input: { ...active.request.input, deviceName: active.actualDeviceName ?? active.request.input.deviceName },
        settings: active.settings, ...(active.anchors.length ? { anchors: active.anchors } : {}), effects: defaultVoiceTakeEffects(), timelineApproximate: active.timelineApproximate, matchPercent: null, monitoring: false,
        status: finished.deviceLost || reason === 'device-lost' ? 'partial-device-lost' : !finished.ok || reason === 'error' || placementMiss ? 'partial-error' : 'complete',
        name: null, audio: { fileName: basename(wavPath), format: 'wav-pcm16', byteSize: file.size, checksum: null }
      }
      await this.writeSidecar(active.dir, active.takeId, sidecar)
      this.finalizedTake = summary(sidecar)
      return { ok: true, take: this.finalizedTake }
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error && !error.message.includes('/') ? error.message : 'The take could not be finalized.' }
    } finally {
      this.finalizing.delete(active.takeId)
      if (!this.armed && this.options.native.stopCapture) await this.options.native.stopCapture(active.generation).catch(() => undefined)
    }
  }

  async cancel(): Promise<{ ok: boolean; error?: string }> {
    this.finalizedTake = null
    if (!this.active) return { ok: false, error: 'No recording is active.' }
    const active = this.active
    if (active.monitor) clearInterval(active.monitor)
    if (active.sampling) await active.sampling.catch(() => undefined)
    if (this.active !== active) return { ok: false, error: 'No recording is active.' }
    this.active = null
    if (active.monitor) clearInterval(active.monitor)
    try {
      const result = await this.options.native.cancelTake({ generation: active.generation })
      await Promise.all([rm(active.wavPath, { force: true }), rm(join(active.dir, `${active.takeId}.json`), { force: true })])
      return result
    } finally {
      if (!this.armed && this.options.native.stopCapture) await this.options.native.stopCapture(active.generation).catch(() => undefined)
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
        if (sidecar.version !== VOICE_TAKE_SIDECAR_VERSION || !validTimelineFields(sidecar)) continue
        if (this.active?.request.songId === songId && this.active.takeId === sidecar.takeId) { result.push(summary(sidecar)); continue }
        if (sidecar.status === 'recovered') {
          try {
            const wavPath = join(dir, sidecar.audio.fileName)
            const file = await stat(wavPath)
            const wav = await readWavInfo(wavPath)
            const durationSec = wav.frames / wav.sampleRate
            const changed = sidecar.durationSec !== durationSec || sidecar.sampleRate !== wav.sampleRate || sidecar.audio.byteSize !== file.size
            if (sidecar.anchors) {
              if (sidecar.sampleRate !== wav.sampleRate) { delete sidecar.anchors; sidecar.timelineApproximate = true }
              else {
                const retained = sidecar.anchors.filter(anchor => anchor.takeFrame <= wav.frames)
                if (retained.length !== sidecar.anchors.length) sidecar.timelineApproximate = true
                sidecar.anchors = retained
              }
            }
            sidecar.durationSec = durationSec
            sidecar.sampleRate = wav.sampleRate
            sidecar.audio.byteSize = file.size
            if (changed && !(this.active?.request.songId === songId && this.active.takeId === sidecar.takeId)) await this.writeSidecar(dir, sidecar.takeId, sidecar)
          } catch { /* provisional sidecars remain recoverable */ }
        }
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
        startPositionSec: 0, durationSec: wav.frames / wav.sampleRate, sampleRate: wav.sampleRate, channels: 1,
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

  remove(songId: string, takeId: string): Promise<{ ok: boolean; error?: string }> {
    return this.editTake(songId, takeId, () => this.removeTake(songId, takeId))
  }
  private async removeTake(songId: string, takeId: string): Promise<{ ok: boolean; error?: string }> {
    let paths: { dir: string; wav: string; sidecar: string }
    try { paths = this.takePaths(songId, takeId) } catch { return { ok: false, error: 'Invalid take id.' } }
    await Promise.all([rm(paths.wav, { force: true }), rm(paths.sidecar, { force: true })])
    for (const key of [...this.peakCache.keys()]) if (key.startsWith(`${paths.wav}:`)) this.peakCache.delete(key)
    return { ok: true }
  }

  /** Waveform peaks of a finished take, computed from its WAV and cached by file identity. */
  async peaks(request: VoiceTakePeaksRequest): Promise<VoiceTakePeaksResult> {
    let paths: { dir: string; wav: string; sidecar: string }
    try { paths = this.takePaths(request.songId, request.takeId) } catch { return { ok: false, error: 'Invalid take id.' } }
    if (this.active?.takeId === request.takeId || this.finalizing.has(request.takeId)) return { ok: false, error: 'The take is still recording.' }
    try {
      const file = await stat(paths.wav)
      const key = `${paths.wav}:${file.size}:${Math.round(file.mtimeMs)}`
      const cached = this.peakCache.get(key)
      if (cached) return { ok: true, ...cached, peaks: [...cached.peaks] }
      const result = await computeWavPeaks(paths.wav)
      this.peakCache.set(key, result)
      // Bounded: keep the 16 most recent takes, drop the oldest on insert.
      while (this.peakCache.size > PEAK_CACHE_MAX) this.peakCache.delete(this.peakCache.keys().next().value as string)
      return { ok: true, ...result }
    } catch { return { ok: false, error: 'The take audio could not be read.' } }
  }

  /** Persist the singer's shift of a take (the measured placement stays untouched; 0 resets). */
  move(request: VoiceTakeMoveRequest): Promise<VoiceTakeMoveResult> {
    return this.editTake(request.songId, request.takeId, () => this.moveTake(request))
  }
  private async moveTake(request: VoiceTakeMoveRequest): Promise<VoiceTakeMoveResult> {
    let paths: { dir: string; wav: string; sidecar: string }
    try { paths = this.takePaths(request.songId, request.takeId) } catch { return { ok: false, error: 'Invalid take id.' } }
    if (!Number.isFinite(request.userOffsetSec) || Math.abs(request.userOffsetSec) > VOICE_TAKE_MAX_OFFSET_SEC) return { ok: false, error: 'Invalid take offset.' }
    if (this.active?.takeId === request.takeId || this.finalizing.has(request.takeId)) return { ok: false, error: 'The take is still recording.' }
    let sidecar: VoiceTakeSidecar
    try { sidecar = JSON.parse(await readFile(paths.sidecar, 'utf8')) as VoiceTakeSidecar } catch { return { ok: false, error: 'Take not found.' } }
    if (!validTimelineFields(sidecar)) return { ok: false, error: 'Invalid take timeline.' }
    if (sidecar.version !== VOICE_TAKE_SIDECAR_VERSION) return { ok: false, error: 'This take was made by a newer version.' }
    // The take can never start before the song does.
    const offset = Math.max(request.userOffsetSec, -sidecar.startPositionSec)
    if (offset === 0) delete sidecar.userOffsetSec
    else sidecar.userOffsetSec = offset
    await this.writeSidecar(paths.dir, request.takeId, sidecar)
    return { ok: true, take: summary(sidecar) }
  }

  /** The ordered take FX description is durable; playback placement and
   * capture anchors remain immutable when the singer changes a slot. */
  setEffects(songId: string, takeId: string, effects: import('../shared/voice-take').VoiceTakeEffect[]): Promise<void> {
    return this.editTake(songId, takeId, () => this.editEffects(songId, takeId, effects))
  }
  private async editEffects(songId: string, takeId: string, effects: import('../shared/voice-take').VoiceTakeEffect[]): Promise<void> {
    if (!validId(songId) || !validId(takeId) || !isVoiceTakeEffects(effects)) throw new Error('Invalid take effects.')
    if (this.active?.takeId === takeId || this.finalizing.has(takeId)) throw new Error('The take is still recording.')
    const paths = this.takePaths(songId, takeId)
    for (const dir of [this.root, dirname(paths.sidecar)]) {
      const info = await lstat(dir)
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid take directory.')
    }
    const info = await lstat(paths.sidecar)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error('Invalid take sidecar.')
    const sidecar = JSON.parse(await readFile(paths.sidecar, 'utf8')) as VoiceTakeSidecar
    if (sidecar.version !== VOICE_TAKE_SIDECAR_VERSION || !validTimelineFields(sidecar) || sidecar.songId !== songId || sidecar.takeId !== takeId)
      throw new Error('Invalid take sidecar.')
    if (JSON.stringify(sidecar.effects ?? defaultVoiceTakeEffects()) === JSON.stringify(effects)) return
    await this.writeSidecar(dirname(paths.sidecar), takeId, { ...sidecar, effects })
  }

  async play(request: VoicePlayTakeRequest): Promise<{ ok: boolean; error?: string }> {
    if (!validId(request.takeId)) return { ok: false, error: 'Invalid take id.' }
    if (request.gain !== undefined && !Number.isFinite(request.gain)) return { ok: false, error: 'Invalid take gain.' }
    const matches = await this.findTake(request.takeId)
    if (!matches) return { ok: false, error: 'Take not found.' }
    if (!validTimelineFields(matches.sidecar)) return { ok: false, error: 'Invalid take timeline.' }
    if (matches.sidecar.version !== VOICE_TAKE_SIDECAR_VERSION) return { ok: false, error: 'This take was made by a newer version.' }
    const generation = BigInt(`0x${request.takeId.replace(/-/g, '').slice(0, 15)}`)
    const gain = Math.min(8, Math.max(0, request.gain ?? 1))
    const result = await this.options.native.playTake({ takeId: request.takeId, path: matches.wav, startPositionSec: matches.sidecar.startPositionSec + (matches.sidecar.userOffsetSec ?? 0), mode: request.mode, generation, gain, tempo: matches.sidecar.settings[0]?.tempo ?? 1 })
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
    if (!validTimelineFields(sidecar)) throw new Error('Invalid take timeline.')
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
  async armCapture() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async disarmCapture() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async recordTake() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async finishTake() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async cancelTake() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async presentationQuery() { return { ok: false, error: 'Voice recording is unavailable.' } },
  async playTake() { return { ok: false, error: 'Voice playback is unavailable.' } },
  async stopTake() { return { ok: false, error: 'Voice playback is unavailable.' } },
  async captureStats() { return { inputLevel: { peakDb: -120, rmsDb: -120 }, firstSampleCaptured: false } },
  async level() { return { peakDb: -120, rmsDb: -120 } }
})

