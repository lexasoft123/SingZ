/*
 * The PHYSICAL iPhone half of player-session — everything ios.cjs does with
 * `simctl`, done with `devicectl` instead.
 *
 * It exists because a simulator cannot answer the questions a phone can. The
 * sim shares the Mac's CoreAudio, so its route, its latency and its CPU are
 * the Mac's; a handset has its own speaker, its own AVAudioSession and its
 * own thermal budget. Every native-playback defect found on this branch so
 * far was a device-inventory defect, and a simulator publishes one route.
 *
 * Four things differ from the simulator layer, and three of them are traps:
 *
 *  1. THE APP CONTAINER IS NOT A DIRECTORY ON THIS MAC. `simctl
 *     get_app_container` hands the sim layer a path it can cp into; a device
 *     needs `devicectl device copy to --domain-type appDataContainer`, which
 *     is a transfer per file tree and slower by a lot. Seeding six FLACs twice
 *     over is the single slowest step of a device run — budget for it rather
 *     than assuming the sim's timings.
 *
 *  2. THERE IS NO `top` AND NO `ps` FOR A PROCESS ON THE PHONE. The sim layer
 *     samples both because the sim's processes are ordinary Mac processes.
 *     Here `sample()` returns nulls, deliberately and honestly: a CPU or RSS
 *     column invented from the host would be a lie about the device, and the
 *     lie would look exactly like a measurement. Instruments is the tool that
 *     answers this, and it is not driveable from a script this cheap.
 *
 *  3. METRO'S TARGET NAME IS THE DEVICE'S OWN NAME, not a simulator model
 *     string, and it is whatever the owner called their phone. Resolve it
 *     from devicectl rather than assuming, then filter on it — with a sim, an
 *     emulator and a handset all attached, an unfiltered pick takes whichever
 *     answered first, which is how a driver once interrogated the wrong app
 *     entirely.
 *
 *  4. A DEBUG BUILD ON A DEVICE LOADS ITS BUNDLE OVER THE NETWORK, not over a
 *     loopback the way an emulator does with `adb reverse`. The phone must be
 *     on the same network as this Mac and must reach it on the Metro port; if
 *     it cannot, the app opens on a red screen and the driver's only symptom
 *     is "no debugger target", which looks identical to a cold bundle. The
 *     preflight checks reachability rather than letting that ambiguity stand.
 */
const { execSync, execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { connect, sleep } = require('./cdp.cjs')
const { hooksExpr } = require('./scenario.cjs')

const BUNDLE = 'io.s-dev.singz'

/** devicectl only speaks JSON through a FILE — its own help says that is the
 *  one supported interface for scripts, and stdout carries progress chatter
 *  that is not parseable. */
function devicectl(args, timeoutMs = 180000) {
  const out = path.join(os.tmpdir(), `devicectl-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  try {
    execFileSync('xcrun', ['devicectl', ...args, '--json-output', out], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    // Keep the JSON even on failure: devicectl writes its diagnosis there.
    if (fs.existsSync(out)) {
      const body = JSON.parse(fs.readFileSync(out, 'utf8'))
      fs.rmSync(out, { force: true })
      const detail = body?.error?.userInfo?.NSLocalizedDescription?.string ?? body?.error?.localizedDescription
      throw new Error(`devicectl ${args[1] ?? args[0]} failed: ${detail ?? error.message}`)
    }
    throw error
  }
  const body = JSON.parse(fs.readFileSync(out, 'utf8'))
  fs.rmSync(out, { force: true })
  return body
}

/** Every paired, connected device, newest pairing first. */
function listDevices() {
  const body = devicectl(['list', 'devices'], 60000)
  return (body?.result?.devices ?? [])
    .filter((d) => d.connectionProperties?.tunnelState !== 'unavailable')
    .map((d) => ({
      id: d.identifier,
      udid: d.hardwareProperties?.udid ?? null,
      name: d.deviceProperties?.name ?? null,
      model: d.hardwareProperties?.marketingName ?? d.hardwareProperties?.productType ?? null,
      os: d.deviceProperties?.osVersionNumber ?? null
    }))
}

/** The one device a run should target, or null. `IOS_DEVICE` names it by
 *  identifier, udid or name — never guess when more than one is attached, for
 *  the same reason the Metro filter exists. */
function pickDevice() {
  const devices = listDevices()
  const wanted = process.env.IOS_DEVICE
  if (wanted) {
    const hit = devices.find((d) => d.id === wanted || d.udid === wanted || d.name === wanted)
    if (!hit) throw new Error(`IOS_DEVICE="${wanted}" matches none of: ${devices.map((d) => `${d.name} (${d.id})`).join(', ') || 'nothing attached'}`)
    return hit
  }
  if (devices.length === 0) return null
  if (devices.length > 1) {
    throw new Error(
      `${devices.length} iOS devices attached (${devices.map((d) => d.name).join(', ')}). ` +
        'Name one with IOS_DEVICE=<name|udid|identifier> — picking for you is how a run measures the wrong phone.'
    )
  }
  return devices[0]
}

/** Can the phone actually fetch a bundle from this Mac? A Debug device build
 *  loads over the network, and an unreachable Metro is indistinguishable from
 *  a cold one from the driver's side. */
function metroReachable(port) {
  return new Promise((resolve) => {
    const request = http.get(`http://localhost:${port}/status`, (response) => {
      let body = ''
      response.on('data', (c) => (body += c))
      response.on('end', () => resolve(body.includes('packager-status:running')))
    })
    request.on('error', () => resolve(false))
    request.setTimeout(4000, function () {
      this.destroy()
      resolve(false)
    })
  })
}

function lanAddress() {
  for (const name of ['en0', 'en1']) {
    try {
      const address = execSync(`ipconfig getifaddr ${name} 2>/dev/null`, { encoding: 'utf8' }).trim()
      if (address) return address
    } catch {}
  }
  return null
}

function createDevice({ port, log, device }) {
  const DEV = device || pickDevice()
  if (!DEV) throw new Error('no iOS device attached (and no IOS_DEVICE)')
  const NAME = process.env.IOS_DEVICE_NAME || DEV.name
  if (!NAME) throw new Error(`cannot resolve a Metro name for ${DEV.id}`)

  let session = null
  let pid = null

  /* The app's real pid, asked of the DEVICE.
   *
   * `devicectl device process launch` reports no process identifier, so the
   * launch path alone leaves it null — and a null pid compared against a null
   * pid is "unchanged", which makes the did-it-restart check pass without
   * ever looking at anything. `device info processes` does carry one, so ask
   * for it. A restart across backgrounding is precisely the case that makes
   * every later metric belong to a different process; a check that cannot
   * fail is worse than no check, because it reads as a result. */
  const pidOf = () => {
    try {
      const body = devicectl(['device', 'info', 'processes', '--device', DEV.id], 90000)
      const rows = body?.result?.runningProcesses ?? []
      const hit = rows.find((r) => String(r.executable ?? '').includes(`${BUNDLE}`) ||
                                   String(r.executable ?? '').endsWith('/SingZPlayer'))
      return hit?.processIdentifier ?? null
    } catch {
      return null
    }
  }

  const launchApp = (bundle, terminateExisting) => {
    const body = devicectl([
      'device',
      'process',
      'launch',
      '--device',
      DEV.id,
      ...(terminateExisting ? ['--terminate-existing'] : []),
      bundle
    ])
    return body?.result?.runningProcesses?.[0]?.processIdentifier ?? null
  }

  const bindSession = () => {
    dev.ev = session.ev
    dev.val = session.val
    dev.begin = session.begin
    dev.end = session.end
  }

  const dev = {
    platform: 'ios',
    label: `iOS · ${NAME}`,
    deviceName: NAME,
    udid: DEV.udid,
    identifier: DEV.id,
    physical: true,
    hostBound: false,

    async preflight() {
      /* Deliberately NOT the simulator's 48 kHz Mac-output check: that guards
         the sim's RemoteIO, which borrows this Mac's clock. A handset has its
         own, so the rule does not apply and asserting it here would refuse
         perfectly good runs. */
      if (!(await metroReachable(port))) {
        throw new Error(`Metro is not answering on localhost:${port} — start it before a device run`)
      }
      const lan = lanAddress()
      if (!lan) {
        throw new Error(
          'this Mac has no LAN address, so a Debug build on the phone cannot fetch its bundle. ' +
            'A device loads over the network — there is no adb-reverse equivalent here.'
        )
      }
      log(`${DEV.model ?? 'iOS device'} · iOS ${DEV.os ?? '?'} · ${DEV.id}`)
      log(`Metro at ${lan}:${port} (the phone must reach this Mac on that port)`)
      return { outputRate: null, lan }
    },

    /** Documents is the phone library on iOS. Each project is COPIED OVER in
     *  place and NOTHING is cleared — deliberately not the simulator layer's
     *  rule, which removes each project folder first. The host staging
     *  directory is rebuilt every run, so the copies are complete. Read the
     *  block comment below before changing this: clearing here has destroyed
     *  the library twice. */
    seed(songs) {
      /* NEVER pass `--remove-existing-content` here, and never clear
         Documents. On iOS that IS the phone library — the folder a singer
         drops songs into over Finder — and this bundle id is the same app
         they use.

         MEASURED TWICE on a real iPhone, because the flag was re-added once
         in the belief that it scoped to the destination: it does not. With
         `--destination Documents/<song>` it still clears `Documents`, so
         seeding the second song destroys the first and the app reports
         `"Player Session E2E" never listed`. Apple's help text ("remove files
         from the destination directory") reads the other way; the device does
         not agree with it. Plain copies overwrite what they need to, and the
         host staging directory is rebuilt every run, so nothing stale
         survives that matters. */
      /* `devicectl device copy to` documents that it SKIPS FILES THAT HAVE
         NOT BEEN MODIFIED, and the host staging tree is built once per run
         while the device's copy is rewritten by the app during pass 1 (the
         detectors save key and melody back into project.json). If that skip
         test is source-mtime-based, the second pass's seed would copy nothing
         and the native pass would open with the detectors already answered —
         the bias that seeding per pass exists to remove, in the direction
         that hides a regression, and invisible because the run still prints
         "seeded". Measured on an iPhone 13 it does NOT skip (both passes
         settle their analysis in 17-18 s, where the shared seed gave native
         3 s), but that is devicectl's undocumented choice and not a promise.
         Touching the source makes no plausible skip rule apply. */
      const now = new Date()
      for (const song of songs) {
        for (const entry of fs.readdirSync(song.dir, { recursive: true, withFileTypes: true })) {
          const full = path.join(entry.parentPath ?? entry.path ?? song.dir, entry.name)
          try {
            fs.utimesSync(full, now, now)
          } catch {}
        }
        try {
          fs.utimesSync(song.dir, now, now)
        } catch {}
      }
      for (const song of songs) {
        try {
          devicectl([
            'device',
            'copy',
            'to',
            '--device',
            DEV.id,
            '--domain-type',
            'appDataContainer',
            '--domain-identifier',
            BUNDLE,
            '--source',
            song.dir,
            '--destination',
            `Documents/${song.name}`
          ], 600000)
        } catch (error) {
          throw new Error(
            `could not seed "${song.name}" onto ${NAME}: ${error.message}. ` +
              'A device build signed for distribution has no file-sharing domain; ' +
              'the app must be a development or ad-hoc build with its container reachable.'
          )
        }
        log(`  seeded "${song.name}"`)
      }
      log(`seeded ${songs.length} projects into ${NAME}'s Documents`)
    },

    async launch() {
      const t0 = Date.now()
      launchApp(BUNDLE, true)
      pid = pidOf()
      return { pid, out: `pid ${pid}`, t0 }
    },

    /* Reconnect if iOS froze the app and dropped the inspector.
     *
     * A suspended app's socket is closed by the OS, and every later evaluate
     * then throws "WebSocket is not open" — which is not a broken app, it is
     * an app that was asleep. This is the ONE thing a physical device does
     * that a simulator never does, and it lands precisely on the backgrounding
     * step of a legacy pass, where the app is meant to be suspended. The JS
     * context survives the nap, so the hooks and the run id are still there
     * and only the transport needs rebuilding. */
    async ensureConnected() {
      if (session && session.alive()) return false
      if (session) {
        try {
          session.close()
        } catch {}
      }
      session = await connect({
        port,
        label: `"${NAME}"`,
        match: (t) => t.deviceName === NAME && t.appId === BUNDLE
      })
      bindSession()
      /* Reattaching is only safe if the SAME JS context came back. A phone
         that jetsammed or relaunched SingZ while it was in the background
         answers on the same target with a fresh context, whose `__psRun` is
         undefined — and the session guard exempts a missing id, so every
         later measurement would be taken against a song-less new process and
         believed. Prove the identity here instead of trusting the socket. */
      const run = await session.val('String(globalThis.__psRun)')
      const hooks = await session.val('typeof __test')
      if (hooks !== 'object' || (dev.runId && run !== dev.runId)) {
        throw new Error(
          `${NAME} came back as a DIFFERENT session after backgrounding ` +
            `(run ${run} ≠ ${dev.runId}, hooks ${hooks}). The app was restarted, ` +
            'so nothing measured after this point belongs to the run that started.'
        )
      }
      return true
    },

    async attach() {
      session = await connect({ port, label: `"${NAME}"`, match: (t) => t.deviceName === NAME })
      bindSession()
      for (let i = 0; i < 120; i++) {
        if ((await session.val('typeof __test')) === 'object' && (await session.val('typeof __r')) === 'function') break
        await sleep(500)
      }
      if ((await session.val('typeof __test')) !== 'object') throw new Error('__test never appeared')
    },

    async installHooks() {
      dev.runId = `r${Date.now()}`
      await session.val(hooksExpr(dev.runId))
    },

    async detach() {
      if (session) session.close()
      session = null
    },

    /** iOS may be polled over CDP throughout a load — that restriction is
     *  Android's Hermes inspector, not this one. A device decodes slower than
     *  the sim, so the default deadline is longer here. */
    async openProject(name, maxMs = 360000) {
      const raw = await session.val(`__ps.open(${JSON.stringify(name)}, ${maxMs})`, maxMs + 20000)
      const r = JSON.parse(raw)
      if (r.marks.ready === undefined) throw new Error(`"${name}" never became ready: ${raw}`)
      return r
    },

    async background() {
      const was = pid
      launchApp('com.apple.Preferences', false)
      await sleep(2000)
      const still = pidOf()
      return {
        detail: `Preferences launched · SingZ pid ${was} ${
          still === null ? 'GONE' : still === was ? 'still alive' : `REPLACED by ${still}`
        }`,
        samePid: still === null || was === null ? null : still === was
      }
    },

    async foreground() {
      const was = pid
      // NOT --terminate-existing: the whole question is whether the session
      // survives being backgrounded, and killing it would answer it falsely.
      launchApp(BUNDLE, false)
      await sleep(2000)
      const now = pidOf()
      pid = now ?? was
      /* Unknown is not "restarted". `pidOf()` swallows a devicectl hiccup and
         returns null, and scoring that as a pid change would fail the
         did-it-restart rule for a transient read error rather than for a real
         restart. Null rides through `fg.samePid !== false` as a pass. */
      const known = was !== null && now !== null
      return {
        detail: `relaunched in place (pid ${was} → ${now}${
          !known ? ', pid unknown' : String(was) === String(now) ? ', not restarted' : ', RESTARTED'
        })`,
        samePid: known ? String(was) === String(now) : null
      }
    },

    /** Nulls, on purpose. There is no `top` for a process on the phone, and a
     *  number taken from this Mac would describe the Mac. The suite prints a
     *  blank column rather than a fiction; Instruments is what answers this. */
    async sample() {
      return { cpuPct: null, rssMb: null, pssMb: null }
    }
  }

  return dev
}

module.exports = { createDevice, listDevices, pickDevice, BUNDLE }
