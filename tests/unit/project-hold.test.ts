import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Hold = { putBack(): string[] }
type Settle = { quietMs: number; maxMs: number }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { holdProjects, scratchClone, SLACK_NS } = require('../e2e/mac/project-hold.cjs') as {
  holdProjects(dirs: string[], backups?: unknown[], options?: { settle?: Settle }): Hold
  scratchClone(src: string, dst: string): string
  SLACK_NS: bigint
}
const HELPER = join(process.cwd(), 'tests/e2e/mac/project-hold.cjs')

const stat = (path: string) => statSync(path, { bigint: true })
const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= SLACK_NS

/** A time with a nanosecond part no double holds — on macOS it is set
 *  exactly, so a put-back that went through utimes would miss it there. */
const OLD_MTIME = 1767350096987654321n
const OLD_ATIME = 1767350096123456789n
function setOldTimes(path: string) {
  if (process.platform === 'darwin') {
    const iso = (ns: bigint) =>
      `${new Date(Number(ns / 1000000000n) * 1000).toISOString().slice(0, 19)}.${String(ns % 1000000000n).padStart(9, '0')}Z`
    execFileSync('/usr/bin/touch', ['-a', '-d', iso(OLD_ATIME), path])
    execFileSync('/usr/bin/touch', ['-m', '-d', iso(OLD_MTIME), path])
  } else {
    utimesSync(path, Number(OLD_ATIME / 1000000000n), Number(OLD_MTIME / 1000000000n))
  }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'project-hold-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

/** A v2 project as the library holds one: two docs and a stem. */
function project(name = 'Song', version = 2) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'stems'), { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ version, name }))
  writeFileSync(join(dir, 'lyrics.json'), JSON.stringify({ source: 'whisper', lines: [] }))
  writeFileSync(join(dir, 'stems', 'vocals.flac'), 'stem')
  for (const file of ['project.json', 'lyrics.json']) setOldTimes(join(dir, file))
  return dir
}

/** What a file is: its bytes and its mtime — the two things a sync compares. */
function found(path: string) {
  return { bytes: readFileSync(path), mtimeNs: stat(path).mtimeNs }
}
function expectAsFound(path: string, was: { bytes: Buffer; mtimeNs: bigint }) {
  expect(readFileSync(path).equals(was.bytes)).toBe(true)
  const now = stat(path).mtimeNs
  expect(near(now, was.mtimeNs), `mtime ${now} against ${was.mtimeNs}`).toBe(true)
}
function expectFolderTime(dir: string, was: bigint) {
  const now = stat(dir).mtimeNs
  expect(near(now, was), `folder mtime ${now} against ${was}`).toBe(true)
}

/** How the app saves project.json: a `.part` renamed over it, which moves
 *  the project folder's time. */
function saveByRename(dir: string, text = JSON.stringify({ version: 2, name: 'Song', saved: true })) {
  const doc = join(dir, 'project.json')
  writeFileSync(`${doc}.part`, text)
  renameSync(`${doc}.part`, doc)
}

/** What iCloud does 2-4 s after anything in a project changes: set the
 *  folder's time to a whole second of its own. */
function stamp(dir: string) {
  utimesSync(dir, new Date(), new Date(Math.floor(Date.now() / 1000) * 1000 + 1000))
}

/** Someone else acting on the library while the put-back runs — iCloud, the
 *  singer's other device — played by another process, since putBack blocks
 *  this one. It waits to see `watch`'s time move away from `was`, says so,
 *  then waits for the put-back to set it back, and only then runs `act` (with
 *  `fs` and `watch` in scope). `heard` waits for a line it printed; `exited`
 *  resolves with its exit code, 3 if it never saw the put-back. */
function peer(watch: string, was: bigint, act: string[]) {
  const source = [
    "const fs = require('node:fs')",
    `const watch = ${JSON.stringify(watch)}`,
    `const was = ${was}n`,
    `const slack = ${SLACK_NS}n`,
    'let moved = false',
    'const start = Date.now()',
    "console.log('ready')",
    'const tick = setInterval(() => {',
    '  const d = fs.statSync(watch, { bigint: true }).mtimeNs - was',
    '  const back = (d < 0n ? -d : d) <= slack',
    '  if (!moved && !back) {',
    '    moved = true',
    "    console.log('saw it move')",
    '  } else if (moved && back) {',
    '    clearInterval(tick)',
    ...act.map((line) => `    ${line}`),
    '  }',
    '  if (Date.now() - start > 12000) process.exit(3)',
    '}, 20)'
  ].join('\n')
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'ignore'] })
  let said = ''
  const waiting: (() => void)[] = []
  child.stdout!.on('data', (chunk) => {
    said += String(chunk)
    for (const wake of waiting.splice(0)) wake()
  })
  return {
    heard: async (line: string) => {
      while (!said.includes(line)) await new Promise<void>((resolve) => waiting.push(resolve))
    },
    exited: new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
  }
}

describe('holdProjects / putBack', () => {
  it('puts back the bytes AND the mtime of a file the run rewrote, and touches nothing else', () => {
    const dir = project()
    const lyrics = join(dir, 'lyrics.json')
    const doc = join(dir, 'project.json')
    const lyricsWas = found(lyrics)
    const docCtime = stat(doc).ctimeNs
    const held = holdProjects([dir])
    // what the LRCLIB re-ask does to a device-transcribed lyrics.json on open
    writeFileSync(lyrics, JSON.stringify({ source: 'whisper', lines: [], lrclibPending: false, lookup: 3 }))
    expect(held.putBack()).toEqual([])
    expectAsFound(lyrics, lyricsWas)
    if (process.platform === 'darwin') expect(stat(lyrics).mtimeNs).toBe(OLD_MTIME)
    // an untouched file is not rewritten, not even with its own bytes
    expect(stat(doc).ctimeNs).toBe(docCtime)
  })

  it('puts back a time that moved even when the bytes did not', () => {
    const dir = project()
    const doc = join(dir, 'project.json')
    const was = found(doc)
    const held = holdProjects([dir])
    writeFileSync(doc, readFileSync(doc)) // a save of identical bytes
    expect(stat(doc).mtimeNs).not.toBe(was.mtimeNs)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectAsFound(doc, was)
    expect(log.mock.calls.flat().join('\n')).toMatch(/project\.json — mtime put back/)
  })

  it('recreates a file the run deleted', () => {
    const dir = project()
    const lyrics = join(dir, 'lyrics.json')
    const was = found(lyrics)
    setOldTimes(dir)
    const folderWas = stat(dir).mtimeNs
    const held = holdProjects([dir])
    rmSync(lyrics)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectAsFound(lyrics, was)
    // recreating it moved the folder's time again, so that goes back last
    expectFolderTime(dir, folderWas)
  })

  it('moves a file the run added out of the project, without destroying it', () => {
    const dir = project()
    setOldTimes(dir)
    const folderWas = stat(dir).mtimeNs
    const held = holdProjects([dir])
    writeFileSync(join(dir, 'extra.json'), 'made by the run')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectFolderTime(dir, folderWas)
    expect(existsSync(join(dir, 'extra.json'))).toBe(false)
    const line = log.mock.calls.flat().join('\n')
    const moved = /extra\.json — added during the run, moved to (.+?extra\.json)/.exec(line)
    expect(moved).not.toBeNull()
    expect(readFileSync(moved![1], 'utf8')).toBe('made by the run')
    // the put-back's own folder under the temp dir: <stamp>/<project>/<file>,
    // and never wider, whatever that layout becomes
    const stampDir = dirname(dirname(moved![1]))
    expect(dirname(stampDir)).toBe(join(tmpdir(), 'singz-e2e-put-aside'))
    rmSync(stampDir, { recursive: true, force: true })
  })

  it('names what it cannot put back — a stem, and a folder the run added — and leaves them', () => {
    const dir = project()
    const held = holdProjects([dir])
    writeFileSync(join(dir, 'stems', 'vocals.flac'), 'a different stem')
    mkdirSync(join(dir, 'made'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const problems = held.putBack()
    expect(problems.join('\n')).toMatch(/stems\/vocals\.flac: changed during the run/)
    expect(problems.join('\n')).toMatch(/made: a folder added during the run — left in place/)
    expect(existsSync(join(dir, 'made'))).toBe(true)
  })

  it('holds a file too big to keep by its size and time, and names it when it changes', () => {
    const dir = project()
    const song = join(dir, 'song.mp3')
    writeFileSync(song, Buffer.alloc(9 * 1024 * 1024, 1))
    const held = holdProjects([dir])
    writeFileSync(song, Buffer.alloc(9 * 1024 * 1024, 2))
    // Same size, so only the time can tell. Set it rather than trust the file
    // clock to move between two writes: NTFS stamps writes from a clock that
    // ticks every ~15.6 ms, and a coarse Linux clock every few.
    utimesSync(song, 1600000000, 1600000000)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack().join('\n')).toMatch(/song\.mp3: it changed during the run, and it was too big to have been kept/)
  })

  it('refuses a v1 project before anything opens it', () => {
    const dir = project('Old', 1)
    expect(() => holdProjects([dir])).toThrow(/v1 project/)
  })

  it('puts back what assertOpenedProject found in a project nobody asked for', () => {
    const asked = project('Asked')
    const other = project('Other')
    const otherDoc = join(other, 'project.json')
    const otherLyrics = join(other, 'lyrics.json')
    const docWas = found(otherDoc)
    const lyricsWas = found(otherLyrics)
    const backups: unknown[] = []
    const held = holdProjects([asked], backups)
    // as assertOpenedProject pushes it: path, text, and the stat taken with it
    backups.push([otherDoc, readFileSync(otherDoc, 'utf8'), stat(otherDoc)])
    // and one with no stat, as the check did before it kept one
    backups.push([otherLyrics, readFileSync(otherLyrics, 'utf8')])
    writeFileSync(otherDoc, '{"version":2,"rewritten":true}')
    writeFileSync(otherLyrics, '{"rewritten":true}')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const problems = held.putBack()
    expectAsFound(otherDoc, docWas)
    expect(readFileSync(otherLyrics).equals(lyricsWas.bytes)).toBe(true)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/lyrics\.json: its bytes were put back, but no time was held for it/)
  })

  it('lets its own hold win over a later copy of the same file', () => {
    const dir = project()
    const doc = join(dir, 'project.json')
    const was = found(doc)
    const backups: unknown[] = []
    const held = holdProjects([dir], backups)
    writeFileSync(doc, '{"version":2,"rewritten":true}')
    // a copy taken after the app had already written it
    backups.push([doc, readFileSync(doc, 'utf8'), stat(doc)])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectAsFound(doc, was)
  })

  it('runs once', () => {
    const dir = project()
    const lyrics = join(dir, 'lyrics.json')
    const held = holdProjects([dir])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    writeFileSync(lyrics, 'after the put-back')
    expect(held.putBack()).toEqual([])
    expect(readFileSync(lyrics, 'utf8')).toBe('after the put-back')
  })

  it('puts the project back from its exit hook when a run ends without reaching putBack', () => {
    const dir = project()
    const lyrics = join(dir, 'lyrics.json')
    const was = found(lyrics)
    // what the watchdog does at a deadline: no finally runs, the process exits
    const script = [
      `const { holdProjects } = require(${JSON.stringify(HELPER)})`,
      `holdProjects([${JSON.stringify(dir)}])`,
      `require('node:fs').writeFileSync(${JSON.stringify(lyrics)}, 'changed by a run that timed out')`,
      'process.exit(1)'
    ].join('\n')
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/library files put back: Song — lyrics\.json — bytes and times put back/)
    expectAsFound(lyrics, was)
  })

  it('takes the app the run started down BEFORE its exit hook puts the project back', async () => {
    const dir = project()
    const lyrics = join(dir, 'lyrics.json')
    const was = found(lyrics)
    // The app: a child of the run, still saving into the project when the
    // run ends without reaching putBack. Left alive past the put-back, its
    // next save would land on top of it within milliseconds. Detached,
    // because libuv puts every other child on Windows in a job that dies with
    // the run, a few milliseconds after the put-back, which only sometimes
    // beats the next save. It stops itself after 20 s.
    const app = [
      `setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(lyrics)}, 'saved by the app'), 5)`,
      'setTimeout(() => process.exit(0), 20000)'
    ].join('\n')
    const script = [
      `const { holdProjects } = require(${JSON.stringify(HELPER)})`,
      `holdProjects([${JSON.stringify(dir)}])`,
      `const app = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(app)}], { detached: true, stdio: 'ignore' })`,
      "require('node:fs').writeSync(1, String(app.pid))",
      'setTimeout(() => process.exit(1), 500)'
    ].join('\n')
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 })
    // No pid means the run died before it started the app, and proved nothing.
    // Never kill it unchecked: pid 0 is this whole process group, test runner
    // and all.
    const appPid = Number(run.stdout)
    const alive = () => {
      if (!(appPid > 0)) return false
      try {
        process.kill(appPid, 0)
        return true
      } catch {
        return false
      }
    }
    try {
      expect(appPid).toBeGreaterThan(0)
      expect(run.status).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 500))
      expectAsFound(lyrics, was)
    } finally {
      // only while it is seen alive: a pid that has gone can be someone
      // else's by now
      if (alive()) {
        try {
          process.kill(appPid, 'SIGKILL')
        } catch {
          // went in between
        }
      }
    }
  })

  it("puts a project folder's mtime back after a save by rename inside it", () => {
    const dir = project()
    setOldTimes(dir)
    const was = stat(dir).mtimeNs
    const held = holdProjects([dir])
    saveByRename(dir)
    expect(stat(dir).mtimeNs).not.toBe(was)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectFolderTime(dir, was)
    if (process.platform === 'darwin') expect(stat(dir).mtimeNs).toBe(OLD_MTIME)
    expect(log.mock.calls.flat().join('\n')).toMatch(/library folder times put back: Song\b/)
  })

  it("puts the library root's mtime back when the run is all that moved it", () => {
    const dir = project()
    project('Other')
    // Pinned old, so the save below moves it on any clock: NTFS stamps a
    // folder from a timer that can tick every 15.6 ms, and the save lands
    // within one tick of the files project() just wrote.
    setOldTimes(dir)
    setOldTimes(root)
    const was = stat(root).mtimeNs
    const held = holdProjects([dir])
    saveByRename(dir)
    stamp(root)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectFolderTime(root, was)
    expect(log.mock.calls.flat().join('\n')).toMatch(/library folder times put back: Song, project-hold-/)
  })

  it("leaves the root's mtime as it is when something else in it changed during the run", () => {
    const dir = project()
    const other = project('Other')
    setOldTimes(other) // so the change below moves it on a coarse clock too
    setOldTimes(root)
    const held = holdProjects([dir])
    // the singer changes another song meanwhile, and the root is stamped for it
    writeFileSync(join(other, 'notes.json'), 'written on another device')
    stamp(root)
    const stamped = stat(root).mtimeNs
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expect(stat(root).mtimeNs).toBe(stamped)
    expect(log.mock.calls.flat().join('\n')).toMatch(/library folder time left as it is: project-hold-\w+ — Other changed during the run too/)
  })

  // Windows wants a privilege for a link, and this is about the folder's time.
  it.skipIf(process.platform === 'win32')("holds a linked project's time from its folder, never from the link", () => {
    const dir = project()
    setOldTimes(dir)
    const was = stat(dir).mtimeNs
    const link = join(root, 'Linked')
    symlinkSync(dir, link)
    // a run that changes nothing: the put-back must not either
    const held = holdProjects([link])
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expectFolderTime(dir, was)
    if (process.platform === 'darwin') expect(stat(dir).mtimeNs).toBe(OLD_MTIME)
  })

  it("keeps a folder's new time when its files could not all be put back", () => {
    const dir = project()
    setOldTimes(dir)
    const held = holdProjects([dir])
    mkdirSync(join(dir, 'made')) // a folder the run added: named, and left in place
    const moved = stat(dir).mtimeNs
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack().join('\n')).toMatch(/made: a folder added during the run — left in place/)
    expect(stat(dir).mtimeNs).toBe(moved)
    expect(log.mock.calls.flat().join('\n')).toMatch(/library folder time left as it is: Song — its files are not all as found/)
  })

  it('puts a folder time back again when a sync client stamps it after the put-back', async () => {
    const dir = project()
    setOldTimes(dir)
    const was = stat(dir).mtimeNs
    const held = holdProjects([dir], [], { settle: { quietMs: 1500, maxMs: 15000 } })
    // iCloud: once the put-back has set the folder's time back, it stamps it,
    // as the put-back's own writes make it do seconds later
    const icloud = peer(dir, was, ['fs.utimesSync(watch, new Date(), new Date(Math.floor(Date.now() / 1000) * 1000 + 1000))'])
    await icloud.heard('ready')
    saveByRename(dir)
    await icloud.heard('saw it move')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    // judged once the stamp is certainly in, so a put-back that returned
    // before it cannot pass
    expect(await icloud.exited).toBe(0)
    expectFolderTime(dir, was)
    expect(log.mock.calls.flat().join('\n')).toMatch(/library folder times put back: Song \(again after 1 later stamp\)/)
  })

  it('stops putting the root back once another song changes while it waits', async () => {
    const dir = project()
    const other = project('Other')
    setOldTimes(dir)
    setOldTimes(other)
    setOldTimes(root)
    const was = stat(root).mtimeNs
    const held = holdProjects([dir], [], { settle: { quietMs: 1500, maxMs: 15000 } })
    // the singer's other device, once the put-back has set the root back:
    // another song changes, and iCloud stamps the root for it
    const device = peer(root, was, [
      `fs.writeFileSync(${JSON.stringify(join(other, 'notes.json'))}, 'written on another device')`,
      'fs.utimesSync(watch, new Date(), new Date(Math.floor(Date.now() / 1000) * 1000 + 2000))'
    ])
    await device.heard('ready')
    saveByRename(dir)
    stamp(root)
    await device.heard('saw it move')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(held.putBack()).toEqual([])
    expect(await device.exited).toBe(0)
    // the root keeps the time the singer's change gave it: never put back over it
    expect(near(stat(root).mtimeNs, was)).toBe(false)
    expect(log.mock.calls.flat().join('\n')).toMatch(/library folder time left as it is: project-hold-\w+ — Other changed during the run too/)
  })

  it('puts the folder time back from the exit hook too', () => {
    const dir = project()
    setOldTimes(dir)
    const was = stat(dir).mtimeNs
    const doc = join(dir, 'project.json')
    const script = [
      `const { holdProjects } = require(${JSON.stringify(HELPER)})`,
      "const fs = require('node:fs')",
      `holdProjects([${JSON.stringify(dir)}])`,
      `fs.writeFileSync(${JSON.stringify(`${doc}.part`)}, 'saved by a run that timed out')`,
      `fs.renameSync(${JSON.stringify(`${doc}.part`)}, ${JSON.stringify(doc)})`,
      'process.exit(1)'
    ].join('\n')
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
    expect(run.status).toBe(1)
    expect(run.stderr).toMatch(/library folder times put back: Song\b/)
    expectFolderTime(dir, was)
  })
})

describe('scratchClone', () => {
  it('copies a project with its times, so a cache keyed on a stem mtime still hits', () => {
    const src = project()
    const stem = join(src, 'stems', 'vocals.flac')
    setOldTimes(stem)
    const dst = join(root, 'clone')
    mkdirSync(join(dst, 'stale'), { recursive: true }) // whatever was there goes
    scratchClone(src, dst)
    expect(existsSync(join(dst, 'stale'))).toBe(false)
    for (const rel of ['project.json', 'lyrics.json', 'stems/vocals.flac']) {
      expect(readFileSync(join(dst, rel)).equals(readFileSync(join(src, rel)))).toBe(true)
      // the listen cache allows 2 ms; macOS keeps every nanosecond
      const drift = stat(join(dst, rel)).mtimeNs - stat(join(src, rel)).mtimeNs
      expect(drift < 0n ? -drift : drift).toBeLessThanOrEqual(process.platform === 'darwin' ? 0n : 1000000n)
    }
  })

  // Both branches: this platform's own, and cpSync's, which macOS takes only
  // when the volume refuses a clone (forced here by claiming to be linux).
  // Windows wants a privilege for a file link, and this is about the copy.
  describe.skipIf(process.platform === 'win32')('through links', () => {
    it.each(['this platform', 'cpSync'])('copies through them (%s), so no edit reaches a linked project', (branch) => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      if (branch === 'cpSync') Object.defineProperty(process, 'platform', { value: 'linux' })
      try {
        const src = project()
        const outside = join(root, 'outside-lyrics.json')
        writeFileSync(outside, 'the lyrics as they are')
        rmSync(join(src, 'lyrics.json'))
        symlinkSync(outside, join(src, 'lyrics.json'))
        const link = join(root, 'linked')
        symlinkSync(src, link)
        const dst = join(root, 'clone')
        scratchClone(link, dst)
        expect(lstatSync(dst).isSymbolicLink()).toBe(false)
        expect(lstatSync(join(dst, 'lyrics.json')).isSymbolicLink()).toBe(false)
        writeFileSync(join(dst, 'lyrics.json'), 'edited in the clone')
        writeFileSync(join(dst, 'project.json'), 'edited in the clone')
        expect(readFileSync(outside, 'utf8')).toBe('the lyrics as they are')
        expect(readFileSync(join(src, 'project.json'), 'utf8')).toBe(JSON.stringify({ version: 2, name: 'Song' }))
        rmSync(dst, { recursive: true, force: true })
        expect(existsSync(join(src, 'project.json'))).toBe(true)
      } finally {
        Object.defineProperty(process, 'platform', platform)
      }
    })
  })
})
