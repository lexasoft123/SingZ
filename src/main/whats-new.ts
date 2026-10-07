/// <reference types="vite/client" />
import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readSettings, writeSettings } from './settings'
import { localeState } from './locale'
import { releaseHighlights, compareReleaseVersions, validReleaseVersion } from '../shared/release-highlights'

export function registerWhatsNew(): void {
  const returning = existsSync(join(app.getPath('userData'), 'settings.json'))
  const version = app.getVersion()
  // Fresh installs establish a baseline; existing pre-feature installs see the
  // current release once. A downgrade does not erase the newest version seen.
  if (!returning && !readSettings().releaseNotesSeen) writeSettings({ releaseNotesSeen: version })
  ipcMain.handle('app:whats-new', (_event, automatic: boolean = true) => {
    try {
      if (automatic && !app.isPackaged && process.env.SINGZ_E2E_HOOKS !== '1') return { ok: true, notes: null }
      const previous = automatic ? readSettings().releaseNotesSeen : undefined
      return { ok: true, notes: releaseHighlights(app.getVersion(), previous, localeState().locale, 'desktop') }
    } catch (error) { return { ok: false, error: String(error) } }
  })
  ipcMain.handle('app:whats-new-seen', (_event, seen: string) => {
    try {
      if (seen !== app.getVersion() || !releaseHighlights(seen, undefined, 'en', 'desktop')) return { ok: false, error: 'Release notes are unavailable' }
      const previous = readSettings().releaseNotesSeen
      if (!previous || !validReleaseVersion(previous) || compareReleaseVersions(seen, previous) > 0) writeSettings({ releaseNotesSeen: seen })
      return { ok: true }
    } catch (error) { return { ok: false, error: String(error) } }
  })
}
