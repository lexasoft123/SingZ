/**
 * The Lock Screen / Control Center / Android notification mirror.
 *
 * What a singer would notice if these rules broke: the Lock Screen card
 * flashing to paused on every scrub (legacy seeks read `playing: false` for
 * ~80 ms), a timeline walking on through a count-in, a scrub from the Lock
 * Screen that lands nowhere, a card left behind for a song that was closed, and
 * — on Android — a song parked in the background that the OS was never asked
 * to keep alive.
 */
import {
  NOW_PLAYING_SAMPLE_MS,
  NOW_PLAYING_SETTLE_MS,
  NOW_PLAYING_SKIP_SECONDS,
  NowPlayingController,
  parseNowPlayingCommand,
  type NowPlayingCommand,
  type NowPlayingInfo,
  type NowPlayingPort,
  type NowPlayingTimers
} from '../src/playback/now-playing'
import type { PlaybackBackend } from '../src/playback/backend'

class FakeClock implements NowPlayingTimers {
  t = 0
  private seq = 0
  private timeouts = new Map<number, { at: number; fn: () => void }>()
  private intervals = new Map<number, { every: number; next: number; fn: () => void }>()
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.timeouts.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (h: unknown): void => void this.timeouts.delete(h as number)
  setInterval = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq
    this.intervals.set(id, { every: ms, next: this.t + ms, fn })
    return id
  }
  clearInterval = (h: unknown): void => void this.intervals.delete(h as number)
  get pendingIntervals(): number {
    return this.intervals.size
  }
  advance(ms: number, onTick?: (t: number) => void): void {
    const end = this.t + ms
    for (;;) {
      const due: Array<{ at: number; run: () => void }> = []
      for (const [id, x] of this.timeouts) due.push({ at: x.at, run: () => { this.timeouts.delete(id); x.fn() } })
      for (const [, x] of this.intervals) due.push({ at: x.next, run: () => { x.next += x.every; x.fn() } })
      const next = due.filter(d => d.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      this.t = next.at
      onTick?.(this.t)
      next.run()
    }
    this.t = end
    onTick?.(this.t)
  }
}

class FakeBackend {
  playing = false
  position = 0
  duration = 200
  countInStatus: object | null = null
  pitchTempo = { semitones: 0, rate: 1 }
  capabilities = { seek: true }
  private listeners = new Set<() => void>()
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(): void {
    for (const fn of [...this.listeners]) fn()
  }
  get listenerCount(): number {
    return this.listeners.size
  }
}

class FakePort implements NowPlayingPort {
  updates: NowPlayingInfo[] = []
  events: string[] = []
  background = true
  private listeners = new Set<(c: NowPlayingCommand) => void>()
  async update(info: NowPlayingInfo) {
    this.updates.push(info)
    this.events.push(`update:${info.title}:${info.playing ? 'playing' : 'paused'}`)
    return { backgroundPlayback: this.background }
  }
  async clear() {
    this.events.push('clear')
  }
  subscribe(listener: (c: NowPlayingCommand) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  send(command: NowPlayingCommand): void {
    for (const fn of [...this.listeners]) fn(command)
  }
  get listenerCount(): number {
    return this.listeners.size
  }
  get last(): NowPlayingInfo {
    return this.updates[this.updates.length - 1]
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve))

function setup(title = 'Father and Son', artist: string | null = 'Cat Stevens') {
  const clock = new FakeClock()
  const port = new FakePort()
  const backend = new FakeBackend()
  const actions = {
    play: jest.fn(() => {
      backend.playing = true
    }),
    pause: jest.fn(() => {
      backend.playing = false
    }),
    toggle: jest.fn(() => {
      backend.playing = !backend.playing
    }),
    seek: jest.fn((s: number) => {
      backend.position = s
    })
  }
  const controller = new NowPlayingController(port, clock)
  const target = { backend: backend as unknown as PlaybackBackend, title, artist, actions }
  return { clock, port, backend, actions, controller, target }
}

describe('what the OS is told', () => {
  it('shows the song as soon as it attaches: title, artist, length, position, paused', async () => {
    const { port, backend, controller, target } = setup()
    backend.position = 12.5
    controller.attach(target)
    await flush()
    expect(port.updates).toEqual([
      {
        title: 'Father and Son',
        artist: 'Cat Stevens',
        duration: 200,
        elapsed: 12.5,
        rate: 0,
        playing: false,
        canSeek: true,
        skipSeconds: NOW_PLAYING_SKIP_SECONDS
      }
    ])
  })

  it('sends an empty artist, not null, for a name with no "Artist — Title"', async () => {
    const { port, controller, target } = setup('Sing with me', null)
    controller.attach(target)
    await flush()
    expect(port.last.artist).toBe('')
  })

  it('shows nothing for a song with no length yet, and appears once it has one', async () => {
    const { clock, port, backend, controller, target } = setup()
    backend.duration = 0
    controller.attach(target)
    clock.advance(NOW_PLAYING_SAMPLE_MS * 3)
    await flush()
    expect(port.updates).toHaveLength(0)
    backend.duration = 180
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.updates).toHaveLength(1)
    expect(port.last.duration).toBe(180)
  })

  it('advances at the tempo while playing, so a slowed song does not run ahead on the Lock Screen', async () => {
    const { clock, port, backend, controller, target } = setup()
    controller.attach(target)
    backend.playing = true
    backend.pitchTempo = { semitones: -2, rate: 0.8 }
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.last).toMatchObject({ playing: true, rate: 0.8 })
  })

  it('holds the timeline still through a count-in, and lets it run once the song lands', async () => {
    const { clock, port, backend, controller, target } = setup()
    controller.attach(target)
    backend.playing = true
    backend.countInStatus = { beat: 1, beats: 4 }
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.last).toMatchObject({ playing: true, rate: 0 })
    backend.countInStatus = null
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.last).toMatchObject({ playing: true, rate: 1 })
  })

  it('withdraws scrubbing while the core refuses seeks, and offers it back after', async () => {
    const { clock, port, backend, controller, target } = setup()
    controller.attach(target)
    backend.capabilities = { seek: false }
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.last.canSeek).toBe(false)
    backend.capabilities = { seek: true }
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.last.canSeek).toBe(true)
  })
})

describe('how often it is told', () => {
  it('coalesces a burst of notifications into one update', async () => {
    const { clock, port, backend, controller, target } = setup()
    controller.attach(target)
    await flush()
    backend.playing = true
    for (let i = 0; i < 20; i++) backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.updates).toHaveLength(2)
  })

  it('never flashes paused for the instant a legacy seek restarts the song', async () => {
    const { clock, port, backend, controller, target } = setup()
    backend.playing = true
    controller.attach(target)
    await flush()
    backend.playing = false
    backend.position = 90
    backend.emit()
    clock.advance(80)
    backend.playing = true
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.updates.map(u => u.playing)).toEqual([true, true])
    expect(port.last.elapsed).toBe(90)
  })

  it('sends nothing while a song plays steadily — the OS runs its own clock from elapsed and rate', async () => {
    const { clock, port, backend, controller, target } = setup()
    backend.playing = true
    controller.attach(target)
    await flush()
    clock.advance(30_000, t => {
      backend.position = t / 1000
    })
    await flush()
    expect(port.updates).toHaveLength(1)
  })

  it('corrects the OS when the song jumps: a seek, or an A-B loop wrapping back', async () => {
    const { clock, port, backend, controller, target } = setup()
    backend.playing = true
    controller.attach(target)
    await flush()
    clock.advance(5_000, t => {
      backend.position = t / 1000
    })
    backend.position = 1 // the loop wrapped from 5 s back to 1 s, with no notification
    clock.advance(NOW_PLAYING_SAMPLE_MS + NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.updates).toHaveLength(2)
    expect(port.last.elapsed).toBe(1)
  })
})

describe('commands from the Lock Screen, Control Center and the notification', () => {
  it('play and pause go through the player, and only when they change something', async () => {
    const { port, backend, actions, controller, target } = setup()
    controller.attach(target)
    port.send({ kind: 'pause' })
    expect(actions.pause).not.toHaveBeenCalled()
    port.send({ kind: 'play' })
    expect(actions.play).toHaveBeenCalledTimes(1)
    expect(backend.playing).toBe(true)
    port.send({ kind: 'play' })
    expect(actions.play).toHaveBeenCalledTimes(1)
    port.send({ kind: 'pause' })
    expect(actions.pause).toHaveBeenCalledTimes(1)
  })

  it('a headphone toggle toggles', async () => {
    const { port, actions, controller, target } = setup()
    controller.attach(target)
    port.send({ kind: 'toggle' })
    port.send({ kind: 'toggle' })
    expect(actions.toggle).toHaveBeenCalledTimes(2)
  })

  it('a scrub lands inside the song', async () => {
    const { port, actions, controller, target } = setup()
    controller.attach(target)
    port.send({ kind: 'seek', position: 42 })
    port.send({ kind: 'seek', position: 9999 })
    expect(actions.seek.mock.calls).toEqual([[42], [200]])
  })

  it('skip moves from where the song is, and stops at either end', async () => {
    const { port, backend, actions, controller, target } = setup()
    controller.attach(target)
    backend.position = 5
    port.send({ kind: 'skip', seconds: -10 })
    expect(actions.seek).toHaveBeenLastCalledWith(0)
    backend.position = 100
    port.send({ kind: 'skip', seconds: 10 })
    expect(actions.seek).toHaveBeenLastCalledWith(110)
    backend.position = 195
    port.send({ kind: 'skip', seconds: 10 })
    expect(actions.seek).toHaveBeenLastCalledWith(200)
  })

  it('does not seek while the core refuses seeks', async () => {
    const { port, backend, actions, controller, target } = setup()
    controller.attach(target)
    backend.capabilities = { seek: false }
    port.send({ kind: 'seek', position: 30 })
    port.send({ kind: 'skip', seconds: 10 })
    expect(actions.seek).not.toHaveBeenCalled()
  })

  it('tells the OS what a command did, without waiting for the next sample', async () => {
    const { clock, port, controller, target } = setup()
    controller.attach(target)
    await flush()
    port.send({ kind: 'play' })
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(port.last.playing).toBe(true)
  })
})

describe('lifetime', () => {
  it('detaching clears the card and stops listening', async () => {
    const { clock, port, backend, actions, controller, target } = setup()
    const detach = controller.attach(target)
    await flush()
    detach()
    await flush()
    expect(port.events).toEqual(['update:Father and Son:paused', 'clear'])
    expect(backend.listenerCount).toBe(0)
    expect(port.listenerCount).toBe(0)
    expect(clock.pendingIntervals).toBe(0)
    port.send({ kind: 'play' })
    backend.emit()
    clock.advance(5_000)
    await flush()
    expect(actions.play).not.toHaveBeenCalled()
    expect(port.updates).toHaveLength(1)
    detach()
    await flush()
    expect(port.events.filter(e => e === 'clear')).toHaveLength(1)
  })

  it('an update still on its way when the song closes is dropped, never shown then cleared', async () => {
    const { port, controller, target } = setup()
    const detach = controller.attach(target)
    detach()
    await flush()
    expect(port.events).toEqual(['clear'])
  })

  it('a second song replaces the first: the clear always lands before the new card', async () => {
    const first = setup('First song', null)
    const second = { ...first.target, title: 'Second song' }
    first.controller.attach(first.target)
    await flush()
    first.controller.attach(second)
    await flush()
    expect(first.port.events).toEqual([
      'update:First song:paused',
      'clear',
      'update:Second song:paused'
    ])
  })

  it('a song switched before its card landed still ends on the new card', async () => {
    const first = setup('First song', null)
    first.controller.attach(first.target)
    first.controller.attach({ ...first.target, title: 'Second song' })
    await flush()
    expect(first.port.events).toEqual(['clear', 'update:Second song:paused'])
  })

  it('a refused native update does not stall the ones after it', async () => {
    const { clock, port, backend, controller, target } = setup()
    const failing = jest.spyOn(port, 'update').mockRejectedValueOnce(new Error('no session'))
    controller.attach(target)
    await flush()
    backend.playing = true
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(failing).toHaveBeenCalledTimes(2)
    expect(port.last.playing).toBe(true)
  })
})

describe('Android background playback', () => {
  it('keeps a song playing in the background only while the OS agreed to', async () => {
    const { clock, port, backend, controller, target } = setup()
    const detach = controller.attach(target)
    await flush()
    expect(controller.keepsPlayingInBackground).toBe(false) // paused
    backend.playing = true
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(controller.keepsPlayingInBackground).toBe(true)
    port.background = false // the OS refused the foreground service
    backend.pitchTempo = { semitones: 0, rate: 0.9 }
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(controller.keepsPlayingInBackground).toBe(false)
    port.background = true
    backend.pitchTempo = { semitones: 0, rate: 1 }
    backend.emit()
    clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(controller.keepsPlayingInBackground).toBe(true)
    detach()
    expect(controller.keepsPlayingInBackground).toBe(false)
  })
})

describe('when the OS stops holding the song', () => {
  const held = async (ctx: ReturnType<typeof setup>, lost: jest.Mock) => {
    ctx.controller.attach({ ...ctx.target, onBackgroundLost: lost })
    ctx.backend.playing = true
    ctx.backend.emit()
    ctx.clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(ctx.controller.keepsPlayingInBackground).toBe(true)
  }

  it('says so once when the song pauses or runs out, so the screen can park it', async () => {
    const ctx = setup()
    const lost = jest.fn()
    await held(ctx, lost)
    ctx.backend.playing = false
    ctx.backend.emit()
    ctx.clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(lost).toHaveBeenCalledTimes(1)
    ctx.backend.position = 60
    ctx.backend.emit()
    ctx.clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('says so when the OS refuses to keep a still-playing song alive', async () => {
    const ctx = setup()
    const lost = jest.fn()
    await held(ctx, lost)
    ctx.port.background = false
    ctx.backend.pitchTempo = { semitones: 0, rate: 0.9 }
    ctx.backend.emit()
    ctx.clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(lost).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for a song that was never held, and for a song being closed', async () => {
    const ctx = setup()
    const lost = jest.fn()
    const detach = ctx.controller.attach({ ...ctx.target, onBackgroundLost: lost })
    await flush()
    ctx.backend.position = 30
    ctx.backend.emit()
    ctx.clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    expect(lost).not.toHaveBeenCalled()
    ctx.backend.playing = true
    ctx.backend.emit()
    ctx.clock.advance(NOW_PLAYING_SETTLE_MS)
    await flush()
    detach()
    await flush()
    expect(lost).not.toHaveBeenCalled()
  })

  it('reads the live transport: a pause inside the settle is not "still held"', async () => {
    const ctx = setup()
    await held(ctx, jest.fn())
    ctx.backend.playing = false // paused; the update has not been sent yet
    expect(ctx.controller.keepsPlayingInBackground).toBe(false)
  })
})

describe('parseNowPlayingCommand', () => {
  it('accepts the five commands the native modules send', () => {
    expect(parseNowPlayingCommand({ command: 'play' })).toEqual({ kind: 'play' })
    expect(parseNowPlayingCommand({ command: 'pause', value: 0 })).toEqual({ kind: 'pause' })
    expect(parseNowPlayingCommand({ command: 'toggle' })).toEqual({ kind: 'toggle' })
    expect(parseNowPlayingCommand({ command: 'seek', value: 12.5 })).toEqual({ kind: 'seek', position: 12.5 })
    expect(parseNowPlayingCommand({ command: 'skip', value: -10 })).toEqual({ kind: 'skip', seconds: -10 })
  })

  it('refuses anything it cannot act on safely', () => {
    for (const bad of [
      null,
      'play',
      {},
      { command: 'next' },
      { command: 'seek' },
      { command: 'seek', value: -1 },
      { command: 'seek', value: Number.NaN },
      { command: 'skip', value: 0 },
      { command: 'skip', value: Number.POSITIVE_INFINITY }
    ]) {
      expect(parseNowPlayingCommand(bad)).toBeNull()
    }
  })
})
