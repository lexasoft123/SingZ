import { NativeModules } from 'react-native'

/**
 * Moves to Google Drive in flight, by the "This phone" folder they started
 * from (publish.ts has the protocol). Its own module so the writer can clear a
 * record without pulling the Drive client in: a brand-new song is never
 * mid-move, and a record that outlived its folder — a kill between the phone
 * folder's delete and the record's — must not hand its move to the next song
 * given the same name.
 */

interface PrefsNative {
  getTextPref(key: string): Promise<string | null>
  setTextPref(key: string, value: string): Promise<void>
}
const Prefs = NativeModules.AudioRouteInfo as PrefsNative

const RECORD_KEY = 'singz.publish'

export interface MoveRecord {
  id: string
  at: number
}

export async function records(): Promise<Record<string, MoveRecord>> {
  try {
    const raw = await Prefs.getTextPref(RECORD_KEY)
    return raw ? (JSON.parse(raw) as Record<string, MoveRecord>) : {}
  } catch {
    return {}
  }
}

export async function recordFor(dir: string): Promise<MoveRecord> {
  const all = await records()
  if (!all[dir]) {
    all[dir] = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`, at: Date.now() }
    await Prefs.setTextPref(RECORD_KEY, JSON.stringify(all))
  }
  return all[dir]
}

export async function dropRecord(dir: string): Promise<void> {
  const all = await records()
  if (!all[dir]) return
  delete all[dir]
  await Prefs.setTextPref(RECORD_KEY, JSON.stringify(all))
}

/** For a folder that has just been created for a new song. Best effort: a
 *  build without the prefs module has no records to clear. */
export async function forgetMove(dir: string): Promise<void> {
  try {
    await dropRecord(dir)
  } catch {
    // no prefs store, no records
  }
}
