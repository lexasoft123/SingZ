import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Everything main-process code asks electron for at call time, minus the app.
// Every path it is asked for (userData, documents, appData, temp…) is one
// directory, fresh for each `vitest run`: tests/unit/global-setup.ts makes it
// and names it in SINGZ_UNIT_USERDATA. Loaded without that — another config, a
// lone script — it takes a fresh one of its own, never a fixed name under
// tmpdir(), which every run on the machine would share.
const base = process.env.SINGZ_UNIT_USERDATA || mkdtempSync(join(tmpdir(), 'singz-unit-userdata-'))
mkdirSync(base, { recursive: true })

export const app = {
  getPath: (): string => base,
  getVersion: (): string => '0.0.0-test',
  getName: (): string => 'SingZ'
}
export const dialog = {}
// lrclib.ts pulls net at import time; unit tests never actually fetch
export const net = {
  fetch: (): Promise<never> => Promise.reject(new Error('no network in unit tests'))
}
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}
export default { app, dialog, BrowserWindow }
