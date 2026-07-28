import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockDrive, type MockDrive } from './mock-drive'

let mock: MockDrive

beforeAll(async () => {
  mock = await startMockDrive()
  const base = `http://127.0.0.1:${mock.port}`
  process.env.SINGZ_GDRIVE_CONFIG = JSON.stringify({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    authBase: base,
    apiBase: base,
    uploadBase: base
  })
})

afterAll(async () => {
  await mock.close()
})

async function seedProject(root: string, name: string): Promise<void> {
  await mkdir(join(root, name, 'stems'), { recursive: true })
  await writeFile(join(root, name, 'project.json'), JSON.stringify({ version: 2, name }))
  await writeFile(join(root, name, 'lyrics.json'), JSON.stringify({ lines: [] }))
  await writeFile(join(root, name, 'stems', 'vocals.flac'), Buffer.from('fLaC-fake-vocals'))
  await writeFile(join(root, name, 'stems', 'drums.flac'), Buffer.from('fLaC-fake-drums'))
}

describe('gdriveSync (against the mock Drive)', () => {
  it('pushes projects, then re-runs as a no-op via md5 diff', async () => {
    // settings/tokens live under the electron-stub userData
    const { readSettings, writeSettings } = await import('../../src/main/settings')
    const root = await mkdtemp(join(tmpdir(), 'singz-gdrive-'))
    await seedProject(root, 'Mock Song')
    const s = readSettings() as Record<string, unknown>
    s.projectsRoot = root
    s.gdrive = { access: 'mock-access', refresh: 'mock-refresh', expiresAt: Date.now() + 3600_000 }
    writeSettings(s)

    const { gdriveSync, gdriveConfigured, gdriveSignedIn } = await import('../../src/main/gdrive')
    expect(gdriveConfigured()).toBe(true)
    expect(gdriveSignedIn()).toBe(true)

    const first = await gdriveSync()
    expect(first).toMatchObject({ ok: true, projects: 1, uploaded: 4 })

    const names = [...mock.files.values()].map((f) => f.name).sort()
    expect(names).toEqual(['Mock Song', 'SingZ', 'drums.flac', 'lyrics.json', 'project.json', 'stems', 'vocals.flac'].sort())
    const vocals = [...mock.files.values()].find((f) => f.name === 'vocals.flac')
    expect(vocals?.bytes?.toString()).toBe('fLaC-fake-vocals')

    const second = await gdriveSync()
    expect(second).toMatchObject({ ok: true, uploaded: 0, unchanged: 4 })
  })

  it('re-uploads only what changed', async () => {
    const { readSettings } = await import('../../src/main/settings')
    const root = (readSettings() as { projectsRoot: string }).projectsRoot
    await writeFile(join(root, 'Mock Song', 'stems', 'vocals.flac'), Buffer.from('fLaC-new-take'))
    const { gdriveSync } = await import('../../src/main/gdrive')
    const rep = await gdriveSync()
    expect(rep).toMatchObject({ ok: true, uploaded: 1, unchanged: 3 })
    const vocals = [...mock.files.values()].find((f) => f.name === 'vocals.flac')
    expect(vocals?.bytes?.toString()).toBe('fLaC-new-take')
  })
})

describe('planSync', () => {
  it('diffs by md5, treating missing remotes as uploads', async () => {
    const { planSync } = await import('../../src/main/gdrive')
    const plan = planSync(
      [
        { name: 'a', md5: '111' },
        { name: 'b', md5: '222' },
        { name: 'c', md5: '333' }
      ],
      [
        { name: 'a', md5Checksum: '111' },
        { name: 'b', md5Checksum: 'OLD' }
      ]
    )
    expect(plan.upload.sort()).toEqual(['b', 'c'])
    expect(plan.unchanged).toEqual(['a'])
  })
})
