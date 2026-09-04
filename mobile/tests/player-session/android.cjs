/*
 * The Android half of player-session: adb, the external phone-library root,
 * /proc CPU accounting, and the one rule that makes this platform different
 * from iOS —
 *
 *   NEVER EVALUATE JS OVER CDP WHILE A SONG IS LOADING, AND NEVER HANG UP
 *   MID-LOAD. The Hermes inspector segfaults the app in the middle of a
 *   `decodeAudioData` (SIGSEGV at 0x0 on mqt_v_js in libhermesvm, 3/3
 *   reproducible; the same load never fails unpolled, 4/4), and CLOSING the
 *   socket during a load does exactly the same thing. The socket may sit
 *   attached and idle across a whole load — it may neither speak nor hang up.
 *
 * So `openProject` here fires the in-app opener and then goes quiet, polling
 * the `singz.ps` text pref through `run-as` (the app's own private
 * shared_prefs, the same store `singz.crumb` uses) until the marks appear.
 * Not one CDP frame crosses the wire while stems are decoding.
 *
 * The other Android traps, each already paid for once and all of them
 * checked at startup rather than discovered halfway through a run:
 *  - the installed APK must be DEBUGGABLE and must be THIS tree's build;
 *  - Metro's bundles are PER PLATFORM, so a Metro warm for iOS still builds
 *    Android from cold — longer than the app's patience, surfacing as "no
 *    debugger target" from a dev server that answers packager-status
 *    perfectly. Pre-build it with a plain HTTP request first;
 *  - a project folder pushed into the external files dir belongs to `shell`
 *    and the app simply skips it in a `continue` — no throw, no listError.
 *    `grantExternal` chowns it back on an emulator (android-lib.cjs);
 *  - `cmd media_session volume --set` silently no-ops on API 36; twenty
 *    VOLUME_DOWN keyevents are what actually mute an emulator, and a real
 *    phone's volume is not ours to touch (android-lib.cjs decides which).
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { execFileSync, execSync } = require('child_process')
const { connect, sleep } = require('./cdp.cjs')
const { hooksExpr } = require('./scenario.cjs')
const { PKG, dataDir, extFilesDir, isEmulator, silenceDevice, grantExternal } = require('../android-lib.cjs')

const ADB = process.env.ADB || path.join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb')

const CLOCK_TICK = 100 // getconf CLK_TCK on every Android image in the fleet

function bootedSerial() {
  const out = execFileSync(ADB, ['devices'], { encoding: 'utf8' })
  const rows = out
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r[1] === 'device')
  if (!rows.length) return null
  // An emulator is preferred over a real phone: this suite writes into the
  // library and mutes the device, neither of which belongs on somebody's own
  // handset unless they asked for it (ANDROID_SERIAL does that).
  const emu = rows.find((r) => /^emulator-/.test(r[0]))
  return (emu ?? rows[0])[0]
}

function createDevice({ serial, port, log, mobileRoot }) {
  const SERIAL = serial || process.env.ANDROID_SERIAL || bootedSerial()
  if (!SERIAL) throw new Error('no Android device or emulator attached')
  const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8', maxBuffer: 3e7 })
  const shell = (cmd) => adb('shell', cmd)
  const LIB = `${extFilesDir(PKG)}/SingZ projects`

  let session = null
  let pid = null
  let deviceName = null

  const appPid = () => {
    const out = shell(`pidof ${PKG} || true`).trim()
    return out ? out.split(/\s+/)[0] : null
  }

  /* The launcher component, asked of the device. `monkey` looks like the
     generic answer and is not: it exits non-zero here, and `-n <pkg>/.Main`
     does not resolve because the CODE package (com.singzplayer) differs from
     the applicationId. */
  let launcher = null
  const launchIntent = () => {
    if (!launcher) {
      launcher = shell(`cmd package resolve-activity --brief ${PKG} | tail -1`).trim()
      if (!/\//.test(launcher)) throw new Error(`could not resolve a launcher activity for ${PKG}: ${launcher}`)
    }
    return launcher
  }

  const dev = {
    platform: 'android',
    label: `Android · ${SERIAL}`,
    serial: SERIAL,
    /* An emulator is a VM on this Mac, so its /proc numbers move with the
       host's load; a phone's are the phone's own and the host-load rule does
       not apply to them. */
    hostBound: /^emulator-/.test(SERIAL),

    preflight() {
      const model = shell('getprop ro.product.model').trim()
      const sdk = shell('getprop ro.build.version.sdk').trim()
      deviceName = process.env.ANDROID_DEVICE_NAME || model
      const info = shell(`dumpsys package ${PKG} | grep -E 'versionName|DEBUGGABLE' || true`)
      if (!/DEBUGGABLE/.test(info)) {
        throw new Error(
          `${PKG} on ${SERIAL} is not debuggable — no inspector, no run-as, nothing this suite needs. ` +
            'Install the debug build (or point ANDROID_PKG at the side-by-side .debug one).'
        )
      }
      /* A stale binary reports green: confirm the installed APK is the one
         this tree just built, by hash, not by version string. */
      const local = path.join(mobileRoot, 'android/app/build/outputs/apk/debug/app-debug.apk')
      let apkNote = 'no local app-debug.apk to compare against'
      if (fs.existsSync(local)) {
        const localMd5 = execSync(`md5 -q ${JSON.stringify(local)}`).toString().trim()
        const remotePath = shell(`pm path ${PKG} | head -1`).trim().replace(/^package:/, '')
        const remoteMd5 = remotePath ? shell(`md5sum ${JSON.stringify(remotePath)}`).trim().split(/\s+/)[0] : ''
        apkNote =
          localMd5 === remoteMd5
            ? `installed APK matches this tree (${localMd5.slice(0, 8)})`
            : `INSTALLED APK IS NOT THIS TREE'S BUILD (device ${remoteMd5.slice(0, 8)} vs local ${localMd5.slice(0, 8)})`
        if (localMd5 !== remoteMd5 && process.env.ALLOW_STALE_APK !== '1') {
          throw new Error(
            `${apkNote}. A run against a binary that predates the change under test is worse than no run: ` +
              'rebuild and reinstall, or set ALLOW_STALE_APK=1 if you really mean to measure the installed one.'
          )
        }
      }
      log(`${model} · API ${sdk} · ${info.trim().split('\n')[0].trim()} · ${apkNote}`)
      log(`silence: ${silenceDevice(adb)}`)
      /* A leftover `debug_http_host` is how an app silently attaches to a
         NEIGHBOURING worktree's Metro and serves its bundle — this emulator
         was found pointing at 8082 while this run's Metro was on 8081, which
         reads as "Unable to load script" and a dead app. Rewrite it to this
         run's port and put an `adb reverse` behind it so `localhost` works on
         an emulator and a real phone alike. */
      /* `adb root` FIRST and then reverse, in that order: rooting restarts
         adbd and drops every reverse mapping. Root is what makes the chown in
         `grantExternal` possible at all — without it a pushed project belongs
         to `shell`, the app's own storage sandbox will not hand it over, and
         `listProjects` skips it in a `continue`: no throw, no listError, the
         song simply is not in the library. */
      if (isEmulator(adb)) {
        try {
          adb('root')
          execFileSync(ADB, ['-s', SERIAL, 'wait-for-device'], { encoding: 'utf8' })
        } catch {
          log('adb root refused — a pushed project may not be readable by the app')
        }
      }
      adb('reverse', `tcp:${port}`, `tcp:${port}`)
      const prefsPath = `shared_prefs/${PKG}_preferences.xml`
      const wantHost = `localhost:${port}`
      const prefs = shell(`run-as ${PKG} cat ${prefsPath} 2>/dev/null || true`)
      const haveHost = /<string name="debug_http_host">([^<]*)<\/string>/.exec(prefs)?.[1] ?? null
      if (haveHost !== wantHost) {
        const xml =
          '<?xml version="1.0" encoding="utf-8" standalone="yes" ?>\n<map>\n' +
          `  <string name="debug_http_host">${wantHost}</string>\n</map>\n`
        execFileSync(ADB, ['-s', SERIAL, 'shell', `run-as ${PKG} sh -c 'cat > ${prefsPath}'`], { input: xml })
        shell(`am force-stop ${PKG}`)
        log(`dev server: ${haveHost ?? 'unset'} → ${wantHost} (app stopped so it re-reads it)`)
      } else {
        log(`dev server: ${wantHost}`)
      }
      /* Metro's bundles are per platform. Build Android's before the app
         asks for it, or the app gives up before the bundle exists. */
      log('pre-building the Android bundle…')
      return new Promise((res, rej) => {
        const req = http.get(
          `http://localhost:${port}/index.bundle?platform=android&dev=true&minify=false`,
          (r) => {
            r.resume()
            r.on('end', () => {
              log(`bundle pre-built (HTTP ${r.statusCode})`)
              res({ deviceName })
            })
          }
        )
        req.on('error', rej)
        req.setTimeout(600000, () => req.destroy(new Error('Metro never finished the Android bundle')))
      })
    },

    seed(songs) {
      let granted = false
      for (const song of songs) {
        const remote = `${LIB}/${song.name}`
        shell(`rm -rf ${JSON.stringify(remote)} 2>/dev/null || true`)
        shell(`mkdir -p ${JSON.stringify(remote + '/stems')}`)
        adb('push', path.join(song.dir, 'project.json'), `${remote}/project.json`)
        adb('push', path.join(song.dir, 'lyrics.json'), `${remote}/lyrics.json`)
        for (const f of fs.readdirSync(path.join(song.dir, 'stems'))) {
          adb('push', path.join(song.dir, 'stems', f), `${remote}/stems/${f}`)
        }
        granted = grantExternal(adb, remote, PKG) || granted
      }
      log(`seeded ${songs.length} projects into ${LIB}${granted ? ' (chowned to the app)' : ''}`)
    },

    async launch() {
      shell(`am force-stop ${PKG}`)
      await sleep(1500)
      const t0 = Date.now()
      pid = null // a stale pid from the previous launch would skip the wait
      shell(`am start -n ${launchIntent()}`)
      // 100 ms, not 500: this wait is inside the cold-restart timing, whose
      // tolerance is about half a second (see connect's pollMs).
      for (let i = 0; i < 300 && !pid; i++) {
        pid = appPid()
        if (!pid) await sleep(100)
      }
      return { pid, out: `pid ${pid}`, t0 }
    },

    /** The app's own boot mark (CatalogScreen writes `singz.boot` on mount),
     *  polled through run-as at 100 ms: a cold restart timed in-app, with
     *  no inspector traffic on a booting JS thread and a quantum under the
     *  rule's tolerance — the host-side attach used to be the timing, and
     *  its one-second target poll flipped the rule by a whole poll. */
    async awaitBoot(t0, maxMs = 60000) {
      const deadline = Date.now() + maxMs
      while (Date.now() < deadline) {
        let xml = ''
        try {
          xml = shell(`run-as ${PKG} cat shared_prefs/singz.xml 2>/dev/null || true`)
        } catch {}
        const hit = /<string name="(?:txt:)?singz\.boot">([\s\S]*?)<\/string>/.exec(xml)
        if (hit && hit[1].trim()) return Date.now() - t0
        await sleep(100)
      }
      throw new Error('the app never wrote its boot mark (singz.boot)')
    },

    async attach() {
      /* Metro DECORATES an Android device name — "sdk_gphone64_arm64 - 16 -
         API 36" for a device whose `ro.product.model` is
         "sdk_gphone64_arm64" — so an exact match (which is right on iOS)
         finds nothing here. Match the appId AND the model as a prefix: the
         appId alone would take a second emulator running the same package. */
      const model = deviceName
      session = await connect({
        port,
        label: `${PKG} on "${model}"`,
        match: (t) => t.appId === PKG && String(t.deviceName || '').startsWith(model)
      })
      dev.ev = session.ev
      dev.val = session.val
      dev.begin = session.begin
      dev.end = session.end
      for (let i = 0; i < 120; i++) {
        if ((await session.val('typeof __test')) === 'object' && (await session.val('typeof __r')) === 'function') break
        await sleep(500)
      }
      if ((await session.val('typeof __test')) !== 'object') throw new Error('__test never appeared')
      pid = appPid()
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

    /** Fire the opener, then SAY NOTHING until the pref says it is over. */
    async openProject(name, maxMs = 300000) {
      // Clear last open's marks so a stale value cannot be mistaken for this
      // one; an empty string reads as "not there yet" to the poller below.
      await session.ev(`__r('src/latency.ts').setStoredText('singz.ps', '')`)
      await sleep(400)
      // Deliberately NOT awaited over CDP — see the header.
      await session.ev(`void __ps.open(${JSON.stringify(name)}, ${maxMs})`)
      const deadline = Date.now() + maxMs + 20000
      let raw = ''
      while (Date.now() < deadline) {
        await sleep(750)
        let xml = ''
        try {
          xml = shell(`run-as ${PKG} cat shared_prefs/singz.xml 2>/dev/null || true`)
        } catch {
          continue
        }
        /* `setTextPref` namespaces every key it writes — the entry is
           `txt:singz.ps`, not `singz.ps`. Accept both: the prefix is the
           native module's business, not this driver's. */
        const hit = /<string name="(?:txt:)?singz\.ps">([\s\S]*?)<\/string>/.exec(xml)
        if (hit && hit[1].trim()) {
          raw = hit[1]
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
          break
        }
      }
      if (!raw) throw new Error(`"${name}" never reported an open through singz.ps`)
      const r = JSON.parse(raw)
      if (r.marks.ready === undefined) throw new Error(`"${name}" never became ready: ${raw}`)
      return r
    },

    async background() {
      const was = pid
      shell('input keyevent 3')
      await sleep(1500)
      const now = appPid()
      return { detail: `HOME pressed (pid ${was} → ${now})`, // Two UNKNOWN pids are not 'the same pid': that comparison can only
        // ever pass, which is worse than not making it.
        samePid: was === null || now === null ? null : String(was) === String(now) }
    },

    async foreground() {
      const was = pid
      shell(`am start -n ${launchIntent()}`)
      await sleep(2000)
      const now = appPid()
      return {
        detail: `relaunched via ${launchIntent()} (pid ${was} → ${now}${String(was) === String(now) ? ', not restarted' : ', RESTARTED'})`,
        // Two UNKNOWN pids are not 'the same pid': that comparison can only
        // ever pass, which is worse than not making it.
        samePid: was === null || now === null ? null : String(was) === String(now)
      }
    },

    /** utime+stime over a known wall window — the only CPU number Android
     *  will give for one process without a profiler. PSS from meminfo, which
     *  is the figure Android itself uses when it decides who to kill. */
    async sample(windowMs = 2000) {
      const p = appPid()
      if (!p) return { cpuPct: null, rssMb: null, pssMb: null }
      const read = () => {
        const s = shell(`cat /proc/${p}/stat 2>/dev/null || true`).trim()
        if (!s) return null
        const fields = s.slice(s.lastIndexOf(')') + 2).split(/\s+/)
        return Number(fields[11]) + Number(fields[12]) // utime, stime (0-based after state)
      }
      const a = read()
      const t0 = Date.now()
      await sleep(windowMs)
      const b = read()
      const wall = (Date.now() - t0) / 1000
      const cpuPct = a === null || b === null ? null : Math.round(((b - a) / CLOCK_TICK / wall) * 1000) / 10
      // One scheduler tick over this window, in percentage points: the
      // resolution of the number above, which the rule that judges it needs.
      const tickPct = Math.round((100 / CLOCK_TICK / wall) * 100) / 100
      let pssMb = null
      try {
        const mem = shell(`dumpsys meminfo ${PKG} 2>/dev/null || true`)
        const hit = /TOTAL PSS:\s*(\d+)/.exec(mem) ?? /^\s*TOTAL\s+(\d+)/m.exec(mem)
        if (hit) pssMb = Math.round(Number(hit[1]) / 1024)
      } catch {}
      return { cpuPct, tickPct, rssMb: null, pssMb }
    }
  }

  return dev
}

module.exports = { createDevice, bootedSerial, ADB }
