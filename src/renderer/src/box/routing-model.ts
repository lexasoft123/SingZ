import type { BoxRoutingState } from '../../../shared/box-contract'
import { tSettings } from './settings-i18n'

export const ROUTING_CHANNEL_LIMIT = 64
export const routingChannelCount = (channels: number): number => Math.max(0, Math.min(ROUTING_CHANNEL_LIMIT, Math.floor(channels)))
/** Source gain buttons move on a 10% grid. Snapping to integer steps keeps
 * repeated presses from accumulating float drift (e.g. 1e-16 shown as 0%). */
export const ROUTING_GAIN_STEPS = 10
export function routingGainSteps(gain: number): number {
  return Number.isFinite(gain) ? Math.max(0, Math.min(ROUTING_GAIN_STEPS, Math.round(gain * ROUTING_GAIN_STEPS))) : 0
}
export function stepRoutingGain(gain: number, direction: -1 | 1): number {
  return Math.max(0, Math.min(ROUTING_GAIN_STEPS, routingGainSteps(gain) + direction)) / ROUTING_GAIN_STEPS
}

/** Synchronous admission prevents repeated OK events before React rerenders. */
export class RoutingRequestGate {
  private generation = 0
  private active: number | null = null
  begin(): number | null {
    if (this.active !== null) return null
    return this.active = ++this.generation
  }
  current(token: number): boolean { return this.active === token }
  finish(token: number): boolean {
    if (!this.current(token)) return false
    this.active = null
    return true
  }
  invalidate(): void { this.active = null; ++this.generation }
}
export function hasSongRoute(state: BoxRoutingState): boolean {
  return state.snapshot.document?.devices.some(device => device.bindings.some(binding => binding.selector === 'native:singz')) ?? false
}
export function musicRouteCommands(state: BoxRoutingState, outputUid: string, firstChannel: number): unknown[] {
  if (hasSongRoute(state)) throw new Error(tSettings('box.settings.routing.errorMusicExists'))
  const owner = ensureStereoOutput(state, outputUid, firstChannel)
  if (owner) {
    const sourceId = uniqueSourceId(owner.device, 'song')
    return [
      { type: 'addSource', device: owner.device.id, id: sourceId, kind: 'application', selector: 'native:singz', channels: 2, muteOriginal: false, connectByDefault: false },
      { type: 'setSourceWiring', device: owner.device.id, source: sourceId, connections: stereoWiring(0) }
    ]
  }
  const ids = new Set(state.snapshot.document?.devices.map(device => device.id) ?? [])
  let id = 'singz-song'
  for (let suffix = 2; ids.has(id); ++suffix) id = `singz-song-${suffix}`
  return [
    { type: 'createDevice', id, name: 'SingZ music', channels: 2, sampleRate: 48000, passThrough: false },
    { type: 'addSource', device: id, id: 'song', kind: 'application', selector: 'native:singz', channels: 2, muteOriginal: false, connectByDefault: true },
    { type: 'addMonitor', device: id, id: 'speakers', selector: outputUid, channels: firstChannel + 2, connectByDefault: false },
    { type: 'setMonitorWiring', device: id, monitor: 'speakers', connections: stereoWiring(firstChannel) }
  ]
}
export function routingActivationText(state: BoxRoutingState): string {
  const restored = state.snapshot.restoration
  if (restored.phase === 'no-document') return tSettings('box.settings.routing.noRoute')
  if (restored.phase === 'restored' && restored.desiredGeneration === restored.activeGeneration)
    return tSettings('box.settings.routing.active')
  return `${tSettings('box.settings.routing.waiting', { phase: restored.phase })}${restored.error ? ` ${restored.error}` : ''}`
}

export function songMonitor(state: BoxRoutingState): { device: string; monitor: string; outputUid: string; firstChannel: number } | null {
  const device = state.snapshot.document?.devices.find(row => row.bindings.some(binding => binding.selector === 'native:singz'))
  const monitor = device?.monitors[0]
  if (!device || !monitor) return null
  const firstChannel = monitor.connections.find(wire => wire.sourceChannel === 0)?.outputChannel ?? 0
  return { device: device.id, monitor: monitor.id, outputUid: monitor.deviceSelector, firstChannel }
}
function stereoWiring(firstChannel: number): { sourceChannel: number; outputChannel: number; gain: number }[] {
  return [{ sourceChannel: 0, outputChannel: firstChannel, gain: 1 }, { sourceChannel: 1, outputChannel: firstChannel + 1, gain: 1 }]
}
function validateOutput(state: BoxRoutingState, outputUid: string, firstChannel: number): void {
  if (state.inventory.devicesFresh === false || state.inventory.devicesError) throw new Error(tSettings('box.settings.routing.errorInventory'))
  const output = state.inventory.devices.find(device => device.uid === outputUid)
  if (!output || !Number.isInteger(firstChannel) || firstChannel < 0 || firstChannel % 2 || firstChannel + 2 > routingChannelCount(output.outputChannels))
    throw new Error(tSettings('box.settings.routing.errorStereoPair'))
}
type RoutingDevice = NonNullable<BoxRoutingState['snapshot']['document']>['devices'][number]
function outputOwners(state: BoxRoutingState, outputUid: string) {
  return (state.snapshot.document?.devices ?? []).flatMap(device => device.monitors
    .filter(monitor => monitor.enabled && monitor.deviceSelector === outputUid)
    .map(monitor => ({ device, monitor })))
}
/** Reuse one physical stereo owner without modifying its controls or matrix. */
export function ensureStereoOutput(state: BoxRoutingState, outputUid: string, firstChannel: number) {
  validateOutput(state, outputUid, firstChannel)
  const owners = outputOwners(state, outputUid)
  if (owners.length > 1) throw new Error(tSettings('box.settings.routing.errorMultipleOwners'))
  const owner = owners[0]
  if (owner && (owner.device.routing.outputChannels !== 2 || owner.monitor.connections.length !== 2 ||
      ![0, 1].every(channel => owner.monitor.connections.some(wire => wire.sourceChannel === channel &&
        wire.outputChannel === firstChannel + channel && wire.gain > 0))))
    throw new Error(tSettings('box.settings.routing.errorBusLayout'))
  return owner
}
function uniqueSourceId(device: RoutingDevice, base: string): string {
  const ids = new Set([...device.bindings.map(binding => binding.id), ...device.routing.sources.map(source => source.id)])
  let id = base
  for (let suffix = 2; ids.has(id); ++suffix) id = `${base}-${suffix}`
  return id
}
/** Changes only the chosen existing music monitor, leaving all buses and inputs intact. */
export function musicOutputCommands(state: BoxRoutingState, outputUid: string, firstChannel: number): unknown[] {
  validateOutput(state, outputUid, firstChannel)
  const current = songMonitor(state)
  const conflicting = outputOwners(state, outputUid).some(owner => owner.device.id !== current?.device || owner.monitor.id !== current?.monitor)
  if (current && conflicting) throw new Error(tSettings('box.settings.routing.errorOutputOwned'))
  if (!current) {
    const device = state.snapshot.document?.devices.find(row => row.bindings.some(binding => binding.selector === 'native:singz'))
    if (!device) return musicRouteCommands(state, outputUid, firstChannel)
    if (conflicting) throw new Error(tSettings('box.settings.routing.errorOutputOwned'))
    return [
      { type: 'addMonitor', device: device.id, id: 'speakers', selector: outputUid, channels: firstChannel + 2, connectByDefault: false },
      { type: 'setMonitorWiring', device: device.id, monitor: 'speakers', connections: stereoWiring(firstChannel) }
    ]
  }
  return [
    // Each Engine command validates its intermediate graph; detach old wires
    // before reducing endpoint width so old high channels do not invalidate it.
    { type: 'setMonitorWiring', device: current.device, monitor: current.monitor, connections: [] },
    { type: 'setMonitorEndpoint', device: current.device, monitor: current.monitor, selector: outputUid, channels: firstChannel + 2 },
    { type: 'setMonitorWiring', device: current.device, monitor: current.monitor, connections: stereoWiring(firstChannel) }
  ]
}
/** Explicit software monitoring only. Hardware mixer monitoring remains the default. */
export function microphoneRouteCommands(state: BoxRoutingState, inputUid: string, inputChannel: number, outputUid: string, firstChannel: number): unknown[] {
  validateOutput(state, outputUid, firstChannel)
  const input = state.inventory.devices.find(device => device.uid === inputUid)
  if (!input || !Number.isInteger(inputChannel) || inputChannel < 0 || inputChannel >= routingChannelCount(input.inputChannels))
    throw new Error(tSettings('box.settings.routing.errorInputChannel'))
  if (inputUid === outputUid) throw new Error(tSettings('box.settings.routing.errorFeedback'))
  const devices = state.snapshot.document?.devices ?? []
  if (devices.some(device => device.bindings.some(binding => binding.kind === 'input-device' && binding.selector === inputUid &&
      device.routing.sources.some(source => source.id === binding.id && source.connections.some(wire => wire.sourceChannel === inputChannel)))))
    throw new Error(tSettings('box.settings.routing.errorMicrophoneRouted'))
  const owner = ensureStereoOutput(state, outputUid, firstChannel)
  const ids = new Set(devices.map(device => device.id))
  let id = owner?.device.id ?? 'singz-microphone'
  if (!owner) for (let suffix = 2; ids.has(id); ++suffix) id = `singz-microphone-${suffix}`
  const sourceId = owner ? uniqueSourceId(owner.device, 'microphone') : 'microphone'
  const sourceCommands = [
    { type: 'addSource', device: id, id: sourceId, kind: 'input-device', selector: inputUid, channels: routingChannelCount(input.inputChannels), muteOriginal: false, connectByDefault: false },
    { type: 'setSourceWiring', device: id, source: sourceId, connections: [
      { sourceChannel: inputChannel, outputChannel: 0, gain: 1 }, { sourceChannel: inputChannel, outputChannel: 1, gain: 1 }
    ] }
  ]
  // The physical endpoint already has one native owner. Mix another independent
  // source into its existing stereo bus instead of opening it a second time.
  if (owner) return sourceCommands
  return [
    { type: 'createDevice', id, name: `Microphone ${inputChannel + 1}`, channels: 2, sampleRate: 48000, passThrough: false },
    ...sourceCommands,
    { type: 'addMonitor', device: id, id: 'speakers', selector: outputUid, channels: firstChannel + 2, connectByDefault: false },
    { type: 'setMonitorWiring', device: id, monitor: 'speakers', connections: stereoWiring(firstChannel) }
  ]
}
