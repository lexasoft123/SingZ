import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VoiceTakeStore, appendLegacySetting, type VoiceTakeNative } from '../../src/main/voice-takes'
import { defaultVoiceTakeEffects, isVoiceTakeAnchors, isVoiceTakeEffects, resolveVoiceTakeTimeline, VOICE_TAKE_ANCHORS_MAX, VOICE_TAKE_EFFECTS_MAX } from '../../src/shared/voice-take'
import { EventEmitter } from 'node:events'
import { isAllowed } from '../../src/main/media'
import { createVoiceTakeNative, registerVoiceTakeIpc } from '../../src/main/voice-takes-ipc'
import { ConformTakeError, type ConformTakeErrorCode } from '../../src/main/voice-take-conform'
import { logEntries } from '../../src/main/log'
import { VoiceMonitorStore, type VoiceMonitorNative } from '../../src/main/voice-monitor'

const voiceIpc = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => Promise<any>>(),
  conform: vi.fn(), invalidate: vi.fn(async () => {}), release: vi.fn(async () => {}) }))
vi.mock('electron', async actual => ({ ...await actual<typeof import('electron')>(),
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => Promise<any>) => voiceIpc.handlers.set(channel, handler) } }))
vi.mock('../../src/main/voice-take-conform', async actual => ({ ...await actual<typeof import('../../src/main/voice-take-conform')>(),
  conformTake: voiceIpc.conform, invalidateConformedTake: voiceIpc.invalidate, releaseConformedTake: voiceIpc.release }))

describe('bounded legacy settings timeline', () => {
  it('keeps the first and latest changes and never exceeds the cap', () => {
    const settings = [{ atSec: 0, tempo: 1, transposeSemitones: 0 }]
    for (let i = 1; i <= VOICE_TAKE_ANCHORS_MAX + 100; i++)
      appendLegacySetting(settings, { atSec: i, tempo: i % 2 ? .5 : 1, transposeSemitones: 0 })
    expect(settings).toHaveLength(VOICE_TAKE_ANCHORS_MAX)
    expect(settings[0]).toEqual({ atSec: 0, tempo: 1, transposeSemitones: 0 })
    expect(settings.at(-1)).toEqual({ atSec: VOICE_TAKE_ANCHORS_MAX + 100, tempo: 1, transposeSemitones: 0 })
    const last = settings.at(-1)!
    expect(appendLegacySetting(settings, { ...last, atSec: last.atSec + 1 })).toBe(false)
    expect(settings.at(-1)).toEqual(last)
  })
})

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

  it('finalizes immediately when no first-sample timestamp becomes available', async () => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'singz-no-stamp-')); roots.push(root)
    const native = fakeNative()
    native.captureStats = vi.fn(async () => ({ firstSampleCaptured: false }))
    native.finishTake = vi.fn(native.finishTake)
    native.stopCapture = vi.fn(async () => ({ ok: true }))
    const s = new VoiceTakeStore({ rootDir: root, native })
    try {
      const starting = s.start(request)
      await vi.waitFor(() => expect(native.captureStats).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(1100)
      expect(await starting).toMatchObject({ ok: false, reason: 'error', message: expect.stringContaining('No microphone samples') })
      expect(native.finishTake).toHaveBeenCalledTimes(1)
      expect(native.stopCapture).toHaveBeenCalledTimes(1)
      expect((await s.level()).takeActive).toBe(false)
      expect((await s.stop()).take?.status).toBe('partial-error')
    } finally { vi.useRealTimers() }
  })

  it.each(['/home/private-user/take.wav', 'C:\\Users\\private-user\\take.wav'])('redacts sampling and finalization error paths: %s', async message => {
    const root = mkdtempSync(join(tmpdir(), 'singz-safe-log-')); roots.push(root)
    for (const phase of ['sampling', 'finalization'] as const) {
      const native = fakeNative()
      const s = new VoiceTakeStore({ rootDir: root, native })
      const started = await s.start(request)
      expect(started.ok).toBe(true)
      if (phase === 'sampling') native.captureStats = async () => { throw new Error(message) }
      else native.finishTake = async () => { throw new Error(message) }
      const stopped = await s.stop()
      if (phase === 'finalization') expect(stopped.message).toBe('The take could not be finalized.')
      const takeId = started.ok ? started.takeId : ''
      const diagnostics = logEntries().filter(entry => entry.source === 'voice-take' &&
        entry.line.includes(takeId) && entry.line.includes(phase === 'sampling' ? 'sampling failed' : 'finalize failed'))
      expect(diagnostics).toHaveLength(1)
      expect(diagnostics[0].line).not.toContain('private-user')
      expect(diagnostics[0].line).toContain(phase === 'sampling' ? 'capture-sampling-failed' : 'The take could not be finalized.')
    }
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

  it.each([.25, .5, .75, 1, 1.25, 2])('waits for WASAPI-like audible placement before writing an armed stopped-song take at %sx', async tempo => {
    vi.useFakeTimers()
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-')); roots.push(root)
    const origin = 10_000_000_000n
    const graphFrames = tempo === 1 ? 0 : 7200
    const outputFrames = 1056 // WASAPI device + buffer latency, at 48 kHz / 480-frame callbacks.
    const delay = BigInt((graphFrames + outputFrames) * 1e9 / 48000)
    let elapsed = 0n, first = 0n, generation = 0n, writerStarted = false, probes = 0
    const rpc = { call: async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
      if (method === 'inputDevices') return { ok: true, devices: [{ uid: 'mic', label: 'Mic', channels: 1, isDefault: true }] } as T
      if (method === 'beginCapture') { generation = args[1] as bigint; return { ok: true } as T }
      if (method === 'captureState') return { state: 'running', ownershipGeneration: generation.toString() } as T
      if (method === 'captureStats') return { lastSampleHostNs: (origin + elapsed).toString(), firstSampleCaptured: writerStarted,
        firstSampleHostNs: first.toString(), firstSampleQuality: 'hardware', inputBufferFrames: 480, sampleRate: 48000 } as T
      if (method === 'presentationQuery') {
        probes++
        const at = BigInt(args[0] as string)
        const outputBlock = elapsed / 10_000_000n // 480 frames at 48 kHz, independent input packet phase.
        return { found: at >= origin && at < origin + (outputBlock + 1n) * 10_000_000n,
          paused: at === origin, songSeconds: 12 + Number(at - origin) / 1e9 * tempo,
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
      const readiness = logEntries().find(entry => entry.source === 'voice-take' && entry.line.startsWith('readiness ') &&
        entry.line.includes('"takeId":' + JSON.stringify(done.take!.takeId)))
      expect(readiness?.line).toContain('"inputBufferFrames":480')
      expect(readiness?.line).toContain('"outputLatencyFrames":1056')
      expect(readiness?.line).toContain('"quality":"hardware"')
      expect(readiness?.line).toContain('"ready":true')
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
    const native = fakeNative({ frames: 48000, sampleRate: 48000 }); const calls: Array<Parameters<VoiceTakeNative['presentationQuery']>[0]> = []
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
  it('reads only the requested placed waveform span', async () => {
    const root = withRoot(); mkdirSync(join(root, 'song-1'))
    const path = join(root, 'song-1', 'placed.wav')
    const samples = Int16Array.from({ length: 8000 }, (_, i) => i >= 2000 && i < 4000 ? 16384 : 0)
    writeFileSync(path, pcm(8000, samples))
    const { computeWavPeaks } = await import('../../src/main/voice-takes')
    const placed = await computeWavPeaks(path, 20000, 2000, 4000)
    const raw = await computeWavPeaks(path)
    expect(placed.durationSec).toBe(.25)
    expect(placed.peaks.every(p => p === .5)).toBe(true)
    expect(raw.durationSec).toBe(1)
    expect(raw.peaks[0]).toBe(0)
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

describe('take timeline anchors and FX descriptor', () => {
  const timelineFixture = (tempo = 1, seam?: { at: number; tempo: number; transpose?: number } | Array<{ at: number; tempo: number; transpose?: number }>) => {
    const seams = seam ? Array.isArray(seam) ? seam : [seam] : []
    const root = mkdtempSync(join(tmpdir(), 'singz-anchors-')); roots.push(root)
    const sampleRate = 22050 // Deliberately different from the song/output's 48 kHz.
    const origin = 10_000_000_000n
    let elapsed = 0, fault = false, missing = false, paused = false, frameBias = 0
    const native = fakeNative({ frames: sampleRate * 6, sampleRate })
    native.captureStats = async () => ({ firstSampleCaptured: true, firstSampleHostNs: origin.toString(),
      lastSampleHostNs: (origin + BigInt(Math.round(elapsed * 1e9))).toString(),
      takeFrameHostNs: (origin + BigInt(Math.round(elapsed * 1e9))).toString(), takeFrame: Math.round(elapsed * sampleRate) + frameBias,
      firstSampleQuality: 'hardware', sampleRate, inputLatencySource: 'reported', inputLatencyStable: true })
    native.presentationQuery = async args => {
      const at = Number(BigInt(args.firstSampleHostNs!) - origin) / 1e9
      let edge = 0, start = 12, rate = tempo, transpose = 0, epoch = 0
      for (const change of seams) {
        if (at < change.at) break
        start += (change.at - edge) * rate; edge = change.at; rate = change.tempo
        transpose = change.transpose ?? 0; epoch++
      }
      return { ok: true, found: !missing && elapsed - at < 2.7, paused, sampleRate: 48000,
        startPositionSec: start + (at - edge) * rate, rate, transposeSemitones: transpose,
        discontinuitySerial: fault ? 9 : epoch, faultSerial: fault ? 1 : 0,
        mappingStartCaptureHostNs: (origin + BigInt(Math.round(edge * 1e9))).toString(), mappingStartSongSeconds: start }
    }
    // Wall clock deliberately disagrees by minutes with the sample clock.
    const s = new VoiceTakeStore({ rootDir: root, native, now: () => new Date(1_000_000 + elapsed * 100_000) })
    const internal = s as unknown as { active: object; checkDiscontinuity(active: object): Promise<void> }
    let id = ''
    return { s, native, sampleRate,
      async start() { const r = await s.start({ ...request, tempo }); expect(r.ok).toBe(true); id = r.ok ? r.takeId : '' },
      async poll(at: number) { elapsed = at; await internal.checkDiscontinuity(internal.active) },
      at: (at: number) => { elapsed = at },
      read: () => JSON.parse(readFileSync(join(root, 'song-1', `${id}.json`), 'utf8')) as import('../../src/shared/voice-take').VoiceTakeSidecar,
      write: (take: import('../../src/shared/voice-take').VoiceTakeSidecar) => writeFileSync(join(root, 'song-1', `${id}.json`), JSON.stringify(take)),
      fault: () => { fault = true }, miss: () => { missing = true }, pause: () => { paused = true }, bias: (frames: number) => { frameBias = frames }
    }
  }

  it.each([1, .5, 2])('records sample-domain anchors at tempo %s and persists them before finalization', async tempo => {
    const f = timelineFixture(tempo); await f.start(); await f.poll(2); await f.poll(4)
    const provisional = f.read()
    expect(provisional.anchors).toEqual([0, 2, 4].map(t => ({ takeFrame: t * f.sampleRate, projectFrame: Math.round((12 + t * tempo) * f.sampleRate) })))
    expect(provisional.status).toBe('recovered')
    await f.s.stop()
    expect(f.read().anchors?.at(-1)).toEqual({ takeFrame: 6 * f.sampleRate, projectFrame: Math.round((12 + 6 * tempo) * f.sampleRate) })
    expect(f.read().effects).toEqual(defaultVoiceTakeEffects())
  })

  it('captures a landed tempo/transpose seam within one sample despite a false wall clock', async () => {
    const f = timelineFixture(1, { at: 3.125, tempo: .5, transpose: 2 })
    await f.start(); await f.poll(2); await f.poll(4); await f.s.stop()
    const take = f.read(), seamFrame = Math.round(3.125 * f.sampleRate)
    expect(take.status).toBe('complete') // Deliberate settings seam increments serial, never the fault token.
    expect(take.startPositionSec).toBe(12)
    expect(take.anchors).toContainEqual({ takeFrame: seamFrame, projectFrame: Math.round(15.125 * f.sampleRate) })
    expect(take.settings[1]).toEqual({ atSec: seamFrame / f.sampleRate, tempo: .5, transposeSemitones: 2 })
    // Negative control: old wall-clock replay would place the seam hundreds of seconds late.
    const wrong = resolveVoiceTakeTimeline({ ...take, anchors: undefined,
      settings: [take.settings[0]!, { atSec: 3.125 * 100, tempo: .5, transposeSemitones: 2 }] })
    expect(Math.abs(wrong.anchors.at(-1)!.projectFrame - take.anchors!.at(-1)!.projectFrame) / f.sampleRate).toBeGreaterThan(.001)
    expect(take.anchors?.at(-1)?.projectFrame).toBe(Math.round((15.125 + (6 - 3.125) * .5) * f.sampleRate))
  })

  it('uses the committed WAV cursor rather than elapsed host time after gap/drift adjustment', async () => {
    const f = timelineFixture(); await f.start(); f.bias(17); await f.poll(2); await f.s.stop()
    expect(f.read().anchors).toContainEqual({ takeFrame: 2 * f.sampleRate + 17, projectFrame: 14 * f.sampleRate })
    // A host-time-only frame counter would silently erase these file frames.
    expect(f.read().anchors).not.toContainEqual({ takeFrame: 2 * f.sampleRate, projectFrame: 14 * f.sampleRate })
  })

  it('does not lose multiple landed changes between polls or a seam in the final drained block', async () => {
    const f = timelineFixture(1, [{ at: 3.125, tempo: .5 }, { at: 3.25, tempo: 2, transpose: 2 }, { at: 3.375, tempo: 1 }])
    await f.start(); await f.poll(2); f.at(4); await f.s.stop()
    const take = f.read()
    expect(take.status).toBe('complete')
    for (const at of [3.125, 3.25, 3.375])
      expect(take.anchors?.some(anchor => anchor.takeFrame === Math.round(at * f.sampleRate))).toBe(true)
    expect(take.settings.map(point => point.tempo)).toEqual([1, .5, 2, 1])
  })

  it('samples and atomically persists periodic anchors through the real recording timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const f = timelineFixture()
    try {
      await f.start(); f.at(2); await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(f.read().anchors).toHaveLength(2))
      expect(f.read().status).toBe('recovered')
      await f.s.stop()
    } finally { vi.useRealTimers() }
  })

  it('fails a changed file rate and refuses malformed additive sidecar fields without rewriting them', async () => {
    const f = timelineFixture(); await f.start()
    f.native.finishTake = async () => ({ ok: true, frames: 48000, sampleRate: 48000 })
    expect((await f.s.stop()).take?.status).toBe('partial-error')
    expect(f.read().anchors).toBeUndefined()
    const malformed = { ...f.read(), effects: [{ id: 'unknown' }] } as unknown as import('../../src/shared/voice-take').VoiceTakeSidecar
    f.write(malformed)
    expect(await f.s.list('song-1')).toEqual([])
    expect(f.read()).toEqual(malformed)
  })

  it('ends a discontinuous timeline without invalidating its start, even alongside a settings seam', async () => {
    const f = timelineFixture(1, { at: 3.125, tempo: 2 }); await f.start(); await f.poll(2); f.fault(); await f.poll(4)
    expect((await f.s.stop()).take?.status).toBe('complete')
    expect(f.read().startPositionSec).toBe(12)
    expect(f.read().anchors).toHaveLength(2)
  })

  it('ends without extrapolating when retained presentation coverage is lost', async () => {
    const f = timelineFixture(); await f.start(); f.miss(); await f.poll(3)
    expect((await f.s.stop()).take?.status).toBe('complete')
    expect(f.read().anchors).toHaveLength(1)
  })

  it.each([
    { end: 'seek', poll: true }, { end: 'pause', poll: true }, { end: 'song-end', poll: true },
    { end: 'seek', poll: false }, { end: 'pause', poll: false }, { end: 'song-end', poll: false },
    { end: 'Stop with pause before recordStop', poll: false }
  ])('keeps a complete take on $end (poll=$poll)', async ({ end, poll }) => {
    const f = timelineFixture(); await f.start(); await f.poll(2)
    const anchors = f.read().anchors
    if (end === 'seek') f.fault()
    else if (end === 'song-end') f.miss()
    else f.pause()
    f.at(3)
    if (poll) await f.poll(3)
    const stopped = await f.s.stop(undefined, 'seek')
    expect(stopped).toMatchObject({ take: { status: 'complete' }, note: 'seek' })
    expect(await f.s.stop()).toEqual(stopped)
    expect(f.read()).toMatchObject({ startPositionSec: 12, latencySource: 'reported', anchors })
    expect((await f.s.level()).takeActive).toBe(false)
  })

  it('discriminates the reviewed negative control that mislabeled a seek as a placement fault', async () => {
    const f = timelineFixture(); await f.start(); await f.poll(2); f.fault()
    // Reproduce the old faulty() branch, rather than merely asserting a constant.
    ;(f.s as unknown as { active: { placementFault: boolean } }).active.placementFault = true
    expect((await f.s.stop()).take?.status).toBe('partial-error')
    expect(f.read().latencySource).toBe('measured-trim')
  })

  it.each([true, false])('finalizes despite rejecting captureStats (pending poll=%s)', async pending => {
    const f = timelineFixture(); await f.start(); await f.poll(2)
    const anchors = f.read().anchors
    f.native.captureStats = async () => { throw new Error('captureStats rejected') }
    const rejected = pending ? expect(f.poll(3)).rejects.toThrow('captureStats rejected') : undefined
    expect((await f.s.stop()).take?.status).toBe('complete')
    await rejected
    expect(f.read()).toMatchObject({ anchors, latencySource: 'reported' })
  })

  it.each(['gapOverflow', 'gapRegressions'] as const)('retains partial-error for a real %s capture fault', async field => {
    const f = timelineFixture(); await f.start(); await f.poll(2)
    const stats = f.native.captureStats
    f.native.captureStats = async () => ({ ...await stats(), [field]: field === 'gapOverflow' ? true : 1 })
    await f.poll(3)
    expect((await f.s.stop()).take?.status).toBe('partial-error')
  })

  it('loads old sidecars with an explicitly approximate integrated settings map and enabled default FX', async () => {
    const f = timelineFixture(); await f.start(); await f.s.stop()
    const old = f.read(); delete old.anchors; delete old.effects
    old.durationSec = 4; old.settings = [{ atSec: 0, tempo: .5, transposeSemitones: 0 }, { atSec: 2, tempo: 2, transposeSemitones: 2 }]
    const result = resolveVoiceTakeTimeline(old)
    expect(result.approximate).toBe(true); expect(result.effects[0]?.enabled).toBe(true)
    expect(result.anchors).toEqual([{ takeFrame: 0, projectFrame: 12 * f.sampleRate },
      { takeFrame: 2 * f.sampleRate, projectFrame: 13 * f.sampleRate }, { takeFrame: 4 * f.sampleRate, projectFrame: 17 * f.sampleRate }])
    f.write(old)
    expect((await f.s.list('song-1'))[0]?.timelineApproximate).toBe(true)
  })

  it.each([
    [{ takeFrame: 0, projectFrame: NaN }], [{ takeFrame: -1, projectFrame: 0 }], [{ takeFrame: 0, projectFrame: -1 }],
    [{ takeFrame: 1, projectFrame: 0 }], [{ takeFrame: 0, projectFrame: 2 }, { takeFrame: 1, projectFrame: 1 }],
    [{ takeFrame: 0, projectFrame: 0 }, { takeFrame: 0, projectFrame: 1 }], [{ takeFrame: 0, projectFrame: Infinity }],
    [{ takeFrame: 0, projectFrame: .5 }], [{ takeFrame: 0, projectFrame: 0, extra: 1 }], [],
    Array.from({ length: VOICE_TAKE_ANCHORS_MAX + 1 }, (_, i) => ({ takeFrame: i, projectFrame: i }))
  ].map(anchors => ({ anchors })))('rejects malformed, unordered or oversized anchor maps: %#', ({ anchors }) => { expect(isVoiceTakeAnchors(anchors)).toBe(false) })

  it.each([
    [{ id: 'pitch-follow', enabled: true, params: { manualOffsetSemitones: NaN, preserveFormants: false } }],
    [{ id: 'pitch-follow', enabled: true, params: { manualOffsetSemitones: 25, preserveFormants: false } }],
    [{ id: 'pitch-follow', enabled: 1, params: { manualOffsetSemitones: 0, preserveFormants: false } }],
    [{ id: 'unknown', enabled: true, params: {} }], [...defaultVoiceTakeEffects(), ...defaultVoiceTakeEffects()],
    [{ id: 'pitch-follow', enabled: true, params: { manualOffsetSemitones: 0, preserveFormants: false, extra: 1 } }],
    Array(VOICE_TAKE_EFFECTS_MAX + 1).fill(defaultVoiceTakeEffects()[0])
  ].map(effects => ({ effects })))('rejects malformed or duplicate/oversized effect slots: %#', ({ effects }) => { expect(isVoiceTakeEffects(effects)).toBe(false) })

  it('preserves an explicit pitch-follow bypass and rejects invalid recording settings', async () => {
    const f = timelineFixture(); await f.start()
    expect(await f.s.settings({ takeId: f.read().takeId, tempo: NaN, transposeSemitones: 0 })).toMatchObject({ ok: false })
    await f.s.stop(); const take = f.read(); take.effects = [{ ...defaultVoiceTakeEffects()[0]!, enabled: false }]
    expect(resolveVoiceTakeTimeline(take).effects[0]?.enabled).toBe(false)
    take.anchors![1]!.takeFrame = Number.MAX_SAFE_INTEGER
    expect(() => resolveVoiceTakeTimeline(take)).toThrow('Invalid take anchors.')
    take.sampleRate = NaN
    expect(() => resolveVoiceTakeTimeline(take)).toThrow('Invalid take timeline.')
  })
})


describe('ADR 0016 persisted take effect slots', () => {
  it('serializes FX, move and delete sidecar mutations so a delayed FX write cannot lose a drop or resurrect a take', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-fx-race-')); roots.push(root)
    const s = store(root), start = await s.start(request)
    if (!start.ok) throw new Error('start failed')
    await s.stop()
    const file = join(root, 'song-1', `${start.takeId}.json`), effects = [{ ...defaultVoiceTakeEffects()[0], enabled: false }]
    const realWrite = (s as any).writeSidecar.bind(s)
    let unblock!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const write = vi.spyOn(s as any, 'writeSidecar').mockImplementationOnce(async (...args: unknown[]) => {
      entered(); await gate; await realWrite(...args)
    })
    const fx = s.setEffects('song-1', start.takeId, effects)
    await waiting
    const move = s.move({ songId: 'song-1', takeId: start.takeId, userOffsetSec: 2 })
    await Promise.resolve(); expect(write).toHaveBeenCalledTimes(1)
    unblock(); await fx; await move
    const sidecar = JSON.parse(readFileSync(file, 'utf8'))
    expect(sidecar.effects).toEqual(effects); expect(sidecar.userOffsetSec).toBe(2)
    const editing = s.setEffects('song-1', start.takeId, [])
    const removing = s.remove('song-1', start.takeId)
    await editing; expect(await removing).toEqual({ ok: true })
    expect(existsSync(file)).toBe(false)
  })
  it('persists an ordered slot without moving measured placement or anchors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-fx-')); roots.push(root)
    const s = store(root)
    const begun = await s.start(request)
    expect(begun.ok).toBe(true)
    if (!begun.ok) throw new Error('start failed')
    await expect(s.setEffects('song-1', begun.takeId, [])).rejects.toThrow('recording')
    await s.stop()
    const file = join(root, 'song-1', `${begun.takeId}.json`), before = JSON.parse(readFileSync(file, 'utf8'))
    const effects = [{ ...defaultVoiceTakeEffects()[0], enabled: false }]
    await s.setEffects('song-1', begun.takeId, effects)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.effects).toEqual(effects); expect(after.startPositionSec).toBe(before.startPositionSec)
    expect(after.anchors).toEqual(before.anchors)
    expect((await s.list('song-1'))[0].effects).toEqual(effects)
    await expect(s.setEffects('../x', begun.takeId, effects)).rejects.toThrow()
    await expect(s.setEffects('song-1', begun.takeId, [{ id: 'unknown' } as never])).rejects.toThrow()
  })
})


describe('take monitoring metadata from main snapshots', () => {
  const fixture = async (initialOn = false, bind = true) => {
    const root = mkdtempSync(join(tmpdir(), 'singz-monitoring-take-')); roots.push(root)
    let running = false
    const input = { deviceName: 'mic', channelIndex: 0 }
    const native: VoiceMonitorNative = {
      hostDevices: async () => ({ ok: true, platform: 'darwin', provider: 'coreaudio', defaultInputUid: 'mic', defaultOutputUid: 'mic',
        devices: [{ uid: 'mic', label: 'Mic', direction: 'duplex', transport: 'usb', defaultInput: true, defaultOutput: true,
          inputChannels: 1, outputChannels: 2, inputChannelLabels: [], outputChannelLabels: [], nominalSampleRate: 48000,
          accessMode: 'shared', monitoringSuitability: 'low-latency', sampleRateRanges: [],
          bufferFrames: { minimumFrames: 32, maximumFrames: 256, preferredFrames: 32, fundamentalFrames: 1 } }] }),
      inputDevices: async () => ({ ok: true, devices: [{ uid: 'mic', label: 'Mic', channels: 1, isDefault: true }] }),
      voiceMonitorAvailability: async () => ({ available: true }),
      beginVoiceMonitor: async () => { running = true; return { ok: true } },
      endVoiceMonitor: async () => { running = false; return { ok: true } },
      voiceMonitorStatus: async () => ({ running }), setVoiceMonitorGain: async () => ({ ok: true })
    }
    const monitor = new VoiceMonitorStore(native, () => true, 'darwin')
    const set = (on: boolean) => monitor.set({ input, on })
    if (initialOn) expect((await set(true)).on).toBe(true)
    const takeNative = fakeNative()
    const store = new VoiceTakeStore({ rootDir: root, native: takeNative, monitor: bind ? monitor : undefined })
    const path = (id: string) => join(root, request.songId, `${id}.json`)
    const read = (id: string) => JSON.parse(readFileSync(path(id), 'utf8'))
    return { monitor, native, takeNative, store, set, read, path }
  }

  it.each([
    { initial: false, changes: [], expected: false },
    { initial: true, changes: [], expected: true },
    { initial: false, changes: [true], expected: true },
    { initial: false, changes: [true, false], expected: true },
    { initial: true, changes: [false], expected: true }
  ])('records any monitoring use: initial=$initial changes=$changes', async ({ initial, changes, expected }) => {
    const f = await fixture(initial)
    const start = await f.store.start(request); expect(start.ok).toBe(true)
    if (!start.ok) throw new Error('start failed')
    expect(f.read(start.takeId).monitoring).toBe(initial)
    for (const on of changes) await f.set(on) // Includes a pulse shorter than the 250 ms take poll.
    await f.store.stop()
    expect(f.read(start.takeId)).toMatchObject({ version: 1, monitoring: expected })
    await f.monitor.dispose()
  })

  it('discriminates the old unbound-store negative control and ignores renderer claims', async () => {
    const old = await fixture(true, false)
    const legacy = await old.store.start(request); if (!legacy.ok) throw new Error('start failed')
    await old.store.stop(); expect(old.read(legacy.takeId).monitoring).toBe(false)
    await old.monitor.dispose()
    const current = await fixture()
    const spoofed = { ...request, monitoring: true }
    const start = await current.store.start(spoofed); if (!start.ok) throw new Error('start failed')
    await current.store.stop(); expect(current.read(start.takeId).monitoring).toBe(false)
  })

  it('does not count a declined monitor start, or a monitor enabled after capture has stopped', async () => {
    const f = await fixture()
    f.native.beginVoiceMonitor = async () => ({ ok: false, reason: 'error' })
    const start = await f.store.start(request); if (!start.ok) throw new Error('start failed')
    expect((await f.set(true)).on).toBe(false)
    await f.store.stop()
    f.native.beginVoiceMonitor = async () => ({ ok: true })
    await f.set(true)
    expect(f.read(start.takeId).monitoring).toBe(false)
    await f.monitor.dispose()
  })

  it('latches a monitor pulse while recording start awaits its first sample', async () => {
    const f = await fixture()
    const stats = f.takeNative.captureStats
    let release!: () => void
    f.takeNative.captureStats = async () => { await new Promise<void>(resolve => { release = resolve }); return stats() }
    const pending = f.store.start(request)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await f.set(true); await f.set(false)
    f.takeNative.captureStats = stats; release()
    const start = await pending; if (!start.ok) throw new Error('start failed')
    await f.store.stop(); expect(f.read(start.takeId).monitoring).toBe(true)
  })

  it('resets the per-take latch after monitoring is switched off between takes', async () => {
    const f = await fixture(true)
    const first = await f.store.start(request); if (!first.ok) throw new Error('start failed')
    await f.store.stop(); await f.set(false)
    const second = await f.store.start(request); if (!second.ok) throw new Error('start failed')
    await f.store.stop()
    expect(f.read(first.takeId).monitoring).toBe(true)
    expect(f.read(second.takeId).monitoring).toBe(false)
  })

  it('rejects a non-boolean monitoring sidecar without changing it', async () => {
    const f = await fixture()
    const start = await f.store.start(request); if (!start.ok) throw new Error('start failed')
    await f.store.stop()
    const malformed = { ...f.read(start.takeId), monitoring: 'true' }
    writeFileSync(f.path(start.takeId), JSON.stringify(malformed))
    expect(await f.store.list(request.songId)).toEqual([])
    expect(f.read(start.takeId)).toEqual(malformed)
  })
})

describe('recording IPC renderer lifetime', () => {
  const sender = (id: number) => Object.assign(new EventEmitter(), { id, isDestroyed: () => false })
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-record-owner-')); roots.push(root)
    const native = fakeNative()
    native.finishTake = vi.fn(native.finishTake)
    native.stopCapture = vi.fn(async () => ({ ok: true }))
    native.disarmCapture = vi.fn(async () => ({ ok: true }))
    let query = native.presentationQuery
    native.presentationQuery = args => query(args)
    const store = new VoiceTakeStore({ rootDir: root, native })
    registerVoiceTakeIpc(store)
    const call = (channel: string, owner: ReturnType<typeof sender>, value?: unknown) => voiceIpc.handlers.get(channel)!({ sender: owner }, value)
    return { root, native, store, call, setQuery: (value: VoiceTakeNative['presentationQuery']) => { query = value } }
  }

  it.each(['render-process-gone', 'destroyed', 'did-start-navigation'])('finalizes and releases an armed take on %s, once', async event => {
    const { root, native, store, call } = fixture(), owner = sender(71)
    await call('voice:arm', owner, { input: request.input })
    const started = await call('voice:record-start', owner, request)
    expect(started.ok).toBe(true)
    owner.emit(event, {}, 'reload', false, true)
    owner.emit('render-process-gone', {})
    await vi.waitFor(() => expect(native.disarmCapture).toHaveBeenCalledTimes(1))
    expect(native.finishTake).toHaveBeenCalledTimes(1)
    expect((await store.level()).takeActive).toBe(false)
    const sidecar = JSON.parse(readFileSync(join(root, request.songId, `${started.takeId}.json`), 'utf8'))
    expect(sidecar.status).toBe('partial-error')
    // The next window can record; the old owner no longer holds a busy take.
    const next = sender(72)
    expect((await call('voice:record-start', next, request)).ok).toBe(true)
    await call('voice:record-stop', next)
  })

  it('does not stop another webContents take or same-document/subframe navigation', async () => {
    const { native, store, call } = fixture(), owner = sender(81), other = sender(82)
    await call('voice:record-start', owner, request)
    expect(await call('voice:record-start', other, request)).toMatchObject({ ok: false, reason: 'busy' })
    other.emit('render-process-gone', {}); other.emit('destroyed')
    owner.emit('did-start-navigation', {}, '#fragment', true, true)
    owner.emit('did-start-navigation', {}, 'iframe', false, false)
    expect((await store.level()).takeActive).toBe(true)
    expect(native.finishTake).not.toHaveBeenCalled()
    expect(await call('voice:record-stop', other)).toMatchObject({ ok: false })
    await call('voice:record-stop', owner)
  })

  it('cleans up a renderer lost while recordStart is still opening capture', async () => {
    const { root, native, call } = fixture(), owner = sender(91)
    const record = native.recordTake
    let release!: () => void
    native.recordTake = async args => { await new Promise<void>(resolve => { release = resolve }); return record(args) }
    const starting = call('voice:record-start', owner, request)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    owner.emit('did-start-navigation', {}, 'reload', false, true)
    release()
    expect(await starting).toMatchObject({ ok: false, message: 'Recording owner is unavailable.' })
    expect(native.finishTake).toHaveBeenCalledTimes(1)
    expect(native.stopCapture).toHaveBeenCalledTimes(1)
    const take = (await new VoiceTakeStore({ rootDir: root, native }).list(request.songId))[0]
    expect(take.status).toBe('partial-error')
  })

  it('reproduces the missing-handler negative control: renderer loss leaves an unbound store recording', async () => {
    const { native, store } = fixture(), unwatched = sender(101)
    await store.start(request) // Deliberately bypass the IPC lifetime binding.
    unwatched.emit('render-process-gone', {})
    expect((await store.level()).takeActive).toBe(true)
    expect(native.finishTake).not.toHaveBeenCalled()
    await store.stop('error')
  })

  it('waits for lost-owner capture release before opening a replacement renderer take', async () => {
    const { native, call } = fixture(), owner = sender(121), next = sender(122)
    native.recordTake = vi.fn(native.recordTake)
    const finish = native.finishTake
    let release!: () => void
    native.finishTake = vi.fn(async args => { await new Promise<void>(resolve => { release = resolve }); return finish(args) })
    await call('voice:record-start', owner, request)
    owner.emit('render-process-gone', {})
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const replacement = call('voice:record-start', next, request)
    await Promise.resolve()
    expect(native.recordTake).toHaveBeenCalledTimes(1)
    release()
    expect((await replacement).ok).toBe(true)
    expect(native.stopCapture).toHaveBeenCalledTimes(1)
    native.finishTake = finish
    await call('voice:record-stop', next)
  })

  it('keeps renderer-loss partial-error when a pending poll is also ending the take', async () => {
    const { native, store, call, setQuery } = fixture(), owner = sender(131)
    await call('voice:record-start', owner, request)
    let resolveStats!: (value: Awaited<ReturnType<VoiceTakeNative['captureStats']>>) => void
    native.captureStats = () => new Promise(resolve => { resolveStats = resolve })
    const internal = store as unknown as { active: object; checkDiscontinuity(active: object): Promise<void> }
    const poll = internal.checkDiscontinuity(internal.active)
    owner.emit('render-process-gone', {})
    native.captureStats = async () => ({ lastSampleHostNs: '2000000000', sampleRate: 44100 })
    setQuery(async () => ({ ok: true, found: false }))
    resolveStats({ lastSampleHostNs: '2000000000', sampleRate: 44100 })
    await poll
    await vi.waitFor(() => expect(native.disarmCapture).toHaveBeenCalledTimes(1))
    expect(native.finishTake).toHaveBeenCalledTimes(1)
    expect((await store.stop()).take?.status).toBe('partial-error')
  })

  it('the existing 250 ms poll ends capture on audio-process RPC failure without a renderer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { native, store, call } = fixture(), owner = sender(111)
    try {
      await call('voice:record-start', owner, request)
      native.captureStats = async () => { throw new Error('Audio process stopped') }
      await vi.advanceTimersByTimeAsync(250)
      await vi.waitFor(() => expect(native.stopCapture).toHaveBeenCalledTimes(1))
      expect(native.finishTake).toHaveBeenCalledTimes(1)
      expect((await store.stop()).take?.status).toBe('partial-error')
    } finally { vi.useRealTimers() }
  })
})

describe('ADR 0016 conform IPC leases and cancellation', () => {
  const req = { songId: 'song', takeId: 'take', requestId: 'job-1', outputRate: 48000, songDurationProjectFrames: 480000 }
  function register() {
    const sender = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false })
    const store = { setEffects: vi.fn(async () => {}), list: vi.fn(async () => [{ takeId: 'take', startPositionSec: 0.8, userOffsetSec: 0 }]) }
    registerVoiceTakeIpc(store as unknown as VoiceTakeStore)
    const call = (name: string, value: unknown, owner = sender) => voiceIpc.handlers.get(name)!({ sender: owner }, value)
    return { sender, store, call }
  }
  beforeEach(() => {
    voiceIpc.handlers.clear(); voiceIpc.conform.mockReset(); voiceIpc.invalidate.mockClear(); voiceIpc.release.mockClear()
    voiceIpc.conform.mockResolvedValue({ path: '/private/conformed-voice.wav', key: 'cache', cached: true, durationFrames: 48000, placementFrame: 0 })
  })
  it('authorizes only the main-produced WAV and releases a renderer-scoped lease after replacement', async () => {
    const { call } = register()
    const result = await call('voice:conform', req)
    expect(result).toMatchObject({ ok: true, leaseId: 'job-1' })
    expect(isAllowed(result.path)).toBe(true)
    expect(voiceIpc.conform).toHaveBeenCalledWith('song', 'take', expect.objectContaining({ retain: true, signal: expect.any(AbortSignal) }))
    await call('voice:conform-invalidate', { songId: 'song', takeId: 'take', leaseId: 'job-1' }, Object.assign(new EventEmitter(), { id: 8, isDestroyed: () => false }))
    expect(voiceIpc.release).not.toHaveBeenCalled()
    await call('voice:conform-invalidate', { songId: 'song', takeId: 'take', leaseId: 'job-1' })
    expect(voiceIpc.release).toHaveBeenCalledWith(result.path)
    expect(voiceIpc.invalidate).toHaveBeenCalledWith('song', 'take', { cancelActive: false })
  })
  it('caches waveform placement from the conform result even if the take has moved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-voice-race-')); roots.push(root)
    const path = join(root, 'placed.wav')
    const audio = wav(48000, 48000)
    for (let i = 12000; i < 48000; i++) audio.writeInt16LE(16384, 44 + i * 2)
    writeFileSync(path, audio)
    const { call, store } = register()
    voiceIpc.conform.mockResolvedValue({ path, key: 'original-placement', cached: false, durationFrames: 48000, placementFrame: 12000 })
    const first = await call('voice:conform', req)
    expect(first.waveform).toMatchObject({ offsetSec: .25, durationSec: .75 })
    expect(first.waveform.peaks.every((p: number) => p === .5)).toBe(true)
    expect(store.list).not.toHaveBeenCalled()
    await call('voice:conform-invalidate', { songId: 'song', takeId: 'take', leaseId: req.requestId })
    const again = await call('voice:conform', { ...req, requestId: 'job-2' })
    expect(again.waveform).toEqual(first.waveform)
  })
  it('does not abort a two-minute conform', async () => {
    vi.useFakeTimers()
    try {
      const { call } = register()
      let finish!: (result: unknown) => void
      voiceIpc.conform.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const pending = call('voice:conform', req)
      await vi.advanceTimersByTimeAsync(120000)
      expect(voiceIpc.conform.mock.calls[0][2].signal.aborted).toBe(false)
      finish({ path: '/missing.wav', key: 'slow', cached: false, durationFrames: 1, placementFrame: 0 })
      expect(await pending).toMatchObject({ ok: true })
    } finally { vi.useRealTimers() }
  })
  it('serializes FX writes and never starts an obsolete request after a newer request', async () => {
    const { call, store } = register()
    let finish!: () => void
    store.setEffects.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const old = call('voice:conform', { ...req, effects: defaultVoiceTakeEffects() })
    await vi.waitFor(() => expect(store.setEffects).toHaveBeenCalledTimes(1))
    const latest = call('voice:conform', { ...req, requestId: 'job-2', effects: [] })
    finish()
    expect(await old).toEqual({ ok: false, reason: 'cancelled' })
    expect(await latest).toMatchObject({ ok: true, leaseId: 'job-2' })
    expect(voiceIpc.conform).toHaveBeenCalledTimes(1)
    expect(store.setEffects).toHaveBeenLastCalledWith('song', 'take', [])
  })
  it.each([
    ['take-too-long', 'memory budget', { ok: false, reason: 'conform-failed', conformReason: 'take-too-long' }],
    ['memory-budget', 'take too long', { ok: false, reason: 'conform-failed', conformReason: 'memory-budget' }],
    ['path-too-long', 'opaque diagnostic', { ok: false, reason: 'conform-failed', conformReason: 'path-too-long' }],
    ['conform-error', 'take too long', { ok: false, reason: 'conform-failed', conformReason: 'conform-error' }],
    ['cancelled', 'memory budget', { ok: false, reason: 'cancelled' }]
  ])('prefers typed conform code %s to misleading text', async (code, message, expected) => {
    const { call } = register()
    voiceIpc.conform.mockRejectedValueOnce(new ConformTakeError(code as ConformTakeErrorCode, message as string))
    expect(await call('voice:conform', req)).toEqual(expected)
  })
  it('retains message mapping for untyped conform errors', async () => {
    const { call } = register()
    voiceIpc.conform.mockRejectedValueOnce(new Error('Conform cache is full'))
    expect(await call('voice:conform', req)).toEqual({ ok: false, reason: 'conform-failed', conformReason: 'memory-budget' })
  })
  it('cancels an in-flight conform and rejects invalid ids/rates/effects without throwing', async () => {
    const { call } = register()
    let finish!: (value: unknown) => void
    voiceIpc.conform.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = call('voice:conform', req)
    await vi.waitFor(() => expect(voiceIpc.conform).toHaveBeenCalled())
    await call('voice:conform-cancel', 'job-1')
    finish({ path: '/late.wav', key: 'x', cached: false, durationFrames: 1 })
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' })
    expect(voiceIpc.release).toHaveBeenCalledWith('/late.wav')
    for (const patch of [{ songId: '../x' }, { outputRate: NaN }, { songDurationProjectFrames: 0 }, { effects: [{ id: 'unknown' }] }])
      expect(await call('voice:conform', { ...req, ...patch })).toEqual({ ok: false, reason: 'conform-failed' })
  })
  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('releases pinned files on renderer %s', async event => {
    const { call, sender } = register()
    await call('voice:conform', req)
    sender.emit(event, {}, 'url', false, true)
    await vi.waitFor(() => expect(voiceIpc.release).toHaveBeenCalledWith('/private/conformed-voice.wav'))
  })
})

describe('monitor renderer meter-arm handoff', () => {
  it('an old cleanup never disarms a replacement arm with a reused native generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-monitor-arm-')); roots.push(root)
    const native = fakeNative(); native.disarmCapture = vi.fn(native.disarmCapture)
    const s = new VoiceTakeStore({ rootDir: root, native })
    expect((await s.arm({ input: request.input })).ok).toBe(true)
    const oldCleanup = s.monitorInputCleanup()
    expect((await s.arm({ input: request.input })).ok).toBe(true)
    await oldCleanup()
    expect(native.disarmCapture).not.toHaveBeenCalled()
    await s.monitorInputCleanup()()
    expect(native.disarmCapture).toHaveBeenCalledTimes(1)
    // Negative control: the former unscoped cleanup withdraws the new arm.
    await s.arm({ input: request.input }); const unsafe = () => s.disarm()
    await s.arm({ input: request.input }); await unsafe()
    expect(native.disarmCapture).toHaveBeenCalledTimes(2)
  })
})


describe('renderer meter arm ownership', () => {
  it('releases later arms in the same renderer epoch, but preserves replacement epochs', async () => {
    const native = fakeNative(); native.disarmCapture = vi.fn(native.disarmCapture)
    const s = new VoiceTakeStore({ native }); const epoch = {}, replacement = {}
    await s.arm({ input: request.input }, epoch)
    const cleanup = s.monitorInputCleanup(epoch)
    await s.arm({ input: request.input }, epoch)
    await cleanup()
    expect(native.disarmCapture).toHaveBeenCalledTimes(1)
    await s.arm({ input: request.input }, replacement)
    await cleanup()
    expect(native.disarmCapture).toHaveBeenCalledTimes(1)
    await s.monitorInputCleanup(replacement)()
    expect(native.disarmCapture).toHaveBeenCalledTimes(2)
  })
  it('finishes a prior native disarm before a replacement can reuse its generation', async () => {
    const native = fakeNative(); native.armCapture = vi.fn(native.armCapture)
    let finish!: (value: { ok: boolean }) => void
    native.disarmCapture = () => new Promise(resolve => { finish = resolve })
    const s = new VoiceTakeStore({ native })
    await s.arm({ input: request.input })
    const disarm = s.disarm(), replacement = s.arm({ input: request.input })
    expect(native.armCapture).toHaveBeenCalledTimes(1)
    finish({ ok: true }); await disarm; await replacement
    expect(native.armCapture).toHaveBeenCalledTimes(2)
  })
  it.each(['render-process-gone', 'destroyed', 'did-start-navigation'])('releases an arm after %s, including a late native reply', async event => {
    voiceIpc.handlers.clear()
    const native = fakeNative(); native.disarmCapture = vi.fn(native.disarmCapture)
    let finish!: (value: { ok: boolean; generation: bigint }) => void
    native.armCapture = () => new Promise(resolve => { finish = resolve })
    const s = new VoiceTakeStore({ native })
    registerVoiceTakeIpc(s)
    const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false })
    const arm = voiceIpc.handlers.get('voice:arm')!({ sender }, { input: request.input })
    sender.emit(event, {}, 'url', false, true)
    finish({ ok: true, generation: 1n })
    expect(await arm).toMatchObject({ ok: false })
    expect(native.disarmCapture).toHaveBeenCalledExactlyOnceWith(1n)
  })
})


describe('take user versus pre-existing meter Arm purpose', () => {
  it('keeps a monitor-only meter Arm monitor-only across a take; Take owns capture separately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'singz-monitor-take-purpose-')); roots.push(root)
    const native = fakeNative(); native.disarmCapture = vi.fn(native.disarmCapture)
    const s = new VoiceTakeStore({ rootDir: root, native })
    await s.arm({ input: request.input, monitorOnly: true }, {})
    expect((await s.start(request)).ok).toBe(true)
    await s.releaseMonitorInput(); expect(native.disarmCapture).not.toHaveBeenCalled() // Active Take protects capture.
    await s.stop()
    await s.releaseMonitorInput(); expect(native.disarmCapture).toHaveBeenCalledExactlyOnceWith(1n)
  })
})
