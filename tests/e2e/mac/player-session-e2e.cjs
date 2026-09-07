/*
 * The desktop's player-session: one singer's session replayed twice on the
 * built app — once on Web Audio (legacy), once on the native graph — and
 * judged by the SAME rules the phone harness uses (mobile/tests/player-
 * session/scenario.cjs): a timing rule passes when native ≤ legacy +
 * max(50 ms, 10%); CPU when native ≤ legacy + 2 ticks; footprint when native
 * ≤ legacy; the pitch change against an absolute ceiling only. The script is
 * the phone's, minus what a desktop has no equivalent for (backgrounding —
 * the desktop never suspends playback; those rows are reported n/a).
 *
 * Open a ~2 min six-lane song, Play, touch the metronome three times, scrub
 * four times, ride three faders, transpose +2, turn training on, pause and
 * resume, run the song out and Play again, back to the catalog, open the
 * second song, quit, relaunch, reopen the first. Every timing is sampled IN
 * THE RENDERER by a setInterval (the host's CDP round trip never lands inside
 * a number). Both passes run in one invocation, legacy first, native second,
 * on the same scratch profile with the toggle flipped between them.
 *
 * Silent: SINGZ_MUTE mutes Chromium's output — which the NATIVE graph does
 * not go through (CoreAudio, straight from the core) — so every open also
 * zeroes the engine's master gain, which the native prepare carries as
 * masterGain, and the first metronome touch is volume 0 before the click is
 * ever switched on. The window never appears (SINGZ_E2E_HIDDEN).
 *
 * The app exposes `window.__test` only under SINGZ_E2E_HOOKS=1 (App.tsx);
 * it is the phone's `__test` ported: engine, phase, met, training, open,
 * back. A native pass in which the engine reports Web Audio is a HARNESS
 * FAIL naming the log's reason, never a measured pass.
 *
 * Usage: node tests/e2e/mac/player-session-e2e.cjs [--pass legacy|native|both]
 *        E2E_OUT=<dir>  ALLOW_BUSY_HOST=1  QUIET_LOAD=8
 *        PS_LIB=<dir>   a library already staged (the two seeded projects, each
 *                       with its stems and song file) — for a machine without
 *                       ffmpeg, such as the Windows field laptop, where the
 *                       native provider is WASAPI and the CPU/footprint rows are
 *                       not sampled (no `top`; they print as n/a).
 */
// Every E2E driver runs under a deadline: a hang prints where it was and
// exits, instead of sitting there until somebody notices (tests/shared/watchdog.cjs).
require('../../shared/watchdog.cjs').arm('player-session-e2e', { totalMinutes: 120 })

const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { execFileSync } = require('node:child_process')
const { mkdirSync, rmSync, cpSync, writeFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { stageSongs } = require('../../../mobile/tests/player-session/seed.cjs')
const { hostLoad, isQuiet, QUIET_LOAD } = require('../../../mobile/tests/player-session/host-load.cjs')

const argv = process.argv.slice(2)
const passArg = (() => { const i = argv.indexOf('--pass'); return i >= 0 ? argv[i + 1] : 'both' })()
const OUT = process.env.E2E_OUT ?? tmpdir()
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
const MOBILE = join(__dirname, '..', '..', '..', 'mobile')
const PROFILE = join(OUT, 'player-session-userdata')
const LIB = process.env.PS_LIB ? require('node:path').resolve(process.env.PS_LIB) : join(OUT, 'player-session-lib')
const WIN = process.platform === 'win32'
const ADVANCE = 0.008
const PITCH_LIMIT_MS = 12000
/** Diagnostic only: space the three metronome touches out (ms) to tell a
 *  race between back-to-back rebuilds from a stop that happens on every
 *  touch. The scenario proper fires them as fast as a singer's thumb. */
const TOUCH_GAP_MS = Number(process.env.PS_TOUCH_GAP_MS || 0)
const log = (line) => console.log(line)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** The live window, so a harness failure can print what the app itself
 *  wrote down — the log dialog's lines are the only account of a native
 *  decision the driver cannot see from outside. */
let liveWin = null
let liveApp = null

const METRICS = [
  { key: 'openPlayer', label: 'open → player screen', rule: 'compare' },
  { key: 'openReady', label: 'open → ready to play', rule: 'compare' },
  { key: 'playAdvance', label: 'Play → position advancing', rule: 'compare' },
  { key: 'seekApply', label: 'seek → position reads target (worst of 4)', rule: 'compare' },
  { key: 'laneRamp', label: 'lane ramp → applied (worst of 3)', rule: 'compare' },
  { key: 'metSave', label: 'metronome save → accepted (worst of 3)', rule: 'compare' },
  { key: 'metSettle', label: 'metronome touches → audio advancing again', rule: 'compare' },
  { key: 'pitchStall', label: 'pitch +2 → audio advancing again', rule: 'absolute', limit: PITCH_LIMIT_MS },
  { key: 'trainGap', label: 'training on → advancing again', rule: 'compare' },
  { key: 'pauseStop', label: 'pause → stopped', rule: 'compare' },
  { key: 'resumeAdvance', label: 'resume → advancing', rule: 'compare' },
  { key: 'foregroundPlay', label: 'foreground → Play advancing', rule: 'n/a', why: 'the desktop never suspends playback in the background' },
  { key: 'endRestart', label: 'end of song → Play restart', rule: 'compare' },
  { key: 'backUnload', label: 'back → catalog', rule: 'compare' },
  { key: 'secondOpen', label: 'second song → ready to play', rule: 'compare' },
  { key: 'coldRestart', label: 'app restart → catalog ready', rule: 'compare' },
  { key: 'reopen', label: 'reopen after restart → ready to play', rule: 'compare' }
]
const CPU_PHASES = ['idle-in-player', 'playing', 'pitch-change', 'after-leaving']
/**
 * Lines that end a pass on the spot.
 *
 * The named patterns are kept for the sources that have no levels worth
 * trusting, but the rule that matters is the LEVEL one below: every warn or
 * error the dsp path writes is a failure of this session, because main only
 * writes one when a native command was refused, threw, or came back
 * incomplete. Three hand-written phrases were the whole net until a field
 * session produced sixteen `resume failed · … Native playback is not paused`
 * warnings and one `graph build refused`, and this harness would have called
 * that run clean — the regexes want "native playback" FOLLOWED BY "failed",
 * and the line says it the other way round. A list of remembered phrases can
 * only catch the failures somebody already met.
 */
const FATAL_LOG = [/native playback .*(failed|refused|quarantin)/i, /cue rebuild failed/i]
const isFatalLine = (entry) =>
  (entry.source === 'dsp' && (entry.level === 'warn' || entry.level === 'error')) ||
  FATAL_LOG.some((p) => p.test(entry.line))

/** An in-renderer sampler: run `action`, sample position/playing every
 *  `every` ms until `cond` holds (+ hold) or `ms` elapse; resolve the trace. */
function watchExpr({ ms, every = 30, action = '', cond = 'false', extra = 'null', stopOnHit = true, holdAfterHitMs = null }) {
  const hold = stopOnHit ? '0' : holdAfterHitMs === null ? 'Infinity' : String(holdAfterHitMs)
  return (
    '(() => new Promise(res => {' +
    'const out = []; const t0 = Date.now(); let hit = null; let err = null;' +
    'const e = __test.engine;' +
    'const iv = setInterval(() => {' +
    'const s = { t: Date.now() - t0, pos: e.position, playing: !!e.playing, native: e.nativeActive,' +
    ' x: (function () { try { return (' + extra + ') } catch (x) { return null } })() };' +
    'out.push(s);' +
    'if (hit === null && (' + cond + ')) hit = s.t;' +
    'if ((hit !== null && s.t >= hit + ' + hold + ') || s.t >= ' + ms + ') {' +
    'clearInterval(iv); res(JSON.stringify({ t0, hit, err, out })); }' +
    '}, ' + every + ');' +
    '(function () { try { ' + action + ' } catch (x) { err = String(x && (x.stack || x.message) || x) } })();' +
    '}))()'
  )
}
function longestStall(out) {
  const s = out.filter((x) => x.pos !== null)
  let start = null
  let best = null
  for (let i = 1; i < s.length; i++) {
    const moved = s[i].pos > s[i - 1].pos + ADVANCE
    if (!moved) { if (start === null) start = s[i - 1].t }
    else if (start !== null) { const d = s[i].t - start; if (best === null || d > best.ms) best = { ms: d, until: s[i].t }; start = null }
  }
  if (start !== null) { const d = s[s.length - 1].t - start; if (best === null || d > best.ms) best = { ms: d, until: null } }
  return best ?? { ms: 0, until: 0 }
}

/** CPU over a window and footprint for the app's whole process tree (main,
 *  renderer, gpu, utility): `top -l 2` gives the second sample's interval
 *  CPU; RSS is summed from the same sample. */
function processTree(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number))
  const kids = new Map()
  for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid) }
  const out = [rootPid]
  for (let i = 0; i < out.length; i++) for (const k of kids.get(out[i]) ?? []) out.push(k)
  return out
}
function sampleCpu(rootPid, windowSec = 2) {
  const { load1 } = hostLoad()
  // Windows has no `top` and no load average (os.loadavg() is zeros there):
  // the CPU, footprint and host-quiet rows are not measured rather than
  // measured wrongly, and print as n/a.
  if (WIN) return { cpuPct: null, footprintMb: null, load1: null, quiet: true }
  const pids = new Set(processTree(rootPid))
  const text = execFileSync('top', ['-l', '2', '-s', String(windowSec), '-stats', 'pid,cpu,mem'], { encoding: 'utf8' })
  const second = text.split(/\nProcesses:/).pop()
  let cpu = 0
  let memMb = 0
  for (const line of second.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)([KMG])/)
    if (!m || !pids.has(Number(m[1]))) continue
    cpu += Number(m[2])
    const v = Number(m[3])
    memMb += m[4] === 'G' ? v * 1024 : m[4] === 'M' ? v : v / 1024
  }
  return { cpuPct: Math.round(cpu * 10) / 10, footprintMb: Math.round(memMb), load1, quiet: isQuiet(load1) }
}

/**
 * Open both songs once before either pass. The seed strips the stored melody
 * and key, so the first open of each song runs the analysis and auto-saves it
 * into the scratch library — and the pass that happens to go first would carry
 * that child's CPU inside its idle/playing samples while the second opened an
 * already-analysed doc. After this, every compared open sees the same stored
 * state. Waits until the app has stopped saving for a while.
 */
async function warmUp(songs) {
  const env = { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1', SINGZ_USERDATA_DIR: PROFILE, SINGZ_E2E_HOOKS: '1' }
  const app = await _electron.launch({ executablePath: require('electron'), args: [APP], env })
  await quietLaunch(app)
  const win = await app.firstWindow()
  await win.waitForSelector('.lib-card', { timeout: 60000 })
  for (const song of songs) {
    await win.locator('.lib-card').filter({ has: win.locator(`text="${song.name}"`) }).first().click()
    const deadline = Date.now() + 120000
    let ready = false
    while (Date.now() < deadline) {
      const st = JSON.parse(await win.evaluate('JSON.stringify({ phase: __test.phase, n: __test.tracks.length })'))
      if (st.phase === 'ready' && st.n > 0) { ready = true; break }
      await sleep(50)
    }
    if (!ready) throw new Error(`warm-up: "${song.name}" never became ready`)
    await win.evaluate('__test.engine.setMasterVolume(0)')
    // A library that already carries its analysis (a PS_LIB staged and run
    // before) usually saves nothing on open — but "carries" is presence, not
    // currency: after a detector stamp bump the app re-derives and saves
    // again. So the quiet wait stays on this path too; only the "never
    // saved" verdict is waived. Six seconds a song, and a stale stamp shows
    // up as saves instead of being skipped past.
    const doc = JSON.parse(require('node:fs').readFileSync(join(song.dir, 'project.json'), 'utf8'))
    const analysed = Boolean(doc.settings?.melody && doc.settings?.key)
    // Done = at least one save has landed for THIS song AND none for 6 s
    // after the last (max 90 s). The log is cumulative across the one warm-up
    // app, so the count is taken relative to a baseline read at this song's
    // ready — without that, song B's first poll already sees A's saves and the
    // quiet clock starts at ready, which is the window an analysis still
    // working at ready+6 s would be abandoned in by the back navigation and
    // re-run by whichever pass goes first — the very thing this warm-up
    // exists to prevent. Zero saves is a failure, not a note.
    const countSaves = async () => (await win.evaluate('window.singz.getLog()')).filter((x) => /project saved/.test(x.line)).length
    const base = await countSaves()
    let lastSave = analysed ? Date.now() : null
    let seen = 0
    const until = Date.now() + 90000
    while (Date.now() < until) {
      const saves = (await countSaves()) - base
      if (saves !== seen) { seen = saves; lastSave = Date.now() }
      if (lastSave !== null && Date.now() - lastSave > 6000) break
      await sleep(500)
    }
    if (seen === 0 && !analysed) throw new Error(`warm-up: "${song.name}" was never saved within 90 s of ready — its analysis did not land`)
    log(`  warm-up: ${song.name} ${analysed ? 'already analysed' : 'analysed and saved'} (${seen} saves of its own)`)
    await win.evaluate('__test.setShowCatalog(true)')
    await win.waitForSelector('.lib-card', { timeout: 30000 })
  }
  await app.close()
}

async function runPass(kind, songs) {
  const pass = { backend: kind, ms: {}, cpu: {}, notes: [], fatal: [] }
  const env = { ...process.env, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1', SINGZ_USERDATA_DIR: PROFILE, SINGZ_E2E_HOOKS: '1' }
  const launch = async () => {
    const t0 = Date.now()
    const app = await _electron.launch({ executablePath: require('electron'), args: [APP], env })
    await quietLaunch(app)
    const win = await app.firstWindow()
    await win.waitForSelector('.lib-card', { timeout: 60000 })
    return { app, win, ms: Date.now() - t0 }
  }
  const evalStr = (win, expr, timeout = 30000) => win.evaluate(`(async () => (${expr}))()`, undefined, { timeout }).catch(async (e) => {
    // string expressions with await need the async wrapper; plain ones do not
    throw e
  })
  const val = (win, expr) => win.evaluate(expr)
  const watch = async (win, opts) => {
    const r = JSON.parse(await win.evaluate(watchExpr(opts)))
    if (r.err) throw new Error(`in-app action threw: ${r.err} :: ${opts.action}`)
    const err = await val(win, '__test.engine.playbackError ? JSON.stringify(__test.engine.playbackError) : null')
    if (err) throw new Error(`the engine reported a playback error during "${opts.action}": ${err}`)
    return r
  }
  const logSince = async (win, fromMs) => {
    const entries = await val(win, 'window.singz.getLog()')
    return entries.filter((x) => x.t >= fromMs)
  }
  const checkFatal = async (win, fromMs, what) => {
    const lines = await logSince(win, fromMs)
    const hits = lines.filter(isFatalLine).map((x) => `${x.source} [${x.level}]: ${x.line.slice(0, 200)}`)
    if (hits.length) { pass.fatal.push({ what, hits }); throw new Error(`fatal log during "${what}": ${hits[0]}`) }
  }
  // The native facade's last status, read through the engine (a JS runtime
  // sees the private field): which generation renders, and the seam counters.
  const seamFacts = (win) => val(win, `(function(){ const c = __test.engine.nativePlayback; const s = c && c.status; return s ? 'gen ' + s.generation + ' transport ' + s.transportGeneration + ' seams ' + s.swapLandings + ' late ' + s.swapLateLandings + ' pending ' + s.swapPendingGeneration : 'no native status' })()`)
  const dspLines = async (win, fromMs) => (await logSince(win, fromMs)).filter((x) => x.source === 'dsp').map((x) => `${new Date(x.t).toISOString().slice(11, 23)} ${x.line.slice(0, 150)}`)
  const mute = async (win) => {
    await val(win, '__test.engine.setMasterVolume(0)')
  }
  const open = async (win, name) => {
    const t0 = Date.now()
    // Exact, not a substring: song B's name contains song A's.
    await win.locator('.lib-card').filter({ has: win.locator(`text="${name}"`) }).first().click()
    let player = null
    let ready = null
    const deadline = t0 + 120000
    while (Date.now() < deadline) {
      const s = await val(win, 'JSON.stringify({ phase: __test.phase, cat: __test.showCatalog, n: __test.tracks.length })')
      const st = JSON.parse(s)
      if (player === null && !st.cat && st.phase !== 'empty') player = Date.now() - t0
      if (st.phase === 'ready' && st.n > 0 && !st.cat) { ready = Date.now() - t0; break }
      await sleep(20)
    }
    if (ready === null) throw new Error(`"${name}" never became ready`)
    await mute(win)
    return { player: player ?? ready, ready }
  }
  const backendCheck = async (win, when) => {
    const native = await val(win, '__test.engine.nativeActive')
    if (kind === 'native' && !native) {
      const lines = await logSince(win, 0)
      const why = lines.filter((x) => /native|legacy|backend/i.test(x.line)).slice(-6).map((x) => x.line.slice(0, 200))
      throw new Error(`HARNESS: the native pass is playing on Web Audio at "${when}". Recent log: ${JSON.stringify(why)}`)
    }
    if (kind === 'legacy' && native) throw new Error(`HARNESS: the legacy pass is playing on the native graph at "${when}"`)
  }

  // ---- launch, set the toggle, reload so boot reads it -------------------
  let { app, win } = await launch()
  liveWin = win
  liveApp = app
  await val(win, `(() => { const p = JSON.parse(localStorage.getItem('singz.audio') || '{}'); p.nativePlayback = ${kind === 'native'}; localStorage.setItem('singz.audio', JSON.stringify(p)); localStorage.setItem('singz.desktop.native-playback', '${kind === 'native' ? 1 : 0}'); localStorage.setItem('singz.met', JSON.stringify({ click: false, countInBars: 0, volume: 0, accent: true, grid: true })); return 1 })()`)
  await win.reload()
  await win.waitForSelector('.lib-card', { timeout: 60000 })
  const pid = app.process().pid
  const A = songs[0].name
  const B = songs[1].name
  const passStart = Date.now()

  // ---- open A ---------------------------------------------------------------
  const o1 = await open(win, A)
  pass.ms.openPlayer = o1.player
  pass.ms.openReady = o1.ready
  // "Idle in the player" means idle: on native the graph is prepared ahead
  // of Play 400 ms after the last setting lands, and a sample taken during
  // that decode read 45% on an idle screen. Wait for it to settle (or for
  // 8 s) before sampling; legacy has nothing to wait for and gets the 1.5 s.
  await sleep(1500)
  if (kind === 'native') {
    for (const deadline = Date.now() + 8000; Date.now() < deadline; ) {
      const ahead = await val(win, '(function(){ const c = __test.engine.nativePlayback; return !!(c && c.preparedAhead) })()')
      if (ahead) break
      await sleep(250)
    }
    await sleep(1000)
  }
  pass.cpu['idle-in-player'] = sampleCpu(pid)
  const duration = await val(win, '__test.engine.duration')
  log(`  [${kind}] open A: player ${o1.player} ms · ready ${o1.ready} ms · duration ${duration.toFixed(1)} s`)

  // ---- Play → advancing -----------------------------------------------------
  let r = await watch(win, { ms: 15000, action: 'e.play({ countIn: false })', cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE })
  pass.ms.playAdvance = r.hit
  await backendCheck(win, 'Play')
  await mute(win)
  await checkFatal(win, passStart, 'Play')
  await sleep(2500)
  pass.cpu.playing = sampleCpu(pid)
  // Whether the renderer is still holding its own decode of every lane while
  // the core plays. The footprint rows below say the same thing in megabytes,
  // but megabytes drift with the song and the host; this says it by name, so
  // a change that quietly stops releasing is a red with a cause attached.
  pass.lanesResident = await val(win, '__test.engine.lanesResident')
  log(`  [${kind}] Play → advancing ${r.hit} ms · native=${await val(win, '__test.engine.nativeActive')} · lanes resident=${pass.lanesResident} · cpu ${pass.cpu.playing.cpuPct}% (load ${pass.cpu.playing.load1})`)

  // ---- metronome touches: volume 0, click on, count-in 1 --------------------
  const touches = [['volume', 0, 'volume: 0'], ['click', true, 'click: true'], ['countInBars', 1, 'countInBars: 1']]
  const metSaves = []
  for (const [key, value, patch] of touches) {
    r = await watch(win, { ms: 8000, every: 10, action: `__test.setMetCfg(Object.assign({}, __test.met, { ${patch} }))`, cond: `__test.met.${key} === ${JSON.stringify(value)}` })
    if (r.hit === null) throw new Error(`metronome touch ${key} never accepted`)
    metSaves.push(r.hit)
    if (TOUCH_GAP_MS > 0) {
      await sleep(TOUCH_GAP_MS)
      log(`  [${kind}]   after ${key}: ${await val(win, 'JSON.stringify({ playing: __test.engine.playing, pos: +__test.engine.position.toFixed(2), native: __test.engine.nativeActive })')}`)
    }
  }
  pass.ms.metSave = Math.max(...metSaves)
  r = await watch(win, { ms: 10000, cond: 'out.length > 3 && s.playing && s.pos > out[out.length - 2].pos + ' + ADVANCE })
  pass.ms.metSettle = r.hit
  if (r.hit === null) pass.notes.push('the transport did not advance again within 10 s of the metronome touches')
  await checkFatal(win, passStart, 'metronome touches')
  log(`  [${kind}] metronome touches: ${metSaves.join(' / ')} ms · advancing again ${r.hit} ms`)
  // The count-in goes back off before the seeks, as on the phones: from here
  // on every Play measures a transport, not a bar of clicks.
  await val(win, "__test.setMetCfg(Object.assign({}, __test.met, { countInBars: 0 }))")
  await sleep(500)

  // ---- four seeks -----------------------------------------------------------
  const seeks = []
  for (const target of [30, 60, 15, 45]) {
    // The target read back, playing or not: a transport that a rebuild left
    // parked is the metSettle row's finding (a missing measurement fails it),
    // not a reason to abort the pass before the rows that follow.
    r = await watch(win, { ms: 6000, every: 10, action: `e.seek(${target})`, cond: `Math.abs(s.pos - ${target}) < 0.35` })
    if (r.hit === null) throw new Error(`seek to ${target} never read back (last pos ${r.out.at(-1)?.pos})`)
    seeks.push(r.hit)
    await sleep(700)
  }
  pass.ms.seekApply = Math.max(...seeks)
  await checkFatal(win, passStart, 'seeks')
  log(`  [${kind}] seeks → target: ${seeks.join(' / ')} ms`)

  // ---- three lane ramps -----------------------------------------------------
  const ramps = []
  for (const [id, v] of [['drums', 0.4], ['bass', 0.6], ['vocals', 0.2]]) {
    r = await watch(win, { ms: 6000, every: 10, action: `e.setVolume('${id}', ${v})`, cond: `(function(){ const t = e.getTrackStates().find(x => x.id === '${id}'); return !!t && Math.abs(t.volume - ${v}) < 1e-6 })()` })
    if (r.hit === null) throw new Error(`lane ramp ${id} never applied`)
    ramps.push(r.hit)
  }
  pass.ms.laneRamp = Math.max(...ramps)
  log(`  [${kind}] lane ramps → applied: ${ramps.join(' / ')} ms`)

  // ---- pitch +2: the longest stall, absolute ceiling only --------------------
  const lastPollExpr = '(function(){ const c = e.nativePlayback; return c ? c.lastAtMs : null })()'
  r = await watch(win, { ms: PITCH_LIMIT_MS + 3000, every: 20, action: '__test.setTranspose(2)', cond: 'false', stopOnHit: false, holdAfterHitMs: null, extra: lastPollExpr })
  const stall = longestStall(r.out)
  pass.ms.pitchStall = stall.ms
  await backendCheck(win, 'pitch change')
  await mute(win)
  await checkFatal(win, passStart, 'pitch change')
  pass.cpu['pitch-change'] = sampleCpu(pid)
  const pollGap = (out) => { let worst = 0; for (let i = 1; i < out.length; i++) { const d = out[i].x - out[i - 1].x; if (out[i].x !== null && out[i - 1].x !== null && d > worst) worst = d } return worst }
  log(`  [${kind}] pitch +2 → longest stall ${stall.ms} ms · transpose now ${await val(win, '__test.engine.transpose')} · cpu ${pass.cpu['pitch-change'].cpuPct}%${kind === 'native' ? ` · ${await seamFacts(win)} · longest gap between status polls ${pollGap(r.out)} ms` : ''}`)

  // ---- training on ----------------------------------------------------------
  await val(win, `__test.setTrainCfg(Object.assign({}, __test.trainCfg, { mode: 'period', periodSec: 8, stems: ['vocals'] }))`)
  await sleep(300)
  const tTrain = Date.now()
  r = await watch(win, { ms: 10000, every: 20, action: '__test.setTraining(true)', cond: 'false', stopOnHit: false, extra: lastPollExpr })
  pass.ms.trainGap = longestStall(r.out).ms
  const trainingOn = await val(win, '__test.training')
  await checkFatal(win, passStart, 'training on')
  log(`  [${kind}] training on → longest stall ${pass.ms.trainGap} ms · training=${trainingOn}${kind === 'native' ? ` · ${await seamFacts(win)} · longest gap between status polls ${pollGap(r.out)} ms` : ''}`)
  if (kind === 'native') for (const line of await dspLines(win, tTrain)) log(`      ${line}`)

  // ---- pause / resume -------------------------------------------------------
  r = await watch(win, { ms: 5000, every: 10, action: 'e.pause()', cond: '!s.playing && out.length > 2 && Math.abs(s.pos - out[out.length - 2].pos) < 1e-4', holdAfterHitMs: 300 })
  pass.ms.pauseStop = r.hit
  await sleep(800)
  r = await watch(win, { ms: 15000, action: 'e.play()', cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE })
  pass.ms.resumeAdvance = r.hit
  await mute(win)
  await checkFatal(win, passStart, 'pause/resume')
  log(`  [${kind}] pause → stopped ${pass.ms.pauseStop} ms · resume → advancing ${pass.ms.resumeAdvance} ms`)

  // ---- end of song → Play restart ------------------------------------------
  await val(win, `__test.engine.seek(${Math.max(0, duration - 2)})`)
  const endDeadline = Date.now() + 15000
  while (Date.now() < endDeadline) { if (!(await val(win, '__test.engine.playing'))) break; await sleep(100) }
  if (await val(win, '__test.engine.playing')) throw new Error('the song did not run out after a seek to its end')
  await sleep(500)
  r = await watch(win, { ms: 15000, action: 'e.play({ countIn: false })', cond: 'out.length > 1 && s.playing && s.pos < 5 && s.pos > out[0].pos + ' + ADVANCE + ' || (out.length > 1 && s.playing && out[0].pos > 5 && s.pos < 5)' })
  pass.ms.endRestart = r.hit
  await mute(win)
  await checkFatal(win, passStart, 'end of song')
  log(`  [${kind}] end of song → Play restart ${r.hit} ms (pos ${r.out.at(-1)?.pos?.toFixed(2)})`)
  await val(win, '__test.engine.pause()')

  // ---- back → catalog, second song ----------------------------------------
  let t0 = Date.now()
  await val(win, '__test.setShowCatalog(true)')
  await win.waitForSelector('.lib-card', { timeout: 30000 })
  pass.ms.backUnload = Date.now() - t0
  const o2 = await open(win, B)
  pass.ms.secondOpen = o2.ready
  await sleep(1500)
  pass.cpu['after-leaving'] = sampleCpu(pid)
  const nativeAfterLeave = await val(win, '__test.engine.nativeActive')
  log(`  [${kind}] back → catalog ${pass.ms.backUnload} ms · second song ready ${o2.ready} ms · native active after switch=${nativeAfterLeave}`)

  // ---- quit, relaunch, reopen A --------------------------------------------
  await app.close()
  const relaunched = await launch()
  app = relaunched.app
  win = relaunched.win
  liveWin = win
  liveApp = app
  pass.ms.coldRestart = relaunched.ms
  const o3 = await open(win, A)
  pass.ms.reopen = o3.ready
  await val(win, '__test.engine.pause()')
  const finalLog = await logSince(win, 0)
  pass.notes.push(`log lines this launch: ${finalLog.length}`)
  const events = finalLog.filter((x) => x.source === 'dsp')
  log(`  [${kind}] graph events this launch: ${events.length}${events.length ? ' — ' + events.map((x) => x.line.split(' · ')[0]).join('; ').slice(0, 300) : ''}`)
  log(`  [${kind}] app restart ${relaunched.ms} ms · reopen A ready ${o3.ready} ms`)
  await app.close()
  return pass
}

function judge(legacy, native) {
  const rows = []
  const budget = (l) => Math.max(50, l * 0.1)
  for (const spec of METRICS) {
    const l = legacy.ms[spec.key] ?? null
    const n = native.ms[spec.key] ?? null
    if (spec.rule === 'n/a') { rows.push({ rule: `${spec.label}: n/a — ${spec.why}`, ok: null }); continue }
    if (spec.rule === 'absolute') {
      rows.push({ rule: `${spec.label} < ${spec.limit} ms (absolute; not compared)`, ok: n !== null && n < spec.limit, detail: `native ${n} ms · legacy ${l} ms` })
      continue
    }
    if (l === null || n === null) { rows.push({ rule: spec.label, ok: false, detail: `missing measurement (legacy ${l}, native ${n})` }); continue }
    const allowed = l + budget(l)
    rows.push({ rule: `${spec.label}: native ≤ legacy + max(50 ms, 10%)`, ok: n <= allowed, detail: `native ${n} ms vs legacy ${l} ms (budget ${Math.round(allowed)} ms, ${n - l >= 0 ? '+' : ''}${n - l} ms)` })
  }
  for (const phase of CPU_PHASES) {
    const l = legacy.cpu[phase]
    const n = native.cpu[phase]
    if (!l || !n) continue
    if (l.cpuPct === null || n.cpuPct === null) {
      rows.push({ rule: `CPU and footprint (${phase}): n/a — not sampled on this platform`, ok: null })
      continue
    }
    const tick = 0.5 // top's %CPU over a 2 s window resolves to about half a point per process
    const cpuBudget = Math.round((l.cpuPct + 2 * tick) * 10) / 10
    rows.push({ rule: `CPU (${phase}): native ≤ legacy + 2 ticks`, ok: n.cpuPct <= cpuBudget, detail: `native ${n.cpuPct}% vs legacy ${l.cpuPct}% (budget ${cpuBudget}%)${l.quiet && n.quiet ? '' : ' — host BUSY'}` })
    rows.push({ rule: `footprint (${phase}): native ≤ legacy`, ok: n.footprintMb <= l.footprintMb, detail: `native ${n.footprintMb} MB vs legacy ${l.footprintMb} MB` })
  }
  // Web Audio plays FROM the renderer's buffers, so legacy must still hold
  // them; the core plays from the stem files, so native must not.
  rows.push({
    rule: 'the renderer holds its own decode on legacy and has let it go on native',
    ok: legacy.lanesResident === true && native.lanesResident === false,
    detail: `legacy ${legacy.lanesResident} · native ${native.lanesResident}`
  })
  for (const p of [legacy, native]) {
    const busy = CPU_PHASES.filter((ph) => p.cpu[ph] && !p.cpu[ph].quiet)
    if (CPU_PHASES.every((ph) => !p.cpu[ph] || p.cpu[ph].load1 === null)) {
      rows.push({ rule: `the host was quiet through every CPU phase — ${p.backend}: n/a — no load average on this platform`, ok: null })
    } else rows.push({ rule: `the host was quiet (1-min load ≤ ${QUIET_LOAD}) through every CPU phase — ${p.backend}`, ok: busy.length === 0, detail: CPU_PHASES.filter((ph) => p.cpu[ph]).map((ph) => `${ph}=${p.cpu[ph].load1}`).join(' ') + (busy.length ? ` — BUSY during ${busy.join(', ')}: those CPU rows describe the host, not the app` : '') })
    rows.push({ rule: `no fatal native line in the log — ${p.backend}`, ok: p.fatal.length === 0, detail: p.fatal.map((f) => f.hits[0]).join(' | ') })
  }
  return rows
}

;(async () => {
  const load = hostLoad()
  log(`host load ${load.load1} (1-min average, ${load.cpus} cores; quiet is ≤ ${QUIET_LOAD})`)
  if (!isQuiet(load.load1) && !process.env.ALLOW_BUSY_HOST) {
    console.error(`HARNESS FAIL: the host is busy (1-min load ${load.load1}, quiet is ≤ ${QUIET_LOAD}). Set ALLOW_BUSY_HOST=1 to run anyway.`)
    process.exit(1)
  }
  if (!existsSync(APP)) throw new Error(`build first: ${APP} is missing (npm run build)`)
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  let songs
  if (process.env.PS_LIB) {
    // A library staged elsewhere (by this driver on a machine with ffmpeg):
    // read the two projects' names and lengths off their docs.
    const { readdirSync, readFileSync } = require('node:fs')
    songs = readdirSync(LIB, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const doc = JSON.parse(readFileSync(join(LIB, d.name, 'project.json'), 'utf8'))
      const beats = doc.settings?.beat?.beats ?? []
      return { name: doc.name ?? d.name, dir: join(LIB, d.name), seconds: beats.length ? beats[beats.length - 1] : 0 }
    }).sort((a, b) => b.seconds - a.seconds)
    if (songs.length < 2) throw new Error(`PS_LIB=${LIB} needs the two seeded projects`)
  } else {
    songs = stageSongs(MOBILE)
    rmSync(LIB, { recursive: true, force: true })
    mkdirSync(LIB, { recursive: true })
  }
  for (const s of songs) {
    if (process.env.PS_LIB) break
    cpSync(s.dir, join(LIB, s.name), { recursive: true })
    // The desktop lists a project only when the song file its doc names is
    // present; the phones never need it, so the seed stages none. The stems
    // are what plays, so one second of silence stands in (ffmpeg is already a
    // prerequisite: the seed loops the stems with it).
    const songFile = JSON.parse(require('node:fs').readFileSync(join(LIB, s.name, 'project.json'), 'utf8')).songFile
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', '-q:a', '9', join(LIB, s.name, songFile)])
  }
  writeFileSync(join(PROFILE, 'settings.json'), JSON.stringify({ projectsRoot: LIB }, null, 2))
  log(`library: ${LIB} (${songs.map((s) => `${s.name} ${s.seconds.toFixed(0)} s`).join(', ')})`)

  await warmUp(songs)
  const passes = {}
  for (const kind of passArg === 'both' ? ['legacy', 'native'] : [passArg]) {
    log(`\n== ${kind} pass ==`)
    passes[kind] = await runPass(kind, songs)
  }
  if (passArg !== 'both') {
    log(JSON.stringify(passes, null, 1))
    log('PASS (single backend measured; nothing compared)')
    process.exit(0)
  }
  const rows = judge(passes.legacy, passes.native)
  log('\n== comparison ==')
  log(`${'metric'.padEnd(46)} ${'legacy'.padStart(8)} ${'native'.padStart(8)}`)
  for (const spec of METRICS) log(`${spec.label.padEnd(46)} ${String(passes.legacy.ms[spec.key] ?? '—').padStart(8)} ${String(passes.native.ms[spec.key] ?? '—').padStart(8)}`)
  let fails = 0
  let compared = 0
  for (const row of rows) {
    if (row.ok === null) { log(`n/a   ${row.rule}`); continue }
    compared++
    if (!row.ok) fails++
    log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.rule}${row.detail ? ` — ${row.detail}` : ''}`)
  }
  log(`\n${WIN ? 'windows' : 'mac'} desktop: ${compared - fails}/${compared} rules pass`)
  process.exit(fails ? 1 : 0)
})().catch(async (e) => {
  console.error('HARNESS FAIL', e && (e.stack || e.message) || e)
  try {
    if (liveWin) {
      const entries = await liveWin.evaluate('window.singz.getLog()')
      console.error('-- the app log, last 40 lines --')
      for (const x of entries.slice(-40)) console.error(`${new Date(x.t).toISOString().slice(11, 23)} ${x.source}: ${x.line.slice(0, 220)}`)
      const st = await liveWin.evaluate('JSON.stringify({ playing: __test.engine.playing, pos: __test.engine.position, native: __test.engine.nativeActive, err: __test.engine.playbackError, phase: __test.phase })')
      console.error('-- engine --', st)
    }
    if (liveApp) await liveApp.close()
  } catch {}
  process.exit(1)
})
