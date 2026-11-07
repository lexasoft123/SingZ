import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', async importOriginal => {
  const original = await importOriginal<typeof import('./electron-stub')>()
  return {
    ...original,
    app: {
      ...original.app,
      getPath: (name: string): string => name === 'userData' ? fixture.userData : original.app.getPath(name)
    }
  }
})
vi.mock('../../src/main/gdrive-config', () => ({
  default: { clientId: 'signout-fixture-client', clientSecret: 'fixture-only' }
}))

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  if (fixture.userData) await rm(fixture.userData, { recursive: true, force: true })
})

describe('persisted Google Drive sign-out', () => {
  it('removes real stored tokens across restart while preserving unrelated settings', async () => {
    fixture.userData = await mkdtemp(join(tmpdir(), 'singz-signout-'))
    vi.stubEnv('SINGZ_GDRIVE_CONFIG', '')
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    const preferences = { language: 'en' as const, projectsRoot: join(fixture.userData, 'library'), releaseNotesSeen: 'fixture' }
    writeSettings({
      ...preferences,
      gdrive: { access: 'fixture-access', refresh: 'fixture-refresh', expiresAt: Date.now() + 3600_000 }
    })
    const drive = await import('../../src/main/gdrive')
    expect(drive.gdriveSignedIn()).toBe(true)

    drive.gdriveSignOut()

    expect(Object.hasOwn(readSettings(), 'gdrive')).toBe(false)
    const persisted = JSON.parse(await readFile(join(fixture.userData, 'settings.json'), 'utf8'))
    expect(Object.hasOwn(persisted, 'gdrive')).toBe(false)
    expect(persisted).toEqual(preferences)

    vi.resetModules()
    const restartedDrive = await import('../../src/main/gdrive')
    const restartedSettings = await import('../../src/main/settings')
    expect(restartedDrive.gdriveSignedIn()).toBe(false)
    expect(restartedSettings.readSettings()).toEqual(preferences)
  })
})
