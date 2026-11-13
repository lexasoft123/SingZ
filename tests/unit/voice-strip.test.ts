/*
 * Voice strip (ADR 0014, spec §4): the state machine over fake engine / bridge
 * ports, the three-language key set, and the strip's accessible markup.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../../src/shared/i18n/en'
import { voice as voiceEn } from '../../src/shared/i18n/en/voice'
import { setLocale, t } from '../../src/shared/i18n'
import { loadVoiceStrings } from '../../src/renderer/src/components/voice-strings'
import {
  canPressRecord,
  createBridgeVoiceApi,
  INITIAL_VOICE_MODEL,
  primaryState,
  recordBlock,
  stableVoiceSongId,
  takeGain,
  songSpan,
  monitorDbToFader,
  monitorFaderToDb,
  VOICE_CONTEXT_EVENT,
  voiceControllerFor,
  VOICE_STATES,
  VoiceController,
  type VoiceEnginePort,
  type VoiceInputOption,
  type VoiceModel,
  type VoiceTakeApi
} from '../../src/renderer/src/audio/voice-take'
import VoiceStrip from '../../src/renderer/src/components/VoiceStrip'
import { MonitorChipView } from '../../src/renderer/src/components/VoiceMonitorChip'
import Tooltip, { placeTip, TipController, TIP_DELAY_MS } from '../../src/renderer/src/components/Tooltip'
import { takeIsSilent } from '../../src/renderer/src/components/voice-format'
import VoiceTrackSettings from '../../src/renderer/src/components/VoiceTrackSettings'
import { VoiceRecordButton } from '../../src/renderer/src/components/voice-record-button'
import type { VoiceMonitorState, VoiceTakeSummary } from '../../src/shared/voice-take'

const monState = (over: Partial<VoiceMonitorState> = {}): VoiceMonitorState => ({
  available: true,
  on: false,
  gainDb: 0,
  latency: { sampleRate: 48000, requestedFrames: 32, bufferFrames: 64, inputDeviceFrames: 0, outputDeviceFrames: 0, roundTripFrames: 288, roundTripMs: 6, source: 'estimated' },
  warnings: [],
  ...over
})
const summary = (over: Partial<VoiceTakeSummary> = {}): VoiceTakeSummary => ({
  takeId: 'take-1',
  songId: 'song-1',
  createdAt: '2026-11-12T10:00:00Z',
  startPositionSec: 30,
  durationSec: 10,
  status: 'complete',
  name: null,
  tempo: 1,
  transposeSemitones: 0,
  settingsChanged: false,
  ...over
})

function fakeEngine(): VoiceEnginePort & { _playing: boolean; _pos: number; _tempo: number; _tr: number } {
  const e = {
    _playing: false,
    _pos: 30,
    _tempo: 1,
    _tr: 0,
    duration: 200,
    get playing() { return e._playing },
    get position() { return e._pos },
    get tempo() { return e._tempo },
    get transpose() { return e._tr },
    play: vi.fn(async () => { e._playing = true }),
    pause: vi.fn(() => { e._playing = false }),
    seek: vi.fn((t: number) => { e._pos = t }),
    setTempo: vi.fn(async (r: number) => { e._tempo = r }),
    setTranspose: vi.fn(async (s: number) => { e._tr = s }),
    stems: new Map<string, boolean>([['vocals', false], ['drums', false], ['bass', true]]),
    getTrackStates: () => [...e.stems].map(([id, muted]) => ({ id, muted })),
    setMuted: vi.fn((id: string, muted: boolean) => { e.stems.set(id, muted) })
  }
  return e
}

function fakeApi(over: Partial<VoiceTakeApi> = {}): VoiceTakeApi & Record<keyof VoiceTakeApi, ReturnType<typeof vi.fn>> {
  const api = {
    recordStart: vi.fn(async () => ({ ok: true as const, takeId: 'take-1' })),
    recordStop: vi.fn(async () => ({ ok: true, take: summary() })),
    recordSettings: vi.fn(async () => ({ ok: true })),
    list: vi.fn(async () => [] as VoiceTakeSummary[]),
    play: vi.fn(async () => ({ ok: true })),
    stopPlay: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => ({ ok: true })),
    peaks: vi.fn(async () => ({ ok: false as const, error: 'no peaks in this fake' })),
    move: vi.fn(async (req: { userOffsetSec: number }) => ({ ok: true as const, take: summary({ userOffsetSec: req.userOffsetSec }) })),
    level: vi.fn(async () => ({ peakDb: -20, rmsDb: -30 })),
    arm: vi.fn(async () => ({ ok: true as const })),
    monitorAvailability: vi.fn(async () => monState({ on: false })),
    monitorSet: vi.fn(async (req: { on: boolean }) => monState({ on: req.on })),
    monitorGain: vi.fn(async () => monState({ on: true })),
    monitorState: vi.fn(async () => monState({ on: true })),
    disarm: vi.fn(async () => ({ ok: true })),
    ...over
  }
  return api as never
}

let clock = 0
async function setup(
  apiOver: Partial<VoiceTakeApi> = {},
  engineOver?: (e: ReturnType<typeof fakeEngine>) => void,
  inputs: VoiceInputOption[] = [{ id: 'mic', label: 'Scarlett 2i2' }],
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = null
) {
  const engine = fakeEngine()
  engineOver?.(engine)
  const api = fakeApi(apiOver)
  const c = new VoiceController({
    api,
    engine,
    askMicAccess: async () => true,
    listInputs: async () => ({ inputs, labelsHidden: false }),
    now: () => clock,
    storage
  })
  await c.setSong('song-1')
  await c.refreshInputs()
  return { c, engine, api }
}

beforeEach(() => {
  clock = 0
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('primaryState precedence (spec 4.1)', () => {
  const m = (over: Partial<VoiceModel>): VoiceModel => ({ ...INITIAL_VOICE_MODEL, songId: 's', ...over })
  const take = { takeId: 't', n: 1, startSec: 0, durationSec: 5, tempo: 1, transpose: 0, timeline: [{ atSec: 0, tempo: 1, transpose: 0 }], changed: false, kept: false, partial: false, recovered: false }
  it('orders error > recording > playing > review > permission > missing > monitoring > armed > idle', () => {
    expect(primaryState(m({}))).toBe('idle')
    expect(primaryState(m({ armed: true }))).toBe('armed')
    expect(primaryState(m({ armed: true, monitor: { ...INITIAL_VOICE_MODEL.monitor, on: true } }))).toBe('monitoring-on')
    expect(primaryState(m({ monitor: { ...INITIAL_VOICE_MODEL.monitor, avail: 'latency' } }))).toBe('monitoring-unavailable-latency')
    expect(primaryState(m({ monitor: { ...INITIAL_VOICE_MODEL.monitor, avail: 'route' } }))).toBe('monitoring-unavailable-route')
    expect(primaryState(m({ inputMissing: true, monitor: { ...INITIAL_VOICE_MODEL.monitor, avail: 'route' } }))).toBe('input-missing')
    expect(primaryState(m({ armed: true, monitor: { ...INITIAL_VOICE_MODEL.monitor, avail: 'route' } }))).toBe('armed')
    expect(primaryState(m({ perm: 'denied', inputMissing: true }))).toBe('permission-needed')
    expect(primaryState(m({ take, perm: 'denied' }))).toBe('take-review')
    expect(primaryState(m({ take, listen: 'take' }))).toBe('playing-take')
    expect(primaryState(m({ take, listen: 'take', recording: true }))).toBe('recording')
    expect(primaryState(m({ recording: true, error: 'error' }))).toBe('error-recoverable')
  })
  it('a kept take no longer holds the strip in take-review', () => {
    expect(primaryState(m({ take: { ...take, kept: true } }))).toBe('idle')
  })
  it('names all eleven states', () => {
    expect(VOICE_STATES).toHaveLength(11)
  })
  it('blocks Record only for a denied mic, no input, an error, no song; a take under review or playing never blocks', () => {
    expect(recordBlock(m({}))).toBeNull()
    expect(recordBlock(m({ take }))).toBeNull()
    expect(recordBlock(m({ take: { ...take, kept: true } }))).toBeNull()
    expect(recordBlock(m({ perm: 'denied' }))).toBe('perm')
    expect(recordBlock(m({ inputMissing: true }))).toBe('missing')
    expect(recordBlock(m({ error: 'error' }))).toBe('error')
    expect(recordBlock(m({ take: { ...take, kept: true }, listen: 'take' }))).toBeNull()
    expect(recordBlock({ ...INITIAL_VOICE_MODEL })).toBe('no-song')
    expect(canPressRecord(m({ recording: true, take }))).toBe(true)
  })
})

describe('recording', () => {
  it('starts the song when paused, records, and reviews on stop', async () => {
    const { c, engine, api } = await setup()
    expect(c.state).toBe('idle')
    await c.toggleRecord()
    expect(api.recordStart).toHaveBeenCalledWith(expect.objectContaining({ songId: 'song-1', input: { deviceName: 'Scarlett 2i2', channelIndex: 0 }, tempo: 1, transposeSemitones: 0 }))
    expect(engine.play).toHaveBeenCalled()
    expect(c.state).toBe('recording')
    clock = 4000
    await c.toggleRecord()
    expect(api.recordStop).toHaveBeenCalled()
    expect(engine.pause).toHaveBeenCalled()
    expect(c.state).toBe('take-review')
    expect(c.getSnapshot().take).toMatchObject({ takeId: 'take-1', durationSec: 10, kept: false })
    c.dispose()
  })

  it('does not restart a song that is already playing', async () => {
    const { c, engine } = await setup({}, (e) => { e._playing = true })
    await c.startRecording()
    expect(engine.play).not.toHaveBeenCalled()
    c.dispose()
  })

  it('one press records from the unarmed idle state, like Play; a second press stops and keeps the take', async () => {
    const { c, api } = await setup()
    expect(c.getSnapshot().armed).toBe(false)
    expect(c.state).toBe('idle')
    await c.toggleRecord()
    // negative control: the old flow needed arm first and a second press
    expect(api.recordStart).toHaveBeenCalledTimes(1)
    expect(c.state).toBe('recording')
    await c.toggleRecord()
    expect(c.state).toBe('take-review')
    c.dispose()
  })
  it('Record with a take under review keeps it and starts a new take; with a take playing it stops the playback', async () => {
    const { c, api } = await setup()
    await c.toggleRecord()
    await c.toggleRecord()
    expect(c.getSnapshot().take?.kept).toBe(false)
    api.recordStart.mockClear()
    await c.listen('take')
    expect(c.getSnapshot().listen).toBe('take')
    await c.toggleRecord()
    expect(api.stopPlay).toHaveBeenCalled()
    expect(api.recordStart).toHaveBeenCalledTimes(1)
    expect(c.state).toBe('recording')
    expect(api.remove).not.toHaveBeenCalled() // the earlier take's file stays
    c.dispose()
  })
  it('the live level builds the take waveform while recording and it stays after stop', async () => {
    const { c } = await setup()
    await c.toggleRecord()
    for (let i = 0; i < 6; i++) {
      clock += 50
      await c.pollLevel()
    }
    clock += 100
    c.tick()
    const live = c.getSnapshot().take?.peaks
    expect(live?.some((p) => p > 0.05 && p <= 1)).toBe(true) // -20 dB is about 0.1
    await c.toggleRecord()
    expect(c.getSnapshot().take?.peaks).toEqual(live)
    c.dispose()
  })
  it('discard still removes the take', async () => {
    const { c, api } = await setup()
    await c.toggleRecord()
    await c.toggleRecord()
    c.keep()
    expect(c.state).toBe('idle')
    expect(recordBlock(c.getSnapshot())).toBeNull()
    await c.discard()
    expect(api.remove).toHaveBeenCalledWith('song-1', 'take-1')
    expect(c.getSnapshot().take).toBeNull()
    c.dispose()
  })

  it('reports tempo and transpose changes during a take and tags it', async () => {
    const { c, engine, api } = await setup()
    await c.toggleRecord()
    clock = 100
    engine._pos = 30.1
    engine._tempo = 0.8
    engine._tr = -2
    c.tick()
    expect(api.recordSettings).toHaveBeenCalledWith({ takeId: 'take-1', tempo: 0.8, transposeSemitones: -2 })
    expect(c.getSnapshot().take).toMatchObject({ tempo: 0.8, transpose: -2, changed: true })
    c.dispose()
  })

  it('a seek during a take stops it (M1 simplification)', async () => {
    const { c, engine, api } = await setup()
    await c.toggleRecord()
    clock = 100
    engine._pos = 90
    c.tick()
    await vi.waitFor(() => expect(c.state).toBe('take-review'))
    expect(api.recordStop).toHaveBeenCalled()
    expect(c.getSnapshot().stoppedBy).toBe('seek')
    c.dispose()
  })

  it('pausing the song during a take stops it', async () => {
    const { c, engine } = await setup()
    await c.toggleRecord()
    clock = 100
    engine._playing = false
    c.tick()
    await vi.waitFor(() => expect(c.state).toBe('take-review'))
    c.dispose()
  })

  it('maps start failures: permission, no input, busy, missing bridge', async () => {
    let r = await setup({ recordStart: vi.fn(async () => ({ ok: false as const, reason: 'permission' as const, message: '' })) })
    await r.c.toggleRecord()
    expect(r.c.state).toBe('permission-needed')
    r = await setup({ recordStart: vi.fn(async () => ({ ok: false as const, reason: 'no-input' as const, message: '' })) })
    await r.c.toggleRecord()
    expect(r.c.state).toBe('input-missing')
    r = await setup({ recordStart: vi.fn(async () => ({ ok: false as const, reason: 'busy' as const, message: '' })) })
    await r.c.toggleRecord()
    expect(r.c.state).toBe('error-recoverable')
    expect(r.c.getSnapshot().error).toBe('busy')
    r.c.retry()
    expect(r.c.state).toBe('idle')
    const missing = new VoiceController({
      api: createBridgeVoiceApi(() => undefined),
      engine: fakeEngine(),
      askMicAccess: async () => true,
      listInputs: async () => ({ inputs: [{ id: 'm', label: 'm' }], labelsHidden: false }),
      now: () => clock
    })
    await missing.setSong('s')
    await missing.refreshInputs()
    await missing.toggleRecord()
    expect(missing.getSnapshot().error).toBe('no-bridge')
  })

  it('a device lost mid-take keeps the salvaged take and enters error-recoverable', async () => {
    const { c } = await setup({
      recordStop: vi.fn(async () => ({ ok: false, reason: 'device-lost' as const, take: summary({ durationSec: 12, status: 'partial-device-lost' }) }))
    })
    await c.toggleRecord()
    await c.toggleRecord()
    expect(c.state).toBe('error-recoverable')
    expect(c.getSnapshot().take).toMatchObject({ partial: true, durationSec: 12 })
    c.retry()
    expect(c.state).toBe('take-review')
    c.dispose()
  })

  it('arm toggles and resets the clip latch', async () => {
    const { c } = await setup()
    c.setLevelDb(0)
    expect(c.getSnapshot().clipped).toBe(true)
    await c.arm()
    expect(c.state).toBe('armed')
    expect(c.getSnapshot().clipped).toBe(false)
    c.setLevelDb(-3)
    expect(c.getSnapshot().clipped).toBe(false)
    c.setLevelDb(-0.05)
    expect(c.getSnapshot().clipped).toBe(true)
    c.resetClip()
    expect(c.getSnapshot().clipped).toBe(false)
    await c.arm()
    expect(c.state).toBe('idle')
    c.dispose()
  })

  it('a new recording resets the clip latch', async () => {
    const { c } = await setup()
    c.setLevelDb(0)
    await c.toggleRecord()
    expect(c.getSnapshot().clipped).toBe(false)
    c.dispose()
  })
})

describe('start ordering and races', () => {
  it('plays the song first and only then opens capture (never records paused)', async () => {
    const { c, engine, api } = await setup()
    api.recordStart.mockImplementation(async () => {
      expect(engine._playing).toBe(true)
      return { ok: true, takeId: 'take-1' }
    })
    await c.toggleRecord()
    expect(engine.play.mock.invocationCallOrder[0]).toBeLessThan(api.recordStart.mock.invocationCallOrder[0])
    c.dispose()
  })

  it('waits until the engine reports playing, with a timeout and an error path', async () => {
    const { c, engine, api } = await setup({}, (e) => {
      e.play.mockImplementation(async () => undefined) // resolves but never plays
    })
    const started = c.toggleRecord()
    for (let i = 0; i < 130; i++) {
      clock += 25
      await vi.advanceTimersByTimeAsync(25)
    }
    await started
    expect(api.recordStart).not.toHaveBeenCalled()
    expect(c.getSnapshot().error).toBe('error')
    expect(engine._playing).toBe(false)
    c.dispose()
  })

  it('a rejected song start never reaches capture', async () => {
    const { c, api } = await setup({}, (e) => {
      e.play.mockRejectedValue(new Error('no audio'))
    })
    await c.toggleRecord()
    expect(api.recordStart).not.toHaveBeenCalled()
    expect(c.state).toBe('error-recoverable')
    c.dispose()
  })

  it('a song change while recordStart is in flight stops main and removes the take', async () => {
    let resolve!: (v: { ok: true; takeId: string }) => void
    const { c, api } = await setup({
      recordStart: vi.fn(() => new Promise<{ ok: true; takeId: string }>((r) => { resolve = r }))
    })
    const started = c.toggleRecord()
    await vi.waitFor(() => expect(api.recordStart).toHaveBeenCalled())
    await c.setSong('song-2')
    resolve({ ok: true, takeId: 'late' })
    await started
    expect(api.recordStop).toHaveBeenCalled()
    expect(api.remove).toHaveBeenCalledWith('song-1', 'late')
    expect(c.getSnapshot().recording).toBe(false)
    expect(c.getSnapshot().take).toBeNull()
    c.dispose()
  })

  it('leaves recording when main reports the take is no longer active', async () => {
    const { c, api } = await setup()
    await c.toggleRecord()
    clock = 500
    api.level.mockResolvedValue({ peakDb: -20, rmsDb: -30, takeActive: false })
    await c.pollLevel()
    await vi.waitFor(() => expect(c.state).toBe('take-review'))
    expect(api.recordStop).toHaveBeenCalled()
    expect(c.getSnapshot().stoppedBy).toBe('auto')
    c.dispose()
  })

  it('keeps recording while takeActive is true or a poll predates the take', async () => {
    const { c, api } = await setup()
    clock = 1000
    await c.toggleRecord()
    api.level.mockResolvedValue({ peakDb: -20, rmsDb: -30, takeActive: true })
    await c.pollLevel()
    expect(c.state).toBe('recording')
    clock = 1000
    api.level.mockImplementation(async () => {
      clock = 1200
      return { peakDb: -20, rmsDb: -30, takeActive: false }
    })
    clock = 900 // issued before the take started
    await c.pollLevel()
    expect(c.state).toBe('recording')
    c.dispose()
  })
})

describe('stable song identity', () => {
  it('is the same across sessions for one song and differs between songs', () => {
    const a1 = stableVoiceSongId({ path: '/music/a.mp3', projectDir: null })
    const a2 = stableVoiceSongId({ path: '/music/a.mp3', projectDir: null })
    const b = stableVoiceSongId({ path: '/music/b.mp3', projectDir: null })
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(stableVoiceSongId({ path: '/x', projectDir: '/lib/Wild World' })).toBe(
      stableVoiceSongId({ path: '/other', projectDir: '/lib/Wild World/' })
    )
    expect(stableVoiceSongId({ path: '/x', projectDir: '/lib//Wild World' })).toBe(
      stableVoiceSongId({ path: '/x', projectDir: '/lib/Wild World' })
    )
    expect(stableVoiceSongId({ path: '/x', projectDir: 'C:\\lib\\Wild World\\' })).toBe(
      stableVoiceSongId({ path: '/x', projectDir: 'C:/lib/Wild World' })
    )
  })
  it('treats Windows paths as case-insensitive and POSIX paths as case-sensitive', () => {
    expect(stableVoiceSongId({ path: 'x', projectDir: 'C:\\Lib\\Song' })).toBe(stableVoiceSongId({ path: 'x', projectDir: 'c:\\lib\\song' }))
    expect(stableVoiceSongId({ path: 'C:\\Music\\A.mp3', projectDir: null })).toBe(stableVoiceSongId({ path: 'c:/music/a.mp3', projectDir: null }))
    expect(stableVoiceSongId({ path: 'x', projectDir: '\\\\Server\\Share\\Song' })).toBe(stableVoiceSongId({ path: 'x', projectDir: '\\\\server\\share\\song' }))
    expect(stableVoiceSongId({ path: 'x', projectDir: '/Lib/Song' })).not.toBe(stableVoiceSongId({ path: 'x', projectDir: '/lib/song' }))
  })
  it('does not mix up projects that share a folder name in different parents', () => {
    expect(stableVoiceSongId({ path: '/a', projectDir: '/lib/one/Untitled' })).not.toBe(
      stableVoiceSongId({ path: '/a', projectDir: '/lib/two/Untitled' })
    )
    expect(stableVoiceSongId({ path: '/a', projectDir: '/lib/Old' })).not.toBe(stableVoiceSongId({ path: '/a', projectDir: '/lib/New' }))
  })
  it('is a directory-safe slug, not the per-launch load token', () => {
    expect(stableVoiceSongId({ path: 'C:\\Music\\a b/é?.mp3', projectDir: null })).toMatch(/^song-[0-9a-f]{16}$/)
  })
})

describe('listening', () => {
  const withTake = async (over: Partial<VoiceTakeSummary> = {}) => {
    const r = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary(over) })) })
    await r.c.toggleRecord()
    await r.c.toggleRecord()
    return r
  }
  it('Listen plays the take alone and stops after its length', async () => {
    const { c, api, engine } = await withTake()
    clock = 0
    await c.listen('take')
    expect(api.play).toHaveBeenCalledWith({ takeId: 'take-1', mode: 'take', gain: takeGain(100, false) })
    expect(engine.play).toHaveBeenCalledTimes(1) // only the recording start
    expect(c.state).toBe('playing-take')
    clock = 11_000
    c.tick()
    await vi.waitFor(() => expect(c.state).toBe('take-review'))
    expect(api.stopPlay).toHaveBeenCalled()
    c.dispose()
  })
  it('Listen with song sets the take settings first, then plays song and take', async () => {
    const { c, api, engine } = await withTake({ tempo: 0.8, transposeSemitones: -2, startPositionSec: 42 })
    await c.listen('with-song')
    expect(engine.setTempo).toHaveBeenCalledWith(0.8)
    expect(engine.setTranspose).toHaveBeenCalledWith(-2)
    expect(engine.seek).toHaveBeenCalledWith(42)
    expect(api.play).toHaveBeenCalledWith({ takeId: 'take-1', mode: 'with-song', gain: takeGain(100, false) })
    expect(engine._playing).toBe(true)
    await c.stopListening()
    expect(engine._playing).toBe(false)
    expect(c.state).toBe('take-review')
    c.dispose()
  })
  it('pausing the song ends Listen with song', async () => {
    const { c, engine } = await withTake()
    await c.listen('with-song')
    clock += 100
    engine._playing = false
    c.tick()
    await vi.waitFor(() => expect(c.getSnapshot().listen).toBeNull())
    c.dispose()
  })
})

describe('take level, mute and solo (VS-PLAY-004/006)', () => {
  const withTake = async () => {
    const r = await setup()
    await r.c.toggleRecord()
    await r.c.toggleRecord()
    return r
  }
  it('defaults the take level to the native maximum', () => {
    expect(INITIAL_VOICE_MODEL.level).toBe(100)
    expect(takeGain(INITIAL_VOICE_MODEL.level, false)).toBeCloseTo(0.891, 3)
  })
  it('maps the fader to linear gain: 100 is the native maximum (-1 dB), 0 and mute are silent, no boost', () => {
    expect(takeGain(100, false)).toBeCloseTo(0.891, 3)
    expect(takeGain(100, false)).toBeLessThanOrEqual(0.891)
    expect(takeGain(0, false)).toBe(0)
    expect(takeGain(100, true)).toBe(0)
    expect(takeGain(50, false)).toBeCloseTo(0.891 * 10 ** (-30 / 20), 3)
    // strictly increasing: no part of the scale plays identically (native clamps above 0.891)
    for (let l = 1; l < 100; l++) expect(takeGain(l + 1, false)).toBeGreaterThan(takeGain(l, false))
  })
  it('sends the level and mute as gain on every play request', async () => {
    const { c, api } = await withTake()
    c.setLevel(60)
    await c.listen('take')
    expect(api.play).toHaveBeenLastCalledWith({ takeId: 'take-1', mode: 'take', gain: takeGain(60, false) })
    await c.stopListening()
    c.toggleTakeMute()
    await c.listen('take')
    expect(api.play).toHaveBeenLastCalledWith({ takeId: 'take-1', mode: 'take', gain: 0 })
    c.dispose()
  })
  it('solo: Listen with song mutes the stems that were audible and restores them after', async () => {
    const { c, engine } = await withTake()
    c.toggleSolo()
    await c.listen('with-song')
    expect(engine.stems.get('vocals')).toBe(true)
    expect(engine.stems.get('drums')).toBe(true)
    await c.stopListening()
    expect(engine.stems.get('vocals')).toBe(false)
    expect(engine.stems.get('drums')).toBe(false)
    expect(engine.stems.get('bass')).toBe(true) // was muted before: stays muted
    c.dispose()
  })
  it('dispose during a soloed listen restores the stems and pauses the song', async () => {
    const { c, engine } = await withTake()
    c.toggleSolo()
    await c.listen('with-song')
    expect(engine.stems.get('vocals')).toBe(true)
    c.dispose()
    expect(engine.stems.get('vocals')).toBe(false)
    expect(engine.stems.get('drums')).toBe(false)
    expect(engine.stems.get('bass')).toBe(true)
    expect(engine._playing).toBe(false)
    expect(c.getSnapshot().listen).toBeNull()
  })
  it('a song change during a soloed listen restores the stems', async () => {
    const { c, engine } = await withTake()
    c.toggleSolo()
    await c.listen('with-song')
    await c.setSong('song-2')
    expect(engine.stems.get('vocals')).toBe(false)
    expect(engine.stems.get('drums')).toBe(false)
    expect(c.getSnapshot().listen).toBeNull()
    c.dispose()
  })
  it('a controller created after a teardown restores stems left muted by the previous one', async () => {
    const { c, engine, api } = await withTake()
    c.toggleSolo()
    await c.listen('with-song')
    // simulate a teardown that never ran (page-level unmount): stems stay muted
    engine.stems.set('vocals', true)
    engine.stems.set('drums', true)
    // a different path: leftovers are recorded per engine, a new controller restores them
    new VoiceController({
      api,
      engine,
      askMicAccess: async () => true,
      listInputs: async () => ({ inputs: [], labelsHidden: false }),
      now: () => clock,
      storage: null
    })
    expect(engine.stems.get('vocals')).toBe(false)
    expect(engine.stems.get('drums')).toBe(false)
    expect(engine.stems.get('bass')).toBe(true)
    c.dispose()
  })
  it('dispose while api.play is still pending restores the stems, stops native play and never starts listening', async () => {
    let finish!: (v: { ok: boolean }) => void
    const { c, engine, api } = await withTake()
    api.play.mockImplementation(() => new Promise<{ ok: boolean }>((r) => { finish = r }))
    c.toggleSolo()
    const listening = c.listen('with-song')
    await vi.waitFor(() => expect(api.play).toHaveBeenCalled())
    expect(engine.stems.get('vocals')).toBe(true)
    c.dispose()
    expect(engine.stems.get('vocals')).toBe(false)
    expect(engine.stems.get('drums')).toBe(false)
    expect(engine.stems.get('bass')).toBe(true)
    expect(engine._playing).toBe(false)
    await vi.waitFor(() => expect(api.stopPlay).toHaveBeenCalled())
    finish({ ok: true })
    await listening
    expect(c.getSnapshot().listen).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('a song change while api.play is pending cancels the listen', async () => {
    let finish!: (v: { ok: boolean }) => void
    const { c, api } = await withTake()
    api.play.mockImplementation(() => new Promise<{ ok: boolean }>((r) => { finish = r }))
    const listening = c.listen('take')
    await vi.waitFor(() => expect(api.play).toHaveBeenCalled())
    await c.setSong('song-2')
    finish({ ok: true })
    await listening
    expect(c.getSnapshot().listen).toBeNull()
    expect(api.stopPlay).toHaveBeenCalled()
    c.dispose()
  })
  it('without solo the stems are left alone', async () => {
    const { c, engine } = await withTake()
    await c.listen('with-song')
    expect(engine.setMuted).not.toHaveBeenCalled()
    c.dispose()
  })
})

describe('Listen with song follows the song position (D4) and surfaces start errors (D1)', () => {
  const withTake = async (over: Partial<VoiceTakeSummary> = {}) => {
    const r = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary(over) })) })
    await r.c.toggleRecord()
    await r.c.toggleRecord()
    return r
  }
  it('ends when the song position passes startPositionSec + duration * tempo, however it got there', async () => {
    const { c, engine } = await withTake({ startPositionSec: 30, durationSec: 10, tempo: 0.8 })
    await c.listen('with-song')
    clock += 60_000 // wall-clock length is irrelevant while listening with the song
    engine._pos = 37.9
    c.tick()
    expect(c.getSnapshot().listen).toBe('with-song')
    engine._pos = 38.1 // 30 + 10 * 0.8 = 38
    c.tick()
    await vi.waitFor(() => expect(c.getSnapshot().listen).toBeNull())
    c.dispose()
  })
  it('a seek past the end during Listen with song stops it; a seek back keeps it', async () => {
    const { c, engine } = await withTake({ startPositionSec: 30, durationSec: 10 })
    await c.listen('with-song')
    engine._pos = 31
    c.tick()
    expect(c.getSnapshot().listen).toBe('with-song')
    engine._pos = 120
    c.tick()
    await vi.waitFor(() => expect(c.getSnapshot().listen).toBeNull())
    c.dispose()
  })
  it('plays the song before seeking, and shows a failing seek instead of swallowing it', async () => {
    const { c, engine, api } = await withTake()
    engine._playing = false
    engine.seek.mockImplementation(() => { throw new Error('Available only on Windows') })
    await c.listen('with-song')
    expect(engine.play.mock.invocationCallOrder.at(-1)).toBeLessThan(engine.seek.mock.invocationCallOrder[0])
    expect(c.state).toBe('error-recoverable')
    expect(engine._playing).toBe(false)
    expect(api.play).not.toHaveBeenCalled()
    c.dispose()
  })
  it('a rejected song start in Listen with song is an error too', async () => {
    const { c, engine } = await withTake()
    engine._playing = false
    engine.play.mockRejectedValue(new Error('no audio'))
    await c.listen('with-song')
    expect(c.getSnapshot().error).toBe('error')
    c.dispose()
  })
})

describe('arm opens the input (spec: armed = input open, meter live)', () => {
  it('asks main to open the chosen input before showing armed, and disarms on toggle', async () => {
    const { c, api } = await setup()
    await c.arm()
    expect(api.arm).toHaveBeenCalledWith({ input: { deviceName: 'Scarlett 2i2', channelIndex: 0 } })
    expect(c.state).toBe('armed')
    await c.arm()
    expect(api.disarm).toHaveBeenCalledTimes(1)
    expect(c.state).toBe('idle')
    c.dispose()
  })
  it('a failed arm is a recoverable state and the strip is not left armed', async () => {
    for (const [reason, state] of [['permission', 'permission-needed'], ['no-input', 'input-missing'], ['busy', 'error-recoverable']] as const) {
      const { c } = await setup({ arm: vi.fn(async () => ({ ok: false as const, reason, message: '' })) })
      await c.arm()
      expect(c.getSnapshot().armed).toBe(false)
      expect(c.state).toBe(state)
      c.dispose()
    }
  })
  it('a song change or dispose while armed disarms; recording reuses the input without re-arming', async () => {
    const a = await setup()
    await a.c.arm()
    await a.c.setSong('song-2')
    expect(a.api.disarm).toHaveBeenCalled()
    a.c.dispose()
    const b = await setup()
    await b.c.arm()
    b.c.dispose()
    expect(b.api.disarm).toHaveBeenCalled()
    const r = await setup()
    await r.c.arm()
    r.api.disarm.mockClear()
    await r.c.toggleRecord()
    expect(r.api.arm).toHaveBeenCalledTimes(1)
    expect(r.api.disarm).not.toHaveBeenCalled() // the take now owns the input
    r.c.dispose()
  })
  it('a disarm while main is still opening the input releases it afterwards', async () => {
    let done!: (v: { ok: true }) => void
    const { c, api } = await setup({ arm: vi.fn(() => new Promise<{ ok: true }>((r) => { done = r })) })
    const arming = c.arm()
    await vi.waitFor(() => expect(api.arm).toHaveBeenCalled())
    await c.setSong('song-2')
    done({ ok: true })
    await arming
    expect(c.getSnapshot().armed).toBe(false)
    expect(api.disarm).toHaveBeenCalled()
    c.dispose()
  })
})

describe('releasing the input on teardown', () => {
  /** A fake main that, like the real store, keeps an armed input (stale) after a stop until disarmed. */
  function staleStore() {
    const st = { armed: false, stale: false, recording: false }
    return {
      st,
      api: {
        arm: vi.fn(async () => { st.armed = true; return { ok: true as const } }),
        disarm: vi.fn(async () => { st.armed = false; st.stale = false; return { ok: true } }),
        recordStart: vi.fn(async () => {
          if (st.stale) return { ok: false as const, reason: 'busy' as const, message: 'stale generation' }
          st.recording = true
          return { ok: true as const, takeId: 'take-1' }
        }),
        recordStop: vi.fn(async () => {
          st.recording = false
          if (st.armed) st.stale = true
          return { ok: true, take: summary() }
        })
      }
    }
  }
  it('arm, record, change song: recordStop then disarm, and recording again works', async () => {
    const { st, api } = staleStore()
    const { c, api: a } = await setup(api as never)
    await c.arm()
    await c.toggleRecord()
    await c.setSong('song-2')
    expect(a.recordStop).toHaveBeenCalled()
    expect(a.disarm.mock.invocationCallOrder.at(-1)).toBeGreaterThan(a.recordStop.mock.invocationCallOrder[0])
    expect(st.armed).toBe(false)
    expect(st.stale).toBe(false)
    await c.refreshInputs()
    await c.toggleRecord()
    expect(c.state).toBe('recording')
    c.dispose()
  })
  it('an unarmed record then an abort still disarms', async () => {
    const { st, api } = staleStore()
    const { c, api: a } = await setup(api as never)
    await c.toggleRecord()
    st.armed = true // main armed it as part of the take
    await c.setSong(null)
    expect(a.disarm).toHaveBeenCalled()
    expect(st.armed).toBe(false)
    c.dispose()
  })
  it('an in-flight start that is undone also disarms', async () => {
    let resolve!: (v: { ok: true; takeId: string }) => void
    const { c, api } = await setup({ recordStart: vi.fn(() => new Promise<{ ok: true; takeId: string }>((r) => { resolve = r })) })
    const started = c.toggleRecord()
    await vi.waitFor(() => expect(api.recordStart).toHaveBeenCalled())
    await c.setSong('song-2')
    api.disarm.mockClear()
    resolve({ ok: true, takeId: 'late' })
    await started
    expect(api.disarm).toHaveBeenCalled()
    c.dispose()
  })
})

describe('settings restore races (D6)', () => {
  const withTake = async () => {
    const r = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary({ tempo: 1, transposeSemitones: 0 }) })) })
    await r.c.toggleRecord()
    await r.c.toggleRecord()
    r.engine._tempo = 0.8
    r.engine._tr = -3
    return r
  }
  it('an abort while setTempo is still applying restores once it lands', async () => {
    const { c, engine } = await withTake()
    let land!: () => void
    engine.setTempo.mockImplementationOnce((r: number) => new Promise<void>((res) => { land = () => { engine._tempo = r; res() } }))
    const listening = c.listen('with-song')
    await vi.waitFor(() => expect(engine.setTempo).toHaveBeenCalled())
    await c.setSong('song-2') // abort: the engine still reads 0.8 here
    expect(engine._tempo).toBe(0.8)
    land()
    await listening
    await vi.waitFor(() => expect(engine._tempo).toBe(0.8)) // landed 1, then restored
    expect(engine.setTempo).toHaveBeenLastCalledWith(0.8)
    c.dispose()
  })
  it('an abort while setTranspose is applying restores transpose too', async () => {
    const { c, engine } = await withTake()
    let land!: () => void
    engine.setTranspose.mockImplementationOnce((v: number) => new Promise<void>((res) => { land = () => { engine._tr = v; res() } }))
    const listening = c.listen('with-song')
    await vi.waitFor(() => expect(engine.setTranspose).toHaveBeenCalled())
    c.dispose()
    land()
    await listening
    await vi.waitFor(() => expect(engine._tr).toBe(-3))
  })
  it('a value the singer changed during the listen is theirs and is not restored', async () => {
    const { c, engine } = await withTake()
    await c.listen('with-song') // applied 1 / 0
    engine._tempo = 1.2 // the singer moves tempo
    await c.stopListening()
    expect(engine._tempo).toBe(1.2)
    await vi.waitFor(() => expect(engine._tr).toBe(-3)) // transpose untouched by them: restored
    c.dispose()
  })
})

describe('live monitoring (M2)', () => {
  const unavailable = (reason: VoiceMonitorState['available'] & object) =>
    vi.fn(async () => monState({ available: reason, on: false, latency: null }))
  it('availability is asked when the song loads and again on device change', async () => {
    const { c, api } = await setup()
    expect(api.monitorAvailability).toHaveBeenCalledWith({ input: { deviceName: 'Scarlett 2i2', channelIndex: 0 }, outputDeviceId: null })
    api.monitorAvailability.mockClear()
    await c.refreshInputs() // what a device-change notification triggers
    await vi.waitFor(() => expect(api.monitorAvailability).toHaveBeenCalled())
    c.dispose()
  })
  it('toggles on and off through monitorSet, with the monitor gain, never persisted as on', async () => {
    const { c, api } = await setup()
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith({ input: { deviceName: 'Scarlett 2i2', channelIndex: 0 }, on: true, gainDb: -12, outputDeviceId: null })
    expect(c.state).toBe('monitoring-on')
    expect(c.getSnapshot().monitor.latency?.roundTripMs).toBe(6)
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith({ input: { deviceName: 'Scarlett 2i2', channelIndex: 0 }, on: false })
    expect(c.state).toBe('idle')
    await c.toggleMonitor()
    c.dispose()
    // a fresh controller (remount) starts off
    const fresh = await setup()
    expect(fresh.c.getSnapshot().monitor.on).toBe(false)
    fresh.c.dispose()
  })
  it('maps every unavailable reason to the two unavailable states and keeps the reason', async () => {
    const reasons = ['route-separate-devices', 'route-latency', 'route-bluetooth', 'route-wireless', 'no-input', 'permission', 'output-not-native', 'platform', 'device-lost', 'error'] as const
    for (const reason of reasons) {
      const { c, api } = await setup({ monitorAvailability: unavailable({ reason }) })
      await vi.waitFor(() => expect(c.getSnapshot().monitor.reason).toBe(reason))
      expect(c.state).toBe(reason === 'route-latency' ? 'monitoring-unavailable-latency' : 'monitoring-unavailable-route')
      await c.toggleMonitor()
      expect(api.monitorSet).not.toHaveBeenCalled() // unavailable: the toggle does nothing
      c.dispose()
    }
  })
  it('recording and the meter work in every unavailable state; recording works with monitoring on', async () => {
    const u = await setup({ monitorAvailability: unavailable({ reason: 'route-separate-devices' }) })
    await vi.waitFor(() => expect(u.c.getSnapshot().monitor.avail).toBe('route'))
    await u.c.arm()
    expect(u.c.getSnapshot().armed).toBe(true)
    await u.c.toggleRecord()
    expect(u.c.state).toBe('recording')
    u.c.dispose()
    const m = await setup()
    await m.c.toggleMonitor()
    await m.c.toggleRecord()
    expect(m.c.state).toBe('recording')
    expect(m.c.getSnapshot().monitor.on).toBe(true)
    expect(m.api.recordStart).toHaveBeenCalled()
    await m.c.toggleRecord()
    expect(m.c.getSnapshot().monitor.on).toBe(true) // the take ending does not end monitoring
    expect(m.api.disarm).not.toHaveBeenCalled()
    m.c.dispose()
  })
  it('the fader edits the monitor gain live while monitoring and the take level otherwise', async () => {
    const { c, api } = await setup()
    c.setLevel(40)
    c.setMonitorFader(100)
    expect(c.getSnapshot().level).toBe(40)
    expect(api.monitorGain).not.toHaveBeenCalled() // not monitoring: nothing is sent
    await c.toggleMonitor()
    c.setMonitorFader(0)
    await vi.waitFor(() => expect(api.monitorGain).toHaveBeenCalledWith({ gainDb: -60 }))
    expect(c.getSnapshot().level).toBe(40) // each keeps its own value
    expect(monitorFaderToDb(100)).toBe(12)
    expect(monitorDbToFader(0)).toBe(83)
    c.dispose()
  })
  it('a running monitor survives a song change and unload; speaker-off and dispose still stop it', async () => {
    const a = await setup()
    await a.c.toggleMonitor()
    expect(a.c.getSnapshot().monitor.on).toBe(true)
    a.api.monitorSet.mockClear()
    await a.c.setSong('song-2')
    await a.c.setSong(null)
    // negative control: the old teardown turned it off here
    expect(a.api.monitorSet).not.toHaveBeenCalled()
    expect(a.c.getSnapshot().monitor.on).toBe(true)
    await a.c.toggleMonitor() // the speaker still works with no song open
    expect(a.api.monitorSet).toHaveBeenCalledWith(expect.objectContaining({ on: false }))
    expect(a.c.getSnapshot().monitor.on).toBe(false)
    a.c.dispose()
    const b = await setup()
    await b.c.toggleMonitor()
    b.api.monitorSet.mockClear()
    b.c.dispose() // the controller itself going away (host unmount, quit) still releases it
    expect(b.c.getSnapshot().monitor.on).toBe(false)
    await vi.waitFor(() => expect(b.api.monitorSet).toHaveBeenCalledWith(expect.objectContaining({ on: false })))
  })
  it('host lifetime: unmounting the host (song loading, library) keeps the monitor; remount adopts it; dispose still stops it', async () => {
    const { c, api } = await setup()
    const src = { path: '/a.mp3', projectDir: null, title: 'A', artist: '' }
    let unmount = c.bindSong(src)
    await vi.waitFor(() => expect(c.getSnapshot().songId).not.toBeNull())
    await c.toggleMonitor()
    api.monitorSet.mockClear()
    unmount() // phase 'loading' / library: VoiceHost unmounts
    await vi.advanceTimersByTimeAsync(0)
    expect(c.getSnapshot().songId).toBeNull()
    expect(c.getSnapshot().armed).toBe(false)
    expect(c.getSnapshot().take).toBeNull()
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.monitorSet).not.toHaveBeenCalled()
    unmount = c.bindSong({ ...src, path: '/b.mp3' }) // the next song's host mounts
    await vi.waitFor(() => expect(c.getSnapshot().songId).not.toBeNull())
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.monitorSet).not.toHaveBeenCalled()
    // negative control: the full teardown still releases the monitor
    c.dispose()
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalledWith(expect.objectContaining({ on: false })))
    unmount()
  })
  it('the controller is one per engine, so a remounted host sees the running monitor', () => {
    const e = {}
    const a = voiceControllerFor(e, () => ({}) as VoiceController)
    expect(voiceControllerFor(e, () => ({}) as VoiceController)).toBe(a)
    expect(voiceControllerFor({}, () => ({}) as VoiceController)).not.toBe(a)
  })
  it('a start that finishes after a song change stays on', async () => {
    let done!: (v: VoiceMonitorState) => void
    const { c, api } = await setup()
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { done = r }))
    const toggling = c.toggleMonitor()
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalled())
    await c.setSong('song-2')
    api.monitorSet.mockClear()
    done(monState({ on: true }))
    await toggling
    expect(api.monitorSet).not.toHaveBeenCalled()
    expect(c.getSnapshot().monitor.on).toBe(true)
    c.dispose()
  })
  it('device lost: a main-side stop is reflected and never left shown on', async () => {
    const { c, api } = await setup()
    await c.toggleMonitor()
    api.monitorState.mockResolvedValue(monState({ available: { reason: 'device-lost' }, on: false, latency: null }))
    api.level.mockResolvedValue({ peakDb: -30, rmsDb: -40 })
    for (let i = 0; i < 12; i++) await c.pollLevel()
    await vi.waitFor(() => expect(c.getSnapshot().monitor.on).toBe(false))
    expect(c.getSnapshot().error).toBe('monitor')
    c.dispose()
  })
  it('a device lost during a take releases monitoring', async () => {
    const { c } = await setup({ recordStop: vi.fn(async () => ({ ok: false, reason: 'device-lost' as const, take: summary({ status: 'partial-device-lost' }) })) })
    await c.toggleMonitor()
    await c.toggleRecord()
    await c.toggleRecord()
    await vi.waitFor(() => expect(c.getSnapshot().monitor.on).toBe(false))
    c.dispose()
  })
  it('a failed start is an error-recoverable state, not monitoring', async () => {
    const { c } = await setup({ monitorSet: vi.fn(async () => { throw new Error('boom') }) })
    await c.toggleMonitor()
    expect(c.state).toBe('error-recoverable')
    expect(c.getSnapshot().monitor.on).toBe(false)
    c.dispose()
  })
  it('strip markup: pressed toggle with latency badge, or disabled with the reason described', async () => {
    const on = await setup()
    await on.c.toggleMonitor()
    let html = renderToStaticMarkup(createElement(VoiceStrip, { controller: on.c, engine: on.engine as never }))
    expect(html).toContain('aria-label="Monitoring on. Click to turn off"')
    expect(html).toContain('≈ 6 ms')
    expect(html).toContain('Estimated round-trip delay · 64 frames')
    expect(html).toContain('aria-label="Monitor level"')
    on.c.dispose()
    const off = await setup({ monitorAvailability: unavailable({ reason: 'route-separate-devices' }) })
    await vi.waitFor(() => expect(off.c.getSnapshot().monitor.avail).toBe('route'))
    html = renderToStaticMarkup(createElement(VoiceStrip, { controller: off.c, engine: off.engine as never }))
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-describedby="voice-monitor-why"|aria-describedby="voice-monitor-why"[^>]*aria-disabled="true"/)
    expect(html).toContain('id="voice-monitor-why"')
    expect(html).toContain('Monitoring needs the input and output on one device')
    off.c.dispose()
  })
})

describe('monitoring owns an armed input (meter live) and an availability refresh cannot cancel a toggle', () => {
  it('a refresh during a pending monitorSet(on) does not turn the monitor off', async () => {
    let done!: (v: VoiceMonitorState) => void
    const { c, api } = await setup()
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { done = r }))
    const toggling = c.toggleMonitor()
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalled())
    api.monitorSet.mockClear()
    await c.refreshInputs() // device change
    await c.refreshMonitorAvailability()
    c.selectInput('mic')
    done(monState({ on: true }))
    await toggling
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.monitorSet).not.toHaveBeenCalled() // no silent off
    expect(c.getSnapshot().error).toBeNull()
    c.dispose()
  })
  it('monitoring opens the input without arming; off releases it (monitor without arm)', async () => {
    const { c, api } = await setup()
    await c.toggleMonitor()
    expect(api.arm).toHaveBeenCalledTimes(1)
    expect(c.getSnapshot().armed).toBe(false) // negative control: it used to light the arm button
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.arm.mock.invocationCallOrder[0]).toBeLessThan(api.monitorSet.mock.invocationCallOrder.at(-1)!)
    await c.toggleMonitor()
    expect(api.disarm).toHaveBeenCalled()
    expect(c.getSnapshot().armed).toBe(false)
    c.dispose()
  })
  it('arm without monitor: the input opens, monitoring stays off, disarm releases it', async () => {
    const { c, api } = await setup()
    await c.arm()
    expect(c.getSnapshot().armed).toBe(true)
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(api.monitorSet).not.toHaveBeenCalled()
    await c.arm()
    expect(c.getSnapshot().armed).toBe(false)
    expect(api.disarm).toHaveBeenCalledTimes(1)
    c.dispose()
  })
  it('monitor off while armed keeps the arm and the open input', async () => {
    const { c, api } = await setup()
    await c.arm()
    await c.toggleMonitor()
    expect(api.arm).toHaveBeenCalledTimes(1) // the open input is shared
    await c.toggleMonitor()
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(c.getSnapshot().armed).toBe(true) // negative control: it used to disarm when monitoring had armed
    expect(api.disarm).not.toHaveBeenCalled()
    c.dispose()
  })
  it('monitoring works with no song open', async () => {
    const { c, api } = await setup()
    await c.setSong(null)
    await c.toggleMonitor()
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.monitorSet).toHaveBeenCalledWith(expect.objectContaining({ on: true }))
    c.dispose()
  })
  it('record from idle in one press leaves the monitor state alone', async () => {
    const { c, api } = await setup()
    await c.toggleRecord()
    expect(c.getSnapshot().recording).toBe(true)
    expect(c.getSnapshot().armed).toBe(false)
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(api.monitorSet).not.toHaveBeenCalled()
    c.dispose()
  })
  it('an explicit arm is preserved when monitoring is turned off', async () => {
    const { c, api } = await setup()
    await c.arm()
    api.arm.mockClear()
    await c.toggleMonitor()
    expect(api.arm).not.toHaveBeenCalled()
    await c.toggleMonitor()
    expect(api.disarm).not.toHaveBeenCalled()
    expect(c.getSnapshot().armed).toBe(true)
    c.dispose()
  })
  it('a take ending keeps the input open while monitoring; ending monitoring then releases it', async () => {
    const { c, api } = await setup()
    await c.toggleMonitor()
    await c.toggleRecord()
    await c.toggleRecord()
    expect(api.disarm).not.toHaveBeenCalled()
    await c.keep()
    await c.toggleMonitor()
    await vi.waitFor(() => expect(api.disarm).toHaveBeenCalled())
    c.dispose()
  })
  it('monitoring turned off during a take leaves the input to the take, which releases it on stop', async () => {
    const { c, api } = await setup()
    await c.toggleMonitor()
    await c.toggleRecord()
    await c.toggleMonitor()
    expect(api.disarm).not.toHaveBeenCalled()
    await c.toggleRecord()
    expect(api.disarm).toHaveBeenCalled()
    c.dispose()
  })
  it('disarming while monitoring keeps monitoring and the open input', async () => {
    const { c, api } = await setup()
    await c.arm()
    await c.toggleMonitor()
    await c.arm() // the singer clicks the lit arm button
    expect(c.getSnapshot().armed).toBe(false)
    expect(c.getSnapshot().monitor.on).toBe(true) // negative control: it used to end monitoring
    expect(api.disarm).not.toHaveBeenCalled()
    await c.toggleMonitor() // the last holder out closes the input
    expect(api.disarm).toHaveBeenCalledTimes(1)
    c.dispose()
  })
  it('an arm failure leaves monitoring off in the existing recoverable states', async () => {
    for (const [reason, state] of [['permission', 'permission-needed'], ['no-input', 'input-missing'], ['busy', 'error-recoverable']] as const) {
      const { c, api } = await setup({ arm: vi.fn(async () => ({ ok: false as const, reason, message: '' })) })
      await c.toggleMonitor()
      expect(c.getSnapshot().monitor.on).toBe(false)
      expect(api.monitorSet).not.toHaveBeenCalled()
      expect(c.state).toBe(state)
      c.dispose()
    }
  })
  it('a monitor that fails to start disarms the input it armed', async () => {
    const { c, api } = await setup({ monitorSet: vi.fn(async () => { throw new Error('boom') }) })
    await c.toggleMonitor()
    expect(c.state).toBe('error-recoverable')
    expect(c.getSnapshot().armed).toBe(false)
    await vi.waitFor(() => expect(api.disarm).toHaveBeenCalled())
    c.dispose()
  })
  it('a song change during a pending toggle does not switch the monitor off', async () => {
    let done!: (v: VoiceMonitorState) => void
    const { c, api } = await setup()
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { done = r }))
    const toggling = c.toggleMonitor()
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalled())
    await c.setSong('song-2')
    api.monitorSet.mockClear()
    done(monState({ on: true }))
    await toggling
    expect(api.monitorSet).not.toHaveBeenCalled()
    expect(c.getSnapshot().monitor.on).toBe(true)
    c.dispose()
  })
})

describe('input channels (spec J2, VS-REC-011)', () => {
  const quadro: VoiceInputOption[] = Array.from({ length: 16 }, (_, ch) => ({
    id: `zen#${ch}`,
    label: 'Zen Quadro SC',
    deviceName: 'zen-uid',
    channelIndex: ch,
    channels: 16,
    channelLabel: ch === 5 ? 'Vocal mic' : null
  }))
  const mono: VoiceInputOption[] = [{ id: 'mbp#0', label: 'MacBook Pro Microphone', deviceName: 'mbp-uid', channelIndex: 0, channels: 1, channelLabel: null }]
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  const render = (c: VoiceController, engine: unknown): string =>
    renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never }))

  it('lists every channel of a 16-channel device under one optgroup, using the device channel labels', async () => {
    const { c, engine } = await setup({}, undefined, [...quadro, ...mono])
    const html = render(c, engine)
    expect(html).toContain('<optgroup label="Zen Quadro SC">')
    expect((html.match(/<option value="zen#/g) ?? []).length).toBe(16)
    expect(html).toContain('Zen Quadro SC · In 1')
    expect(html).toContain('Zen Quadro SC · In 16')
    expect(html).toContain('Zen Quadro SC · Vocal mic') // the device's own name for channel 6
    expect(html).toContain('MacBook Pro Microphone (mono)')
    expect(html).not.toContain('<optgroup label="MacBook Pro Microphone">') // a mono device is a single option
    c.dispose()
  })
  it('selecting a channel sets the request fields used by arm, record and monitor', async () => {
    const { c, api } = await setup({}, undefined, quadro)
    c.selectInput('zen#7')
    await c.arm()
    expect(api.arm).toHaveBeenLastCalledWith({ input: { deviceName: 'zen-uid', channelIndex: 7 } })
    await c.toggleRecord()
    expect(api.recordStart).toHaveBeenLastCalledWith(expect.objectContaining({ input: { deviceName: 'zen-uid', channelIndex: 7 } }))
    await c.toggleRecord()
    c.keep()
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ input: { deviceName: 'zen-uid', channelIndex: 7 }, on: true }))
    c.dispose()
  })
  it('re-asks monitor availability when only the channel changes', async () => {
    const { c, api } = await setup({}, undefined, quadro)
    api.monitorAvailability.mockClear()
    c.selectInput('zen#9')
    await vi.waitFor(() => expect(api.monitorAvailability).toHaveBeenCalledWith({ input: { deviceName: 'zen-uid', channelIndex: 9 }, outputDeviceId: null }))
    c.dispose()
  })
  it('persists the channel per device and restores it; a missing channel or device falls back with no error', async () => {
    const store = memory()
    const first = await setup({}, undefined, [...quadro, ...mono], store)
    first.c.selectInput('zen#7')
    first.c.selectInput('mbp#0')
    first.c.dispose()
    expect(JSON.parse(store.m.get('singz.voice.input')!)).toEqual({ device: 'mbp-uid', channels: { 'zen-uid': 7, 'mbp-uid': 0 } })
    // the last device and the channel remembered for it come back
    const again = await setup({}, undefined, [...quadro, ...mono], store)
    expect(again.c.getSnapshot().input).toBe('mbp#0')
    again.c.selectInput('zen#7')
    again.c.dispose()
    const restored = await setup({}, undefined, [...quadro, ...mono], store)
    expect(restored.c.getSnapshot().input).toBe('zen#7')
    restored.c.dispose()
    // the device is still there but now has fewer channels: channel 0, no error
    const fewer = await setup({}, undefined, quadro.slice(0, 4), store)
    expect(fewer.c.getSnapshot().input).toBe('zen#0')
    expect(fewer.c.getSnapshot().error).toBeNull()
    fewer.c.dispose()
    // the device is gone: the first available input, no error
    const gone = await setup({}, undefined, mono, store)
    expect(gone.c.getSnapshot().input).toBe('mbp#0')
    expect(gone.c.getSnapshot().error).toBeNull()
    gone.c.dispose()
  })
  it('ignores an unreadable or older stored value', async () => {
    const store = memory()
    store.m.set('singz.voice.input', 'zen#3')
    const r = await setup({}, undefined, quadro, store)
    expect(r.c.getSnapshot().input).toBe('zen#0')
    r.c.dispose()
  })
})

describe('changing the input while armed (main refuses a mismatched armed channel)', () => {
  const opt = (dev: string, ch: number): VoiceInputOption => ({ id: `${dev}#${ch}`, label: dev, deviceName: dev, channelIndex: ch, channels: 8, channelLabel: null })
  const inputs = [...Array.from({ length: 8 }, (_, ch) => opt('zen', ch)), opt('mbp', 0)]
  /** A fake main that models the armed input: a take on a different channel or device is refused. */
  function mainModel() {
    const st = { armed: null as { dev: string; ch: number } | null, opens: 0, closes: 0, log: [] as string[] }
    return {
      st,
      api: {
        arm: vi.fn(async (r: { input: { deviceName: string; channelIndex: number } }) => {
          st.armed = { dev: r.input.deviceName, ch: r.input.channelIndex }
          st.opens++
          st.log.push(`arm ${r.input.deviceName}#${r.input.channelIndex}`)
          return { ok: true as const }
        }),
        disarm: vi.fn(async () => { st.armed = null; st.closes++; st.log.push('disarm'); return { ok: true } }),
        recordStart: vi.fn(async (r: { input: { deviceName: string; channelIndex: number } }) => {
          if (st.armed && (st.armed.dev !== r.input.deviceName || st.armed.ch !== r.input.channelIndex)) {
            return { ok: false as const, reason: 'no-input' as const, message: 'armed channel differs' }
          }
          return { ok: true as const, takeId: 'take-1' }
        })
      }
    }
  }
  const armedOn = async (id: string, extra: Partial<VoiceTakeApi> = {}) => {
    const main = mainModel()
    const r = await setup({ ...main.api, ...extra } as never, undefined, inputs)
    r.c.selectInput(id)
    await r.c.arm()
    return { ...r, main }
  }
  const settle = async () => { await vi.advanceTimersByTimeAsync(0); await Promise.resolve() }

  it('re-arms on the new channel so Record succeeds instead of reading input missing', async () => {
    const { c, main } = await armedOn('zen#0')
    expect(main.st.armed).toEqual({ dev: 'zen', ch: 0 })
    c.selectInput('zen#7')
    await vi.waitFor(() => expect(main.st.armed).toEqual({ dev: 'zen', ch: 7 }))
    expect(main.st.log.slice(-2)).toEqual(['disarm', 'arm zen#7'])
    expect(c.getSnapshot().armed).toBe(true)
    await c.toggleRecord()
    expect(c.state).toBe('recording')
    expect(c.getSnapshot().inputMissing).toBe(false)
    c.dispose()
  })
  it('a different device is re-armed too', async () => {
    const { c, main } = await armedOn('zen#3')
    c.selectInput('mbp#0')
    await vi.waitFor(() => expect(main.st.armed).toEqual({ dev: 'mbp', ch: 0 }))
    await c.toggleRecord()
    expect(c.state).toBe('recording')
    c.dispose()
  })
  it('two quick selections: only the last stays armed and nothing leaks open', async () => {
    const { c, main } = await armedOn('zen#0')
    c.selectInput('zen#2')
    c.selectInput('zen#5')
    await vi.waitFor(() => expect(main.st.armed).toEqual({ dev: 'zen', ch: 5 }))
    await settle()
    expect(main.st.armed).toEqual({ dev: 'zen', ch: 5 })
    expect(main.st.opens - main.st.closes).toBe(1) // exactly one input open
    expect(c.getSnapshot().armed).toBe(true)
    c.dispose()
  })
  it('selecting while not armed arms nothing', async () => {
    const main = mainModel()
    const { c } = await setup(main.api as never, undefined, inputs)
    c.selectInput('zen#4')
    await settle()
    expect(main.api.arm).not.toHaveBeenCalled()
    expect(main.st.armed).toBeNull()
    c.dispose()
  })
  it('a selection while recording is ignored', async () => {
    const { c, main } = await armedOn('zen#0')
    await c.toggleRecord()
    main.api.arm.mockClear()
    c.selectInput('zen#6')
    await settle()
    expect(c.getSnapshot().input).toBe('zen#0')
    expect(main.api.arm).not.toHaveBeenCalled()
    c.dispose()
  })
  it('while monitoring: the monitor is released; an input the singer armed is re-armed, one the monitor armed is released', async () => {
    const own = await armedOn('zen#0')
    await own.c.toggleMonitor() // singer's arm already open: monitor does not own it
    expect(own.c.getSnapshot().monitor.on).toBe(true)
    own.c.selectInput('zen#7')
    await vi.waitFor(() => expect(own.main.st.armed).toEqual({ dev: 'zen', ch: 7 }))
    expect(own.c.getSnapshot().monitor.on).toBe(false)
    expect(own.api.monitorSet).toHaveBeenCalledWith(expect.objectContaining({ on: false }))
    own.c.dispose()
    const main = mainModel()
    const viaMonitor = await setup(main.api as never, undefined, inputs)
    viaMonitor.c.selectInput('zen#0')
    await viaMonitor.c.toggleMonitor() // monitoring armed it
    expect(main.st.armed).toEqual({ dev: 'zen', ch: 0 })
    viaMonitor.c.selectInput('zen#7')
    await vi.waitFor(() => expect(main.st.armed).toBeNull())
    await settle()
    expect(main.st.armed).toBeNull() // released, not re-armed
    expect(viaMonitor.c.getSnapshot().armed).toBe(false)
    viaMonitor.c.dispose()
  })
  it('a song change during a pending re-arm leaves the new song disarmed with no open input', async () => {
    let releaseDisarm!: () => void
    const { c, main } = await armedOn('zen#0')
    const realDisarm = main.api.disarm.getMockImplementation()!
    main.api.disarm.mockImplementationOnce(() => new Promise((r) => { releaseDisarm = () => r(realDisarm()) }))
    main.api.arm.mockClear()
    c.selectInput('zen#7') // switchInput is now waiting on its forceDisarm
    await vi.waitFor(() => expect(main.api.disarm).toHaveBeenCalled())
    const changing = c.setSong('song-2')
    releaseDisarm()
    await changing
    await settle()
    expect(main.api.arm).not.toHaveBeenCalled() // the re-arm never lands on the new song
    expect(main.st.armed).toBeNull()
    expect(c.getSnapshot().armed).toBe(false)
    c.dispose()
  })
  it('a selection during a pending monitor arm leaves nothing armed on the old channel', async () => {
    let finishArm!: () => void
    const main = mainModel()
    const realArm = main.api.arm.getMockImplementation()!
    main.api.arm.mockImplementationOnce((r) => new Promise((res) => { finishArm = () => res(realArm(r)) }))
    const r = await setup(main.api as never, undefined, inputs)
    r.c.selectInput('zen#0')
    const toggling = r.c.toggleMonitor() // arms zen#0 for the monitor
    await vi.waitFor(() => expect(main.api.arm).toHaveBeenCalledTimes(1))
    r.c.selectInput('zen#7')
    finishArm()
    await toggling
    await settle()
    await vi.waitFor(() => expect(main.st.armed).toBeNull()) // not armed on zen#0, and not re-armed (the monitor owned it)
    expect(r.c.getSnapshot().armed).toBe(false)
    expect(r.c.getSnapshot().monitor.on).toBe(false)
    r.c.dispose()
  })
  it('a selection while a take is starting is ignored', async () => {
    let started!: () => void
    const { c, main } = await armedOn('zen#0', {
      recordStart: vi.fn(() => new Promise<{ ok: true; takeId: string }>((r) => { started = () => r({ ok: true, takeId: 'take-1' }) }))
    } as never)
    const recording = c.toggleRecord()
    await vi.waitFor(() => expect(c.getSnapshot().starting).toBe(true))
    main.api.arm.mockClear()
    c.selectInput('zen#3')
    expect(c.getSnapshot().input).toBe('zen#0')
    started()
    await recording
    expect(main.api.arm).not.toHaveBeenCalled()
    c.dispose()
  })
  it('a failed re-arm leaves the strip disarmed in the existing state and the select usable', async () => {
    let calls = 0
    const { c } = await armedOn('zen#0', {
      arm: vi.fn(async () => (++calls === 1 ? { ok: true as const } : { ok: false as const, reason: 'no-input' as const, message: '' }))
    } as never)
    c.selectInput('zen#7')
    await vi.waitFor(() => expect(c.getSnapshot().inputMissing).toBe(true))
    expect(c.getSnapshot().armed).toBe(false)
    expect(c.getSnapshot().input).toBe('zen#7')
    c.dispose()
  })
})

describe('monitor level preset, memory and hint', () => {
  const memory = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init))
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  it('defaults to a safe -12 dB', async () => {
    expect(INITIAL_VOICE_MODEL.monitorGainDb).toBe(-12)
    const { c } = await setup()
    expect(c.getSnapshot().monitorGainDb).toBe(-12)
    c.dispose()
  })
  it('remembers the monitor gain in storage, clamped to -60..+12, and ignores junk', async () => {
    const store = memory()
    const a = await setup({}, undefined, undefined, store)
    a.c.setMonitorFader(0)
    expect(store.m.get('singz.voice.monitorGain')).toBe('-60')
    a.c.setMonitorFader(60)
    expect(store.m.get('singz.voice.monitorGain')).toBe('-17')
    a.c.dispose()
    const b = await setup({}, undefined, undefined, store)
    expect(b.c.getSnapshot().monitorGainDb).toBe(-17)
    b.c.dispose()
    for (const raw of ['99', '-999', 'loud', '', '   ', 'NaN', 'Infinity']) {
      const junk = memory({ 'singz.voice.monitorGain': raw })
      const r = await setup({}, undefined, undefined, junk)
      expect(r.c.getSnapshot().monitorGainDb, JSON.stringify(raw)).toBe(-12) // never 0 dB, never clamped up to +12
      expect(junk.m.get('singz.voice.monitorGain')).toBe('-12') // junk is rewritten with the default
      r.c.dispose()
    }
    const ok = await setup({}, undefined, undefined, memory({ 'singz.voice.monitorGain': ' -6.5 ' }))
    expect(ok.c.getSnapshot().monitorGainDb).toBe(-6.5)
    ok.c.dispose()
  })
  it('monitorSet carries the remembered gain, so monitoring never opens louder than it', async () => {
    const { c, api } = await setup({}, undefined, undefined, memory({ 'singz.voice.monitorGain': '-30' }))
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: true, gainDb: -30 }))
    c.dispose()
  })
  it('while monitoring is off the fader edits the take level only; monitoring starts with the remembered gain', async () => {
    const { c, api } = await setup()
    c.setFader(50)
    expect(c.getSnapshot().level).toBe(50)
    expect(c.getSnapshot().monitorGainDb).toBe(-12)
    expect(api.monitorGain).not.toHaveBeenCalled()
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ gainDb: -12 }))
    c.dispose()
  })
  it('the fader edits the take level by default and the monitor level exactly while the speaker is on', async () => {
    const { c, api } = await setup()
    c.setFader(40)
    expect(c.getSnapshot().level).toBe(40)
    expect(c.getSnapshot().monitorGainDb).toBe(-12)
    await c.toggleMonitor()
    c.setFader(0)
    await vi.waitFor(() => expect(api.monitorGain).toHaveBeenCalledWith({ gainDb: -60 }))
    expect(c.getSnapshot().level).toBe(40)
    await c.toggleMonitor()
    c.setFader(20)
    expect(c.getSnapshot().level).toBe(20)
    expect(c.getSnapshot().monitorGainDb).toBe(-60) // remembered
    c.dispose()
  })
  it('shows the headphones hint once, on the first time monitoring is turned on in the session', async () => {
    const { c, engine } = await setup()
    await c.toggleMonitor()
    expect(c.getSnapshot().monitorHint).toBe(true)
    expect(renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never }))).toContain('Use headphones to avoid feedback')
    await c.toggleMonitor()
    expect(c.getSnapshot().monitorHint).toBe(false)
    await c.toggleMonitor()
    expect(c.getSnapshot().monitorHint).toBe(false) // not shown again, and nothing blocks
    expect(c.getSnapshot().monitor.on).toBe(true)
    c.dispose()
  })
  it('markup: Record + Speaker pair, no Mon chip; the speaker toggles monitoring while idle; the fader names its level', async () => {
    const { c, engine, api } = await setup()
    const render = (): string => renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never }))
    let html = render()
    expect(html).toContain('aria-label="Arm for recording"')
    expect(html).toMatch(/class="vs-ib vs-mon"[^>]*aria-pressed="false"[^>]*aria-label="Monitor my voice \(off\)"/)
    expect(html).toContain('aria-label="Voice level"')
    // negative control: the old Mon chip and its fader-mode tooltips are gone
    expect(html).not.toMatch(/>Mon</)
    expect(html).not.toContain('Click to set the monitor level instead')
    expect(html).not.toContain('Click to set the voice level instead')
    expect(c).not.toHaveProperty('toggleFaderMode')
    // idle (not armed, not recording): the speaker alone turns monitoring on
    expect(c.getSnapshot().armed).toBe(false)
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: true }))
    html = render()
    expect(html).toMatch(/class="vs-ib vs-mon active"[^>]*aria-pressed="true"[^>]*aria-label="Monitoring on\. Click to turn off"/)
    expect(html).toContain('aria-label="Monitor level"')
    expect(html).not.toContain('aria-label="Voice level"')
    c.dispose()
  })
})

describe('monitoring during a take, route changes, and the arm window (hardware run 3)', () => {
  /** A fake main where an arm while a take holds the input is refused as busy. */
  function busyMain() {
    const st = { recording: false, armed: false, armCalls: 0 }
    return {
      st,
      api: {
        arm: vi.fn(async () => {
          st.armCalls++
          if (st.recording) return { ok: false as const, reason: 'busy' as const, message: 'a take is active' }
          st.armed = true
          return { ok: true as const }
        }),
        disarm: vi.fn(async () => { st.armed = false; return { ok: true } }),
        recordStart: vi.fn(async () => { st.recording = true; return { ok: true as const, takeId: 'take-1' } }),
        recordStop: vi.fn(async () => { st.recording = false; return { ok: true, take: summary() } })
      }
    }
  }
  it('monitor on during a take: no arm, no error, the take is unaffected', async () => {
    const m = busyMain()
    const { c, api } = await setup(m.api as never)
    await c.toggleRecord()
    expect(c.state).toBe('recording')
    await c.toggleMonitor()
    expect(m.api.arm).not.toHaveBeenCalled()
    expect(c.getSnapshot().error).toBeNull()
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(c.state).toBe('recording')
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: true }))
    await c.toggleRecord() // the take completes fine
    expect(c.state).toBe('take-review')
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(m.api.disarm).not.toHaveBeenCalled() // monitoring now holds the input
    await c.toggleMonitor()
    await vi.waitFor(() => expect(m.api.disarm).toHaveBeenCalled()) // and releases it when it ends
    c.dispose()
  })
  it('monitor off during a take only releases the monitor: no disarm, the take keeps recording', async () => {
    const m = busyMain()
    const { c, api } = await setup(m.api as never)
    await c.toggleMonitor() // armed by monitoring
    await c.toggleRecord()
    m.api.disarm.mockClear()
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: false }))
    expect(m.api.disarm).not.toHaveBeenCalled()
    expect(c.state).toBe('recording')
    await c.toggleRecord()
    expect(m.api.disarm).toHaveBeenCalled() // the take's stop releases it once monitoring is off
    c.dispose()
  })
  it('a monitor for a different input than the take records is refused with a note, not an error', async () => {
    const m = busyMain()
    const two = [{ id: 'a', label: 'Zen', deviceName: 'zen', channelIndex: 0, channels: 2 }, { id: 'b', label: 'Zen', deviceName: 'zen', channelIndex: 1, channels: 2 }]
    const { c, engine, api } = await setup(m.api as never, undefined, two)
    c.selectInput('a')
    await c.toggleRecord()
    ;(c as unknown as { takeInput: { deviceName: string; channelIndex: number } }).takeInput = { deviceName: 'zen', channelIndex: 1 }
    await c.toggleMonitor()
    expect(c.getSnapshot().monitorNote).toBe('other-input')
    expect(c.getSnapshot().error).toBeNull()
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(api.monitorSet).not.toHaveBeenCalledWith(expect.objectContaining({ on: true }))
    expect(renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never }))).toContain("Monitoring while recording uses the take&#x27;s input")
    c.dispose()
  })
  it('re-asks availability when the song output changes: speakers disable the button with the reason, the interface re-enables it', async () => {
    let route = 'interface'
    let emit = () => undefined as void
    const sep = { reason: 'route-separate-devices' as const }
    const { c, api, engine } = await setup({}, (e) => {
      Object.defineProperty(e, 'outputDeviceId', { get: () => route })
      ;(e as unknown as { subscribe: (fn: () => void) => () => void }).subscribe = (fn) => { emit = fn; return () => undefined }
    })
    c.bindSong({ path: '/a.mp3', projectDir: null, title: 'A', artist: '' })
    await vi.waitFor(() => expect(c.getSnapshot().songId).not.toBeNull())
    api.monitorAvailability.mockClear()
    api.monitorAvailability.mockResolvedValue(monState({ available: sep, on: false, latency: null }))
    route = 'speakers'
    emit()
    await vi.waitFor(() => expect(c.getSnapshot().monitor.reason).toBe('route-separate-devices'))
    const html = renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never }))
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-describedby="voice-monitor-why"|aria-describedby="voice-monitor-why"[^>]*aria-disabled="true"/)
    api.monitorAvailability.mockResolvedValue(monState({ on: false }))
    route = 'interface'
    emit()
    await vi.waitFor(() => expect(c.getSnapshot().monitor.avail).toBe('ok'))
    c.dispose()
  })
  it('re-asks availability right before each toggle-on and refuses with the reason if main says unavailable', async () => {
    const { c, api } = await setup()
    expect(c.getSnapshot().monitor.avail).toBe('ok')
    api.monitorAvailability.mockResolvedValue(monState({ available: { reason: 'route-separate-devices' }, on: false, latency: null }))
    await c.toggleMonitor()
    expect(api.monitorSet).not.toHaveBeenCalled()
    expect(c.getSnapshot().monitor.reason).toBe('route-separate-devices')
    expect(c.getSnapshot().armed).toBe(false) // nothing armed for a refused monitor
    c.dispose()
  })
  it('between its arm landing and monitorSet replying, a selection does not re-arm what monitoring armed', async () => {
    let reply!: (v: VoiceMonitorState) => void
    const inputs2 = [{ id: 'z0', label: 'Zen', deviceName: 'zen', channelIndex: 0, channels: 4 }, { id: 'z3', label: 'Zen', deviceName: 'zen', channelIndex: 3, channels: 4 }]
    const { c, api } = await setup({}, undefined, inputs2)
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { reply = r }))
    const toggling = c.toggleMonitor()
    await vi.waitFor(() => expect(api.arm).toHaveBeenCalled()) // the input opened, monitorSet is in flight
    api.arm.mockClear()
    c.selectInput('z3')
    reply(monState({ on: true }))
    await toggling
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(api.arm).not.toHaveBeenCalled() // never re-armed: the singer did not arm it
    expect(c.getSnapshot().armed).toBe(false)
    expect(c.getSnapshot().monitor.on).toBe(false)
    c.dispose()
  })
})

describe('availability follows the route, not song playback; a recovered route clears a monitor error', () => {
  const notNative = () => monState({ available: { reason: 'output-not-native' }, on: false, latency: null })
  const transient = () => monState({ available: { reason: 'error' }, on: false, latency: null })
  /** An engine whose subscribers can be fired, with settable native/play state. */
  async function withEngine(apiOver: Partial<VoiceTakeApi> = {}) {
    let fire = () => undefined as void
    const r = await setup(apiOver, (e) => {
      const st = { native: false }
      Object.defineProperty(e, 'nativeActive', { get: () => st.native })
      ;(e as unknown as { native: typeof st }).native = st
      ;(e as unknown as { subscribe: (fn: () => void) => () => void }).subscribe = (fn) => { fire = fn; return () => undefined }
    })
    r.c.bindSong({ path: '/a.mp3', projectDir: null, title: 'A', artist: '' })
    await vi.waitFor(() => expect(r.c.getSnapshot().songId).not.toBeNull())
    return { ...r, fire: () => fire(), native: (r.engine as unknown as { native: { native: boolean } }).native }
  }
  it('play never re-asks availability; Web Audio playback stopping, and a route change, do', async () => {
    const { c, api, engine, fire, native } = await withEngine()
    await vi.waitFor(() => expect(c.getSnapshot().monitor.avail).toBe('ok'))
    api.monitorAvailability.mockClear()
    engine._playing = true
    fire() // Play with the route unchanged
    await vi.advanceTimersByTimeAsync(10_000)
    expect(api.monitorAvailability).not.toHaveBeenCalled()
    engine._playing = false
    fire() // playback stopped: the output context changed
    await vi.advanceTimersByTimeAsync(0)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(1)
    api.monitorAvailability.mockClear()
    native.native = true
    fire() // route change
    await vi.advanceTimersByTimeAsync(0)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(1)
    c.dispose()
  })
  it('output-not-native is not retried because of Play, only after a route change or context publish (bounded)', async () => {
    const { c, api, engine, fire, native } = await withEngine({ monitorAvailability: vi.fn(async () => notNative()) })
    await vi.waitFor(() => expect(c.getSnapshot().monitor.reason).toBe('output-not-native'))
    api.monitorAvailability.mockClear()
    engine._playing = true
    fire()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.monitorAvailability).not.toHaveBeenCalled()
    native.native = true
    fire() // route change: one ask now, then the bounded retries while the stale answer persists
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(4)
    c.dispose()
  })
  it('a stale output-not-native is replaced once App\'s context publish lands', async () => {
    const g = globalThis as unknown as { window?: EventTarget }
    const prior = g.window
    g.window = new EventTarget()
    try {
      const { c, api } = await withEngine({ monitorAvailability: vi.fn(async () => notNative()) })
      await vi.waitFor(() => expect(c.getSnapshot().monitor.reason).toBe('output-not-native'))
      api.monitorAvailability.mockResolvedValue(monState({ on: false }))
      g.window.dispatchEvent(new Event(VOICE_CONTEXT_EVENT)) // App: publish resolved
      await vi.waitFor(() => expect(c.getSnapshot().monitor.avail).toBe('ok'))
      c.dispose()
    } finally {
      g.window = prior
    }
  })
  it('a route change retries a transient error at +0.5, +1.5 and +3 s, then stops; no storm', async () => {
    const { c, api, native, fire } = await withEngine({ monitorAvailability: vi.fn(async () => transient()) })
    await vi.waitFor(() => expect(c.getSnapshot().monitor.reason).toBe('error'))
    api.monitorAvailability.mockClear()
    native.native = true
    fire()
    for (let i = 0; i < 5; i++) fire() // more emits with no change: nothing extra
    await vi.advanceTimersByTimeAsync(0)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1500)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.monitorAvailability).toHaveBeenCalledTimes(4) // stopped
    c.dispose()
  })
  it('retries stop once it becomes available, and are cancelled by a song change', async () => {
    const a = await withEngine({ monitorAvailability: vi.fn(async () => transient()) })
    await vi.waitFor(() => expect(a.c.getSnapshot().monitor.reason).toBe('error'))
    a.api.monitorAvailability.mockClear()
    a.api.monitorAvailability.mockResolvedValue(monState({ on: false }))
    a.native.native = true
    a.fire()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(a.api.monitorAvailability).toHaveBeenCalledTimes(1) // available at once: no retries needed
    a.c.dispose()
    const b = await withEngine({ monitorAvailability: vi.fn(async () => transient()) })
    await vi.waitFor(() => expect(b.c.getSnapshot().monitor.reason).toBe('error'))
    b.native.native = true
    b.fire()
    await b.c.setSong('song-2')
    b.api.monitorAvailability.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(b.api.monitorAvailability).not.toHaveBeenCalled() // timers cancelled
    b.c.dispose()
  })
  it('a device-lost error clears itself when the route returns; other errors are not cleared by that rule', async () => {
    const { c, api, fire, native } = await withEngine()
    await c.toggleMonitor()
    api.monitorState.mockResolvedValue(monState({ available: { reason: 'device-lost' }, on: false, latency: null }))
    api.level.mockResolvedValue({ peakDb: -30, rmsDb: -40 })
    for (let i = 0; i < 12; i++) await c.pollLevel()
    await vi.waitFor(() => expect(c.state).toBe('error-recoverable'))
    expect(c.getSnapshot().error).toBe('monitor')
    // the route returns: availability true, monitoring off
    api.monitorAvailability.mockResolvedValue(monState({ on: false }))
    native.native = !native.native // the output route changed
    fire()
    await vi.waitFor(() => expect(c.getSnapshot().error).toBeNull())
    expect(['idle', 'armed']).toContain(c.state)
    c.dispose()
    for (const kind of ['busy', 'error', 'device-lost', 'no-bridge'] as const) {
      const r = await withEngine()
      ;(r.c as unknown as { set: (p: object) => void }).set({ error: kind })
      await r.c.refreshMonitorAvailability()
      expect(r.c.getSnapshot().error, kind).toBe(kind)
      r.c.dispose()
    }
  })
  it('a monitor failure is not cleared by an availability answer issued before it; an explicit toggle clears it', async () => {
    const { c, api } = await withEngine({ monitorSet: vi.fn(async () => { throw new Error('boom') }) })
    await c.toggleMonitor()
    expect(c.getSnapshot().error).toBe('monitor')
    api.monitorSet.mockImplementation(async (req: { on: boolean }) => monState({ on: req.on }))
    await c.toggleMonitor()
    expect(c.getSnapshot().error).toBeNull()
    expect(c.getSnapshot().monitor.on).toBe(true)
    c.dispose()
  })
  it('clears the other-input note when the take stops, on song change and on input change', async () => {
    const two = [{ id: 'a', label: 'Zen', deviceName: 'zen', channelIndex: 0, channels: 2 }, { id: 'b', label: 'Zen', deviceName: 'zen', channelIndex: 1, channels: 2 }]
    const note = async () => {
      const r = await setup({}, undefined, two)
      r.c.selectInput('a')
      await r.c.toggleRecord()
      ;(r.c as unknown as { takeInput: object }).takeInput = { deviceName: 'zen', channelIndex: 1 }
      await r.c.toggleMonitor()
      expect(r.c.getSnapshot().monitorNote).toBe('other-input')
      return r
    }
    const stop = await note()
    await stop.c.toggleRecord()
    expect(stop.c.getSnapshot().monitorNote).toBeNull()
    stop.c.dispose()
    const song = await note()
    await song.c.setSong('song-2')
    expect(song.c.getSnapshot().monitorNote).toBeNull()
    song.c.dispose()
    const inp = await note()
    ;(inp.c as unknown as { set: (p: object) => void }).set({ recording: false, starting: false })
    inp.c.selectInput('b')
    expect(inp.c.getSnapshot().monitorNote).toBeNull()
    inp.c.dispose()
  })
})

describe('Listen with song replays the take settings and restores the singer settings (D6)', () => {
  const recordWithChange = async () => {
    const r = await setup()
    await r.c.toggleRecord()
    clock = 4000
    r.engine._pos = 33.2
    r.engine._tempo = 0.8
    r.engine._tr = -3
    r.c.tick() // a change at ~4 s into the take
    clock = 6000
    await r.c.toggleRecord()
    return r
  }
  it('applies later timeline points when the take reaches them', async () => {
    const { c, engine } = await recordWithChange()
    expect(c.getSnapshot().take?.timeline).toEqual([
      { atSec: 0, tempo: 1, transpose: 0 },
      { atSec: 4, tempo: 0.8, transpose: -3 }
    ])
    engine._tempo = 1
    engine._tr = 0
    clock = 10_000
    await c.listen('with-song')
    expect(engine._tempo).toBe(1)
    clock = 12_000 // 2 s into the take: not yet
    c.tick()
    expect(engine._tempo).toBe(1)
    clock = 14_100 // 4.1 s in
    c.tick()
    await vi.waitFor(() => expect(engine._tempo).toBe(0.8))
    expect(engine._tr).toBe(-3)
    c.dispose()
  })
  it('restores the singer tempo and transpose on stop, abort and error', async () => {
    for (const how of ['stop', 'dispose', 'setSong', 'error'] as const) {
      const r = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary({ tempo: 1, transposeSemitones: 0 }) })) })
      await r.c.toggleRecord()
      await r.c.toggleRecord()
      r.engine._tempo = 0.8
      r.engine._tr = -3
      if (how === 'error') r.api.play.mockResolvedValue({ ok: false })
      await r.c.listen('with-song')
      if (how === 'stop') await r.c.stopListening()
      if (how === 'dispose') r.c.dispose()
      if (how === 'setSong') await r.c.setSong('song-2')
      await vi.waitFor(() => expect(r.engine._tempo, how).toBe(0.8))
      expect(r.engine._tr, how).toBe(-3)
      r.c.dispose()
    }
  })
  it('a teardown during an in-flight play that then succeeds stops native playback again', async () => {
    let finish!: (v: { ok: boolean }) => void
    const { c, api } = await recordWithChange()
    api.play.mockImplementation(() => new Promise<{ ok: boolean }>((r) => { finish = r }))
    const listening = c.listen('take')
    await vi.waitFor(() => expect(api.play).toHaveBeenCalled())
    c.dispose()
    api.stopPlay.mockClear()
    finish({ ok: true })
    await listening
    expect(api.stopPlay).toHaveBeenCalled()
  })
  it('song span follows the timeline, not just the first tempo', () => {
    expect(songSpan({ durationSec: 10, tempo: 1, timeline: [{ atSec: 0, tempo: 1, transpose: 0 }, { atSec: 4, tempo: 0.5, transpose: 0 }] })).toBeCloseTo(4 + 3, 6)
  })
})

describe('seek-stopped note (D4)', () => {
  it('shows the seek copy in take-review, not only outside it', async () => {
    const { c, engine } = await setup()
    await c.toggleRecord()
    clock = 100
    engine._pos = 90
    c.tick()
    await vi.waitFor(() => expect(c.state).toBe('take-review'))
    const html = renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never }))
    expect(html).toContain('Recording stopped because the song position changed.')
    c.dispose()
  })
})

describe('song lifecycle', () => {
  it('offers the newest stored take as kept and clears on song close', async () => {
    const list = vi.fn(async () => [summary({ takeId: 'old', createdAt: '2026-01-01T00:00:00Z' }), summary({ takeId: 'new', status: 'recovered' })])
    const { c } = await setup({ list })
    expect(c.getSnapshot().take).toMatchObject({ takeId: 'new', kept: true, recovered: true })
    await c.setSong(null)
    expect(c.getSnapshot().take).toBeNull()
  })
  it('closing the song during a take stops it', async () => {
    const { c, api } = await setup()
    await c.toggleRecord()
    await c.setSong(null)
    expect(api.recordStop).toHaveBeenCalled()
    expect(c.getSnapshot().recording).toBe(false)
  })
})

describe('i18n key set', () => {
  const holes = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
  const locales = ['es-419', 'pt-BR', 'tr', 'ru', 'zh-CN', 'hi', 'ja', 'ko', 'th', 'id', 'vi', 'fil', 'ms', 'zh-TW'] as const
  it('every language holds the same player.voice.* keys and placeholders as English', async () => {
    const english = en as Record<string, string>
    expect(Object.keys(voiceEn).length).toBeGreaterThan(50)
    for (const loc of locales) {
      const dict = (await import(`../../src/shared/i18n/${loc}/voice.ts`)).voice as Record<string, string>
      expect(Object.keys(dict).sort(), loc).toEqual(Object.keys(voiceEn).sort())
      for (const [k, v] of Object.entries(voiceEn)) {
        expect(dict[k]!.trim(), `${loc} ${k}`).not.toBe('')
        expect(holes(dict[k]!), `${loc} ${k}`).toEqual(holes(v))
      }
    }
    // Voice strings are registered by the lazy chunk, not the eager dictionary.
    expect(Object.keys(english).some((k) => k.startsWith('player.voice.'))).toBe(false)
  })
  it('loads the current language on demand', async () => {
    expect(await loadVoiceStrings('ru')).toBe(true)
    setLocale('ru')
    expect(t('player.voice.name')).toBe('Голос')
    setLocale('en')
    expect(t('player.voice.name')).toBe('Voice')
  })
})

describe('markup', () => {
  const render = async (setupFn?: (c: VoiceController) => Promise<void>): Promise<string> => {
    const { c, engine } = await setup()
    await setupFn?.(c)
    const html = renderToStaticMarkup(
      createElement('div', null, createElement(VoiceStrip, { controller: c, engine: engine as never }), createElement(VoiceRecordButton, { controller: c }))
    )
    c.dispose()
    return html
  }
  it('idle strip: labelled region, toggle buttons with aria-pressed, labelled slider and meter, a real monitor toggle', async () => {
    const html = await render()
    expect(html).toContain('aria-label="Voice strip"')
    expect(html).toContain('aria-label="Arm for recording"')
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Arm for recording"|aria-label="Arm for recording"[^>]*aria-pressed="false"/)
    expect(html).toContain('aria-label="Mute voice take playback"')
    expect(html).toContain('aria-label="Solo voice"')
    expect(html).toContain('aria-label="Voice level"')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-label="Monitor my voice (off)"')
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Monitor my voice \(off\)"|aria-label="Monitor my voice \(off\)"[^>]*aria-pressed="false"/)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-label="Record (R)"')
    expect(html).not.toContain('title="Record (R)"') // the in-app Tooltip replaces the native title
  })
  it('recording: Record becomes a pressed Stop button', async () => {
    const html = await render((c) => c.toggleRecord())
    expect(html).toContain('aria-label="Stop recording (R)"')
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Stop recording/)
  })
  it('review: the take actions are a labelled group; Add as track is disabled in M1; Record says why it is off', async () => {
    const html = await render(async (c) => { await c.toggleRecord(); await c.toggleRecord() })
    expect(html).toContain('role="group" aria-label="Take actions"')
    expect(html).toContain('aria-label="Keep take"')
    expect(html).toContain('aria-label="Listen"')
    expect(html).toContain('aria-label="Listen with song"')
    expect(html).toMatch(/aria-label="Add to song as track \(coming later\)"[^>]*disabled/)
    expect(html).toContain('aria-label="Discard take (Delete)"')
    expect(html).toContain('aria-label="Record (R)"')
    expect(html).not.toContain('Record unavailable')
    expect(html).not.toContain('recorded at') // a take at 100% and 0 shows no tag: nothing to explain
    expect(html).not.toContain('100% · 0')
  })
  it('the take clip sits on the stems\' time axis: the shared view, not the whole song', async () => {
    const { c, engine } = await setup()
    await c.toggleRecord()
    await c.toggleRecord()
    const at = (view: { s: number; e: number } | null): string =>
      renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never, view }))
    const take = c.getSnapshot().take!
    const dur = engine.duration // 200
    expect(at(null)).toContain(`left:${(take.startSec / dur) * 100}%`)
    const v = { s: take.startSec - 5, e: take.startSec + 45 }
    expect(at(v)).toContain('left:10%') // (start - (start-5)) / 50
    expect(at({ s: take.startSec + 100, e: take.startSec + 150 })).not.toContain('vs-clip ') // scrolled out of view
    c.dispose()
  })
})

describe('voice lane without a take', () => {
  it('keeps the lane clear after arming while retaining the arm control state', async () => {
    const { c, engine } = await setup()
    await c.arm()
    const html = renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never, view: null }))
    expect(html).toContain('aria-label="Disarm recording"')
    expect(html).not.toContain('Recording starts at the playhead')
    expect(html).not.toContain('Press Record (R)')
    c.dispose()
  })
})

describe('monitor output in the track settings popup', () => {
  const memory = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init))
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  const KEY = 'singz.voice.monitorOutput'
  const candidates = [
    { id: 'zen-uid', name: 'Zen Quadro', usable: true },
    { id: 'bt-uid', name: 'Headphones BT', usable: false, reason: 'route-bluetooth' as const },
    { id: 'mbp-spk', name: 'MacBook Speakers', usable: false, reason: 'route-separate-devices' as const }
  ]
  const withCandidates = (over: Partial<VoiceMonitorState> = {}) =>
    ({ monitorAvailability: vi.fn(async () => monState({ on: false, outputCandidates: candidates, outputDevice: { id: 'zen-uid', name: 'Zen Quadro' }, ...over })) }) as Partial<VoiceTakeApi>
  const settingsHtml = (c: VoiceController): string => renderToStaticMarkup(createElement(VoiceTrackSettings, { controller: c, onClose: () => undefined }))

  it('the voice header has a Track settings gear that opens the popup (aria-haspopup dialog)', async () => {
    const { c, engine } = await setup()
    const html = renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never, view: null }))
    expect(html).toMatch(/aria-haspopup="dialog"[^>]*aria-expanded="false"[^>]*aria-label="Track settings"/)
    c.dispose()
  })
  it('lists the candidates; an unusable one is disabled with its typed reason and cannot be chosen', async () => {
    const store = memory()
    const { c, api } = await setup(withCandidates(), undefined, undefined, store)
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    const html = settingsHtml(c)
    expect(html).toContain('Same as song output (Zen Quadro)')
    expect(html).toMatch(/<option value="bt-uid" disabled="">Headphones BT \(unavailable: Bluetooth adds too much delay[^<]*<\/option>/)
    expect(html).toMatch(/<option value="mbp-spk" disabled="">MacBook Speakers \(unavailable: Monitoring needs the input and output on one device/)
    expect(html).toMatch(/<option value="zen-uid">Zen Quadro<\/option>/)
    api.monitorAvailability.mockClear()
    await c.setMonitorOutput('bt-uid') // negative control: the disabled entry is refused
    await c.setMonitorOutput('not-listed')
    expect(c.getSnapshot().monitorOutput).toBeNull()
    expect(store.m.get(KEY)).toBeUndefined()
    expect(api.monitorAvailability).not.toHaveBeenCalled()
    c.dispose()
  })
  it('the selection is sent as outputDeviceId and remembered; the default sends null', async () => {
    const store = memory()
    const { c, api } = await setup(withCandidates(), undefined, undefined, store)
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.setMonitorOutput('zen-uid')
    expect(store.m.get(KEY)).toBe('zen-uid')
    await vi.waitFor(() => expect(api.monitorAvailability).toHaveBeenLastCalledWith(expect.objectContaining({ outputDeviceId: 'zen-uid' })))
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: true, outputDeviceId: 'zen-uid' }))
    await c.setMonitorOutput(null)
    expect(store.m.get(KEY)).toBe('')
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: true, outputDeviceId: null }))
    await c.toggleMonitor()
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: true, outputDeviceId: null }))
    c.dispose()
    // a fresh controller (remount after restart) restores the choice; monitoring itself is never remembered
    const again = await setup(withCandidates(), undefined, undefined, memory({ [KEY]: 'zen-uid' }))
    expect(again.c.getSnapshot().monitorOutput).toBe('zen-uid')
    expect(again.c.getSnapshot().monitor.on).toBe(false)
    again.c.dispose()
  })
  it('choosing an output while monitoring restarts it as a transient state, not an error', async () => {
    const { c, api } = await setup(withCandidates())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.toggleMonitor()
    let done!: (v: VoiceMonitorState) => void
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { done = r }))
    const switching = c.setMonitorOutput('zen-uid')
    await vi.waitFor(() => expect(c.getSnapshot().monitorSwitching).toBe(true))
    expect(settingsHtml(c)).toContain('Switching the monitor output…')
    expect(c.getSnapshot().error).toBeNull()
    done(monState({ on: true, outputCandidates: candidates, outputDevice: { id: 'zen-uid', name: 'Zen Quadro' } }))
    await switching
    expect(c.getSnapshot().monitorSwitching).toBe(false)
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(c.getSnapshot().error).toBeNull()
    c.dispose()
  })
  it('a typed refusal on the new device leaves the monitor off without raising an error', async () => {
    const { c, api } = await setup(withCandidates())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.toggleMonitor()
    api.monitorSet.mockResolvedValueOnce(monState({ available: { reason: 'route-separate-devices' }, on: false, latency: null, outputCandidates: candidates }))
    await c.setMonitorOutput('zen-uid')
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(c.getSnapshot().monitor.reason).toBe('route-separate-devices')
    expect(c.getSnapshot().error).toBeNull()
    c.dispose()
  })
  it('a remembered device missing from the candidates falls back to the default and says so', async () => {
    const store = memory({ [KEY]: 'gone-uid' })
    const { c, api } = await setup(withCandidates(), undefined, undefined, store)
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    expect(c.getSnapshot().monitorOutput).toBeNull()
    expect(c.getSnapshot().monitorOutputMissing).toBe(true)
    expect(settingsHtml(c)).toContain('The saved output is not available.')
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ outputDeviceId: null }))
    c.dispose()
    // negative control: a present remembered device is used and no fallback note is shown
    const ok = await setup(withCandidates(), undefined, undefined, memory({ [KEY]: 'zen-uid' }))
    await vi.waitFor(() => expect(ok.c.getSnapshot().monitorOutputs).toHaveLength(3))
    expect(ok.c.getSnapshot().monitorOutput).toBe('zen-uid')
    expect(ok.c.getSnapshot().monitorOutputMissing).toBe(false)
    ok.c.dispose()
  })
  it('strict parse: junk in storage is ignored', async () => {
    for (const raw of ['on', ' padded ', 'a\u0000b', 'x'.repeat(300)]) {
      const { c } = await setup({}, undefined, undefined, memory({ [KEY]: raw }))
      expect(c.getSnapshot().monitorOutput, raw).toBeNull()
      c.dispose()
    }
  })
  it('the route line shows the device, buffer and estimated delay only while monitoring', async () => {
    const { c } = await setup(withCandidates())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    expect(settingsHtml(c)).toContain('Route: shown while monitoring.')
    await c.toggleMonitor()
    expect(settingsHtml(c)).toMatch(/Route: Zen Quadro · buffer \d+ frames · estimated delay ≈ \d+ ms/)
    c.dispose()
  })
})

describe('monitor output: back-to-back picks, refusals and unusable remembered devices', () => {
  const memory = (init: Record<string, string> = {}) => {
    const m = new Map(Object.entries(init))
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }
  const cands = [
    { id: 'a-uid', name: 'Interface A', usable: true },
    { id: 'b-uid', name: 'Interface B', usable: true },
    { id: 'bt-uid', name: 'Headphones BT', usable: false, reason: 'route-separate-devices' as const }
  ]
  const apiOver = (): Partial<VoiceTakeApi> =>
    ({ monitorAvailability: vi.fn(async () => monState({ on: false, outputCandidates: cands })) }) as Partial<VoiceTakeApi>
  const outputsOf = (api: ReturnType<typeof fakeApi>): (string | null | undefined)[] =>
    api.monitorSet.mock.calls.filter((c) => (c[0] as { on: boolean }).on).map((c) => (c[0] as { outputDeviceId?: string | null }).outputDeviceId)

  it('pick A then B back to back while the switch is in flight: B is sent once A settles', async () => {
    const { c, api } = await setup(apiOver())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.toggleMonitor()
    api.monitorSet.mockClear()
    let doneA!: (v: VoiceMonitorState) => void
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { doneA = r }))
    const a = c.setMonitorOutput('a-uid')
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalledTimes(1))
    await c.setMonitorOutput('b-uid') // in flight: recorded, not dropped
    expect(api.monitorSet).toHaveBeenCalledTimes(1)
    doneA(monState({ on: true, outputCandidates: cands }))
    await a
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalledTimes(2))
    expect(outputsOf(api)).toEqual(['a-uid', 'b-uid']) // negative control: without the re-issue native would stay on A
    expect(c.getSnapshot().monitorOutput).toBe('b-uid')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.monitorSet).toHaveBeenCalledTimes(2) // once, no loop
    c.dispose()
  })
  it('a pick made while the toggle-on is in flight is sent after it lands', async () => {
    const { c, api } = await setup(apiOver())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    let done!: (v: VoiceMonitorState) => void
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { done = r }))
    const toggling = c.toggleMonitor()
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalledTimes(1))
    await c.setMonitorOutput('b-uid')
    done(monState({ on: true, outputCandidates: cands }))
    await toggling
    await vi.waitFor(() => expect(outputsOf(api)).toEqual([null, 'b-uid']))
    c.dispose()
  })
  it('a pick that returns to what was sent while in flight is not re-sent', async () => {
    const { c, api } = await setup(apiOver())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.toggleMonitor()
    api.monitorSet.mockClear()
    let doneA!: (v: VoiceMonitorState) => void
    api.monitorSet.mockImplementationOnce(() => new Promise<VoiceMonitorState>((r) => { doneA = r }))
    const a = c.setMonitorOutput('a-uid')
    await vi.waitFor(() => expect(api.monitorSet).toHaveBeenCalledTimes(1))
    await c.setMonitorOutput('b-uid')
    await c.setMonitorOutput('a-uid')
    doneA(monState({ on: true, outputCandidates: cands }))
    await a
    await vi.advanceTimersByTimeAsync(0)
    expect(outputsOf(api)).toEqual(['a-uid'])
    c.dispose()
  })
  it('a refused switch releases the input the monitor held', async () => {
    const { c, api } = await setup(apiOver())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.toggleMonitor()
    expect(c.getSnapshot().armed).toBe(false) // monitoring holds the input, the arm button is untouched
    api.disarm.mockClear()
    api.monitorSet.mockResolvedValueOnce(monState({ available: { reason: 'route-separate-devices' }, on: false, latency: null, outputCandidates: cands }))
    await c.setMonitorOutput('a-uid')
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(c.getSnapshot().armed).toBe(false) // negative control: it used to stay armed with the input open
    await vi.waitFor(() => expect(api.disarm).toHaveBeenCalled())
    c.dispose()
  })
  it('a failed switch (the call throws) turns the monitor off and releases its arm', async () => {
    const { c, api } = await setup(apiOver())
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    await c.toggleMonitor()
    api.disarm.mockClear()
    api.monitorSet.mockRejectedValueOnce(new Error('boom'))
    await c.setMonitorOutput('a-uid')
    expect(c.getSnapshot().monitor.on).toBe(false)
    expect(c.getSnapshot().armed).toBe(false)
    await vi.waitFor(() => expect(api.disarm).toHaveBeenCalled())
    c.dispose()
  })
  it('a remembered output that is present but unusable falls back to the default and says so', async () => {
    const { c, api } = await setup(apiOver(), undefined, undefined, memory({ 'singz.voice.monitorOutput': 'bt-uid' }))
    await vi.waitFor(() => expect(c.getSnapshot().monitorOutputs).toHaveLength(3))
    expect(c.getSnapshot().monitorOutput).toBeNull()
    expect(c.getSnapshot().monitorOutputMissing).toBe(true)
    await c.toggleMonitor()
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ outputDeviceId: null }))
    c.dispose()
    // negative control: a usable remembered output is kept
    const ok = await setup(apiOver(), undefined, undefined, memory({ 'singz.voice.monitorOutput': 'a-uid' }))
    await vi.waitFor(() => expect(ok.c.getSnapshot().monitorOutputs).toHaveLength(3))
    expect(ok.c.getSnapshot().monitorOutput).toBe('a-uid')
    ok.c.dispose()
  })
})

describe('voice lane: tooltips, waveform, selection, move and delete', () => {
  const recorded = async (apiOver: Partial<VoiceTakeApi> = {}, over: Partial<VoiceTakeSummary> = {}) => {
    const r = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary(over) })), ...apiOver })
    await r.c.toggleRecord()
    await r.c.toggleRecord()
    return r
  }
  const strip = (c: VoiceController, engine: unknown, view: { s: number; e: number } | null = null): string =>
    renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never, view }))

  it('every button of the strip, the take actions and the popup has an accessible name and the in-app Tooltip around it', async () => {
    const { c, engine } = await recorded()
    const pages = [
      strip(c, engine),
      renderToStaticMarkup(createElement('div', null, createElement(VoiceRecordButton, { controller: c }))),
      renderToStaticMarkup(createElement(VoiceTrackSettings, { controller: c, onClose: () => undefined }))
    ]
    c.selectTake(true)
    await c.moveTake(60) // a moved take also shows Reset position
    pages.push(strip(c, engine))
    let buttons = 0
    for (const html of pages) {
      for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        buttons++
        const attrs = m[1]!
        const name = /aria-label="([^"]+)"/.exec(attrs)?.[1] ?? m[2]!.replace(/<[^>]*>/g, '').trim()
        expect(name, attrs).not.toBe('')
        expect(attrs, `native title on ${name}`).not.toContain('title=') // native title tooltips do not show: the in-app Tooltip owns it
        expect(html.slice(Math.max(0, m.index! - 80), m.index!), `Tooltip around ${name}`).toMatch(/<span class="sz-tip-wrap[^"]*">$/)
      }
    }
    expect(buttons).toBeGreaterThan(10)
    expect(pages[3]).toContain('aria-label="Reset position"')
    // shortcut hints ride in the tooltip text
    expect(pages[1]).toContain('aria-label="Record (R)"')
    expect(pages[3]).toContain('aria-label="Discard take (Delete)"')
    c.dispose()
  })
  it('a just-finished take gets real peaks from main and draws a waveform, not a grid', async () => {
    const peaks = Array.from({ length: 200 }, (_, i) => Math.abs(Math.sin(i / 7)) * 0.8)
    const { c, engine, api } = await recorded({ peaks: vi.fn(async () => ({ ok: true as const, stepSec: 0.05, durationSec: 10, peaks })) })
    await vi.waitFor(() => expect(c.getSnapshot().take?.peaks).toEqual(peaks))
    expect(api.peaks).toHaveBeenCalledWith({ songId: 'song-1', takeId: 'take-1' })
    const html = strip(c, engine)
    expect(html).toContain('<polygon')
    expect(html).toContain('class="vs-wave-mid"')
    expect(html).not.toContain('repeating-linear-gradient')
    c.dispose()
  })
  it('a take loaded from disk also gets its peaks; a silent take is a flat centre line and no polygon is faked', async () => {
    const list = vi.fn(async () => [summary({ takeId: 'old-1', userOffsetSec: 0 })])
    const { c, engine, api } = await setup({ list, peaks: vi.fn(async () => ({ ok: true as const, stepSec: 0.05, durationSec: 10, peaks: [0.5, 0.9, 0.2] })) })
    await vi.waitFor(() => expect(c.getSnapshot().take?.peaks).toEqual([0.5, 0.9, 0.2]))
    expect(api.peaks).toHaveBeenCalledWith({ songId: 'song-1', takeId: 'old-1' })
    expect(strip(c, engine)).toContain('<polygon')
    c.dispose()
    const silent = await recorded() // the fake has no peaks for it: nothing to draw but the line
    const html = strip(silent.c, silent.engine)
    expect(html).toContain('class="vs-wave-mid"')
    expect(html).not.toContain('<polygon')
    silent.c.dispose()
  })
  it('the clip is a selectable option; selection is controller state, not allowed while recording, and reset with the song', async () => {
    const r = await setup()
    await r.c.toggleRecord()
    r.c.selectTake(true)
    expect(r.c.getSnapshot().takeSelected).toBe(false) // a take that is still recording stays unselectable
    await r.c.toggleRecord()
    expect(strip(r.c, r.engine)).toMatch(/role="option" aria-selected="false" tabindex="0"/)
    r.c.selectTake(true)
    expect(strip(r.c, r.engine)).toMatch(/role="option" aria-selected="true" tabindex="0" class="vs-clip[^"]*\bselected\b/)
    expect(r.c.getSnapshot().takeSelected).toBe(true)
    // selection survives zoom and scroll: the view only changes how it is drawn
    expect(strip(r.c, r.engine, { s: 20, e: 60 })).toContain('aria-selected="true"')
    r.c.selectTake(false)
    expect(r.c.getSnapshot().takeSelected).toBe(false)
    r.c.selectTake(true)
    await r.c.setSong('song-2')
    expect(r.c.getSnapshot().takeSelected).toBe(false)
    r.c.dispose()
  })
  it('moving clamps to [0, song duration - take span] and stores only the offset beside the measured start', async () => {
    const { c, api } = await recorded() // start 30 s, 10 s take, 200 s song
    await c.moveTake(100)
    expect(api.move).toHaveBeenLastCalledWith({ songId: 'song-1', takeId: 'take-1', userOffsetSec: 70 })
    expect(c.getSnapshot().take).toMatchObject({ startSec: 100, userOffsetSec: 70 })
    await c.moveTake(-5)
    expect(api.move).toHaveBeenLastCalledWith(expect.objectContaining({ userOffsetSec: -30 })) // clamped to 0
    expect(c.getSnapshot().take?.startSec).toBe(0)
    await c.moveTake(1000)
    expect(api.move).toHaveBeenLastCalledWith(expect.objectContaining({ userOffsetSec: 160 })) // clamped to 200 - 10
    expect(c.getSnapshot().take?.startSec).toBe(190)
    for (const call of api.move.mock.calls) expect((call[0] as { userOffsetSec: number }).userOffsetSec).toBeGreaterThanOrEqual(-30) // never an unclamped value
    c.dispose()
  })
  it('a move that is not saved goes back where it was; Reset position restores the measured start', async () => {
    const { c, api } = await recorded()
    api.move.mockResolvedValueOnce({ ok: false, error: 'disk' })
    await c.moveTake(80)
    expect(c.getSnapshot().take).toMatchObject({ startSec: 30, userOffsetSec: 0 })
    await c.moveTake(80)
    expect(c.getSnapshot().take?.startSec).toBe(80)
    await c.resetTakePosition()
    expect(api.move).toHaveBeenLastCalledWith(expect.objectContaining({ userOffsetSec: 0 }))
    expect(c.getSnapshot().take).toMatchObject({ startSec: 30, userOffsetSec: 0 })
    c.dispose()
  })
  it('keyboard nudges are small moves; none while recording or listening', async () => {
    const r = await setup()
    await r.c.toggleRecord()
    await r.c.moveTake(5)
    expect(r.api.move).not.toHaveBeenCalled()
    await r.c.toggleRecord()
    const start = r.c.getSnapshot().take!.startSec
    await r.c.moveTake(start + 0.1)
    expect(r.c.getSnapshot().take?.startSec).toBeCloseTo(start + 0.1, 3)
    await r.c.listen('take')
    r.api.move.mockClear()
    await r.c.moveTake(100)
    expect(r.api.move).not.toHaveBeenCalled() // not while listening
    r.c.dispose()
  })
  it('a take loaded after a restart sits at its moved position, and listen-back seeks there', async () => {
    const list = vi.fn(async () => [summary({ startPositionSec: 30, userOffsetSec: 12 })])
    const { c, engine, api } = await setup({ list })
    await vi.waitFor(() => expect(c.getSnapshot().take).not.toBeNull())
    expect(c.getSnapshot().take).toMatchObject({ startSec: 42, userOffsetSec: 12 })
    await c.listen('with-song')
    expect(engine.seek).toHaveBeenCalledWith(42) // negative control: not the measured 30
    expect(api.play).toHaveBeenCalled()
    c.dispose()
  })
  it('Delete removes the selected take and clears the selection; with nothing selected it does nothing', async () => {
    const { c, api } = await recorded()
    await c.deleteSelected()
    expect(api.remove).not.toHaveBeenCalled()
    expect(c.getSnapshot().take).not.toBeNull()
    c.selectTake(true)
    await c.deleteSelected()
    expect(api.remove).toHaveBeenCalledWith('song-1', 'take-1')
    expect(c.getSnapshot().take).toBeNull()
    expect(c.getSnapshot().takeSelected).toBe(false)
    c.dispose()
  })
})

describe('in-app Tooltip', () => {
  const make = () => {
    const seen: boolean[] = []
    const ctl = new TipController((v) => seen.push(v))
    return { ctl, seen }
  }
  it('shows after the hover delay, not before; leaving first cancels it', () => {
    vi.useFakeTimers()
    const { ctl, seen } = make()
    ctl.pointerEnter()
    vi.advanceTimersByTime(TIP_DELAY_MS - 1)
    expect(ctl.visible).toBe(false) // negative control: a native title would also wait, nothing earlier shows
    vi.advanceTimersByTime(1)
    expect(ctl.visible).toBe(true)
    ctl.pointerLeave()
    expect(ctl.visible).toBe(false)
    ctl.pointerEnter()
    vi.advanceTimersByTime(TIP_DELAY_MS - 10)
    ctl.pointerLeave()
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([true, false])
    vi.useRealTimers()
  })
  it('keyboard focus shows at once; a mouse-press focus does not; blur hides', () => {
    const { ctl } = make()
    ctl.focus(false)
    expect(ctl.visible).toBe(false)
    ctl.focus(true)
    expect(ctl.visible).toBe(true)
    ctl.blur()
    expect(ctl.visible).toBe(false)
  })
  it('a press, Esc or a scroll (dismiss) hides it and cancels a pending show', () => {
    vi.useFakeTimers()
    const { ctl } = make()
    ctl.pointerEnter()
    vi.advanceTimersByTime(TIP_DELAY_MS)
    expect(ctl.visible).toBe(true)
    ctl.dismiss()
    expect(ctl.visible).toBe(false)
    ctl.pointerEnter() // still hovering after the press: one more rest shows it again
    ctl.pointerLeave()
    ctl.pointerEnter()
    ctl.dismiss()
    vi.advanceTimersByTime(1000)
    expect(ctl.visible).toBe(false)
    vi.useRealTimers()
  })
  it('keeps the tip inside the viewport: above when there is room, below when not, clamped sideways', () => {
    const vp = { width: 400, height: 300 }
    const tip = { width: 120, height: 24 }
    expect(placeTip({ left: 100, top: 150, width: 24, height: 24 }, tip, vp)).toMatchObject({ side: 'above', top: 150 - 24 - 8 })
    expect(placeTip({ left: 100, top: 10, width: 24, height: 24 }, tip, vp)).toMatchObject({ side: 'below', top: 42 })
    expect(placeTip({ left: 0, top: 150, width: 10, height: 24 }, tip, vp).left).toBe(6)
    expect(placeTip({ left: 395, top: 150, width: 10, height: 24 }, tip, vp).left).toBe(400 - 120 - 6)
  })
  it('wraps the control (a disabled one too) in a pointer-receiving wrapper and leaves aria-label and no title on it', () => {
    const html = renderToStaticMarkup(
      createElement(Tooltip, { label: 'Why not' }, createElement('button', { type: 'button', disabled: true, 'aria-label': 'Do it' }, 'x'))
    )
    expect(html).toMatch(/^<span class="sz-tip-wrap"><button[^>]*aria-label="Do it"/)
    expect(html).not.toContain('title=')
    expect(html).not.toContain('role="tooltip"') // only while shown
  })
})

describe('take clip tag and silent take note', () => {
  const stripHtml = (c: VoiceController, engine: unknown): string =>
    renderToStaticMarkup(createElement(VoiceStrip, { controller: c, engine: engine as never, view: null }))
  it('names tempo and pitch with units only when they differ from the song', async () => {
    const r = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary({ tempo: 0.8, transposeSemitones: 2 } as never) })) })
    await r.c.toggleRecord()
    await r.c.toggleRecord()
    const html = stripHtml(r.c, r.engine)
    expect(html).toContain('Tempo 80%')
    expect(html).toContain('Pitch +2 st')
    expect(html).not.toContain('Tempo 100%')
    r.c.dispose()
  })
  it('a silent take says so; a take with signal or unknown peaks does not', () => {
    expect(takeIsSilent([0, 0.0001, 0])).toBe(true)
    expect(takeIsSilent([0, 0.2, 0])).toBe(false) // negative control
    expect(takeIsSilent([])).toBe(false)
    expect(takeIsSilent(undefined)).toBe(false)
  })
  it('renders the note on a silent take only', async () => {
    const silent = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary() })), peaks: vi.fn(async () => ({ ok: true as const, stepSec: 0.05, durationSec: 10, peaks: [0, 0, 0] })) })
    await silent.c.toggleRecord()
    await silent.c.toggleRecord()
    await vi.waitFor(() => expect(silent.c.getSnapshot().take?.peaks).toEqual([0, 0, 0]))
    expect(stripHtml(silent.c, silent.engine)).toContain('No signal recorded')
    silent.c.dispose()
    const loud = await setup({ recordStop: vi.fn(async () => ({ ok: true, take: summary() })), peaks: vi.fn(async () => ({ ok: true as const, stepSec: 0.05, durationSec: 10, peaks: [0.4, 0.6] })) })
    await loud.c.toggleRecord()
    await loud.c.toggleRecord()
    await vi.waitFor(() => expect(loud.c.getSnapshot().take?.peaks).toEqual([0.4, 0.6]))
    expect(stripHtml(loud.c, loud.engine)).not.toContain('No signal recorded')
    loud.c.dispose()
  })
})

describe('input ownership interleavings', () => {
  const deferred = <T,>() => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => { resolve = r })
    return { promise, resolve }
  }
  it('arm clicked while the monitor is opening shares ONE api.arm and never disarms (negative control: two arms and a disarm)', async () => {
    const gate = deferred<{ ok: true }>()
    const { c, api } = await setup({ arm: vi.fn(() => gate.promise) as never })
    const monitoring = c.toggleMonitor()
    await vi.waitFor(() => expect(api.arm).toHaveBeenCalledTimes(1))
    const arming = c.arm()
    await Promise.resolve()
    gate.resolve({ ok: true })
    await Promise.all([monitoring, arming])
    expect(api.arm).toHaveBeenCalledTimes(1)
    expect(api.disarm).not.toHaveBeenCalled()
    expect(c.getSnapshot().armed).toBe(true)
    expect(c.getSnapshot().monitor.on).toBe(true)
    c.dispose()
  })
  it('monitor toggled while the arm is opening shares the same open', async () => {
    const gate = deferred<{ ok: true }>()
    const { c, api } = await setup({ arm: vi.fn(() => gate.promise) as never })
    const arming = c.arm()
    await vi.waitFor(() => expect(api.arm).toHaveBeenCalledTimes(1))
    const monitoring = c.toggleMonitor()
    await Promise.resolve()
    gate.resolve({ ok: true })
    await Promise.all([arming, monitoring])
    expect(api.arm).toHaveBeenCalledTimes(1)
    expect(api.disarm).not.toHaveBeenCalled()
    expect(c.getSnapshot().armed).toBe(true)
    expect(c.getSnapshot().monitor.on).toBe(true)
    // the last holder out closes it
    await c.toggleMonitor()
    expect(api.disarm).not.toHaveBeenCalled()
    await c.arm()
    expect(api.disarm).toHaveBeenCalledTimes(1)
    c.dispose()
  })
  it('arm joined to a monitor open, monitor withdrawn at any point around the open landing: the input stays open for the arm (negative control: closed under armed)', async () => {
    for (let ticks = 0; ticks <= 8; ticks++) {
      const gate = deferred<{ ok: true }>()
      const { c, api } = await setup({ arm: vi.fn(() => gate.promise) as never })
      const monitoring = c.toggleMonitor()
      await vi.waitFor(() => expect(api.arm).toHaveBeenCalledTimes(1))
      const arming = c.arm()
      await Promise.resolve()
      gate.resolve({ ok: true })
      for (let i = 0; i < ticks; i++) await Promise.resolve()
      await c.releaseMonitor() // the monitor goes stale somewhere while the shared open lands
      await Promise.all([monitoring, arming])
      expect(c.getSnapshot().armed, `ticks ${ticks}`).toBe(true)
      expect(api.disarm, `ticks ${ticks}`).not.toHaveBeenCalled()
      c.dispose()
    }
  })
  it('arm then monitor then disarm then monitor off closes the input exactly once, at the end', async () => {
    const { c, api } = await setup()
    await c.arm()
    await c.toggleMonitor()
    await c.arm()
    expect(api.disarm).not.toHaveBeenCalled()
    await c.toggleMonitor()
    expect(api.disarm).toHaveBeenCalledTimes(1)
    c.dispose()
  })
  it('monitor then record: the take reuses the input, stopping it hands the input back to the monitor', async () => {
    const { c, api } = await setup()
    await c.toggleMonitor()
    await c.toggleRecord()
    await c.toggleRecord()
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.disarm).not.toHaveBeenCalled() // negative control: stop used to disarm under a live monitor
    await c.toggleMonitor()
    expect(api.disarm).toHaveBeenCalledTimes(1)
    c.dispose()
  })
  it('a record start that fails busy leaves the live monitor input open; without a monitor it closes it', async () => {
    const busy = { recordStart: vi.fn(async () => ({ ok: false as const, reason: 'busy' as const, message: '' })) }
    const live = await setup(busy)
    await live.c.toggleMonitor()
    await live.c.toggleRecord()
    expect(live.c.getSnapshot().error).toBe('busy')
    expect(live.c.getSnapshot().monitor.on).toBe(true)
    expect(live.api.disarm).not.toHaveBeenCalled()
    live.c.dispose()
    const alone = await setup(busy)
    await alone.c.toggleRecord()
    expect(alone.api.disarm).toHaveBeenCalled() // negative control: nothing holds the input
    alone.c.dispose()
  })
  it('a start undone because the song changed keeps a live monitor\'s input', async () => {
    const gate = deferred<{ ok: true; takeId: string }>()
    const { c, api } = await setup({ recordStart: vi.fn(() => gate.promise) as never })
    await c.toggleMonitor()
    const rec = c.toggleRecord()
    await vi.waitFor(() => expect(api.recordStart).toHaveBeenCalled())
    await c.setSong('song-2')
    gate.resolve({ ok: true, takeId: 'take-9' })
    await rec
    expect(api.remove).toHaveBeenCalled() // the start was undone
    expect(c.getSnapshot().monitor.on).toBe(true)
    expect(api.disarm).not.toHaveBeenCalled()
    c.dispose()
  })
  it('unplug during a monitor-only session closes the input; an armed one stays open', async () => {
    const lost = () => monState({ available: { reason: 'device-lost' }, on: false, latency: null })
    const only = await setup()
    await only.c.toggleMonitor()
    only.api.monitorState.mockResolvedValue(lost())
    for (let i = 0; i < 12; i++) await only.c.pollLevel()
    await vi.waitFor(() => expect(only.c.getSnapshot().monitor.on).toBe(false))
    expect(only.api.disarm).toHaveBeenCalledTimes(1) // negative control: it stayed open with no owner
    only.c.dispose()
    const armed = await setup()
    await armed.c.arm()
    await armed.c.toggleMonitor()
    armed.api.monitorState.mockResolvedValue(lost())
    for (let i = 0; i < 12; i++) await armed.c.pollLevel()
    await vi.waitFor(() => expect(armed.c.getSnapshot().monitor.on).toBe(false))
    expect(armed.c.getSnapshot().armed).toBe(true)
    expect(armed.api.disarm).not.toHaveBeenCalled()
    armed.c.dispose()
  })
})

describe('Tooltip styles', () => {
  const css = readFileSync(new URL('../../src/renderer/src/components/voice-strip.css', import.meta.url), 'utf8')
  const src = readFileSync(new URL('../../src/renderer/src/components/Tooltip.tsx', import.meta.url), 'utf8')
  const rendered = [...new Set([...src.matchAll(/sz-tip[\w-]*/g)].map((m) => m[0]))].filter((n) => n !== 'sz-tip-wrap' ? true : true)
  it('every class the component renders has a CSS rule, and the tip is a fixed, topmost, click-through surface', () => {
    expect(rendered).toEqual(expect.arrayContaining(['sz-tip', 'sz-tip-wrap']))
    for (const name of rendered) expect(css, `.${name} has no rule`).toMatch(new RegExp(`\\.${name}[\\s{.:,>]`))
    const tip = /\.sz-tip \{([^}]*)\}/.exec(css)![1]!
    expect(tip).toMatch(/position:\s*fixed/)
    expect(tip).toMatch(/pointer-events:\s*none/)
    expect(tip).toMatch(/background:/)
    expect(Number(/z-index:\s*(\d+)/.exec(tip)![1])).toBeGreaterThan(1000)
    expect(css).toMatch(/prefers-reduced-motion: no-preference\)\s*\{\s*\.sz-tip \{ animation/)
    expect(css).toMatch(/\.sz-tip\.above::after/)
    expect(css).toMatch(/\.sz-tip\.below::after/)
  })
})

describe('app-level monitor chip', () => {
  const html = (c: VoiceController): string => renderToStaticMarkup(createElement(MonitorChipView, { m: c.getSnapshot(), onStop: () => undefined }))
  it('monitor on with no strip mounted (library view) shows the chip; it stops the monitor; a mounted strip hides it', async () => {
    const { c, api } = await setup()
    expect(html(c)).toBe('') // monitor off: nothing
    await c.toggleMonitor()
    expect(html(c)).toContain('aria-label="Monitoring your voice: click to stop"') // negative control below
    expect(html(c)).toContain('class="vs-mon-chip"')
    c.setStripMounted(true)
    expect(html(c)).toBe('') // the strip is on screen: it owns the control
    c.setStripMounted(false)
    // the click wiring: the button calls the stop handler, which is the controller's releaseMonitor
    let stopped = 0
    const el = MonitorChipView({ m: c.getSnapshot(), onStop: () => { stopped++; void c.releaseMonitor() } }) as { props: { children: { props: { onClick: () => void } } } }
    el.props.children.props.onClick()
    expect(stopped).toBe(1)
    await vi.waitFor(() => expect(c.getSnapshot().monitor.on).toBe(false))
    expect(api.monitorSet).toHaveBeenLastCalledWith(expect.objectContaining({ on: false }))
    expect(html(c)).toBe('')
    c.dispose()
  })
  it('the strip reports itself mounted through the controller', async () => {
    const { c, engine } = await setup()
    expect(c.getSnapshot().stripMounted).toBe(false)
    c.setStripMounted(true)
    expect(c.getSnapshot().stripMounted).toBe(true)
    void engine
    c.dispose()
  })
})
