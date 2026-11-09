import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoxCecService, boxCecEnabled } from '../../src/main/box/cec'
import { RemoteKeyGate } from '../../src/renderer/src/box/remote'

class Child extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => { this.emit('close', 0); return true })
  frame(value: unknown): void { this.stdout.write(JSON.stringify(value) + '\n') }
  ready(): void { this.frame({ type: 'status', state: 'ready', detail: 'CEC connected.' }) }
  key(code: number, pressed = true): void { this.frame({ type: 'key', code, pressed }) }
}
const services: BoxCecService[] = []
function fixture(ready = true) {
  const children: Child[] = []
  const spawnChild = vi.fn(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcess })
  const service = new BoxCecService({ enabled: true, helperPath: '/trusted/cec-input.py', spawnChild: spawnChild as unknown as typeof spawn, retryMs: 50, releaseMs: 100 })
  services.push(service)
  const send = vi.fn()
  const sink = { ready: () => ready, send }
  service.attach(sink); service.start()
  return { service, children, spawnChild, send, sink, child: children[0] }
}
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); vi.useRealTimers() })

describe('Box HDMI-CEC input', () => {
  it('reconstructs bounded helper telemetry and counts delivery independently of readiness', () => {
    const f = fixture(false); f.child.ready()
    const report = { type: 'telemetry', received: 5, acceptedPress: 1, acceptedRelease: 1,
      rejectedFormat: 1, rejectedInitiator: 1, rejectedDestination: 1,
      physicalAddress: 4096, logicalAddressMask: 16, powerReplyQueued: 2, powerReplyCompleted: 1, lastPowerReplyTxStatus: 1,
      lastRx: { initiator: 5, destination: 4, opcode: 68, length: 3, rxStatus: 1 },
      lastStateChange: { physicalAddress: 4096, logicalAddressMask: 16 }, secret: 'not exposed' }
    f.child.frame(report)
    const diagnostics = f.service.snapshot().diagnostics!
    expect(diagnostics.helper).toMatchObject({ received: 5, rejectedInitiator: 1, powerReplyQueued: 2, powerReplyCompleted: 1, lastPowerReplyTxStatus: 1 })
    expect(diagnostics.helperReceivedAt).toBeGreaterThan(0)
    expect(JSON.stringify(diagnostics)).not.toContain('secret')
    diagnostics.helper!.received = 999
    expect(f.service.snapshot().diagnostics!.helper!.received).toBe(5)
    f.child.key(0); f.child.key(0)
    expect(f.service.snapshot().diagnostics).toMatchObject({ notReadyPresses: 1, blockedPresses: 1, deliveredEvents: 0 })
    f.child.key(0, false)
    f.sink.ready = () => true
    f.child.key(0); f.child.key(0, false)
    expect(f.service.snapshot().diagnostics!.deliveredEvents).toBe(2)
  })
  it.each([-1, 2147483648, 1.5, '1', null])('rejects invalid telemetry counter %j', received => {
    const f = fixture(); f.child.ready()
    f.child.frame({ type: 'telemetry', received, acceptedPress: 0, acceptedRelease: 0,
      rejectedFormat: 0, rejectedInitiator: 0, rejectedDestination: 0, physicalAddress: 4096, logicalAddressMask: 16 })
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(f.service.snapshot().state).toBe('error')
  })
  it('rejects out-of-range frame metadata', () => {
    const f = fixture(); f.child.ready()
    f.child.frame({ type: 'telemetry', received: 1, acceptedPress: 0, acceptedRelease: 0,
      rejectedFormat: 0, rejectedInitiator: 0, rejectedDestination: 0, physicalAddress: 4096, logicalAddressMask: 16,
      lastRx: { initiator: 16, destination: 4, opcode: 68, length: 3, rxStatus: 1 } })
    expect(f.service.snapshot().state).toBe('error')
  })
  it('starts only for visible Linux Box, never Desktop/headless tests or opt-out', () => {
    expect(boxCecEnabled('linux', 'box', {})).toBe(true)
    for (const [platform, surface, env] of [
      ['darwin', 'box', {}], ['linux', 'desktop', {}], ['linux', 'box', { SINGZ_BOX_CEC: '0' }],
      ['linux', 'box', { SINGZ_E2E_HIDDEN: '1' }]
    ] as const) expect(boxCecEnabled(platform, surface, env)).toBe(false)
    const spawnChild = vi.fn()
    const service = new BoxCecService({ enabled: false, helperPath: '/helper', spawnChild })
    services.push(service); service.start(); expect(spawnChild).not.toHaveBeenCalled()
  })
  it('uses one fixed interpreter/helper with validated adapter and no shell', () => {
    const f = fixture(); f.service.start()
    expect(f.spawnChild).toHaveBeenCalledTimes(1)
    expect(f.spawnChild.mock.calls[0]).toEqual(['python3', ['-u', '/trusted/cec-input.py'], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })])
    const spawnChild = vi.fn()
    const service = new BoxCecService({ enabled: true, helperPath: '/helper', device: '/dev/cec0;whoami', spawnChild })
    services.push(service); service.start(); expect(spawnChild).not.toHaveBeenCalled(); expect(service.snapshot().state).toBe('error')
  })
  it('decodes split JSON lines, maps remote buttons and marks held-key repeats', () => {
    const f = fixture(); f.child.stdout.write('{"type":"status","state":"ready",');f.child.stdout.write('"detail":"Connected"}\n')
    f.child.key(1); f.child.key(1); f.child.key(1, false)
    expect(f.send.mock.calls.map(([event]) => event)).toEqual([
      { type: 'keyDown', keyCode: 'Up', modifiers: [] }, { type: 'keyDown', keyCode: 'Up', modifiers: ['isautorepeat'] },
      { type: 'keyUp', keyCode: 'Up', modifiers: [] }
    ])
    f.child.key(0x40); f.child.key(0x41); f.child.key(0x45)
    expect(f.send).toHaveBeenCalledTimes(3) // power/TV volume/Stop stay outside app
  })
  it('measures kernel receive to main with the monotonic clock, without delaying keys', () => {
    const child = new Child()
    const service = new BoxCecService({ enabled: true, helperPath: '/helper',
      spawnChild: vi.fn(() => child) as unknown as typeof spawn,
      now: () => 1234, monotonicNowNs: () => 2_000_000_000n })
    services.push(service)
    const send = vi.fn(); service.attach({ ready: () => true, send }); service.start(); child.ready()
    child.frame({ type: 'key', code: 1, pressed: true, receivedAtNs: '1996500000' })
    expect(service.snapshot()).toMatchObject({ lastReceiveToMainMs: 3.5, lastPressAt: 1234 })
    expect(send).toHaveBeenCalledTimes(1)
    for (const stamp of ['2000000001', '-1', 'garbage', '9'.repeat(100)]) {
      child.frame({ type: 'key', code: 1, pressed: true, receivedAtNs: stamp })
      expect(service.snapshot().lastReceiveToMainMs).toBe(3.5)
    }
    expect(send).toHaveBeenCalledTimes(5)
    expect(service.snapshot().state).toBe('ready')
  })
  it('preserves wake-only and repeat behavior through the existing renderer gate', () => {
    const f = fixture(); const gate = new RemoteKeyGate();let visible = false;let actions = 0
    f.service.attach({ ready: () => true, send: event => {
      const key = event.keyCode === 'Return' ? 'Enter' : event.keyCode
      if (event.type === 'keyUp') gate.keyUp(key)
      else { const result = gate.keyDown(key, event.modifiers?.includes('isautorepeat') ?? false, !visible); if (result.wake) visible = true; if (result.allowAction) actions++ }
    } })
    f.child.ready();f.child.key(0);f.child.key(0);expect(visible).toBe(true);expect(actions).toBe(0)
    f.child.key(0, false);f.child.key(0);expect(actions).toBe(1)
  })
  it('drops input while loading/unfocused and never queues it for a later target', () => {
    const f = fixture(false);f.child.ready();f.child.key(0);f.service.attach({ ready: () => true, send: f.send })
    f.child.key(0);expect(f.send).not.toHaveBeenCalled();f.child.key(0, false);f.child.key(0);expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('releases on focus loss, swallows held repeats, and permits the next distinct press', () => {
    const f = fixture();f.child.ready();f.child.key(1);f.service.releaseKeys();f.child.key(1)
    expect(f.send.mock.calls.map(([v]) => v.type)).toEqual(['keyDown', 'keyUp'])
    f.child.key(1, false);f.child.key(1);expect(f.send).toHaveBeenCalledTimes(3)
  })
  it('recovers a lost release without making a delayed held wake press act', async () => {
    vi.useFakeTimers();const f = fixture();f.child.ready();f.child.key(0)
    await vi.advanceTimersByTimeAsync(101);f.child.key(0)
    expect(f.send.mock.calls.map(([v]) => v.type)).toEqual(['keyDown', 'keyUp'])
    f.child.key(0, false);f.child.key(0);expect(f.send).toHaveBeenCalledTimes(3)
  })
  it('re-enables a key after quiet time on TVs that never send User Control Released', async () => {
    vi.useFakeTimers();const f = fixture();f.child.ready();f.child.key(0)
    await vi.advanceTimersByTimeAsync(101);f.child.key(0) // delayed held repeat stays swallowed
    await vi.advanceTimersByTimeAsync(2000);f.child.key(0) // repeats keep the chord blocked
    expect(f.send.mock.calls.map(([v]) => v.type)).toEqual(['keyDown', 'keyUp'])
    await vi.advanceTimersByTimeAsync(2600);f.child.key(0) // no release ever arrived
    expect(f.send.mock.calls.map(([v]) => [v.type, v.modifiers])).toEqual([['keyDown', []], ['keyUp', []], ['keyDown', []]])
  })
  it('decodes multibyte UTF-8 split across pipe chunks', () => {
    const f = fixture()
    const bytes = Buffer.from(JSON.stringify({ type: 'status', state: 'ready', detail: 'Подключено 接続' }) + '\n')
    const split = bytes.indexOf(Buffer.from('П')) + 1 // inside the two-byte sequence
    f.child.stdout.write(bytes.subarray(0, split)); f.child.stdout.write(bytes.subarray(split))
    expect(f.service.snapshot()).toMatchObject({ state: 'ready', detail: 'Подключено 接続' })
  })
  it('backs off reconnects exponentially to a cap and resets after a healthy run', async () => {
    vi.useFakeTimers()
    const children: Child[] = []
    const spawnChild = vi.fn(() => { const child = new Child(); children.push(child); return child as unknown as ChildProcess })
    const service = new BoxCecService({ enabled: true, helperPath: '/helper', spawnChild: spawnChild as unknown as typeof spawn,
      retryMs: 100, retryMaxMs: 400, healthyRunMs: 1000 })
    services.push(service); service.start()
    const delays: number[] = []
    const failAndMeasure = async (): Promise<void> => {
      const count = children.length
      children[count - 1].emit('close', 1)
      let waited = 0
      while (children.length === count) { await vi.advanceTimersByTimeAsync(10); waited += 10 }
      delays.push(waited)
    }
    for (let i = 0; i < 4; i++) await failAndMeasure()
    expect(delays).toEqual([100, 200, 400, 400])
    children.at(-1)!.ready()
    await vi.advanceTimersByTimeAsync(1000)
    await failAndMeasure()
    expect(delays.at(-1)).toBe(100)
  })
  it('reconnects without stale frame replay or a held key becoming a fresh action', async () => {
    vi.useFakeTimers();const f = fixture();f.child.ready();f.child.key(0);f.child.emit('close', 1)
    await vi.advanceTimersByTimeAsync(51);const next = f.children[1];next.ready();f.child.key(2);next.key(0)
    expect(f.send).toHaveBeenCalledTimes(2);next.key(0, false);next.key(0);expect(f.send).toHaveBeenCalledTimes(3)
  })
  it('fails closed on oversized/invalid child output and sanitizes diagnostics', () => {
    const f = fixture();f.child.ready();f.child.key(0);f.child.stdout.write('x'.repeat(2049))
    expect(f.child.kill).toHaveBeenCalledWith('SIGTERM');expect(f.service.snapshot().state).toBe('error');expect(f.service.snapshot().detail).not.toContain('xxx')
  })
  it('reports actual unavailable status and disposes idempotently without reconnect', async () => {
    vi.useFakeTimers();const f = fixture();f.child.frame({ type: 'status', state: 'unavailable', detail: 'No HDMI output CEC adapter.' });f.child.emit('close',2)
    expect(f.service.snapshot().state).toBe('unavailable');await f.service.dispose();await f.service.dispose();await vi.advanceTimersByTimeAsync(1000)
    expect(f.children).toHaveLength(1);f.child.key(0);expect(f.send).not.toHaveBeenCalled()
  })
})
