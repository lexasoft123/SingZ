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
 *      E2E_OUT (scratch + screenshot dir, default os.tmpdir()),
 *      E2E_CANCEL_AT (warmup | align, default warmup — see the leg below),
 *      E2E_ALIGN_WAIT_S (how long to wait for the aligner, default 900).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('lyrics-cancel-e2e')
const { current: watchdog } = require('../../shared/watchdog.cjs')

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { readFileSync, existsSync, rmSync, readdirSync } = require('node:fs')
const { scratchClone } = require('./project-hold.cjs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')

const PROJECT = process.env.E2E_PROJECT ?? 'Nothing Else Matters'
const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const OUT = process.env.E2E_OUT ?? tmpdir()
const SCRATCH = join(OUT, 'singz-e2e-lyrics-cancel')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
/** The listen is 0-60% of the job's progress; the word aligner is the rest. */
const ALIGN_FROM_PCT = 60
const AT_ALIGN = (process.env.E2E_CANCEL_AT ?? 'warmup') === 'align'
const ALIGN_WAIT_S = (() => {
  const raw = process.env.E2E_ALIGN_WAIT_S
  if (raw === undefined || raw === '') return 900
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`E2E_ALIGN_WAIT_S must be a positive number of seconds, got "${raw}"`)
  return n
})()

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
      /** Which phase the job is in. The listen runs 0-60%, the word aligner
       *  60-100% — so the percent says whether a cancel here can reach the
       *  aligner at all. */
      pct: Number.parseInt(document.querySelector('.lp-pct')?.textContent ?? '', 10),
      stage: document.querySelector('.lp-loading')?.textContent?.split('…')[0]?.trim() ?? null,
      badge: badge ? badge.className : null,
      credit: credit?.getAttribute('title') ?? credit?.textContent ?? null,
      lines: [...document.querySelectorAll('.lyr-line')].map((el) => el.textContent)
    }
  })

/**
 * A screenshot is evidence, never a gate. On a weak iGPU the emptied panel
 * can take longer to paint than playwright's default, and a throw here lands
 * BEFORE the run prints what it found — which is how a red once arrived as a
 * TimeoutError with no verdict line at all.
 */
const shot = async (win, name) => {
  try {
    await win.screenshot({ path: join(OUT, name), timeout: 15000 })
  } catch (err) {
    console.log(`(screenshot ${name} did not paint in time: ${err?.message ?? err})`)
  }
}

;(async () => {
  if (!existsSync(join(ROOT, PROJECT))) throw new Error(`no such project: ${join(ROOT, PROJECT)}`)
  if (!existsSync(join(ROOT, PROJECT, 'lyrics.json')))
    throw new Error(`${PROJECT} has no cached lyrics.json — the panel must open with words already on it`)

  // A clone that keeps every time, because the listen cache is keyed on the
  // vocals' size AND mtime: a copy with fresh mtimes always re-listens from
  // cold, which silently pins this driver's Cancel to the warm-up phase and
  // makes the align-warning check below structurally unable to fire. It
  // follows links too, so nothing written into it can reach the library.
  scratchClone(join(ROOT, PROJECT), SCRATCH)

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
    await shot(win, 'lyrics-cancel-before.png')

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
    // Where to cancel. The reported bug is a singer changing their mind, which
    // is usually seconds in — so the default stops the job wherever it has got
    // to, and the run finishes in under a minute. The WORD ALIGNER, though,
    // lives past 60%, and the two warnings this also guards are only emitted
    // there: reaching it means sitting through the whole listen (6 min cold
    // on a field laptop, seconds when the listen cache hits). E2E_CANCEL_AT=
    // align opts into that and makes the log check below load-bearing.
    // The last percent the job was SEEN at. `.lp-pct` is inside the loading
    // block, so it is unmounted by the very transition the messages below
    // report — read after the fact it is always NaN, which is exactly the
    // number a reader would be trying to use.
    let seenPct = null
    if (AT_ALIGN) {
      console.log('E2E_CANCEL_AT=align — waiting for the word aligner (past 60%) before cancelling')
      const reached = await watchdog().run('the job reaches the word aligner', ALIGN_WAIT_S, async () => {
        const deadline = Date.now() + ALIGN_WAIT_S * 1000
        let said = 0
        while (Date.now() < deadline) {
          const p = await readPanel(win)
          if (Number.isFinite(p.pct)) seenPct = p.pct
          if (!p.loading) return false // it answered before the aligner was reached
          if (Number.isFinite(p.pct) && p.pct >= ALIGN_FROM_PCT) return true
          // The watchdog takes progress from this driver's own output, and its
          // blanket idle deadline is SHORTER than this step's budget — a silent
          // poll through a cold listen would be killed as a hang, past the
          // finally that removes the scratch copy.
          if (Date.now() - said > 30000) {
            said = Date.now()
            console.log(`  still listening: ${p.stage} ${Number.isFinite(p.pct) ? `${p.pct}%` : ''}`)
          }
          await new Promise((r) => setTimeout(r, 500))
        }
        throw new Error(`still at the listen after ${ALIGN_WAIT_S}s — raise E2E_ALIGN_WAIT_S`)
      })
      if (!reached) {
        // Not a product failure: the trap was never set. Same verdict as the
        // settle guard below, which is the same situation one window later.
        const now = await readPanel(win)
        inconclusive =
          `the job answered at ${seenPct ?? '?'}%, before the word aligner — nothing was cancelled ` +
          `inside it. The panel says: ${JSON.stringify(now.state ?? now.badge)}.`
        throw new Error('INCONCLUSIVE')
      }
      await new Promise((r) => setTimeout(r, 4000)) // well inside a chunk, not on its seam
    }

    const during = await readPanel(win)
    console.log(
      `during: loading=${during.loading}, ${during.lines.length} lines on screen, ` +
        `stage "${during.stage}" ${Number.isFinite(during.pct) ? `${during.pct}%` : seenPct !== null ? `${seenPct}% (last seen)` : '(no percent yet)'}`
    )
    await shot(win, 'lyrics-cancel-during.png')
    if (!during.loading) {
      // 60% is the LISTEN's own terminal report, published before the words
      // are judged — a mismatch verdict answers the job during the settle.
      inconclusive =
        `the job answered at ${seenPct ?? '?'}% during the settle, so there was no ` +
        `longer a Cancel to press. The panel says: ${JSON.stringify(during.state)}.`
      throw new Error('INCONCLUSIVE')
    }

    await win.click(cancel)
    // The panel has to come back on its own. Nothing here reopens the song —
    // a reopen is exactly what the singer had to do, and what this forbids.
    await watchdog().run('the panel comes back after Cancel', 60, () =>
      win.waitForFunction(() => !document.querySelector('.lp-loading'), null, { timeout: 60000 })
    )
    await new Promise((r) => setTimeout(r, 1500)) // a late write would land in this window
    const after = await readPanel(win)
    console.log(`after:  ${after.lines.length} lines, badge "${after.badge}", credit ${after.credit}`)
    await shot(win, 'lyrics-cancel-after.png')

    if (!after.ready) fail.push(`the panel is not showing lyrics after Cancel (${after.lines.length} lines)`)
    else {
      if (after.lines.length !== before.lines.length)
        fail.push(`line count changed across the cancel: ${before.lines.length} -> ${after.lines.length}`)
      else if (after.lines.join('\n') !== before.lines.join('\n'))
        fail.push('the lines came back with different words')
      if (after.badge !== before.badge) fail.push(`source badge changed: "${before.badge}" -> "${after.badge}"`)
      if (after.credit !== before.credit) fail.push(`credit changed: ${before.credit} -> ${after.credit}`)
    }

    // A cancellation must read in the log as a cancellation. We kill the word
    // aligner by signal, so its non-zero exit used to be logged as a failure
    // and its chunk then reported the words it had not placed — a run that
    // stopped cleanly reading as a broken one, twice.
    //
    // This can only fire if the cancel actually reached the aligner, so the
    // run says which it was rather than letting a vacuous silence read as
    // coverage. A zero here from a warm-up cancel means nothing at all.
    const reached = Number.isFinite(during.pct) && during.pct >= ALIGN_FROM_PCT
    const { warns, stopped } = await win.evaluate(async () => {
      const all = (await window.singz.getLog()).filter((e) => e.source === 'lyrics')
      return {
        warns: all.filter((e) => e.level === 'warn' && /align:/.test(e.line)).map((e) => e.line),
        // The line alignChunk logs when it finds its child killed by us: the
        // proof that an aligner was actually running and actually stopped.
        stopped: all.some((e) => /align: the word aligner stopped \(cancelled\)/.test(e.line))
      }
    })
    // On the align leg a silent log is only evidence if something was there
    // to be noisy. A cancel that landed on a chunk seam killed no child, so
    // it proves nothing — say so rather than bank it.
    if (AT_ALIGN && !stopped && !warns.length && fail.length === 0) {
      inconclusive =
        `the cancel landed at ${during.pct}% but no aligner child was killed (no "stopped (cancelled)" ` +
        `line), so it fell between chunks and the align-warning check proves nothing. Re-run.`
      throw new Error('INCONCLUSIVE')
    }
    if (warns.length) {
      console.log('align warnings during the cancelled run:')
      for (const w of warns) console.log(`  ${w}`)
      fail.push(`${warns.length} align warning(s) logged for a cancelled run`)
    } else if (reached) {
      console.log(
        `no align warnings logged for a cancel taken at ${during.pct}% — inside the word aligner` +
          (stopped ? ', which logged that it stopped (cancelled)' : '')
      )
    } else {
      console.log(
        `align-warning check COVERS NOTHING this run: the cancel landed at ` +
          `${Number.isFinite(during.pct) ? `${during.pct}%` : 'the warm-up'}, before the word aligner. ` +
          `Run with E2E_CANCEL_AT=align to exercise it.`
      )
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
