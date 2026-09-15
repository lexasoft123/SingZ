import { NativeEventEmitter, NativeModules } from 'react-native'
import { log } from '../log'
import type { PlaybackBackend } from './backend'

/**
 * The song on the Lock Screen, in Control Center and in Android's media
 * notification — and the play, pause and scrub that come back from there.
 *
 * App Review rejected the first iPhone submission under guideline 2.5.4: the
 * app declares the `audio` background mode, and a reviewer who pressed Home
 * saw nothing that used it. The song WAS still playing — iOS keeps the native
 * graph rendering in the background by decision — but nothing outside the app
 * said so. This is what says so, on both phones.
 *
 * Deliberately one small native module per platform (`NowPlaying`, same
 * method names and arity on both) rather than react-native-audio-api's
 * PlaybackNotificationManager: that one starts an Android foreground service
 * from any notification update, including from the background where Android
 * refuses it, and its iOS remote commands cannot be fired from a test. Ours
 * starts the service only for a playing song, and both platforms carry a
 * DEBUG-only `debugCommand` that goes through the same handler the OS calls.
 */

/** What the OS media surface is told. Song time throughout. */
export interface NowPlayingInfo {
  readonly title: string
  /** '' when the project name carries no "Artist — Title". */
  readonly artist: string
  readonly duration: number
  readonly elapsed: number
  /** How fast `elapsed` advances: 0 when paused or counting in, else tempo. */
  readonly rate: number
  readonly playing: boolean
  /** Scrubbing and the ±skip buttons; withdrawn while the core refuses seeks. */
  readonly canSeek: boolean
  readonly skipSeconds: number
}

export type NowPlayingCommand =
  | { readonly kind: 'play' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'seek'; readonly position: number }
  | { readonly kind: 'skip'; readonly seconds: number }

export interface NowPlayingUpdateResult {
  /**
   * Whether a playing song keeps sounding once the app leaves the screen.
   * Always true on iOS (the `audio` background mode). On Android it is true
   * only while the media-playback foreground service actually runs — the OS
   * may refuse to start one, and then the song parks exactly as it did before.
   */
  readonly backgroundPlayback: boolean
}

export interface NowPlayingPort {
  update(info: NowPlayingInfo): Promise<NowPlayingUpdateResult | null>
  clear(): Promise<void>
  subscribe(listener: (command: NowPlayingCommand) => void): () => void
}

/** How a remote command reaches the player: the SAME paths its buttons use. */
export interface NowPlayingActions {
  play(): void
  pause(): void
  toggle(): void
  seek(seconds: number): void
}

export interface NowPlayingTarget {
  readonly backend: PlaybackBackend
  readonly title: string
  readonly artist: string | null
  readonly actions: NowPlayingActions
  /**
   * The OS stopped keeping this song alive in the background: it was paused
   * (from anywhere), ran out, was stopped by a focus loss, or the OS refused
   * the foreground service. On Android the app may already be behind the home
   * screen, where nothing else would park the song — its output stream would
   * go on rendering silence (half a core on a phone) until the singer came
   * back. The screen parks it here.
   */
  readonly onBackgroundLost?: () => void
}

export interface NowPlayingTimers {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realTimers: NowPlayingTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}

/** Lock Screen skip buttons. Ten seconds is a phrase back, not a verse. */
export const NOW_PLAYING_SKIP_SECONDS = 10
/**
 * Coalesce a burst of backend notifications into one native update. A legacy
 * seek reads `playing: false` for the ~80 ms its restart takes; publishing that
 * would flash the Lock Screen to paused and back on every scrub.
 */
export const NOW_PLAYING_SETTLE_MS = 150
/** How often the elapsed time is checked against what the OS extrapolates. */
export const NOW_PLAYING_SAMPLE_MS = 1000
/**
 * How far the OS's extrapolated position may drift before it is corrected.
 * The OS runs its own clock from `elapsed` and `rate`, so a steady song needs
 * no updates at all; a seek, an A-B loop wrap or a count-in landing does.
 */
export const NOW_PLAYING_DRIFT_SEC = 1

const sameInfo = (a: NowPlayingInfo, b: NowPlayingInfo): boolean =>
  a.title === b.title &&
  a.artist === b.artist &&
  a.duration === b.duration &&
  a.rate === b.rate &&
  a.playing === b.playing &&
  a.canSeek === b.canSeek &&
  a.skipSeconds === b.skipSeconds

export function nowPlayingInfo(target: Omit<NowPlayingTarget, 'actions'>): NowPlayingInfo | null {
  const { backend } = target
  const duration = backend.duration
  // Nothing to show until the song has a length: a Lock Screen card with a
  // 0:00 timeline for a song still loading is worse than no card.
  if (!(duration > 0) || !Number.isFinite(duration)) return null
  const playing = backend.playing
  // A count-in holds the playhead while the clicks run; the OS would walk its
  // timeline on through the bars before the song.
  const advancing = playing && backend.countInStatus == null
  const tempo = backend.pitchTempo.rate
  const position = backend.position
  return {
    title: target.title,
    artist: target.artist ?? '',
    duration,
    elapsed: Number.isFinite(position) ? Math.min(Math.max(position, 0), duration) : 0,
    rate: advancing && tempo > 0 && Number.isFinite(tempo) ? tempo : 0,
    playing,
    canSeek: backend.capabilities.seek,
    skipSeconds: NOW_PLAYING_SKIP_SECONDS
  }
}

export function parseNowPlayingCommand(value: unknown): NowPlayingCommand | null {
  if (value == null || typeof value !== 'object') return null
  const { command, value: amount } = value as { command?: unknown; value?: unknown }
  const finite = typeof amount === 'number' && Number.isFinite(amount)
  switch (command) {
    case 'play':
    case 'pause':
    case 'toggle':
      return { kind: command }
    case 'seek':
      return finite && (amount as number) >= 0 ? { kind: 'seek', position: amount as number } : null
    case 'skip':
      return finite && amount !== 0 ? { kind: 'skip', seconds: amount as number } : null
    default:
      return null
  }
}

interface Pushed {
  readonly info: NowPlayingInfo
  readonly at: number
}

/**
 * Keeps one player's state mirrored onto the OS media surface while attached.
 * One song at a time: attaching a new target detaches the previous one.
 */
export class NowPlayingController {
  private detachCurrent: (() => void) | null = null
  private currentBackend: PlaybackBackend | null = null
  private background = false
  /**
   * Every native call, in order, across songs. Per-song queues let a closed
   * song's clear land AFTER the next song's first update and wipe its card
   * off the Lock Screen.
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly port: NowPlayingPort,
    private readonly timers: NowPlayingTimers = realTimers
  ) {}

  /**
   * True while a playing song has been handed to the OS for background
   * playback (see NowPlayingUpdateResult). The Android background park asks
   * this before pausing a song the singer left playing.
   */
  get keepsPlayingInBackground(): boolean {
    // The LIVE transport too, not only the last push: a pause and a Home
    // press inside one settle would otherwise read as still held, skip the
    // park, and leave the stream rendering silence once the update lands.
    return this.detachCurrent != null && this.background && this.currentBackend?.playing === true
  }

  attach(target: NowPlayingTarget): () => void {
    this.detachCurrent?.()
    const { backend, actions } = target
    let pushed: Pushed | null = null
    let settle: unknown = null
    let closed = false

    const push = (): void => {
      settle = null
      if (closed) return
      const info = nowPlayingInfo(target)
      if (info == null) return
      const at = this.timers.now()
      pushed = { info, at }
      // An update still queued when its song closes is dropped, not sent:
      // showing a card only for the clear behind it to take it away again
      // is a flicker on the Lock Screen.
      this.chain = this.chain
        .then(async () => {
          if (closed) return
          const result = await this.port.update(info)
          if (closed) return
          const held = this.background
          this.background = info.playing && result?.backgroundPlayback === true
          if (held && !this.background) target.onBackgroundLost?.()
        })
        // One refused update must not wedge every later call behind it.
        .catch(error => log('now-playing', `update failed · ${String(error)}`, 'warn'))
    }

    const schedule = (): void => {
      if (closed || settle != null) return
      settle = this.timers.setTimeout(push, NOW_PLAYING_SETTLE_MS)
    }

    const sample = (): void => {
      if (closed) return
      const info = nowPlayingInfo(target)
      if (info == null) return
      if (pushed == null || !sameInfo(pushed.info, info)) {
        schedule()
        return
      }
      const predicted =
        pushed.info.elapsed + ((this.timers.now() - pushed.at) / 1000) * pushed.info.rate
      if (Math.abs(info.elapsed - predicted) > NOW_PLAYING_DRIFT_SEC) schedule()
    }

    const onCommand = (command: NowPlayingCommand): void => {
      if (closed) return
      const canSeek = backend.capabilities.seek
      const duration = backend.duration
      log('now-playing', `remote ${command.kind}${'position' in command ? ` ${command.position.toFixed(1)}s` : ''}${'seconds' in command ? ` ${command.seconds > 0 ? '+' : ''}${command.seconds}s` : ''}`)
      switch (command.kind) {
        case 'play':
          if (!backend.playing) actions.play()
          break
        case 'pause':
          if (backend.playing) actions.pause()
          break
        case 'toggle':
          actions.toggle()
          break
        case 'seek':
          if (canSeek && duration > 0) actions.seek(Math.min(Math.max(command.position, 0), duration))
          break
        case 'skip':
          if (canSeek && duration > 0) {
            actions.seek(Math.min(Math.max(backend.position + command.seconds, 0), duration))
          }
          break
      }
      schedule()
    }

    this.currentBackend = backend
    const unsubscribeBackend = backend.subscribe(schedule)
    const unsubscribeCommands = this.port.subscribe(onCommand)
    const sampler = this.timers.setInterval(sample, NOW_PLAYING_SAMPLE_MS)
    push()

    const detach = (): void => {
      if (closed) return
      closed = true
      if (settle != null) this.timers.clearTimeout(settle)
      this.timers.clearInterval(sampler)
      unsubscribeBackend()
      unsubscribeCommands()
      if (this.detachCurrent === detach) {
        this.detachCurrent = null
        this.currentBackend = null
        this.background = false
      }
      this.chain = this.chain
        .then(() => this.port.clear())
        .catch(error => log('now-playing', `clear failed · ${String(error)}`, 'warn'))
    }
    this.detachCurrent = detach
    return detach
  }
}

interface NowPlayingNative {
  update(info: NowPlayingInfo): Promise<NowPlayingUpdateResult | null>
  clear(): Promise<null>
}

/** The platform module, or null where it is absent (tests, an old binary). */
export function nativeNowPlayingPort(): NowPlayingPort | null {
  const native = NativeModules.NowPlaying as NowPlayingNative | undefined
  if (typeof native?.update !== 'function' || typeof native.clear !== 'function') return null
  const emitter = new NativeEventEmitter(NativeModules.NowPlaying)
  return {
    update: info =>
      native.update(info).catch(error => {
        log('now-playing', `update failed · ${String(error)}`, 'warn')
        return null
      }),
    clear: () =>
      native.clear().then(
        () => undefined,
        error => log('now-playing', `clear failed · ${String(error)}`, 'warn')
      ),
    subscribe: listener => {
      const subscription = emitter.addListener('singzNowPlayingCommand', (value: unknown) => {
        const command = parseNowPlayingCommand(value)
        if (command) listener(command)
        else log('now-playing', `unrecognized remote command · ${JSON.stringify(value)}`, 'warn')
      })
      return () => subscription.remove()
    }
  }
}

/**
 * Android only: the Headless JS task NowPlayingModule holds while a song plays
 * in its foreground service. React Native stops JS timers while the activity
 * is paused unless such a task is active, and everything that answers a lock
 * screen command runs on timers. The task does nothing and never finishes by
 * itself — the native side finishes it, a few seconds after the song stops.
 * Registered in index.js.
 */
export const NOW_PLAYING_KEEP_ALIVE_TASK = 'SingzNowPlayingKeepAlive'
export const nowPlayingKeepAlive = (): Promise<void> => new Promise<void>(() => {})

let shared: NowPlayingController | null | undefined
/** The app's one controller, or null when the native module is missing. */
export function nowPlaying(): NowPlayingController | null {
  if (shared === undefined) {
    const port = nativeNowPlayingPort()
    shared = port ? new NowPlayingController(port) : null
    if (shared == null) log('now-playing', 'native module absent · no Lock Screen controls', 'warn')
  }
  return shared
}
