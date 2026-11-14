import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  sink: undefined as undefined | ((value: unknown) => void),
  begin: vi.fn(), stop: vi.fn(), prepare: vi.fn(), unload: vi.fn(),
  binding: { inputDevices: vi.fn(() => ({ ok: true, devices: [] })),
    boxRoutingInitialize: vi.fn(() => ({ ok: true })), boxRoutingPoll: vi.fn(), boxRoutingShutdown: vi.fn() }
}))
vi.mock('../../src/main/capture', () => ({
  CaptureOwner: class {
    begin(...args: unknown[]) { fake.sink = args.at(-1) as (value: unknown) => void; fake.begin(...args); return { ok: true } }
    preparePlayback(...args: unknown[]) { return fake.prepare(...args) }
    unloadPlayback(...args: unknown[]) { return fake.unload(...args) }
    stop() { fake.stop() }
  },
  loadCaptureBinding: () => fake.binding
}))

let port: EventEmitter & { postMessage: ReturnType<typeof vi.fn> }
const originalPort = Object.getOwnPropertyDescriptor(process, 'parentPort')
const request = (id: number, method: string, args: unknown[] = [], target = 'owner', epoch = 'service-test') =>
  port.emit('message', { data: { type: 'request', epoch, id, target, method, args } })

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  fake.sink = undefined
  port = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port })
  vi.stubEnv('SINGZ_AUDIO_PROCESS', '1')
  vi.stubEnv('SINGZ_AUDIO_EPOCH', 'service-test')
  await import('../../src/main/audio-service')
})
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs()
  if (originalPort) Object.defineProperty(process, 'parentPort', originalPort)
  else Reflect.deleteProperty(process, 'parentPort')
})

describe('audio helper control dispatcher', () => {
  it('announces its own PID and refuses methods outside the explicit surface', async () => {
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready', epoch: 'service-test', pid: process.pid })
    request(1, 'constructor')
    request(2, 'inputDevices', [], 'binding', 'stale-epoch')
    await vi.advanceTimersByTimeAsync(0)
    expect(port.postMessage.mock.calls.map(([message]) => message).find(message => message.id === 1)).toMatchObject({ type: 'reply', ok: false })
    expect(fake.binding.inputDevices).not.toHaveBeenCalled()
  })

  it('coalesces capture telemetry behind an acknowledgement while control replies continue', async () => {
    request(1, 'begin', [7, { inputChannel: 0 }, '9', 33])
    await vi.advanceTimersByTimeAsync(0)
    const frame = (frequency: number) => ({ ownershipGeneration: '9', frequency, clarity: 1, rms: 0, dbfs: -120 })
    fake.sink!(frame(110)); fake.sink!(frame(220))
    await vi.advanceTimersByTimeAsync(40)
    let telemetry = port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'capture')
    expect(telemetry).toHaveLength(1)
    expect(telemetry[0]).toMatchObject({ key: 33, value: { frequency: 220 } })
    fake.sink!(frame(330)); fake.sink!(frame(440))
    await vi.advanceTimersByTimeAsync(400)
    expect(port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'capture')).toHaveLength(1)
    request(2, 'inputDevices', [], 'binding')
    await vi.advanceTimersByTimeAsync(0)
    expect(port.postMessage.mock.calls.map(([message]) => message).find(message => message.id === 2)).toMatchObject({ ok: true })
    port.emit('message', { data: { type: 'capture-ack', epoch: 'service-test' } })
    await vi.advanceTimersByTimeAsync(40)
    telemetry = port.postMessage.mock.calls.map(([message]) => message).filter(message => message.type === 'capture')
    expect(telemetry).toHaveLength(2)
    expect(telemetry[1]).toMatchObject({ key: 33, value: { frequency: 440 } })
  })

  it('honors export cancellation received before the export starts opening files', async () => {
    request(1, 'cancelAudioExport', ['cancelled-job'], 'binding')
    request(2, 'paths', [['/never-open-source.wav'], '/never-create-output.wav', 'wav', 'cancelled-job'], 'export')
    await vi.advanceTimersByTimeAsync(0)
    const reply = port.postMessage.mock.calls.map(([message]) => message).find(message => message.id === 2)
    expect(reply).toMatchObject({ ok: true, value: { ok: false, error: 'Export cancelled' } })
  })

  it('dispatches cancellation while native prepare has not completed', async () => {
    let finish!: (value: unknown) => void
    fake.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fake.unload.mockReturnValueOnce({ ok: true, cleanupComplete: true })
    request(1, 'preparePlayback', [7, {}, []])
    request(2, 'unloadPlayback', [7, '9'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.unload).toHaveBeenCalledWith(7, '9')
    expect(port.postMessage.mock.calls.map(([message]) => message).find(message => message.id === 2)).toMatchObject({ ok: true, value: { cleanupComplete: true } })
    expect(port.postMessage.mock.calls.map(([message]) => message).find(message => message.id === 1)).toBeUndefined()
    finish({ ok: false, error: 'cancelled' })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.postMessage.mock.calls.map(([message]) => message).find(message => message.id === 1)).toMatchObject({ ok: true, value: { ok: false } })
  })
})

it('initializes and polls routing only for local Box and shuts it down after the capture owner', async () => {
  vi.resetModules(); vi.stubEnv('SINGZ_SURFACE', 'box'); vi.stubEnv('SINGZ_AUDIO_BOX_DATA_DIR', '/fake/box-profile')
  port.removeAllListeners('message')
  vi.clearAllTimers()
  await import('../../src/main/audio-service')
  request(1, 'inputDevices', [], 'binding')
  await vi.advanceTimersByTimeAsync(0)
  expect(fake.binding.boxRoutingInitialize).toHaveBeenCalledWith(join('/fake/box-profile', 'routing.json'))
  await vi.advanceTimersByTimeAsync(100)
  expect(fake.binding.boxRoutingPoll).toHaveBeenCalledTimes(4)
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  port.emit('message', { data: { type: 'shutdown', epoch: 'service-test' } })
  expect(fake.stop.mock.invocationCallOrder[0]).toBeLessThan(fake.binding.boxRoutingShutdown.mock.invocationCallOrder[0])
  expect(vi.getTimerCount()).toBe(0)
  exit.mockRestore()
})
