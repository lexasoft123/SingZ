import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoxStateService } from '../../src/main/box/state'
import { BoxStorageService } from '../../src/main/box/storage'
import { BoxControllerHub } from '../../src/main/box/controller'
import type { BoxControllerPublish } from '../../src/shared/box-contract'

const require = createRequire(import.meta.url)
const { stemProject, wav, md5 } = require('../e2e/linux/fixtures.cjs') as {
  stemProject: (dir: string, name?: string, seconds?: number) => Promise<{ dir: string; doc: Record<string, unknown> }>
  wav: (seconds?: number) => Buffer
  md5: (bytes: Buffer) => string
}
const dirs: string[] = []
const temp = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'singz-box-services-'))
  dirs.push(dir)
  return dir
}
const publish = (hub: BoxControllerHub, paths: Partial<Pick<BoxControllerPublish, 'activeLocalProjectDir' | 'openingLocalProjectDir'>> = {}): void => {
  const result = hub.publish({
    activeProjectId: null,
    transport: { playing: false, position: 0, duration: 0, masterVolume: 1 },
    songs: [], queue: [], stems: [],
    activeLocalProjectDir: null,
    openingLocalProjectDir: null,
    ...paths
  })
  expect(result.ok).toBe(true)
}
const marker = async (root: string, id: string, contents = '{}'): Promise<string> => {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'project.json'), contents)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('Box state', () => {
  it('persists validated state privately and reloads it after restart', async () => {
    const dir = await temp()
    const first = new BoxStateService(dir)
    const defaults = await first.getState()
    expect(defaults.ok).toBe(true)
    if (defaults.ok) expect(defaults.value).toMatchObject({
      preferences: { setupComplete: false, safeAreaPercent: 0, language: 'system' }, queue: []
    })
    expect((await first.setPreferences({ setupComplete: true, safeAreaPercent: 5, language: 'en' })).ok).toBe(true)
    expect((await first.saveQueue([{ kind: 'drive', id: 'drive-1' }, { kind: 'local', dir: join(dir, 'local') }])).ok).toBe(true)
    const file = join(dir, 'box-state.json')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
    const restarted = await new BoxStateService(dir).getState()
    expect(restarted.ok).toBe(true)
    if (restarted.ok) expect(restarted.value).toMatchObject({
      preferences: { setupComplete: true, safeAreaPercent: 5, language: 'en' },
      queue: [{ kind: 'drive', id: 'drive-1' }, { kind: 'local', dir: join(dir, 'local') }]
    })
  })

  it('normalizes legacy cue policy without discarding queue/profile and persists the override privately', async () => {
    const dir = await temp()
    const legacy = {
      version: 1,
      preferences: { setupComplete: true, safeAreaPercent: 3, language: 'en' },
      queue: [{ kind: 'drive', id: 'preserved-project' }]
    }
    await writeFile(join(dir, 'box-state.json'), JSON.stringify(legacy))
    const service = new BoxStateService(dir)
    expect(await service.getState()).toMatchObject({ ok: true, value: {
      ...legacy, preferences: { ...legacy.preferences, metronomeOverride: 'song' }
    } })
    expect(await service.setPreferences({ metronomeOverride: 'off' })).toMatchObject({ ok: true })
    expect(await new BoxStateService(dir).getState()).toMatchObject({ ok: true, value: {
      ...legacy, preferences: { ...legacy.preferences, metronomeOverride: 'off' }
    } })
    const file = join(dir, 'box-state.json')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await service.setPreferences({ metronomeOverride: 'unknown' as 'off' })).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(await service.getState()).toMatchObject({ ok: true, value: { preferences: { metronomeOverride: 'off' } } })
    await writeFile(file, JSON.stringify({ ...legacy, preferences: { ...legacy.preferences, metronomeOverride: 'unknown' } }))
    expect(await new BoxStateService(dir, () => undefined).getState()).toMatchObject({ ok: true, value: { queue: [] } })
    expect((await readdir(dir)).some(name => name.startsWith('box-state.json.corrupt-'))).toBe(true)
  })

  it.each([
    ['schema', JSON.stringify({ version: 1, preferences: { setupComplete: false, safeAreaPercent: 2, language: 'system' }, queue: [] })],
    ['newer version', JSON.stringify({ version: 2, preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' }, queue: [] })],
    ['unknown keys', JSON.stringify({ version: 1, preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en', future: 1 }, queue: [] })],
    ['truncated', '{"version":1,"prefer'],
    ['empty', '']
  ])('quarantines %s state, preserving its bytes, and stays writable with defaults', async (_label, contents) => {
    const dir = await temp()
    const file = join(dir, 'box-state.json')
    const bytes = Buffer.from(contents)
    await writeFile(file, bytes)
    const logged: string[] = []
    const service = new BoxStateService(dir, message => logged.push(message))
    expect(await service.getState()).toMatchObject({ ok: true, value: { preferences: { setupComplete: false }, queue: [] } })
    const quarantined = (await readdir(dir)).filter(name => name.startsWith('box-state.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
    expect(await readFile(join(dir, quarantined[0]))).toEqual(bytes)
    expect(logged).toHaveLength(1)
    expect(await service.setPreferences({ setupComplete: true })).toMatchObject({ ok: true })
    expect(await service.saveQueue([{ kind: 'drive', id: 'after-recovery' }])).toMatchObject({ ok: true })
    expect(await new BoxStateService(dir).getState()).toMatchObject({ ok: true, value: {
      preferences: { setupComplete: true }, queue: [{ kind: 'drive', id: 'after-recovery' }]
    } })
  })

  it('removes orphaned temporaries from an interrupted save on startup', async () => {
    const dir = await temp()
    const orphan = join(dir, 'box-state.json.4242.0123456789abcdef.tmp')
    const unrelated = join(dir, 'other.tmp')
    await writeFile(orphan, '{"partial')
    await writeFile(unrelated, 'keep')
    expect((await new BoxStateService(dir).getState()).ok).toBe(true)
    expect((await readdir(dir)).sort()).toEqual(['other.tmp'])
  })

  it('treats the rename as the commit point and keeps memory consistent with disk', async () => {
    if (process.platform === 'win32') return
    const dir = await temp()
    const logged: string[] = []
    const service = new BoxStateService(dir, message => logged.push(message))
    // Directory fsync failure after the replacement must not report a lost save.
    ;(service as unknown as { syncParentDirectory: () => Promise<void> }).syncParentDirectory =
      async () => { throw Object.assign(new Error('EIO: sync failed'), { code: 'EIO' }) }
    expect(await service.setPreferences({ setupComplete: true })).toMatchObject({ ok: true })
    expect(await service.getState()).toMatchObject({ ok: true, value: { preferences: { setupComplete: true } } })
    expect(await new BoxStateService(dir).getState()).toMatchObject({ ok: true, value: { preferences: { setupComplete: true } } })
    expect(logged).toEqual([expect.stringContaining('could not be synced')])
  })

  it('reports write failure and never claims an in-memory save succeeded', async () => {
    const dir = await temp()
    const service = new BoxStateService(dir)
    expect((await service.getState()).ok).toBe(true)
    await mkdir(join(dir, 'box-state.json'))
    const result = await service.setPreferences({ setupComplete: true })
    expect(result).toMatchObject({ ok: false, code: 'write-failed' })
    const current = await service.getState()
    expect(current.ok).toBe(true)
    if (current.ok) expect(current.value.preferences.setupComplete).toBe(false)
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
  })

  it('rejects a schema-valid but oversized queue before commit and preserves the prior snapshot', async () => {
    const dir = await temp()
    const service = new BoxStateService(dir)
    expect((await service.saveQueue([{ kind: 'drive', id: 'before' }])).ok).toBe(true)
    const queue = Array.from({ length: 256 }, () => ({ kind: 'local' as const, dir: `/${'x'.repeat(4095)}` }))
    const result = await service.saveQueue(queue)
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    const reloaded = await new BoxStateService(dir).getState()
    expect(reloaded.ok).toBe(true)
    if (reloaded.ok) expect(reloaded.value.queue).toEqual([{ kind: 'drive', id: 'before' }])
  })
})

describe('Box managed cache', () => {
  it('refuses deletion before the first authoritative publication', async () => {
    const userData = await temp()
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    const project = await marker(storage.cacheRoot, 'drive-a')
    const result = await storage.removeCachedProject(project)
    expect(result).toMatchObject({ ok: false, code: 'guard-uninitialized' })
    expect((await stat(join(project, 'project.json'))).isFile()).toBe(true)
  })

  it('lists and removes actual stems-only and source-only fixture projects by driveId', async () => {
    const userData = await temp()
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    publish(hub)
    const stems = await stemProject(join(storage.cacheRoot, 'stems-only'), 'Actual stems fixture', 0.02)
    expect(stems.doc.songFile).toBe('original.wav')
    expect(stems.doc.songHash).toBeUndefined()
    const source = await stemProject(join(storage.cacheRoot, 'source-only'), 'Actual source fixture', 0.02)
    const original = wav(0.02)
    await writeFile(join(source.dir, 'original.wav'), original)
    source.doc.songHash = { md5: md5(original), size: original.length, mtimeMs: (await stat(join(source.dir, 'original.wav'))).mtimeMs }
    delete source.doc.stemHashes
    await rm(join(source.dir, 'stems'), { recursive: true })
    await writeFile(join(source.dir, 'project.json'), JSON.stringify(source.doc))
    const snapshot = await storage.snapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.value.projects.map((project) => project.driveId).sort()).toEqual(['source-only', 'stems-only'])
    expect(snapshot.value.totalBytes).toBeGreaterThan(0)
    expect(snapshot.value.freeBytes).toBeGreaterThan(0)
    expect(snapshot.value.cacheBytes).toBeGreaterThan(0)
    expect((await storage.removeCachedProject(stems.dir)).ok).toBe(true)
    expect((await storage.removeCachedProject(source.dir)).ok).toBe(true)
    expect((await storage.snapshot()).ok).toBe(true)
  })

  it('keeps corrupt, oversized-marker, and nested-symlink cache entries removable', async () => {
    const userData = await temp()
    const external = await temp()
    await writeFile(join(external, 'source.wav'), 'do not delete')
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    publish(hub)
    const corrupt = await marker(storage.cacheRoot, 'corrupt', '{not json')
    const large = await marker(storage.cacheRoot, 'large')
    await writeFile(join(large, 'project.json'), Buffer.alloc(1024 * 1024 + 1, 65))
    await symlink(external, join(corrupt, 'linked-source'), process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(storage.cacheRoot, '.singz-adopting-ignore'))
    await writeFile(join(storage.cacheRoot, '.singz-adopting-ignore', 'project.json'), '{}')
    const snapshot = await storage.snapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    expect(snapshot.value.projects.map((project) => [project.driveId, project.name])).toEqual([
      ['corrupt', 'corrupt'], ['large', 'large']
    ])
    expect((await storage.removeCachedProject(corrupt)).ok).toBe(true)
    expect((await storage.removeCachedProject(large)).ok).toBe(true)
    expect(await readFile(join(external, 'source.wav'), 'utf8')).toBe('do not delete')
  })

  it('rejects raw traversal, external directories, symlink children, and active/opening projects', async () => {
    const userData = await temp()
    const external = await temp()
    await writeFile(join(external, 'project.json'), '{}')
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    publish(hub)
    const project = await marker(storage.cacheRoot, 'guarded')
    expect((await storage.removeCachedProject(`${storage.cacheRoot}/guarded/../guarded`))).toMatchObject({
      ok: false, code: 'invalid-path'
    })
    expect((await storage.removeCachedProject(external)).ok).toBe(false)
    const linked = join(storage.cacheRoot, 'linked')
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await storage.removeCachedProject(linked)).ok).toBe(false)
    publish(hub, { activeLocalProjectDir: project })
    expect((await storage.removeCachedProject(project))).toMatchObject({ ok: false, code: 'project-active' })
    publish(hub, { activeLocalProjectDir: null, openingLocalProjectDir: project })
    expect((await storage.removeCachedProject(project))).toMatchObject({ ok: false, code: 'project-active' })
    publish(hub, { openingLocalProjectDir: null })
    expect((await storage.removeCachedProject(project)).ok).toBe(true)
    expect((await stat(join(external, 'project.json'))).isFile()).toBe(true)
  })

  it('sweeps interrupted removals from dead or idle owners but not a live foreign process', async () => {
    const userData = await temp()
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    const dead = await marker(storage.cacheRoot, '.singz-removing-999999999-0123456789abcdef')
    await mkdir(join(dead, 'stems', 'nested'), { recursive: true })
    await writeFile(join(dead, 'stems', 'nested', 'vocals.wav'), Buffer.alloc(1024))
    const own = await marker(storage.cacheRoot, `.singz-removing-${process.pid}-fedcba9876543210`)
    const live = await marker(storage.cacheRoot, `.singz-removing-${process.ppid}-00112233445566aa`)
    const adopting = await marker(storage.cacheRoot, '.singz-adopting-keep')
    expect((await storage.snapshot()).ok).toBe(true)
    const names = (await readdir(storage.cacheRoot)).sort()
    expect(names).not.toContain(basename(dead))
    expect(names).not.toContain(basename(own))
    expect(names).toEqual([basename(live), basename(adopting)].sort())
  })

  it('restores a project whose removal failed instead of stranding it in quarantine', async () => {
    const userData = await temp()
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    publish(hub)
    const project = await marker(storage.cacheRoot, 'too-many-files')
    await Promise.all(Array.from({ length: 4100 }, (_, index) => writeFile(join(project, `f${index}`), '')))
    expect(await storage.removeCachedProject(project)).toMatchObject({ ok: false, code: 'storage-write-failed' })
    expect((await stat(join(project, 'project.json'))).isFile()).toBe(true)
    expect((await readdir(storage.cacheRoot)).filter(name => name.startsWith('.singz-removing-'))).toEqual([])
  })

  it('filters internal entries before applying the project listing bound', async () => {
    const userData = await temp()
    const storage = new BoxStorageService(userData, new BoxControllerHub())
    await mkdir(storage.cacheRoot, { recursive: true })
    await Promise.all(Array.from({ length: 512 }, (_, index) => mkdir(join(storage.cacheRoot, `.singz-adopting-${index}`))))
    await marker(storage.cacheRoot, 'real-project')
    const snapshot = await storage.snapshot()
    expect(snapshot.ok).toBe(true)
    if (snapshot.ok) expect(snapshot.value.projects.map(project => project.driveId)).toEqual(['real-project'])
  })

  it('handles a missing cache root with actual filesystem capacity', async () => {
    const userData = await temp()
    const hub = new BoxControllerHub()
    const storage = new BoxStorageService(userData, hub)
    const result = await storage.snapshot()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.projects).toEqual([])
  })
})
