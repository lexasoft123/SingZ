/**
 * Native seeks against the watcher that stops playback at the end of a
 * non-looping selection — the real `MultitrackEngine`, and a native client that
 * seeks the way `DesktopNativePlaybackClient` does: the target is what
 * `audibleSeconds` reports from the moment the queued seek STARTS, and a seek
 * is two IPC round trips (the command, then the status refresh), serialized
 * behind whatever the client was already doing.
 *
 * Field report: a selection held a song's first Play and none after it. The
 * watcher was only armed by the fresh-start path and the count-in restart;
 * arming it on every Play then exposed two seek races that the first Play had
 * always had, and both paused a playing song where a singer had just put the
 * cursor:
 *
 *   1. ONE seek past the selection's end. `seek()` moved `startOffset` in its
 *      receipt, two round trips after the client reported the new position,
 *      so a tick in between saw the old start (inside) beside the new
 *      position (past the end).
 *   2. OVERLAPPING seeks — a held arrow key repeats faster than two round
 *      trips. With `startOffset` moved at issue time, the first seek's receipt
 *      wrote its older target over the second's, and a seek queued behind
 *      another moved the start before the client's position had moved off the
 *      first target. Two things answer it: the watcher does not judge while a
 *      seek is in flight (the GATE), and seeks are numbered so that only the
 *      latest may touch the start when it settles (the NUMBERING).
 *
 *      Measured by removing each: without the gate 13 cases fail, all of them
 *      backward; without the numbering none fail; without both 28 fail — the
 *      same 13 plus 15 of the 20 forward ones (all but the five at 3 ms, where
 *      the two seeks do not overlap). So either mechanism holds the forward
 *      pairs on its own, and only the gate holds the backward.
 *
 * These are the deterministic half of that evidence. The E2E leg in
 * `transport-race-e2e.cjs` is the other half and is only probabilistic, even
 * on the Windows field laptop, because it depends on real round-trip times.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

class Param { value = 0; setValueAtTime(): void {}; linearRampToValueAtTime(): void {}; setTargetAtTime(): void {} }
class Gain { gain = new Param(); connect(): void {}; disconnect(): void {} }
class Source {
  buffer = null; playbackRate = { value: 1 }; frequency = new Param(); loop = false; loopStart = 0; loopEnd = 0
  onended = null; connect(): void {}; disconnect(): void {}; start(): void {}; stop(): void {}
}
class FakeAudioContext {
  currentTime = 10; state = 'running'; sampleRate = 48000; outputLatency = 0; destination = {}
  createGain(): Gain { return new Gain() }
  createOscillator(): Source { return new Source() }
  createBufferSource(): Source { return new Source() }
  async resume(): Promise<void> {}
  async suspend(): Promise<void> {}
  async setSinkId(): Promise<void> {}
}

class StartupAudioContext extends FakeAudioContext {
  static last: StartupAudioContext | null = null
  sinkId: string | { type: 'none' }
  readonly physicalRoutes: string[]

  constructor(options: { sinkId?: string | { type: 'none' } } = {}) {
    super()
    this.sinkId = options.sinkId ?? ''
    this.physicalRoutes = [this.route(this.sinkId)]
    StartupAudioContext.last = this
  }

  private route(sink: string | { type: 'none' }): string {
    return typeof sink === 'string' ? sink || 'default' : 'none'
  }

  async setSinkId(sink: string | { type: 'none' } = ''): Promise<void> {
    this.sinkId = sink
    this.physicalRoutes.push(this.route(sink))
  }
}

async function reconcileStartupOutput(
  savedOutputId: string | undefined,
  nativeAvailable: boolean
): Promise<{
  result: import('../../src/renderer/src/audio/output-routing').PlaybackOutputReconcileResult
  context: StartupAudioContext
  enumerateOutputs: ReturnType<typeof vi.fn>
}> {
  vi.stubGlobal('AudioContext', StartupAudioContext)
  vi.stubGlobal('navigator', { platform: 'Linux' })
  vi.stubGlobal('window', {
    singz: { configureDesktopTrainingOutput: vi.fn(async () => ({ ok: true })) }
  })
  const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
  const { PlaybackOutputArbiter } = await import('../../src/renderer/src/audio/output-routing')
  const engine = new MultitrackEngine()
  const context = StartupAudioContext.last!
  const enumerateOutputs = vi.fn(async () =>
    savedOutputId && nativeAvailable && context.physicalRoutes.at(-1) === 'none'
      ? [{ kind: 'audiooutput' as const, deviceId: savedOutputId }]
      : []
  )
  const arbiter = new PlaybackOutputArbiter(savedOutputId, {
    setOutput: (sinkId) => engine.setOutput(sinkId),
    enumerateOutputs,
    commit: vi.fn()
  })
  const result = await arbiter.reconcile()
  return { result, context, enumerateOutputs }
}

describe('startup output ownership', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  const REAL_LABELS: readonly [string, string][] = [
    ['NoMachine Audio Adapter', 'NoMachine Audio Adapter (Virtual)'],
    ['Zen Quadro SC Playback', 'Zen Quadro SC Playback (23e5:a2f9)'],
    ['MacBook Pro Speakers', 'MacBook Pro Speakers (Built-in)']
  ]

  async function engineWith(platform: string, native: { uid: string; label: string; outputChannels: number }[],
    browser: { kind: string; deviceId: string; label: string }[], policy: { playback?: boolean } = {}) {
    vi.stubGlobal('AudioContext', StartupAudioContext)
    const enumerateDevices = vi.fn(async () => browser)
    vi.stubGlobal('navigator', { platform, mediaDevices: { enumerateDevices } })
    vi.stubGlobal('window', { singz: {
      audioHostDevices: vi.fn(async () => ({ ok: true, devices: native })),
      configureDesktopTrainingOutput: vi.fn(async () => ({ ok: true }))
    } })
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    return { engine: new MultitrackEngine(policy), enumerateDevices }
  }

  it('prepares the open paused song again after selecting the Zen output', async () => {
    vi.useFakeTimers()
    const uid = 'AppleUSBAudioEngine:Antelope Audio:Zen Quadro SC:4912524000285:1,2'
    const { engine } = await engineWith('MacIntel', [{ uid, label: 'Zen', outputChannels: 16 }], [])
    const client = { active: false, recoveryPending: false, preparedAhead: false, retainedPrepared: false,
      discardAhead: vi.fn(async () => { client.preparedAhead = false }) }
    const prepareAhead = vi.fn(async (_client: unknown, _request: { browserOutputId?: string }) => { client.preparedAhead = true; return true })
    const internals = engine as unknown as { nativePlayback: typeof client; ensureNativePlayback(): Promise<unknown> }
    internals.nativePlayback = client
    internals.ensureNativePlayback = async () => ({ client, prepareAhead })
    try {
      engine.load([{ id: 'vocals', buffer: { duration: 120 } as AudioBuffer, duration: 120, path: '/vocals.flac' }])
      await vi.advanceTimersByTimeAsync(400)
      expect(client.preparedAhead).toBe(true)
      await engine.setOutput(`native:${uid}`)
      expect(client.preparedAhead).toBe(false)
      await vi.advanceTimersByTimeAsync(399)
      expect(client.preparedAhead).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(client.preparedAhead).toBe(true)
      expect(prepareAhead).toHaveBeenCalledTimes(2)
      expect(prepareAhead.mock.calls[1][1].browserOutputId).toBe(`native:${uid}`)
    } finally { engine.setNativeAheadAllowed(false); vi.useRealTimers() }
  })

  it('adopts the unchanged native graph when Play arrives during its ahead build on Windows', async () => {
    vi.useFakeTimers()
    const { engine } = await engineWith('Win32', [{ uid: 'wasapi:speakers', label: 'Speakers', outputChannels: 2 }], [])
    let finishPrepare!: () => void
    const building = new Promise<void>(resolve => { finishPrepare = resolve })
    const calls: string[] = []
    const client = { active: false, transportActive: false, recoveryPending: false, retainedPrepared: false, preparedAhead: false,
      discardAhead: vi.fn(async () => { if (client.preparedAhead) calls.push('unload:1'); client.preparedAhead = false }),
      prepareRetainedForPlay: vi.fn(async () => {}) }
    let builds = 0
    const prepareAhead = vi.fn(async () => { calls.push(`prepare:${++builds}`); await building; client.preparedAhead = true; return true })
    const tryStart = vi.fn(async () => {
      if (!client.preparedAhead) calls.push(`prepare:${++builds}`)
      calls.push(`open:${builds}`, `start:${builds}`)
      client.preparedAhead = false; client.active = true; client.transportActive = true
      return true
    })
    const internals = engine as unknown as { nativePlayback: typeof client; ensureNativePlayback(): Promise<unknown> }
    internals.nativePlayback = client
    internals.ensureNativePlayback = async () => ({ client, prepareAhead, tryStart })
    try {
      engine.load([{ id: 'vocals', buffer: { duration: 120 } as AudioBuffer, duration: 120, path: '/vocals.flac' }])
      await vi.advanceTimersByTimeAsync(400)
      expect(calls).toEqual(['prepare:1'])
      const play = engine.play({ countIn: false })
      expect(engine.starting).toBe(true)
      finishPrepare()
      await play
      expect(engine.nativeActive).toBe(true)
      expect(engine.playing).toBe(true)
      expect(calls).toEqual(['prepare:1', 'open:1', 'start:1'])
      expect(client.discardAhead).not.toHaveBeenCalled()
    } finally { engine.setNativeAheadAllowed(false); vi.useRealTimers() }
  })

  it.each(['MacIntel', 'Win32'])('selecting a native output never needs a Chromium sink while native owns playback (%s)', async (platform) => {
    const all = REAL_LABELS.flatMap(([bare, decorated], i) => [
      { native: { uid: `uid${i}`, label: bare, outputChannels: 2 }, browser: { kind: 'audiooutput', deviceId: `b${i}`, label: decorated } }])
    // Even an ambiguous pair and an unmatched label must select cleanly.
    const { engine, enumerateDevices } = await engineWith(platform,
      [...all.map(r => r.native), { uid: 'dup1', label: 'Dup (Built-in)', outputChannels: 2 }, { uid: 'dup2', label: 'Dup (Virtual)', outputChannels: 2 }],
      all.map(r => r.browser))
    for (const uid of ['uid0', 'uid1', 'uid2', 'dup1']) {
      await engine.setOutput(`native:${uid}`)
      expect(engine.outputDeviceId).toBe(`native:${uid}`)
    }
    expect(StartupAudioContext.last?.sinkId).toEqual({ type: 'none' })
    expect(enumerateDevices).not.toHaveBeenCalled()
  })

  it.each(REAL_LABELS)('fallback playback resolves %s to its decorated Chromium sink', async (bare, decorated) => {
    const { engine } = await engineWith('MacIntel', [{ uid: 'u', label: bare, outputChannels: 2 }, { uid: 'o', label: 'Other', outputChannels: 2 }],
      [{ kind: 'audiooutput', deviceId: 'default', label: `Default - ${decorated}` },
        { kind: 'audiooutput', deviceId: 'sink-1', label: decorated }, { kind: 'audiooutput', deviceId: 'sink-2', label: 'Other (Built-in)' }])
    await engine.setOutput('native:u')
    await (engine as unknown as { applyFallbackSink(id: string): Promise<void> }).applyFallbackSink('u')
    expect(StartupAudioContext.last?.sinkId).toBe('sink-1')
  })

  it('without native playback the sink is resolved at selection (decorated label) and a missing one rolls back', async () => {
    const { engine } = await engineWith('Win32', [{ uid: 'u', label: 'NoMachine Audio Adapter', outputChannels: 2 }],
      [{ kind: 'audiooutput', deviceId: 'b', label: 'NoMachine Audio Adapter (Virtual)' }], { playback: false })
    await engine.setOutput('native:u')
    expect(StartupAudioContext.last?.sinkId).toBe('b')
  })

  it.each([
    ['no browser row', []],
    ['an ambiguous browser pair', [{ kind: 'audiooutput', deviceId: 'a', label: 'Interface (Built-in)' }, { kind: 'audiooutput', deviceId: 'b', label: 'Interface (Virtual)' }]]
  ])('only the fallback path throws on %s; a non-native selection stays usable', async (_name, outputs) => {
    const { engine } = await engineWith('Win32', [{ uid: 'native-id', label: 'Interface', outputChannels: 2 }], outputs as never)
    await engine.setOutput('native:native-id')
    await expect((engine as unknown as { applyFallbackSink(id: string): Promise<void> }).applyFallbackSink('native-id')).rejects.toThrow('uniquely')
  })

  it('native-side ambiguity rejects the fallback sink (negative control)', async () => {
    const { engine } = await engineWith('Win32', [{ uid: 'a', label: 'Interface (Built-in)', outputChannels: 2 }, { uid: 'b', label: 'Interface (Virtual)', outputChannels: 2 }],
      [{ kind: 'audiooutput', deviceId: 'x', label: 'Interface' }], { playback: false })
    await expect(engine.setOutput('native:a')).rejects.toThrow('uniquely')
    expect(engine.outputDeviceId).toBe('')
  })

  it('does not make the initial default sink hide a saved native endpoint from inventory', async () => {
    const outputId = 'native:alsa:sysfs:/sys/devices/platform/usb/5-1:pcm:0'

    const { result, context } = await reconcileStartupOutput(outputId, true)

    expect(result).toEqual({ kind: 'applied', outputId })
    expect(context.physicalRoutes).toEqual(['none', 'none'])
  })

  it('negative control: restores the ordinary browser default after starting detached', async () => {
    const { result, context, enumerateOutputs } = await reconcileStartupOutput(undefined, false)

    expect(result).toEqual({ kind: 'applied', outputId: undefined })
    expect(context.physicalRoutes).toEqual(['none', 'default'])
    expect(enumerateOutputs).not.toHaveBeenCalled()
  })

  it('still falls back to the browser default when the saved native endpoint is really missing', async () => {
    const outputId = 'native:alsa:disconnected'

    const { result, context } = await reconcileStartupOutput(outputId, false)

    expect(result).toEqual({ kind: 'missing', outputId })
    expect(context.physicalRoutes).toEqual(['none', 'default'])
  })
})

interface FakeClient {
  pauses: number
  [key: string]: unknown
}

/** A native client with `ipcMs` per round trip. Only what the engine's
 *  native play, pause and seek paths touch. */
function nativeClient(ipcMs: number): FakeClient {
  const c: any = {
    intent: 'paused',
    base: 0,
    at: 0,
    pending: null as number | null,
    pauses: 0,
    tail: Promise.resolve(),
    get active() { return true },
    get transportActive() { return true },
    get preparedAhead() { return false },
    get recoveryPending() { return false },
    get transportParked() { return c.intent === 'paused' },
    get status() { return { transportState: c.intent === 'playing' ? 'playing' : 'paused' } },
    audibleSeconds() {
      if (c.pending !== null) return c.pending
      return c.intent === 'playing' ? c.base + (Date.now() - c.at) / 1000 : c.base
    },
    serialize(op: () => Promise<void>) {
      const current = c.tail.then(op, op)
      c.tail = current.then(() => {}, () => {})
      return current
    },
    ipc() { return new Promise((resolve) => setTimeout(resolve, ipcMs)) },
    // The target shows once the queued seek STARTS, not when it is asked for.
    async seek(seconds: number) {
      return c.serialize(async () => {
        c.pending = seconds
        await c.ipc()
        await c.ipc()
        c.base = seconds
        c.at = Date.now()
        c.pending = null
      })
    },
    resume() {
      return c.serialize(async () => {
        await c.ipc()
        c.base = c.audibleSeconds()
        c.at = Date.now()
        c.intent = 'playing'
        await c.ipc()
      })
    },
    pause() {
      c.pauses++
      return c.serialize(async () => {
        await c.ipc()
        c.base = c.audibleSeconds()
        c.intent = 'paused'
        await c.ipc()
      })
    },
    reconfigure() { return c.serialize(async () => { await c.ipc() }) },
    async unload() {}
  }
  return c
}

const SELECTION = { start: 20, end: 26 }

/** A song with a 20-26 s non-looping selection, playing natively from `from`. */
async function playingSelection(from: number, ipcMs: number): Promise<{ engine: any; client: FakeClient }> {
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
  const engine: any = new MultitrackEngine()
  engine.aheadAllowed = false
  engine.load([{ id: 'vocals', buffer: { duration: 120 }, duration: 120, path: '/vocals.flac' }])
  const client = nativeClient(ipcMs)
  engine.nativePlayback = client
  const region = engine.setRegion(SELECTION, false)
  await vi.advanceTimersByTimeAsync(100)
  await region
  engine.seek(from)
  await vi.advanceTimersByTimeAsync(200)
  const play = engine.play({ countIn: false })
  await vi.advanceTimersByTimeAsync(200)
  await play
  expect(engine.playing).toBe(true)
  return { engine, client }
}

describe('native seeks never pause a playing selection', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  for (const ipcMs of [10, 40]) {
    for (const phase of [0, 7, 13, 19]) {
      it(`one seek past the selection's end lands and plays on (${ipcMs} ms round trips, phase ${phase} ms)`, async () => {
        const { engine, client } = await playingSelection(21, ipcMs)
        await vi.advanceTimersByTimeAsync(1000 + phase)
        engine.seek(40)
        await vi.advanceTimersByTimeAsync(600)
        expect(client.pauses).toBe(0)
        expect(engine.playing).toBe(true)
        expect(engine.position).toBeGreaterThan(SELECTION.end)
      })
    }
  }

  for (const ipcMs of [3, 20, 30, 60]) {
    for (const phase of [0, 5, 10, 15, 20]) {
      it(`overlapping seeks out of the selection never pause it (${ipcMs} ms round trips, phase ${phase} ms)`, async () => {
        // A held → from just before the selection: the first seek lands inside
        // it, the next past its end. Any start before the end is one the
        // watcher polices, so this is the same case as starting inside.
        const { engine, client } = await playingSelection(17, ipcMs)
        await vi.advanceTimersByTimeAsync(phase)
        engine.seekBy(5)
        await vi.advanceTimersByTimeAsync(33)
        engine.seekBy(5)
        await vi.advanceTimersByTimeAsync(600)
        expect(client.pauses).toBe(0)
        expect(engine.playing).toBe(true)
      })

      it(`overlapping seeks back into the selection never pause it, and it still stops at its end (${ipcMs} ms round trips, phase ${phase} ms)`, async () => {
        // A held ← from past the end back into the selection.
        const { engine, client } = await playingSelection(20, ipcMs)
        engine.seek(36)
        await vi.advanceTimersByTimeAsync(500 + phase)
        engine.seek(31)
        await vi.advanceTimersByTimeAsync(33)
        engine.seek(26.5)
        await vi.advanceTimersByTimeAsync(33)
        engine.seek(21.5)
        await vi.advanceTimersByTimeAsync(600)
        expect(client.pauses).toBe(0)
        expect(engine.playing).toBe(true)
        // Once the seeks have settled the watcher judges again: the play that
        // landed inside the selection still stops at its end.
        await vi.advanceTimersByTimeAsync(6000)
        expect(engine.playing).toBe(false)
        expect(engine.position).toBeLessThan(SELECTION.end + 0.2)
      })
    }
  }
})

/** Desktop-visible: a native receipt for the song being LEFT must not land in
 *  the next one (the epoch guards in setMasterVolume / setVolume and the
 *  accepted-control twins). */
describe('late native control receipts across a song switch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function later<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }

  async function nativeSong(): Promise<{ engine: any; gain: ReturnType<typeof later<void>>; lane: ReturnType<typeof later<{ gain: number; muted: boolean; solo: boolean }>> }> {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { MultitrackEngine } = await import('../../src/renderer/src/audio/engine')
    const engine: any = new MultitrackEngine()
    engine.aheadAllowed = false
    engine.load([{ id: 'vocals', buffer: { duration: 120 }, duration: 120, path: '/vocals.flac' }])
    const gain = later<void>()
    const lane = later<{ gain: number; muted: boolean; solo: boolean }>()
    engine.nativePlayback = {
      active: true, preparedAhead: false, recoveryPending: false, transportActive: false,
      setMasterGain: vi.fn(() => gain.promise),
      updateLane: vi.fn(() => lane.promise),
      unload: vi.fn(async () => {})
    }
    return { engine, gain, lane }
  }

  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  it.each(['retire', 'load'])('ends the native song session on a real %s instead of retaining its buffer lease', async action => {
    const { engine } = await nativeSong()
    const unload = engine.nativePlayback.unload
    if (action === 'retire') engine.retireForSongSwitch()
    else engine.load([{ id: 'other', buffer: { duration: 120 }, duration: 120, path: '/other.flac' }])
    await flush()
    expect(unload).toHaveBeenCalledExactlyOnceWith()
  })

  it('drops a master gain and lane receipt that settle after the song switched', async () => {
    const { engine, gain, lane } = await nativeSong()
    engine.setMasterVolume(0.3)
    engine.setVolume('vocals', 0.2)
    const accepted = engine.setMasterVolumeAccepted(0.4)
    await vi.waitFor(() => expect(engine.nativePlayback.setMasterGain).toHaveBeenCalledTimes(2))
    engine.retireForSongSwitch()
    gain.resolve()
    lane.resolve({ gain: 0.2, muted: false, solo: false })
    await expect(accepted).rejects.toThrow('song changed')
    await flush()
    expect(engine.masterVolume).toBe(1)
    expect(engine.getTrackStates().find((track: { id: string }) => track.id === 'vocals')?.volume).toBe(1)
  })

  it('negative control: the same receipts apply when the song did not change', async () => {
    const { engine, gain, lane } = await nativeSong()
    engine.setMasterVolume(0.3)
    engine.setVolume('vocals', 0.2)
    gain.resolve()
    lane.resolve({ gain: 0.2, muted: false, solo: false })
    await flush()
    expect(engine.masterVolume).toBe(0.3)
    expect(engine.getTrackStates().find((track: { id: string }) => track.id === 'vocals')?.volume).toBe(0.2)
  })
})
