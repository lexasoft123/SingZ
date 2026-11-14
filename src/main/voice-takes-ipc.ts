import { ipcMain, type WebContents } from 'electron'
import { allowFile } from './media'
import { computeWavPeaks } from './voice-takes'
import { conformTake, invalidateConformedTake, releaseConformedTake, isConformTakeError } from './voice-take-conform'
import { isVoiceTakeEffects, safeVoiceTakeMessage, type VoiceTakeConformRequest, type VoiceTakeConformResult } from '../shared/voice-take'
import { desktopAudioProcess } from './audio-process'
import { log } from './log'
import { VOICE_IPC, VOICE_TAKE_MAX_OFFSET_SEC, VOICE_TAKE_CONFORM_NATIVE_BUDGET_MS, type VoiceTakeMoveRequest, type VoiceTakePeaksRequest, type VoiceArmRequest, type VoiceInputLevel, type VoiceRecordStartRequest, type VoiceRecordSettingsChange } from '../shared/voice-take'
import { VoiceTakeStore, createUnavailableVoiceNative, type VoiceTakeNative } from './voice-takes'

const normalizeDeviceLabel = (value: string): string => value.trim().replace(/\s+\([^()]*\)\s*$/, '').trim().toLocaleLowerCase()

let nextVoiceCaptureGeneration = BigInt(Date.now()) * 1000n

export const createVoiceTakeNative = (audioProcess: typeof desktopAudioProcess = desktopAudioProcess): VoiceTakeNative => {
  const desktopAudioProcess = audioProcess
  let captureGeneration: bigint | undefined
  let captureDeviceName = ''
  let captureDeviceUid = ''
  let captureChannel = -1
  const chooseDevice = async (deviceName: string, channelIndex: number): Promise<{ ok: true; device: import('../shared/types').CaptureInputDevice; channel: number } | { ok: false; reason: 'no-input'; error: string }> => {
    const devices = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['inputDevices']>>>('binding', 'inputDevices', [])
    if (!devices.ok) return { ok: false, reason: 'no-input', error: devices.error }
    const requested = deviceName.trim()
    const unique = (matches: typeof devices.devices) => matches.length === 1 ? matches[0] : undefined
    const chosen = requested
      ? unique(devices.devices.filter(device => device.uid === requested)) ??
        unique(devices.devices.filter(device => device.label === requested)) ??
        unique(devices.devices.filter(device => normalizeDeviceLabel(device.label) === normalizeDeviceLabel(requested)))
      : devices.devices.find(device => device.isDefault) ?? devices.devices[0]
    if (!chosen || !Number.isInteger(channelIndex) || channelIndex < 0 || channelIndex >= chosen.channels) return { ok: false, reason: 'no-input', error: 'The selected microphone is unavailable.' }
    return { ok: true, device: chosen, channel: channelIndex }
  }
  const openCapture = async (deviceName: string, channelIndex: number, generation: bigint): Promise<{ ok: boolean; reason?: 'no-input' | 'busy' | 'error'; error?: string; deviceName?: string; generation?: bigint }> => {
    const selected = await chooseDevice(deviceName, channelIndex)
    if (!selected.ok) return selected
    if (captureGeneration !== undefined) {
      const state = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureState']>>>('binding', 'captureState', [])
      if (state.state === 'running' && state.ownershipGeneration === captureGeneration.toString()) {
        if (selected.device.uid === captureDeviceUid && selected.channel === captureChannel) return { ok: true, generation: captureGeneration, deviceName: captureDeviceName }
        const stopped = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('binding', 'cancelCapture', [captureGeneration])
        if (!stopped.ok) return { ok: false, reason: 'error', error: 'The microphone could not be released.' }
      }
      captureGeneration = undefined; captureDeviceName = ''; captureDeviceUid = ''; captureChannel = -1
    }
    let started: Awaited<ReturnType<import('./capture').NativeCaptureBinding['beginCapture']>>
    try {
      started = await desktopAudioProcess.call('binding', 'beginCapture', [{ deviceUid: selected.device.uid, inputChannel: selected.channel }, generation, () => undefined])
    } catch (error) {
      // The begin may have succeeded despite a lost reply; release that generation.
      await desktopAudioProcess.call('binding', 'cancelCapture', [generation]).catch(() => undefined)
      throw error
    }
    if (!started.ok) return { ok: false, reason: 'error', error: started.error }
    captureGeneration = generation; captureDeviceName = selected.device.label; captureDeviceUid = selected.device.uid; captureChannel = selected.channel
    return { ok: true, generation, deviceName: captureDeviceName }
  }
  const presentationQuery: VoiceTakeNative['presentationQuery'] = async args => {
    if (!args.firstSampleHostNs || !args.sampleRate || !Number.isFinite(args.sampleRate) || args.sampleRate <= 0)
      return { ok: true, found: false, latencySource: 'measured-trim' as const }
    let hostNs: bigint
    try { hostNs = BigInt(args.firstSampleHostNs) } catch { return { ok: true, found: false, latencySource: 'measured-trim' as const } }
    const inputTrimNs = args.trimInputLatency ? (args.inputLatencyFrames ?? 0) * 1e9 / args.sampleRate : 0
    const outputRate = args.outputSampleRate ?? args.sampleRate
    const outputTrimNs = ((args.outputLatencyFrames ?? 0) + (args.graphLatencyFrames ?? 0)) * 1e9 / outputRate
    const trimNs = BigInt(Math.max(0, Math.round(inputTrimNs + outputTrimNs)))
    const adjustedHostNs = hostNs > trimNs ? hostNs - trimNs : 0n
    const raw = await desktopAudioProcess.call<{
      found: boolean; projectFrame?: number; songSeconds?: number; rate?: number; sampleRate?: number;
      outputLatencyFrames?: number; graphLatencyFrames?: number; discontinuitySerial?: number | string;
      transposeSemitones?: number; faultSerial?: number | string; mappingStartHostNs?: number | string; mappingStartSongSeconds?: number;
      paused?: boolean; seekDuringCallback?: boolean; generation?: string | number
    }>('binding', 'presentationQuery', [adjustedHostNs.toString()])
    return {
      ok: true, found: raw.found, projectFrame: raw.projectFrame, songSeconds: raw.songSeconds, sampleRate: raw.sampleRate,
      startPositionSec: raw.songSeconds, paused: raw.paused, outputLatencyFrames: raw.outputLatencyFrames,
      graphLatencyFrames: raw.graphLatencyFrames, discontinuitySerial: raw.discontinuitySerial,
      transposeSemitones: raw.transposeSemitones, faultSerial: raw.faultSerial, generation: raw.generation, rate: raw.rate,
      mappingStartCaptureHostNs: raw.mappingStartHostNs === undefined ? undefined : (BigInt(raw.mappingStartHostNs) + trimNs).toString(),
      mappingStartSongSeconds: raw.mappingStartSongSeconds,
      seekDuringCallback: raw.seekDuringCallback,
      latencySource: raw.found ? (args.firstSampleQuality === 'unknown' ? 'measured-trim' as const : 'reported' as const) : 'measured-trim' as const
    }
  }
  return {
  armCapture: args => openCapture(args.deviceName, args.channelIndex, ++nextVoiceCaptureGeneration),
  disarmCapture: async generation => { if (captureGeneration && (!generation || generation === captureGeneration)) { const result = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('binding', 'cancelCapture', [captureGeneration]); if (result.ok) { captureGeneration = undefined; captureDeviceName = ''; captureDeviceUid = ''; captureChannel = -1 } return result } return { ok: true } },
  recordTake: async args => {
    const generation = args.generation ?? (++nextVoiceCaptureGeneration)
    const started = await openCapture(args.deviceName ?? '', args.channelIndex ?? 0, generation)
    if (!started.ok) return started
    // An armed input can deliver immediately after Play, before the song's
    // first audible frame. At non-unity tempo (or transpose), the time/pitch
    // latency makes this window much longer. Wait BEFORE opening the writer:
    // retrying placement later cannot move a first sample out of old silence.
    let ready = false
    let covered = false
    let placementEstimated: import('../shared/voice-take').VoiceTakePlacementEstimate | undefined
    const readinessStarted = Date.now()
    let lastProbe: Record<string, unknown> = {}
    for (let attempt = 0; attempt < 80; attempt++) {
      covered = false
      const stats = await desktopAudioProcess.call<Awaited<ReturnType<VoiceTakeNative['captureStats']>>>('binding', 'captureStats', [])
      if (stats.lastSampleHostNs && stats.lastSampleHostNs !== '0' && stats.sampleRate) {
        const probe = { songId: '', firstSampleHostNs: stats.lastSampleHostNs, sampleRate: stats.sampleRate }
        const raw = await presentationQuery(probe)
        lastProbe = { attempts: attempt + 1, host: stats.lastSampleHostNs, quality: stats.firstSampleQuality,
          sampleRate: stats.sampleRate, inputBufferFrames: stats.inputBufferFrames,
          inputLatencyFrames: stats.inputLatencyFrames, inputLatencySource: stats.inputLatencySource,
          inputLatencyStable: stats.inputLatencyStable, raw }
        if (raw.ok && raw.found && !raw.paused && !raw.seekDuringCallback) {
          const placed = await presentationQuery({ ...probe, outputSampleRate: raw.sampleRate,
            inputLatencyFrames: stats.inputLatencySource === 'reported' && stats.inputLatencyStable !== false ? stats.inputLatencyFrames : 0,
            outputLatencyFrames: raw.outputLatencyFrames, graphLatencyFrames: raw.graphLatencyFrames, trimInputLatency: true })
          lastProbe.placed = placed
          if (placed.ok && placed.found && !placed.paused && !placed.seekDuringCallback) {
            covered = true
            // Wait for audible timeline coverage and the output's cold-start
            // delay, not optional input telemetry. Waiting for an input that
            // never reports stability drops the singer's first two seconds:
            // the writer does not exist yet. Preserve the estimate explicitly.
            if (raw.outputLatencyFrames !== 0) {
              ready = true
              if (stats.inputLatencyStable === false) placementEstimated = 'latency-not-settled'
              else if (stats.inputLatencySource !== 'reported' || raw.outputLatencyFrames === undefined) placementEstimated = 'latency-unreported'
              break
            }
          }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    // Some routes cannot report stable latency. Keep the two-second bound and
    // capture only with current timeline coverage, explicitly marked estimated.
    if (!ready && covered) { ready = true; placementEstimated = 'latency-not-settled' }
    log('voice-take', 'readiness ' + JSON.stringify({ takeId: args.takeId, ready, placementEstimated, waitedMs: Date.now() - readinessStarted, ...lastProbe }), placementEstimated ? 'warn' : ready ? 'info' : 'warn')
    if (!ready) return { ok: false, generation: started.generation ?? generation, reason: 'error', error: 'The song is not ready to record. Try again after playback starts.' }
    const result = await desktopAudioProcess.call<{ ok: boolean; error?: string }>('binding', 'recordTake', [args.dir, args.takeId, started.generation ?? generation])
    return { ...result, generation: started.generation ?? generation, deviceName: started.deviceName, ...(placementEstimated ? { placementEstimated } : {}) }
  },
  finishTake: args => desktopAudioProcess.call('binding', 'finishTake', [args.generation]),
  cancelTake: args => desktopAudioProcess.call('binding', 'cancelTake', [args.generation]),
  stopCapture: async generation => {
    try { return await desktopAudioProcess.call<{ ok: boolean; cancelled?: boolean; error?: string }>('binding', 'cancelCapture', [generation]) }
    finally { if (captureGeneration === generation) { captureGeneration = undefined; captureDeviceName = ''; captureDeviceUid = ''; captureChannel = -1 } }
  },
  presentationQuery,
  transportState: async () => (await desktopAudioProcess.call<import('../shared/types').DesktopPlaybackStatus>('binding', 'playbackStatus', [])).transportState,
  captureStats: () => desktopAudioProcess.call('binding', 'captureStats', []),
  level: async () => {
    const stats = await desktopAudioProcess.call<Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureStats']>>>('binding', 'captureStats', [])
    return (stats as Awaited<ReturnType<import('./capture').NativeCaptureBinding['captureStats']>> & { inputLevel: VoiceInputLevel }).inputLevel
  }
  }
}

export function registerVoiceTakeIpc(store: VoiceTakeStore): void {
  // Leases are scoped to the renderer that requested the cache entry. Pin at
  // publication, before replying: POSIX otherwise allows prune-before-open.
  const jobs = new Map<string, AbortController>()
  const latestBySong = new Map<string, AbortController>()
  const mutations = new Map<string, Promise<unknown>>()
  const leases = new Map<string, { owner: number; songId: string; takeId: string; path: string }>()
  const watched = new Set<number>()
  const waveCache = new Map<string, import('../shared/voice-take').VoiceTakeConformedWaveform>()
  let recordingOwner: number | undefined
  let recordingCleanup: Promise<void> | undefined
  const pendingStarts = new Set<{ owner: number; detached: boolean }>()
  const stopLostRecording = (): Promise<void> => {
    if (recordingCleanup) return recordingCleanup
    const cleanup = (async () => {
      try { await store.stop('error') }
      finally { await store.disarm() } // An armed take otherwise retains its input lease.
    })()
    recordingCleanup = cleanup
    void cleanup.finally(() => { if (recordingCleanup === cleanup) recordingCleanup = undefined }).catch(() => {})
    return cleanup
  }
  const armOwners = new Map<number, { detached: boolean }>()
  const watchOwner = (sender: WebContents): { detached: boolean } => {
    const owner = sender.id
    if (watched.has(owner)) return armOwners.get(owner)!
    watched.add(owner)
    armOwners.set(owner, { detached: false })
    const releaseOwner = () => {
      const lostArmOwner = armOwners.get(owner)
      if (lostArmOwner) {
        lostArmOwner.detached = true
        const releaseArm = store.monitorInputCleanup?.(lostArmOwner)
        if (releaseArm) void releaseArm().catch(() => log('voice-take', 'renderer arm cleanup failed', 'warn'))
      }
      armOwners.set(owner, { detached: false })
      for (const start of pendingStarts) if (start.owner === owner) start.detached = true
      if (recordingOwner === owner) {
        recordingOwner = undefined // Repeated crash/navigation/destroy signals are idempotent.
        void stopLostRecording().catch(() => log('voice-take', 'renderer-loss cleanup failed', 'warn'))
      }
      for (const [id, job] of jobs) if (id.startsWith(`${owner}:`)) job.abort()
      for (const [id, lease] of leases) if (lease.owner === owner) {
        leases.delete(id)
        void releaseConformedTake(lease.path).then(() => invalidateConformedTake(lease.songId, lease.takeId, { cancelActive: false })).catch(() => {})
      }
    }
    sender.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) releaseOwner() })
    sender.on('render-process-gone', releaseOwner)
    sender.once('destroyed', () => { releaseOwner(); watched.delete(owner); armOwners.delete(owner) })
    return armOwners.get(owner)!
  }
  const validId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v)
  const key = (owner: number, id: string): string => `${owner}:${id}`
  ipcMain.handle(VOICE_IPC.conform, async (event, raw: VoiceTakeConformRequest): Promise<VoiceTakeConformResult> => {
    if (!raw || !validId(raw.songId) || !validId(raw.takeId) || !validId(raw.requestId) ||
        !Number.isSafeInteger(raw.outputRate) || raw.outputRate < 8000 || raw.outputRate > 192000 ||
        !Number.isSafeInteger(raw.songDurationProjectFrames) || raw.songDurationProjectFrames <= 0 ||
        (raw.effects !== undefined && !isVoiceTakeEffects(raw.effects))) return { ok: false, reason: 'conform-failed' }
    const owner = event.sender.id, id = key(owner, raw.requestId)
    if (jobs.has(id) || leases.has(id)) return { ok: false, reason: 'conform-failed' }
    watchOwner(event.sender)
    const controller = new AbortController()
    jobs.set(id, controller)
    latestBySong.get(raw.songId)?.abort()
    latestBySong.set(raw.songId, controller)
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, VOICE_TAKE_CONFORM_NATIVE_BUDGET_MS + 60_000)
    try {
      const mutation = (mutations.get(raw.songId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (controller.signal.aborted) throw new Error('Take conform cancelled')
        if (raw.effects !== undefined) await store.setEffects(raw.songId, raw.takeId, raw.effects)
      })
      mutations.set(raw.songId, mutation)
      try { await mutation } finally { if (mutations.get(raw.songId) === mutation) mutations.delete(raw.songId) }
      if (controller.signal.aborted) return { ok: false, reason: timedOut ? 'timeout' : 'cancelled' }
      const result = await conformTake(raw.songId, raw.takeId, { songDurationProjectFrames: raw.songDurationProjectFrames,
        outputRate: raw.outputRate, effects: raw.effects, signal: controller.signal, retain: true })
      if (controller.signal.aborted || event.sender.isDestroyed()) {
        await releaseConformedTake(result.path)
        await invalidateConformedTake(raw.songId, raw.takeId, { cancelActive: false })
        return { ok: false, reason: timedOut ? 'timeout' : 'cancelled' }
      }
      let waveform = waveCache.get(result.key)
      if (!waveform) {
        try {
          const startFrame = Math.max(0, Math.min(result.durationFrames, result.placementFrame))
          const peaks = await computeWavPeaks(result.path, undefined, startFrame, result.durationFrames)
          waveform = { offsetSec: startFrame / raw.outputRate, durationSec: peaks.durationSec, peaks: peaks.peaks }
          waveCache.set(result.key, waveform)
          while (waveCache.size > 16) waveCache.delete(waveCache.keys().next().value as string)
        } catch { /* raw waveform remains available */ }
      }
      if (controller.signal.aborted || event.sender.isDestroyed()) {
        await releaseConformedTake(result.path)
        return { ok: false, reason: timedOut ? 'timeout' : 'cancelled' }
      }
      leases.set(id, { owner, songId: raw.songId, takeId: raw.takeId, path: result.path })
      allowFile(result.path)
      return { ok: true, ...result, leaseId: raw.requestId, ...(waveform ? { waveform } : {}) }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const code = isConformTakeError(error) ? error.code : undefined
      if (timedOut) return { ok: false, reason: 'timeout' }
      if (controller.signal.aborted || code === 'cancelled') return { ok: false, reason: 'cancelled' }
      const conformReason = code === 'take-too-long' || code === 'memory-budget' || code === 'path-too-long' || code === 'conform-error'
        ? code
        : /too long|exceeds RIFF/i.test(message) ? 'take-too-long' : /memory|cache is full/i.test(message) ? 'memory-budget' : /graph.*budget/i.test(message) ? 'graph-budget' : 'conform-error'
      return { ok: false, reason: 'conform-failed', conformReason }
    } finally {
      clearTimeout(timeout); jobs.delete(id)
      if (latestBySong.get(raw.songId) === controller) latestBySong.delete(raw.songId)
    }
  })
  ipcMain.handle(VOICE_IPC.cancelConform, async (event, requestId: unknown) => {
    if (validId(requestId)) jobs.get(key(event.sender.id, requestId))?.abort()
  })
  ipcMain.handle(VOICE_IPC.invalidateConformed, async (event, raw: import('../shared/voice-take').VoiceTakeInvalidateRequest) => {
    try {
      if (!raw || !validId(raw.songId) || !validId(raw.takeId)) return { ok: false }
      if (raw.leaseId !== undefined) {
        if (!validId(raw.leaseId)) return { ok: false }
        const id = key(event.sender.id, raw.leaseId), lease = leases.get(id)
        if (!lease || lease.songId !== raw.songId || lease.takeId !== raw.takeId) return { ok: false }
        leases.delete(id)
        await releaseConformedTake(lease.path)
      }
      await invalidateConformedTake(raw.songId, raw.takeId, { cancelActive: false })
      return { ok: true }
    } catch { return { ok: false } }
  })
  const startValid = (value: unknown): value is VoiceRecordStartRequest => {
    const request = value as VoiceRecordStartRequest
    return Boolean(request && typeof request === 'object' && typeof request.songId === 'string' && typeof request.songTitle === 'string' && typeof request.songArtist === 'string' && request.input && typeof request.input.deviceName === 'string' && Number.isFinite(request.input.channelIndex) && Number.isFinite(request.tempo) && Number.isFinite(request.transposeSemitones))
  }
  const settingsValid = (value: unknown): value is VoiceRecordSettingsChange => {
    const change = value as VoiceRecordSettingsChange
    return Boolean(change && typeof change === 'object' && typeof change.takeId === 'string' && Number.isFinite(change.tempo) && Number.isFinite(change.transposeSemitones))
  }
  const armValid = (value: unknown): value is VoiceArmRequest => {
    const arm = value as VoiceArmRequest
    return Boolean(arm && typeof arm === 'object' && (arm.monitorOnly === undefined || typeof arm.monitorOnly === 'boolean') && arm.input && typeof arm.input.deviceName === 'string' && Number.isFinite(arm.input.channelIndex))
  }
  ipcMain.handle(VOICE_IPC.arm, async (event, request: unknown) => { try {
    if (!armValid(request)) return { ok: false, reason: 'error' as const, message: 'Invalid arm request.' }
    if (!event?.sender || event.sender.isDestroyed()) return { ok: false, reason: 'error' as const, message: 'Microphone owner is unavailable.' }
    const owner = watchOwner(event.sender)
    const result = await store.arm(request, owner)
    if (owner.detached || event.sender.isDestroyed()) {
      await store.monitorInputCleanup(owner)()
      return { ok: false, reason: 'error' as const, message: 'Microphone owner is unavailable.' }
    }
    return result
  } catch { return { ok: false, reason: 'error' as const, message: 'Microphone could not be armed.' } } })
  ipcMain.handle(VOICE_IPC.disarm, async () => { try { return await store.disarm() } catch { return { ok: false, error: 'Microphone could not be disarmed.' } } })
  ipcMain.handle(VOICE_IPC.recordStart, async (event, request: unknown) => {
    if (!startValid(request)) return { ok: false, reason: 'error' as const, message: 'Invalid recording request.' }
    if (event.sender.isDestroyed()) return { ok: false, reason: 'error' as const, message: 'Recording owner is unavailable.' }
    watchOwner(event.sender)
    const start = { owner: event.sender.id, detached: false }
    pendingStarts.add(start)
    try {
      // Do not let the previous owner's finalizer release a capture generation
      // that a replacement window has already reused for its own take.
      await recordingCleanup
      if (start.detached || event.sender.isDestroyed())
        return { ok: false, reason: 'error' as const, message: 'Recording owner is unavailable.' }
      const result = await store.start(request)
      if (result.ok) {
        if (start.detached || event.sender.isDestroyed()) {
          await stopLostRecording()
          return { ok: false, reason: 'error' as const, message: 'Recording owner is unavailable.' }
        }
        recordingOwner = start.owner
      }
      return result
    } catch { return { ok: false, reason: 'error' as const, message: 'Recording could not start.' } }
    finally { pendingStarts.delete(start) }
  })
  ipcMain.handle(VOICE_IPC.recordStop, async (event, reason?: 'device-lost' | 'error') => {
    if (recordingOwner !== undefined && recordingOwner !== event.sender.id)
      return { ok: false, reason: 'error' as const, message: 'Another renderer owns the recording.' }
    try { return await store.stop(reason) }
    catch { return { ok: false, reason: 'error' as const, message: 'The take could not be finalized.' } }
    finally { if (recordingOwner === event.sender.id) recordingOwner = undefined }
  })
  ipcMain.handle(VOICE_IPC.recordSettings, async (_event, change: unknown) => { try { return settingsValid(change) ? await store.settings(change) : { ok: false, error: 'Invalid recording settings.' } } catch { return { ok: false, error: 'Recording settings could not be applied.' } } })
  ipcMain.handle(VOICE_IPC.list, async (_event, songId: unknown) => { try { return typeof songId === 'string' ? await store.list(songId) : [] } catch { return [] } })
  ipcMain.handle(VOICE_IPC.remove, (_event, songId: unknown, takeId: unknown) =>
    typeof songId === 'string' && typeof takeId === 'string' ? store.remove(songId, takeId).catch(() => ({ ok: false, error: 'Take could not be deleted.' })) : { ok: false, error: 'Invalid take id.' })
  const takeRefValid = (value: unknown): value is VoiceTakePeaksRequest => {
    const ref = value as VoiceTakePeaksRequest
    return Boolean(ref && typeof ref === 'object' && typeof ref.songId === 'string' && ref.songId.length <= 200 && typeof ref.takeId === 'string' && ref.takeId.length <= 200)
  }
  ipcMain.handle(VOICE_IPC.peaks, async (_event, request: unknown) => { try { return takeRefValid(request) ? await store.peaks({ songId: request.songId, takeId: request.takeId }) : { ok: false as const, error: 'Invalid take peaks request.' } } catch { return { ok: false as const, error: 'Take peaks are unavailable.' } } })
  ipcMain.handle(VOICE_IPC.move, async (_event, request: unknown) => {
    try {
      const move = request as VoiceTakeMoveRequest
      return takeRefValid(request) && typeof move.userOffsetSec === 'number' && Number.isFinite(move.userOffsetSec) && Math.abs(move.userOffsetSec) <= VOICE_TAKE_MAX_OFFSET_SEC
        ? await store.move({ songId: move.songId, takeId: move.takeId, userOffsetSec: move.userOffsetSec })
        : { ok: false as const, error: 'Invalid take move request.' }
    } catch { return { ok: false as const, error: 'The take could not be moved.' } }
  })
  let levelFailureLogged = false
  ipcMain.handle(VOICE_IPC.level, async () => {
    try { const level = await store.level(); levelFailureLogged = false; return level }
    catch (error) {
      if (!levelFailureLogged) log('voice-take', 'level failed ' + JSON.stringify({ error: safeVoiceTakeMessage(error instanceof Error ? error.message : undefined, 'capture-level-failed') }), 'warn')
      levelFailureLogged = true
      return { peakDb: -120, rmsDb: -120, takeActive: false }
    }
  })
}

export function createRegisteredVoiceTakeStore(monitor?: import('./voice-monitor').VoiceMonitorStore): VoiceTakeStore {
  // The native action surface is deliberately injected so the store remains testable
  // while older addons return a clear unavailable error through the RPC layer.
  return new VoiceTakeStore({
    native: process.env.SINGZ_VOICE_NATIVE === '0' ? createUnavailableVoiceNative() : createVoiceTakeNative(),
    rootDir: undefined,
    monitor
  })
}

export function registerVoiceTakes(monitor?: import('./voice-monitor').VoiceMonitorStore): VoiceTakeStore {
  const store = createRegisteredVoiceTakeStore(monitor)
  registerVoiceTakeIpc(store)
  return store
}

