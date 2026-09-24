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
 * `putBack()` never throws — a finally that throws skips the restores still
 * owed — and runs once. When a run ends without reaching it (the watchdog's
 * deadline, a kill, an error nothing caught) an exit hook runs it, after
 * taking down the app the run started where it can (see onExit).
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

/** A file larger than this is held by its size and times only. The app never
 *  writes one (the biggest is the song itself), and reading an iCloud copy
 *  that was evicted would pull it down for nothing. */
const KEEP_BYTES = 8n * 1024n * 1024n

/** How far a put-back time may land from the held one: nowhere on macOS. */
const SLACK_NS = process.platform === 'darwin' ? 0n : 1000n

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
    real: canonical(dir),
    label: basename(dir),
    files,
    others,
    stems: others.get('stems') === 'folder' ? listStems(join(dir, 'stems')) : null
  }
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

function putBackProject(project, into, say, problems) {
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
}

/**
 * Hold `dirs` as they are now; `backups` is the driver's list that
 * assertOpenedProject adds a wrongly opened project's files to, and it is put
 * back with them. Call before the app launches. Returns `{ putBack }`: call it
 * after the app has closed, and fail the run on what it returns — the
 * problems, each also printed as it is found; empty when every file was left
 * as found.
 */
function holdProjects(dirs, backups = []) {
  const seen = new Set()
  const projects = []
  for (const dir of dirs) {
    const real = canonical(dir)
    if (seen.has(real)) continue
    seen.add(real)
    projects.push(holdProject(dir))
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
        putBackProject(project, into, say, problems)
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
    // Said here as well as returned: a driver whose run threw reaches its
    // outer catch with the error, not with this list.
    for (const problem of problems) say(`library NOT left as found: ${problem}`)
    return problems
  }
  // The fallback, for a run that ends without reaching putBack: the
  // watchdog's deadline, a signal, or an error nothing caught. A put-back
  // under a live app can be saved over, so the app this run started goes
  // first — its direct children, the way the watchdog takes them. That holds
  // on macOS and Linux. Windows has no pkill: there the app goes down in
  // Playwright's own exit handler, which launch registered after this one, so
  // a save landing in between is unlikely but not ruled out. 'exit' listeners
  // run synchronously, and so does all of this; it writes straight to stderr,
  // because a piped stdout may not flush.
  const onExit = () => {
    try {
      execFileSync('pkill', ['-9', '-P', String(process.pid)], { stdio: 'ignore', timeout: 5000 })
    } catch {
      // no children left, or no pkill: nothing to take down
    }
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
