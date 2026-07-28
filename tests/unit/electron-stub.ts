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
export class BrowserWindow {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
}
export default { app, dialog, BrowserWindow }
