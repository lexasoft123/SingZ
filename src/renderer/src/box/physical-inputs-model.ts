import { tMicrophone } from './settings-i18n'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { BoxResult, BoxRoutingState } from '../../../shared/box-contract'

export type PhysicalSelection = { uid: string; channel: number } | null
export type RoutingPreview = {
  state: BoxRoutingState | null
  error: string
  pending: boolean
  receivedAt: number | null
}
type Revision = BoxRoutingState['snapshot']['revision']
type RoutingApi = {
  read(): Promise<BoxResult<BoxRoutingState>>
  edit(value: { expected: Revision; commands: unknown[] }): Promise<BoxResult<BoxRoutingState>>
}
/** One mounted Settings owner: reads never overlap, and explicit edits wait for
 * an already-running read. Visibility/unmount revoke queued work and replies. */
export class PhysicalRoutingPreview {
  private value: RoutingPreview = { state: null, error: '', pending: false, receivedAt: null }
  private listeners = new Set<() => void>()
  private generation = 0
  private active = false
  private visible = false
  private timer?: ReturnType<typeof setInterval>
  private flight: Promise<void> | null = null
  private editing = false
  constructor(private readonly api: RoutingApi, private readonly now: () => number = Date.now) {}
  getSnapshot = (): RoutingPreview => this.value
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(patch: Partial<RoutingPreview>): void {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  start(visible = true): void {
    this.active = true
    this.setVisible(visible)
    if (!this.timer) this.timer = setInterval(() => { void this.refresh() }, 200)
  }
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible; this.generation++
    this.publish({ receivedAt: null })
    if (visible && this.active) void this.refresh()
  }
  stop(): void {
    this.active = false; this.visible = false; this.generation++
    clearInterval(this.timer); this.timer = undefined
    this.publish({ receivedAt: null })
  }
  refresh = (): Promise<void> => {
    if (!this.active || !this.visible || this.flight || this.editing) return this.flight ?? Promise.resolve()
    const token = this.generation
    const flight = (async () => {
      try {
        const result = await this.api.read()
        if (token !== this.generation || !this.active || !this.visible) return
        if (result.ok) this.publish({ state: result.value, error: '', receivedAt: this.now() })
        else this.publish({ error: tMicrophone('box.microphones.routingReadFailed', { detail: result.error }), receivedAt: null })
      } catch (error) {
        if (token === this.generation && this.active && this.visible) this.publish({ error: tMicrophone('box.microphones.routingReadFailed', { detail: String(error) }), receivedAt: null })
      }
    })()
    this.flight = flight
    void flight.finally(() => { if (this.flight === flight) this.flight = null })
    return flight
  }
  edit = async (expected: Revision, commands: unknown[]): Promise<boolean> => {
    if (!this.active || !this.visible || this.editing) return false
    const token = this.generation
    this.editing = true
    this.publish({ pending: true })
    try {
      await this.flight
      if (token !== this.generation || !this.active || !this.visible) return false
      if (this.value.error || this.value.receivedAt === null || this.now() - this.value.receivedAt > 1000) {
        this.publish({ error: tMicrophone('box.microphones.refreshRouting') }); return false
      }
      const revision = this.value.state?.snapshot.revision
      if (!revision || revision.epoch !== expected.epoch || revision.generation !== expected.generation) {
        this.publish({ error: tMicrophone('box.microphones.routingChanged') }); return false
      }
      const result = await this.api.edit({ expected, commands })
      if (token !== this.generation || !this.active || !this.visible) return false
      if (result.ok) { this.publish({ state: result.value, error: '', receivedAt: this.now() }); return true }
      this.publish({ error: tMicrophone('box.microphones.routingApplyFailed', { detail: result.error }), receivedAt: null }); return false
    } catch (error) {
      if (token === this.generation && this.active && this.visible) this.publish({ error: tMicrophone('box.microphones.routingApplyFailed', { detail: String(error) }), receivedAt: null })
      return false
    } finally {
      this.editing = false
      this.publish({ pending: false })
    }
  }
}
export function usePhysicalRoutingPreview(enabled: boolean): { preview: RoutingPreview; controller: PhysicalRoutingPreview } {
  const controller = useMemo(() => new PhysicalRoutingPreview({
    read: () => window.singz.box.routingSnapshot(),
    edit: value => window.singz.box.routingEdit(value)
  }), [])
  const preview = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => {
    if (!enabled) return
    const visible = (): void => controller.setVisible(document.visibilityState !== 'hidden')
    controller.start(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', visible)
    return () => { document.removeEventListener('visibilitychange', visible); controller.stop() }
  }, [controller, enabled])
  return { preview, controller }
}
export function physicalInputDevices(state: BoxRoutingState | null): BoxRoutingState['inventory']['devices'] {
  return state?.inventory.devices.filter(device => device.inputChannels > 0) ?? []
}
export function physicalInventoryIssue(state: BoxRoutingState | null): string {
  if (!state) return tMicrophone('box.microphones.connecting')
  if (state.inventory.devicesFresh === false || state.inventory.devicesError) return state.inventory.devicesError ? tMicrophone('box.microphones.inventoryDetail', { detail: state.inventory.devicesError }) : tMicrophone('box.microphones.inventoryUnavailable')
  return ''
}
export function physicalChannels(device: BoxRoutingState['inventory']['devices'][number]): { channel: number; name: string }[] {
  return Array.from({ length: Math.min(64, device.inputChannels) }, (_, channel) => ({
    channel, name: device.inputChannelNames?.[channel]?.trim() || tMicrophone('box.microphones.channelLabel', { channel: channel + 1 })
  }))
}
export function selectPhysicalChannel(state: BoxRoutingState | null, uid: string, channel: number): PhysicalSelection {
  const device = physicalInputDevices(state).find(row => row.uid === uid)
  return device && !physicalInventoryIssue(state) && Number.isInteger(channel) && channel >= 0 && channel < Math.min(64, device.inputChannels)
    ? { uid, channel } : null
}
/** Pre-fader source meter only. Output/monitor peaks never stand in for a mic. */
export function physicalInputLevel(preview: RoutingPreview, uid: string, channel: number, now = Date.now()): { peak: number; rms: number } | null {
  const { state, receivedAt } = preview
  if (!state || receivedAt === null || now - receivedAt > 1000 || now < receivedAt || preview.error ||
      physicalInventoryIssue(state) || !selectPhysicalChannel(state, uid, channel) || !state.snapshot.runtime.metersFresh ||
      state.snapshot.restoration.activeGeneration !== state.snapshot.restoration.desiredGeneration) return null
  for (const device of state.snapshot.document?.devices ?? []) {
    const live = state.snapshot.runtime.devices?.find(row => row.id === device.id && row.active)
    if (!live) continue
    for (const binding of device.bindings) {
      if (binding.kind !== 'input-device' || binding.selector !== uid) continue
      const source = device.routing.sources.find(row => row.id === binding.id && row.enabled && row.channels > channel)
      const input = live.sources.find(row => row.id === source?.id && row.online)
      const meter = input?.meter
      if (meter?.valid && meter.frames > 0 && meter.channels > channel && Number.isFinite(meter.peak[channel]) && Number.isFinite(meter.rms[channel])) {
        return { peak: meter.peak[channel], rms: meter.rms[channel] }
      }
    }
  }
  return null
}

/** Stable UIDs preserve draft identity if physical enumeration order changes. */
export function cyclePhysicalDevice(devices: { uid: string }[], current: string | null): string | null {
  return devices.length ? devices[(devices.findIndex(device => device.uid === current) + 1) % devices.length].uid : null
}
