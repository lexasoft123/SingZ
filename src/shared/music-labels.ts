/*
 * Music-theory names on screen. music-theory.ts names keys and intervals in
 * English, and those names are also DATA — a session stores `intervalName` and
 * checks it against the theory's own answer — so they stay English there and
 * are translated here, at display. Imports the core only: training-session.ts calls it and the phone
 * bundles that, so it must not pull the desktop's dictionaries in — on the
 * phone no `interval.*` string is registered and the English name is kept.
 */
import { t, type Key } from './i18n/core'

/** "C major" → "C major" / "C мажор" / "C 大调". */
export function keyLabel(name: string): string {
  const m = /^(.+) (major|minor)$/.exec(name)
  if (!m) return name
  const key = `key.${m[2]}` as Key
  const out = t(key, { tonic: m[1] })
  return out === key ? name : out
}

/** "major third" → "major third" / "большая терция" / "大三度". */
export function intervalLabel(name: string): string {
  const key = `interval.${name.replace(' ', '.')}` as Key
  const out = t(key)
  return out === key ? name : out
}
