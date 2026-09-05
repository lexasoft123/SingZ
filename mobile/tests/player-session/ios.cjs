/*
 * The iOS Simulator half of player-session: simctl, the container, `top`,
 * and the two things that had to be measured rather than assumed.
 *
 * 1. THE MAC'S DEFAULT OUTPUT MUST RUN AT 48 kHz. At 44.1 kHz the
 *    simulator's RemoteIO finalizes MaximumFramesPerSlice 4459
 *    (= 4096 x 48000/44100), above the prepared 4096, and the native host
 *    refuses the handoff — the whole native pass then fails as "the backend
 *    is legacy", which looks like a product bug and is not one. So probe the
 *    host's default output first and say so plainly. (docs/IOS-AUDIO.md; the
 *    native-playback-ios scratch driver carries the same warning as prose.)
 *
 * 2. BACKGROUND AND FOREGROUND, measured 2026-09-02 on iPhone 17 Pro / iOS
 *    26.5, because there was no precedent for either in this repo:
 *      - `simctl launch <udid> com.apple.Preferences` DOES background SingZ:
 *        its AppState goes `active` -> `background` and its pid is unchanged.
 *      - `simctl launch <udid> io.s-dev.singz` on an ALREADY RUNNING app
 *        foregrounds it WITHOUT restarting: same pid, AppState back to
 *        `active`, and `simctl` prints that same pid.
 *    So no `singz://` URL scheme is needed for this suite. The pid is
 *    asserted on both edges anyway — the day that stops being true, the
 *    suite says so instead of quietly measuring a fresh process.
 */
const fs = require('fs')
const path = require('path')
const { execSync, execFileSync } = require('child_process')
const { connect, sleep } = require('./cdp.cjs')
const { hooksExpr } = require('./scenario.cjs')

const BUNDLE = 'io.s-dev.singz'

/** The default OUTPUT device's rate, from CoreAudio's own inventory. */
function defaultOutputRate() {
  const raw = execSync('system_profiler SPAudioDataType -json 2>/dev/null', { encoding: 'utf8', maxBuffer: 8e6 })
  const items = JSON.parse(raw).SPAudioDataType?.[0]?._items ?? []
  const hit = items.find((d) => d.coreaudio_default_audio_output_device === 'spaudio_yes')
  return hit ? { name: hit._name, rate: Number(hit.coreaudio_device_srate) } : { name: null, rate: null }
}

/** This device's own Metro name, so the target filter has a real key. */
function deviceNameOf(udid) {
  const all = JSON.parse(execSync('xcrun simctl list devices --json', { encoding: 'utf8' })).devices
  for (const list of Object.values(all)) {
    const hit = list.find((d) => d.udid === udid)
    if (hit) return hit.name
  }
  return null
}

function bootedUdid() {
  const all = JSON.parse(execSync('xcrun simctl list devices --json', { encoding: 'utf8' })).devices
  for (const list of Object.values(all)) {
    const hit = list.find((d) => d.state === 'Booted')
    if (hit) return hit.udid
  }
  return null
}

function createDevice({ udid, port, log }) {
  const UDID = udid || process.env.SIM_UDID || bootedUdid()
  if (!UDID) throw new Error('no booted iOS simulator (and no SIM_UDID)')
  const NAME = process.env.SIM_DEVICE_NAME || deviceNameOf(UDID)
  if (!NAME) throw new Error(`cannot resolve a device name for ${UDID}`)

  let session = null
  let pid = null
  let bootMarkBefore = ''

  /** `singz.boot` off the app container's plist, '' when absent. plutil
   *  treats a dot as a key-path separator, hence the escape. */
  const readBootMark = () => {
    try {
      const mark = execFileSync(
        'plutil',
        ['-extract', 'singz\\.boot', 'raw', '-o', '-', path.join(container(), 'Library', 'Preferences', `${BUNDLE}.plist`)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim()
      return /Could not extract/.test(mark) ? '' : mark
    } catch {
      return ''
    }
  }

  /* Ask about THE pid simctl printed, never `pgrep` for the app: with two
   * simulators up there are two SingZPlayer processes and the wrong one
   * answers (that is how a memory driver once reported "release() freed
   * nothing"). */
  const alive = (p) => {
    if (!p) return false
    try {
      return execSync(`ps -o pid= -p ${p} 2>/dev/null || true`).toString().trim() !== ''
    } catch {
      return false
    }
  }

  const container = () =>
    execFileSync('xcrun', ['simctl', 'get_app_container', UDID, BUNDLE, 'data'], { encoding: 'utf8' }).trim()

  const dev = {
    platform: 'ios',
    label: `iOS · ${NAME}`,
    deviceName: NAME,
    udid: UDID,
    /* A simulator is a process on this Mac: its CPU and memory samples carry
       whatever else the Mac is doing, so the host-load rule applies. */
    hostBound: true,

    preflight() {
      const out = defaultOutputRate()
      if (out.rate !== 48000) {
        throw new Error(
          `the Mac's default output ("${out.name ?? 'unknown'}") runs at ${out.rate ?? '?'} Hz. ` +
            'The simulator\'s RemoteIO then finalizes a callback size outside the prepared bounds and the ' +
            'native handoff is refused — every native measurement here would be a fallback to legacy. ' +
            'Switch the default output to 48 kHz (Audio MIDI Setup) and re-run.'
        )
      }
      log(`default output: ${out.name} @ ${out.rate} Hz`)
      return { outputRate: out.rate }
    },

    /** Copy both staged projects into the app's Documents (the phone library
     *  on iOS). Wiped first so a run never inherits a half-written seed. */
    seed(songs) {
      const docs = path.join(container(), 'Documents')
      fs.mkdirSync(docs, { recursive: true })
      for (const song of songs) {
        const dest = path.join(docs, song.name)
        fs.rmSync(dest, { recursive: true, force: true })
        fs.cpSync(song.dir, dest, { recursive: true })
      }
      log(`seeded ${songs.length} projects into ${docs}`)
    },

    async launch() {
      // The mark the last boot wrote, so awaitBoot can wait for a DIFFERENT
      // one: neither the in-app clear (cfprefsd may not have flushed it) nor
      // the file edit below (cfprefsd may write its cache back) is proof
      // against reading the previous boot's mark; a changed value is.
      bootMarkBefore = readBootMark()
      const was = pid
      execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`)
      /* Wait for the process to be GONE, and make it so if it is not: with
         native playback holding an active audio session, `simctl terminate`
         returned while the process stayed up, `simctl launch` then merely
         fronted it, and the "restart" the rule timed was the dev client
         reloading its bundle inside the same pid — 7.7 s against legacy's
         real 4.8 s relaunch, and never a cold start at all. */
      const gone = () => !alive(was)
      const tTerm = Date.now()
      for (let i = 0; i < 30 && was && !gone(); i++) await sleep(100)
      let forced = false
      if (was && !gone()) {
        /* Still there 3 s after terminate: say so, keep a native stack sample
           of what it is doing (scratchpad-independent: beside the run's cwd),
           and force it. A restart timed past this point measured the wait for
           a process that would not die, not a boot. */
        forced = true
        try {
          const lingerFile = path.join(require('os').tmpdir(), `singz-exit-linger-${was}.txt`)
          execSync(`sample ${was} 1 1 -file ${lingerFile} 2>/dev/null`)
          log(`  launch: previous pid ${was} still up 3 s after terminate · stack sample in ${lingerFile}`)
        } catch {}
        try {
          execSync(`kill -9 ${was} 2>/dev/null || true`)
        } catch {}
        for (let i = 0; i < 30 && !gone(); i++) await sleep(100)
      }
      const exitMs = Date.now() - tTerm
      await sleep(400)
      /* The boot mark is removed from the plist FILE here, with the app dead:
         the scenario's in-app clear goes through cfprefsd, which had not
         flushed it to disk by the time the process was terminated, so the
         restart poll read the previous boot's mark and the rule measured
         384 ms for a boot that takes seconds. */
      try {
        execFileSync(
          'plutil',
          ['-remove', 'singz\\.boot', path.join(container(), 'Library', 'Preferences', `${BUNDLE}.plist`)],
          { stdio: 'ignore' }
        )
      } catch {}
      const t0 = Date.now()
      const out = execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`).toString().trim()
      pid = /:\s*(\d+)/.exec(out)?.[1] ?? null
      log(
        `  launch: previous pid ${was ?? '—'} ${was ? (forced ? `did NOT exit on terminate (forced after ${exitMs} ms)` : `exited in ${exitMs} ms`) : ''}` +
          ` · simctl launch ${Date.now() - t0} ms → pid ${pid}`
      )
      return { pid, out, t0 }
    },

    /** The app's own boot mark (CatalogScreen writes `singz.boot` on mount;
     *  on iOS `setTextPref` stores it under that key in the app's standard
     *  defaults and flushes synchronously), read off the container's plist
     *  at 100 ms: the cold restart timed in-app, as the Android driver does,
     *  instead of by the Metro target poll's one-second quantum. The FILE,
     *  not `simctl spawn defaults read` — the simulator's cfprefsd answered
     *  "does not exist" for a key the plist on disk plainly held. `plutil`
     *  treats a dot as a key-path separator, hence the escape. */
    async awaitBoot(t0, maxMs = 60000) {
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        const mark = readBootMark()
        if (mark && mark !== bootMarkBefore) {
          /* The restart is the STAMP minus the launch, not the moment the
             plist showed it: a simulator's app reads the Mac's own clock, so
             the two are one clock, and what the file's appearance adds is
             cfprefsd's write-back — 27 ms standalone, and EIGHT SECONDS
             inside a run (the unified log put the process start at
             13:52:15.7 and the app's stamp at 13:52:17.0; the poll saw it
             at 13:52:25), which the rule then compared at 10%. A stamp
             outside [t0, now] is not this launch's clock and the arrival
             time is kept. */
          const stamp = Number(mark)
          const seen = Date.now()
          return Number.isFinite(stamp) && stamp >= t0 && stamp <= seen ? stamp - t0 : seen - t0
        }
        await sleep(100)
      }
      throw new Error('the app never wrote a new boot mark (singz.boot)')
    },

    async attach() {
      session = await connect({ port, label: `"${NAME}"`, match: (t) => t.deviceName === NAME })
      dev.ev = session.ev
      dev.val = session.val
      dev.begin = session.begin
      dev.end = session.end
      for (let i = 0; i < 80; i++) {
        if ((await session.val('typeof __test')) === 'object' && (await session.val('typeof __r')) === 'function') break
        await sleep(500)
      }
      if ((await session.val('typeof __test')) !== 'object') throw new Error('__test never appeared')
    },

    async installHooks() {
      /* A fresh id per attach: every measurement window carries it back, so a
         Metro reload mid-pass is caught rather than silently measured. */
      dev.runId = `r${Date.now()}`
      await session.val(hooksExpr(dev.runId))
    },

    async detach() {
      if (session) session.close()
      session = null
    },

    /** iOS may poll over CDP throughout a load — it is Android's Hermes
     *  inspector that cannot be spoken to mid-decode, not this one. */
    async openProject(name, maxMs = 240000) {
      const raw = await session.val(`__ps.open(${JSON.stringify(name)}, ${maxMs})`, maxMs + 20000)
      const r = JSON.parse(raw)
      if (r.marks.ready === undefined) throw new Error(`"${name}" never became ready: ${raw}`)
      return r
    },

    async background() {
      const was = pid
      execSync(`xcrun simctl launch ${UDID} com.apple.Preferences`)
      await sleep(1500)
      const still = alive(was)
      return {
        detail: `Preferences launched · SingZ pid ${was} ${still ? 'still alive' : 'GONE'}`,
        samePid: still
      }
    },

    async foreground() {
      const was = pid
      const out = execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`).toString().trim()
      const now = /:\s*(\d+)/.exec(out)?.[1] ?? null
      await sleep(1500)
      return {
        detail: `relaunched in place (pid ${was} → ${now}${String(was) === String(now) ? ', not restarted' : ', RESTARTED'})`,
        // Two UNKNOWN pids are not 'the same pid': that comparison can only
        // ever pass, which is worse than not making it.
        samePid: was === null || now === null ? null : String(was) === String(now)
      }
    },

    /** `top -l 2` because the first sample is a since-boot average and is
     *  garbage, and `-s` so the second sample spans the WHOLE window the
     *  scenario asked for: top's default is one second, and a one-second
     *  window over a paused player catches the native session's two-second
     *  telemetry poll on every other sample — idle CPU read 1.4% against
     *  legacy's 0.9% on one run and 1.6% against 1.6% on the next, the
     *  quantum and not the backend. `ps` for the resident set, which is the
     *  number the other memory drivers in this directory report. */
    async sample(windowMs = 2000) {
      if (!pid) return { cpuPct: null, rssMb: null, pssMb: null }
      let cpuPct = null
      const windowSec = Math.max(1, Math.round(windowMs / 1000))
      try {
        const out = execSync(`top -l 2 -s ${windowSec} -pid ${pid} -stats pid,cpu,mem 2>/dev/null`, { encoding: 'utf8' })
        const lines = out.trim().split('\n').filter((l) => new RegExp(`^\\s*${pid}\\s`).test(l))
        if (lines.length) cpuPct = Number(lines[lines.length - 1].trim().split(/\s+/)[1])
      } catch {}
      /* The physical footprint — what iOS's jetsam decides on, the twin of
         the PSS the Android leg reads — not `ps -o rss=`: RSS keeps counting
         the pages the allocator has already marked reusable, and vmmap of
         the two backends idle in the player showed native 60 MB of exactly
         that (MALLOC_SMALL (empty), the decode's freed magazines) against
         legacy's 4 MB — 30 MB "heavier" by RSS while 19 MB lighter by
         footprint (532.6 vs 551.6 MB). `footprint -p` reads it in ~50 ms
         without suspending the process; vmmap --summary takes a second and
         does. */
      let footprintMb = null
      try {
        const out = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        const hit = /phys_footprint:\s*([\d.]+)\s*(MB|GB|KB)/.exec(out)
        if (hit) footprintMb = Math.round(Number(hit[1]) * (hit[2] === 'GB' ? 1024 : hit[2] === 'KB' ? 1 / 1024 : 1))
      } catch {}
      let rssMb = null
      try {
        rssMb = Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024)
      } catch {}
      // The resolution of top's printed %CPU: one tenth of a point over its
      // one-second interval. The CPU rule tolerates two of these, as it does
      // two scheduler ticks on Android.
      return { cpuPct, tickPct: 0.1, footprintMb, rssMb, pssMb: null }
    }
  }

  return dev
}

module.exports = { createDevice, defaultOutputRate, deviceNameOf, bootedUdid, BUNDLE }
