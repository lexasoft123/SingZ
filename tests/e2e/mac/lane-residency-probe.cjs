/*
 * Lane-residency probe (macOS): how much of the renderer's copy of a song
 * actually comes back, and WHEN.
 *
 * `player-session-e2e.cjs` answers "is native heavier than legacy" and samples
 * a couple of seconds after each action. That is the right question for a
 * singer and the wrong instrument for this one, because Chromium has no
 * `AudioBuffer.release()`: dropping the last reference is all the renderer can
 * do, and the pages come back on the collector's schedule, not ours. A row
 * that has not moved two seconds after Play does not tell you whether the
 * reference is gone or merely uncollected — and those need very different
 * fixes.
 *
 * So this probe separates them. It runs the app with `--expose-gc`, reads the
 * RENDERER process alone with `footprint -p`, and samples three times:
 *
 *   1. song open, lanes resident — the cost of holding them
 *   2. native playing, references dropped, NO gc — what a singer sees
 *   3. the same, after a forced collection — whether the bytes are reachable
 *
 * (3) minus (2) is the collector's backlog; the drop from (1) to (3) is what
 * the release is actually worth. If (3) does not move, something still holds a
 * reference and the release is a no-op wearing a green rule.
 *
 * Prereqs: `npm run build`; the capture addon built for this tree
 * (`npm run capture:addon`) — without a native graph there is no release to
 * measure and this says so rather than passing vacuously; no other instance
 * running. Use a LONG six-lane project: a 40-second song's lanes are noise.
 *
 * Env: E2E_SONG (default "Deutschland"), E2E_PROJECTS_ROOT.
 */
require('../../shared/watchdog.cjs').arm('lane-residency-probe', { totalMinutes: 20 })

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { homedir } = require('node:os')

const ROOT =
  process.env.E2E_PROJECTS_ROOT ??
  join(homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
const SONG = process.env.E2E_SONG ?? 'Deutschland'
const SONG_PJ = join(ROOT, SONG, 'project.json')
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')

const val = (win, expr) => win.evaluate(`(${expr})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The renderer child of this app, by its own command line. Electron does not
 *  expose `process.pid` to a sandboxed renderer, so it is asked of the OS. */
function rendererPid(mainPid) {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 3e7 })
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    if (Number(m[2]) !== mainPid) continue
    if (/--type=renderer/.test(m[3])) return Number(m[1])
  }
  return null
}

/** Physical footprint of one process, in MB — the number macOS itself uses,
 *  read off `footprint`'s own header line ("… 64-bit    Footprint: 913 MB"). */
function footprintMb(pid) {
  const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', maxBuffer: 3e7 })
  const m = /Footprint:\s*([\d.]+)\s*([KMG])B/i.exec(out)
  if (!m) throw new Error(`footprint said nothing this could read:\n${out.slice(0, 400)}`)
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  return Math.round(unit === 'G' ? n * 1024 : unit === 'K' ? n / 1024 : n)
}

/** The dirty pages by category, in MB — so a sample that does not move can
 *  say WHICH arena did not move. */
function categoriesMb(pid) {
  const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', maxBuffer: 3e7 })
  const rows = {}
  for (const line of out.split('\n')) {
    const m = /^\s*([\d.]+)\s*([KMG])B\s+\S+\s*\S*\s+\S+\s*\S*\s+\d+\s+(.+?)\s*$/.exec(line)
    if (!m) continue
    const n = Number(m[1])
    const unit = m[2].toUpperCase()
    const mb = unit === 'G' ? n * 1024 : unit === 'K' ? n / 1024 : n
    if (mb >= 5) rows[m[3]] = Math.round(mb)
  }
  return rows
}

/**
 * Wait until the renderer's footprint stops moving, and return it.
 *
 * A fixed sleep is not enough and the first draft of this probe proved it: a
 * saved project can still be re-deriving its melody or beats, and those
 * analyses decode SIX MORE lanes of their own at the file's rate. Sampling
 * over them measures the analysis, not the lanes — the run that taught this
 * showed the audio arena GROWING by one lane's worth across Play.
 */
async function settledFootprint(pid, label, maxMs = 300000) {
  const deadline = Date.now() + maxMs
  let last = footprintMb(pid)
  let stable = 0
  while (Date.now() < deadline) {
    await sleep(4000)
    const now = footprintMb(pid)
    stable = Math.abs(now - last) <= 8 ? stable + 1 : 0
    last = now
    if (stable >= 3) return now
  }
  throw new Error(`${label}: the renderer's footprint never settled (last ${last} MB)`)
}

const diffCategories = (before, after) => {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys
    .map((k) => ({ k, before: before[k] ?? 0, after: after[k] ?? 0 }))
    .filter((r) => Math.abs(r.after - r.before) >= 5 || r.before >= 50 || r.after >= 50)
    .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
}

;(async () => {
  if (!existsSync(SONG_PJ)) throw new Error(`no project at ${SONG_PJ} — set E2E_SONG`)

  const app = await _electron.launch({
    executablePath: require('electron'),
    // `--js-flags` reaches the renderer's V8 too, which is the one that holds
    // the lanes.
    args: [APP, '--js-flags=--expose-gc'],
    env: {
      ...process.env,
      SINGZ_MUTE: '1',
      SINGZ_E2E_HIDDEN: '1',
      SINGZ_NO_SYNC: '1',
      SINGZ_E2E_HOOKS: '1'
    }
  })
  await quietLaunch(app)
  const fail = []
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await win.waitForSelector('.lib-card', { timeout: 20000 })
    await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 20000 })
    if ((await val(win, 'typeof window.gc')) !== 'function') {
      throw new Error('the renderer has no window.gc — --expose-gc did not reach it')
    }

    const mainPid = app.process().pid
    const rpid = rendererPid(mainPid)
    if (!rpid) throw new Error(`could not find the renderer child of pid ${mainPid}`)

    /* The instrument, before the measurement. Chromium has no
       `AudioBuffer.release()`, so this whole probe rests on one assumption:
       that dropping the last reference and forcing a collection returns the
       pages. If that is false, every "the release did nothing" verdict below
       is about the ruler, not the app. So: allocate half a gigabyte of
       AudioBuffer, drop it, collect, and see. */
    const CONTROL_MB = 512
    await val(win, `void (window.__probeHold = (() => {
      const ctx = __test.engine.context
      const n = Math.floor((${CONTROL_MB} * 1024 * 1024) / (2 * 4))
      const b = ctx.createBuffer(2, n, ctx.sampleRate)
      // touched, so the pages are really dirty rather than lazily zero-filled
      const c = b.getChannelData(0)
      for (let i = 0; i < c.length; i += 4096) c[i] = 0.5
      const d = b.getChannelData(1)
      for (let i = 0; i < d.length; i += 4096) d[i] = 0.5
      return b
    })())`)
    await sleep(2000)
    const withControl = footprintMb(rpid)
    await val(win, 'void (window.__probeHold = null)')
    await val(win, 'window.gc()')
    await sleep(2000)
    const withoutControl = footprintMb(rpid)
    console.log(`control: ${CONTROL_MB} MB of AudioBuffer allocated, dropped, collected — ${withControl} → ${withoutControl} MB (${withoutControl - withControl} MB)`)
    if (withControl - withoutControl < CONTROL_MB * 0.5) {
      fail.push(
        `the instrument does not work: dropping ${CONTROL_MB} MB of AudioBuffer and collecting returned only ` +
          `${withControl - withoutControl} MB, so this probe cannot tell a held buffer from an uncollected one`
      )
    }

    await win.click(`.lib-card:has-text("${SONG}")`)
    await win.waitForSelector('.pill.karaoke', { timeout: 120000 })
    await win.waitForFunction(() => __test?.engine?.duration > 0, null, { timeout: 120000 })
    const seconds = await val(win, '__test.engine.duration')
    const lanes = (await val(win, '__test.engine.getTrackStates().map(t => t.id)')).length
    // Let the open settle: the analyses decode stems of their own, and a
    // sample taken over them measures those instead.
    await settledFootprint(rpid, 'after the open')
    await val(win, 'window.gc()')
    await sleep(2000)
    const holding = footprintMb(rpid)
    const holdingCats = categoriesMb(rpid)

    await win.click('button.play')
    // `nativeActive` turns true inside `tryStart`, several statements BEFORE
    // the release — waiting on it and reading residency in the same breath
    // reads the state before the drop and calls a working release broken.
    // Wait for the transport to be audibly running instead.
    await win.waitForFunction(() => __test?.engine?.playing === true, null, { timeout: 60000 })
    await sleep(3000)
    const resident = await val(win, '__test.engine.lanesResident')
    const nativeActive = await val(win, '__test.engine.nativeActive')
    // Where a surviving reference would be: the engine says it let go, so a
    // footprint that does not move means somebody else is holding, and the
    // React lane list is the other place the same objects live.
    const uiHolding = await val(win, '(__test.tracks || []).filter(t => t.buffer).map(t => t.id)')
    // Not the same question as the one above, and the reason this probe
    // exists: a `useCallback` from an earlier render keeps that render's
    // whole context alive, so a lane list with samples in it survives every
    // release. Counted from the engine's side, which is the owner.
    const engineHolding = await val(win, "__test.engine.getTrackStates().map(t => t.id).filter(id => __test.engine.getTrackBuffer(id))")
    const afterPlay = footprintMb(rpid)

    /* What a singer actually gets. Nothing in production calls `gc()`, so the
       pages come back when V8 next decides to collect — and that is a
       different number from "are the bytes reachable". Watched, not assumed. */
    const NATURAL_MS = Number(process.env.PROBE_NATURAL_MS ?? 120000)
    const naturalStart = Date.now()
    let naturalHit = null
    let natural = afterPlay
    while (Date.now() - naturalStart < NATURAL_MS) {
      await sleep(5000)
      natural = footprintMb(rpid)
      if (naturalHit === null && natural < holding - 300) naturalHit = Date.now() - naturalStart
    }
    console.log(
      `  left alone for ${Math.round(NATURAL_MS / 1000)} s   ${natural} MB` +
        (naturalHit === null ? ' — never collected on its own' : ` — collected after ${Math.round(naturalHit / 1000)} s`)
    )

    await val(win, 'window.gc()')
    await sleep(2000)
    const collected = footprintMb(rpid)
    const collectedCats = categoriesMb(rpid)
    await val(win, '__test.engine.pause()')

    console.log(`song "${SONG}" · ${seconds.toFixed(1)} s · ${lanes} lanes · renderer pid ${rpid}`)
    console.log(`  holding the lanes            ${holding} MB`)
    console.log(`  native playing, no gc        ${afterPlay} MB   (${afterPlay - holding >= 0 ? '+' : ''}${afterPlay - holding})`)
    console.log(`  native playing, after gc     ${collected} MB   (${collected - holding >= 0 ? '+' : ''}${collected - holding})`)
    console.log(`  collector's backlog          ${afterPlay - collected} MB`)
    console.log(`  native active / lanes resident  ${nativeActive} / ${resident}`)
    console.log(`  lanes the UI still holds     ${uiHolding.length ? uiHolding.join(', ') : 'none'}`)
    console.log(`  lanes the engine still holds ${engineHolding.length ? engineHolding.join(', ') : 'none'}`)
    console.log('  by category, holding → after the release and a collection:')
    for (const r of diffCategories(holdingCats, collectedCats)) {
      console.log(`    ${r.k.padEnd(28)} ${String(r.before).padStart(5)} → ${String(r.after).padStart(5)} MB  (${r.after - r.before >= 0 ? '+' : ''}${r.after - r.before})`)
    }

    if (nativeActive !== true) fail.push('native playback never took the song — there is no release to measure')
    if (resident !== false) fail.push(`the engine still holds its lanes under native playback (lanesResident=${resident})`)
    // The lanes of a real six-lane song are hundreds of megabytes; anything
    // under 100 means the references did not actually go.
    if (holding - collected < 100) {
      fail.push(`releasing the lanes returned only ${holding - collected} MB — something still holds a reference`)
    }
  } finally {
    await app.close()
  }

  if (fail.length) {
    for (const f of fail) console.error(`FAIL  ${f}`)
    process.exit(1)
  }
  console.log('\nPASS')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
