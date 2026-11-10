import { describe, expect, it } from 'vitest'
import type { BoxRoutingState } from '../../src/shared/box-contract'
import { RoutingRequestGate, hasSongRoute, musicRouteCommands, routingActivationText } from '../../src/renderer/src/box/routing-model'
const state = (): BoxRoutingState => ({ version: 1,
  inventory: { devices: [{ uid: 'alsa:flow8', name: 'FLOW 8', inputChannels: 10, outputChannels: 4 }] },
  snapshot: { revision: { epoch: 'e', generation: '1' }, document: null,
    restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' }, runtime: { metersFresh: false, monitors: [] } }
})
describe('TV routing model', () => {
  it('admits one remote activation synchronously and ignores old mount replies', () => {
    const gate = new RoutingRequestGate()
    const old = gate.begin()!
    expect(gate.begin()).toBeNull()
    gate.invalidate()
    const current = gate.begin()!
    expect(gate.finish(old)).toBe(false)
    expect(gate.current(current)).toBe(true)
    expect(gate.finish(current)).toBe(true)
  })
  it('adds a song beside existing microphone routes without rewriting or stopping them', () => {
    const current = state()
    current.snapshot.document = { devices: [{ id: 'singz-song', name: 'Microphones', routing: { outputChannels: 2, sources: [] }, bindings: [{ id: 'mic', kind: 'input-device', selector: 'alsa:flow8' }], monitors: [] }] }
    const original = JSON.stringify(current)
    expect(hasSongRoute(current)).toBe(false)
    const commands = musicRouteCommands(current, 'alsa:flow8', 2) as Record<string, unknown>[]
    expect(commands[0]).toMatchObject({ type: 'createDevice', id: 'singz-song-2', passThrough: false })
    expect(commands[2]).toMatchObject({ type: 'addMonitor', channels: 4, connectByDefault: false })
    expect(commands[3].connections).toEqual([{ sourceChannel: 0, outputChannel: 2, gain: 1 }, { sourceChannel: 1, outputChannel: 3, gain: 1 }])
    expect(JSON.stringify(current)).toBe(original)
    expect(commands.some(command => String(command.type).match(/stop|delete|remove/i))).toBe(false)
  })
  it('rejects disconnected outputs, invalid pairs and duplicate song creation', () => {
    const current = state()
    expect(() => musicRouteCommands(current, 'missing', 0)).toThrow('available')
    expect(() => musicRouteCommands(current, 'alsa:flow8', 4)).toThrow('available')
    expect(() => musicRouteCommands(current, 'alsa:flow8', 1)).toThrow('available')
    current.snapshot.document = { devices: [{ id: 'music', name: 'Music', routing: { outputChannels: 2, sources: [] }, bindings: [{ id: 'song', kind: 'application', selector: 'native:singz' }], monitors: [] }] }
    expect(() => musicRouteCommands(current, 'alsa:flow8', 0)).toThrow('already')
  })
  it('does not present persistence acknowledgement as active physical routing', () => {
    const current = state()
    current.snapshot.restoration = { phase: 'retry', error: 'Output unavailable', desiredGeneration: '5', activeGeneration: '4' }
    expect(routingActivationText(current)).toContain('waiting for activation')
    current.snapshot.restoration.phase = 'restored'
    expect(routingActivationText(current)).toContain('waiting for activation')
    current.snapshot.restoration.activeGeneration = '5'
    expect(routingActivationText(current)).toBe('Saved routing is active.')
  })
})

// Output changes are atomic Engine edits; unrelated microphone buses survive.
describe('routing drafts', () => {
  it('rewires the existing music monitor and clears high wires before shrinking its width', async () => {
    const { musicOutputCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = state()
    current.snapshot.document = { devices: [{ id: 'music', name: 'Music', routing: { outputChannels: 2, sources: [] }, bindings: [{ id: 'song', kind: 'application', selector: 'native:singz' }], monitors: [{ id: 'out', deviceSelector: 'alsa:flow8', channels: 4, gain: 1, enabled: true, muted: false, connections: [{ sourceChannel: 0, outputChannel: 2, gain: 1 }, { sourceChannel: 1, outputChannel: 3, gain: 1 }] }] }] }
    const commands = musicOutputCommands(current, 'alsa:flow8', 0)
    expect(commands).toEqual([
      { type: 'setMonitorWiring', device: 'music', monitor: 'out', connections: [] },
      { type: 'setMonitorEndpoint', device: 'music', monitor: 'out', selector: 'alsa:flow8', channels: 2 },
      { type: 'setMonitorWiring', device: 'music', monitor: 'out', connections: [{ sourceChannel: 0, outputChannel: 0, gain: 1 }, { sourceChannel: 1, outputChannel: 1, gain: 1 }] }
    ])
  })
  it('requires an explicit different interface for microphone software monitoring', async () => {
    const { microphoneRouteCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = state()
    expect(() => microphoneRouteCommands(current, 'alsa:flow8', 0, 'alsa:flow8', 0)).toThrow('feedback')
    current.inventory.devices.push({ uid: 'alsa:speakers', name: 'Speakers', inputChannels: 0, outputChannels: 2 })
    expect(() => microphoneRouteCommands(current, 'alsa:flow8', 10, 'alsa:speakers', 0)).toThrow('input channel')
    const commands = microphoneRouteCommands(current, 'alsa:flow8', 3, 'alsa:speakers', 0) as Record<string, unknown>[]
    expect(commands[0]).toMatchObject({ type: 'createDevice', passThrough: false })
    expect(commands[1]).toMatchObject({ type: 'addSource', kind: 'input-device', selector: 'alsa:flow8', connectByDefault: false })
    expect(commands[2].connections).toEqual([{ sourceChannel: 3, outputChannel: 0, gain: 1 }, { sourceChannel: 3, outputChannel: 1, gain: 1 }])
    expect(current.snapshot.document).toBeNull()
  })
})

describe('one physical output owner', () => {
  const sharedState = (): BoxRoutingState => {
    const current = state()
    current.inventory.devices.push({ uid: 'alsa:pa', name: 'PA', inputChannels: 0, outputChannels: 4 })
    current.snapshot.document = { devices: [{
      id: 'shared', name: 'Music and microphones', routing: { outputChannels: 2, sources: [
        { id: 'microphone', channels: 10, gain: 0.6, muted: false, enabled: true, connections: [{ sourceChannel: 0, outputChannel: 0, gain: 1 }, { sourceChannel: 0, outputChannel: 1, gain: 1 }] }
      ] }, bindings: [{ id: 'microphone', kind: 'input-device', selector: 'alsa:flow8' }],
      monitors: [{ id: 'pa', deviceSelector: 'alsa:pa', channels: 2, gain: 0.7, enabled: true, muted: false, connections: [{ sourceChannel: 0, outputChannel: 0, gain: 1 }, { sourceChannel: 1, outputChannel: 1, gain: 1 }] }]
    }] }
    return current
  }
  it('adds a second microphone channel to the same PA without another monitor or bus', async () => {
    const { microphoneRouteCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = sharedState()
    const before = JSON.stringify(current)
    const commands = microphoneRouteCommands(current, 'alsa:flow8', 1, 'alsa:pa', 0)
    expect(commands).toEqual([
      { type: 'addSource', device: 'shared', id: 'microphone-2', kind: 'input-device', selector: 'alsa:flow8', channels: 10, muteOriginal: false, connectByDefault: false },
      { type: 'setSourceWiring', device: 'shared', source: 'microphone-2', connections: [{ sourceChannel: 1, outputChannel: 0, gain: 1 }, { sourceChannel: 1, outputChannel: 1, gain: 1 }] }
    ])
    expect(JSON.stringify(current)).toBe(before)
  })
  it('shares the existing music stereo bus while preserving song gain and wiring', async () => {
    const { microphoneRouteCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = sharedState()
    current.snapshot.document!.devices[0].bindings = [{ id: 'song', kind: 'application', selector: 'native:singz' }]
    current.snapshot.document!.devices[0].routing.sources[0].id = 'song'
    const before = JSON.stringify(current)
    const commands = microphoneRouteCommands(current, 'alsa:flow8', 0, 'alsa:pa', 0) as Record<string, unknown>[]
    expect(commands).toHaveLength(2)
    expect(commands[0]).toMatchObject({ type: 'addSource', device: 'shared', id: 'microphone' })
    expect(JSON.stringify(current)).toBe(before)
  })
  it('rejects occupied different output pairs or unsupported bus layouts before sending edits', async () => {
    const { microphoneRouteCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = sharedState()
    expect(() => microphoneRouteCommands(current, 'alsa:flow8', 1, 'alsa:pa', 2)).toThrow('different channel pair')
    current.snapshot.document!.devices[0].routing.outputChannels = 4
    expect(() => microphoneRouteCommands(current, 'alsa:flow8', 1, 'alsa:pa', 0)).toThrow('unsupported bus layout')
  })
  it('bounds wide inventory channels to the native 64-channel limit', async () => {
    const { microphoneRouteCommands, routingChannelCount } = await import('../../src/renderer/src/box/routing-model')
    const current = state()
    current.inventory.devices[0].inputChannels = 128
    current.inventory.devices.push({ uid: 'alsa:wide', name: 'Wide output', inputChannels: 0, outputChannels: 128 })
    expect(routingChannelCount(128)).toBe(64)
    expect(() => microphoneRouteCommands(current, 'alsa:flow8', 64, 'alsa:wide', 0)).toThrow('input channel')
    expect(() => microphoneRouteCommands(current, 'alsa:flow8', 63, 'alsa:wide', 64)).toThrow('stereo output')
    const commands = microphoneRouteCommands(current, 'alsa:flow8', 63, 'alsa:wide', 62) as Record<string, unknown>[]
    expect(commands[1]).toMatchObject({ channels: 64 })
    expect(commands[3]).toMatchObject({ channels: 64 })
  })
})

describe('setup order and occupied output changes', () => {
  const stereoBus = (id: string, uid: string) => ({
    id, name: 'Existing mix', routing: { outputChannels: 2, sources: [] as NonNullable<BoxRoutingState['snapshot']['document']>['devices'][number]['routing']['sources'] },
    bindings: [] as { id: string; kind: string; selector: string }[],
    monitors: [{ id: 'speakers', deviceSelector: uid, channels: 2, gain: 0.4, enabled: true, muted: false, connections: [{ sourceChannel: 0, outputChannel: 0, gain: 1 }, { sourceChannel: 1, outputChannel: 1, gain: 1 }] }]
  })
  const installSourceCommands = (current: BoxRoutingState, commands: unknown[]): void => {
    for (const raw of commands) {
      const command = raw as { type: string; device: string; id: string; source: string; kind: string; selector: string; channels: number; connections: { sourceChannel: number; outputChannel: number; gain: number }[] }
      const device = current.snapshot.document!.devices.find(row => row.id === command.device)!
      if (command.type === 'addSource') {
        device.bindings.push({ id: command.id, kind: command.kind, selector: command.selector })
        device.routing.sources.push({ id: command.id, channels: command.channels, gain: 1, enabled: true, muted: false, connections: [] })
      } else if (command.type === 'setSourceWiring') device.routing.sources.find(row => row.id === command.source)!.connections = command.connections
      else throw new Error('Shared output setup attempted to change bus/physical owner')
    }
  }
  it('adds music after microphone setup with a unique source while preserving the mix name and gain', async () => {
    const current = state()
    current.inventory.devices.push({ uid: 'alsa:pa', name: 'PA', inputChannels: 0, outputChannels: 4 })
    const bus = stereoBus('mix', 'alsa:pa')
    bus.bindings.push({ id: 'song', kind: 'input-device', selector: 'alsa:flow8' })
    bus.routing.sources.push({ id: 'song', channels: 10, gain: 0.3, enabled: true, muted: false, connections: [{ sourceChannel: 0, outputChannel: 0, gain: 1 }] })
    current.snapshot.document = { devices: [bus] }
    const commands = musicRouteCommands(current, 'alsa:pa', 0) as Record<string, unknown>[]
    expect(commands[0]).toMatchObject({ type: 'addSource', device: 'mix', id: 'song-2', selector: 'native:singz' })
    installSourceCommands(current, commands)
    expect(hasSongRoute(current)).toBe(true)
    expect(bus.name).toBe('Existing mix')
    expect(bus.routing.sources[0].gain).toBe(0.3)
    expect(bus.monitors).toHaveLength(1)
  })
  it('supports song then microphone 1 then microphone 2 with one physical monitor', async () => {
    const { microphoneRouteCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = state()
    current.inventory.devices.push({ uid: 'alsa:pa', name: 'PA', inputChannels: 0, outputChannels: 2 })
    current.snapshot.document = { devices: [stereoBus('mix', 'alsa:pa')] }
    installSourceCommands(current, musicRouteCommands(current, 'alsa:pa', 0))
    installSourceCommands(current, microphoneRouteCommands(current, 'alsa:flow8', 0, 'alsa:pa', 0))
    installSourceCommands(current, microphoneRouteCommands(current, 'alsa:flow8', 1, 'alsa:pa', 0))
    const bus = current.snapshot.document.devices[0]
    expect(bus.routing.sources.map(source => source.id)).toEqual(['song', 'microphone', 'microphone-2'])
    expect(bus.monitors).toHaveLength(1)
    expect(bus.monitors[0].gain).toBe(0.4)
  })
  it('rejects incompatible shared music setup and moving its output onto a different owner', async () => {
    const { musicOutputCommands } = await import('../../src/renderer/src/box/routing-model')
    const current = state()
    current.inventory.devices.push({ uid: 'alsa:pa', name: 'PA', inputChannels: 0, outputChannels: 4 })
    current.snapshot.document = { devices: [stereoBus('mix', 'alsa:pa')] }
    expect(() => musicRouteCommands(current, 'alsa:pa', 2)).toThrow('different channel pair')
    current.snapshot.document.devices[0].routing.outputChannels = 4
    expect(() => musicRouteCommands(current, 'alsa:pa', 0)).toThrow('unsupported bus layout')
    const song = stereoBus('music', 'alsa:flow8')
    song.bindings.push({ id: 'song', kind: 'application', selector: 'native:singz' })
    current.snapshot.document.devices.push(song)
    expect(() => musicOutputCommands(current, 'alsa:pa', 0)).toThrow('already owned by another route')
  })
})
