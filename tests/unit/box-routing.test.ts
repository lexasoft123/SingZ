import { describe, expect, it, vi } from 'vitest'
import { BoxRoutingService, validRoutingState } from '../../src/main/box/routing'

const state = () => ({ version: 1, inventory: { devices: [] }, snapshot: {
  revision: { epoch: 'e', generation: '0' }, document: null,
  restoration: { phase: 'no-document', error: '', desiredGeneration: '0', activeGeneration: '0' },
  runtime: { metersFresh: false, monitors: [] }
} })
describe('trusted Box routing', () => {
  it('reconciles before canonical reads and rejects malformed nested state', async () => {
    const order: string[] = []
    const service = new BoxRoutingService(async () => { order.push('state'); return JSON.stringify(state()) }, async () => { order.push('reconcile') })
    expect((await service.snapshot()).ok).toBe(true)
    expect(order).toEqual(['reconcile', 'state'])
    const bad = state() as any
    bad.snapshot.document = { devices: [{ id: 'bad' }] }
    expect(validRoutingState(bad)).toBe(false)
    expect((await new BoxRoutingService(async () => JSON.stringify(bad)).snapshot()).ok).toBe(false)
  })
  it('preserves history faults and signed headroom without accepting nonfinite telemetry', async () => {
    const current = state() as any
    const historyRead = { valid: true, outsideBand: true, observations: '100', bandExits: '2',
      reanchors: '1', generationChanges: '0', windowObservations: '30', appendFrames: 256, headroomFrames: -4,
      minimumFrames: -4, maximumFrames: 1024, meanFrames: 500, acquisitionFrames: 1024,
      lowerBoundFrames: 512, upperBoundFrames: 1536, ratio: 1.00005, acquisitionErrorFrames: -1028 }
    current.snapshot.runtime.monitors = [{ device: 'song', monitor: 'main', sourceOnline: true,
      meter: { valid: true }, clockDomain: 'history', historyRead }]
    const result = await new BoxRoutingService(async () => JSON.stringify(current)).snapshot()
    expect(result.ok && result.value.snapshot.runtime.monitors[0].historyRead?.bandExits).toBe('2')
    expect(result.ok && result.value.snapshot.runtime.monitors[0].historyRead?.headroomFrames).toBe(-4)
    historyRead.ratio = Number.NaN
    expect(validRoutingState(current)).toBe(false)
    historyRead.ratio = 1
    current.snapshot.runtime.monitors[0].clockDomain = 'cpu-guessed'
    expect(validRoutingState(current)).toBe(false)
  })
  it('rejects stale intent and preserves exact uint64 revisions', async () => {
    const current = state(); current.snapshot.revision.generation = '18446744073709551615'
    const request = vi.fn(async () => JSON.stringify(current))
    const result = await new BoxRoutingService(request).edit({ expected: { epoch: 'e', generation: '0' }, commands: [{}] })
    expect(result.ok).toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('sends an exact revision, surfaces native rejection and never reports it applied', async () => {
    const request = vi.fn(async (json: string) => {
      const value = JSON.parse(json)
      return JSON.stringify(value.operation === 'state' ? state() : { version: 1, ok: false, code: 'bad-route', detail: 'Channel is unavailable' })
    })
    const result = await new BoxRoutingService(request).edit({ expected: { epoch: 'e', generation: '0' }, commands: [{ type: 'createDevice' }] })
    expect(result).toEqual({ ok: false, error: 'Channel is unavailable' })
    expect(JSON.parse(request.mock.calls[1][0]).request.expected).toEqual({ epoch: 'e', generation: '0' })
  })
  it('reads canonical activation after acknowledged persistence instead of manufacturing success', async () => {
    const current = state(); current.snapshot.restoration.phase = 'retry'
    const request = async (json: string) => JSON.stringify(JSON.parse(json).operation === 'state' ? current : { ok: true })
    const result = await new BoxRoutingService(request).edit({ expected: { epoch: 'e', generation: '0' }, commands: [{}] })
    expect(result.ok && result.value.snapshot.restoration.phase).toBe('retry')
  })
})
