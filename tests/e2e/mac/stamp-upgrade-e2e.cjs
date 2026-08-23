/*
 * Stored-analysis stamps E2E (macOS): a saved analysis is UPGRADED, never
 * walked backwards. Permanent harness used by the e2e-verifier agent.
 *
 * This guards a measured near-miss, not a hypothetical: the library was
 * re-analysed to beat v23 while the release app on the same machine was
 * v22, and every staleness check compared stamps with `!==` — so opening a
 * song in the older app would have re-derived its own older grid and
 * auto-saved it back, walking the whole library backwards one open at a
 * time. A phone behind a desktop is the same story. `analysisIsStale`
 * (audio/analysis.ts) is the rule; this is the rule running in the app.
 *
 * Two legs against copies of one real project:
 *   from-the-future — every stamp forced ABOVE this build's. The grid, the
 *     melody and the key must be adopted untouched (project.json byte-stable
 *     in those fields, melody src=stored), and the transport's Grid data row
 *     must SAY newer-and-left-alone rather than offering an upgrade — the
 *     copy is half the fix: Re-detect sits in the same popover, and a row
 *     reading "v99 → v23 available" invites the singer to do the downgrade
 *     by hand.
 *   genuinely-old — every stamp forced to v1: must re-derive to this build's
 *     constants, same song, from the core.
 *
 * Env: E2E_SONG (default "Wild World"), E2E_PROJECTS_ROOT, E2E_OUT.
 * Needs a built app (npm run build) and a splitter pack for the beat model;
 * with no pack the future leg still holds (nothing may be rewritten) and the
 * old leg's beat re-derives naked, which is still v23.
 */
const { _electron } = require('playwright-core')
const { readFileSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')
const { homedir, tmpdir } = require('node:os')
const { quietLaunch } = require('./quiet-launch.cjs')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const NAME = process.env.E2E_SONG ?? 'Wild World'
const OUT = process.env.E2E_OUT ?? tmpdir()
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
const FUTURE = 99

const songFile = (dir) => {
  const f = readdirSync(dir).find((n) => /\.(flac|mp3|m4a|wav|ogg|opus)$/i.test(n) && statSync(join(dir, n)).isFile())
  if (!f) throw new Error(`${dir} has no song file`)
  return join(dir, f)
}

/** One leg: seed every stamp to `stampTo`, open, wait, read what landed. */
async function leg(label, stampTo, settleMs) {
  const dir = join(OUT, `singz-e2e-stamp-${label}`)
  rmSync(dir, { recursive: true, force: true })
  cpSync(join(ROOT, NAME), dir, { recursive: true })
  const doc = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
  const s = doc.settings ?? {}
  if (!s.beat) throw new Error(`${NAME} has no stored beat grid — pick a song that does`)
  const before = { bpm: s.beat.bpm, nBeats: s.beat.beats.length, downbeat: s.beat.downbeat }
  // A hand-tuned grid takes a different branch entirely (never re-derived);
  // this leg is about the AUTO rule, so make sure we are testing that one.
  s.beat.source = 'auto'
  for (const k of ['beat', 'melody', 'key']) if (s[k]) s[k].detVersion = stampTo
  writeFileSync(join(dir, 'project.json'), JSON.stringify(doc))

  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1', SINGZ_E2E_HIDDEN: '1' }
  })
  try {
    await quietLaunch(app)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 30000 })
    await win.setInputFiles('input[type=file]', songFile(dir))
    await win.waitForSelector('.pill.karaoke', { timeout: 120000 })
    await new Promise((r) => setTimeout(r, settleMs))
    // the Grid data row lives in the metronome popover
    await win.click('[title^="Metronome"]')
    const row = await win
      .locator('.tp-gridver-val')
      .first()
      .evaluate((el) => ({ text: el.textContent.trim(), cls: el.className, title: el.getAttribute('title') }))
      .catch(() => null)
    const melodySrc = await win.evaluate(() => window.__melody?.src ?? null)
    const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).settings ?? {}
    return { before, after, row, melodySrc, dir }
  } finally {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
}

;(async () => {
  const fail = []
  try {
    if (!existsSync(APP)) throw new Error(`no built app at ${APP} — run npm run build`)
    if (!existsSync(join(ROOT, NAME))) throw new Error(`no project ${NAME} under ${ROOT}`)

    // ---- from the future: nothing may move -------------------------------
    const f = await leg('future', FUTURE, 90000)
    console.log(
      `future : stamps beat v${f.after.beat?.detVersion} melody v${f.after.melody?.detVersion} key v${f.after.key?.detVersion} · ` +
        `bpm ${f.after.beat?.bpm} (was ${f.before.bpm}) · ${f.after.beat?.beats?.length} beats (was ${f.before.nBeats}) · ` +
        `melody src=${f.melodySrc} · row ${JSON.stringify(f.row)}`
    )
    for (const k of ['beat', 'melody', 'key']) {
      if (f.after[k] && f.after[k].detVersion !== FUTURE)
        fail.push(`${k} was DOWNGRADED: v${FUTURE} → v${f.after[k].detVersion}`)
    }
    if (f.after.beat?.bpm !== f.before.bpm || f.after.beat?.beats?.length !== f.before.nBeats)
      fail.push(`the newer grid was rewritten: ${f.before.bpm}/${f.before.nBeats} → ${f.after.beat?.bpm}/${f.after.beat?.beats?.length}`)
    if (f.melodySrc !== 'stored') fail.push(`the newer melody was re-tracked (src=${f.melodySrc}), it must be adopted`)
    if (!f.row) fail.push('the Grid data row never rendered — the copy half of this rule is unverified')
    else {
      if (/available/.test(f.row.text)) fail.push(`the row OFFERS AN UPGRADE for a newer grid: "${f.row.text}"`)
      if (!/newer/i.test(f.row.text)) fail.push(`the row does not say the grid is newer: "${f.row.text}"`)
      if (/\bstale\b/.test(f.row.cls)) fail.push(`the row is painted stale for a newer grid: "${f.row.cls}"`)
      if (!/leaves it alone/i.test(f.row.title ?? '')) fail.push(`the tooltip does not say the grid is left alone: "${f.row.title}"`)
    }

    // ---- genuinely old: must upgrade -------------------------------------
    const o = await leg('old', 1, 45000)
    console.log(
      `old    : stamps beat v${o.after.beat?.detVersion} melody v${o.after.melody?.detVersion} key v${o.after.key?.detVersion} · ` +
        `bpm ${o.after.beat?.bpm} · ${o.after.beat?.beats?.length} beats · melody src=${o.melodySrc} · row ${JSON.stringify(o.row?.text)}`
    )
    if ((o.after.beat?.detVersion ?? 0) <= 1) fail.push(`an OLD grid did not upgrade: still v${o.after.beat?.detVersion}`)
    if ((o.after.melody?.detVersion ?? 0) <= 1) fail.push(`an OLD melody did not upgrade: still v${o.after.melody?.detVersion}`)
    if (o.melodySrc !== 'core') fail.push(`the old melody did not come from the core (src=${o.melodySrc})`)
    if (o.row && /available/.test(o.row.text)) fail.push(`the row still offers an upgrade AFTER upgrading: "${o.row.text}"`)
  } catch (e) {
    fail.push(String(e && e.message ? e.message : e))
  }
  if (fail.length) {
    for (const f of fail) console.error('FAIL', f)
    process.exit(1)
  }
  console.log('PASS — newer analyses are adopted untouched, older ones upgrade, and the row says so')
})()
