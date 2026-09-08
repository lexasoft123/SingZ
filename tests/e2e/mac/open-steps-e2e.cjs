/*
 * Where a song open spends its seconds on the desktop — the mac twin of
 * `mobile/tests/open-steps-android.cjs`, and written for the same reason: the
 * opening bar is the only thing that says, and reading it off a screen is
 * guesswork. A step that takes half a second and one that takes four
 * milliseconds look identical going past.
 *
 * Prints the FIRST open and a SECOND one, which are different jobs — the
 * second retires a live song and a graph prepared ahead of it.
 *
 *   node tests/e2e/mac/open-steps-e2e.cjs
 *   E2E_SONG="…" E2E_SONG_B="…" node tests/e2e/mac/open-steps-e2e.cjs
 *
 * Prereqs: `npm run build`; two projects in the singer's library.
 */
require('../../shared/watchdog.cjs').arm('open-steps-e2e', { totalMinutes: 20 })

const { join } = require('node:path')
const ROOT = join(__dirname, '..', '..', '..')
const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const A = process.env.E2E_SONG ?? 'Deutschland'
const B = process.env.E2E_SONG_B ?? 'Mein Teil'
const val = (win, e) => win.evaluate(`(${e})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [join(ROOT, 'out', 'main', 'index.js')],
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1', SINGZ_E2E_HOOKS: '1' }
  })
  await quietLaunch(app)
  const win = await app.firstWindow()
  await win.waitForSelector('.lib-card', { timeout: 30000 })
  await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 30000 })

  for (const [label, song] of [[`FIRST open`, A], [`SECOND open (a song is already loaded)`, B]]) {
    const t0 = Date.now()
    await win.click(`.lib-card:has-text("${song}")`)
    // Wait for the load to START before waiting for it to finish: on the
    // second open the previous song already satisfies "ready", so the wait
    // returned instantly and the table came back empty.
    await win.waitForFunction(() => __test?.phase === 'loading', null, { timeout: 30000 })
    await win.waitForFunction(() => __test?.phase === 'ready' && __test?.engine?.duration > 0, null, { timeout: 180000 })
    const ready = Date.now() - t0
    const rows = JSON.parse(await val(win, 'JSON.stringify(__test.loadSteps())'))
    const dur = await val(win, '__test.engine.duration')
    table(`${label} — "${song}" (${dur.toFixed(0)} s)`, rows, `click → phase ready: ${ready} ms`)
    // Let the prepare-ahead settle so the second open pays for retiring it.
    await sleep(6000)
    if (label === 'FIRST open') {
      await win.click('button.play')
      await win.waitForFunction(() => __test?.engine?.playing === true, null, { timeout: 60000 })
      await sleep(2500)
      await val(win, '__test.engine.pause()')
      await val(win, 'void __test.setShowCatalog(true)')
      await win.waitForSelector('.lib-card', { timeout: 30000 })
    }
  }
  await app.close()
})().catch((e) => { console.error(e); process.exit(1) })
