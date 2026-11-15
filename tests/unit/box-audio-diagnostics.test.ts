import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm, readdir, lstat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { BoxCaptureTap, recordBoxCaptureTap } from '../../src/main/box-audio/capture-tap'
import { captureTapRequest } from '../../src/shared/box-audio-diagnostics'
import { boxAudioReadOnly } from '../../src/shared/box-audio'
import { startBoxAudioHost } from '../../src/main/box-audio/server'
import { createBoxAudioClient } from '../../src/main/box-audio/client'
const { startBoxHostRecorder } = createRequire(import.meta.url)('../shared/box-host-recorder.cjs')
const request = { seconds: 2, input: { uid: 'alsa:test', channel: 0 } }
const receipt = (id = '1', active = true) => ({ id, active, complete: !active, ok: !active, error: '',
  outputPath: '/data/pre-alsa.wav', inputPath: '/data/capture-input.wav', sampleRate: 48000,
  outputFrames: '96000', inputFrames: '96000', targetFrames: '96000', firstOutputHostNs: '1', firstInputHostNs: '2',
  outputDiscontinuities: '0', inputDiscontinuities: '0' })
describe('Box diagnostic capture admission', () => {
  it('requires bounded duration and one explicit zero-based input; rejects destination injection', () => {
    expect(captureTapRequest(request)).toEqual(request)
    for (const invalid of [null, {}, { ...request, path: '/tmp/x' }, { ...request, directory: '/tmp/x' },
      ...[0, -1, 30.1, NaN, Infinity, '2'].map(seconds => ({ ...request, seconds })),
      ...[-1, 64, .1, '0'].map(channel => ({ ...request, input: { uid: 'alsa:test', channel } })),
      { ...request, input: { uid: '', channel: 0 } }, { ...request, input: { uid: 'x\0', channel: 0 } }])
      expect(() => captureTapRequest(invalid)).toThrow()
    expect(captureTapRequest({ ...request, seconds: 30, input: { uid: 'alsa:test', channel: 63 } }).seconds).toBe(30)
    expect(boxAudioReadOnly('service', 'captureTap')).toBe(false)
    expect(boxAudioReadOnly('service', 'captureTapStatus')).toBe(true)
    expect(boxAudioReadOnly('service', 'audioDiagnostics')).toBe(true)
  })
  it('fences capture polling across a host restart even when its id is reused', async () => {
    vi.useFakeTimers()
    const callStamped = vi.fn().mockResolvedValueOnce({ epoch: 'old', value: receipt() })
      .mockResolvedValueOnce({ epoch: 'new', value: receipt('1', false) })
    try {
      const recording = expect(recordBoxCaptureTap({ callStamped }, request)).rejects.toThrow(/host or identity changed/)
      await vi.advanceTimersByTimeAsync(100)
      await recording
      expect(callStamped.mock.calls.map(args => args[1])).toEqual(['captureTap', 'captureTapStatus'])
    } finally { vi.useRealTimers() }
  })
  it('returns the exact completed receipt without replaying the recording command', async () => {
    vi.useFakeTimers()
    const complete = receipt('1', false)
    const callStamped = vi.fn().mockResolvedValueOnce({ epoch: 'host', value: receipt() })
      .mockResolvedValueOnce({ epoch: 'host', value: complete })
    try {
      const recording = recordBoxCaptureTap({ callStamped }, request)
      await vi.advanceTimersByTimeAsync(100)
      expect(await recording).toEqual(complete)
      expect(callStamped.mock.calls.map(args => args[1])).toEqual(['captureTap', 'captureTapStatus'])
    } finally { vi.useRealTimers() }
  })
  it.skipIf(process.platform === 'win32')('creates private host-generated destinations and retains completed identities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-diagnostic-'))
    let current = receipt('0', false)
    const start = vi.fn((json: string) => {
      const value = JSON.parse(json)
      expect(value.seconds).toBe(2); expect(value.input).toEqual(request.input)
      expect(value.directory.startsWith(join(dir, 'audio-diagnostics', 'capture-'))).toBe(true)
      current = receipt(current.id === '0' ? '1' : '2')
      return JSON.stringify(current)
    })
    const native = { boxCaptureTapStart: start, boxCaptureTapStatus: () => JSON.stringify(current), boxAudioDiagnostics: () => '{}' }
    const capture = new BoxCaptureTap(dir, () => native)
    try {
      expect((await capture.start(request)).id).toBe('1')
      expect((await lstat(join(dir, 'audio-diagnostics'))).mode & 0o077).toBe(0)
      const folders = await readdir(join(dir, 'audio-diagnostics'))
      expect((await lstat(join(dir, 'audio-diagnostics', folders[0]))).mode & 0o077).toBe(0)
      await expect(capture.start(request)).rejects.toThrow(/active/)
      current = receipt('1', false)
      expect(capture.status('1').complete).toBe(true)
      expect((await capture.start(request)).id).toBe('2')
      expect(capture.status('1').complete).toBe(true)
      expect(start).toHaveBeenCalledTimes(2)
      expect(() => capture.status('999')).toThrow(/unavailable/)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform === 'win32')('rejects a symlink diagnostic root before invoking native capture', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-diagnostic-link-'))
    const outside = await mkdtemp(join(tmpdir(), 'box-diagnostic-outside-'))
    const start = vi.fn()
    try {
      await symlink(outside, join(dir, 'audio-diagnostics'))
      const capture = new BoxCaptureTap(dir, () => ({ boxCaptureTapStart: start,
        boxCaptureTapStatus: () => JSON.stringify(receipt('0', false)), boxAudioDiagnostics: () => '{}' }))
      await expect(capture.start(request)).rejects.toThrow(/private/)
      expect(start).not.toHaveBeenCalled()
      expect(await readdir(outside)).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform === 'win32')('cleans rejected starts and serializes concurrent allocation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-diagnostic-failed-'))
    const start = vi.fn(() => { throw new Error('offline') })
    const capture = new BoxCaptureTap(dir, () => ({ boxCaptureTapStart: start,
      boxCaptureTapStatus: () => JSON.stringify(receipt('0', false)), boxAudioDiagnostics: () => '{}' }))
    try {
      const first = expect(capture.start(request)).rejects.toThrow('offline')
      await expect(capture.start(request)).rejects.toThrow(/starting/)
      await first
      expect(start).toHaveBeenCalledTimes(1)
      expect(await readdir(join(dir, 'audio-diagnostics'))).toEqual([])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it.skipIf(process.platform === 'win32')('protects capture mutations through the real host RPC and recorder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-diag-rpc-'))
    const start = vi.fn(async () => receipt())
    const status = vi.fn(() => receipt('1', false))
    const host = await startBoxAudioHost(join(dir, 'host.sock'), { owner: {}, binding: {},
      routingCapabilities: () => ({}), routingRequest: () => '{}', captureTap: start,
      captureTapStatus: status, audioDiagnostics: () => ({ servo: { selectedHz: 48000 } }), shutdown: () => {} })
    const recorder = await startBoxHostRecorder({ socketPath: join(dir, 'record.sock'), realSocketPath: join(dir, 'host.sock') })
    const client = createBoxAudioClient(recorder.socketPath)
    try {
      recorder.start()
      expect(await client.call('service', 'audioDiagnostics', [])).toEqual({ servo: { selectedHz: 48000 } })
      expect((await client.call<any>('service', 'captureTapStatus', ['1'])).complete).toBe(true)
      recorder.assertNoMutations()
      await expect(client.call('service', 'captureTap', [{ ...request, directory: '/tmp/bad' }])).rejects.toThrow(/Diagnostic|Invalid/)
      expect(start).not.toHaveBeenCalled()
      recorder.reset()
      expect((await client.call<any>('service', 'captureTap', [request])).active).toBe(true)
      expect(start).toHaveBeenCalledWith(request)
      expect(recorder.mutations).toEqual([{ target: 'service', method: 'captureTap' }])
      expect(() => recorder.assertNoMutations()).toThrow(/Protected host mutations/)
      await expect(client.call('service', 'captureTapStatus', ['0'])).rejects.toThrow(/Unknown/)
    } finally { await client.shutdown(); await recorder.close(); await host.close(); await rm(dir, { recursive: true, force: true }) }
  })
})
