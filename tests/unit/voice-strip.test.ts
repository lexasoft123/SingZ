/*
 * Voice strip (ADR 0014, spec §4): the state machine over fake engine / bridge
 * ports, the three-language key set, and the strip's accessible markup.
 */
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
  VOICE_STATES,
  VoiceController,
  type VoiceEnginePort,
  type VoiceModel,
  type VoiceTakeApi
} from '../../src/renderer/src/audio/voice-take'
import VoiceStrip from '../../src/renderer/src/components/VoiceStrip'
import { VoiceRecordButton } from '../../src/renderer/src/components/voice-record-button'
import type { VoiceTakeSummary } from '../../src/shared/voice-take'

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
    level: vi.fn(async () => ({ peakDb: -20, rmsDb: -30 })),
    ...over
  }
  return api as never
}

let clock = 0
async function setup(apiOver: Partial<VoiceTakeApi> = {}, engineOver?: (e: ReturnType<typeof fakeEngine>) => void) {
  const engine = fakeEngine()
  engineOver?.(engine)
  const api = fakeApi(apiOver)
  const c = new VoiceController({
    api,
    engine,
    askMicAccess: async () => true,
    listInputs: async () => ({ inputs: [{ id: 'mic', label: 'Scarlett 2i2' }], labelsHidden: false }),
    now: () => clock,
    storage: null
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
  const take = { takeId: 't', n: 1, startSec: 0, durationSec: 5, tempo: 1, transpose: 0, changed: false, kept: false, partial: false, recovered: false }
  it('orders error > recording > playing > review > permission > missing > monitoring > armed > idle', () => {
    expect(primaryState(m({}))).toBe('idle')
    expect(primaryState(m({ armed: true }))).toBe('armed')
    expect(primaryState(m({ armed: true, monitor: { avail: 'ok', on: true } }))).toBe('monitoring-on')
    expect(primaryState(m({ monitor: { avail: 'latency', on: false } }))).toBe('monitoring-unavailable-latency')
    expect(primaryState(m({ monitor: { avail: 'route', on: false } }))).toBe('monitoring-unavailable-route')
    expect(primaryState(m({ inputMissing: true, monitor: { avail: 'route', on: false } }))).toBe('input-missing')
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
  it('blocks Record for an unresolved take, a denied mic, no input, a listen, no song', () => {
    expect(recordBlock(m({}))).toBeNull()
    expect(recordBlock(m({ take }))).toBe('take')
    expect(recordBlock(m({ take: { ...take, kept: true } }))).toBeNull()
    expect(recordBlock(m({ perm: 'denied' }))).toBe('perm')
    expect(recordBlock(m({ inputMissing: true }))).toBe('missing')
    expect(recordBlock(m({ error: 'error' }))).toBe('error')
    expect(recordBlock(m({ take: { ...take, kept: true }, listen: 'take' }))).toBe('listening')
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

  it('disables Record while a take is unresolved; keep or discard frees it', async () => {
    const { c, api } = await setup()
    await c.toggleRecord()
    await c.toggleRecord()
    api.recordStart.mockClear()
    await c.toggleRecord()
    expect(api.recordStart).not.toHaveBeenCalled()
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
  it('idle strip: labelled region, toggle buttons with aria-pressed, labelled slider and meter, inert monitor', async () => {
    const html = await render()
    expect(html).toContain('aria-label="Voice strip"')
    expect(html).toContain('aria-label="Arm for recording"')
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Arm for recording"|aria-label="Arm for recording"[^>]*aria-pressed="false"/)
    expect(html).toContain('aria-label="Mute voice take playback"')
    expect(html).toContain('aria-label="Solo voice"')
    expect(html).toContain('aria-label="Voice level"')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-label="Monitoring comes later"')
    expect(html).toMatch(/aria-disabled="true"[^>]*aria-label="Monitoring comes later"|aria-label="Monitoring comes later"[^>]*aria-disabled="true"/)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-label="Record (R)"')
    expect(html).toContain('title="Record (R)"')
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
    expect(html).toContain('aria-label="Discard take"')
    expect(html).toContain('aria-label="Record unavailable: keep or discard the current take first"')
    expect(html).toContain('recorded at 100% · 0')
  })
})
