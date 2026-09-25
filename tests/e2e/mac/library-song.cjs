/*
 * Open a library song by its EXACT name, and prove which project opened.
 *
 * The drivers that open a song from a library used to click
 * `.lib-card:has-text(name)`, which is a SUBSTRING match: "Player Session E2E"
 * is contained in "Player Session E2E second". With a fresh copy of that
 * library the click took the 81.6 s second song, while the driver backed up
 * and restored the OTHER song's project.json and measured the wrong song.
 * player-session-e2e already matched exactly; this is that rule for every
 * driver, plus the check it never had: the project that actually opened is
 * the one whose files the driver is holding.
 *
 * The check can only run once the song has loaded, and by then the open has
 * already saved into the project: one with analyses missing gets its melody
 * line, the lanes' waveforms and a lyricsHash written straight away, and a
 * transcription's lyrics.json is re-stamped by LRCLIB's re-ask. A copy taken
 * at the check holds all of that, so the driver's `finally` had nothing left
 * to undo (seen forcing space-focus onto the wrong card). So the click also
 * copies those two files of every project the library lists, just before it
 * lands, and a mismatch hands the driver the copies of the project that
 * opened.
 *
 * A helper, not a driver: it runs inside the driver that required it, under
 * that driver's watchdog.
 */
const { existsSync, readFileSync, realpathSync, statSync } = require('node:fs')
const { basename, dirname, join } = require('node:path')

/** The name the library shows for the project in `dir`: the doc's own name,
 *  else the folder's (src/main/projects.ts, `meta.name ?? entry.name`). */
function libraryName(dir) {
  const doc = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  return typeof doc.name === 'string' && doc.name ? doc.name : basename(dir)
}

const canonical = (path) => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** The files an open writes into its project by itself. Only these two:
 *  every listed project is read before every click, and a song file can be
 *  tens of megabytes. The doc comes first, so a lyricsHash is never read
 *  after the lyrics it describes. */
const OPEN_WRITES = ['project.json', 'lyrics.json']

/** Per window: every listed project's OPEN_WRITES as they were just before its
 *  latest click (canonical folder → file → readFile's answer). Whatever name
 *  that click asked for — a driver handing the pick the wrong name is one of
 *  the ways the wrong song opens. */
const beforeClick = new WeakMap()

/** A file as it is now, `{ text, stat }` with a bigint stat for restores that
 *  put times back; null when it does not exist, undefined when unreadable. */
function readFile(path) {
  try {
    // Read, then stat: a write landing in between pairs the older text with the
    // newer time. The size+mtime memo that goes back beside it — lyricsHash, in
    // a project.json read earlier still — can then only miss and force a
    // rehash; the other order could leave it vouching for bytes it never saw.
    const text = readFileSync(path, 'utf8')
    return { text, stat: statSync(path, { bigint: true }) }
  } catch (e) {
    return e?.code === 'ENOENT' ? null : undefined
  }
}

/** OPEN_WRITES of every project the library lists, as they are now. The
 *  listing is the library's own (src/main/projects.ts), so it covers every card
 *  the click could land on, and it needs no __test hooks. */
async function libraryFiles(win) {
  const { projects } = await win.evaluate(() => window.singz.listProjects())
  return new Map(
    projects.map(({ dir }) => [canonical(dir), new Map(OPEN_WRITES.map((file) => [file, readFile(join(dir, file))]))])
  )
}

/** Click the ONE library card named exactly `name`. A name no card carries,
 *  or one that several projects share, throws: either way the click could not
 *  say which project it meant. Resolves to the moment the click was sent
 *  (Date.now()), for a driver that times the open — the copies taken before
 *  it are this helper's cost, not the app's. */
async function clickLibrarySong(win, name) {
  // The exact form player-session-e2e uses, quoted so a name with a quote in
  // it stays one selector.
  const cards = win.locator('.lib-card').filter({ has: win.locator(`text=${JSON.stringify(name)}`) })
  const count = await cards.count()
  if (count !== 1) {
    throw new Error(count === 0
      ? `no library card is named exactly "${name}"`
      : `${count} library cards are named exactly "${name}" — the name does not pick one project`)
  }
  // As late as it can be taken: whichever project this click opens, these are
  // its files before the open could save anything into them.
  beforeClick.set(win, await libraryFiles(win))
  const clickedAt = Date.now()
  await cards.click()
  return clickedAt
}

/** The project folder the app actually opened, read off the engine's lanes: a
 *  split project's lanes live in `<project>/stems/`, an unsplit one plays its
 *  song file from `<project>/` itself. Null unless every lane with a file
 *  agrees on one folder. */
async function openedProjectDir(win) {
  const paths = await win.evaluate(() =>
    (__test.engine.tracks || []).map((t) => t.path).filter((p) => typeof p === 'string' && p))
  const folderOf = (p) => (basename(dirname(p)) === 'stems' ? dirname(dirname(p)) : dirname(p))
  const dirs = [...new Set(paths.map((p) => canonical(folderOf(p))))]
  return dirs.length === 1 ? dirs[0] : null
}

const parses = (text) => {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Put the opened project's OPEN_WRITES into `backups` as they were before the
 *  click that opened it; returns what could not be put back that way. */
function holdOpened(win, opened, backups) {
  const notes = []
  const before = beforeClick.get(win)?.get(opened)
  for (const file of OPEN_WRITES) {
    const path = join(opened, file)
    // The driver's own copy was taken earlier still.
    if (backups.some(([held]) => canonical(held) === canonical(path))) continue
    const was = before?.get(file)
    if (was === null) {
      // A driver deletes nothing from a library.
      if (existsSync(path)) notes.push(`${path} did not exist before the click; left in place`)
      continue
    }
    // Nothing that does not parse is ever written back: lyrics are written in
    // place, so a read can catch them half-done. Without a whole copy from
    // before the click, the file as it is now still keeps later saves out,
    // just not the ones the open made.
    let copy = was && parses(was.text) ? was : null
    const asFound = !copy
    if (!copy) {
      const now = readFile(path)
      if (now === undefined) notes.push(`${path} could not be read, so nothing will put it back`)
      else if (now && !parses(now.text)) notes.push(`${path} was caught mid-write, so nothing will put it back`)
      if (!now || !parses(now.text)) continue
      copy = now
    }
    // Opening a v1 project converts its stems to FLAC (the upgrade at ready,
    // and every save), so a v1 doc written back over them names stems that are
    // gone — the song-switch drivers refuse a v1 song of their own for this.
    if (file === 'project.json' && (JSON.parse(copy.text)?.version ?? 1) < 2) {
      notes.push(`${path} is a v1 project, which opening converts to FLAC, so it is left as the app writes it`)
      continue
    }
    backups.push([path, copy.text, copy.stat])
    if (asFound) notes.push(`no copy of ${path} from before the click, so it goes back as found now, with what the open saved`)
  }
  return notes
}

/**
 * Throw unless the app opened the project in `dir`, BEFORE the driver
 * measures anything. On a mismatch the project that did open has already been
 * saved into, and may be again from here on, so its project.json and
 * lyrics.json join `backups` (the driver's `[[path, text]]` list, restored in
 * its `finally`) as they were before the click that opened it — never a v1
 * project's doc, which the open's upgrade makes untrue. Each entry carries that
 * file's bigint stat as a third element, which a `[path, text]` loop simply
 * ignores. What could not be held that way is said in the error.
 */
async function assertOpenedProject(win, { dir, name, backups }) {
  const opened = await openedProjectDir(win)
  if (opened !== null && opened === canonical(dir)) return
  const notes = opened !== null && backups ? holdOpened(win, opened, backups) : []
  throw new Error(
    `asked for "${name}" in ${canonical(dir)}, but the app opened ` +
      `${opened ?? 'no single project with lane files'} — refusing to measure the wrong song` +
      notes.map((note) => `; ${note}`).join('')
  )
}

module.exports = { assertOpenedProject, clickLibrarySong, libraryName, openedProjectDir }
