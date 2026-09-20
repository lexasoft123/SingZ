/*
 * Cancel-keeps-the-lyrics E2E (macOS): a song is showing its lyrics, the
 * singer starts "Check & align" over them and changes their mind. The panel
 * must be exactly what it was — same words, same source, same credit — not
 * empty until the song is reopened.
 *
 * Why this needed a driver of its own. lyrics.json is never touched by a
 * cancel, so on disk nothing is wrong and no unit test of the cache can see
 * it: the loss is entirely in the renderer's panel state, which went to
 * `idle` because a cancellation was being handled as though it were a
 * verdict on the lyrics. The singer's report was "36 lines became 0". The
 * state machine itself is pinned by tests/unit/lyrics-state.test.ts; this
 * driver is the proof that the real app's Cancel button reaches it — through
 * main, through a real align request, and back.
 *
 * It refuses rather than passes when it cannot set the trap: with the speech
 * model absent, main answers `needsModel` in milliseconds and the panel flips
 * to the consent prompt before a Cancel button ever exists, so a green run
 * would mean nothing. That exits 2 (INCONCLUSIVE), the waveform-streamed
 * precedent, never 0.
 *
 * The singer's library is never touched: the song is a scratch COPY opened
 * from outside the library through the hidden file input (the drag-drop code
 * path), so a cancel that writes anything writes it to the copy.
 *
 * Prereqs: `npm run build` done; the Qwen3-ASR speech model installed under
 * ~/Library/Application Support/SingZ/; a project with cached lyrics.json;
 * no other app instance running (same userData identity).
 *
 * Env: E2E_PROJECT (default "Nothing Else Matters"),
 *      E2E_PROJECTS_ROOT (default iCloud Drive/SingZ),
 *      E2E_OUT (scratch + screenshot dir, default os.tmpdir()).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('lyrics-cancel-e2e')
const { current: watchdog } = require('../../shared/watchdog.cjs')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { readFileSync, existsSync, cpSync, rmSync, readdirSync } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const PROJECT = process.env.E2E_PROJECT ?? 'Nothing Else Matters'
const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const OUT = process.env.E2E_OUT ?? tmpdir()
const SCRATCH = join(OUT, 'singz-e2e-lyrics-cancel')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')

/**
 * Everything the panel is saying about its lyrics right now. The line TEXTS,
 * not merely how many: a panel that re-derived its words would restore a
 * different 36 lines and pass a count check.
 */
const readPanel = (win) =>
  win.evaluate(() => {
    const badge = document.querySelector('.lp-source .src-badge')
    const credit = document.querySelector('.lp-source .src-credit')
    return {
      ready: Boolean(document.querySelector('.lp-source')),
      loading: Boolean(document.querySelector('.lp-loading')),
      /** Whatever the panel is saying in place of lyrics — a consent offer, a
       *  missing engine, a failure — so a refusal can quote it. */
      state: document.querySelector('.lp-state')?.textContent?.trim().slice(0, 200) ?? null,
      badge: badge ? badge.className : null,
      credit: credit?.getAttribute('title') ?? credit?.textContent ?? null,
      lines: [...document.querySelectorAll('.lyr-line')].map((el) => el.textContent)
    }
  })

;(async () => {
  if (!existsSync(join(ROOT, PROJECT))) throw new Error(`no such project: ${join(ROOT, PROJECT)}`)
  if (!existsSync(join(ROOT, PROJECT, 'lyrics.json')))
    throw new Error(`${PROJECT} has no cached lyrics.json — the panel must open with words already on it`)

  if (existsSync(SCRATCH)) rmSync(SCRATCH, { recursive: true })
  cpSync(join(ROOT, PROJECT), SCRATCH, { recursive: true })

  const fail = []
  let inconclusive = null
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1' } // silent, hidden, never the real Drive
  })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
  app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })

    // The trap only exists while the align request takes long enough to
    // cancel. Ask before opening anything, so a missing model costs seconds
    // rather than a misleading green.
    const speech = await win.evaluate(async () => {
      const models = await window.singz.modelsStatus()
      return models.find((m) => m.id === 'qwen-asr') ?? null
    })
    if (!speech || !speech.present) {
      inconclusive =
        'the Qwen3-ASR speech model is not installed — "Check & align" answers needsModel at once, ' +
        'so the panel reaches the consent prompt without ever offering a Cancel button. ' +
        'Install it from the app (Settings ▸ models) and re-run.'
      throw new Error('INCONCLUSIVE')
    }

    // Opened from outside the library, the same code path as drag-drop — so
    // nothing this run does can reach the singer's own copy of the song.
    const srcName = readdirSync(SCRATCH).find((f) => /^song\.(mp3|flac|wav|m4a|ogg|opus)$/i.test(f))
    if (!srcName) throw new Error(`no song.* file in ${SCRATCH}`)
    await watchdog().run('open the scratch song', 120, async () => {
      await win.setInputFiles('input[type=file]', join(SCRATCH, srcName))
      await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
    })
    const kOn = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'))
    if (!kOn) await win.click('.pill.karaoke')
    await win.waitForSelector('.lp-source', { timeout: 60000 })
    await win.waitForSelector('.lyr-line', { timeout: 60000 })

    const before = await readPanel(win)
    console.log(`before: ${before.lines.length} lines, badge "${before.badge}", credit ${before.credit}`)
    if (before.lines.length === 0) throw new Error('the panel opened with no lines — nothing to lose')
    await win.screenshot({ path: join(OUT, 'lyrics-cancel-before.png') })

    // Start the job the singer's report names, and stop it the way they did.
    await win.click('.lp-source .linkish:has-text("Check & align")')
    const cancel = '.lp-state button:has-text("Cancel")'
    try {
      await win.waitForSelector(cancel, { timeout: 30000 })
    } catch {
      // Say what the panel said, rather than guessing which of the several
      // fast answers it was: a missing engine, a consent prompt and an align
      // that simply finished all look the same from here, and a driver that
      // names the wrong one sends the reader to the wrong place.
      const now = await readPanel(win)
      inconclusive =
        `no Cancel button ever appeared — the align request answered at once. The panel says: ` +
        `${JSON.stringify(now.state)}. ` +
        (now.ready ? 'Nothing was cancelled.' : 'Fix that first: there is no job here to cancel.')
      throw new Error('INCONCLUSIVE')
    }
    const during = await readPanel(win)
    console.log(`during: loading=${during.loading}, ${during.lines.length} lines on screen`)
    await win.screenshot({ path: join(OUT, 'lyrics-cancel-during.png') })

    await win.click(cancel)
    // The panel has to come back on its own. Nothing here reopens the song —
    // a reopen is exactly what the singer had to do, and what this forbids.
    await watchdog().run('the panel comes back after Cancel', 60, () =>
      win.waitForFunction(() => !document.querySelector('.lp-loading'), null, { timeout: 60000 })
    )
    await new Promise((r) => setTimeout(r, 1500)) // a late write would land in this window
    const after = await readPanel(win)
    console.log(`after:  ${after.lines.length} lines, badge "${after.badge}", credit ${after.credit}`)
    await win.screenshot({ path: join(OUT, 'lyrics-cancel-after.png') })

    if (!after.ready) fail.push(`the panel is not showing lyrics after Cancel (${after.lines.length} lines)`)
    else {
      if (after.lines.length !== before.lines.length)
        fail.push(`line count changed across the cancel: ${before.lines.length} -> ${after.lines.length}`)
      else if (after.lines.join('\n') !== before.lines.join('\n'))
        fail.push('the lines came back with different words')
      if (after.badge !== before.badge) fail.push(`source badge changed: "${before.badge}" -> "${after.badge}"`)
      if (after.credit !== before.credit) fail.push(`credit changed: ${before.credit} -> ${after.credit}`)
    }

    // A cancellation must read in the log as a cancellation. The aligner is
    // killed by signal and its chunk then places no words, and both used to
    // be logged as warnings — a run that stopped cleanly looking like a
    // broken one. (Silent unless the cancel landed after the aligner had
    // started; a fast cancel never reaches it, which is why this reports
    // what it found rather than asserting a line is present.)
    const warns = await win.evaluate(async () => {
      const all = await window.singz.getLog()
      return all
        .filter((e) => e.source === 'lyrics' && e.level === 'warn' && /align:/.test(e.line))
        .map((e) => e.line)
    })
    if (warns.length) {
      console.log('align warnings during the cancelled run:')
      for (const w of warns) console.log(`  ${w}`)
      fail.push(`${warns.length} align warning(s) logged for a cancelled run`)
    } else {
      console.log('no align warnings logged for the cancelled run')
    }
  } catch (err) {
    if (err?.message !== 'INCONCLUSIVE') throw err
  } finally {
    await app.close().catch(() => {})
    rmSync(SCRATCH, { recursive: true, force: true })
  }

  if (inconclusive) {
    console.log('INCONCLUSIVE:', inconclusive)
    process.exit(2)
  }
  if (fail.length) {
    console.log('FAIL:', fail.join('; '))
    process.exit(1)
  }
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
