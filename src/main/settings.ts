import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Small app-wide settings file (userData/settings.json), window-state style.
 *  Declared rather than cast at every call site: everything below is already
 *  stored here, and the casts hid which fields were real. */
export interface AppSettings {
  /** Overridden project-library location (e.g. an iCloud Drive folder). */
  projectsRoot?: string
  /** Google Drive OAuth, refreshed in place. */
  gdrive?: { access: string; refresh: string; expiresAt: number }
  /** When the last successful push finished. */
  gdriveLastSync?: number
  /** What has changed since Drive last saw it — see sync-dirty.ts. */
  gdriveDirty?: DirtyState
}

/**
 * The library's unsynced state. `seq` is the correctness primitive: a sync
 * captures it before running and clears only marks at or below what it saw, so
 * a change that lands mid-run survives and earns its own follow-up. `dirs` is
 * for the UI — which songs are waiting — and is never allowed to decide what
 * gets uploaded.
 */
export interface DirtyState {
  seq: number
  /** Absolute project dir → the seq it was last marked at. */
  dirs: Record<string, number>
  /** Library-scope change (root moved, migration): the seq it happened at. */
  allSeq: number
  /** When the library first went dirty after being clean. */
  since?: number
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function readSettings(): AppSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as AppSettings
  } catch {
    return {}
  }
}

export function writeSettings(patch: Partial<AppSettings>): void {
  const next = { ...readSettings(), ...patch }
  for (const k of Object.keys(next) as (keyof AppSettings)[]) {
    if (next[k] === undefined) delete next[k]
  }
  try {
    writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  } catch {
    /* a failed settings save must never break the app */
  }
}
