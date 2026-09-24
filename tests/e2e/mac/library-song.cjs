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
 * A helper, not a driver: it runs inside the driver that required it, under
 * that driver's watchdog.
 */
const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { basename, dirname, join } = require('node:path')

/** The name the library shows for the project in `dir`: the doc's own name,
 *  else the folder's (src/main/projects.ts, `meta.name ?? entry.name`). */
function libraryName(dir) {
  const doc = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  return typeof doc.name === 'string' && doc.name ? doc.name : basename(dir)
}

/** Click the ONE library card named exactly `name`. A name no card carries,
 *  or one that several projects share, throws: either way the click could not
 *  say which project it meant. */
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
  await cards.click()
}

const canonical = (path) => {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
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

/**
 * Throw unless the app opened the project in `dir`, BEFORE the driver
 * measures anything. On a mismatch the project that did open is the one the
 * app may save into from here on, so its project.json joins `backups` (the
 * driver's `[[path, text]]` list, restored in its `finally`) before the throw.
 */
async function assertOpenedProject(win, { dir, name, backups }) {
  const opened = await openedProjectDir(win)
  if (opened !== null && opened === canonical(dir)) return
  if (opened !== null && backups) {
    const pj = join(opened, 'project.json')
    if (existsSync(pj) && !backups.some(([path]) => canonical(path) === canonical(pj))) {
      backups.push([pj, readFileSync(pj, 'utf8')])
    }
  }
  throw new Error(
    `asked for "${name}" in ${canonical(dir)}, but the app opened ` +
      `${opened ?? 'no single project with lane files'} — refusing to measure the wrong song`
  )
}

module.exports = { assertOpenedProject, clickLibrarySong, libraryName, openedProjectDir }
