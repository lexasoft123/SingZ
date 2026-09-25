/*
 * Leave a library project exactly as the driver found it: its bytes AND its
 * times.
 *
 * A driver that opens a project from a library in place lets the app write
 * into it — an analysis re-derived and auto-saved into project.json, a
 * device-transcribed lyrics.json that the LRCLIB re-ask marks settled
 * (`lrclibPending: false`, `lookup`), whatever a regression writes. Putting
 * the bytes back is not enough. project.json's `lyricsHash` and `stemHashes`
 * record each file's mtimeMs, compared with ~2 ms of tolerance, so a
 * lyrics.json put back with a fresh mtime makes the next sweep of a signed-in
 * desktop that syncs that library re-hash it, rewrite project.json and upload
 * it to Drive. That happened on 2026-09-24, ~26 min after a lyrics-edit run
 * that restored lyrics.json with copyFileSync, which keeps the bytes and not
 * the mtime.
 *
 * `holdProjects()` reads every top-level file of each project — bytes, mtime,
 * atime — BEFORE the app launches. `putBack()` runs once the app has CLOSED,
 * so no straggling write lands after it. It rewrites a file whose bytes moved,
 * puts back a time that moved even when the bytes did not, recreates a file
 * the run deleted, and moves a top-level file the run ADDED into a folder
 * under the system temp dir: out of the library, but not destroyed. What it
 * cannot put back (anything under stems/, a file too big to have been kept, a
 * folder the run added) it names as a problem, and the driver fails on it. The
 * `[path, text, stat]` entries assertOpenedProject hands the driver for a
 * project that opened instead of the one asked for go back the same way.
 *
 * Times go back to the nanosecond on macOS (`touch -d` with a nine-digit
 * fraction). Node's utimes takes seconds as a double and lands within ~0.2 µs
 * of the value rather than on it, which is what the other platforms get: still
 * far inside the doc's 2 ms.
 *
 * Folder times go back too, last, once every file is back. The project
 * folder's goes back when its files and entries all did; the time of the
 * folder holding it (the library root) goes back when nothing else in it
 * changed during the run. Two things move them. The app saves project.json as
 * a `.part` renamed over it, which moves the project folder's time. And iCloud
 * Drive, 2-4 s after anything in a project changes (the put-back's own writes
 * included), stamps that project folder AND the library root with a whole
 * second of its own. That stamp is the only thing that moves the root: watched
 * on 2026-09-25, no entry in it was created or removed. Setting a folder's time
 * does not draw another stamp. So in a synced folder the put-back waits for the
 * stamp its own writes draw, puts the time back after it, and returns once
 * nothing has moved for 6 s. Nothing in SingZ reads a folder's time; this is
 * only about leaving the library as found.
 *
 * `putBack()` never throws — a finally that throws skips the restores still
 * owed — and runs once. When a run ends without reaching it (the watchdog's
 * deadline, a kill, an error nothing caught) an exit hook runs it, after
 * taking down the app the run started.
 *
 * A helper, not a driver: it runs inside the driver that required it, under
 * that driver's watchdog.
 */
const { execFileSync } = require('node:child_process')
const {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync
} = require('node:fs')
const { basename, dirname, join } = require('node:path')
const { tmpdir } = require('node:os')
const { killChildren } = require('../../shared/kill-children.cjs')

/** A file larger than this is held by its size and times only. The app never
 *  writes one (the biggest is the song itself), and reading an iCloud copy
 *  that was evicted would pull it down for nothing. */
const KEEP_BYTES = 8n * 1024n * 1024n

/** How far a put-back time may land from the held one: nowhere on macOS. */
const SLACK_NS = process.platform === 'darwin' ? 0n : 1000n

/** How long a synced folder must keep its put-back time before the put-back
 *  trusts it, and the most it waits: the stamp comes 2-4 s after a write. */
const SYNC_SETTLE = { quietMs: 6000, maxMs: 30000 }

/** A folder a sync client stamps: iCloud Drive, or another File Provider. */
const syncedFolder = (real) =>
  process.platform === 'darwin' && /\/Library\/(Mobile Documents|CloudStorage)\//.test(`${real}/`)

/** Blocks, as an 'exit' listener has to: nothing asynchronous runs there. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const canonical = (path) => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}
const statNs = (path) => lstatSync(path, { bigint: true })
const sameTime = (a, b) => (a > b ? a - b : b - a) <= SLACK_NS
const kind = (entry) => (entry.isDirectory() ? 'folder' : entry.isSymbolicLink() ? 'link' : 'special file')

/** A file's bytes and times, read so that they belong together: stat, read,
 *  stat, and again if something wrote it in between. The times kept are the
 *  ones from before the read, since reading is itself what moves an atime. */
function readHeld(path) {
  for (let i = 0; i < 5; i++) {
    const stat = statNs(path)
    const bytes = stat.size <= KEEP_BYTES ? readFileSync(path) : null
    const again = statNs(path)
    if (again.mtimeNs === stat.mtimeNs && again.size === stat.size) {
      return { bytes, size: stat.size, mtimeNs: stat.mtimeNs, atimeNs: stat.atimeNs }
    }
  }
  throw new Error(`${path} kept changing while it was being read — something else is writing it`)
}

/** The form BSD touch -d takes, with all nine digits of the fraction. */
function isoNs(ns) {
  const whole = new Date(Number(ns / 1000000000n) * 1000).toISOString().slice(0, 19)
  return `${whole}.${String(ns % 1000000000n).padStart(9, '0')}Z`
}
/** Seconds as the nearest double, for utimes (whole and fraction apart, so
 *  the only rounding is the sum's). */
const seconds = (ns) => Number(ns / 1000000000n) + Number(ns % 1000000000n) / 1e9

function setTimes(path, atimeNs, mtimeNs) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/touch', ['-a', '-d', isoNs(atimeNs), path], { stdio: 'pipe' })
    execFileSync('/usr/bin/touch', ['-m', '-d', isoNs(mtimeNs), path], { stdio: 'pipe' })
  } else {
    utimesSync(path, seconds(atimeNs), seconds(mtimeNs))
  }
}

/** A folder's mtime alone: its atime moves whenever anything lists it. */
function setMtime(path, mtimeNs) {
  if (process.platform === 'darwin') {
    execFileSync('/usr/bin/touch', ['-m', '-d', isoNs(mtimeNs), path], { stdio: 'pipe' })
  } else {
    utimesSync(path, seconds(statNs(path).atimeNs), seconds(mtimeNs))
  }
}

/** What stems/ holds, by size and mtime. Stems are too big to keep, so a
 *  change there is reported and never put back. */
function listStems(dir) {
  const out = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const stat = statNs(join(dir, entry.name))
    out.set(entry.name, entry.isFile() ? `${stat.size} bytes, mtime ${stat.mtimeNs} ns` : kind(entry))
  }
  return out
}

/** Every top-level file of one project as found, and what else sits beside
 *  them. A v1 project is refused: opening one migrates its stems to FLAC and
 *  deletes the WAVs, which nothing can put back, and the old project.json put
 *  back over it would then describe files that are gone. */
function holdProject(dir) {
  // The folder's own time, never a link's: it goes back onto `real`.
  const real = canonical(dir)
  const folderMtimeNs = statNs(real).mtimeNs
  const files = new Map()
  const others = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile()) files.set(entry.name, { path, ...readHeld(path) })
    else others.set(entry.name, kind(entry))
  }
  const doc = files.get('project.json')
  if (doc && doc.bytes && (JSON.parse(doc.bytes.toString('utf8')).version ?? 1) < 2) {
    throw new Error(
      `${dir} is a v1 project — opening it migrates its stems to FLAC and deletes the WAVs, ` +
        `which no put-back can undo. Pick a v2 project.`
    )
  }
  return {
    dir,
    real,
    label: basename(dir),
    folderMtimeNs,
    files,
    others,
    stems: others.get('stems') === 'folder' ? listStems(join(dir, 'stems')) : null
  }
}

/** What sits in a folder, by name, leaving out `skip`: each entry's kind and
 *  mtime, and a file's size. The folder's own time goes back only while this
 *  still reads the same, since anything else that changed in it moved that
 *  time too, and the change was not the run's to undo. */
function listAround(dir, skip) {
  const out = new Map()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const stat = statNs(join(dir, entry.name))
    out.set(entry.name, `${entry.isFile() ? `file of ${stat.size} bytes` : `a ${kind(entry)}`}, mtime ${stat.mtimeNs} ns`)
  }
  return out
}

/** Why `around` no longer describes the folder it was taken from, or null. */
function changedAround(dir, around, skip) {
  let now
  try {
    now = listAround(dir, skip)
  } catch (error) {
    return error.message
  }
  for (const [name, was] of around) {
    if (!now.has(name)) return `${name} went away during the run`
    if (now.get(name) !== was) return `${name} changed during the run too`
  }
  for (const name of now.keys()) if (!around.has(name)) return `${name} appeared during the run`
  return null
}

/**
 * Put each folder's mtime back, once its contents are: `folders` are
 * `{ path, label, mtimeNs, blocker }`, where `blocker()` says why a folder's
 * time must stay as it is now, or null. In a synced folder (or with `settle`
 * given) it keeps watching until nothing has moved for `settle.quietMs`, at
 * most `settle.maxMs`, and puts back again whatever is stamped meanwhile.
 */
function putBackFolders(folders, settle, say, problems) {
  const left = []
  const live = []
  for (const folder of folders) {
    const why = folder.blocker()
    if (why) left.push(`${folder.label} — ${why}`)
    else live.push({ ...folder, puts: 0, done: false })
  }
  const restore = (folder) => {
    try {
      if (sameTime(statNs(folder.path).mtimeNs, folder.mtimeNs)) return false
      setMtime(folder.path, folder.mtimeNs)
      folder.puts++
      return true
    } catch (error) {
      folder.done = true
      problems.push(`${folder.label} (folder): its mtime could not be put back (${error.message})`)
      return false
    }
  }
  for (const folder of live) restore(folder)
  const wait = settle ?? (live.some((folder) => syncedFolder(folder.path)) ? SYNC_SETTLE : null)
  if (wait) {
    // Said first: this blocks, and not even Ctrl-C cuts it short.
    say(
      `library folder times: waiting for the sync's own stamp, until nothing has moved for ` +
        `${wait.quietMs / 1000} s (${wait.maxMs / 1000} s at most)`
    )
    const start = Date.now()
    let still = Date.now()
    while (Date.now() - start < wait.maxMs && Date.now() - still < wait.quietMs) {
      pause(100)
      for (const folder of live) {
        if (folder.done) continue
        // Something else changed in it while this waited: its time is no
        // longer only the run's, so it stays as that change left it.
        const why = folder.blocker()
        if (why) {
          folder.done = true
          left.push(`${folder.label} — ${why}`)
        } else if (restore(folder)) {
          still = Date.now()
        }
      }
    }
    if (Date.now() - still < wait.quietMs) {
      say(`library folder times: still being stamped when the ${wait.maxMs / 1000} s wait ran out, so a later stamp can move them again`)
    }
  }
  const back = []
  const asFound = []
  for (const folder of live) {
    if (folder.done) continue
    if (!sameTime(statNs(folder.path).mtimeNs, folder.mtimeNs)) {
      problems.push(`${folder.label} (folder): its mtime did not stay put back`)
    } else if (folder.puts === 0) {
      asFound.push(folder.label)
    } else {
      const again = folder.puts - 1
      back.push(again ? `${folder.label} (again after ${again} later stamp${again > 1 ? 's' : ''})` : folder.label)
    }
  }
  if (back.length) say(`library folder times put back: ${back.join(', ')}`)
  if (asFound.length) say(`library folder times as found: ${asFound.join(', ')}`)
  for (const line of left) say(`library folder time left as it is: ${line}`)
}

/** Out of the library, into `into`, without destroying it. */
function moveAside(path, into) {
  mkdirSync(into, { recursive: true })
  let dest = join(into, basename(path))
  for (let n = 2; existsSync(dest); n++) dest = join(into, `${n}-${basename(path)}`)
  try {
    renameSync(path, dest)
  } catch (error) {
    if (error.code !== 'EXDEV') throw error
    copyFileSync(path, dest)
    unlinkSync(path)
  }
  return dest
}

/**
 * Put one file back to `want`: `bytes` (null: held by size and times only),
 * `mtimeNs` and `atimeNs` (absent: no time was held for it). Returns what was
 * done, or null when the file was as found; throws what could not be done.
 */
function putBackFile(path, want) {
  const present = existsSync(path)
  if (want.bytes === null) {
    if (!present) throw new Error('it disappeared during the run, and it was too big to have been kept')
    const stat = statNs(path)
    if (stat.size !== want.size || stat.mtimeNs !== want.mtimeNs) {
      throw new Error('it changed during the run, and it was too big to have been kept')
    }
    return null
  }
  const current = present ? readFileSync(path) : null
  const bytesMoved = current === null || !current.equals(want.bytes)
  if (bytesMoved) {
    writeFileSync(path, want.bytes)
    if (!readFileSync(path).equals(want.bytes)) throw new Error('it reads back different after the put-back')
  }
  if (want.mtimeNs === undefined) {
    if (bytesMoved) throw new Error('its bytes were put back, but no time was held for it, so its mtime is the put-back\'s')
    return null
  }
  const timeMoved = bytesMoved || !sameTime(statNs(path).mtimeNs, want.mtimeNs)
  if (timeMoved) setTimes(path, want.atimeNs ?? want.mtimeNs, want.mtimeNs)
  if (!sameTime(statNs(path).mtimeNs, want.mtimeNs)) throw new Error('its mtime did not go back')
  if (current === null) return 'recreated, bytes and times'
  if (bytesMoved) return 'bytes and times put back'
  if (timeMoved) return 'mtime put back (its bytes were as found)'
  return null
}

/** Put one project's files back, and say whether all of them went back. */
function putBackProject(project, into, say, problems) {
  const before = problems.length
  const done = []
  const fail = (what, error) => problems.push(`${project.label}/${what}: ${error.message}`)
  for (const [name, held] of project.files) {
    try {
      const did = putBackFile(held.path, held)
      if (did) done.push(`${name} — ${did}`)
    } catch (error) {
      fail(name, error)
    }
  }
  let now = []
  try {
    now = readdirSync(project.dir, { withFileTypes: true })
  } catch (error) {
    fail('', error)
  }
  for (const entry of now) {
    if (project.files.has(entry.name) || project.others.has(entry.name)) continue
    const path = join(project.dir, entry.name)
    try {
      if (!entry.isFile()) throw new Error(`a ${kind(entry)} added during the run — left in place`)
      done.push(`${entry.name} — added during the run, moved to ${moveAside(path, join(into, project.label))}`)
    } catch (error) {
      fail(entry.name, error)
    }
  }
  for (const [name, was] of project.others) {
    const entry = now.find((e) => e.name === name)
    if (!entry) fail(name, new Error(`a ${was} that disappeared during the run`))
    else if (kind(entry) !== was) fail(name, new Error(`a ${was} that is now a ${kind(entry)}`))
  }
  if (project.stems) {
    try {
      const stemsDir = join(project.dir, 'stems')
      const after = existsSync(stemsDir) ? listStems(stemsDir) : new Map()
      for (const [name, was] of project.stems) {
        const is = after.get(name)
        if (is === undefined) fail(`stems/${name}`, new Error('disappeared during the run — stems are never put back'))
        else if (is !== was) fail(`stems/${name}`, new Error(`changed during the run (${was} → ${is}) — stems are never put back`))
      }
      for (const name of after.keys()) {
        if (!project.stems.has(name)) fail(`stems/${name}`, new Error('added during the run — stems are never put back'))
      }
    } catch (error) {
      fail('stems', error)
    }
  }
  say(
    done.length
      ? `library files put back: ${project.label} — ${done.join('; ')}`
      : `library files as found: ${project.label} (${project.files.size} top-level files)`
  )
  return problems.length === before
}

/**
 * Hold `dirs` as they are now; `backups` is the driver's list that
 * assertOpenedProject adds a wrongly opened project's files to, and it is put
 * back with them. Call before the app launches. Returns `{ putBack }`: call it
 * after the app has closed, and fail the run on what it returns — the
 * problems, each also printed as it is found; empty when every file was left
 * as found. `settle` is for tests: the wait a synced folder gets, forced on.
 */
function holdProjects(dirs, backups = [], { settle } = {}) {
  const seen = new Set()
  const projects = []
  for (const dir of dirs) {
    const real = canonical(dir)
    if (seen.has(real)) continue
    seen.add(real)
    projects.push(holdProject(dir))
  }
  // The folder each project sits in, usually the library root: its time, and
  // everything in it but the held projects, so the time goes back only when
  // the run is all that moved it.
  const parents = new Map()
  for (const project of projects) {
    const path = dirname(project.real)
    if (!parents.has(path)) parents.set(path, { path, label: basename(path), skip: new Set() })
    parents.get(path).skip.add(basename(project.real))
  }
  for (const parent of parents.values()) {
    parent.mtimeNs = statNs(parent.path).mtimeNs
    parent.around = listAround(parent.path, parent.skip)
  }
  let ran = false
  const run = (say) => {
    if (ran) return []
    ran = true
    const problems = []
    const into = join(
      tmpdir(),
      'singz-e2e-put-aside',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    )
    for (const project of projects) {
      try {
        project.whole = putBackProject(project, into, say, problems)
      } catch (error) {
        problems.push(`${project.label}: ${error.message}`)
      }
    }
    // What the check found in a project nobody asked for. A path inside a
    // project held above is skipped: that hold is older, and whole.
    const held = new Set(projects.map((p) => p.real))
    for (const [path, text, stat] of backups) {
      if (held.has(canonical(dirname(path)))) continue
      try {
        let did
        if (typeof text !== 'string') {
          if (!existsSync(path)) continue
          did = `added during the run, moved to ${moveAside(path, join(into, basename(dirname(path))))}`
        } else {
          did = putBackFile(path, {
            bytes: Buffer.from(text, 'utf8'),
            mtimeNs: stat?.mtimeNs,
            atimeNs: stat?.atimeNs
          })
        }
        say(did ? `library file put back: ${path} — ${did}` : `library file as found: ${path}`)
      } catch (error) {
        problems.push(`${path}: ${error.message}`)
      }
    }
    // Folder times last: putting files back moves them again, and in a synced
    // folder it is what draws the stamp that the wait puts back after.
    try {
      putBackFolders(
        [
          ...projects.map((project) => ({
            path: project.real,
            label: project.label,
            mtimeNs: project.folderMtimeNs,
            blocker: () => (project.whole ? null : 'its files are not all as found')
          })),
          ...[...parents.values()].map((parent) => ({
            path: parent.path,
            label: parent.label,
            mtimeNs: parent.mtimeNs,
            blocker: () => changedAround(parent.path, parent.around, parent.skip)
          }))
        ],
        settle,
        say,
        problems
      )
    } catch (error) {
      problems.push(`folder times: ${error.message}`)
    }
    // Said here as well as returned: a driver whose run threw reaches its
    // outer catch with the error, not with this list.
    for (const problem of problems) say(`library NOT left as found: ${problem}`)
    return problems
  }
  // The fallback, for a run that ends without reaching putBack: the
  // watchdog's deadline, a signal, or an error nothing caught. A put-back
  // under a live app can be saved over, so the app this run started goes
  // first, the way the watchdog takes it (kill-children.cjs: the direct
  // children, on Windows too, where Playwright's own exit handler would
  // otherwise take it down only after this one). 'exit'
  // listeners run synchronously, and so does all of this; it writes straight
  // to stderr, because a piped stdout may not flush.
  const onExit = () => {
    killChildren(process.pid)
    run((line) => writeSync(2, `${line}\n`))
  }
  process.on('exit', onExit)
  return {
    putBack() {
      process.removeListener('exit', onExit)
      return run((line) => console.log(line))
    }
  }
}

/**
 * A copy of a library project for a driver that edits one on purpose, so the
 * singer's own is never written at all: a signed-in desktop syncing that
 * library sweeps every half hour, and a sweep that lands mid-run uploads
 * whatever the driver has made of the project by then, put back afterwards or
 * not. On macOS an APFS clone (`cp -c`: instant, no space) with every time
 * kept to the nanosecond; elsewhere, or where the volume refuses a clone, a
 * copy that keeps them to the millisecond. Either way the listen cache, keyed
 * on the vocals' size and mtime within 2 ms, still hits.
 */
function scratchClone(src, dst) {
  // The project itself, never a link to it: a linked folder copied as the link
  // would put every edit back into the library. -L does the same for a link
  // inside it, and so does cpSync's `dereference`, but only with a `filter`:
  // without one Node copies the tree natively and remakes every link below the
  // top as a link again.
  const real = realpathSync(src)
  rmSync(dst, { recursive: true, force: true })
  let copied = false
  if (process.platform === 'darwin') {
    try {
      execFileSync('/bin/cp', ['-c', '-R', '-L', '-p', real, dst], { stdio: 'pipe' })
      copied = true
    } catch {
      rmSync(dst, { recursive: true, force: true })
    }
  }
  if (!copied) {
    cpSync(real, dst, { recursive: true, preserveTimestamps: true, dereference: true, filter: () => true })
  }
  // Whichever way it was copied, a link left in the clone is a way back into
  // the library, so a clone holding one is never handed back.
  const links = linksUnder(dst)
  if (links.length) {
    rmSync(dst, { recursive: true, force: true })
    throw new Error(`the copy of ${src} kept a link (${links[0]}), and a write through it would reach the library`)
  }
  return dst
}

/** Every link at or below `dir`. */
function linksUnder(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) out.push(path)
    else if (entry.isDirectory()) out.push(...linksUnder(path))
  }
  return out
}

module.exports = { holdProjects, scratchClone, SLACK_NS }
