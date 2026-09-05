/*
 * The session, the metrics and the rules — backend-agnostic and platform-
 * agnostic. Everything that knows about simctl or adb lives in ios.cjs /
 * android.cjs; everything that knows what a singer did lives here.
 *
 * The scenario is one real 3-hour session, compressed: open a long six-lane
 * song, play it, fiddle with the metronome, scrub about, ride three faders,
 * transpose up two, turn training on, pause, come back, take a phone call
 * (background), come back again, run the song out to its end, start it
 * again, go back to the catalog, open a different song, come back, restart
 * the app, open the first song again. Nothing here is exotic. That is the
 * point: it is the set of things the singer actually did in the session that
 * produced the field reports the native graph is being fixed for.
 *
 * Both playback backends run the identical script, so a metric is only ever
 * compared with ITSELF on the other backend, on the same rig, minutes apart.
 * That is the only comparison a simulator can honestly support.
 *
 * ---- how the numbers are taken --------------------------------------------
 *
 * Every fine-grained timing is measured IN THE APP, not from the host: an
 * expression sets up a `setInterval` sampler, runs the action, and resolves
 * with the whole trace. A host-side poll over CDP costs 5-20 ms a round trip
 * and would put its own latency inside every number. The host only ever sees
 * the trace afterwards.
 *
 * TWO metrics are NOT compared, and the notes on each in METRICS say why.
 * First audible is reported only: legacy times it from its own position
 * clock and native from the core's first audible callback, so the columns
 * are different events and a legacy win there means nothing.
 *
 * The other is the pitch change. Under the native
 * graph a transpose is currently a full rebuild, and it is expected to lose
 * badly against legacy's varispeed sources; comparing it would say nothing
 * anyone does not already know. It is asserted against an absolute ceiling
 * instead, and both numbers are printed side by side so the gap is visible
 * rather than hidden behind a PASS.
 */

const { sleep } = require('./cdp.cjs')
const { hostLoad, isQuiet, QUIET_LOAD } = require('./host-load.cjs')

/* The legacy engine's callback size, written down once. react-native-audio-api
   renders in RENDER_QUANTUM_SIZE frames (Constants.h) and on Android asks
   Oboe for exactly that many per callback (AudioPlayer.cpp,
   setFramesPerDataCallback); on iOS the OS chooses its own callback size
   and the app cannot observe it. Nothing in the app logs it, so this is the
   one figure the table has for legacy — a constant, and labelled as one. */
const LEGACY_RENDER_QUANTUM = 128

/* The app's telemetry poll interval, mirrored. A driver cannot import from
   src/ (it runs in node against a device, not in the bundle), so this is the
   one place it is written down twice — and the sampling windows below are all
   derived from it rather than from independent literals, which is what went
   wrong when the interval moved and a fixed 300 ms window stopped containing
   the correction it existed to catch. Keep in step with
   NATIVE_TELEMETRY_POLL_MS in mobile/src/playback/native.ts.

   Since the position moved onto the synchronous clock the poll carries no
   position, so a correction no longer "arrives" on it — but the seek rule's
   window still spans one poll plus, so that a build without the clock (which
   still projects between polls) is measured over the whole gap it can bounce
   in. */
const POLL_MS = 1000

/** A sample is "advancing" when the transport moved by more than this since
 *  the previous one — comfortably above sampler jitter, well under one
 *  sampler interval of real playback (30 ms interval ~ 0.030 s of song). */
const ADVANCE = 0.008

/* -------------------------------------------------------------------------
 * Metric table. `rule`:
 *   'compare'  — native must be <= legacy + max(50 ms, 10%)
 *   'absolute' — native must be under `limit`; the two are NOT compared
 *   'report'   — printed, never a pass/fail on its own
 * ---------------------------------------------------------------------- */
const METRICS = [
  { key: 'openPlayer', label: 'open → player screen', rule: 'compare' },
  { key: 'openReady', label: 'open → ready to play', rule: 'compare' },
  { key: 'playAdvance', label: 'Play → position advancing', rule: 'compare' },
  /* Reported, never compared. Legacy times this from its own position
     clock and native from the core's first audible callback: they are
     not the same measurement, so a legacy win here means nothing and
     must not fail a rule. Same reasoning as the transpose. */
  { key: 'playAudible', label: 'Play → first audible', rule: 'report' },
  { key: 'seekApply', label: 'seek → position reads target (worst of 4)', rule: 'compare' },
  { key: 'laneRamp', label: 'lane ramp → applied (worst of 3)', rule: 'compare' },
  { key: 'metSave', label: 'metronome save → accepted (worst of 3)', rule: 'compare' },
  { key: 'metSettle', label: 'metronome touches → audio advancing again', rule: 'compare' },
  {
    key: 'pitchGap',
    label: 'pitch +2 → audio advancing again',
    rule: 'absolute',
    limit: 12000,
    note: 'native rebuilds the graph here — NOT compared with legacy'
  },
  { key: 'trainGap', label: 'training on → advancing again', rule: 'compare' },
  { key: 'pauseStop', label: 'pause → stopped', rule: 'compare' },
  { key: 'resumeAdvance', label: 'resume → advancing', rule: 'compare' },
  { key: 'foregroundPlay', label: 'foreground → Play advancing', rule: 'compare' },
  { key: 'endRestart', label: 'end of song → Play restart', rule: 'compare' },
  { key: 'backUnload', label: 'back → catalog (unloaded)', rule: 'compare' },
  { key: 'secondOpen', label: 'second song → player screen', rule: 'compare' },
  { key: 'coldRestart', label: 'app restart → app ready', rule: 'compare' },
  { key: 'reopen', label: 'reopen after restart → player screen', rule: 'compare' }
]

const CPU_PHASES = ['idle-in-player', 'playing', 'pitch-change', 'backgrounded', 'after-leaving']

/* -------------------------------------------------------------------------
 * The in-app side of the harness, installed once per attach.
 *
 * `open()` is the important one. It starts the load AND records the marks
 * itself, so a song opens exactly the same way on both platforms — and so
 * Android can go SILENT over CDP for the whole load, which it must: the
 * Hermes inspector segfaults the app if it is spoken to during a
 * `decodeAudioData`. The marks are also written to the `singz.ps` text pref
 * on the way out, which is how the Android layer learns the load is over
 * without touching JS (the same trick as `singz.crumb`, through the same
 * native store).
 * ---------------------------------------------------------------------- */
const hooksExpr = (runId) =>
  '(() => {' +
  'const g = globalThis;' +
  'g.__psRun = ' + JSON.stringify(runId) + ';' +
  "const np = () => __r('src/playback/native.ts').nativePlayback;" +
  'g.__ps = {' +
  'status: () => np().settingsStatus().then(s => JSON.stringify({' +
  'enabled: s.enabled, supported: s.supported, detail: s.detail,' +
  'buildId: s.capability && s.capability.buildId,' +
  'playbackBuild: s.capability && s.capability.playbackBuild' +
  '})),' +
  'setNative: (on) => np().saveEnabled(on),' +
  'open: (name, maxMs) => new Promise(res => {' +
  'const t0 = Date.now(); const marks = {}; g.__psOpen = null;' +
  'const finish = () => { const r = JSON.stringify({ t0: t0, run: g.__psRun, marks: marks }); g.__psOpen = r;' +
  "try { __r('src/latency.ts').setStoredText('singz.ps', r) } catch (e) {} res(r); };" +
  'const iv = setInterval(() => {' +
  'const t = Date.now() - t0;' +
  "if (marks.player === undefined && __test.screen === 'player') marks.player = t;" +
  'const b = __test.backend;' +
  'if (marks.player !== undefined && marks.ready === undefined && b && b.duration > 0) {' +
  'marks.ready = t; marks.kind = b.kind; marks.duration = b.duration; }' +
  'if (marks.ready !== undefined || t >= maxMs) { clearInterval(iv); finish(); }' +
  '}, 25);' +
  'try { __test.openProject(name) } catch (e) { marks.error = String(e && e.message) }' +
  '})' +
  '};' +
  'return 1; })()'

/* ---------------------------------------------------------------- helpers */

/**
 * One in-app measurement window. `action` runs at t=0; the sampler records
 * the transport every `every` ms until `cond` first holds (or `ms` elapses).
 * `cond` sees `s` (this sample), `out` (all so far) and `b` (the backend).
 */
function watchExpr({
  ms,
  every = 30,
  action = '',
  cond = 'false',
  extra = 'null',
  stopOnHit = true,
  /* Keep sampling for this long AFTER the condition first holds, then stop.
     `stopOnHit: false` with no hold runs the whole window — which is right
     for a stall hunt and wrong for a seek, where a 4 s window truncated
     three of four native seeks into "never read back" and turned a real
     number into a missing one. */
  holdAfterHitMs = null
}) {
  const hold = stopOnHit ? '0' : holdAfterHitMs === null ? 'Infinity' : String(holdAfterHitMs)
  return (
    '(() => new Promise(res => {' +
    'const out = []; const t0 = Date.now(); let hit = null; let err = null;' +
    /* Captured ONCE, so the action, the condition and `extra` all speak about
       the same object. It used to be a `const` inside the interval callback,
       which put it out of scope for the action — every `b.play()` threw a
       ReferenceError into a catch and the metric came back as "never
       advanced", with nothing on screen to say why. */
    'const b = __test.backend;' +
    'const iv = setInterval(() => {' +
    'const s = { t: Date.now() - t0, pos: b ? b.position : null, playing: !!(b && b.playing), screen: __test.screen,' +
    ' x: (function () { try { return (' + extra + ') } catch (e) { return null } })() };' +
    'out.push(s);' +
    'if (hit === null && (' + cond + ')) hit = s.t;' +
    'if ((hit !== null && s.t >= hit + ' + hold + ') || s.t >= ' + ms + ') {' +
    'clearInterval(iv); res(JSON.stringify({ t0, hit, err, run: globalThis.__psRun, out })); }' +
    '}, ' + every + ');' +
    '(function () { try { ' + action + ' } catch (e) { err = String(e && (e.stack || e.message) || e) } })();' +
    '}))()'
  )
}

/**
 * Metro reloads the app's JS when ANYTHING under `mobile/` changes — the test
 * files included — and a reload unmounts the player, unloads the song and
 * re-runs the bundle in the SAME process. Every measurement after it is
 * measuring a different session, and the symptom is a promise that never
 * settles or a transport that "stopped" for no reason (both were seen while
 * this suite was being written, and cost an hour each). So every window
 * carries the run id out with it and a mismatch is a hard stop, not a metric.
 */
/**
 * Lines that mean the pass is already over.
 *
 * The suite used to read the log only twice: three patterns counted at the
 * END of a pass, and releases/prepares counted inside two named windows.
 * That is how an Android run spent twenty minutes driving a graph whose
 * output never opened — `native output handoff failed before rendering`
 * appeared ten seconds in, was in no list, and every metric after it came
 * back "missing" instead of the one failure it actually was.
 *
 * These are checked after EVERY measurement window, over exactly that
 * window's span, so listening to the log is automatic rather than
 * remembered per step. Any hit ends the pass on the spot, naming the line.
 */
const FATAL_LOG = [
  'native output handoff failed',
  'render handoff failed after start',
  'render start failed',
  'graph build refused',
  'graph build command failed',
  'cue rebuild failed',
  'cue rebuild activation failed',
  'render terminal',
  'seek receipt did not arrive',
  'graph cleanup uncertain',
  'cleanup is uncertain',
  'durable save failed'
]

class PassVoid extends Error {
  constructor(reason, lines) {
    super(`${reason}\n        ${lines.join('\n        ')}`)
    this.name = 'PassVoid'
    this.lines = lines
  }
}

async function assertNoFatalLog(dev, from, to, what) {
  const pattern = FATAL_LOG.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const raw = await dev.val(
    "__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => x.t >= " +
      from +
      ' && x.t <= ' +
      to +
      " && /" + pattern + "/.test(x.line)).map(x => x.source + ': ' + x.line.slice(0, 260))))"
  )
  const hits = JSON.parse(raw)
  if (hits.length)
    throw new PassVoid(
      `the app reported a fatal condition during "${what}" — every later metric would be measuring a session that is already broken`,
      hits
    )
}

function assertSameSession(dev, r, what) {
  if (dev.runId && r.run !== undefined && r.run !== dev.runId) {
    throw new Error(
      `the app reloaded its JS during "${what}" (run ${r.run} ≠ ${dev.runId}). ` +
        'Nothing under mobile/ may be edited while a run is in flight — Metro pushes a reload and the pass is void.'
    )
  }
}

const watch = async (dev, opts) => {
  const r = JSON.parse(await dev.val(watchExpr(opts), opts.ms + 20000))
  /* An action that threw is a harness bug, never a product measurement:
     say so instead of returning "it never happened". */
  if (r.err) throw new Error(`in-app action threw: ${r.err} :: ${opts.action}`)
  assertSameSession(dev, r, opts.action || 'measurement window')
  await assertNoFatalLog(dev, r.t0, Date.now(), opts.action || 'measurement window')
  return r
}

/** The same window, but with the host free to work while it is open. */
const watchBegin = (dev, opts) => dev.begin(watchExpr(opts), opts.ms + 20000)
const watchEnd = async (dev, token) => {
  const r = JSON.parse(await dev.end(token))
  if (r.err) throw new Error(`in-app action threw: ${r.err}`)
  assertSameSession(dev, r, 'overlapped measurement window')
  await assertNoFatalLog(dev, r.t0, Date.now(), 'overlapped measurement window')
  return r
}

/**
 * The longest run of samples during which the transport did not advance,
 * and when it started moving again. This is the "silence gap" a singer
 * hears: a transpose that stops the music for four seconds is four seconds
 * of gap whether the engine calls it a rebuild, a re-cue or a stall.
 */
function longestStall(out) {
  const s = out.filter((x) => x.pos !== null && x.t >= 0)
  let start = null
  let best = null
  for (let i = 1; i < s.length; i++) {
    const moved = s[i].pos > s[i - 1].pos + ADVANCE
    if (!moved) {
      if (start === null) start = s[i - 1].t
    } else if (start !== null) {
      const dur = s[i].t - start
      if (!best || dur > best.ms) best = { from: start, to: s[i].t, ms: dur, openEnded: false }
      start = null
    }
  }
  if (start !== null) {
    const last = s[s.length - 1]
    const dur = last.t - start
    if (!best || dur > best.ms) best = { from: start, to: last.t, ms: dur, openEnded: true }
  }
  return best ?? { from: 0, to: 0, ms: 0, openEnded: false }
}

const round = (n) => (n === null || n === undefined ? null : Math.round(n))
const fmt2 = (n) => (typeof n === 'number' ? n.toFixed(2) : '—')

/* ------------------------------------------------------------------ steps */

/** Wait for whatever detector the open kicked off, so the numbers after it
 *  are not measuring pYIN. Cheap after the first run of a given project:
 *  the results are written into project.json and the next open plans none. */
async function settleAnalysis(dev, capMs = 420000) {
  const t0 = Date.now()
  let idle = 0
  let last = null
  /* Three consecutive idle reads, not one: an open reports `busy: false` for
     a moment before the detector it planned actually starts, and a metric
     taken in that gap is measuring the run-up to pYIN. */
  while (Date.now() - t0 < capMs) {
    await sleep(1000)
    last = JSON.parse(await dev.val('JSON.stringify(__test.songSheet())'))
    idle = last.busy === false && last.analysisStage === null ? idle + 1 : 0
    if (idle >= 3) return { ms: Date.now() - t0, settled: true, sheet: last }
  }
  return { ms: Date.now() - t0, settled: false, sheet: last }
}

/** Where the transport is, in one line. Printed after every step that could
 *  stop it — a metric that reads "never advanced" three steps later cannot
 *  say which step was the one that stopped the music. */
async function where(dev) {
  const w = JSON.parse(
    await dev.val(
      'JSON.stringify((() => { const b = __test.backend; return { run: globalThis.__psRun, screen: __test.screen,' +
        ' t: b ? { pos: Math.round(b.position * 100) / 100, playing: b.playing, err: b.error } : null } })())'
    )
  )
  /* Same guard as every measurement window: if the JS reloaded, the numbers
     after this point belong to a different session and the pass is void. */
  assertSameSession(dev, w, 'a transport read')
  return w.t === null ? null : { ...w.t, screen: w.screen }
}
/** How many log lines matching `re` fall in [from, to]. `re` is a SUBSTRING
 *  pattern on purpose — dsp lines carry elapsed times and shapes that change,
 *  and a matcher pinned to a whole line goes quietly false the day one does. */
async function countLog(dev, re, from, to) {
  const raw = await dev.val(
    "__r('src/log.ts').logEntries().then(e => e.filter(x => x.t >= " +
      from +
      ' && x.t <= ' +
      to +
      " && " + re + ".test(x.line)).length)"
  )
  return raw
}

/** The app's own dsp/native-playback lines since `since`, for a note that has
 *  to explain itself — a refused seek is not actionable without them. */
async function logTail(dev, since, limit = 6) {
  const raw = await dev.val(
    "__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => x.t >= " +
      since +
      " && /^(dsp|native-playback|playback|engine)$/.test(x.source)).slice(-" +
      limit +
      ").map(x => x.source + ': ' + x.line.slice(0, 160))))"
  )
  const lines = JSON.parse(raw)
  return lines.length ? lines.join(' ⏎ ') : '(no dsp/native lines)'
}

const whereText = (w) => (w === null ? 'no backend' : `pos ${w.pos} playing=${w.playing}${w.err ? ` err=${w.err}` : ''}`)

/** Silence, twice over: the legacy engine's master bus and the backend's own
 *  master gain. Metronome clicks bypass both, which is why the scenario's
 *  first metronome touch is `volume: 0`. */
async function goQuiet(dev) {
  await dev.ev('try { __test.engine.master.gain.value = 0 } catch (e) {}')
  await dev.ev('try { __test.backend.setMasterGain(0) } catch (e) {}')
}

/** Give the device its voice back.
 *
 *  The legacy master gain lives on the AudioContext for the life of the
 *  PROCESS, so a run that only silences leaves the app mute until someone
 *  kills it — and the app still logs "play from 0:00 · Speaker · volume 55%"
 *  the whole time, so it reads as a playback bug rather than as this. On a
 *  simulator nobody notices; on a singer's own phone it is the suite handing
 *  back a broken app. Worse, native playback does NOT go through this bus, so
 *  the symptom is "legacy is silent and native works", which is a very
 *  convincing false lead. Restored on the way out of every pass, including a
 *  VOID one — that is the pass most likely to have left the phone muted. */
async function restoreVoice(dev) {
  await dev.ev('try { __test.engine.master.gain.value = 1 } catch (e) {}')
  await dev.ev('try { __test.backend.setMasterGain(1) } catch (e) {}')
}

/** Put the playback backend back the way the owner had it. Persisted, so a
 *  run that skips this leaves the device on whichever backend it tested
 *  last — on somebody's own phone, a setting they never chose. */
async function restorePreference(dev) {
  if (dev.preferenceBefore === undefined) return
  await dev.ev(
    `__ps.setNative(${dev.preferenceBefore ? 'true' : 'false'}).then(() => 1, () => 1)`
  )
}

/* ------------------------------------------------------------------- pass */

/**
 * One backend, start to finish. `expectKind` is what `backend.kind` must
 * report once the song is open — a pass that silently fell back to legacy
 * while claiming to measure the native graph is the failure mode this whole
 * suite exists to prevent.
 */
async function runPass(dev, { backend, expectKind, songs, log }) {
  const m = {}
  const flags = {}
  const notes = []
  const cpu = {}
  const openWindows = []
  const detail = {}

  const say = (line) => log(`  ${line}`)
  let observedKind = null
  /* Every CPU/memory phase is sampled WITH the host's 1-minute load beside
     it. A simulator or emulator number taken on a busy Mac describes the Mac;
     the load is what says so, printed in the table and judged as a rule
     (`hostQuiet`) when the device is host-bound. */
  const sample = async (phase, windowMs = 2000) => {
    const s = await dev.sample(windowMs)
    const h = hostLoad()
    const out = { ...s, load1: h.load1 }
    say(`${phase}: cpu ${s.cpuPct ?? '—'}% · host load ${h.load1}${isQuiet(h.load1) ? '' : ` (BUSY — quiet is ≤ ${QUIET_LOAD})`}`)
    return out
  }

  /* A void must not throw away what it already measured.
   *
   * A pass that dies at step nine has nine steps' worth of answers in it, and
   * those are exactly the steps a comparison is made of. Discarding them left
   * this suite unable to report ANYTHING for months of runs: legacy would
   * complete, native would reach the transpose and die, and the table printed
   * nothing at all — while twelve measured native metrics sat in `m` and were
   * dropped on the floor. The pass is still VOID and still says so; what it
   * stops doing is losing the evidence. */
  try {

  // ---- 1. cold start with the preference already decided -----------------
  const launch = await dev.launch()
  // The first launch is not the measured restart; `m.coldRestart` stays
  // UNDEFINED until step 14 sets it. Pre-seeding it to null made a step a
  // voided pass never reached print as a failed measurement instead of as
  // "not reached" — the one row that broke the three-verdict rule.
  await dev.attach()
  await dev.installHooks()
  /* Let Metro settle before a single number is taken. A file changed under
     `mobile/` seconds before the run starts arrives as a reload just after
     the app connects, which wipes the hooks and reads later as "the backend
     vanished". Three seconds and a re-check of the run id is enough to turn
     that into a clear failure at the top rather than a mystery in the middle. */
  await sleep(3000)
  await dev.installHooks()
  const before = JSON.parse(await dev.val('__ps.status()'))
  /* Whatever the owner had it set to. The preference is PERSISTED, and the
     pass order is legacy→native, so a run that does not put it back leaves a
     phone on the experimental backend nobody chose — the same class of harm
     as leaving the device muted, on a branch whose native path still has open
     field defects. Only the FIRST pass's reading is kept — not because the
     second would read back what this suite set (it restores at the end of
     every pass now, so normally it reads the owner's value), but because
     that restore is exactly what may not have run. The first reading is the
     last one taken before this suite touched anything. */
  if (dev.preferenceBefore === undefined) dev.preferenceBefore = before.enabled
  await dev.val(`__ps.setNative(${backend === 'native' ? 'true' : 'false'}).then(() => 1)`)
  const status = JSON.parse(await dev.val('__ps.status()'))
  say(`preference: ${before.enabled} → ${status.enabled} · supported=${status.supported} · ${status.detail}`)
  if (backend === 'native' && !(status.enabled && status.supported)) {
    throw new Error(`native playback is not available on this rig: ${status.detail}`)
  }
  await goQuiet(dev)

  await dev.ev("void __test.selectMode('phone')")
  let listed = false
  for (let i = 0; i < 60 && !listed; i++) {
    listed = (await dev.val(`(__test.projects || []).includes(${JSON.stringify(songs[0].name)})`)) === true
    if (!listed) {
      await dev.ev('void __test.refresh()')
      await sleep(500)
    }
  }
  if (!listed) {
    throw new Error(
      `"${songs[0].name}" never listed — libMode=${await dev.val('__test.libMode')} listError=${await dev.val('String(__test.listError)')}`
    )
  }

  // ---- 2. open the long song --------------------------------------------
  const open1 = await dev.openProject(songs[0].name)
  observedKind = open1.marks.kind
  m.openPlayer = round(open1.marks.player)
  m.openReady = round(open1.marks.ready)
  openWindows.push({ label: 'song A', from: open1.t0, to: open1.t0 + (open1.marks.ready ?? 0) + 5000 })
  assertSameSession(dev, open1, 'first open')
  say(`opened "${songs[0].name}" · kind=${open1.marks.kind} · player ${m.openPlayer} ms · ready ${m.openReady} ms`)
  if (open1.marks.kind !== expectKind) {
    const why = await dev.val(
      "__r('src/log.ts').logEntries().then(e => JSON.stringify(e.filter(x => /bypassed|refused/.test(x.line)).slice(-3).map(x => x.line)))"
    )
    throw new Error(`backend.kind is ${open1.marks.kind}, expected ${expectKind} — ${why}`)
  }
  await goQuiet(dev)
  const settled = await settleAnalysis(dev)
  say(
    `analysis settled: ${settled.settled ? `${(settled.ms / 1000).toFixed(0)} s` : 'STILL BUSY (capped)'}` +
      ` · key=${settled.sheet?.key ?? '—'} melody=${settled.sheet?.melody ?? '—'}`
  )
  const duration = await dev.val('__test.backend ? __test.backend.duration : 0')
  say(`duration ${duration.toFixed(1)} s · lanes ${await dev.val('__test.lanes().map(l => l.id).join(",")')}`)

  cpu['idle-in-player'] = await sample('idle-in-player')

  // ---- 3. Play -----------------------------------------------------------
  const play = await watch(dev, {
    ms: 20000,
    every: 30,
    action:
      "globalThis.__psPlay = null; b.play().then(r => { globalThis.__psPlay = r }, e => { globalThis.__psPlay = { error: String(e && e.message) } });",
    cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE
  })
  m.playAdvance = round(play.hit)
  detail.playOutcome = await dev.val('JSON.stringify(globalThis.__psPlay)')
  /* A Play that never moves the transport is a RED ROW, not a dead run. It
     used to throw, which threw away every later measurement in the session —
     and the later ones are exactly what says whether the failure was one
     moment or the whole evening. The pass carries on and the rule fails. */
  if (play.hit === null) {
    notes.push(`Play never advanced the transport · outcome ${detail.playOutcome} · log: ${await logTail(dev, play.t0)}`)
  }
  /* "First audible" has an honest answer only under the native graph, which
     logs the first render callback that produced sound. Legacy has no such
     line; the transport moving is the best it can say, and the README says
     so rather than the table inventing a number. */
  if (backend === 'native') {
    const audible = await dev.val(
      `__r('src/log.ts').logEntries().then(e => { const a = e.filter(x => /first audible callback/.test(x.line) && x.t >= ${play.t0}); return a.length ? a[0].t - ${play.t0} : null })`
    )
    m.playAudible = round(audible)
    if (audible === null) notes.push('no "first audible callback" line after Play')
  } else {
    m.playAudible = m.playAdvance
    detail.playAudibleIsProxy = true
  }
  flags.playStarted = play.hit !== null
  detail.playStarted = detail.playOutcome
  say(`Play → advancing ${m.playAdvance} ms · first audible ${m.playAudible} ms (${detail.playOutcome})`)
  /* The NEGOTIATED callback size — the number to want first when one backend
     costs more CPU than the other. Native logs it when the host output opens
     (`zcore AudioHost open · … · N frame nominal buffer`); legacy logs
     nothing and the table carries its render quantum, marked as the
     constant it is. */
  if (backend === 'native') {
    const frames = await dev.val(
      `__r('src/log.ts').logEntries().then(e => { const a = e.filter(x => /zcore AudioHost open/.test(x.line) && x.t >= ${play.t0}); const m = a.length ? /(\\d+) frame nominal buffer/.exec(a[a.length - 1].line) : null; return m ? Number(m[1]) : null })`
    )
    detail.callbackFrames = frames === null ? null : { frames, source: 'negotiated (app log)' }
    if (frames === null) notes.push('no "zcore AudioHost open" line after Play, so the callback size is unknown')
  } else {
    detail.callbackFrames = { frames: LEGACY_RENDER_QUANTUM, source: 'render quantum (RNAudioAPI constant)' }
  }
  say(`callback: ${detail.callbackFrames ? `${detail.callbackFrames.frames} frames · ${detail.callbackFrames.source}` : 'unknown'}`)
  await sleep(1500)
  cpu.playing = await sample('playing')

  // ---- 4. three metronome touches ---------------------------------------
  /* Through the SCREEN's handler, which is the one that persists — a save
     that throws is the field bug. Volume first so the click that touch 2
     switches on is inaudible. */
  const touches = [
    { patch: '{ volume: 0 }', read: '__test.met.volume', cond: 's.x === 0' },
    { patch: '{ click: true }', read: '__test.met.click', cond: 's.x === true' },
    { patch: '{ countInBars: 1 }', read: '__test.met.countInBars', cond: 's.x === 1' }
  ]
  const metMs = []
  for (const t of touches) {
    const r = await watch(dev, {
      ms: 15000,
      every: 30,
      action: `__test.changeMet(${t.patch});`,
      extra: t.read,
      cond: t.cond
    })
    metMs.push(r.hit)
    if (r.hit === null) notes.push(`metronome touch ${t.patch} never took effect`)
  }
  flags.metronomeSaved = metMs.every((x) => x !== null)
  m.metSave = metMs.some((x) => x === null) ? null : round(Math.max(...metMs))
  detail.metSaves = metMs.map(round)
  say(`metronome touches (volume/click/count-in): ${detail.metSaves.join(' / ')} ms · ${whereText(await where(dev))}`)
  /* Put the count-in back: from here on "advancing again" must mean the
     transport, not a metronome counting a bar in front of it. */
  await dev.ev('__test.changeMet({ countInBars: 0 })')

  /* And then WAIT for the music to come back. A metronome touch is a cue
     rebuild under the native graph and the transport is not Running while it
     is in flight — which is not a footnote, it is the metric: four seeks
     measured across that window came back as "The absolute playback seek is
     invalid" and read as a broken seek rather than as a metronome change
     that stopped the song. Legacy answers this in one sampler tick. */
  const metSettle = await watch(dev, {
    ms: 20000,
    every: 30,
    cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE
  })
  m.metSettle = round(metSettle.hit)
  if (metSettle.hit === null) {
    notes.push('the transport never came back after the metronome touches — pressed Play to carry on')
    await watch(dev, {
      ms: 20000,
      every: 30,
      action: 'b.play();',
      cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE
    })
  }
  say(`metronome touches → advancing again ${m.metSettle} ms · ${whereText(await where(dev))}`)

  // ---- 5. four seeks -----------------------------------------------------
  const targets = [0.75, 0.2, 0.55, 0.1].map((f) => Math.round(duration * f * 100) / 100)
  const seekMs = []
  const pullbacks = []
  for (const target of targets) {
    /* Issue it the moment the control is live, not before. `capabilities.seek`
       is false while a structural graph swap owns the transport, and the SCREEN
       greys the scrub rail out for exactly that window — so a driver that seeks
       through it is measuring something no singer can do. The wait is inside
       the measured window, because being unable to seek for a second IS the
       singer's second. */
    const r = await watch(dev, {
      ms: 12000,
      every: 20,
      stopOnHit: false,
      // Must outlast the echo window below, or sampling stops before the
      // correction it is looking for can arrive.
      holdAfterHitMs: POLL_MS + 200,
      action: `(function go() { if (!b.capabilities || b.capabilities.seek) { b.seek(${target}) } else { setTimeout(go, 20) } })();`,
      extra: 'b.capabilities ? b.capabilities.seek : null',
      cond: `s.pos >= ${target} - 0.5 && s.pos <= ${target} + 1.5`
    })
    seekMs.push(r.hit)
    if (r.hit === null) {
      pullbacks.push(null)
      const why = await dev.val('String(__test.backend && __test.backend.error)')
      const live = r.out.find((x) => x.x === true)
      notes.push(
        `seek(${target}) never read back — backend.error=${why}, seek capability came back at ${live ? live.t + ' ms' : 'never'}` +
          ` · log: ${await logTail(dev, r.t0)}`
      )
      continue
    }
    /* A seek that reads its target and is then yanked backwards is the
       "re-anchor echo" the field build shows: the UI lands, then jumps to
       where the old graph thought it was.

       The window is DERIVED from the telemetry poll interval, never written
       down beside it. `hit` fires on the optimistic seek adoption, which is
       immediate, while the correction that would reveal an echo arrives on
       the next poll — uniformly distributed over one interval. A fixed 300 ms
       was strictly wider than that at a 200 ms poll and silently narrower
       than it the moment the interval moved: a quarter of seeks would have
       their correction land outside the window, each measuring a confident
       zero, and with four seeks a pass most runs would go green having looked
       at nothing. One interval plus a margin keeps it strictly wider, and
       still short enough not to trip over an ordinary loop wrap. */
    const echoWindowMs = POLL_MS + 100
    const win = r.out.filter(
      (s) => s.t >= r.hit && s.t <= r.hit + echoWindowMs && s.pos !== null
    )
    let peak = -Infinity
    let worst = 0
    for (const s of win) {
      peak = Math.max(peak, s.pos)
      worst = Math.max(worst, peak - s.pos)
    }
    pullbacks.push(Math.round(worst * 1000))
  }
  m.seekApply = seekMs.some((x) => x === null) ? null : round(Math.max(...seekMs))
  detail.seeks = seekMs.map(round)
  detail.pullbackMs = pullbacks
  flags.seekNoPullback = pullbacks.every((p) => p !== null && p <= 50)
  say(`seeks → target: ${detail.seeks.join(' / ')} ms · pull-back ${pullbacks.join(' / ')} ms · ${whereText(await where(dev))}`)

  // ---- 6. three lane ramps ----------------------------------------------
  const lanes = [
    { action: "b.setVolume('guitar', 0.35);", extra: "b.getTrackStates().filter(t => t.id === 'guitar').map(t => t.volume)[0]", cond: 'Math.abs(s.x - 0.35) < 1e-6' },
    { action: "b.setVolume('bass', 0.7);", extra: "b.getTrackStates().filter(t => t.id === 'bass').map(t => t.volume)[0]", cond: 'Math.abs(s.x - 0.7) < 1e-6' },
    { action: "b.setMuted('piano', true);", extra: "b.getTrackStates().filter(t => t.id === 'piano').map(t => t.muted)[0]", cond: 's.x === true' }
  ]
  const laneMs = []
  for (const l of lanes) {
    const r = await watch(dev, { ms: 8000, every: 20, action: l.action, extra: l.extra, cond: l.cond })
    laneMs.push(r.hit)
    if (r.hit === null) notes.push(`lane change never applied: ${l.action}`)
  }
  m.laneRamp = laneMs.some((x) => x === null) ? null : round(Math.max(...laneMs))
  detail.lanes = laneMs.map(round)
  say(`lane ramps → applied: ${detail.lanes.join(' / ')} ms · ${whereText(await where(dev))}`)

  // ---- 7. transpose +2 (host samples CPU while the window is open) -------
  const pitchToken = await watchBegin(dev, {
    ms: 16000,
    every: 30,
    stopOnHit: false,
    action: '__test.setPitchTempo(2, 100);'
  })
  cpu['pitch-change'] = await sample('pitch-change')
  const pitch = await watchEnd(dev, pitchToken)
  const stall = longestStall(pitch.out)
  m.pitchGap = round(stall.ms)
  detail.pitchStall = stall
  detail.pitchAfter = await dev.val('JSON.stringify(__test.backend ? __test.backend.pitchTempo : null)')
  flags.pitchResumed = !stall.openEnded
  say(
    `pitch +2 → longest stall ${m.pitchGap} ms${stall.openEnded ? ' (STILL STALLED at the end of the window)' : ''} · pitchTempo ${detail.pitchAfter}`
  )

  // ---- 8. training on, by time ------------------------------------------
  await dev.ev("__test.setTrainMode('time')")
  await sleep(800)
  const train = await watch(dev, { ms: 12000, every: 30, stopOnHit: false, action: '__test.armTraining();' })
  const trainStall = longestStall(train.out)
  m.trainGap = round(trainStall.ms)
  flags.trainingOn = (await dev.val('__test.trainingOn')) === true
  detail.trainingOn = `trainingOn=${flags.trainingOn} after a ${m.trainGap} ms stall`
  say(`training on → longest stall ${m.trainGap} ms · trainingOn=${flags.trainingOn} · ${whereText(await where(dev))}`)

  // ---- 9. pause / resume -------------------------------------------------
  const pause = await watch(dev, { ms: 6000, every: 20, stopOnHit: false, action: 'b.pause();', cond: '!s.playing' })
  m.pauseStop = round(pause.hit)
  detail.pauseDriftMs = null
  if (pause.hit !== null) {
    const after = pause.out.filter((s) => s.t >= pause.hit + 200 && s.pos !== null)
    const drift = after.length > 1 ? after[after.length - 1].pos - after[0].pos : 0
    detail.pauseDriftMs = Math.round(drift * 1000)
    flags.pauseHolds = Math.abs(drift) < 0.05
  } else {
    flags.pauseHolds = false
    notes.push('pause never reported stopped')
  }
  say(`pause → stopped ${m.pauseStop} ms · drift after ${detail.pauseDriftMs} ms`)

  const resume = await watch(dev, {
    ms: 20000,
    every: 30,
    action: 'b.play();',
    cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE
  })
  m.resumeAdvance = round(resume.hit)
  if (resume.hit === null) notes.push('resume never advanced the transport')
  say(`resume → advancing ${m.resumeAdvance} ms`)

  // ---- 10. background / foreground --------------------------------------
  say(`before backgrounding: ${whereText(await where(dev))}`)
  const posBefore = await dev.val('__test.backend ? __test.backend.position : null')
  const bgWindowFrom = await dev.val('Date.now()')
  const bg = await dev.background()
  /* The hold lasts about seven seconds. A two-second sample three seconds in
     compared two different seconds of it and flipped the rule by a point or
     two run after run while a per-thread top showed both backends at the
     same one thread (the main one, 10-14%) for the whole hold — so this
     phase is sampled over five seconds from early in the hold. (The iOS
     devices sample their own fixed window; the argument is Android's.) */
  await sleep(1000)
  cpu.backgrounded = await sample('backgrounded', 5000)
  /* A backgrounded app may legitimately be FROZEN, and then it cannot answer.
   *
   * On a real iPhone iOS suspends an app that is not playing audio, so its JS
   * thread stops and a CDP evaluate never returns — the driver hangs and the
   * whole pass dies at the one step whose ANSWER is "it was suspended". A
   * simulator never showed this because it does not suspend. And the two
   * backends differ here by design: native keeps rendering in the background,
   * legacy does not, so this is exactly the case that must not be an error.
   * Ask with a short deadline; silence IS the measurement. */
  const askBackgrounded = async (expression, fallback) => {
    try {
      // Both waits bounded: the evaluate's first reply AND the parked poll.
      return await dev.val(expression, 6000, 6000)
    } catch {
      return fallback
    }
  }
  const bgState = await askBackgrounded(
    "(() => { try { return __r('node_modules/react-native/index.js').AppState.currentState } catch (e) { return 'unknown' } })()",
    'suspended'
  )
  const posDuring = await askBackgrounded('__test.backend ? __test.backend.position : null', null)
  const playingDuring = await askBackgrounded('__test.backend ? __test.backend.playing : null', false)
  detail.background = `${bg.detail} · AppState=${bgState} · playing=${playingDuring} · position ${fmt2(posBefore)}→${fmt2(posDuring)}`
  /* Whether the transport was still running while backgrounded decides
     whether the backgrounded CPU/memory sample can be COMPARED at all: iOS
     native now keeps playing there by choice while legacy suspends, and
     "still rendering six lanes" against "stopped" is not a regression, it is
     two different jobs. `evaluate` turns that phase into an info line when
     the two backends disagree here. */
  detail.backgroundPlaying = playingDuring === true
  /* "suspended" is a background state too — the strongest one. A frozen JS
     thread is proof the app went to the background, not a failure to. */
  flags.survivedBackground =
    bgState === 'background' || bgState === 'inactive' || bgState === 'suspended'
  say(`background: ${detail.background}`)

  const fg = await dev.foreground()
  await sleep(1500)
  /* A device that was suspended dropped its inspector socket with no notice.
     Reconnect before the first read after coming back, or every remaining
     measurement fails as "WebSocket is not open" — an error that describes
     the driver, not the app. */
  if (typeof dev.ensureConnected === 'function') {
    const reconnected = await dev.ensureConnected()
    if (reconnected) say('  (reattached — the device had suspended the app and closed the inspector)')
  }
  const fgState = await dev.val("(() => { try { return __r('node_modules/react-native/index.js').AppState.currentState } catch (e) { return 'unknown' } })()")
  detail.foreground = `${fg.detail} · AppState=${fgState}`
  flags.samePidAcrossBackground = fg.samePid !== false
  // Without this the row prints a bare `false`, which is the least actionable
  // thing a failing rule can say; the pids are right there.
  detail.samePidAcrossBackground = detail.foreground
  await dev.ev('try { __test.backend.pause() } catch (e) {}')
  await sleep(800)
  const fgPlay = await watch(dev, {
    ms: 20000,
    every: 30,
    action: 'b.play();',
    cond: 'out.length > 1 && s.playing && s.pos > out[0].pos + ' + ADVANCE
  })
  m.foregroundPlay = round(fgPlay.hit)
  /* Backgrounding no longer tears the graph down — iOS keeps playing, Android
     pauses in place — so a `graph released` across this window, or a fresh
     `preparing graph` in front of the Play that comes back, is now a FAILURE
     rather than the expected cost of leaving the app. */
  detail.backgroundReleased = await countLog(dev, '/graph released/', bgWindowFrom, fgPlay.t0 + (fgPlay.hit ?? 0) + 500)
  detail.backgroundPrepared = await countLog(dev, '/preparing graph/', bgWindowFrom, fgPlay.t0 + (fgPlay.hit ?? 0) + 500)
  flags.backgroundKeepsTheGraph = detail.backgroundReleased === 0 && detail.backgroundPrepared === 0
  detail.backgroundKeepsTheGraph = `graph released=${detail.backgroundReleased} preparing graph=${detail.backgroundPrepared}`
  say(
    `foreground: ${detail.foreground} · Play → advancing ${m.foregroundPlay} ms · across background: graph released=${detail.backgroundReleased} preparing graph=${detail.backgroundPrepared}`
  )

  // ---- 11. run it out to the end ----------------------------------------
  const endWindowFrom = await dev.val('Date.now()')
  const endTarget = Math.round(Math.max(0, duration - 5) * 100) / 100
  await watch(dev, {
    ms: 12000,
    every: 20,
    action: `b.seek(${endTarget});`,
    cond: `s.pos >= ${endTarget} - 0.5`
  })
  const reachEnd = await watch(dev, {
    ms: 25000,
    every: 50,
    cond: `!s.playing && s.pos >= ${Math.round((duration - 0.75) * 100) / 100}`
  })
  detail.endReachedMs = round(reachEnd.hit)
  flags.stoppedAtEnd = reachEnd.hit !== null
  const endPos = await dev.val('__test.backend ? __test.backend.position : null')
  const endPlaying = await dev.val('__test.backend ? __test.backend.playing : null')
  say(
    `end of song: stopped=${flags.stoppedAtEnd} after ${detail.endReachedMs} ms · position ${fmt2(endPos)}/${duration.toFixed(2)} · playing=${endPlaying}`
  )
  if (endPlaying) await dev.ev('try { __test.backend.pause() } catch (e) {}')
  await sleep(600)

  /* The upper bound matters: the transport sits AT the end of the song here,
     so "position > 0.05" is already true before the seek lands and would
     hand back a zero. It has to be back near the top and moving. */
  const restart = await watch(dev, {
    ms: 20000,
    every: 30,
    action: 'b.seek(0); b.play();',
    cond: `out.length > 1 && s.playing && s.pos > 0.05 && s.pos < ${Math.round(duration * 0.5)}`
  })
  m.endRestart = round(restart.hit)
  if (restart.hit === null) notes.push('Play after the end of the song never restarted the transport')
  /* Reaching the end parks the graph at the end rather than unloading it, so
     the Play that follows must not be preceded by a rebuild. Same rule as the
     background window, same reason: the singer pressing Play again is not
     asking for a six-lane graph to be built. */
  detail.endReleased = await countLog(dev, '/graph released/', endWindowFrom, restart.t0 + (restart.hit ?? 0) + 500)
  detail.endPrepared = await countLog(dev, '/preparing graph/', endWindowFrom, restart.t0 + (restart.hit ?? 0) + 500)
  flags.endOfSongParks = detail.endReleased === 0 && detail.endPrepared === 0
  detail.endOfSongParks = `graph released=${detail.endReleased} preparing graph=${detail.endPrepared}`
  say(
    `end → Play again: ${m.endRestart} ms · across the end: graph released=${detail.endReleased} preparing graph=${detail.endPrepared}`
  )

  // ---- 12. back to the catalog ------------------------------------------
  const back = await watch(dev, { ms: 15000, every: 30, action: '__test.back();', cond: "s.screen === 'catalog'" })
  m.backUnload = round(back.hit)
  await sleep(2500)
  cpu['after-leaving'] = await sample('after-leaving')
  if (backend === 'native') {
    const unloaded = await dev.val(
      `__r('src/log.ts').logEntries().then(e => e.filter(x => /unloaded generation/.test(x.line) && x.t >= ${back.t0}).length)`
    )
    flags.nativeUnloaded = unloaded >= 1
  }
  say(`back → catalog ${m.backUnload} ms`)

  // ---- 13. a different song, then back ----------------------------------
  for (let i = 0; i < 30; i++) {
    if ((await dev.val(`(__test.projects || []).includes(${JSON.stringify(songs[1].name)})`)) === true) break
    await dev.ev('void __test.refresh()')
    await sleep(500)
  }
  const open2 = await dev.openProject(songs[1].name)
  assertSameSession(dev, open2, 'second song open')
  m.secondOpen = round(open2.marks.player)
  openWindows.push({ label: 'song B', from: open2.t0, to: open2.t0 + (open2.marks.ready ?? 0) + 5000 })
  say(`second song → player ${m.secondOpen} ms · kind=${open2.marks.kind}`)
  await goQuiet(dev)
  await settleAnalysis(dev)
  await watch(dev, { ms: 15000, every: 30, action: '__test.back();', cond: "s.screen === 'catalog'" })
  await sleep(1500)

  // ---- 14. cold restart, then open the first song again -----------------
  /* The log lives in prefs and is replayed at launch, but take a copy first:
     merging two fetches by (t, line) is cheaper than trusting the replay to
     be complete. */
  const logBefore = JSON.parse(await dev.val("__r('src/log.ts').logEntries().then(e => JSON.stringify(e))"))
  // Clear the app's boot mark so the poll below cannot read the old one.
  await dev.ev("void __r('src/latency.ts').setStoredText('singz.boot', '')")
  await sleep(300)
  await dev.detach()
  const tRestart = Date.now()
  const launched = await dev.launch()
  /* Timed by the app's own boot mark where the device can poll it without
     the inspector (Android); host-side and coarse otherwise — the Metro
     target poll is on a 1 s cadence, wider than this rule's tolerance, so
     on those platforms the rule can only see differences of a poll or more. */
  if (dev.awaitBoot) {
    m.coldRestart = round(await dev.awaitBoot(launched.t0 ?? tRestart))
    await dev.attach()
  } else {
    await dev.attach()
    m.coldRestart = round(Date.now() - tRestart)
  }
  await dev.installHooks()
  await goQuiet(dev)
  await dev.ev("void __test.selectMode('phone')")
  for (let i = 0; i < 30; i++) {
    if ((await dev.val(`(__test.projects || []).includes(${JSON.stringify(songs[0].name)})`)) === true) break
    await dev.ev('void __test.refresh()')
    await sleep(500)
  }
  const open3 = await dev.openProject(songs[0].name)
  assertSameSession(dev, open3, 'reopen after restart')
  m.reopen = round(open3.marks.player)
  openWindows.push({ label: 'song A (after restart)', from: open3.t0, to: open3.t0 + (open3.marks.ready ?? 0) + 5000 })
  say(`restart ${m.coldRestart} ms · reopen → player ${m.reopen} ms · kind=${open3.marks.kind}`)
  await goQuiet(dev)
  if (open3.marks.kind !== expectKind) notes.push(`after restart the backend was ${open3.marks.kind}, not ${expectKind}`)

  // ---- 15. the log ------------------------------------------------------
  const logAfter = JSON.parse(await dev.val("__r('src/log.ts').logEntries().then(e => JSON.stringify(e))"))
  const seen = new Set()
  const entries = []
  for (const e of [...logBefore, ...logAfter]) {
    const k = `${e.t}|${e.source}|${e.line}`
    if (seen.has(k)) continue
    seen.add(k)
    entries.push(e)
  }
  entries.sort((a, b) => a.t - b.t)
  /* Bounded to THIS pass, and that bound is not decoration: the app's log is
     persisted (prefs on both phones, 400 lines) and replayed at launch, so an
     unwindowed count reads lines written days ago by another build. It was
     found reporting `graph build refused=1` against the LEGACY pass, which
     prepares no graph and cannot refuse one — the line belonged to a field
     session that ran before the APK under test was even installed. A count
     that can be non-zero for a backend incapable of producing it is not a
     measurement. `openWindows` was already windowed; these three were not. */
  /* The bound carries a skew allowance because the two sides of the
     comparison are two clocks: `launch.t0` is the HOST's and `e.t` is the
     device's. Measured on this emulator the device ran 485 ms behind, so a
     bare `>= launch.t0` would clip a line the app wrote moments after start.
     Five seconds swallows that without re-admitting anything stale — the
     lines this exists to exclude are hours or days old, not seconds. */
  const passFrom = launch.t0 - 5000
  const countAll = (re) => entries.filter((e) => e.t >= passFrom && re.test(e.line)).length
  const counts = {
    refused: countAll(/graph build refused/),
    cueFailed: countAll(/cue rebuild failed/),
    durableFailed: countAll(/durable save failed/),
    preparePerOpen: openWindows.map((w) => ({
      label: w.label,
      n: entries.filter((e) => /preparing graph/.test(e.line) && e.t >= w.from && e.t <= w.to).length
    }))
  }
  flags.noRefusals = counts.refused === 0
  flags.noCueFailures = counts.cueFailed === 0
  flags.noDurableSaveFailures = counts.durableFailed === 0
  flags.onePreparePerOpen =
    backend === 'legacy'
      ? counts.preparePerOpen.every((o) => o.n === 0)
      : counts.preparePerOpen.every((o) => o.n === 1)
  say(
    `log: graph build refused=${counts.refused} · cue rebuild failed=${counts.cueFailed} · durable save failed=${counts.durableFailed} · preparing graph per open ${counts.preparePerOpen.map((o) => `${o.label}=${o.n}`).join(', ')}`
  )
  /* A host-bound device's CPU and memory phases are only a measurement when
     the host was quiet through every one of them. This is judged per PASS:
     a busy host during the legacy pass alone poisons the comparison just as
     surely. A phone is never host-bound and gets no such rule. */
  if (dev.hostBound) {
    const busy = CPU_PHASES.filter((p) => cpu[p] && !isQuiet(cpu[p].load1))
    flags.hostQuiet = busy.length === 0
    detail.hostQuiet =
      CPU_PHASES.map((p) => `${p}=${cpu[p] ? cpu[p].load1 : '—'}`).join(' ') +
      ` (quiet ≤ ${QUIET_LOAD})` +
      (busy.length ? ` — BUSY during ${busy.join(', ')}: those CPU/memory rows describe the host, not the app` : '')
  }

  await watch(dev, { ms: 15000, every: 30, action: '__test.back();', cond: "s.screen === 'catalog'" })
  /* Before the socket closes, not after. The runner's `finally` also calls
     this, but by then `detach()` has closed the inspector and `ws.send` on a
     closed socket THROWS — swallowed by that finally's catch. So the only
     path that restored audio was the VOID one, and a perfectly green run left
     the device mute for the life of the process: exactly the harm this was
     written to prevent, inverted. */
  await restoreVoice(dev)
  await restorePreference(dev)
  await dev.detach()

  return { backend, kind: open1.marks.kind, metrics: m, flags, counts, cpu, detail, notes, launchPid: launch.pid }
  } catch (error) {
    if (error && error.name === 'PassVoid') {
      error.partial = {
        backend,
        kind: observedKind,
        metrics: m,
        flags,
        counts: {},
        cpu,
        detail,
        notes,
        launchPid: null,
        voided: true
      }
    }
    throw error
  }
}

/* ------------------------------------------------------------------ rules */

const budget = (legacy) => Math.max(50, legacy * 0.1)

function evaluate(legacy, native) {
  const rows = []
  /* A step a voided pass never REACHED is not a failed step. Scoring it as
     one buries the handful of real findings under a column of NaN and makes
     the table read as a catastrophe when the truth is "it stopped here". A
     measurement that was attempted and came back empty is still a failure —
     the two are different and the table has to say which. */
  const reached = (pass, key) =>
    !(pass.voided === true && pass.metrics[key] === undefined)
  const value = (pass, key) => {
    const raw = pass.metrics[key]
    return raw === undefined ? null : raw
  }
  for (const spec of METRICS) {
    const l = value(legacy, spec.key)
    const n = value(native, spec.key)
    const unreached =
      (!reached(legacy, spec.key) && ' — legacy stopped before this step') ||
      (!reached(native, spec.key) && ' — native stopped before this step')
    if (unreached) {
      rows.push({
        rule: `${spec.label}: NOT REACHED${unreached}`,
        ok: null,
        detail: `legacy ${l ?? '—'} ms · native ${n ?? '—'} ms`
      })
      continue
    }
    if (spec.rule === 'absolute') {
      rows.push({
        rule: `${spec.label} < ${spec.limit} ms (absolute; not compared)`,
        ok: n !== null && n < spec.limit,
        detail: `native ${n} ms · legacy ${l} ms · ceiling ${spec.limit} ms`
      })
      continue
    }
    if (spec.rule !== 'compare') continue
    if (l === null || n === null) {
      rows.push({ rule: spec.label, ok: false, detail: `missing measurement (legacy ${l}, native ${n})` })
      continue
    }
    const allowed = l + budget(l)
    rows.push({
      rule: `${spec.label}: native ≤ legacy + max(50 ms, 10%)`,
      ok: n <= allowed,
      detail: `native ${n} ms vs legacy ${l} ms (budget ${Math.round(allowed)} ms, ${n - l >= 0 ? '+' : ''}${n - l} ms)`
    })
  }

  for (const phase of CPU_PHASES) {
    const l = legacy.cpu[phase]
    const n = native.cpu[phase]
    if (!l || !n) continue
    /* Only compare a phase the two backends spent doing the same thing. */
    const comparable =
      phase !== 'backgrounded' || legacy.detail.backgroundPlaying === native.detail.backgroundPlaying
    if (l.cpuPct !== null && n.cpuPct !== null) {
      if (!comparable) {
        rows.push({
          rule: `CPU (${phase}): NOT compared — the backends were not doing the same thing`,
          ok: null,
          uncompared: true,
          detail:
            `native ${n.cpuPct}% (transport ${native.detail.backgroundPlaying ? 'still playing' : 'stopped'})` +
            ` vs legacy ${l.cpuPct}% (transport ${legacy.detail.backgroundPlaying ? 'still playing' : 'stopped'})`
        })
      } else {
        /* The tolerance is the sample's own quantum: two scheduler ticks over
           its window (1.0 point at 2 s, 0.4 at 5 s on Android; the iOS
           samplers report no tick and keep zero). Eight POCO runs flipped
           the backgrounded rule by one to three ticks while exact per-thread
           tick deltas over the whole hold showed the two backends on the
           same threads at the same cost — two utime+stime windows taken at
           different moments cannot resolve less than their quantum, and a
           rule that asks them to is decided by which second it lands on. */
        const tol = Math.max(n.tickPct ?? 0, l.tickPct ?? 0) * 2
        const budget = Math.round((l.cpuPct + tol) * 10) / 10
        rows.push({
          rule: tol > 0 ? `CPU (${phase}): native ≤ legacy + 2 ticks` : `CPU (${phase}): native ≤ legacy`,
          ok: n.cpuPct <= budget,
          detail: tol > 0
            ? `native ${n.cpuPct}% vs legacy ${l.cpuPct}% (budget ${budget}%, tick ${Math.max(n.tickPct ?? 0, l.tickPct ?? 0)} pt)`
            : `native ${n.cpuPct}% vs legacy ${l.cpuPct}%`
        })
      }
    }
    const memKey = n.pssMb !== null && n.pssMb !== undefined ? 'pssMb' : 'rssMb'
    if (l[memKey] !== null && n[memKey] !== null && l[memKey] !== undefined && n[memKey] !== undefined) {
      const label = memKey === 'pssMb' ? 'PSS' : 'RSS'
      rows.push(
        comparable
          ? {
              rule: `${label} (${phase}): native ≤ legacy`,
              ok: n[memKey] <= l[memKey],
              detail: `native ${n[memKey]} MB vs legacy ${l[memKey]} MB`
            }
          : {
              rule: `${label} (${phase}): NOT compared — the backends were not doing the same thing`,
              ok: null,
              uncompared: true,
              detail: `native ${n[memKey]} MB vs legacy ${l[memKey]} MB`
            }
      )
    }
  }

  const boolRules = [
    /* Both of these used to be computed and never judged — the pid one while
       ios.cjs claimed "the pid is asserted on both edges anyway". What
       actually happened was that the word RESTARTED appeared inside a printed
       line and nothing failed, so a background cycle that restarted the app —
       the case that makes every later metric a different process — passed. */
    ['samePidAcrossBackground', 'the app was not restarted by backgrounding'],
    ['trainingOn', 'training actually turned on'],
    ['seekNoPullback', 'no seek pull-back over 50 ms in the 300 ms after the target is read'],
    ['metronomeSaved', 'every metronome touch was accepted'],
    ['pitchResumed', 'the transport was moving again before the pitch window closed'],
    ['pauseHolds', 'pause holds the position'],
    ['survivedBackground', 'the app actually went to the background'],
    ['playStarted', 'Play moved the transport'],
    ['stoppedAtEnd', 'playback stopped at the end of the song'],
    ['backgroundKeepsTheGraph', 'backgrounding releases no graph and Play back needs no rebuild'],
    ['endOfSongParks', 'the end of the song parks the graph — Play again needs no rebuild'],
    ['noRefusals', 'no "graph build refused" in the whole session'],
    ['noCueFailures', 'no "cue rebuild failed" in the whole session'],
    ['noDurableSaveFailures', 'no "durable save failed" in the whole session'],
    ['onePreparePerOpen', 'exactly one "preparing graph" per open (native) / none (legacy)'],
    ['hostQuiet', 'the host was quiet (1-min load ≤ QUIET_LOAD) through every CPU/memory phase']
  ]
  for (const [key, label] of boolRules) {
    for (const pass of [legacy, native]) {
      if (pass.flags[key] === undefined) continue
      rows.push({
        rule: `${label} — ${pass.backend}`,
        ok: pass.flags[key] === true,
        detail: JSON.stringify(pass.detail[key] ?? pass.flags[key])
      })
    }
  }
  if (native.flags.nativeUnloaded !== undefined) {
    rows.push({
      rule: 'leaving the player unloads the native generation',
      ok: native.flags.nativeUnloaded === true,
      detail: `"unloaded generation" lines after back(): ${native.flags.nativeUnloaded}`
    })
  }
  return rows
}

/* --------------------------------------------------------------- printing */

const pad = (s, n) => String(s === null || s === undefined ? '—' : s).padEnd(n)
const padL = (s, n) => String(s === null || s === undefined ? '—' : s).padStart(n)

function renderTables(platformLabel, legacy, native, rows) {
  const out = []
  out.push('')
  out.push(`==== ${platformLabel} · timings (ms) ====`)
  out.push(`${pad('metric', 44)} ${padL('legacy', 8)} ${padL('native', 8)} ${padL('Δ', 8)}  verdict`)
  for (const spec of METRICS) {
    /* undefined and null mean different things here. `null` is a measurement
       that was ATTEMPTED and came back empty; `undefined` on a voided pass is
       a step the run never got to. Only the first is a finding — printing the
       second as "OVER by NaN" is how a partial table turns two real problems
       into eighteen imaginary ones. */
    const rawL = legacy.metrics[spec.key]
    const rawN = native.metrics[spec.key]
    const stopped =
      (legacy.voided === true && rawL === undefined) || (native.voided === true && rawN === undefined)
    const l = rawL === undefined ? null : rawL
    const n = rawN === undefined ? null : rawN
    let verdict = ''
    if (stopped) verdict = 'not reached — the run stopped earlier'
    else if (spec.rule === 'report') verdict = 'reported · not compared'
    else if (spec.rule === 'absolute') {
      verdict = n === null ? 'no measurement' : n < spec.limit ? `under ${spec.limit} ms` : `OVER ${spec.limit} ms`
      verdict += ' · not compared'
    } else if (l === null || n === null) verdict = 'missing'
    else verdict = n <= l + budget(l) ? 'ok' : `OVER by ${Math.round(n - l - budget(l))} ms`
    const delta = l === null || n === null ? null : `${n - l >= 0 ? '+' : ''}${n - l}`
    out.push(`${pad(spec.label, 44)} ${padL(l, 8)} ${padL(n, 8)} ${padL(delta, 8)}  ${verdict}`)
  }

  out.push('')
  out.push(`==== ${platformLabel} · CPU and memory (HOST-side numbers — see README) ====`)
  const cbOf = (p) => (p.detail.callbackFrames ? `${p.detail.callbackFrames.frames} frames · ${p.detail.callbackFrames.source}` : 'unknown')
  out.push(`callback size: legacy ${cbOf(legacy)} · native ${cbOf(native)}`)
  out.push(
    `${pad('phase', 20)} ${padL('legacy %', 10)} ${padL('native %', 10)} ${padL('legacy MB', 11)} ${padL('native MB', 11)}` +
      ` ${padL('load@legacy', 12)} ${padL('load@native', 12)}`
  )
  for (const phase of CPU_PHASES) {
    const l = legacy.cpu[phase] ?? {}
    const n = native.cpu[phase] ?? {}
    const memOf = (s) => (s.pssMb !== null && s.pssMb !== undefined ? s.pssMb : s.rssMb)
    /* The host's 1-minute load when each side's sample was taken. A "!"
       marks a busy host: that row's numbers describe the Mac, not the app. */
    const loadOf = (s) => (s.load1 === null || s.load1 === undefined ? null : `${s.load1}${isQuiet(s.load1) ? '' : ' !'}`)
    out.push(
      `${pad(phase, 20)} ${padL(l.cpuPct, 10)} ${padL(n.cpuPct, 10)} ${padL(memOf(l), 11)} ${padL(memOf(n), 11)}` +
        ` ${padL(loadOf(l), 12)} ${padL(loadOf(n), 12)}`
    )
  }
  out.push(`(load is the host's 1-minute average; quiet is ≤ ${QUIET_LOAD}, set QUIET_LOAD to move it)`)

  out.push('')
  out.push(`==== ${platformLabel} · rules ====`)
  /* Three verdicts, not two. `ok: null` is a step the run never reached, and
     counting it as a failure would drown the real ones — the whole point of
     printing a partial table is that the handful of genuine findings stay
     visible. It is not counted as a pass either. */
  for (const r of rows)
    out.push(`${r.ok === null ? '  -- ' : r.ok ? 'PASS' : 'FAIL'}  ${r.rule}\n        ${r.detail}`)
  /* A row the run DID reach but deliberately did not compare (`uncompared`:
     a backgrounded phase where the two backends were doing different things)
     is a third thing again, and used to be summarized as "the run stopped
     early" when both passes had run to the end. */
  const judged = rows.filter((r) => r.ok !== null)
  const bad = judged.filter((r) => !r.ok)
  const uncompared = rows.filter((r) => r.ok === null && r.uncompared).length
  const skipped = rows.length - judged.length - uncompared
  out.push('')
  out.push(
    `${platformLabel}: ${judged.length - bad.length}/${judged.length} rules pass` +
      (uncompared ? ` · ${uncompared} not compared` : '') +
      (skipped ? ` · ${skipped} never reached (the run stopped early)` : '')
  )
  for (const pass of [legacy, native]) {
    if (pass.notes.length) out.push(`  notes (${pass.backend}): ${pass.notes.join(' | ')}`)
  }
  return out.join('\n')
}

module.exports = {
  restoreVoice,
  restorePreference,
  METRICS,
  CPU_PHASES,
  hooksExpr,
  assertSameSession,
  runPass,
  evaluate,
  renderTables,
  watchExpr,
  longestStall
}
