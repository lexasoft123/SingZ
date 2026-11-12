import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fault = vi.hoisted(() => ({
  renameTo: null as RegExp | null, // rename whose destination matches throws…
  renameCode: 'EIO',
  renameFailures: Infinity, // …this many times
  fsyncPath: null as RegExp | null, // fsync of an fd opened on a matching path throws
  dirFsync: false, // fsync of a directory fd throws
  readPath: null as RegExp | null, // readFileSync of a matching path throws
  readCode: 'EIO',
  hold: null as { reached: () => void; gate: Promise<void> } | null, // parks an async rename onto the backup
  events: [] as string[],
  fds: new Map<number, string>()
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const err = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code })
  const norm = (path: string): string => basename(path).replace(/(\.g\d+)?\.[0-9a-f]{16}\.tmp$/, '.tmp')
  return {
    ...real,
    open: async (path: string, ...rest: unknown[]) => {
      const handle = await (real.open as (...a: unknown[]) => Promise<Awaited<ReturnType<typeof real.open>>>)(path, ...rest)
      const name = String(path)
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'sync') {
            return async (): Promise<void> => {
              const isDir = (await real.stat(name)).isDirectory()
              if (isDir ? fault.dirFsync : fault.fsyncPath?.test(name)) throw err('EIO')
              fault.events.push(`fsync:${isDir ? 'dir' : norm(name)}`)
              await target.sync()
              if (fault.hold && /settings\.json\.bak\.g\d+\.[0-9a-f]+\.tmp$/.test(name)) {
                // a slow disk: the staged temp is on disk, the job's continuation has not run yet
                const { reached, gate } = fault.hold
                reached()
                await gate
              }
            }
          }
          const value = Reflect.get(target, key) as unknown
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
        }
      })
    },
    rename: async (from: string, to: string): Promise<void> => {
      fault.events.push(`rename:${basename(String(to))}`)
      await real.rename(from, to)
    }
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  const err = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code })
  return {
    ...real,
    openSync: (path: string, ...rest: unknown[]): number => {
      const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest)
      fault.fds.set(fd, String(path))
      return fd
    },
    fsyncSync: (fd: number): void => {
      const path = fault.fds.get(fd) ?? ''
      const isDir = real.statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false
      if (isDir ? fault.dirFsync : fault.fsyncPath?.test(path)) throw err('EIO')
      fault.events.push(`fsync:${isDir ? 'dir' : basename(path).replace(/\.[0-9a-f]{16}\.tmp$/, '.tmp')}`)
      real.fsyncSync(fd)
    },
    renameSync: (from: string, to: string): void => {
      if (fault.renameTo?.test(String(to)) && fault.renameFailures-- > 0) throw err(fault.renameCode)
      fault.events.push(`rename:${basename(String(to))}`)
      real.renameSync(from, to)
    },
    readFileSync: (path: string, ...rest: unknown[]): unknown => {
      if (fault.readPath?.test(String(path))) throw err(fault.readCode)
      if (String(path).endsWith('.bak')) fault.events.push('read:bak')
      return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)
    }
  }
})
vi.mock('../../src/main/gdrive-config', () => ({ default: { clientId: 'fixture-client', clientSecret: 'fixture-only' } }))

import { app } from 'electron'
import { copyFileSync } from 'node:fs'
import { publishStagedSync, stageFile, writeFileAtomicSync } from '../../src/main/atomic-file'

type Settings = typeof import('../../src/main/settings')
let S: Settings
let D: typeof import('../../src/main/sync-dirty')
let G: typeof import('../../src/main/gdrive')
let P: typeof import('../../src/main/projects')
/** A new process: every module built anew, only the files survive. */
async function relaunch(): Promise<void> {
  if (S) await S.settingsBackupIdle()
  vi.resetModules()
  S = await import('../../src/main/settings')
  D = await import('../../src/main/sync-dirty')
  G = await import('../../src/main/gdrive')
  P = await import('../../src/main/projects')
}

const dataDir = (): string => app.getPath('userData')
const file = (): string => join(dataDir(), 'settings.json')
const bak = (): string => `${file()}.bak`
const names = (): string[] => readdirSync(dataDir()).filter((n) => n.startsWith('settings.json'))
const corrupt = (): string[] => names().filter((n) => n.includes('.corrupt-'))
const events = (): string[] => fault.events.filter((e) => !e.startsWith('read:'))
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
const tokens = { access: 'a', refresh: 'r', expiresAt: Date.now() + 3_600_000 }
let root: string

beforeEach(async () => {
  if (S) await S.settingsBackupIdle()
  Object.assign(fault, { hold: null, renameTo: null, renameCode: 'EIO', renameFailures: Infinity, fsyncPath: null, dirFsync: false, readPath: null, readCode: 'EIO' })
  fault.events.length = 0
  mkdirSync(dataDir(), { recursive: true })
  for (const n of names()) rmSync(join(dataDir(), n), { force: true })
  root = mkdtempSync(join(tmpdir(), 'singz-settings-atomic-'))
  await relaunch()
})
afterEach(async () => {
  // A closing mark waits on a timer; settle it while this test's module instance still owns it,
  // so it cannot write into a later test's files.
  Object.assign(fault, { hold: null, renameTo: null, fsyncPath: null, dirFsync: false, readPath: null })
  D.flushDirty()
  await S.settingsBackupIdle()
  rmSync(root, { recursive: true, force: true })
})

describe('atomic publish', () => {
  it('keeps the old file when the process dies between temp write and rename', async () => {
    expect(S.writeSettings({ projectsRoot: '/old' })).toBe(true)
    const before = readFileSync(file(), 'utf8')
    fault.renameTo = /settings\.json$/
    expect(S.writeSettings({ projectsRoot: '/new' })).toBe(false)
    fault.renameTo = null
    await S.settingsBackupIdle()
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(names().filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('retries a Windows sharing violation on the rename, then succeeds', () => {
    S.writeSettings({ projectsRoot: '/old' })
    fault.renameTo = /settings\.json$/
    fault.renameCode = 'EPERM'
    fault.renameFailures = 2
    expect(S.writeSettings({ projectsRoot: '/new' })).toBe(true)
    expect(S.readSettings().projectsRoot).toBe('/new')
  })

  it('gives up on a persistent sharing violation within the bound and never unlinks the destination', async () => {
    const target = join(root, 'target.json')
    writeFileSync(target, 'old')
    fault.renameTo = /target\.json$/
    fault.renameCode = 'EBUSY'
    let clock = 0
    const slept: number[] = []
    expect(() => writeFileAtomicSync(target, Buffer.from('new'), { sleep: (ms) => { slept.push(ms); clock += ms }, now: () => clock })).toThrow(/EBUSY/)
    expect(clock).toBeLessThanOrEqual(2000)
    expect(slept.length).toBeGreaterThan(3)
    expect(slept[1]).toBeGreaterThan(slept[0]) // backs off
    expect(readFileSync(target, 'utf8')).toBe('old')
    // the publish step of the backup (staged temp, then a synchronous rename) has the same bound
    const staged = join(root, 'staged.tmp')
    await stageFile(staged, Buffer.from('new'))
    clock = 0
    slept.length = 0
    expect(() => publishStagedSync(staged, target, { sleep: (ms) => { slept.push(ms); clock += ms }, now: () => clock })).toThrow(/EBUSY/)
    expect(clock).toBeLessThanOrEqual(2000)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(root)).toEqual(['target.json'])
  })

  it('commits main with a file fsync but no directory fsync on the calling thread', async () => {
    S.writeSettings({ projectsRoot: '/a' })
    expect(events()).toEqual(['fsync:settings.json.tmp', 'rename:settings.json'])
    await S.settingsBackupIdle()
    expect(events().slice(2)).toEqual(['fsync:settings.json.bak.tmp', 'rename:settings.json.bak', 'fsync:dir']) // deferred, off thread
  })
})

describe('the backup', () => {
  it('holds the state just saved — created by the first save, never one behind', async () => {
    S.writeSettings({ gdrive: tokens, projectsRoot: '/a' })
    await S.settingsBackupIdle()
    expect(json(bak())).toEqual(json(file()))
    S.writeSettings({ gdrive: undefined })
    await S.settingsBackupIdle()
    expect(json(bak())).toEqual(json(file()))
    expect(json(bak()).gdrive).toBeUndefined()
    expect(json(file())._gen).toBe(2)
  })

  it('coalesces a burst: only the latest bytes are written, one at a time', async () => {
    for (let i = 0; i < 20; i++) S.writeSettings({ releaseNotesSeen: `v${i}` })
    await S.settingsBackupIdle()
    expect(json(bak()).releaseNotesSeen).toBe('v19')
    expect(fault.events.filter((e) => e === 'rename:settings.json.bak').length).toBeLessThanOrEqual(2)
  })

  it('a failed backup fsync leaves the main committed and no stale backup file behind', async () => {
    S.writeSettings({ gdrive: tokens })
    await S.settingsBackupIdle()
    fault.fsyncPath = /settings\.json\.bak\.(g\d+\.)?[0-9a-f]+\.tmp$/
    expect(S.writeSettings({ gdrive: undefined })).toBe(true) // main is committed
    await S.settingsBackupIdle()
    fault.fsyncPath = null
    expect(json(file()).gdrive).toBeUndefined()
    expect(existsSync(bak())).toBe(false) // the signed-in copy must not survive a sign-out
    writeFileSync(file(), '{ "gdr')
    expect(S.readSettings().gdrive).toBeUndefined() // this process still holds what it committed
    await relaunch()
    writeFileSync(file(), '{ "gdr')
    expect(S.readSettings().gdrive).toBeUndefined() // and a later one finds no stale copy
  })

  it('a backup still in flight is never restored over the newer state this process committed', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' })
    await S.settingsBackupIdle()
    S.writeSettings({ gdrive: undefined }) // the backup file still holds the tokens: this write has not reached it
    expect(json(bak()).gdrive).toBeDefined()
    writeFileSync(file(), '{')
    expect(S.readSettings()).toEqual({ language: 'ru' })
    expect(json(file())._gen).toBe(2)
  })

  it('a directory-fsync failure is logged off thread; the save itself stays committed and the backup is dropped', async () => {
    S.writeSettings({ projectsRoot: '/old' })
    await S.settingsBackupIdle()
    fault.dirFsync = true
    expect(S.writeSettings({ projectsRoot: '/new' })).toBe(true)
    await S.settingsBackupIdle()
    fault.dirFsync = false
    expect(json(file()).projectsRoot).toBe('/new')
    expect(existsSync(bak())).toBe(false)
  })

  it('the synchronous flush leaves a busy publisher alone: one writer, one backup rename', async () => {
    S.writeSettings({ language: 'ru' })
    S.flushSettingsBackupSync()
    await S.settingsBackupIdle()
    expect(json(bak())).toEqual(json(file()))
    expect(events().filter((e) => e === 'rename:settings.json.bak')).toHaveLength(1)
  })
})

describe('recovery (a fresh process)', () => {
  it('restores the latest values after truncation and keeps the corrupt bytes', async () => {
    S.writeSettings({ projectsRoot: '/lib' })
    S.writeSettings({ language: 'ru' })
    S.writeSettings({ gdrive: tokens })
    await relaunch()
    writeFileSync(file(), '{ "projectsRoot": "/li') // torn write
    expect(S.readSettings()).toEqual({ projectsRoot: '/lib', language: 'ru', gdrive: tokens })
    expect(corrupt()).toHaveLength(1)
    expect(readFileSync(join(dataDir(), corrupt()[0]), 'utf8')).toBe('{ "projectsRoot": "/li')
    expect(json(file())).toMatchObject({ language: 'ru' }) // main is whole again
    S.writeSettings({ qwenOfferDismissed: true })
    expect(S.readSettings()).toMatchObject({ projectsRoot: '/lib', language: 'ru', qwenOfferDismissed: true })
    expect(json(file())._gen).toBe(4) // generations carry on from the restored copy
  })

  it('a sign-out followed by corruption does not bring the credentials back', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' })
    S.writeSettings({ gdrive: undefined })
    await relaunch()
    writeFileSync(file(), '{')
    expect(S.readSettings()).toEqual({ language: 'ru' })
  })

  it('reads the recovery copy before it moves the corrupt file aside', async () => {
    S.writeSettings({ language: 'ru' })
    await relaunch()
    writeFileSync(file(), '{')
    fault.events.length = 0
    S.readSettings()
    const readAt = fault.events.indexOf('read:bak')
    expect(readAt).toBeGreaterThanOrEqual(0)
    expect(readAt).toBeLessThan(fault.events.findIndex((e) => e === 'rename:settings.json'))
  })

  it('finishes an interrupted recovery on the next read', async () => {
    S.writeSettings({ language: 'ru', projectsRoot: '/lib' })
    await relaunch()
    writeFileSync(file(), '{')
    fault.renameTo = /settings\.json$/ // dies after moving aside, before restoring the main
    expect(S.readSettings()).toMatchObject({ language: 'ru', projectsRoot: '/lib' })
    expect(existsSync(file())).toBe(false)
    fault.renameTo = null
    expect(S.readSettings()).toMatchObject({ language: 'ru', projectsRoot: '/lib' })
    expect(json(file())).toMatchObject({ language: 'ru' })
    expect(corrupt()).toHaveLength(1)
  })

  it('keeps a corrupt file aside when there is no good copy, and starts empty', async () => {
    writeFileSync(file(), 'not json')
    expect(S.readSettings()).toEqual({})
    expect(S.writeSettings({ language: 'ru' })).toBe(true)
    expect(readFileSync(join(dataDir(), corrupt()[0]), 'utf8')).toBe('not json')
  })

  it('an unparseable backup is not trusted', async () => {
    S.writeSettings({ language: 'ru' })
    await relaunch()
    writeFileSync(bak(), '{ nope')
    writeFileSync(file(), '{')
    expect(S.readSettings()).toEqual({})
    expect(corrupt()).toHaveLength(1)
  })
})

describe('unreadable or unpreserved files refuse writes', () => {
  it('a transient read error with no backup never becomes an empty merge base', async () => {
    S.writeSettings({ gdrive: tokens, projectsRoot: '/lib' })
    await relaunch()
    rmSync(bak())
    const before = readFileSync(file(), 'utf8')
    fault.readPath = /settings\.json$/
    fault.readCode = 'EACCES'
    expect(S.readSettings()).toEqual({})
    expect(S.writeSettings({ language: 'ru' })).toBe(false)
    expect(() => S.writeSettingsStrict({ language: 'ru' })).toThrow(/unreadable/)
    fault.readPath = null
    expect(readFileSync(file(), 'utf8')).toBe(before)
    expect(S.writeSettings({ language: 'ru' })).toBe(true)
    expect(S.readSettings()).toMatchObject({ gdrive: tokens, projectsRoot: '/lib', language: 'ru' })
  })

  it('a failed quarantine never lets a save overwrite the corrupt original', async () => {
    S.writeSettings({ language: 'ru' })
    await relaunch()
    writeFileSync(file(), '{ "gdrive": {"refresh": "secret"')
    const before = readFileSync(file())
    fault.renameTo = /\.corrupt-/
    expect(S.writeSettings({ projectsRoot: '/x' })).toBe(false)
    expect(() => S.writeSettingsStrict({ projectsRoot: '/x' })).toThrow(/not preserved/)
    expect(readFileSync(file())).toEqual(before)
    expect(corrupt()).toEqual([])
  })
})

describe('sync-dirty marks', () => {
  const project = (name: string): string => {
    const dir = join(root, name)
    mkdirSync(dir)
    writeFileSync(join(dir, 'project.json'), '{}')
    return dir
  }

  it('marks in one synchronous burst become one write', async () => {
    const dirs = ['a', 'b', 'c', 'd'].map(project)
    for (const dir of dirs) D.markProjectDirty(dir, 'save')
    expect(D.dirtyDirs()).toEqual(dirs) // visible at once
    expect(events()).toEqual([]) // nothing written yet
    await Promise.resolve()
    expect(fault.events.filter((e) => e === 'rename:settings.json')).toHaveLength(1)
    expect(json(file()).gdriveDirty).toMatchObject({ seq: 4 })
  })

  it('withDirty writes its mark durably before the operation runs, and the closing mark after', async () => {
    const dir = project('Song')
    let seenOnDisk = -1
    await D.withDirty(dir, 'save', async () => {
      seenOnDisk = (json(file()).gdriveDirty as { seq: number }).seq // what a crash right now would find
    })
    expect(seenOnDisk).toBe(1)
    await Promise.resolve()
    expect(D.dirtySeq()).toBe(2) // the closing mark is visible at once…
    expect((json(file()).gdriveDirty as { seq: number }).seq).toBe(1) // …and rides on the next write
    expect(D.flushDirty()).toBe(true)
    expect((json(file()).gdriveDirty as { seq: number }).seq).toBe(2)
  })

  it('does not report clean when a mark could not be saved', () => {
    const dir = project('Song')
    fault.renameTo = /settings\.json$/
    D.markProjectDirty(dir, 'save')
    expect(D.flushDirty()).toBe(false)
    expect(D.isDirty()).toBe(true)
    expect(D.dirtyDirs()).toEqual([dir])
    fault.renameTo = null
    expect(D.flushDirty()).toBe(true)
    expect(D.dirtyDirs()).toEqual([dir])
  })

  it('a failed clear stays dirty', () => {
    const dir = project('Song')
    D.markProjectDirty(dir, 'save')
    D.flushDirty()
    fault.renameTo = /settings\.json$/
    expect(D.clearDirty(D.dirtySeq())).toBe(false)
    expect(D.isDirty()).toBe(true)
  })
})

describe('callers that must observe a failed save', () => {
  it('sign-out reports a failed save and the credentials stay', () => {
    S.writeSettings({ gdrive: tokens })
    fault.renameTo = /settings\.json$/
    const res = G.gdriveSignOut()
    fault.renameTo = null
    expect(res).toMatchObject({ ok: false })
    expect(G.gdriveSignedIn()).toBe(true)
    expect(G.gdriveSignOut()).toEqual({ ok: true })
    expect(G.gdriveSignedIn()).toBe(false)
  })

  it('a library-root change fails visibly and the old root stays', async () => {
    const target = join(root, 'new-library')
    const before = S.readSettings().projectsRoot
    fault.renameTo = /settings\.json$/
    const res = await P.setProjectsRoot(target)
    fault.renameTo = null
    expect(res).toMatchObject({ ok: false })
    expect(S.readSettings().projectsRoot).toBe(before)
  })
})

/** Park the next async rename onto the backup; resolves once it is parked. */
function barrier(): { parked: Promise<void>; release: () => void } {
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const parked = new Promise<void>((r) => { reached = r })
  fault.hold = { reached, gate }
  return { parked, release: () => { fault.hold = null; release() } }
}

const leftovers = (): string[] => names().filter((n) => n.endsWith('.tmp'))

describe('one backup publisher behind a generation fence', () => {
  it('a job parked between its fsync and its publish still ends with the newest generation', async () => {
    S.writeSettings({ language: 'ru' }) // gen 1
    const gate = barrier()
    await gate.parked
    S.writeSettings({ projectsRoot: '/two' }) // gen 2, waits behind it
    gate.release()
    await S.settingsBackupIdle()
    expect(json(bak())).toEqual(json(file()))
    expect(json(bak())._gen).toBe(2)
  })

  it('session end with an old job parked: the newest generation is published at once and the old continuation discards itself', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' }) // gen 1 → parked
    const gate = barrier()
    await gate.parked
    S.writeSettings({ gdrive: undefined }) // gen 2
    S.flushSettingsBackupSync() // session-end: no waiting
    expect(json(bak())._gen).toBe(2)
    expect(json(bak()).gdrive).toBeUndefined()
    gate.release() // the old job resumes
    await S.settingsBackupIdle()
    expect(json(bak())._gen).toBe(2) // and did not rename gen 1 over it
    expect(json(bak()).gdrive).toBeUndefined()
    expect(leftovers()).toEqual([])
    expect(events().filter((e) => e === 'rename:settings.json.bak')).toHaveLength(1)
  })

  it('a quit that gave up waiting on a parked job: the later synchronous publish wins and the job discards', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' }) // gen 1 → parked
    const gate = barrier()
    await gate.parked
    S.writeSettings({ gdrive: undefined }) // gen 2
    const orderly = S.settingsShutdown() // before-quit: waits for the job…
    S.flushSettingsBackupSync() // …until will-quit, after the 3 s bound, publishes synchronously
    expect(json(bak())._gen).toBe(2)
    gate.release()
    await orderly
    await S.settingsBackupIdle()
    expect(json(bak())._gen).toBe(2)
    expect(json(bak()).gdrive).toBeUndefined()
    expect(leftovers()).toEqual([])
    expect(events().filter((e) => e === 'rename:settings.json.bak')).toHaveLength(1)
  })

  it('orderly shutdown with nothing slow ends at the newest generation', async () => {
    S.writeSettings({ language: 'ru' })
    S.writeSettings({ projectsRoot: '/two' })
    await S.settingsShutdown()
    expect(json(bak())._gen).toBe(2)
    expect(leftovers()).toEqual([])
  })

  it('a failed quit flush deletes the stale credential-bearing backup synchronously', async () => {
    S.writeSettings({ gdrive: tokens }) // gen 1
    await S.settingsBackupIdle()
    const stale = readFileSync(bak())
    fault.fsyncPath = /settings\.json\.bak\.(g\d+\.)?[0-9a-f]+\.tmp$/
    S.writeSettings({ gdrive: undefined }) // gen 2: the job fails and drops the backup
    await S.settingsBackupIdle()
    writeFileSync(bak(), stale) // …but suppose the stale copy is still there
    expect(json(bak()).gdrive).toBeDefined()
    S.flushSettingsBackupSync() // quit path, still failing
    expect(existsSync(bak())).toBe(false) // gone, synchronously
  })

  it('a failed quit flush still fences off an older parked job holding credentials', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' }) // gen 1 → parked after its fsync
    const gate = barrier()
    await gate.parked
    S.writeSettings({ gdrive: undefined }) // gen 2: signed out
    fault.fsyncPath = /settings\.json\.bak\.(g\d+\.)?[0-9a-f]+\.tmp$/
    S.flushSettingsBackupSync() // quit path fails to publish gen 2
    fault.fsyncPath = null
    fault.events.length = 0
    gate.release() // the gen-1 job resumes with its credential-bearing temp
    await S.settingsBackupIdle()
    // the queued gen-2 job publishes over any leak, so count publishes: gen 1 must never land
    expect(events().filter((e) => e === 'rename:settings.json.bak')).toHaveLength(1)
    if (existsSync(bak())) {
      expect(json(bak())._gen).toBe(2) // only the newest may ever land
      expect(json(bak()).gdrive).toBeUndefined()
    }
    expect(leftovers()).toEqual([])
  })

  it('a legacy main without a generation and no backup gets a backup on first read', async () => {
    writeFileSync(file(), JSON.stringify({ language: 'ru', projectsRoot: '/legacy' }))
    await relaunch()
    expect(S.readSettings().projectsRoot).toBe('/legacy')
    await S.settingsBackupIdle()
    expect(existsSync(bak())).toBe(true)
    expect(json(bak()).projectsRoot).toBe('/legacy')
  })

  it('a failed orderly shutdown deletes the stale backup too', async () => {
    S.writeSettings({ gdrive: tokens })
    await S.settingsBackupIdle()
    const stale = readFileSync(bak())
    fault.fsyncPath = /settings\.json\.bak\.(g\d+\.)?[0-9a-f]+\.tmp$/
    S.writeSettings({ gdrive: undefined })
    await S.settingsBackupIdle()
    writeFileSync(bak(), stale)
    await S.settingsShutdown()
    expect(existsSync(bak())).toBe(false)
  })
})

describe('power-loss contract', () => {
  it('the fast path does no directory fsync before returning', () => {
    S.writeSettings({ language: 'ru' })
    expect(events()).not.toContain('fsync:dir')
  })

  it('critical writes fsync the directory entry before returning', async () => {
    S.writeSettingsStrict({ language: 'ru' }, { durable: true })
    expect(events()).toEqual(['fsync:settings.json.tmp', 'rename:settings.json', 'fsync:dir'])
    fault.events.length = 0
    S.writeSettings({ gdrive: tokens })
    await S.settingsBackupIdle()
    fault.events.length = 0
    expect(G.gdriveSignOut()).toEqual({ ok: true })
    expect(events().slice(0, 3)).toEqual(['fsync:settings.json.tmp', 'rename:settings.json', 'fsync:dir'])
    await S.settingsBackupIdle()
    fault.events.length = 0
    await P.setProjectsRoot(join(root, 'lib'))
    expect(events().slice(0, 3)).toEqual(['fsync:settings.json.tmp', 'rename:settings.json', 'fsync:dir'])
  })

  it("withDirty's opening write-ahead mark is power-loss durable, the closing mark is not", async () => {
    const dir = join(root, 'Song')
    mkdirSync(dir)
    writeFileSync(join(dir, 'project.json'), '{}')
    let seen: string[] = []
    await D.withDirty(dir, 'save', async () => { seen = events() })
    expect(seen).toEqual(['fsync:settings.json.tmp', 'rename:settings.json', 'fsync:dir'])
  })
})

describe('withDirty refuses to run without its write-ahead mark', () => {
  it('fn is never called when the opening flush fails (negative control: it is called when it succeeds)', async () => {
    const dir = join(root, 'Song')
    mkdirSync(dir)
    writeFileSync(join(dir, 'project.json'), '{}')
    const fn = vi.fn(async () => 'done')
    await expect(D.withDirty(dir, 'save', fn)).resolves.toBe('done')
    expect(fn).toHaveBeenCalledTimes(1)
    fn.mockClear()
    fault.renameTo = /settings\.json$/
    await expect(D.withDirty(dir, 'save', fn)).rejects.toThrow(/not starting/)
    expect(fn).not.toHaveBeenCalled()
    expect(D.isDirty()).toBe(true) // and the change is still remembered in memory
  })
})

describe('restart snapshots taken without draining pending work', () => {
  /** What a crash right now leaves behind, as a fresh process finds it. */
  async function crashAndRestart(): Promise<void> {
    const saved = new Map(names().filter((n) => !n.endsWith('.tmp')).map((n) => [n, readFileSync(join(dataDir(), n))]))
    await S.settingsBackupIdle() // test housekeeping: let the old process's threads stop before the files are swapped
    for (const n of names()) rmSync(join(dataDir(), n), { force: true })
    for (const [n, bytes] of saved) writeFileSync(join(dataDir(), n), bytes)
    await relaunch()
  }

  it('main is the newest generation, and the restarted process brings the lagging backup up to it', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' }) // gen 1
    await S.settingsBackupIdle()
    S.writeSettings({ gdrive: undefined }) // gen 2: backup job not run yet
    expect(json(bak())._gen).toBe(1) // what the crash snapshot holds
    await crashAndRestart()
    expect(S.readSettings()).toEqual({ language: 'ru' })
    await S.settingsBackupIdle()
    expect(json(bak())._gen).toBe(2) // reconciled on first read
    expect(json(bak()).gdrive).toBeUndefined()
    writeFileSync(file(), '{') // and now a corrupt main cannot bring the credentials back
    await relaunch()
    expect(S.readSettings()).toEqual({ language: 'ru' })
  })
})

describe('first-read reconciliation', () => {
  it('a main corrupted while the reconciliation job is still held restores the newest generation, not the older backup', async () => {
    S.writeSettings({ gdrive: tokens, language: 'ru' }) // gen 1
    await S.settingsBackupIdle()
    S.writeSettings({ gdrive: undefined }) // gen 2: main only; the backup is a generation behind
    const stale = readFileSync(bak())
    await S.settingsBackupIdle()
    writeFileSync(bak(), stale) // what the crash left: backup gen 1 next to main gen 2
    await relaunch()
    const gate = barrier()
    expect(S.readSettings()).toEqual({ language: 'ru' }) // first read schedules the reconciliation…
    await gate.parked // …which is now held before its publish
    expect(json(bak())._gen).toBe(1)
    writeFileSync(file(), '{') // main corrupted before it finishes
    expect(S.readSettings()).toEqual({ language: 'ru' }) // gen 2, not the signed-in gen 1
    expect(json(file())._gen).toBe(2)
    gate.release()
    await S.settingsBackupIdle()
    expect(json(bak())._gen).toBe(2)
  })
})
