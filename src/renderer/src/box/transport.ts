import type {
  LyricLine,
  ProjectInfo,
  ProjectListItem,
  ProjectSettings,
  SingzApi
} from '../../../shared/types'
import type { ParsedGraphDocument } from '../../../shared/graph-document'
import type { EnginePlaybackError, EngineTrackInput, TrackState } from '../audio/engine'
import { MET_DEFAULTS, sanitizeBeatInfo, sanitizeMetronome } from '../audio/beat'
import { desktopLaneMeasureApplies, readLanes } from '../audio/lane-measure'
import { orderedStems } from '../model'
import { sanitizeSongVolume } from '../audio/song-volume'
import { PlaybackOutputArbiter, PlaybackOutputSelectionError } from '../audio/output-routing'
import { t } from './i18n'
import { tSettings } from './settings-i18n'
import { inspectBoxProject, projectMetadata, settingsWithTracks, type BoxProjectMetadata } from './project'

export interface BoxEngine {
  readonly duration: number
  readonly position: number
  readonly playing: boolean
  readonly starting: boolean
  readonly masterVolume: number
  readonly transpose: number
  readonly tempo: number
  readonly playbackError: EnginePlaybackError | null
  readonly outputDeviceId?: string
  load(tracks: EngineTrackInput[], opts: { position?: number; play?: boolean; graphDocument?: ParsedGraphDocument | null }): void
  decode(data: ArrayBuffer): Promise<AudioBuffer>
  play(): Promise<void>
  playAccepted?(): Promise<void>
  pause(): void
  pauseAccepted?(): Promise<void>
  toggle(): void
  seek(position: number): void
  seekBy(delta: number): void
  setVolume(id: string, volume: number): void
  setMuted(id: string, muted: boolean): void
  setSolo(id: string, solo: boolean): void
  setMasterVolume(volume: number): void
  setVolumeAccepted(id: string, volume: number): Promise<void>
  setMutedAccepted(id: string, muted: boolean): Promise<void>
  setSoloAccepted(id: string, solo: boolean): Promise<void>
  setMasterVolumeAccepted(volume: number): Promise<void>
  setTranspose(transpose: number): Promise<void>
  setTempo(tempo: number): Promise<void>
  setBeats(info: ReturnType<typeof sanitizeBeatInfo>): Promise<void>
  setMetronome(config: typeof MET_DEFAULTS): Promise<void>
  setTraining(spec: null): Promise<void>
  setRegion(region: null, loop: boolean): Promise<void>
  getTrackStates(): TrackState[]
  setLaneReader(read: ((path: string) => Promise<ArrayBuffer>) | null): void
  retireForSongSwitch(): void
  setOutput?(deviceId: string): Promise<void>
  subscribe(listener: () => void): () => void
  teardown(): Promise<void>
}

export interface BoxActiveSong {
  item: ProjectListItem
  project: ProjectInfo
  metadata: BoxProjectMetadata
  lyrics:
    | { status: 'ready'; lines: LyricLine[] }
    | { status: 'missing' }
    | { status: 'error'; error: string }
}

export interface BoxTransportSnapshot {
  active: BoxActiveSong | null
  loadingName: string | null
  committing: boolean
  lastError: string | null
  saveError: string | null
  position: number
  duration: number
  playing: boolean
  starting: boolean
  tracks: TrackState[]
  masterVolume: number
  transpose: number
  tempo: number
  playbackError: EnginePlaybackError | null
  appliedOutputUid: string | null
  applyingOutput: boolean
  outputError: string | null
  routingBlocked: boolean
  restartRequired: boolean
}

interface PendingProjectSave {
  item: ProjectListItem
  acceptedSettings: ProjectSettings
  pendingSettings?: ProjectSettings
  controlTail: Promise<ProjectSettings>
  timer: ReturnType<typeof setTimeout> | null
  saving?: Promise<void>
  error?: string
}

export class BoxTransport {
  private active: BoxActiveSong | null = null
  private loadingName: string | null = null
  private committing = false
  private lastError: string | null = null
  private generation = 0
  private activeGeneration = 0
  private disposed = false
  private tearingDown = false
  private teardownPromise: Promise<void> | null = null
  private engineTail: Promise<unknown> = Promise.resolve()
  private saveTail: Promise<unknown> = Promise.resolve()
  private appliedOutputUid: string | null = null
  private applyingOutput = false
  private applyingOutputUid: string | null = null
  private outputError: string | null = null
  private routingBlocked = false
  private restartRequired = false
  private outputApplyPromise: Promise<void> | null = null
  private readonly outputArbiter: PlaybackOutputArbiter
  private readonly pendingSaves = new Map<string, PendingProjectSave>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribeEngine: () => void
  private readonly pollTimer: ReturnType<typeof setInterval> | null
  private snapshot: BoxTransportSnapshot
  private readonly saveDelayMs: number
  private readonly nativePlaybackEnabled?: boolean

  constructor(
    private readonly api: SingzApi,
    private readonly engine: BoxEngine,
    options: { pollMs?: number; saveDelayMs?: number; nativePlaybackEnabled?: boolean } = {}
  ) {
    this.saveDelayMs = options.saveDelayMs ?? 600
    this.nativePlaybackEnabled = options.nativePlaybackEnabled
    this.outputArbiter = new PlaybackOutputArbiter(undefined, {
      setOutput: async sinkId => {
        try {
          if (!this.engine.setOutput) throw new Error(tSettings('box.settings.routeUnavailable'))
          await this.engine.setOutput(sinkId)
        } catch (error) {
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? (error as { code?: unknown }).code
            : undefined
          if (code === 'provider-cleanup-incomplete' || code === 'provider-recovery-unavailable') {
            this.restartRequired = true
            this.routingBlocked = true
            this.appliedOutputUid = null
          }
          throw error
        }
      },
      enumerateOutputs: async () => {
        const inventory = await this.api.audioHostDevices('alsa')
        if (!inventory.ok) throw new Error(inventory.error)
        return inventory.devices
          .filter(device => device.outputChannels > 0)
          .map(device => ({ kind: 'audiooutput' as const, deviceId: `native:${device.uid}` }))
      },
      commit: outputId => {
        this.appliedOutputUid = outputId?.startsWith('native:')
          ? outputId.slice('native:'.length)
          : null
      }
    })
    this.engine.setLaneReader(async path => this.api.readAudio(path))
    this.unsubscribeEngine = this.engine.subscribe(() => this.refresh())
    const pollMs = options.pollMs ?? 100
    this.pollTimer = pollMs > 0 ? setInterval(() => this.refresh(), pollMs) : null
    this.snapshot = this.readSnapshot()
  }

  getSnapshot = (): BoxTransportSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readSnapshot(): BoxTransportSnapshot {
    return {
      active: this.active,
      loadingName: this.loadingName,
      committing: this.committing,
      lastError: this.lastError,
      saveError: this.active ? this.pendingSaves.get(this.active.item.dir)?.error ?? null : null,
      position: this.active ? this.engine.position : 0,
      duration: this.active ? this.engine.duration : 0,
      playing: this.active ? this.engine.playing : false,
      starting: this.active ? this.engine.starting : false,
      tracks: this.active ? this.engine.getTrackStates() : [],
      masterVolume: this.active ? this.engine.masterVolume : 1,
      transpose: this.active ? this.engine.transpose : 0,
      tempo: this.active ? this.engine.tempo : 1,
      playbackError: this.active ? this.engine.playbackError : null,
      appliedOutputUid: this.appliedOutputUid,
      applyingOutput: this.applyingOutput,
      outputError: this.outputError,
      routingBlocked: this.routingBlocked,
      restartRequired: this.restartRequired
    }
  }

  private publish(): void {
    this.snapshot = this.readSnapshot()
    for (const listener of this.listeners) listener()
  }

  refresh = (): void => {
    if (this.disposed) return
    const previous = this.snapshot
    const next = this.readSnapshot()
    const unchanged = previous.active === next.active && previous.loadingName === next.loadingName &&
      previous.committing === next.committing && previous.lastError === next.lastError &&
      previous.saveError === next.saveError && previous.playing === next.playing &&
      previous.starting === next.starting && previous.duration === next.duration &&
      Math.abs(previous.position - next.position) < 0.005 && previous.masterVolume === next.masterVolume &&
      previous.transpose === next.transpose && previous.tempo === next.tempo &&
      previous.playbackError === next.playbackError && previous.appliedOutputUid === next.appliedOutputUid &&
      previous.applyingOutput === next.applyingOutput && previous.outputError === next.outputError &&
      previous.routingBlocked === next.routingBlocked && previous.restartRequired === next.restartRequired &&
      JSON.stringify(previous.tracks) === JSON.stringify(next.tracks)
    if (unchanged) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }

  private current(generation: number): boolean {
    return !this.disposed && !this.tearingDown && generation === this.generation
  }

  private enqueueEngine<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.engineTail.then(operation, operation)
    this.engineTail = run.catch(() => undefined)
    return run
  }

  private enqueueSave<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.saveTail.then(operation, operation)
    this.saveTail = run.catch(() => undefined)
    return run
  }

  applyOutput(rawUid: string): Promise<void> {
    if (this.outputApplyPromise) {
      if (this.applyingOutputUid === rawUid) return this.outputApplyPromise
      return Promise.reject(new Error(tSettings('box.settings.applying')))
    }
    if (this.restartRequired) {
      return Promise.reject(new Error(tSettings('box.settings.restartRequired')))
    }
    if (this.disposed || this.tearingDown) {
      return Promise.reject(new Error(tSettings('box.settings.routeUnavailable')))
    }
    this.applyingOutput = true
    this.applyingOutputUid = rawUid
    this.outputError = null
    this.engine.pause()
    this.publish()
    const selection = this.enqueueEngine(async () => {
      this.engine.pause()
      this.refresh()
      const inventory = await this.api.audioHostDevices('alsa')
      if (!inventory.ok) throw new Error(inventory.error)
      if (inventory.provider !== 'alsa') throw new Error(tSettings('box.settings.routeUnavailable'))
      const selected = inventory.devices.find(device => device.uid === rawUid && device.outputChannels > 0)
      if (!selected) throw new Error(tSettings('box.settings.deviceDisconnected'))
      try {
        return await this.outputArbiter.select(`native:${rawUid}`)
      } catch (error) {
        if (error instanceof PlaybackOutputSelectionError && error.repairRequired) this.engine.pause()
        throw error
      }
    })
    const tracked = (async (): Promise<void> => {
      try {
        if (await selection) {
          if (!this.restartRequired) this.routingBlocked = false
          this.outputError = null
        }
      } catch (error) {
        if (!(error instanceof PlaybackOutputSelectionError) || error.current) {
          const cause = error instanceof PlaybackOutputSelectionError ? error.causeValue : error
          this.outputError = cause instanceof Error ? cause.message : String(cause)
          if (error instanceof PlaybackOutputSelectionError && error.repairRequired) {
            this.routingBlocked = true
            this.appliedOutputUid = null
          }
          if (this.restartRequired) {
            this.routingBlocked = true
            this.appliedOutputUid = null
          }
        }
        throw error
      } finally {
        this.applyingOutput = false
        this.applyingOutputUid = null
        this.outputApplyPromise = null
        this.publish()
      }
    })()
    this.outputApplyPromise = tracked
    return tracked
  }

  async open(item: ProjectListItem): Promise<boolean> {
    if (this.disposed || this.tearingDown) return false
    const generation = ++this.generation
    this.loadingName = item.name
    this.lastError = null
    this.publish()
    try {
      const { registration, inspection, lyrics } = await inspectBoxProject(this.api, item)
      if (!this.current(generation)) return false
      if (inspection.readiness !== 'ready' || !registration.ok || !registration.project?.stems || !lyrics) {
        throw new Error(inspection.message ?? t('box.player.lyricsRequired'))
      }
      const project = registration.project
      const stems = project.stems as Record<string, string>
      const stemOrder = orderedStems(stems)
      const custom = project.settings.custom ?? []
      const lanes = [
        ...stemOrder.map(id => ({ id, path: stems[id] })),
        ...custom.map(track => ({ id: track.id, path: track.file }))
      ]
      const applies = await desktopLaneMeasureApplies(lanes, {
        api: this.api,
        nativePlaybackEnabled: this.nativePlaybackEnabled
      })
      if (!this.current(generation)) return false
      if (this.nativePlaybackEnabled === true && !applies) {
        throw new Error(t('box.nativeRequired'))
      }
      const graphPromise = import('../audio/desktop-project-graph').then(module =>
        module.loadDesktopProjectGraph(
          () => this.api.readProjectGraph(registration.path),
          () => this.current(generation)
        )
      )
      const lanesPromise = readLanes(
        lanes,
        async path => this.engine.decode(await this.api.readAudio(path)),
        { api: this.api, applies, nativePlaybackEnabled: this.nativePlaybackEnabled }
      )
      const [graph, read] = await Promise.all([graphPromise, lanesPromise])
      if (!this.current(generation) || !graph.accepted) return false
      if (read.superseded) throw new Error('The project read was superseded. Open it again.')
      const missing = lanes.find(lane => !read.reads.has(lane.id))
      if (missing) throw read.errors.get(missing.id) ?? new Error(`${missing.id} could not be read`)
      const duration = lanes.reduce((longest, lane) => Math.max(longest, read.reads.get(lane.id)?.duration ?? 0), 0)
      if (!(duration > 0)) throw new Error('The prepared stems have no playable duration.')
      if (!lyrics.ok) throw new Error(t('box.player.lyricsReadError', { error: lyrics.error }))
      if (!lyrics.cached || lyrics.lines.length === 0) {
        throw new Error(t('box.player.lyricsRequired'))
      }
      const active: BoxActiveSong = {
        item,
        project,
        metadata: projectMetadata(project, duration),
        lyrics: { status: 'ready', lines: lyrics.lines }
      }

      if (this.active) await this.flushControls(this.active.item.dir)
      if (!this.current(generation)) return false
      return await this.enqueueEngine(async () => {
        if (!this.current(generation)) return
        this.committing = true
        this.publish()
        try {
          this.engine.pause()
          this.engine.retireForSongSwitch()
          this.active = null
          await this.engine.setTraining(null)
          if (!this.current(generation)) return
          await this.engine.setRegion(null, false)
          if (!this.current(generation)) return
          await this.engine.setBeats(sanitizeBeatInfo(project.settings.beat))
          if (!this.current(generation)) return
          await this.engine.setMetronome(project.settings.metronome
            ? sanitizeMetronome(project.settings.metronome)
            : { ...MET_DEFAULTS })
          if (!this.current(generation)) return
          await this.engine.setTranspose(project.settings.transpose ?? 0)
          if (!this.current(generation)) return
          await this.engine.setTempo(project.settings.tempo ?? 1)
          if (!this.current(generation)) return
          await this.engine.setMasterVolumeAccepted(sanitizeSongVolume(project.settings.masterVolume))
          if (!this.current(generation)) return
          this.engine.load(lanes.map(lane => {
            const laneRead = read.reads.get(lane.id)!
            return { id: lane.id, buffer: laneRead.buffer, duration: laneRead.duration, path: lane.path }
          }), { graphDocument: graph.graphDocument, position: 0, play: false })
          for (const lane of lanes) {
            const saved = project.settings.tracks[lane.id]
            if (!saved) continue
            await this.engine.setMutedAccepted(lane.id, saved.muted)
            await this.engine.setSoloAccepted(lane.id, saved.solo)
            await this.engine.setVolumeAccepted(lane.id, saved.volume)
          }
          if (!this.current(generation)) return
          this.active = active
          this.activeGeneration = generation
          this.loadingName = null
          this.publish()
          return true
        } finally {
          this.committing = false
          this.publish()
        }
      }).then(result => result === true)
    } catch (error) {
      if (!this.current(generation)) return false
      this.loadingName = null
      this.committing = false
      this.lastError = error instanceof Error ? error.message : String(error)
      this.publish()
      return false
    }
  }

  cancelOpen(): boolean {
    if (this.loadingName === null || this.committing) return false
    this.generation++
    this.loadingName = null
    this.publish()
    return true
  }

  toggle(): void {
    if (this.active?.lyrics.status !== 'ready' || this.active.lyrics.lines.length === 0) return
    if (!this.engine.playing && (this.routingBlocked || this.applyingOutput || this.restartRequired)) return
    this.engine.toggle()
  }

  pause(): void {
    this.engine.pause()
  }

  async controllerPlayPause(): Promise<void> {
    const active = this.active
    const owner = this.activeGeneration
    if (!active || active.lyrics.status !== 'ready' || active.lyrics.lines.length === 0) {
      throw new Error('No song with ready lyrics can be controlled.')
    }
    if (this.tearingDown || this.disposed || this.generation !== owner) {
      throw new Error('The current song changed before playback was controlled.')
    }
    const dir = active.item.dir
    await this.enqueueEngine(async () => {
      const ownsEngine = (): boolean => this.activeGeneration === owner && this.active?.item.dir === dir &&
        !this.tearingDown && !this.disposed && this.generation === owner
      if (!ownsEngine()) throw new Error('The current song changed before playback was controlled.')
      const desiredPlaying = !this.engine.playing
      const acceptedPlay = desiredPlaying && this.engine.playAccepted !== undefined
      if (desiredPlaying) {
        if (this.routingBlocked || this.applyingOutput || this.restartRequired) {
          throw new Error('Playback is blocked by the current audio output state.')
        }
        if (this.engine.playAccepted) await this.engine.playAccepted()
        else await this.engine.play()
      } else {
        if (!this.engine.pauseAccepted) throw new Error('Pause is not supported by this playback backend yet.')
        await this.engine.pauseAccepted()
      }
      if (!ownsEngine()) throw new Error('The current song changed before playback control completed.')
      if (!acceptedPlay && this.engine.playing !== desiredPlaying) throw new Error('Playback control was superseded before its receipt arrived.')
      this.refresh()
    })
  }

  seek(position: number): void {
    if (this.routingBlocked || this.applyingOutput || this.restartRequired) return
    if (this.active) this.engine.seek(position)
  }

  seekBy(delta: number): void {
    if (this.routingBlocked || this.applyingOutput || this.restartRequired) return
    if (this.active) this.engine.seekBy(delta)
  }

  setVolume(id: string, volume: number): void {
    void this.recordControl(() => this.engine.setVolumeAccepted(id, Math.max(0, Math.min(1, volume)))).catch(() => undefined)
  }

  setMuted(id: string, muted: boolean): void {
    void this.recordControl(() => this.engine.setMutedAccepted(id, muted)).catch(() => undefined)
  }

  setSolo(id: string, solo: boolean): void {
    void this.recordControl(() => this.engine.setSoloAccepted(id, solo)).catch(() => undefined)
  }

  setMasterVolume(volume: number): void {
    void this.recordControl(() => this.engine.setMasterVolumeAccepted(sanitizeSongVolume(volume))).catch(() => undefined)
  }

  async controllerMix(command: { type: 'volume'; target: string; value: number } | { type: 'mute' | 'solo'; target: string; value: boolean }): Promise<void> {
    const active = this.active
    if (!active || this.tearingDown || this.disposed || this.generation !== this.activeGeneration) {
      throw new Error('No current song can accept this mixer command.')
    }
    const master = command.target === 'master'
    if (command.type === 'volume') {
      if (!master && !this.engine.getTrackStates().some(track => track.id === command.target)) {
        throw new Error('The mixer target is not available in the current song.')
      }
      await this.recordControl(
        () => master
          ? this.engine.setMasterVolumeAccepted(sanitizeSongVolume(command.value))
          : this.engine.setVolumeAccepted(command.target, Math.max(0, Math.min(1, command.value))),
        true
      )
      return
    }
    if (master || !this.engine.getTrackStates().some(track => track.id === command.target)) {
      throw new Error('The mixer target is not available in the current song.')
    }
    await this.recordControl(
      () => command.type === 'mute'
        ? this.engine.setMutedAccepted(command.target, command.value)
        : this.engine.setSoloAccepted(command.target, command.value),
      true
    )
  }

  private recordControl(accepted: () => Promise<void>, awaitReceipt = false): Promise<void> {
    const active = this.active
    const owner = this.activeGeneration
    if (!active || this.tearingDown || this.disposed || this.generation !== owner) {
      return awaitReceipt ? Promise.reject(new Error('The current song changed before the mixer command ran.')) : Promise.resolve()
    }
    const dir = active.item.dir
    let entry = this.pendingSaves.get(dir)
    if (!entry) {
      entry = {
        item: active.item,
        acceptedSettings: active.project.settings,
        controlTail: Promise.resolve(active.project.settings),
        timer: null
      }
      this.pendingSaves.set(dir, entry)
    }
    const pending = entry
    const fallback = pending.pendingSettings ?? pending.acceptedSettings
    let receiptError: unknown = null
    const ownsEngine = (): boolean =>
      this.activeGeneration === owner && this.active?.item.dir === dir
    pending.controlTail = this.enqueueEngine(async () => {
      if (!ownsEngine()) {
        if (awaitReceipt) receiptError = new Error('The current song changed before the mixer command ran.')
        return fallback
      }
      try {
        await accepted()
        if (!ownsEngine()) {
          if (awaitReceipt) receiptError = new Error('The current song changed before the mixer command completed.')
          return fallback
        }
        const next = settingsWithTracks(
          fallback,
          this.engine.getTrackStates(),
          this.engine.masterVolume,
          this.engine.transpose,
          this.engine.tempo
        )
        pending.pendingSettings = next
        pending.error = undefined
        this.scheduleProjectSave(pending)
        this.publish()
        return next
      } catch (error) {
        if (ownsEngine()) pending.error = error instanceof Error ? error.message : String(error)
        if (awaitReceipt) receiptError = error
        this.publish()
        return fallback
      }
    })
    return pending.controlTail.then(() => {
      if (receiptError) throw receiptError
    })
  }

  private scheduleProjectSave(entry: PendingProjectSave): void {
    if (this.tearingDown || this.disposed || !entry.pendingSettings || entry.error) return
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.flushProject(entry.item.dir)
    }, this.saveDelayMs)
  }

  private async flushControls(dir: string): Promise<void> {
    const entry = this.pendingSaves.get(dir)
    if (!entry) return
    let tail: Promise<ProjectSettings>
    do {
      tail = entry.controlTail
      await tail
    } while (tail !== entry.controlTail)
  }

  private async flushProject(dir: string): Promise<void> {
    const entry = this.pendingSaves.get(dir)
    if (!entry) return
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    await this.flushControls(dir)
    if (entry.saving) await entry.saving
    if (entry.pendingSettings) await this.saveProjectEntry(entry)
  }

  private async saveProjectEntry(entry: PendingProjectSave): Promise<void> {
    const settings = entry.pendingSettings
    if (!settings || entry.saving) return entry.saving
    entry.pendingSettings = undefined
    const operation = this.enqueueSave(async () => {
      try {
        const result = await this.api.saveProject(entry.item.songPath, entry.item.name, settings)
        if (!result.ok) throw new Error(result.error)
        entry.acceptedSettings = settings
        entry.error = undefined
        if (this.active?.item.dir === entry.item.dir) {
          this.active.project = { ...this.active.project, settings }
        }
      } catch (error) {
        entry.pendingSettings ??= settings
        entry.error = error instanceof Error ? error.message : String(error)
      } finally {
        entry.saving = undefined
        this.publish()
      }
    })
    entry.saving = operation
    await operation
  }

  flushPersistence = async (): Promise<void> => {
    for (const dir of this.pendingSaves.keys()) await this.flushProject(dir)
  }

  async teardown(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise
    this.tearingDown = true
    this.generation++
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    for (const entry of this.pendingSaves.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = null
    }
    this.teardownPromise = (async (): Promise<void> => {
      try {
        await this.flushPersistence()
      } catch {
        // Save errors stay pending; native cleanup is still mandatory.
      }
      await this.engineTail
      await this.outputApplyPromise?.catch(() => undefined)
      this.engine.pause()
      try {
        await this.engine.teardown()
      } finally {
        this.unsubscribeEngine()
        this.disposed = true
        this.listeners.clear()
      }
    })()
    return this.teardownPromise
  }
}
