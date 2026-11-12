import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceTakeStore, type VoiceTakeNative } from '../../src/main/voice-takes'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const wav = (sampleRate = 22050, frames = sampleRate, declaredBytes = frames * 2): Buffer => { const b = Buffer.alloc(44 + frames * 2); b.write('RIFF', 0); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(sampleRate, 24); b.write('data', 36); b.writeUInt32LE(declaredBytes, 40); return b }

const fakeNative = (finish: Partial<Awaited<ReturnType<VoiceTakeNative['finishTake']>>> = {}, placement: Partial<Awaited<ReturnType<VoiceTakeNative['presentationQuery']>>> = {}): VoiceTakeNative => ({
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
})

