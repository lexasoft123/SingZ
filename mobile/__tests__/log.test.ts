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
    expect(await second.logEntries()).toEqual([])
    const sessions = await second.logSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions[0].current).toBe(true)
    expect((await second.logSessionEntries(sessions[1].id))[0].line).toContain('Mr Crowley')
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


it('retains the previous ten launches in addition to the current launch', async () => {
  for (let session = 0; session < 13; session++) {
    const l = install()
    l.log('app', `launch ${session}`)
    await l.logEntries()
  }
  const l = install()
  l.log('app', 'current launch')
  const sessions = await l.logSessions()
  expect(sessions).toHaveLength(11)
  expect((await l.logSessionEntries(sessions[0].id))[0].line).toBe('current launch')
  expect((await l.logSessionEntries(sessions[1].id))[0].line).toBe('launch 12')
  expect((await l.logSessionEntries(sessions[10].id))[0].line).toBe('launch 3')
})

it('clears only the current launch and preserves new lines logged during the write', async () => {
  const old = install()
  old.log('app', 'previous launch')
  await old.logEntries()
  const l = install()
  l.log('app', 'current launch')
  const sessions = await l.logSessions()
  const clearing = l.clearLog()
  l.log('mic', 'after clear')
  await clearing
  expect((await l.logEntries()).map(e => e.line)).toEqual(['after clear'])
  expect((await l.logSessionEntries(sessions[1].id))[0].line).toBe('previous launch')
})

it('migrates the mixed rolling log by launch without replaying it into current', async () => {
  const entry = (t: number, line: string) => ({ t, source: 'app', level: 'info', line })
  prefs['singz.log'] = JSON.stringify([
    entry(1000, 'language: en'), entry(1001, 'SingZ 0.24.0 (72)'), entry(1100, 'old event'),
    entry(2000, 'language: en'), entry(2001, 'SingZ 0.24.0 (73)'), entry(2100, 'new event')
  ])
  const l = install()
  expect(await l.logEntries()).toEqual([])
  const sessions = await l.logSessions()
  expect(sessions).toHaveLength(3)
  expect((await l.logSessionEntries(sessions[1].id)).map(e => e.line)).toEqual([
    'language: en', 'SingZ 0.24.0 (73)', 'new event'
  ])
  expect((await l.logSessionEntries(sessions[2].id)).map(e => e.line)).toContain('old event')
})

it('keeps incoming startup lines while historical preferences are still loading', async () => {
  const l = install()
  const { NativeModules } = require('react-native')
  let resolveRead!: (raw: string | null) => void
  NativeModules.AudioRouteInfo.getTextPref = (key: string) => key === 'singz.log.current.v1'
    ? new Promise(resolve => { resolveRead = resolve }) : Promise.resolve(null)
  l.log('app', 'first new line')
  await Promise.resolve()
  l.log('mic', 'second new line')
  resolveRead(JSON.stringify({ id: 'old', startedAt: 1, entries: [{ t: 1, level: 'info', source: 'app', line: 'old' }] }))
  expect((await l.logEntries()).map(e => e.line)).toEqual(['first new line', 'second new line'])
  expect((await l.logSessions()).filter(s => !s.current)).toHaveLength(1)
})

it('does not duplicate the prior launch after a kill between history and current writes', async () => {
  const original = { id: 'old', startedAt: 1, entries: [{ t: 1, level: 'info', source: 'app', line: 'old' }] }
  prefs['singz.log.current.v1'] = JSON.stringify(original)
  prefs['singz.log.history.v1'] = JSON.stringify([original])
  const l = install()
  expect((await l.logSessions()).filter(s => !s.current)).toHaveLength(1)
  expect(await l.logSessionEntries('missing')).toEqual([])
})

it('does not overwrite the previous launch when archiving it fails', async () => {
  const original = { id: 'old', startedAt: 1, entries: [{ t: 1, level: 'info', source: 'app', line: 'old' }] }
  prefs['singz.log.current.v1'] = JSON.stringify(original)
  const l = install()
  const { NativeModules } = require('react-native')
  let rejectArchive = true
  NativeModules.AudioRouteInfo.setTextPref = async (key: string, value: string) => {
    if (key === 'singz.log.history.v1' && rejectArchive) throw new Error('full')
    prefs[key] = value
  }
  l.log('app', 'new')
  await l.logEntries()
  expect(JSON.parse(prefs['singz.log.current.v1']).id).toBe('old')
  rejectArchive = false
  l.log('app', 'retry')
  await l.logEntries()
  expect(JSON.parse(prefs['singz.log.history.v1'])[0].id).toBe('old')
  expect(JSON.parse(prefs['singz.log.current.v1']).entries.map((e: { line: string }) => e.line)).toEqual(['new', 'retry'])
})

it('does not replace unreadable saved sessions with an empty archive', async () => {
  const original = { id: 'old', startedAt: 1, entries: [{ t: 1, level: 'info', source: 'app', line: 'old' }] }
  prefs['singz.log.current.v1'] = JSON.stringify(original)
  const l = install()
  const { NativeModules } = require('react-native')
  let rejectRead = true
  NativeModules.AudioRouteInfo.getTextPref = async (key: string) => {
    if (rejectRead) throw new Error('temporarily unavailable')
    return prefs[key] ?? null
  }
  l.log('app', 'new')
  await l.logEntries()
  expect(JSON.parse(prefs['singz.log.current.v1']).id).toBe('old')
  rejectRead = false
  l.log('app', 'retry')
  await l.logEntries()
  expect(JSON.parse(prefs['singz.log.history.v1'])[0].id).toBe('old')
})
