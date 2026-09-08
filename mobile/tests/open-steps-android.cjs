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
function table(title, rows, marks) {
  console.log(`\n${title}`)
  if (!rows.length) return console.log('  (no steps reported)')
  // Collapse the creep ticks, and credit each step with the time IT ran —
  // the span until the next step starts. Crediting a row with the time since
  // the previous one names the wrong step, which is how "Starting playback"
  // was first reported as the longest part of a desktop open when the 420 ms
  // belonged to drawing the waveforms before it.
  const groups = []
  for (const r of rows) {
    const last = groups[groups.length - 1]
    if (last && last.msg === r.msg) { last.frac = r.frac; continue }
    groups.push({ msg: r.msg, ms: r.ms, frac: r.frac })
  }
  const total = rows[rows.length - 1].ms
  console.log('  ' + 'starts'.padStart(8) + '  ' + 'runs for'.padStart(9) + '  ' + 'bar'.padStart(5) + '  step')
  console.log('  ' + '-'.repeat(8) + '  ' + '-'.repeat(9) + '  ' + '-'.repeat(5) + '  ' + '-'.repeat(34))
  const withRun = groups.map((g, i) => ({ ...g, ran: (i + 1 < groups.length ? groups[i + 1].ms : total) - g.ms }))
  for (const g of withRun) {
    console.log('  ' + `${g.ms} ms`.padStart(8) + '  ' + `${g.ran} ms`.padStart(9) + '  ' +
      `${Math.round(g.frac * 100)}%`.padStart(5) + '  ' + g.msg)
  }
  const slow = withRun.reduce((a, g) => (g.ran > a.ran ? g : a), { ran: -1, msg: '' })
  console.log(`  total ${total} ms · longest "${slow.msg}" ${slow.ran} ms (${Math.round((slow.ran / Math.max(1, total)) * 100)}%)`)
  if (marks) console.log(`  ${marks}`)
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
    table(
      `${o.label} — "${o.song.name}" (${o.song.seconds.toFixed(0)} s)`,
      o.rows,
      `the screen's own marks: player ${o.marks.player} ms · ready ${o.marks.ready} ms`
    )
  }
  await dev.detach()
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
