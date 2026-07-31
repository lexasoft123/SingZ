import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Everything main-process code asks electron for at call time, minus the app.
const base = join(tmpdir(), 'singz-unit-userdata')
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
