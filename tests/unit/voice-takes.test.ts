import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceTakeStore, type VoiceTakeNative } from '../../src/main/voice-takes'
import { createVoiceTakeNative } from '../../src/main/voice-takes-ipc'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const wav = (sampleRate = 22050, frames = sampleRate, declaredBytes = frames * 2): Buffer => { const b = Buffer.alloc(44 + frames * 2); b.write('RIFF', 0); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(sampleRate, 24); b.write('data', 36); b.writeUInt32LE(declaredBytes, 40); return b }

const fakeNative = (finish: Partial<Awaited<ReturnType<VoiceTakeNative['finishTake']>>> = {}, placement: Partial<Awaited<ReturnType<VoiceTakeNative['presentationQuery']>>> = {}): VoiceTakeNative => ({
  armCapture: async () => ({ ok: true, generation: 1n, deviceName: 'Mic' }), disarmCapture: async () => ({ ok: true }),
  recordTake: async ({ dir, takeId }) => { const path = join(dir, `${takeId}.wav`); mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, wav(44100, 44100)); return { ok: true } },
  finishTake: async () => ({ ok: true, frames: 44100, sampleRate: 44100, firstSampleQuality: 'hardware' as const, firstSampleHostNs: '123', ...finish }),
  cancelTake: async () => ({ ok: true }),
  presentationQuery: async () => ({ ok: true, startPositionSec: 12, inputLatencyFrames: 1, outputLatencyFrames: 2, graphLatencyFrames: 3, latencySource: 'measured-trim' as const, ...placement }),
  captureStats: async () => ({ firstSampleCaptured: true, firstSampleHostNs: '1000000000', lastSampleHostNs: '1000000000', firstSampleQuality: 'hardware' as const, sampleRate: 44100, inputLevel: { peakDb: -20, rmsDb: -30 } }),
  playTake: async () => ({ ok: true }), stopTake: async () => ({ ok: true }), level: async () => ({ peakDb: -20, rmsDb: -30 })
})

const request = { songId: 'song-1', songTitle: 'Song', songArtist: 'Artist', input: { deviceName: 'Mic', channelIndex: 0 }, tempo: 1, transposeSemitones: 0 }
const store = (root: string, now = new Date()) => new VoiceTakeStore({ rootDir: root, native: fakeNative(), now: () => now })

describe('voice take storage', () => {
  it('writes a complete sidecar atomically after finishing, including settings timeline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    let now = new Date('2026-01-01T00:00:00.000Z')
    const s = new VoiceTakeStore({ rootDir: root, native: fakeNative(), now: () => now, placementQuery: fakeNative().presentationQuery })
    const started = await s.start(request); expect(started.ok).toBe(true)
    now = new Date('2026-01-01T00:00:01.000Z')
    await s.settings({ takeId: started.ok ? started.takeId : '', tempo: 0.9, transposeSemitones: 2 })
    const stopped = await s.stop(); expect(stopped.ok).toBe(true)
    const files = readdirSync(join(root, 'song-1')); expect(files).toHaveLength(2)
    const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${started.ok ? started.takeId : ''}.json`), 'utf8'))
    expect(sidecar.settings).toHaveLength(2); expect(sidecar.startPositionSec).toBe(12); expect(sidecar.status).toBe('complete')
    expect(files.some(file => file.endsWith('.tmp'))).toBe(false)
  })

  it('rejects a second active recording as busy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); const s = store(root)
    expect((await s.start(request)).ok).toBe(true)
    expect(await s.start(request)).toMatchObject({ ok: false, reason: 'busy' })
  })

  it('recovers a wav without a sidecar and computes its duration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    mkdirSync(join(root, 'song-1')); writeFileSync(join(root, 'song-1', 'take-1.wav'), wav(22050, 22050))
    const list = await store(root).list('song-1'); expect(list[0]).toMatchObject({ takeId: 'take-1', status: 'recovered' }); expect(list[0]?.durationSec).toBeCloseTo(1, 3)
    expect(existsSync(join(root, 'song-1', 'take-1.json'))).toBe(true)
  })

  it('recovers zero, oversized, and patched WAV data lengths safely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); mkdirSync(join(root, 'song-1'))
    writeFileSync(join(root, 'song-1', 'zero.wav'), wav(22050, 22050, 0))
    writeFileSync(join(root, 'song-1', 'oversized.wav'), wav(22050, 22050, 999999999))
    writeFileSync(join(root, 'song-1', 'patched.wav'), wav(22050, 22050, 22050))
    const list = await store(root).list('song-1')
    expect(list.find(t => t.takeId === 'zero')?.durationSec).toBeCloseTo(1, 3)
    expect(list.find(t => t.takeId === 'oversized')?.durationSec).toBeCloseTo(1, 3)
    expect(list.find(t => t.takeId === 'patched')?.durationSec).toBeCloseTo(0.5, 3)
  })

  it('keeps unknown sidecar versions and does not overwrite them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); mkdirSync(join(root, 'song-1'))
    const path = join(root, 'song-1', 'new.json'); const unknown = JSON.stringify({ version: 99, takeId: 'new' }); writeFileSync(path, unknown)
    await store(root).list('song-1'); expect(readFileSync(path, 'utf8')).toBe(unknown)
    // Deliberate negative control: a recovery implementation that rewrote every json file would fail this assertion.
  })

  it('deletes only the selected take files and never uses a project stems path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); const s = store(root)
    const first = await s.start(request); await s.stop(); const second = await s.start(request); await s.stop()
    await s.remove('song-1', first.ok ? first.takeId : '')
    const files = readdirSync(join(root, 'song-1')); expect(files).toHaveLength(2)
    expect(files.join(',')).toContain(second.ok ? second.takeId : ''); expect(root).not.toContain('/stems/')
  })

  it('rejects traversal ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); const s = store(root)
    expect(await s.list('../outside')).toEqual([])
    expect(await s.remove('../outside', 'take')).toMatchObject({ ok: false })
  })

  it('preserves a partial file when native finish reports device loss', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const native = fakeNative({ ok: false, deviceLost: true, reason: 'device-lost', error: 'input disconnected' })
    const s = new VoiceTakeStore({ rootDir: root, native })
    const started = await s.start(request); expect(started.ok).toBe(true)
    const stopped = await s.stop(); expect(stopped.ok).toBe(true)
    const takeId = started.ok ? started.takeId : ''
    expect(readFileSync(join(root, 'song-1', `${takeId}.wav`)).byteLength).toBeGreaterThan(44)
    expect(JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8')).status).toBe('partial-device-lost')
    // Deliberate negative control: calling cancelTake on deviceLost would remove the WAV and fail this assertion.
  })

  it('surfaces late placement history misses without garbage timing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const s = new VoiceTakeStore({ rootDir: root, native: fakeNative({}, { found: false }) })
    const started = await s.start(request); expect(started.ok).toBe(true)
    const stopped = await s.stop(); expect(stopped.ok).toBe(true)
    const takeId = started.ok ? started.takeId : ''
    const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8'))
    expect(sidecar.status).toBe('partial-error'); expect(sidecar.latencySource).toBe('measured-trim'); expect(Number.isFinite(sidecar.startPositionSec)).toBe(true)
  })

  it('plays with-song using the sidecar start position and recorded tempo, and surfaces native errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    let playArgs: Record<string, unknown> | undefined
    const native = fakeNative()
    native.playTake = async args => { playArgs = args as unknown as Record<string, unknown>; return { ok: true } }
    const s = new VoiceTakeStore({ rootDir: root, native })
    const started = await s.start({ ...request, tempo: 0.87 }); await s.stop()
    expect(await s.play({ takeId: started.ok ? started.takeId : '', mode: 'with-song', gain: 99 })).toMatchObject({ ok: true })
    expect(playArgs).toMatchObject({ mode: 'with-song', startPositionSec: 12, tempo: 0.87, gain: 8 })
    native.playTake = async () => ({ ok: false, error: 'playback unavailable' })
    expect(await s.play({ takeId: started.ok ? started.takeId : '', mode: 'take' })).toMatchObject({ ok: false, error: 'playback unavailable' })
    expect(await s.stopPlay()).toMatchObject({ ok: true })
  })

  it('writes a provisional sidecar after placement and recovers its placement after a crash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const first = new VoiceTakeStore({ rootDir: root, native: fakeNative() }); const started = await first.start({ ...request, tempo: 0.82 }); expect(started.ok).toBe(true)
    const takeId = started.ok ? started.takeId : ''
    const provisional = JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8'))
    expect(provisional).toMatchObject({ status: 'recovered', startPositionSec: 12, durationSec: 0, songTitle: 'Song', songArtist: 'Artist' })
    const recovered = await new VoiceTakeStore({ rootDir: root, native: fakeNative() }).list('song-1')
    expect(recovered[0]).toMatchObject({ takeId, startPositionSec: 12, durationSec: 1, tempo: 0.82, status: 'recovered' })
  })

  it('does not refresh the active provisional sidecar while listing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const s = new VoiceTakeStore({ rootDir: root, native: fakeNative() }); const started = await s.start(request); expect(started.ok).toBe(true)
    const takeId = started.ok ? started.takeId : ''
    await s.list('song-1')
    const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8'))
    expect(sidecar.status).toBe('recovered'); expect(sidecar.durationSec).toBe(0)
  })

  it('does raw then latency-trimmed placement from real-shaped capture stats and makes stop idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const native = fakeNative(); const calls: Array<Record<string, unknown>> = []
    native.presentationQuery = async args => { calls.push(args as unknown as Record<string, unknown>); return { ok: true, found: true, startPositionSec: 4, outputLatencyFrames: 20, graphLatencyFrames: 10, discontinuitySerial: 7, latencySource: 'reported' as const } }
    const s = new VoiceTakeStore({ rootDir: root, native }); const started = await s.start(request); expect(started.ok).toBe(true)
    expect(calls).toHaveLength(2); expect(calls[0]?.outputLatencyFrames).toBeUndefined(); expect(calls[1]?.outputLatencyFrames).toBe(20)
    const first = await s.stop(); expect(first.ok).toBe(true); expect(await s.stop()).toEqual(first)
  })

  it('does not let a seek note erase a partial-device-lost status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const s = new VoiceTakeStore({ rootDir: root, native: fakeNative({ ok: false, deviceLost: true }) }); const started = await s.start(request); expect(started.ok).toBe(true)
    const result = await s.stop('device-lost', 'seek'); expect(result.take?.status).toBe('partial-device-lost')
  })

  it('marks latency measured-trim when capture stats expose no input latency', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const s = new VoiceTakeStore({ rootDir: root, native: fakeNative() }); const started = await s.start(request); expect(started.ok).toBe(true)
    await s.stop(); const takeId = started.ok ? started.takeId : ''
    const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8'))
    expect(sidecar.latencySource).toBe('measured-trim')
  })

  it('rejects concurrent record starts while waiting for the first sample', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const native = fakeNative(); let ready = false
    native.captureStats = async () => ready ? { firstSampleCaptured: true, firstSampleHostNs: '1000', lastSampleHostNs: '1000', sampleRate: 44100, firstSampleQuality: 'hardware' as const } : { firstSampleCaptured: false, sampleRate: 44100 }
    const first = new VoiceTakeStore({ rootDir: root, native }); const pending = first.start(request)
    await new Promise(resolve => setTimeout(resolve, 10)); expect(await first.start(request)).toMatchObject({ ok: false, reason: 'busy' })
    ready = true; expect((await pending).ok).toBe(true); await first.cancel()
  })

  it('clears a prior finalized take when the next take is cancelled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); const s = store(root)
    expect((await s.start(request)).ok).toBe(true); await s.stop(); expect((await s.start(request)).ok).toBe(true); await s.cancel()
    expect(await s.stop()).toMatchObject({ ok: false, reason: 'error' })
  })

  it('clears a prior finalized take when a new start fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); const native = fakeNative(); const s = new VoiceTakeStore({ rootDir: root, native })
    expect((await s.start(request)).ok).toBe(true); await s.stop()
    native.recordTake = async () => ({ ok: false, error: 'input unavailable' })
    expect((await s.start(request)).ok).toBe(false)
    expect(await s.stop()).toMatchObject({ ok: false, reason: 'error' })
  })

  it.each([.25, .5, 1, 2])('waits for audible placement before writing an armed stopped-song take at %sx', async tempo => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const origin = 10_000_000_000n
    const graphFrames = tempo === 1 ? 0 : 7200
    const outputFrames = 480
    const delay = BigInt((graphFrames + outputFrames) * 1e9 / 48000)
    let elapsed = 0n, first = 0n, generation = 0n, writerStarted = false, probes = 0
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic', label: 'Mic', channels: 1, isDefault: true }] } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; return { ok: true } as T }
      if (method === 'captureState') return { state: 'running', ownershipGeneration: generation.toString() } as T
      if (method === 'captureStats') return { lastSampleHostNs: (origin + elapsed).toString(), firstSampleCaptured: writerStarted,
        firstSampleHostNs: first.toString(), firstSampleQuality: 'hardware', sampleRate: 48000 } as T
      if (method === 'presentationQuery') {
        probes++
        const at = BigInt(args[0] as string)
        return { found: at >= origin, paused: at === origin, songSeconds: 12 + Number(at - origin) / 1e9 * tempo,
          outputLatencyFrames: outputFrames, graphLatencyFrames: graphFrames, sampleRate: 48000 } as T
      }
      if (method === 'recordTake') {
        writerStarted = true; first = origin + elapsed
        writeFileSync(join(args[0] as string, `${args[1]}.wav`), wav(48000, 48000))
        return { ok: true } as T
      }
      if (method === 'finishTake') return { ok: true, frames: 48000 * 300, sampleRate: 48000 } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const s = new VoiceTakeStore({ rootDir: root, native })
    try {
      expect((await s.arm({ input: request.input })).ok).toBe(true)
      // Negative control: the old adapter called recordTake immediately after
      // openCapture. Reproduce its complete store result, including the sidecar.
      const legacy = new VoiceTakeStore({ rootDir: root, native: { ...native,
        recordTake: args => rpc.call('binding', 'recordTake', [args.dir, args.takeId, generation]) } })
      elapsed = 5_000_000n // raw coverage exists; latency-trimmed coverage does not
      expect((await legacy.start({ ...request, tempo })).ok).toBe(true)
      expect((await legacy.stop()).take).toMatchObject({ status: 'partial-error', startPositionSec: 0 })
      writerStarted = false; first = 0n; probes = 0; elapsed = 0n
      const pending = s.start({ ...request, tempo })
      // Force Play-adopted but still parked: an already-armed mic has a sample
      // immediately. Then force the graph-latency history miss before readiness.
      await vi.waitFor(() => expect(probes).toBeGreaterThan(0))
      expect(writerStarted).toBe(false)
      elapsed = 5_000_000n
      await vi.advanceTimersByTimeAsync(25)
      expect(writerStarted).toBe(false)
      elapsed = delay + 10_000_000n
      await vi.advanceTimersByTimeAsync(25)
      expect((await pending).ok).toBe(true)
      expect(writerStarted).toBe(true)
      const done = await s.stop()
      expect(done.take).toMatchObject({ status: 'complete', durationSec: 300 })
      expect(done.take?.startPositionSec).toBeCloseTo(12 + .01 * tempo, 8)
      // Old immediate writer froze first=origin, and stop returned partial-error/start=0.
      expect(first).toBeGreaterThan(origin + delay)
    } finally { await s.cancel(); vi.useRealTimers() }
  })

  it.each([false, true])('times out before creating a take and retains only explicitly armed capture (%s)', async armed => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    let generation = 0n, probes = 0, writes = 0, closes = 0
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic', label: 'Mic', channels: 1, isDefault: true }] } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; return { ok: true } as T }
      if (method === 'captureState') return { state: 'running', ownershipGeneration: generation.toString() } as T
      if (method === 'captureStats') { probes++; return { lastSampleHostNs: '1000000000', sampleRate: 48000 } as T }
      if (method === 'presentationQuery') return { found: false } as T
      if (method === 'recordTake') writes++
      if (method === 'cancelCapture') closes++
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const s = new VoiceTakeStore({ rootDir: root, native })
    try {
      if (armed) await s.arm({ input: request.input })
      const pending = s.start(request)
      await vi.waitFor(() => expect(probes).toBeGreaterThan(0))
      await vi.advanceTimersByTimeAsync(2100)
      expect(await pending).toMatchObject({ ok: false, reason: 'error' })
      expect(writes).toBe(0)
      expect(closes).toBe(armed ? 0 : 1)
      expect(readdirSync(join(root, request.songId))).toEqual([])
    } finally { await s.disarm(); vi.useRealTimers() }
  })

  it('wires the real-shaped audio-process stats into placement instead of silently defaulting to zero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const calls: Array<{ method: string; args: unknown[] }> = []
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      calls.push({ method, args })
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic-uid', label: 'MacBook Pro Microphone', isDefault: true, sampleRate: 48000, channels: 1, channelLabels: ['Mono'] }] } as T
      if (method === 'beginCapture') return { ok: true } as T
      if (method === 'recordTake') { const dir = args[0] as string; const id = args[1] as string; writeFileSync(join(dir, `${id}.wav`), wav(48000, 48000)); return { ok: true } as T }
      if (method === 'captureStats') return { firstSampleCaptured: true, firstSampleHostNs: '1000000000', lastSampleHostNs: '1000000000', firstSampleQuality: 'hardware', sampleRate: 48000, inputLevel: { peakDb: -20, rmsDb: -30 } } as T
      if (method === 'presentationQuery') return { found: true, songSeconds: 7, sampleRate: 48000, outputLatencyFrames: 480, graphLatencyFrames: 240, discontinuitySerial: 3 } as T
      if (method === 'finishTake') return { ok: true, frames: 48000, sampleRate: 48000 } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const s = new VoiceTakeStore({ rootDir: root, native }); const started = await s.start({ ...request, input: { ...request.input, deviceName: '' } }); expect(started.ok).toBe(true); await s.stop()
    const takeId = started.ok ? started.takeId : ''; const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8'))
    expect(sidecar.startPositionSec).toBe(7); expect(sidecar.outputLatencyFrames).toBe(480); expect(sidecar.graphLatencyFrames).toBe(240)
    expect(sidecar.input.deviceName).toBe('MacBook Pro Microphone')
    expect(calls.filter(call => call.method === 'captureStats').length).toBeGreaterThan(0)
  })

  it('matches decorated device labels and rejects an explicit missing device', async () => {
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic-uid', label: 'MacBook Pro Microphone', isDefault: true, sampleRate: 48000, channels: 1, channelLabels: ['Mono'] }] } as T
      if (method === 'beginCapture') return { ok: true } as T
      if (method === 'captureStats') return { lastSampleHostNs: '1000000000', sampleRate: 48000 } as T
      if (method === 'presentationQuery') return { found: true, songSeconds: 12, sampleRate: 48000 } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const matched = await native.recordTake({ dir: '/tmp', takeId: 'decorated', generation: 2n, deviceName: 'MacBook Pro Microphone (Built-in)', channelIndex: 0 })
    expect(matched.ok).toBe(true); expect(matched.deviceName).toBe('MacBook Pro Microphone')
    await native.disarmCapture(2n)
    const missing = await native.recordTake({ dir: '/tmp', takeId: 'missing', generation: 3n, deviceName: 'Other microphone', channelIndex: 0 })
    expect(missing).toMatchObject({ ok: false, reason: 'no-input' })
  })

  it('rejects invalid capture channels for arm and record without clamping', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    let channels = 2
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      calls.push({ method, args })
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic', label: 'Mic', isDefault: true, sampleRate: 48000, channels, channelLabels: ['1', '2'] }] } as T
      if (method === 'captureStats') return { lastSampleHostNs: '1000000000', sampleRate: 48000 } as T
      if (method === 'presentationQuery') return { found: true, songSeconds: 12, sampleRate: 48000 } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const s = new VoiceTakeStore({ rootDir: root, native })
    for (const channelIndex of [-1, 0.5, 2, 100]) {
      const input = { deviceName: 'Mic', channelIndex }
      expect(await s.arm({ input })).toMatchObject({ ok: false, reason: 'no-input' })
      expect(await s.start({ ...request, input })).toMatchObject({ ok: false, reason: 'no-input' })
    }
    expect(calls.filter(c => c.method === 'beginCapture' || c.method === 'recordTake')).toHaveLength(0)
    expect(await s.arm({ input: { deviceName: 'Mic', channelIndex: 1 } })).toMatchObject({ ok: true })
    expect(calls.find(c => c.method === 'beginCapture')?.args[0]).toMatchObject({ inputChannel: 1 })
    channels = 1
    expect(await s.arm({ input: { deviceName: 'Mic', channelIndex: 1 } })).toMatchObject({ ok: false, reason: 'no-input' })
    await s.disarm()
    channels = 2
    const second = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    expect(await second.recordTake({ dir: root, takeId: 'valid', generation: 99n, deviceName: 'Mic', channelIndex: 1 })).toMatchObject({ ok: true })
    expect(calls.filter(c => c.method === 'beginCapture').at(-1)?.args[0]).toMatchObject({ inputChannel: 1 })
    expect(calls.filter(c => c.method === 'recordTake')).toHaveLength(1)
  })
  it('reopens armed capture for channel and resolved device changes, and records the requested channel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const events: Array<{ method: string; args: unknown[] }> = []
    let generation = 0n
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      events.push({ method, args })
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'zen', label: 'Zen', channels: 8, isDefault: true }, { uid: 'quad', label: 'Quad', channels: 4, isDefault: false }] } as T
      if (method === 'captureState') return { state: generation ? 'running' : 'stopped', ownershipGeneration: generation.toString() } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; return { ok: true } as T }
      if (method === 'cancelCapture') { if (args[0] === generation) generation = 0n; return { ok: true } as T }
      if (method === 'captureStats') return { firstSampleCaptured: true, firstSampleHostNs: '1000000000', lastSampleHostNs: '1000000000', sampleRate: 48000 } as T
      if (method === 'presentationQuery') return { found: true, songSeconds: 0, sampleRate: 48000 } as T
      if (method === 'finishTake') return { ok: true, frames: 48000, sampleRate: 48000 } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const s = new VoiceTakeStore({ rootDir: root, native })
    expect(await s.arm({ input: { deviceName: 'zen', channelIndex: 0 } })).toMatchObject({ ok: true })
    const first = generation
    expect(await s.arm({ input: { deviceName: 'Zen', channelIndex: 0 } })).toMatchObject({ ok: true })
    expect(events.filter(e => e.method === 'beginCapture')).toHaveLength(1)
    expect(await s.arm({ input: { deviceName: 'zen', channelIndex: 7 } })).toMatchObject({ ok: true })
    expect(events.find(e => e.method === 'cancelCapture')?.args[0]).toBe(first)
    expect(generation).not.toBe(first)
    expect(events.filter(e => e.method === 'beginCapture').at(-1)?.args[0]).toMatchObject({ deviceUid: 'zen', inputChannel: 7 })
    const second = generation
    expect(await s.arm({ input: { deviceName: 'quad', channelIndex: 0 } })).toMatchObject({ ok: true })
    expect(events.filter(e => e.method === 'cancelCapture').at(-1)?.args[0]).toBe(second)
    expect(events.filter(e => e.method === 'beginCapture').at(-1)?.args[0]).toMatchObject({ deviceUid: 'quad', inputChannel: 0 })
    const third = generation
    const started = await s.start({ ...request, input: { deviceName: 'quad', channelIndex: 3 } })
    expect(started.ok).toBe(true)
    expect(events.filter(e => e.method === 'cancelCapture').at(-1)?.args[0]).toBe(third)
    expect(generation).not.toBe(third)
    expect(events.filter(e => e.method === 'beginCapture').at(-1)?.args[0]).toMatchObject({ deviceUid: 'quad', inputChannel: 3 })
    expect(events.find(e => e.method === 'recordTake')?.args[2]).toBe(generation)
    expect(await s.arm({ input: { deviceName: 'zen', channelIndex: 0 } })).toMatchObject({ ok: false, reason: 'busy' })
    await s.stop()
    await s.disarm()
  })
  it('does not open a replacement when releasing the old capture fails', async () => {
    const events: string[] = []
    let generation = 0n
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      events.push(method)
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'zen', label: 'Zen', channels: 8, isDefault: true }] } as T
      if (method === 'captureState') return { state: 'running', ownershipGeneration: generation.toString() } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; return { ok: true } as T }
      if (method === 'cancelCapture') return { ok: false } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    const s = new VoiceTakeStore({ native })
    expect((await s.arm({ input: { deviceName: 'zen', channelIndex: 0 } })).ok).toBe(true)
    expect(await s.arm({ input: { deviceName: 'zen', channelIndex: 7 } })).toMatchObject({ ok: false, reason: 'error' })
    expect(events.filter(e => e === 'beginCapture')).toHaveLength(1)
  })
  it('arms for live level, reuses capture for recording, keeps it after stop, and disarms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); const s = new VoiceTakeStore({ rootDir: root, native: fakeNative() })
    expect(await s.arm({ input: { deviceName: 'Mic', channelIndex: 0 } })).toMatchObject({ ok: true })
    expect(await s.level()).toMatchObject({ takeActive: false }); const started = await s.start(request); expect(started.ok).toBe(true)
    expect(await s.level()).toMatchObject({ takeActive: true }); await s.stop(); expect(await s.level()).toMatchObject({ takeActive: false }); expect(await s.disarm()).toMatchObject({ ok: true })
  })
  it.each([
    ['reported', true, 120, 'reported'],
    ['unknown', false, 0, 'measured-trim'],
    ['reported', false, 0, 'measured-trim']
  ] as const)('uses only stable reported input latency (%s, %s)', async (source, stable, trim, expectedSource) => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const native = fakeNative(); const calls: Array<Parameters<VoiceTakeNative['presentationQuery']>[0]> = []
    native.captureStats = async () => ({ firstSampleCaptured: true, firstSampleHostNs: '1000000000', lastSampleHostNs: '1000000000', sampleRate: 48000, inputLatencyFrames: 120, inputBufferFrames: 512, inputLatencySource: source, inputLatencyStable: stable })
    native.presentationQuery = async args => { calls.push(args); return { ok: true, found: true, startPositionSec: 4, outputLatencyFrames: 20, graphLatencyFrames: 10 } }
    const s = new VoiceTakeStore({ rootDir: root, native }); const started = await s.start(request); expect(started.ok).toBe(true)
    await s.stop()
    const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${started.ok ? started.takeId : ''}.json`), 'utf8'))
    expect(calls[1]?.inputLatencyFrames).toBe(trim); expect(sidecar).toMatchObject({ inputLatencyFrames: trim, latencySource: expectedSource })
  })

  it('rejects overlapping arms and clears the arming flag after failure', async () => {
    const native = fakeNative(); let resolve!: (value: Awaited<ReturnType<VoiceTakeNative['armCapture']>>) => void; let calls = 0
    native.armCapture = () => { calls++; return new Promise(done => { resolve = done }) }
    const s = new VoiceTakeStore({ native }); const first = s.arm({ input: request.input }); const second = s.arm({ input: request.input })
    expect(calls).toBe(1); expect(await second).toMatchObject({ ok: false, reason: 'busy' })
    resolve({ ok: false }); expect((await first).ok).toBe(false)
    native.armCapture = async () => ({ ok: true, generation: 1n }); expect((await s.arm({ input: request.input })).ok).toBe(true)
  })

  it('rejects ambiguous normalized and identical labels while preferring exact uid and label', async () => {
    const devices = [{ uid: 'one', label: 'USB Mic (1)', channels: 1 }, { uid: 'two', label: 'USB Mic (2)', channels: 1 }]
    const rpc = { call: async <T>(_target: string, method: string): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    expect(await native.armCapture({ deviceName: 'USB Mic', channelIndex: 0 })).toMatchObject({ ok: false, reason: 'no-input' })
    expect(await native.armCapture({ deviceName: 'two', channelIndex: 0 })).toMatchObject({ ok: true, deviceName: 'USB Mic (2)' }); await native.disarmCapture()
    expect(await native.armCapture({ deviceName: 'USB Mic (1)', channelIndex: 0 })).toMatchObject({ ok: true, deviceName: 'USB Mic (1)' }); await native.disarmCapture()
    devices[1]!.label = 'USB Mic (1)'
    expect(await native.armCapture({ deviceName: 'USB Mic (1)', channelIndex: 0 })).toMatchObject({ ok: false, reason: 'no-input' })
  })

  it('reopens unarmed capture after stop and releases armed capture after stop and disarm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    let generation = 0n; let opens = 0
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic', label: 'Mic', channels: 1, isDefault: true }] } as T
      if (method === 'captureState') return { state: generation ? 'running' : 'stopped', ownershipGeneration: generation.toString() } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; opens++; return { ok: true } as T }
      if (method === 'cancelCapture') { if (generation === args[0]) generation = 0n; return { ok: true } as T }
      if (method === 'recordTake') { if (!generation || generation !== args[2]) return { ok: false, error: 'No microphone input is open' } as T; writeFileSync(join(args[0] as string, `${args[1]}.wav`), wav()); return { ok: true } as T }
      if (method === 'captureStats') return { firstSampleCaptured: true, firstSampleHostNs: '1000', lastSampleHostNs: '1000', sampleRate: 22050 } as T
      if (method === 'presentationQuery') return { found: true, songSeconds: 0 } as T
      if (method === 'finishTake') return { ok: true, sampleRate: 22050, frames: 22050 } as T
      return { ok: true } as T
    } }
    const s = new VoiceTakeStore({ rootDir: root, native: createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess) })
    expect((await s.start(request)).ok).toBe(true); await s.stop(); expect(generation).toBe(0n)
    expect((await s.start(request)).ok).toBe(true); await s.stop(); expect(opens).toBe(2)
    expect((await s.arm({ input: request.input })).ok).toBe(true); expect((await s.start(request)).ok).toBe(true)
    await s.stop(); expect(generation).not.toBe(0n); await s.disarm(); expect(generation).toBe(0n)
  })

  it('reopens capture when native state no longer owns the cached generation', async () => {
    let generation = 0n; let opens = 0
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic', label: 'Mic', channels: 1 }] } as T
      if (method === 'captureState') return { state: generation ? 'running' : 'stopped', ownershipGeneration: generation.toString() } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; opens++; return { ok: true } as T }
      if (method === 'captureStats') return { lastSampleHostNs: '1000000000', sampleRate: 48000 } as T
      if (method === 'presentationQuery') return { found: true, songSeconds: 12, sampleRate: 48000 } as T
      return { ok: true } as T
    } }
    const native = createVoiceTakeNative(rpc as typeof import('../../src/main/audio-process').desktopAudioProcess)
    await native.recordTake({ dir: '/tmp', takeId: 'a', generation: 1n, deviceName: 'Mic' }); generation = 0n
    await native.recordTake({ dir: '/tmp', takeId: 'b', generation: 2n, deviceName: 'Mic' }); expect(opens).toBe(2)
  })

})


describe('take peaks, moving and deleting (voice lane)', () => {
  const pcm = (sampleRate: number, samples: Int16Array): Buffer => {
    const b = wav(sampleRate, samples.length)
    samples.forEach((v, i) => b.writeInt16LE(v, 44 + i * 2))
    return b
  }
  const withRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root); return root }
  const recordOne = async (root: string, native = fakeNative()) => {
    const s = new VoiceTakeStore({ rootDir: root, native, now: () => new Date('2026-01-01T00:00:00.000Z'), placementQuery: native.presentationQuery })
    const started = await s.start(request)
    if (!started.ok) throw new Error('start')
    await s.stop()
    return { s, takeId: started.takeId }
  }

  it('peaks: silence is flat zero, a sine peaks near its amplitude, a clipped burst reaches 1', async () => {
    const root = withRoot(); const dir = join(root, 'song-1'); mkdirSync(dir)
    const rate = 8000
    writeFileSync(join(dir, 'silence.wav'), pcm(rate, new Int16Array(rate)))
    writeFileSync(join(dir, 'sine.wav'), pcm(rate, Int16Array.from({ length: rate }, (_, i) => Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 16384))))
    writeFileSync(join(dir, 'burst.wav'), pcm(rate, Int16Array.from({ length: rate }, (_, i) => (i >= 4000 && i < 4100 ? (i % 2 ? 32767 : -32768) : 0))))
    const s = store(root)
    const silence = await s.peaks({ songId: 'song-1', takeId: 'silence' })
    const sine = await s.peaks({ songId: 'song-1', takeId: 'sine' })
    const burst = await s.peaks({ songId: 'song-1', takeId: 'burst' })
    if (!silence.ok || !sine.ok || !burst.ok) throw new Error('peaks failed')
    expect(silence.stepSec).toBeCloseTo(0.01, 4)
    expect(silence.peaks).toHaveLength(100)
    expect(Math.max(...silence.peaks)).toBe(0)
    expect(Math.min(...sine.peaks)).toBeGreaterThan(0.45) // a 10 ms slice holds several full cycles of 440 Hz
    expect(Math.max(...sine.peaks)).toBeCloseTo(0.5, 2)
    expect(Math.max(...burst.peaks)).toBe(1)
    expect(burst.peaks.filter(p => p > 0)).toHaveLength(2) // 100 samples at 8 kHz span two 10 ms slices
    expect(burst.peaks[0]).toBe(0)
  })
  it('peaks are coarsened to the cap: a long take never exceeds maxPeaks and its step grows', async () => {
    const root = withRoot(); mkdirSync(join(root, 'song-1'))
    const path = join(root, 'song-1', 'long.wav')
    writeFileSync(path, wav(1000, 100_000)) // 100 s at 1 kHz: 10 ms steps would be 10000 peaks
    const { computeWavPeaks } = await import('../../src/main/voice-takes')
    const fine = await computeWavPeaks(path, 20000)
    expect(fine.peaks).toHaveLength(10000)
    expect(fine.stepSec).toBeCloseTo(0.01, 6)
    const coarse = await computeWavPeaks(path, 400)
    expect(coarse.peaks.length).toBeLessThanOrEqual(400) // a revert of the coarsening would give 10000 here
    expect(coarse.stepSec).toBeCloseTo(0.25, 6)
    expect(coarse.stepSec).toBeGreaterThan(fine.stepSec)
    expect(coarse.durationSec).toBeCloseTo(100, 3)
  })
  it('the peak cache keeps only the 16 most recent takes', async () => {
    const root = withRoot(); const dir = join(root, 'song-1'); mkdirSync(dir)
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `t${i}.wav`), wav(8000, 800))
    const s = store(root)
    for (let i = 0; i < 20; i++) expect(await s.peaks({ songId: 'song-1', takeId: `t${i}` })).toMatchObject({ ok: true })
    const cache = (s as unknown as { peakCache: Map<string, unknown> }).peakCache
    expect(cache.size).toBe(16)
    expect([...cache.keys()].some(k => k.includes(`${join(dir, 't0.wav')}:`))).toBe(false) // the oldest were dropped
    expect([...cache.keys()].some(k => k.includes(`${join(dir, 't19.wav')}:`))).toBe(true)
  })
  it('peaks and moves are refused while a take is being finalized, and allowed afterwards', async () => {
    const root = withRoot()
    const native = fakeNative()
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const finish = native.finishTake
    native.finishTake = async args => { await gate; return finish(args) }
    const s = new VoiceTakeStore({ rootDir: root, native, now: () => new Date('2026-01-01T00:00:00.000Z'), placementQuery: native.presentationQuery })
    const started = await s.start(request)
    if (!started.ok) throw new Error('start')
    const stopping = s.stop() // active is already null here; the sidecar is not written yet
    expect(await s.move({ songId: 'song-1', takeId: started.takeId, userOffsetSec: 2 })).toMatchObject({ ok: false, error: 'The take is still recording.' })
    expect(await s.peaks({ songId: 'song-1', takeId: started.takeId })).toMatchObject({ ok: false, error: 'The take is still recording.' })
    release()
    await stopping
    expect(await s.move({ songId: 'song-1', takeId: started.takeId, userOffsetSec: 2 })).toMatchObject({ ok: true })
    expect(await s.peaks({ songId: 'song-1', takeId: started.takeId })).toMatchObject({ ok: true })
  })
  it('peaks stay bounded for a long take and are cached by file identity', async () => {
    const root = withRoot(); const dir = join(root, 'song-1'); mkdirSync(dir)
    writeFileSync(join(dir, 'long.wav'), wav(1000, 100_000)) // 100 s of silence at 1 kHz
    const s = store(root)
    const first = await s.peaks({ songId: 'song-1', takeId: 'long' })
    if (!first.ok) throw new Error('peaks')
    expect(first.peaks.length).toBeLessThanOrEqual(20000)
    expect(first.durationSec).toBeCloseTo(100, 3)
    const again = await s.peaks({ songId: 'song-1', takeId: 'long' })
    expect(again).toEqual(first)
  })
  it('peaks refuse bad ids, a missing file and a take that is still recording', async () => {
    const root = withRoot(); const s = store(root)
    expect(await s.peaks({ songId: '../x', takeId: 'a' })).toMatchObject({ ok: false })
    expect(await s.peaks({ songId: 'song-1', takeId: 'nope' })).toMatchObject({ ok: false })
    const started = await s.start(request)
    if (!started.ok) throw new Error('start')
    expect(await s.peaks({ songId: 'song-1', takeId: started.takeId })).toMatchObject({ ok: false, error: 'The take is still recording.' })
    expect(await s.move({ songId: 'song-1', takeId: started.takeId, userOffsetSec: 1 })).toMatchObject({ ok: false })
  })
  it('move persists beside the measured placement, survives a list reload, and 0 resets it', async () => {
    const root = withRoot(); const { s, takeId } = await recordOne(root)
    const moved = await s.move({ songId: 'song-1', takeId, userOffsetSec: 2.5 })
    expect(moved).toMatchObject({ ok: true, take: { startPositionSec: 12, userOffsetSec: 2.5 } })
    const sidecar = JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8'))
    expect(sidecar.startPositionSec).toBe(12) // never overwritten
    expect(sidecar.userOffsetSec).toBe(2.5)
    const reloaded = await store(root).list('song-1')
    expect(reloaded[0]).toMatchObject({ takeId, startPositionSec: 12, userOffsetSec: 2.5 })
    await s.move({ songId: 'song-1', takeId, userOffsetSec: 0 })
    expect(JSON.parse(readFileSync(join(root, 'song-1', `${takeId}.json`), 'utf8')).userOffsetSec).toBeUndefined()
    expect((await store(root).list('song-1'))[0]?.userOffsetSec).toBe(0)
  })
  it('move never lets the take start before the song and rejects junk', async () => {
    const root = withRoot(); const { s, takeId } = await recordOne(root)
    expect(await s.move({ songId: 'song-1', takeId, userOffsetSec: -100 })).toMatchObject({ ok: true, take: { userOffsetSec: -12 } }) // clamped to 12 - 12 = 0
    for (const userOffsetSec of [NaN, Infinity, 36001, -36001]) expect(await s.move({ songId: 'song-1', takeId, userOffsetSec })).toMatchObject({ ok: false })
    expect(await s.move({ songId: 'song-1', takeId: '../bad', userOffsetSec: 1 })).toMatchObject({ ok: false })
    expect(await s.move({ songId: 'song-1', takeId: 'missing', userOffsetSec: 1 })).toMatchObject({ ok: false, error: 'Take not found.' })
  })
  it('playback starts from the moved position (negative control: the unmoved take starts at the measured one)', async () => {
    const root = withRoot()
    const native = fakeNative()
    const playTake = vi.fn(async () => ({ ok: true }))
    native.playTake = playTake
    const { s, takeId } = await recordOne(root, native)
    await s.play({ takeId, mode: 'take' })
    expect(playTake).toHaveBeenLastCalledWith(expect.objectContaining({ startPositionSec: 12 }))
    await s.move({ songId: 'song-1', takeId, userOffsetSec: 3 })
    await s.play({ takeId, mode: 'with-song' })
    expect(playTake).toHaveBeenLastCalledWith(expect.objectContaining({ startPositionSec: 15, mode: 'with-song' }))
  })
  it('remove deletes the wav and the sidecar and forgets the peaks', async () => {
    const root = withRoot(); const { s, takeId } = await recordOne(root)
    expect(await s.peaks({ songId: 'song-1', takeId })).toMatchObject({ ok: true })
    expect(await s.remove('song-1', takeId)).toEqual({ ok: true })
    expect(readdirSync(join(root, 'song-1'))).toEqual([])
    expect(await s.peaks({ songId: 'song-1', takeId })).toMatchObject({ ok: false })
    expect(await s.list('song-1')).toEqual([])
  })
})
