import { NativeModules } from 'react-native'

/**
 * Output-route latency compensation. iOS reports outputLatency +
 * ioBufferDuration per route; the app shifts lyric/training visuals by that
 * amount so highlights match what the ear hears over CarPlay/Bluetooth.
 * Reported values under-report on Bluetooth (~30–100 ms) and are unverified
 * on CarPlay head units, so a per-route user trim is layered on top and
 * persisted natively (UserDefaults).
 */
interface AudioRouteInfoApi {
  getOutput(): Promise<{
    outputLatency: number
    ioBufferDuration: number
    portType: string
    portName: string
    portUid: string
    /** Media/output volume, 0..1. Absent on builds older than 0.14.3. */
    volume?: number
    /** Android only — the raw step index and its maximum, for the log. */
    volumeIndex?: number
    volumeMax?: number
  }>
  getPref(key: string): Promise<number | null>
  setPref(key: string, value: number): Promise<void>
  getTextPref(key: string): Promise<string | null>
  setTextPref(key: string, value: string): Promise<void>
}

const Native = NativeModules.AudioRouteInfo as AudioRouteInfoApi

export interface RouteLatency {
  /** Reported route latency (outputLatency + ioBufferDuration), seconds. */
  autoSec: number
  /** Friendly output name ("Speaker", "CarPlay", a BT device's own name). */
  label: string
  /** Persistence key for this route's trim. */
  key: string
}

const PORT_LABELS: Record<string, string> = {
  Speaker: 'Speaker',
  Headphones: 'Headphones',
  CarAudio: 'CarPlay',
  BluetoothA2DPOutput: 'Bluetooth',
  BluetoothHFP: 'Bluetooth headset',
  BluetoothLE: 'Bluetooth LE audio',
  HearingAid: 'Hearing aid',
  AirPlay: 'AirPlay',
  HDMIOutput: 'HDMI',
  'USB Audio': 'USB audio'
}

export async function getRouteLatency(): Promise<RouteLatency> {
  // A wedged native probe must degrade to "no compensation", never to a
  // player with no route (that also hides the trim control).
  const o = await Promise.race([
    Native.getOutput(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('route probe timeout')), 3000))
  ]).catch(() => ({
    outputLatency: 0,
    ioBufferDuration: 0.02,
    portType: 'Speaker',
    portName: 'Speaker',
    portUid: 'fallback'
  }))
  const pretty = PORT_LABELS[o.portType] ?? o.portType
  // A named external device beats the generic port label (e.g. "Kia Soul").
  const external = !['Speaker', 'Headphones'].includes(o.portType)
  return {
    autoSec: Math.max(0, o.outputLatency + o.ioBufferDuration),
    label: external && o.portName ? o.portName : pretty,
    key: `singz.trim:${o.portType}:${o.portName}`
  }
}

/**
 * Where the sound is going and how loud, as one line for the log.
 *
 * `silent` is the whole point. A phone whose media volume sits at zero plays
 * a song perfectly and inaudibly, and until something is audibly playing the
 * volume keys move the ringtone instead — so from the outside it is identical
 * to an app that cannot play at all. That cost a closed-test round; the log
 * now says it outright.
 */
export async function describeOutput(): Promise<{ text: string; silent: boolean }> {
  const o = await Promise.race([
    Native.getOutput(),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
  ]).catch(() => null)
  if (o === null) return { text: 'route unknown', silent: false }

  const where = (PORT_LABELS[o.portType] ?? o.portType) + (o.portName && o.portName !== o.portType ? ` (${o.portName})` : '')
  if (typeof o.volume !== 'number') return { text: where, silent: false }

  const loud =
    typeof o.volumeIndex === 'number' && typeof o.volumeMax === 'number'
      ? `${o.volumeIndex}/${o.volumeMax}`
      : `${Math.round(o.volume * 100)}%`
  return { text: `${where} · volume ${loud}`, silent: o.volume <= 0 }
}

export async function getTrimMs(key: string): Promise<number> {
  const v = await Native.getPref(key)
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export async function setTrimMs(key: string, ms: number): Promise<void> {
  await Native.setPref(key, ms)
}

/** Crash breadcrumbs: flushed to UserDefaults before each risky step. */
export const getCrumb = (): Promise<string | null> => Native.getTextPref('singz.crumb')
export const setCrumb = (note: string): Promise<void> => Native.setTextPref('singz.crumb', note)

/** Generic persisted text (same native store as trims and crumbs). */
export const getStoredText = (key: string): Promise<string | null> => Native.getTextPref(key)
export const setStoredText = (key: string, value: string): Promise<void> =>
  Native.setTextPref(key, value)
