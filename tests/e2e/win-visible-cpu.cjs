/*
 * What a Windows singer actually pays while WATCHING the player.
 *
 * `player-session-e2e.cjs` runs the window hidden (`SINGZ_E2E_HIDDEN`) so a
 * measurement session never surfaces over somebody's work — and on Windows a
 * hidden window composites little or nothing, so every CPU number that harness
 * reports there is the app's NON-PAINT cost. On the field laptop that came out
 * at 1.9% native against 2.5% legacy while playing, which is a real result and
 * not the singer's: this machine's history is three Windows-only fixes in
 * `styles.css` worth 15-20 points of an HD 4600 EACH, all of them paint.
 *
 * So this one shows the window. It must run in the interactive desktop session
 * (`schtasks /it`) — over plain SSH a GUI process lands in session 0, where
 * there is no desktop to composite to and the answer would be the hidden one
 * again wearing a different name.
 *
 * Two guards, because a visible window is not automatically a painting one:
 *   - the frame rate is counted, and a run under 30 fps is REFUSED rather than
 *     reported (Chromium throttles an occluded or minimized window to ~1 Hz);
 *   - `document.visibilityState` must read 'visible'.
 *
 * Samples idle-in-player and playing, per backend, at the whole-song view —
 * a project reopens at the view it was saved in, and a deep zoom makes the
 * playhead cross a device pixel every frame, which is 2.5x the whole app's
 * CPU on the mac and is not what a fresh open looks like.
 *
 *   PS_LIB=<dir> node tests/e2e/win-visible-cpu.cjs
 *
 * Env: PS_LIB (a staged library, required on a machine without ffmpeg),
 *      E2E_OUT, WINDOW_SEC (default 5).
 */
require('../shared/watchdog.cjs').arm('win-visible-cpu', { totalMinutes: 40 })

const { _electron } = require('playwright-core')
const { execFileSync } = require('node:child_process')
const { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { tmpdir } = require('node:os')

const OUT = process.env.E2E_OUT ?? tmpdir()
const APP = join(__dirname, '..', '..', 'out', 'main', 'index.js')
const PROFILE = join(OUT, 'win-visible-cpu-userdata')
const LIB = process.env.PS_LIB ? resolve(process.env.PS_LIB) : null
const SAMPLER = join(__dirname, '..', 'shared', 'win-process-sample.ps1')
const WINDOW_SEC = Number(process.env.WINDOW_SEC ?? 5)
const KEY = 'singz.desktop.native-playback'

const log = (l) => console.log(l)
const val = (win, e) => win.evaluate(`(${e})`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sample(rootPid) {
  const text = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SAMPLER, '-RootPid', String(rootPid), '-WindowSec', String(WINDOW_SEC)],
    { encoding: 'utf8', windowsHide: true }
  )
  return JSON.parse(text.trim().split('\n').pop())
}

/** Frames actually delivered over a second — the run's licence to be read.
 *  Cancels a previous counter first: the first version started a NEW rAF loop
 *  on every call and left the old one running, so the second reading came back
 *  at exactly twice the frame rate (61, then 122). */
async function fps(win) {
  await val(win, `void (() => {
    if (window.__fRaf) cancelAnimationFrame(window.__fRaf)
    window.__f = 0
    const t = () => { window.__f++; window.__fRaf = requestAnimationFrame(t) }
    window.__fRaf = requestAnimationFrame(t)
  })()`)
  await sleep(2000)
  return Math.round((await val(win, '__f')) / 2)
}

async function run(backend, song) {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // No SINGZ_E2E_HIDDEN: that is the whole point. SINGZ_MUTE still applies —
    // this is a measurement, not a performance.
    env: { ...process.env, SINGZ_MUTE: '1', SINGZ_NO_SYNC: '1', SINGZ_USERDATA_DIR: PROFILE, SINGZ_E2E_HOOKS: '1' }
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.lib-card', { timeout: 60000 })
  await win.waitForFunction(() => window.__test !== undefined, null, { timeout: 60000 })
  await val(win, `void localStorage.setItem(${JSON.stringify(KEY)}, '${backend === 'native' ? '1' : '0'}')`)

  await win.locator('.lib-card').filter({ has: win.locator(`text="${song.name}"`) }).first().click()
  await win.waitForFunction(() => __test?.engine?.duration > 0, null, { timeout: 180000 })
  const full = win.locator('button[title="Show the whole song"]')
  if (await full.isEnabled().catch(() => false)) await full.click()
  // The analyses decode stems of their own; a sample over them measures those.
  await sleep(30000)

  const visibility = await val(win, 'document.visibilityState')
  const frames = await fps(win)
  const idle = sample(app.process().pid)

  await win.click('button.play')
  await win.waitForFunction(() => __test?.engine?.playing === true, null, { timeout: 60000 })
  await sleep(5000)
  const nativeActive = await val(win, '__test.engine.nativeActive')
  const playing = sample(app.process().pid)
  const framesPlaying = await fps(win)

  await val(win, '__test.engine.pause()')
  await app.close()
  return { visibility, frames, framesPlaying, idle, playing, nativeActive }
}

;(async () => {
  if (process.platform !== 'win32') throw new Error('this probe is for Windows; the mac has its own')
  if (!existsSync(APP)) throw new Error(`build first: ${APP} is missing`)
  if (!LIB) throw new Error('PS_LIB is required: this machine has no ffmpeg to stage a library with')

  const songs = readdirSync(LIB, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const doc = JSON.parse(readFileSync(join(LIB, d.name, 'project.json'), 'utf8'))
      const beats = doc.settings?.beat?.beats ?? []
      return { name: doc.name ?? d.name, seconds: beats.length ? beats[beats.length - 1] : 0 }
    })
    .sort((a, b) => b.seconds - a.seconds)
  if (!songs.length) throw new Error(`PS_LIB=${LIB} holds no projects`)
  const song = songs[0]

  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ projectsRoot: LIB }, null, 2))
  log(`library ${LIB} · song "${song.name}" ${song.seconds.toFixed(0)} s · ${WINDOW_SEC} s windows`)

  const out = {}
  for (const backend of ['legacy', 'native']) {
    out[backend] = await run(backend, song)
    const r = out[backend]
    const split = (s) => Object.entries(s.roles ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')
    log(
      `${backend.padEnd(7)} visibility=${r.visibility} fps ${r.frames}/${r.framesPlaying} · nativeActive=${r.nativeActive}\n` +
        `        idle    ${r.idle.cpuPct}% ${r.idle.memMb} MB — ${split(r.idle)}\n` +
        `        playing ${r.playing.cpuPct}% ${r.playing.memMb} MB — ${split(r.playing)}`
    )
    await sleep(3000)
  }

  const fail = []
  for (const backend of ['legacy', 'native']) {
    const r = out[backend]
    if (r.visibility !== 'visible') fail.push(`${backend}: document.visibilityState is "${r.visibility}" — the window was not on screen`)
    if (Math.min(r.frames, r.framesPlaying) < 30) {
      fail.push(`${backend}: ${Math.min(r.frames, r.framesPlaying)} fps — Chromium throttled this window, so the CPU rows are not a singer's`)
    }
    if ((backend === 'native') !== r.nativeActive) fail.push(`${backend}: nativeActive=${r.nativeActive}, the wrong engine was measured`)
  }

  log('\n---- visible window, what the singer pays ----')
  for (const phase of ['idle', 'playing']) {
    const l = out.legacy[phase].cpuPct
    const n = out.native[phase].cpuPct
    log(`  ${phase.padEnd(8)} legacy ${String(l).padStart(6)}%   native ${String(n).padStart(6)}%   ${n - l >= 0 ? '+' : ''}${Math.round((n - l) * 10) / 10}`)
  }

  if (fail.length) {
    for (const f of fail) console.error(`FAIL  ${f}`)
    process.exit(1)
  }
  log('\nPASS')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
