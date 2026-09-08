/*
 * Where a song open actually spends its seconds, step by step.
 *
 * The opening bar is the only thing that says, and reading it off a screen is
 * guesswork: a step that takes four seconds and one that takes forty
 * milliseconds look identical going past. `TEST.loadSteps()` hands back every
 * step the loader reported with the millisecond it landed, so this prints them
 * as a table — for the FIRST open of a song and for a SECOND one, which are
 * different jobs (the second retires a live graph before it can build its own).
 *
 *   node mobile/tests/open-steps-android.cjs
 *   node mobile/tests/open-steps-android.cjs --backend legacy
 *
 * Preconditions are the session suite's: Metro from this worktree, this tree's
 * debuggable APK installed, ffmpeg on PATH.
 */
require('../../tests/shared/watchdog.cjs').arm('open-steps', { totalMinutes: 30 })

const path = require('path')
const { stageSongs } = require('./player-session/seed.cjs')
const { createDevice } = require('./player-session/android.cjs')

const MOBILE_ROOT = path.resolve(__dirname, '..')
const PORT = process.env.METRO_PORT || '8081'
const argv = process.argv.slice(2)
const argOf = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const BACKEND = argOf('backend', 'native')
const log = (l) => console.log(l)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** One open's steps, as a table with per-step deltas. */
function table(title, rows) {
  log(`\n${title}`)
  if (!rows.length) return log('  (no steps reported)')
  log('  ' + 'at'.padStart(7) + '  ' + 'took'.padStart(7) + '  ' + 'bar'.padStart(5) + '  step')
  log('  ' + '-'.repeat(7) + '  ' + '-'.repeat(7) + '  ' + '-'.repeat(5) + '  ' + '-'.repeat(40))
  let prev = 0
  for (const r of rows) {
    const took = r.ms - prev
    prev = r.ms
    log(
      '  ' + `${r.ms} ms`.padStart(7) + '  ' + `${took} ms`.padStart(7) + '  ' +
        `${Math.round(r.frac * 100)}%`.padStart(5) + '  ' + r.msg
    )
  }
  const total = rows[rows.length - 1].ms
  const slowest = rows.reduce((a, r, i) => {
    const took = r.ms - (i ? rows[i - 1].ms : 0)
    return took > a.took ? { took, msg: r.msg } : a
  }, { took: 0, msg: '' })
  log(`  total ${total} ms · longest single step "${slowest.msg}" ${slowest.took} ms ` +
    `(${Math.round((slowest.took / Math.max(1, total)) * 100)}% of the open)`)
}

;(async () => {
  const songs = stageSongs(MOBILE_ROOT)
  const dev = createDevice({ port: PORT, log, mobileRoot: MOBILE_ROOT })
  dev.preflight()
  dev.seed(songs)

  const launched = await dev.launch()
  await dev.awaitBoot(launched.t0)
  await dev.attach()
  await dev.installHooks()
  await dev.val(`__ps.setNative(${BACKEND === 'native' ? 'true' : 'false'}).then(() => 1)`)
  await dev.ev("void __test.selectMode('phone')")
  for (let i = 0; i < 30; i++) {
    if ((await dev.val(`(__test.projects || []).includes(${JSON.stringify(songs[0].name)})`)) === true) break
    await dev.ev('void __test.refresh()')
    await sleep(500)
  }

  const opened = []
  for (const [label, song] of [['FIRST open', songs[0]], ['SECOND open (a graph is already live)', songs[1]]]) {
    if (opened.length) {
      await dev.ev('void __test.back()')
      await sleep(2000)
    }
    const open = await dev.openProject(song.name)
    const rows = JSON.parse(await dev.val('JSON.stringify(__test.loadSteps())'))
    opened.push({ label, song, rows, marks: open.marks })
  }

  log(`\nbackend: ${BACKEND} · ${opened[0].marks.kind}`)
  for (const o of opened) {
    table(`${o.label} — "${o.song.name}" (${o.song.seconds.toFixed(0)} s)`, o.rows)
    log(`  the screen's own marks: player ${o.marks.player} ms · ready ${o.marks.ready} ms`)
  }
  await dev.detach()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
