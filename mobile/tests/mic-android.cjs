/*
 * Android vocal-training CAPTURE, driven end to end against a real device.
 *
 * Why this exists. Four prerelease builds in one week each fixed a capture
 * fault that no test could see: the input ranking preferred a Bluetooth
 * endpoint the app never routes to; the lane count asked for the maximum a
 * phone advertised and took lane 0, which the platform defines nothing about;
 * a level threshold sat inside a singer's own voice; and the whole backend
 * moved to Oboe. Every one of those was found by reading source or by reading
 * a field log, because `mobile/tests/` had 22 drivers and not one of them
 * touched the microphone.
 *
 * What it asserts is the TRANSPORT CONTRACT — what the app asked Android for,
 * what Android gave back, whether audio then actually arrives, and whether the
 * lease lets go afterwards. It deliberately asserts nothing about pitch or
 * level thresholds: that needs a controlled acoustic environment, would be
 * flaky in a room and vacuous in silence, and is already pinned by the host
 * suite (tests/native/core_host_tests.cpp) with mutation-checked fixtures.
 * Host tests own the DSP; this owns the transport.
 *
 * It drives `__test.audioInput` rather than the training screen. Tapping
 * through a UI at fixed coordinates tests the layout and breaks when it moves,
 * and the faults were never in the layout.
 *
 * Prereqs:
 *   - a DEBUG build installed (`-PdebugAppIdSuffix=.debug`; a plain debug APK
 *     shares the release applicationId with a different signing key, and
 *     Android then demands an uninstall that takes every downloaded song and
 *     the Drive sign-in with it)
 *   - the app running, Metro reachable (`adb reverse tcp:8081 tcp:<METRO_PORT>`)
 *   - RECORD_AUDIO granted: the driver refuses to raise Android's prompt, so
 *     it grants it itself via `pm grant` and says so
 *   - real audio input. An emulator booted `-no-audio` has none, and this
 *     driver would report a capture that delivers nothing — correctly, and
 *     uselessly. Prefer an attached phone.
 *
 *   ANDROID_PKG=com.lexasoft.singz.debug node mobile/tests/mic-android.cjs
 */
const { execFileSync } = require('node:child_process')
const { PKG, silenceDevice } = require('./android-lib.cjs')
const { createPostConnectionBail } = require('./mic-android-lifecycle.cjs')

const SERIAL = process.env.ANDROID_SERIAL || ''
const ADB = process.env.ADB || `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
const PORT = Number(process.env.METRO_PORT || 8081)
const adbArgs = SERIAL ? ['-s', SERIAL] : []
const adb = (...a) => execFileSync(ADB, [...adbArgs, ...a], { encoding: 'utf8' }).trim()

const die = (m) => { console.error(m); process.exit(1) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
let inert = 0

// Post-connection state, module-scope so `bail` can reach it from the outer
// catch as well as from inside the run.
let ws = null
let val = null
let cleanupVal = null
let seamBusy = false
let connected = false

/**
 * The only way out after the inspector is attached. Process death tears the
 * socket down, and a seam call still in flight then fires a timer into a
 * half-torn-down runtime — the measured SIGSEGV this whole design avoids. Every
 * post-connection exit comes through here, including the outer catch and an
 * eval timeout, which were the two that used to bypass it.
 */
const bail = createPostConnectionBail({
  isSeamBusy: () => seamBusy,
  // This evaluator deliberately gets one last chance after a WebSocket error.
  // If the socket is still usable, pending=false proves run() reached its
  // finally and released capture. If it is not, the helper catches the error
  // and still closes exactly once.
  evaluateForCleanup: (expr, timeoutMs) => cleanupVal?.(expr, timeoutMs),
  closeInspector: () => ws?.close(),
  report: (message) => console.error(message),
  exit: (code) => process.exit(code),
  sleep
})
const check = (label, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

;(async () => {
  // The app must be debuggable or there is no inspector and no run-as, and a
  // release APK carrying the same applicationId looks identical in `adb
  // devices` — it fails later, obscurely, for reasons unrelated to capture.
  const info = adb('shell', 'dumpsys', 'package', PKG)
  // "not installed" and "installed but not debuggable" are different problems
  // and used to print the same message, which sends the reader to the build
  // config for a package that simply is not there.
  if (!/versionName=/.test(info)) die(`${PKG} is not installed — build with -PdebugAppIdSuffix=.debug and install it`)
  if (!/DEBUGGABLE/.test(info)) die(`${PKG} is not a debug build — no inspector, no run-as`)
  // silenceDevice takes the adb FUNCTION, not its path: handed a string,
  // isEmulator's call throws into its own catch and reports "real device", so
  // the mute silently never happens. Every sibling driver passes the function
  // and logs the result; so does this one.
  console.log(silenceDevice(adb))

  // Permission is the operator's job, not the app's: the driver passes
  // requestPermission:false so a prompt can never hang a run and read as a
  // capture failure.
  if (!/RECORD_AUDIO: granted=true/.test(info)) {
    adb('shell', 'pm', 'grant', PKG, 'android.permission.RECORD_AUDIO')
    console.log('note: granted RECORD_AUDIO (the driver never lets the app ask)')
  }

  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json()
  // Metro lists every attached app in connection order, so with an emulator
  // and a simulator both up an unfiltered pick answers from whichever
  // connected first. Android's Metro deviceName carries ro.product.model.
  const model = adb('shell', 'getprop', 'ro.product.model')
  if (!model) die('adb could not name the device — is it attached and authorised?')
  const target = list.filter((x) => (x.deviceName || '').includes(model) && x.webSocketDebuggerUrl).pop()
  if (!target) die(`no target for ${JSON.stringify(model)} on Metro ${PORT} — app running? adb reverse set?`)

  const WebSocket = require('ws')
  ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { Origin: 'http://localhost' } })
  let id = 0
  const pend = new Map()
  let inspectorFailure = null
  let rejectOpen = null
  const failInspector = (cause) => {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    if (inspectorFailure) return
    inspectorFailure = error
    for (const pending of pend.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    pend.clear()
  }
  ws.on('message', (m) => {
    try {
      const j = JSON.parse(m.toString())
      const pending = pend.get(j.id)
      if (!pending) return
      pend.delete(j.id)
      clearTimeout(pending.timer)
      pending.resolve(j)
    } catch (error) {
      failInspector(new Error(`invalid inspector response: ${error.message}`))
    }
  })
  ws.on('error', (error) => {
    if (!connected) rejectOpen?.(error)
    else failInspector(new Error(`inspector error: ${error.message}`))
  })
  ws.on('close', (code, reason) => {
    const suffix = reason?.length ? `: ${reason.toString()}` : ''
    const error = new Error(`inspector closed (${code})${suffix}`)
    if (!connected) rejectOpen?.(error)
    else failInspector(error)
  })
  await new Promise((resolve, reject) => {
    rejectOpen = reject
    ws.once('open', () => {
      connected = true
      rejectOpen = null
      resolve()
    })
  })
  const evaluate = async (expr, timeoutMs = 30000, cleanup = false) => {
    if (!cleanup && inspectorFailure) throw inspectorFailure
    if (ws.readyState !== WebSocket.OPEN) throw new Error('inspector is not open')
    const i = ++id
    const r = await new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pend.delete(i)
        rej(new Error(`eval timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      pend.set(i, { resolve: res, reject: rej, timer })
      ws.send(JSON.stringify({
        id: i,
        method: 'Runtime.evaluate',
        // No awaitPromise: Hermes' promises are not native and CDP cannot
        // resolve them. Every eval here is SYNCHRONOUS by construction —
        // see `await work()` below, which polls instead. An eval that leaves
        // work in flight has been measured killing the app on disconnect.
        params: { expression: expr, returnByValue: true }
      }), (error) => {
        if (!error || !pend.has(i)) return
        pend.delete(i)
        clearTimeout(timer)
        rej(error)
      })
    })
    if (r.result?.exceptionDetails)
      throw new Error(`eval threw: ${JSON.stringify(r.result.exceptionDetails)}`)
    return r.result?.result?.value
  }
  val = (expr, timeoutMs) => evaluate(expr, timeoutMs, false)
  cleanupVal = (expr, timeoutMs) => evaluate(expr, timeoutMs, true)
  if (await val('1+1', 5000) !== 2)
    throw new Error('the Metro target does not answer — stale listing?')

  /**
   * Kick the seam off and poll for its answer. Never returns while work is
   * still in flight, which is what makes it safe to close the socket after:
   * a pending timer firing into a runtime the inspector has begun tearing
   * down segfaults the app (measured, twice, before this loop existed).
   */
  const work = async (expr, budgetMs) => {
    seamBusy = true
    if ((await val(expr)) !== true)
      throw new Error(`seam call did not start (already busy?): ${expr}`)
    for (let waited = 0; waited <= budgetMs + 15000; waited += 250) {
      await sleep(250)
      if ((await val('__test.audioInput.pending === false && __test.audioInput.result !== null')) === true) {
        seamBusy = false
        const out = JSON.parse(await val('JSON.stringify(__test.audioInput.result)'))
        if (out && out.error) throw new Error(`seam reported: ${out.error}`)
        return out
      }
    }
    throw new Error(`seam never settled: ${expr}`)
  }
  if (await val("typeof globalThis.__test?.audioInput") !== 'object')
    throw new Error('__test.audioInput missing — is this a dev build of THIS tree?')

  // ---- 1. inventory -------------------------------------------------------
  const inputs = await work('__test.audioInput.listInputs()', 5000)
  check('Android offers at least one input', Array.isArray(inputs) && inputs.length > 0,
    `${inputs?.length ?? 0} device(s)`)
  const preferred = (inputs || []).filter((d) => d.isPreferred)
  check('exactly one input is marked preferred', preferred.length === 1,
    preferred.map((d) => `${d.label} (${d.transport})`).join(', '))
  // The ranking bug that shipped: Bluetooth outranked the built-in microphone
  // while the module establishes no SCO route, so connected earbuds aimed
  // capture at an endpoint SingZ never activates.
  const bluetoothAttached = (inputs || []).some((d) => /bluetooth|hearing-aid/.test(d.transport))
  if (!bluetoothAttached) {
    inert++
    console.log('note: no Bluetooth input attached — the ranking assertion is inert this run')
  }

  // ---- 2-4. negotiate, listen, read the counters --------------------------
  const first = await work('__test.audioInput.run(2500)', 2500)
  const n = first.negotiated
  console.log(`negotiated: ${n.sampleRate} Hz · channel ${n.selectedChannel + 1}/${n.deviceChannels} · ` +
    `${n.sampleFormat} · ${n.sharingMode} · ${n.performanceMode} · ${n.inputPreset}`)

  // Deliberately NOT asserted here: that the device uid echoes back and that
  // the selected channel matches. AudioInputModule.kt rejects both before
  // acquire() returns, so a check on them could only ever print PASS — a
  // divergence arrives as a throw and never reaches this line.
  //
  // The lane COUNT is live: Kotlin only guarantees >= 1, so this is what pins
  // the mono request. Which lane of a multi-lane built-in capture carries the
  // voice is not something the platform defines, which is why we ask for one.
  check('exactly one lane is granted', n.deviceChannels === 1,
    `channel ${n.selectedChannel + 1}/${n.deviceChannels}`)
  check('the negotiated format is float32', n.sampleFormat === 'float32', n.sampleFormat)
  check('the negotiated rate is usable', n.sampleRate >= 8000 && n.sampleRate <= 384000, `${n.sampleRate} Hz`)
  // A preset the stream was never asked about is a guess; the log must not
  // call it verified.
  check('the input preset is read back from the stream', /-verified$/.test(n.inputPreset), n.inputPreset)

  // The fault the whole investigation was about: capture that runs, reports
  // healthy, and delivers nothing.
  check('audio actually arrives', first.frames > 0, `${first.frames} analysis blocks in 2.5 s`)
  check('the hardware callback fired', (first.stats?.deliveredBlocks ?? 0) > 0,
    `${first.stats?.deliveredBlocks ?? 0} callbacks`)
  check('no overruns', (first.stats?.overruns ?? -1) === 0, `${first.stats?.overruns}`)
  check('a level is reported', first.peakDbfs !== null && first.peakDbfs > -120,
    first.peakDbfs === null ? 'none' : `${first.peakDbfs.toFixed(1)} dBFS`)
  // The ranking regression that shipped, asserted on the endpoint capture
  // actually OPENED on rather than on the inventory's isPreferred flag: a
  // regression that marks nothing preferred would leave that flag empty and
  // read as a pass, while the coordinator quietly falls back to devices[0].
  if (bluetoothAttached) {
    check('capture did not open on a Bluetooth endpoint',
      !/bluetooth|hearing-aid/.test(first.device.transport), first.device.transport)
  }
  if ((first.stats?.peakGain ?? 0) > 0)
    console.log(`note: the core lifted capture up to ${first.stats.peakGain.toFixed(1)}x`)

  // ---- 5. the lease lets go, and a second capture works -------------------
  // `run()` releases in a finally, so reaching here at all means the first
  // release resolved. The ownership latch is deliberately unforgiving — a
  // failed release blocks every later acquisition — so proving the SECOND
  // acquire succeeds is what proves teardown was clean rather than merely
  // attempted.
  const second = await work('__test.audioInput.run(1200)', 1200)
  check('capture can be re-acquired after release', second.frames > 0,
    `${second.frames} blocks on the second capture`)
  check('the second capture negotiates the same contract',
    second.negotiated.deviceChannels === n.deviceChannels &&
    second.negotiated.sampleFormat === n.sampleFormat,
    `${second.negotiated.sampleFormat} ch ${second.negotiated.deviceChannels}`)

  connected = false
  ws.close()
  const caveat = inert ? ` — ${inert} assertion${inert > 1 ? 's' : ''} inert (see notes)` : ''
  console.log(failed === 0 ? `\nMIC ANDROID: PASS${caveat}` : `\nMIC ANDROID: ${failed} FAILED${caveat}`)
  process.exit(failed === 0 ? 0 : 1)
})().catch(async (e) => {
  const message = `driver error: ${e.stack || e.message}`
  if (connected) await bail(message)
  else die(message)
})
