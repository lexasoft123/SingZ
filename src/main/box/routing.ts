import type { BoxResult, BoxRoutingState } from '../../shared/box-contract'

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096 && !v.includes('\0')
const counter = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v)
const integer = (v: unknown, max = 64): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
const gain = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const list = (v: unknown, max: number, valid: (item: any) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(valid)
const controls = (v: any): boolean => record(v) && gain(v.gain) && typeof v.enabled === 'boolean' && typeof v.muted === 'boolean'
const wires = (v: unknown): boolean => list(v, 4096, w => record(w) && integer(w.sourceChannel, 63) && integer(w.outputChannel, 63) && gain(w.gain))
const optional = (value: unknown, valid: (value: any) => boolean): boolean => value === undefined || valid(value)
const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const levels = (value: unknown): boolean => list(value, 64, finiteNonnegative)
const meter = (value: any): boolean => record(value) && typeof value.valid === 'boolean' && integer(value.channels) &&
  Number.isSafeInteger(value.frames) && value.frames >= 0 && levels(value.peak) && levels(value.rms) &&
  value.peak.length === value.channels && value.rms.length === value.channels && (!value.valid || value.frames > 0)
const channelNames = (value: unknown): boolean => list(value, 65536, name => typeof name === 'string' && name.length <= 256 && !name.includes('\0'))
const inventoryDevice = (d: any): boolean => record(d) && text(d.uid) && text(d.name) && integer(d.inputChannels, 65536) && integer(d.outputChannels, 65536) &&
  optional(d.inputChannelNames, channelNames) && optional(d.outputChannelNames, channelNames) &&
  optional(d.defaultInput, value => typeof value === 'boolean') && optional(d.defaultOutput, value => typeof value === 'boolean') && optional(d.rate, value => finiteNonnegative(value) && value <= 4000000)
const runtimeDevice = (d: any): boolean => record(d) && text(d.id) && typeof d.active === 'boolean' && meter(d.meter) &&
  list(d.sources, 32, source => record(source) && text(source.id) && typeof source.online === 'boolean' && counter(source.missingFrames) && meter(source.meter))
export function validRoutingState(v: unknown): v is BoxRoutingState {
  if (!record(v) || v.version !== 1 || !record(v.inventory) || !record(v.snapshot)) return false
  const s = v.snapshot
  return list(v.inventory.devices, 256, inventoryDevice) && optional(v.inventory.devicesFresh, value => typeof value === 'boolean') &&
    optional(v.inventory.devicesError, text) &&
    record(s.revision) && text(s.revision.epoch) && counter(s.revision.generation) &&
    record(s.restoration) && text(s.restoration.phase) && text(s.restoration.error) && counter(s.restoration.desiredGeneration) && counter(s.restoration.activeGeneration) &&
    record(s.runtime) && typeof s.runtime.metersFresh === 'boolean' && optional(s.runtime.devices, value => list(value, 32, runtimeDevice)) && list(s.runtime.monitors, 1024, m => record(m) && text(m.device) && text(m.monitor) && typeof m.sourceOnline === 'boolean' && record(m.meter) && typeof m.meter.valid === 'boolean') &&
    (s.document === null || record(s.document) && list(s.document.devices, 32, d =>
      record(d) && text(d.id) && text(d.name) && record(d.routing) && integer(d.routing.outputChannels) &&
      list(d.routing.sources, 32, a => controls(a) && text(a.id) && integer(a.channels) && wires(a.connections)) &&
      list(d.bindings, 32, b => record(b) && text(b.id) && text(b.kind) && text(b.selector)) &&
      list(d.monitors, 32, m => controls(m) && text(m.id) && text(m.deviceSelector) && integer(m.channels) && wires(m.connections))))
}

type Request = (json: string) => Promise<string>
/** Owner TV lane only. The Engine remains the route schema and revision authority. */
export class BoxRoutingService {
  constructor(private readonly request?: Request, private readonly reconcile?: () => Promise<unknown>) {}

  async snapshot(): Promise<BoxResult<BoxRoutingState>> {
    if (!this.request) return { ok: false, error: 'The independent audio host is not configured.' }
    try {
      await this.reconcile?.()
      const value = JSON.parse(await this.request(JSON.stringify({ version: 1, operation: 'state' })))
      if (!validRoutingState(value)) {
        return { ok: false, error: 'The audio host returned an invalid routing snapshot.' }
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Routing is unavailable.' }
    }
  }

  async edit(value: unknown): Promise<BoxResult<BoxRoutingState>> {
    if (!this.request) return { ok: false, error: 'The independent audio host is not configured.' }
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid routing edit.')
      const v = value as { expected?: { epoch?: unknown; generation?: unknown }; commands?: unknown[] }
      if (Object.keys(v).some(key => !['expected', 'commands'].includes(key)) ||
          typeof v.expected?.epoch !== 'string' || v.expected.epoch.length > 128 ||
          typeof v.expected.generation !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v.expected.generation) ||
          !Array.isArray(v.commands) || !v.commands.length || v.commands.length > 128) throw new Error('Invalid routing edit.')
      const state = await this.snapshot()
      if (!state.ok) return state
      if (state.value.snapshot.revision.epoch !== v.expected.epoch ||
          state.value.snapshot.revision.generation !== v.expected.generation) throw new Error('Routing changed. Refresh before applying.')
      const json = JSON.stringify({ version: 1, operation: state.value.snapshot.document ? 'edit' : 'initialize',
        request: { version: 1, expected: v.expected, commands: v.commands } })
      if (Buffer.byteLength(json) >= 1024 * 1024) throw new Error('Routing edit is too large.')
      const ack = JSON.parse(await this.request(json))
      if (ack.ok !== true) throw new Error(ack.detail || ack.code || 'The routing edit was rejected.')
      return await this.snapshot()
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'The routing edit failed.' }
    }
  }
}
