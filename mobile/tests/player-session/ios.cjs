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
      execSync(`xcrun simctl terminate ${UDID} ${BUNDLE} 2>/dev/null || true`)
      await sleep(1200)
      const t0 = Date.now()
      const out = execSync(`xcrun simctl launch ${UDID} ${BUNDLE}`).toString().trim()
      pid = /:\s*(\d+)/.exec(out)?.[1] ?? null
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
      const plist = path.join(container(), 'Library', 'Preferences', `${BUNDLE}.plist`)
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        let mark = ''
        try {
          mark = execFileSync('plutil', ['-extract', 'singz\\.boot', 'raw', '-o', '-', plist], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          }).trim()
        } catch {}
        if (mark && !/Could not extract/.test(mark)) return Date.now() - t0
        await sleep(100)
      }
      throw new Error('the app never wrote its boot mark (singz.boot)')
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
     *  garbage; `ps` for the resident set, which is the number the other
     *  memory drivers in this directory report. */
    async sample() {
      if (!pid) return { cpuPct: null, rssMb: null, pssMb: null }
      let cpuPct = null
      try {
        const out = execSync(`top -l 2 -pid ${pid} -stats pid,cpu,mem 2>/dev/null`, { encoding: 'utf8' })
        const lines = out.trim().split('\n').filter((l) => new RegExp(`^\\s*${pid}\\s`).test(l))
        if (lines.length) cpuPct = Number(lines[lines.length - 1].trim().split(/\s+/)[1])
      } catch {}
      let rssMb = null
      try {
        rssMb = Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024)
      } catch {}
      // The resolution of top's printed %CPU: one tenth of a point over its
      // one-second interval. The CPU rule tolerates two of these, as it does
      // two scheduler ticks on Android.
      return { cpuPct, tickPct: 0.1, rssMb, pssMb: null }
    }
  }

  return dev
}

module.exports = { createDevice, defaultOutputRate, deviceNameOf, bootedUdid, BUNDLE }
