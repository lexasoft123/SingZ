/**
 * The phone's port of the desktop Log dialog. A release APK has no inspector
 * and no `run-as`, so this is the only evidence a phone leaves: it has to
 * survive a restart, stay small, and never be the reason an open fails.
 */
export {} // a module, so these locals do not collide with the other suites' globals

let prefs: Record<string, string> = {}

const install = (): typeof import('../src/log') => {
  jest.resetModules()
  const { NativeModules } = require('react-native')
  NativeModules.AudioRouteInfo = {
    getTextPref: async (k: string) => prefs[k] ?? null,
    setTextPref: async (k: string, v: string) => {
      prefs[k] = v
    }
  }
  return require('../src/log') as typeof import('../src/log')
}

beforeEach(() => {
  prefs = {}
})

describe('the phone sync log', () => {
  it('keeps what happened, oldest first — a log is read downwards', async () => {
    const l = install()
    l.log('gdrive', 'unchanged — 15 songs, nothing fetched')
    l.log('gdrive', 'Mr Crowley/stems/vocals.flac · 12 MB · 3.2 s · downloaded')
    const entries = await l.logEntries()
    expect(entries[0].line).toContain('nothing fetched')
    expect(entries[0].source).toBe('gdrive')
    expect(entries[1].line).toContain('downloaded')
  })

  it('survives the app being restarted', async () => {
    const first = install()
    first.log('song', 'opened Mr Crowley — 6 lanes from Drive')
    await first.logEntries() // let the write settle

    const second = install()
    expect((await second.logEntries())[0].line).toContain('Mr Crowley')
  })

  it('stays small — a phone log must not grow forever', async () => {
    const l = install()
    for (let i = 0; i < 460; i++) l.log('gdrive', `line ${i}`)
    const entries = await l.logEntries()
    expect(entries.length).toBeLessThanOrEqual(400)
    expect(entries[entries.length - 1].line).toBe('line 459') // the newest is always kept
  })

  it('never throws into the caller when prefs are unwritable', async () => {
    const l = install()
    const { NativeModules } = require('react-native')
    NativeModules.AudioRouteInfo.setTextPref = async () => {
      throw new Error('no room on device')
    }
    expect(() => l.log('gdrive', 'something')).not.toThrow()
    await expect(l.logEntries()).resolves.toBeDefined()
  })

  it('reaches a panel that is already open, without waiting for the write', async () => {
    const l = install()
    const seen: string[] = []
    const off = l.onLogLine((e) => seen.push(e.line))
    l.log('song', 'decoding vocals')
    expect(seen).toEqual(['decoding vocals'])
    off()
    l.log('song', 'decoding drums')
    expect(seen).toHaveLength(1)
  })

  it('writes sizes and times a singer can read', () => {
    const l = install()
    expect(l.fmtBytes(11_919_173)).toBe('12 MB')
    expect(l.fmtBytes(1_250_000_000)).toBe('1.3 GB')
    expect(l.fmtMs(3200)).toBe('3.2 s')
    expect(l.fmtMs(8)).toBe('8 ms')
  })
})
