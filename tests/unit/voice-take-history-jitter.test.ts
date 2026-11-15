import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceTakeStore, type VoiceTakeNative, type VoiceTakeTransportSnapshot } from '../../src/main/voice-takes'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers() })

/** Same interval test as PlaybackPresentationHistory::query: no extrapolation
 * past a committed output callback. Input packets have an independent phase. */
function jitterFixture(tempo: number, firstMiss: false | 'once' | 'startup' = false) {
  const root = mkdtempSync(join(tmpdir(), 'singz-history-jitter-')); roots.push(root)
  const rate = 48000, frames = 128, origin = 10_000_000_000n
  const first = origin + 500_000_000n
  const jitter = [-800_000, 800_000, 0, 300_000, -200_000]
  const entries = Array.from({ length: 2300 }, (_, i) => ({
    host: origin + BigInt(Math.round(i * frames * 1e9 / rate) + jitter[i % jitter.length]),
    project: 12 * rate + i * frames * tempo
  }))
  let elapsed = 0, missing = 0, seeks = 0, loops = 0, historicalPause = false, invalidMapping = false, captureFault = false
  let state: 'playing' | 'paused' | 'completed' = 'playing'
  let queryCalls = 0
  const transportSnapshot = vi.fn(async (): Promise<VoiceTakeTransportSnapshot | null> => ({ state, seekCount: String(seeks), loopCount: String(loops) }))
  const native: VoiceTakeNative = {
    armCapture: async () => ({ ok: true }), disarmCapture: async () => ({ ok: true }),
    recordTake: async ({ dir, takeId }) => {
      mkdirSync(dir, { recursive: true })
      const wav = Buffer.alloc(44 + rate * 5 * 2)
      wav.write('RIFF'); wav.write('WAVE', 8); wav.write('fmt ', 12)
      wav.writeUInt32LE(rate, 24); wav.write('data', 36); wav.writeUInt32LE(rate * 5 * 2, 40)
      writeFileSync(join(dir, `${takeId}.wav`), wav)
      return { ok: true }
    },
    finishTake: vi.fn(async () => ({ ok: true, frames: Math.round(elapsed * rate), sampleRate: rate })),
    cancelTake: async () => ({ ok: true }),
    captureStats: async () => {
      const frame = Math.floor(elapsed * rate / frames) * frames
      return { firstSampleCaptured: true, firstSampleHostNs: first.toString(), sampleRate: rate,
        takeFrameHostNs: (first + BigInt(Math.round(frame * 1e9 / rate))).toString(), takeFrame: frame,
        firstSampleQuality: 'hardware', inputLatencyFrames: 128, inputLatencySource: 'reported', inputLatencyStable: true, gapOverflow: captureFault }
    },
    presentationQuery: async args => {
      const trim = args.trimInputLatency ? Math.round(((args.inputLatencyFrames ?? 0) + (args.outputLatencyFrames ?? 0) + (args.graphLatencyFrames ?? 0)) * 1e9 / rate) : 0
      const at = BigInt(args.firstSampleHostNs!) - BigInt(trim)
      const entry = entries.findLast(e => e.host <= at)
      const offset = entry ? Number(at - entry.host) * rate / 1e9 : Infinity
      const found = !(firstMiss === 'once' && queryCalls++ === 0) && !(firstMiss === 'startup' && elapsed === 0) && offset >= 0 && offset < frames
      if (!found) missing++
      return { ok: true, found, sampleRate: rate, outputLatencyFrames: 128, graphLatencyFrames: 7200,
        ...(found ? { songSeconds: invalidMapping ? -1 : (entry!.project + offset * tempo) / rate, paused: historicalPause,
          rate: tempo, discontinuitySerial: seeks + loops, faultSerial: seeks + loops,
          mappingStartCaptureHostNs: (origin + BigInt(trim)).toString(), mappingStartSongSeconds: 12 } : {}) }
    },
    transportState: async () => state as 'playing' | 'paused' | 'completed',
    level: async () => ({ peakDb: -20, rmsDb: -30 })
  }
  Object.assign(native, { transportSnapshot })
  const store = new VoiceTakeStore({ rootDir: root, native })
  const internal = store as unknown as { active: object | null; checkDiscontinuity(active: object): Promise<void> }
  return { store, native, transportSnapshot,
    async start() { expect((await store.start({ songId: 'song-1', songTitle: 'Song', songArtist: '',
      input: { deviceName: '', channelIndex: 0 }, tempo, transposeSemitones: 0 })).ok).toBe(true) },
    async poll(at: number) { elapsed = at; if (internal.active) await internal.checkDiscontinuity(internal.active) },
    missing: () => missing,
    baseline: () => (internal.active as { transportSnapshot?: VoiceTakeTransportSnapshot } | null)?.transportSnapshot,
    seek: () => { seeks++ }, loop: () => { loops++ }, pause: () => { state = 'paused' }, end: () => { state = 'completed' },
    misreportPause: () => { historicalPause = true },
    invalidateMapping: () => { invalidMapping = true }, breakCapture: () => { captureFault = true }
  }
}

describe('native recording with independent jittered callback histories', () => {
  it('retries a null start snapshot and still ends a seek in the reviewer probe', async () => {
    const f = jitterFixture(1.25)
    try {
      f.transportSnapshot.mockResolvedValueOnce(null)
      await f.start()
      expect(f.transportSnapshot).toHaveBeenCalledTimes(2)
      await f.poll(.5); f.seek()
      for (let t = .75; t <= 5; t += .25) await f.poll(t)
      expect(f.native.finishTake).toHaveBeenCalledOnce()
      expect(await f.store.stop()).toMatchObject({ note: 'seek' })
    } finally { await f.store.cancel() }
  })

  it.each(['seek', 'loop'] as const)('uses positive history evidence for a %s when no current baseline is ever available', async boundary => {
    const f = jitterFixture(1.25)
    try {
      f.transportSnapshot.mockResolvedValue(null)
      await f.start(); await f.poll(.5)
      expect(f.baseline()).toBeUndefined()
      f[boundary]()
      for (let t = .75; t <= 5; t += .25) await f.poll(t)
      expect(f.native.finishTake).toHaveBeenCalledOnce()
      expect(await f.store.stop()).toMatchObject({ note: 'seek' })
    } finally { await f.store.cancel() }
  })

  it('adopts a late current baseline on continuous history and catches the next seek through its counters', async () => {
    const f = jitterFixture(1.25)
    try {
      f.transportSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      await f.start()
      expect(f.transportSnapshot).toHaveBeenCalledTimes(3)
      expect(f.baseline()).toBeUndefined()
      await f.poll(0)
      expect(f.baseline()).toMatchObject({ seekCount: '0', loopCount: '0' })
      expect(f.native.finishTake).not.toHaveBeenCalled()
      f.seek(); await f.poll(1)
      expect(f.native.finishTake).toHaveBeenCalledOnce()
      expect(await f.store.stop()).toMatchObject({ note: 'seek' })
    } finally { await f.store.cancel() }
  })

  it('does not adopt a first current snapshot over existing seek evidence', async () => {
    const f = jitterFixture(1.25)
    try {
      f.transportSnapshot.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      await f.start(); f.seek(); await f.poll(0)
      expect(f.native.finishTake).toHaveBeenCalledOnce()
      expect(await f.store.stop()).toMatchObject({ note: 'seek' })
    } finally { await f.store.cancel() }
  })

  it.each([1.25, .75, 1.1, 1.5])('records the full five seconds at %sx despite uncovered callback timestamps', async tempo => {
    const f = jitterFixture(tempo)
    try {
      await f.start()
      for (let t = .25; t <= 5; t += .25) {
        await f.poll(t)
        expect(f.native.finishTake).not.toHaveBeenCalled()
        if (t === .5) expect(await f.store.list('song-1')).toEqual([])
      }
      expect(f.missing()).toBeGreaterThan(0)
      expect(await f.store.stop()).toMatchObject({ ok: true, take: { status: 'complete', durationSec: 5 } })
      const list = await f.store.list('song-1')
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ status: 'complete', durationSec: 5 })
    } finally { await f.store.cancel() }
  })

  it.each(['once', 'startup'] as const)('does not turn an initial %s coverage miss into a delayed placement error', async missing => {
    const f = jitterFixture(1.25, missing)
    try {
      await f.start()
      for (let t = .25; t <= 5; t += .25) { await f.poll(t); expect(f.native.finishTake).not.toHaveBeenCalled() }
      expect(await f.store.stop()).toMatchObject({ take: { status: 'complete', durationSec: 5 } })
    } finally { await f.store.cancel() }
  })

  it.each(['seek', 'loop', 'pause', 'end'] as const)('still ends the take for a confirmed native %s', async boundary => {
    const f = jitterFixture(1.25)
    try {
      await f.start(); await f.poll(.5)
      f[boundary]()
      await f.poll(1)
      expect(f.native.finishTake).toHaveBeenCalledOnce()
      expect(await f.store.stop()).toMatchObject({ ok: true, note: boundary === 'pause' ? 'pause' : boundary === 'end' ? 'song-end' : 'seek' })
    } finally { await f.store.cancel() }
  })

  it('cross-checks an apparent historical pause against the still-playing native transport', async () => {
    const f = jitterFixture(1.25)
    try {
      await f.start(); f.misreportPause()
      for (let t = .25; t <= 5; t += .25) { await f.poll(t); expect(f.native.finishTake).not.toHaveBeenCalled() }
      expect(await f.store.stop()).toMatchObject({ take: { status: 'complete', durationSec: 5 } })
    } finally { await f.store.cancel() }
  })

  it.each(['initial', 'later'] as const)('preserves all PCM when an unconfirmed %s mapping is invalid', async when => {
    const f = jitterFixture(1.25)
    try {
      if (when === 'initial') f.invalidateMapping()
      await f.start()
      for (let t = .25; t <= 5; t += .25) {
        if (when === 'later' && t >= 1) f.invalidateMapping()
        await f.poll(t)
        expect(f.native.finishTake).not.toHaveBeenCalled()
      }
      expect(await f.store.stop()).toMatchObject({ take: { status: 'partial-error', durationSec: 5 } })
    } finally { await f.store.cancel() }
  })

  it('still stops on a real capture overflow', async () => {
    const f = jitterFixture(1.25)
    try {
      await f.start(); f.breakCapture(); await f.poll(.25)
      expect(f.native.finishTake).toHaveBeenCalledOnce()
      expect(await f.store.stop()).toMatchObject({ take: { status: 'partial-error' } })
    } finally { await f.store.cancel() }
  })

  it('does not fall back to a stale stopped state when fresh callback telemetry is unavailable', async () => {
    const f = jitterFixture(1.25)
    try {
      await f.start()
      f.transportSnapshot.mockResolvedValue(null)
      f.native.transportState = vi.fn(async () => 'stopped')
      f.misreportPause()
      for (let t = .25; t <= 5; t += .25) { await f.poll(t); expect(f.native.finishTake).not.toHaveBeenCalled() }
      expect(f.native.transportState).not.toHaveBeenCalled()
      expect(await f.store.stop()).toMatchObject({ take: { status: 'complete', durationSec: 5 } })
    } finally { await f.store.cancel() }
  })
})
