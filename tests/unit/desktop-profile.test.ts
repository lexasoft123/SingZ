import { describe, expect, it, vi } from 'vitest'
import { posix, win32 } from 'node:path'
import { migrateDesktopProfile, type ProfileFileSystem } from '../../src/main/desktop-profile'

function fixture(names: string[] = [], caseInsensitive = false) {
  const appData = '/config'
  let nextInode = 1
  const directories = new Map(names.map(name => [name, {
    ino: nextInode++, dev: 1, realpath: `${appData}/${name}`,
    entries: { 'settings.json': `${name} settings`, 'voice-takes': `${name} recordings` }
  }]))
  const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' })
  const lookup = (directory: string) => {
    const name = posix.basename(directory)
    const actual = caseInsensitive ? [...directories.keys()].find(key => key.toLowerCase() === name.toLowerCase()) : name
    const entry = actual && directories.get(actual)
    if (!entry) throw missing()
    return entry
  }
  const io: ProfileFileSystem = {
    statSync: vi.fn(directory => ({ ...lookup(directory), isDirectory: () => true })),
    lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
    realpathSync: vi.fn(directory => lookup(directory).realpath),
    readdirSync: vi.fn(() => [...directories.keys()]),
    renameSync: vi.fn((from, to) => {
      if (directories.has(posix.basename(to))) throw new Error('must never overwrite')
      const entry = lookup(from)
      directories.delete(posix.basename(from))
      directories.set(posix.basename(to), { ...entry, realpath: to })
    })
  }
  const warn = vi.fn()
  const run = () => migrateDesktopProfile(appData, { fs: io, path: posix, warn })
  return { appData, directories, io, warn, run }
}

describe('desktop profile paths', () => {
  it.each([
    ['macOS', posix, '/Users/test/Library/Application Support', '/Users/test/Library/Application Support/SingZ'],
    ['Linux', posix, '/home/test/.config', '/home/test/.config/SingZ'],
    ['Windows', win32, 'C:\\Users\\test\\AppData\\Roaming', 'C:\\Users\\test\\AppData\\Roaming\\SingZ']
  ] as const)('uses the product spelling on %s', (_platform, path, appData, expected) => {
    const { io } = fixture()
    expect(migrateDesktopProfile(appData, { fs: io, path })).toBe(expected)
    expect(io.renameSync).not.toHaveBeenCalled()
  })
})

describe('desktop profile migration', () => {
  it.each(['singz', 'SingZ'])('never renames a case-insensitive directory stored as %s', spelling => {
    const f = fixture([spelling], true)
    expect(f.run()).toBe('/config/SingZ')
    expect([...f.directories.keys()]).toEqual([spelling])
    expect(f.io.renameSync).not.toHaveBeenCalled()
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('also recognizes the same directory by device/inode when realpath spellings differ', () => {
    const f = fixture(['singz', 'SingZ'])
    f.directories.get('SingZ')!.ino = f.directories.get('singz')!.ino
    expect(f.run()).toBe('/config/SingZ')
    expect(f.io.renameSync).not.toHaveBeenCalled()
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('atomically moves a distinct legacy-only directory with every entry intact, once', () => {
    const f = fixture(['singz'])
    const entries = f.directories.get('singz')!.entries
    expect(f.run()).toBe('/config/SingZ')
    expect(f.io.renameSync).toHaveBeenCalledExactlyOnceWith('/config/singz', '/config/SingZ')
    expect([...f.directories.keys()]).toEqual(['SingZ'])
    expect(f.directories.get('SingZ')!.entries).toBe(entries)
    expect(f.run()).toBe('/config/SingZ')
    expect(f.io.renameSync).toHaveBeenCalledTimes(1)
    expect(f.warn).not.toHaveBeenCalled()
  })

  it('negative control: keeps both distinct profiles without merging even non-colliding entries', () => {
    const f = fixture(['singz', 'SingZ'])
    Object.assign(f.directories.get('singz')!.entries, { 'legacy-only': 'keep here' })
    const before = structuredClone([...f.directories])
    expect(f.run()).toBe('/config/SingZ')
    expect([...f.directories]).toEqual(before)
    expect(f.io.renameSync).not.toHaveBeenCalled()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('Legacy profile left untouched: /config/singz'))
  })

  it.each(['EXDEV', 'EACCES', 'EPERM'])('continues using the intact legacy profile after %s', code => {
    const f = fixture(['singz'])
    vi.mocked(f.io.renameSync).mockImplementation(() => { throw Object.assign(new Error(code), { code }) })
    const before = structuredClone([...f.directories])
    expect(f.run()).toBe('/config/singz')
    expect([...f.directories]).toEqual(before)
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('continuing with /config/singz'))
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining(code))
    expect(f.run()).toBe('/config/singz')
    expect([...f.directories]).toEqual(before)
  })

  it('does not rename a legacy symlink to user-managed storage', () => {
    const f = fixture(['singz'])
    vi.mocked(f.io.lstatSync).mockReturnValue({ isSymbolicLink: () => true })
    expect(f.run()).toBe('/config/singz')
    expect(f.io.renameSync).not.toHaveBeenCalled()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('symbolic link'))
  })

  it('uses the canonical directory if another launch completes migration first', () => {
    const f = fixture(['singz'])
    vi.mocked(f.io.renameSync).mockImplementationOnce((_from, to) => {
      // Simulate another process completing exactly this move before our call.
      const entry = f.directories.get('singz')!
      f.directories.delete('singz')
      f.directories.set('SingZ', { ...entry, realpath: to })
      throw Object.assign(new Error('already moved'), { code: 'ENOENT' })
    })
    expect(f.run()).toBe('/config/SingZ')
    expect([...f.directories.keys()]).toEqual(['SingZ'])
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('continuing with /config/SingZ'))
    expect(f.io.renameSync).toHaveBeenCalledTimes(1)
  })

  it('requires the exact lowercase entry in the parent listing before renaming', () => {
    const f = fixture(['singz'])
    vi.mocked(f.io.readdirSync).mockReturnValue(['sInGz'])
    expect(f.run()).toBe('/config/SingZ')
    expect(f.io.renameSync).not.toHaveBeenCalled()
  })

  it('preserves the known legacy profile when inspection fails', () => {
    const f = fixture(['singz'])
    vi.mocked(f.io.readdirSync).mockImplementation(() => { throw new Error('EACCES') })
    expect(f.run()).toBe('/config/singz')
    expect(f.io.renameSync).not.toHaveBeenCalled()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'))
  })

  it('does not confuse matching inode numbers on different devices', () => {
    const f = fixture(['singz', 'SingZ'])
    Object.assign(f.directories.get('SingZ')!, { ino: 1, dev: 2 })
    expect(f.run()).toBe('/config/SingZ')
    expect(f.warn).toHaveBeenCalled()
    expect(f.io.renameSync).not.toHaveBeenCalled()
  })
})
