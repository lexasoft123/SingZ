import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Small app-wide settings file (userData/settings.json), window-state style. */
interface AppSettings {
  /** Overridden project-library location (e.g. an iCloud Drive folder). */
  projectsRoot?: string
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
