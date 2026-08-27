import { app } from 'electron'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type {
  CaptureAnalysisWindow,
  CaptureInputDevice,
  CaptureStartResult,
  CaptureStateName,
  CaptureStats
} from '../shared/types'

export interface NativeCaptureBinding {
  inputDevices():
    | { ok: true; devices: CaptureInputDevice[] }
    | { ok: false; devices: []; error: string }
  beginCapture(
    config: { deviceUid?: string; inputChannel: number; ringBlocks?: number },
    generation: bigint,
    sink: (window: CaptureAnalysisWindow) => void
  ): CaptureStartResult
  cancelCapture(generation: bigint): { ok: true; cancelled: boolean }
  captureState(): { state: CaptureStateName; ownershipGeneration: string; error: string }
  captureStats(): CaptureStats
  /** Compiled-in identity — which Electron and which source tree built this binary. */
  buildInfo: { electronVersion: string; sourceStamp: string }
}

const require = createRequire(import.meta.url)

export interface CaptureAddonRuntime {
  envOverride?: string
  packaged: boolean
  resourcesPath: string
  cwd: string
  platform: NodeJS.Platform
  arch: string
}

export function resolveCaptureAddonPath(runtime: CaptureAddonRuntime): string {
  if (runtime.envOverride) return resolve(runtime.envOverride)
  return runtime.packaged
    ? join(runtime.resourcesPath, 'engines', 'singz-capture.node')
    : join(runtime.cwd, 'vendor', `${runtime.platform}-${runtime.arch}`, 'singz-capture.node')
}

export function captureAddonPath(): string {
  return resolveCaptureAddonPath({
    envOverride: process.env.SINGZ_CAPTURE_ADDON,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch
  })
}

export function loadCaptureBinding(): NativeCaptureBinding {
  const binding = require(captureAddonPath()) as NativeCaptureBinding
  // The addon is ABI-coupled to one Electron; a shape check alone would load
  // a stale or foreign-worktree binary and misbehave later. Refuse here — a
  // pre-identity or bare-cmake build reads as "an unknown Electron".
  const built = binding.buildInfo?.electronVersion || 'an unknown Electron'
  if (built !== process.versions.electron) {
    throw new Error(
      `singz-capture.node was built for Electron ${built}, this app runs ` +
        `${process.versions.electron} — rebuild it with npm run capture:addon`
    )
  }
  return binding
}

function parseGeneration(raw: string): bigint | null {
  if (!/^[1-9]\d{0,19}$/.test(raw)) return null
  try {
    const value = BigInt(raw)
    return value <= 0xffffffffffffffffn ? value : null
  } catch {
    return null
  }
}

function failedStart(error: string, inputChannel: number, deviceUid = ''): CaptureStartResult {
  return {
    ok: false,
    state: 'error',
    error,
    sampleRate: 0,
    inputChannel,
    deviceUid,
    deviceLabel: '',
    deviceChannels: 0,
    sampleFormat: '',
    sharingMode: '',
    performanceMode: '',
    timestampSource: ''
  }
}

function validStartResult(value: unknown): value is CaptureStartResult {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.ok === 'boolean' &&
    typeof row.state === 'string' &&
    typeof row.sampleRate === 'number' &&
    Number.isInteger(row.inputChannel) &&
    typeof row.deviceUid === 'string' &&
    typeof row.deviceLabel === 'string' &&
    typeof row.deviceChannels === 'number' &&
    typeof row.sampleFormat === 'string' &&
    typeof row.sharingMode === 'string' &&
    typeof row.performanceMode === 'string' &&
    typeof row.timestampSource === 'string' &&
    (row.ok || typeof row.error === 'string')
  )
}

/** One process owner. Native cancel stops and joins delivery before it returns. */
export class CaptureOwner {
  private binding: NativeCaptureBinding | null = null
  private loadError: string | null = null
  private generation = ''
  private rendererId: number | null = null
  private cleanupRenderers = new Set<number>()

  constructor(binding?: NativeCaptureBinding) {
    if (binding) this.binding = binding
  }

  private native(): NativeCaptureBinding | null {
    if (this.binding) return this.binding
    try {
      this.binding = loadCaptureBinding()
      this.loadError = null
    } catch (error) {
      // Retry on every call and keep only the LATEST failure: the addon can
      // appear after launch (first build finishing, a copy landing in
      // vendor/), and a latched first error would report a stale
      // "unavailable" for the whole process lifetime.
      this.loadError = `Native microphone support is unavailable: ${String(error)}`
    }
    return this.binding
  }

  devices(): { ok: true; devices: CaptureInputDevice[] } | { ok: false; devices: []; error: string } {
    const binding = this.native()
    if (!binding) return { ok: false, devices: [], error: this.loadError ?? 'Native capture unavailable' }
    return binding.inputDevices()
  }

  begin(
    rendererId: number,
    config: { deviceUid?: string; inputChannel: number; ringBlocks?: number },
    rawGeneration: string,
    emit: (window: CaptureAnalysisWindow) => void
  ): CaptureStartResult {
    const generation = parseGeneration(rawGeneration)
    if (!generation || !Number.isInteger(config.inputChannel) || config.inputChannel < 0) {
      return failedStart('Invalid microphone ownership generation or input channel.', 0)
    }
    const binding = this.native()
    if (!binding) {
      return {
        ok: false,
        state: 'unsupported',
        error: this.loadError ?? 'Native capture unavailable',
        sampleRate: 0,
        inputChannel: config.inputChannel,
        deviceUid: config.deviceUid ?? '',
        deviceLabel: '',
        deviceChannels: 0,
        sampleFormat: '',
        sharingMode: '',
        performanceMode: '',
        timestampSource: ''
      }
    }
    let exactConfig = config
    if (!config.deviceUid) {
      const inventory = binding.inputDevices()
      const defaultDevice = inventory.ok
        ? inventory.devices.find((device) => device.isDefault)
        : undefined
      if (!defaultDevice) {
        return {
          ok: false,
          state: 'error',
          error: inventory.ok ? 'No system-default microphone is available.' : inventory.error,
          sampleRate: 0,
          inputChannel: config.inputChannel,
          deviceUid: '',
          deviceLabel: '',
          deviceChannels: 0,
          sampleFormat: '',
          sharingMode: '',
          performanceMode: '',
          timestampSource: ''
        }
      }
      exactConfig = { ...config, deviceUid: defaultDevice.uid }
    }
    if (this.generation) binding.cancelCapture(BigInt(this.generation))
    this.generation = rawGeneration
    this.rendererId = rendererId
    let rawResult: unknown
    try {
      rawResult = binding.beginCapture(exactConfig, generation, (window) => {
        if (this.generation === window.ownershipGeneration && this.rendererId === rendererId) emit(window)
      })
    } catch (error) {
      try { binding.cancelCapture(generation) } catch { /* rollback is best-effort after bridge failure */ }
      this.generation = ''
      this.rendererId = null
      return failedStart(
        `Native microphone start failed: ${String(error)}`,
        exactConfig.inputChannel,
        exactConfig.deviceUid
      )
    }
    if (!validStartResult(rawResult)) {
      try { binding.cancelCapture(generation) } catch { /* malformed bridge may fail cancellation too */ }
      this.generation = ''
      this.rendererId = null
      return failedStart(
        'Native microphone start returned an invalid response.',
        exactConfig.inputChannel,
        exactConfig.deviceUid
      )
    }
    const result = rawResult
    if (!result.ok) {
      this.generation = ''
      this.rendererId = null
    }
    return result
  }

  cancel(rendererId: number, rawGeneration: string): { ok: true; cancelled: boolean } | { ok: false; error: string } {
    const generation = parseGeneration(rawGeneration)
    if (!generation) return { ok: false, error: 'Invalid microphone ownership generation.' }
    if (this.rendererId !== rendererId || this.generation !== rawGeneration) {
      return { ok: true, cancelled: false }
    }
    const binding = this.native()
    if (!binding) return { ok: false, error: this.loadError ?? 'Native capture unavailable' }
    const result = binding.cancelCapture(generation)
    if (result.cancelled) {
      this.generation = ''
      this.rendererId = null
    }
    return result
  }

  rendererGone(rendererId: number): void {
    if (rendererId === this.rendererId) this.stop()
  }

  /** True once per webContents lifetime, so restarts/reloads add no listeners. */
  bindRendererCleanup(rendererId: number): boolean {
    if (this.cleanupRenderers.has(rendererId)) return false
    this.cleanupRenderers.add(rendererId)
    return true
  }

  stop(): void {
    if (!this.generation || !this.binding) return
    this.binding.cancelCapture(BigInt(this.generation))
    this.generation = ''
    this.rendererId = null
  }

  state(): { state: CaptureStateName; ownershipGeneration: string; error: string } {
    return this.native()?.captureState() ?? {
      state: 'unsupported',
      ownershipGeneration: '',
      error: this.loadError ?? 'Native capture unavailable'
    }
  }

  stats(): CaptureStats {
    return this.native()?.captureStats() ?? {
      deliveredBlocks: '0',
      deliveredFrames: '0',
      overruns: '0',
      deliveryWakeups: '0',
      droppedEvents: '0',
      overwrittenWindows: '0'
    }
  }
}
