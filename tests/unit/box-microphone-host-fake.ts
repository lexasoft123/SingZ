import { vi } from 'vitest'
import type { BoxMicrophoneLevels, BoxMicrophoneSelectionEdit, BoxMicrophoneSelectionResult, BoxMicrophoneSnapshot } from '../../src/shared/box-audio'
import type { BoxResult } from '../../src/shared/box-contract'
import { BoxMicrophones, type MicrophoneChannelStorage } from '../../src/renderer/src/box/microphones'

export const device = { uid: 'alsa:flow8', label: 'FLOW 8', channels: 10 }
export function memoryStorage(initial?: unknown): MicrophoneChannelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  if (initial !== undefined) data.set('singz-box.microphone-channels.v1', JSON.stringify(initial))
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value) }, removeItem: key => { data.delete(key) } }
}
export const legacy = (...devices: [string, number[]][]) => ({ version: 1, devices })

/** A stand-in for the audio host's `service.microphones` surface. It owns the
 * selection and analysis; the renderer can only read it and edit by revision. */
export function fakeHost(initial: { origin?: 'default' | 'user'; device?: string | null; channels?: Record<string, number[]> } = {}) {
  let host: BoxMicrophoneSnapshot = {
    epoch: 'e1', revision: '1', origin: initial.origin ?? 'default',
    selection: { device: initial.device === undefined ? device.uid : initial.device, channels: initial.channels ?? { [device.uid]: [0, 1] } },
    phase: 'running', reason: '', detail: '', generation: '5', active: null, levels: null, pitch: null
  }
  let reachable = true
  let nextWriteError: string | null = null
  const settle = (): void => {
    const sel = host.selection
    if (sel.device === null) { host = { ...host, phase: 'off', reason: '', active: null, levels: null, pitch: null, generation: '0' }; return }
    const enabled = sel.channels[sel.device] ?? []
    const device_ = sel.device
    host = { ...host, phase: 'running', reason: '', generation: host.generation === '0' ? '6' : host.generation,
      active: { device: device_, label: device.label, deviceChannels: device.channels, enabledChannels: enabled, analysisChannel: enabled[0] ?? 0 },
      levels: { channelIndices: [...enabled], peak: enabled.map((_, i) => 0.25 * (i + 1)), rms: enabled.map(() => 0.1) },
      pitch: { frequency: 220, clarity: 0.9, ageMs: 40 } }
  }
  settle()
  const api = {
    microphones: vi.fn(async (): Promise<BoxResult<BoxMicrophoneSnapshot>> =>
      reachable ? { ok: true, value: structuredClone(host) } : { ok: false, error: 'ENOENT control socket' }),
    microphoneLevels: vi.fn(async (): Promise<BoxResult<BoxMicrophoneLevels>> =>
      reachable ? { ok: true, value: { epoch: host.epoch, generation: host.generation, levels: host.phase === 'running' && host.levels ? structuredClone(host.levels) : null } }
        : { ok: false, error: 'ENOENT control socket' }),
    setMicrophoneSelection: vi.fn(async (edit: BoxMicrophoneSelectionEdit): Promise<BoxResult<BoxMicrophoneSelectionResult>> => {
      if (!reachable) return { ok: false, error: 'ENOENT control socket' }
      if (edit.expectedRevision !== host.revision) return { ok: true, value: { ok: false, code: 'stale', error: 'stale', snapshot: structuredClone(host) } }
      if (nextWriteError) { const error = nextWriteError; nextWriteError = null; return { ok: true, value: { ok: false, code: 'write-failed', error, snapshot: structuredClone(host) } } }
      host = { ...host, revision: String(BigInt(host.revision) + 1n), origin: 'user', selection: { device: edit.device, channels: structuredClone(edit.channels) } }
      settle()
      return { ok: true, value: { ok: true, snapshot: structuredClone(host) } }
    })
  }
  return {
    api,
    get snapshot() { return host },
    /** Another writer (or a host-side change) while this UI is not looking. */
    patch(patch: Partial<BoxMicrophoneSnapshot>) { host = { ...host, ...patch } },
    bumpRevision(device_: string | null, channels: Record<string, number[]>) { host = { ...host, revision: String(BigInt(host.revision) + 1n), origin: 'user', selection: { device: device_, channels } }; settle() },
    setReachable(value: boolean) { reachable = value },
    failNextWrite(error: string) { nextWriteError = error },
    /** The audio host process restarted: new epoch and generation, same persisted selection. */
    restart() { host = { ...host, epoch: 'e2', generation: '9' }; settle(); host = { ...host, generation: '9' } }
  }
}
export function newStore(host: ReturnType<typeof fakeHost>, storage?: MicrophoneChannelStorage) {
  return new BoxMicrophones(host.api, () => Date.now(), storage ?? memoryStorage())
}
