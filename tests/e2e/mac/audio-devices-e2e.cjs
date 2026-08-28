/*
 * Audio settings E2E (macOS): gear → Settings → Audio; device pickers, live
 * mic device switch while singing, resizable pitch strip, Esc close, output
 * sinkId move + boot-time re-apply. Permanent harness for the e2e-verifier.
 *
 * Runs against an isolated scratch profile (SINGZ_USERDATA_DIR) with a
 * pre-seeded stems cache, so no library and no splitter engine are needed.
 * SINGZ_FAKE_MIC grants capture without touching hardware. A renderer-only,
 * driver-installed stereo fixture then supplies silence on channel 1 and a
 * tone on channel 2. Device enumeration stays real, so the hardware picker
 * branch is still exercised without making meter assertions machine-dependent.
 *
 * That fixture reaches the WEB AUDIO path only. With a current core binary the
 * meter and training capture natively instead, on this machine's real default
 * input, and the fixture's silent/tone pair says nothing about it — so the
 * meter assertions fork on `nativeMode`: the fixture pair when the app is on
 * Web Audio, and "inside the scale it declares, on the lane that was picked"
 * when it is native. Written after a machine whose default input is a
 * 24-channel aggregate failed both halves while the app was working.
 *
 * Because that fork is decided by whichever binary sits in the vendor slot,
 * the run reads the app's own provenance verdict for it, prints the line, and
 * stops unless it POSITIVELY identifies this tree's core — a foreign one
 * (error), one that cannot say what built it (warn), and one whose expected
 * hash could not be computed here all fail the run, because none of them lets
 * it claim it verified this tree. No core at all is reported and allowed:
 * the Web Audio half is then the honest fork.
 *
 * Prereqs: `npm run build` done; `scripts/vendor-analyze.sh` run so the
 * vendored core matches this tree; the dev Electron binary has mac microphone
 * permission (TCC) so getUserMedia can open.
 *
 * Env: E2E_OUT (screenshot + profile dir, default os.tmpdir()). Set
 * SINGZ_ANALYZE to a freshly built core binary to exercise native UID/channel
 * persistence; an older vendored binary deliberately exercises fallback.
 */
const { _electron } = require('playwright-core')
const { quietLaunch } = require('./quiet-launch.cjs')
const { writeFileSync, mkdirSync, copyFileSync, createReadStream, rmSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

const OUT = process.env.E2E_OUT ?? tmpdir()
const APP = join(__dirname, '..', '..', '..', 'out', 'main', 'index.js')
const PROFILE = join(OUT, 'audio-e2e-userdata')
const STEMS_6 = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano']

/** 2s of 440 Hz mono 16-bit PCM — enough for a loaded, playable song. */
function makeWav(path) {
  const rate = 44100
  const n = rate * 2
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

const hashFile = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex').slice(0, 16)))
      .on('error', reject)
  })

const launch = async () => {
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // SINGZ_MUTE silences the device only — enumeration, sinkId moves and the
    // fake-mic pitch path stay real, so every assertion here is mute-proof.
    env: { ...process.env, SINGZ_FAKE_MIC: '1', SINGZ_USERDATA_DIR: PROFILE, SINGZ_MUTE: '1', SINGZ_E2E_HIDDEN: '1', SINGZ_NO_SYNC: '1' }
  })
  await quietLaunch(app) // measurement runs must not steal the singer's focus
  const win = await app.firstWindow()
  await win.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    const state = { active: 0, maxActive: 0 }
    Object.defineProperty(window, '__singzE2eMic', { value: state, configurable: true })
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (!constraints?.audio) return original(constraints)
      const context = new AudioContext()
      const merger = context.createChannelMerger(2)
      const silent = context.createConstantSource()
      silent.offset.value = 0
      silent.connect(merger, 0, 0)
      const tone = context.createOscillator()
      tone.frequency.value = 440
      const gain = context.createGain()
      gain.gain.value = 0.2
      tone.connect(gain).connect(merger, 0, 1)
      const destination = context.createMediaStreamDestination()
      merger.connect(destination)
      silent.start()
      tone.start()
      await context.resume()
      const stream = destination.stream
      const track = stream.getAudioTracks()[0]
      const requested = typeof constraints.audio === 'object'
        ? constraints.audio.deviceId?.exact
        : undefined
      track.getSettings = () => ({ deviceId: typeof requested === 'string' ? requested : 'default', channelCount: 2 })
      const stop = track.stop.bind(track)
      let live = true
      track.stop = () => {
        if (!live) return
        live = false
        state.active--
        stop()
        silent.stop()
        tone.stop()
        void context.close()
      }
      state.active++
      state.maxActive = Math.max(state.maxActive, state.active)
      return stream
    }
  })
  await win.reload()
  return app
}

/**
 * WHICH singz-analyze is this run actually exercising?
 *
 * This driver forks on the core: with one that supports native capture the
 * meter and training go through AudioInput, and with an older one they take
 * the Web Audio fixture. So the binary in the vendor slot decides which half
 * of this file runs — which makes its provenance a testing question, not just
 * a correctness one. During the v0.19.0 cut a sibling worktree's core sat in
 * the shared slot for hours and THIS driver exercised the live-input path
 * that branch had changed; a green run said nothing about this tree.
 *
 * The app answers it itself now (src/main/analyze-provenance.ts) with one
 * `analyze` line at its first resolveAnalyze(). That check is fired and not
 * awaited, so this polls rather than reading once.
 *
 * A build with NO core at all is a legitimate configuration — the Web Audio
 * half is exactly what it should run — so absence is reported, not failed.
 * `melodyNativeAvailable()` is the authoritative answer to "is there one",
 * and asking it also guarantees the resolve that emits the line.
 */
const coreProvenance = async (win) => {
  const available = await win.evaluate(async () => {
    const r = await window.singz.melodyNativeAvailable()
    return r.ok && r.available
  })
  if (!available) {
    console.log('core provenance: no singz-analyze in this build — Web Audio half by necessity')
    return null
  }
  // The poll is a NODE loop, not waitForFunction: with an ASYNC page function
  // waitForFunction does not poll at all — it calls it once and resolves with
  // whatever that call returned, so `polling` and `timeout` are inert and a
  // line that has not landed yet arrives here as null. Measured: the async
  // predicate ran once and settled in 23 ms; the same predicate written
  // synchronously ran nine times over 3.2 s. Plain `evaluate` DOES await an
  // async page function, so the loop below is the shape that works. It
  // matters because the line is not instant — the check spawns build-info and
  // scripts/analyze-source-hash.sh, both racing the device inventory this
  // driver is already waiting on.
  //
  // getLog() (IPC log:all) returns the LogEntry array itself. Do NOT reach for
  // `.entries` on it — that is Array.prototype.entries, a function.
  const readHits = () =>
    win.evaluate(async () => {
      const log = await window.singz.getLog()
      return log.filter((e) => e.source === 'analyze' && /core singz-analyze/.test(e.line))
    })
  const deadline = Date.now() + 20000
  let hits = await readHits()
  while (hits.length === 0) {
    if (Date.now() > deadline) {
      throw new Error('no core-provenance line in the app log after 20s — the check that should emit it never ran')
    }
    await new Promise((r) => setTimeout(r, 400))
    hits = await readHits()
  }
  if (hits.length !== 1) {
    throw new Error(`expected one core-provenance line, got ${hits.length}: ${JSON.stringify(hits.map((h) => h.line))}`)
  }
  const [entry] = hits
  console.log(`core provenance [${entry.level}]: ${entry.line}`)
  // Only a POSITIVE identification passes. `error` is the foreign core; `warn`
  // is a binary that cannot say what built it (a host-built one hand-copied
  // into the slot); an `info` that says "no source tree to check it against"
  // means the hash could not be computed here. None of those three let this
  // run claim it verified THIS tree, which is the only thing the assertion is
  // for — so all three stop it, and the line itself is the diagnosis.
  if (!(entry.level === 'info' && /built from this tree/.test(entry.line))) {
    throw new Error(`this run would not be verifying this tree's core: ${entry.line}`)
  }
  return entry
}

;(async () => {
  const wav = join(OUT, 'e2e-tone.wav')
  makeWav(wav)
  // Seed the splitter cache: six copies of the tone under the song's hash,
  // so "Split into stems" returns instantly with no engine installed.
  rmSync(PROFILE, { recursive: true, force: true })
  const stemDir = join(PROFILE, 'stems', await hashFile(wav), 'htdemucs_6s')
  mkdirSync(stemDir, { recursive: true })
  for (const s of STEMS_6) copyFileSync(wav, join(stemDir, `${s}.wav`))

  let app = await launch()
  let win = await app.firstWindow()
  await win.waitForSelector('.pill.gear', { timeout: 60000 })

  // ---- pickers: never the pseudo-devices; adapt to the machine's list ----
  await win.click('.pill.gear')
  await win.waitForSelector('.settings-card', { timeout: 20000 })
  // the pickers fill asynchronously — done when the loading hint clears
  await win.waitForFunction(
    () =>
      ![...document.querySelectorAll('.settings-hint')].some((el) =>
        el.textContent?.includes('Looking for audio devices')
      ),
    null,
    { timeout: 20000 }
  )
  const nativeInventory = await win.evaluate(() => window.singz.listDesktopAudioInputs())
  const nativeMode = nativeInventory.ok
  const inputPrefKey = nativeMode ? 'nativeInputUid' : 'inputId'
  console.log('microphone mode:', nativeMode ? 'native AudioInput' : 'Web Audio fallback')
  // Which core chose that fork, and was it built from this tree — printed
  // beside the mode so the run is self-documenting either way.
  await coreProvenance(win)
  const inOpts = await win.$$eval('#settings-input option', (os) =>
    os.map((o) => ({ v: o.value, t: o.textContent ?? '' }))
  )
  const outOpts = await win.$$eval('#settings-output option', (os) =>
    os.map((o) => ({ v: o.value, t: o.textContent ?? '' }))
  )
  if ([...inOpts, ...outOpts].some((o) => o.v === 'default' || o.v === 'communications')) {
    throw new Error('pseudo-devices leaked into the pickers')
  }
  // Prefer the built-in mic for the live test; anything else as the second.
  const ins = inOpts.filter((o) => o.v)
  ins.sort((a, b) => Number(/built-in|macbook/i.test(b.t)) - Number(/built-in|macbook/i.test(a.t)))
  if (ins.length < 1) throw new Error('no audio inputs on this machine')
  console.log('inputs:', ins.map((f) => f.t).join(' | '))
  await win.waitForFunction(
    () => {
      const text = document.querySelector('.mic-meter-head output')?.textContent ?? ''
      return text.includes('dBFS') || text.includes('No signal') || text.includes('blocked')
    },
    null,
    { timeout: 20000 }
  )
  if (!(await win.$('.mic-meter[role="meter"]'))) throw new Error('accessible mic meter missing')
  const meterLevel = () =>
    win.$eval('.mic-meter[role="meter"]', (el) => Number(el.getAttribute('aria-valuenow')))
  const silentLevel = await meterLevel()
  // The fixture is a renderer-installed getUserMedia stream, so it feeds the
  // Web Audio path ONLY. In native mode this meter is a real device on this
  // machine's real default input, whatever that happens to be — asserting the
  // fixture's silence there measures the room, not the app. What native mode
  // can promise is that the meter stays inside the scale it declares.
  if (nativeMode) {
    // Number(null) is 0, which is inside the scale — check the attribute is
    // really there, or a meter that stopped reporting would read as healthy.
    const raw = await win.$eval('.mic-meter[role="meter"]', (el) => el.getAttribute('aria-valuenow'))
    if (raw === null || raw === '' || !Number.isFinite(Number(raw)))
      throw new Error(`meter published no level: aria-valuenow=${JSON.stringify(raw)}`)
    if (!(silentLevel >= -72 && silentLevel <= 0))
      throw new Error(`meter read ${silentLevel} dBFS, outside its own -72..0 scale`)
  } else if (silentLevel !== -72) {
    throw new Error(`channel 1 fixture should be silent, got ${silentLevel} dBFS`)
  }
  const initialChannelOptions = await win.$$('#settings-input-channel option')
  const initialNative = nativeMode
    ? nativeInventory.devices.find((device) => device.isDefault) ?? nativeInventory.devices[0]
    : null
  const expectedInitialChannels = nativeMode
    ? (initialNative?.channels ?? 1) > 1 ? initialNative.channels : 0
    : 2
  if (initialChannelOptions.length !== expectedInitialChannels)
    throw new Error(`input picker exposed ${initialChannelOptions.length} channels, expected ${expectedInitialChannels}`)
  if (initialChannelOptions.length > 1) {
    const previewChannel = 1
    await win.selectOption('#settings-input-channel', String(previewChannel))
    await win.waitForFunction(
      (selected) => JSON.parse(localStorage.getItem('singz.audio') ?? '{}').inputChannel === selected,
      previewChannel
    )
    if (nativeMode) {
      // Wait for the preview to be BACK, on the new lane, before reading it:
      // selecting a channel calls setPreview(INITIAL_PREVIEW) in a layout
      // effect and reopens the device asynchronously, while the localStorage
      // gate above lands in a passive effect that runs sooner. Reading in that
      // window measures the -72 placeholder with device still null, where the
      // fallback warning cannot render either — both assertions vacuous.
      await win.waitForFunction(
        (channel) => document.querySelector('.mic-preview-status')?.textContent?.includes(`channel ${channel} of `) === true,
        previewChannel + 1,
        { timeout: 20000 }
      )
      // A real lane may legitimately be silent, so the promise here is that
      // the lane you picked is the lane being previewed — the app says so
      // itself by NOT showing its channel-fallback warning — and that the
      // meter keeps reporting inside its scale on it.
      const nativeLevel = await meterLevel()
      if (!(nativeLevel >= -72 && nativeLevel <= 0))
        throw new Error(`channel ${previewChannel + 1} read ${nativeLevel} dBFS, outside the meter's scale`)
      const laneWarning = await win.$eval('.settings-card', (card) =>
        [...card.querySelectorAll('.settings-hint.warn')].map((el) => el.textContent ?? '').find((t) => t.includes('lane')) ?? null
      )
      if (laneWarning) throw new Error(`channel ${previewChannel + 1} not opened: ${laneWarning}`)
      console.log(`native lane: channel ${previewChannel + 1} at ${nativeLevel} dBFS; picker lanes: ${initialChannelOptions.length}`)
    } else {
      await win.waitForFunction(
        () => Number(document.querySelector('.mic-meter[role="meter"]')?.getAttribute('aria-valuenow')) > -72
      )
      const signalLevel = await meterLevel()
      if (signalLevel === silentLevel) throw new Error('channel meter did not change between silent and signal lanes')
      console.log(`fixture preview: ${silentLevel} dBFS → ${signalLevel} dBFS; picker lanes: ${initialChannelOptions.length}`)
    }
  }
  await win.screenshot({ path: join(OUT, 'settings-audio.png') })

  await win.selectOption('#settings-input', ins[0].v)
  const stored = await win.evaluate(() => JSON.parse(localStorage.getItem('singz.audio') ?? '{}'))
  if (stored[inputPrefKey] !== ins[0].v) throw new Error(`${inputPrefKey} pick not persisted`)
  // ---- output pick (guarded — machine hardware) ----
  const realOuts = outOpts.filter((o) => o.v)
  let pickedOut = null
  if (realOuts.length > 0) {
    pickedOut = realOuts[0].v
    await win.selectOption('#settings-output', pickedOut)
    await win.waitForFunction((id) => window.__engine.context.sinkId === id, pickedOut, {
      timeout: 10000
    })
    console.log('output moved to:', realOuts[0].t)
  } else {
    console.log('skip output pick (no outputs listed)')
  }
  await win.click('.settings-card .modal-actions .pill')

  // Settings' own preview owns the native input for as long as the panel is
  // open, so a raw start here is refused ('Another training microphone is
  // starting/active') — that is the exclusivity working, not a failure. The
  // smoke therefore runs with the panel CLOSED and nothing else holding the
  // device; the pitch strip's mic stays off until a singer asks for it.
  if (nativeMode) {
    const nativeSmoke = await win.evaluate(async (deviceUid) => {
      let resolveFrame
      const frame = new Promise((resolve) => { resolveFrame = resolve })
      const unsubscribe = window.singz.onDesktopAudioInputEvent((token, event) => {
        if (event.type === 'frame') resolveFrame(event)
      })
      // Settings' preview releases the device asynchronously, so the start
      // gate can still be holding a claim for a beat after the panel closes.
      // 'busy' is that claim, and it is short-lived by construction — retry
      // it rather than reporting the app's own exclusivity as a failure.
      let started = await window.singz.startDesktopAudioInput({ deviceUid, channel: 0 })
      for (let attempt = 0; attempt < 20 && !started.ok && started.kind === 'busy'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        started = await window.singz.startDesktopAudioInput({ deviceUid, channel: 0 })
      }
      if (!started.ok) {
        unsubscribe()
        return { started }
      }
      const observed = await Promise.race([
        frame,
        new Promise((resolve) => setTimeout(() => resolve(null), 6000))
      ])
      const stopped = await window.singz.stopDesktopAudioInput(started.token)
      unsubscribe()
      return { started, observed, stopped }
    }, ins[0].v)
    if (!nativeSmoke.started.ok || nativeSmoke.started.device.uid !== ins[0].v || !nativeSmoke.observed || !nativeSmoke.stopped.ok)
      throw new Error(`native UID capture failed: ${JSON.stringify(nativeSmoke)}`)
    console.log('native capture:', nativeSmoke.started.device.label, 'channel 1')
  }

  // ---- active Imitate yields exclusively to Settings and stays interrupted ----
  await win.click('.app-sections button:has-text("Vocal training")')
  await win.waitForSelector('.vt-exercise:has-text("Match a note")', { timeout: 20000 })
  await win.click('.vt-exercise:has-text("Match a note")')
  await win.click('button:has-text("Start practice")')
  // The handover is asserted against what the SCREEN shows, because that is
  // the half both capture paths share: `__singzE2eMic` counts getUserMedia
  // and sees nothing at all when the app is capturing natively. Listening =
  // the practice transport; interrupted = the paused card and its Continue
  // button (`exercisePhase` is internal state, never text on screen).
  await win.waitForSelector('.vt-transport-status', { timeout: 20000 })
  await win.click('.pill.gear')
  await win.waitForSelector('.settings-card', { timeout: 10000 })
  await win.waitForFunction(
    () => document.querySelector('.vt-ready')?.textContent?.includes('Practice paused') === true,
    null,
    { timeout: 15000 }
  )
  if (await win.$('.vt-transport-status'))
    throw new Error('training kept listening while Settings owned the microphone')
  if (!nativeMode) {
    await win.waitForFunction(() => window.__singzE2eMic.active === 1, null, { timeout: 15000 })
    const trainingOwnership = await win.evaluate(() => window.__singzE2eMic)
    if (trainingOwnership.maxActive > 1)
      throw new Error(`training/settings capture overlapped: ${JSON.stringify(trainingOwnership)}`)
  }
  await win.click('.settings-card .modal-actions .pill')
  if (!nativeMode) await win.waitForFunction(() => window.__singzE2eMic.active === 0, null, { timeout: 10000 })
  // Closing Settings must not silently put the singer back on the mic.
  const paused = await win.$eval('.vt-ready', (el) => el.textContent ?? '')
  if (!paused.includes('Practice paused'))
    throw new Error(`training resumed under Settings close: ${paused}`)
  if (!(await win.$('button:has-text("Continue practice")')))
    throw new Error('paused practice offers no way back in')
  await win.click('.app-sections button:has-text("Songs")')

  // ---- load the tone, split from cache, karaoke + mic on ----
  await win.setInputFiles('input[type="file"]:not([data-testid])', wav)
  await win.waitForSelector('.pill.primary:has-text("Split into stems")', { timeout: 30000 })
  await win.click('.pill.primary:has-text("Split into stems")')
  await win.waitForSelector('.pill.karaoke', { timeout: 60000 })
  const kOn = await win.$eval('.pill.karaoke', (el) => el.classList.contains('active'))
  if (!kOn) await win.click('.pill.karaoke')
  await win.waitForSelector('.mic-toggle', { timeout: 20000 })
  await win.click('.mic-toggle')
  await win.waitForFunction(
    () => document.querySelector('.mic-toggle')?.textContent?.includes('Mic on'),
    null,
    { timeout: 20000 }
  )

  // ---- settings owns a live analyser preview; flipping restarts runtime + preview ----
  await win.click('.pill.gear')
  await win.waitForFunction(
    () => {
      const text = document.querySelector('.mic-meter-head output')?.textContent ?? ''
      return text.includes('dBFS') || text.includes('No signal')
    },
    null,
    { timeout: 15000 }
  )
  if (ins.length >= 2) {
    await win.selectOption('#settings-input', ins[1].v)
    if (nativeMode) {
      // __singzE2eMic counts getUserMedia, and the native preview never calls
      // it — the app says which device it reopened on instead.
      // The option text is "<label> · <n> ch"; the status names the label.
      await win.waitForFunction(
        (label) => document.querySelector('.mic-preview-status')?.textContent?.includes(`Listening through ${label}`) === true,
        ins[1].t.split(' · ')[0].trim(),
        { timeout: 20000 }
      )
    } else {
      await win.waitForFunction(() => window.__singzE2eMic.active === 1, null, { timeout: 15000 })
    }
    const prefs2 = await win.evaluate(() => JSON.parse(localStorage.getItem('singz.audio') ?? '{}'))
    if (prefs2[inputPrefKey] !== ins[1].v) throw new Error('live input switch not persisted')
    console.log('live mic switch: restarted on', ins[1].t)
  } else {
    console.log('skip live switch (single input machine)')
  }
  const channelOptions = await win.$$('#settings-input-channel option')
  let expectedInputChannel = 0
  if (channelOptions.length > 1) {
    const pickedChannel = String(channelOptions.length - 1)
    await win.selectOption('#settings-input-channel', pickedChannel)
    await win.waitForFunction(
      (channel) => JSON.parse(localStorage.getItem('singz.audio') ?? '{}').inputChannel === channel,
      Number(pickedChannel)
    )
    await win.waitForFunction(
      (channel) => document.querySelector('.mic-route')?.textContent?.includes(`IN ${channel + 1}/`),
      Number(pickedChannel)
    )
    console.log('input channel:', Number(pickedChannel) + 1)
    expectedInputChannel = Number(pickedChannel)
  }
  // Exclusivity, read from whichever counter can see it: on Web Audio the one
  // live stream is Settings' own; natively Settings holds the device outside
  // Chromium, so the proof is that karaoke's stream LET GO and never doubled.
  if (nativeMode) {
    const ownership = await win.evaluate(() => window.__singzE2eMic)
    if (ownership.active !== 0 || ownership.maxActive > 1)
      throw new Error(`karaoke did not yield to the native preview: ${JSON.stringify(ownership)}`)
  } else {
    await win.waitForFunction(() => window.__singzE2eMic.active === 1, null, { timeout: 15000 })
    const ownership = await win.evaluate(() => window.__singzE2eMic)
    if (ownership.active !== 1 || ownership.maxActive > 1)
      throw new Error(`microphone ownership overlapped: ${JSON.stringify(ownership)}`)
  }

  // ---- Esc closes settings without killing karaoke underneath ----
  await win.keyboard.press('Escape')
  await win.waitForSelector('.settings-card', { state: 'detached', timeout: 5000 })
  if (!(await win.$('.pitch-strip'))) throw new Error('Esc closed karaoke, not just settings')
  await win.waitForFunction(
    () => document.querySelector('.mic-toggle')?.textContent?.includes('Mic on'),
    null,
    { timeout: 15000 }
  )
  const restoredOwnership = await win.evaluate(() => window.__singzE2eMic)
  if (restoredOwnership.active !== 1 || restoredOwnership.maxActive > 1)
    throw new Error(`karaoke capture did not restore exclusively: ${JSON.stringify(restoredOwnership)}`)

  // ---- pitch strip: drag the top edge, drawing scales, height persists ----
  const before = await win.$eval('.pitch-strip', (el) => el.clientHeight)
  const handle = await win.$('.ps-resize')
  const hb = await handle.boundingBox()
  await win.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await win.mouse.down()
  await win.mouse.move(hb.x + hb.width / 2, hb.y - 120, { steps: 8 })
  await win.mouse.up()
  const after = await win.$eval('.pitch-strip', (el) => el.clientHeight)
  if (after < before + 100) throw new Error(`resize did not grow the strip (${before}→${after})`)
  const storedH = await win.evaluate(() => localStorage.getItem('singz.pitchH'))
  if (Math.abs(Number(storedH) - after) > 2) throw new Error('pitchH not persisted')
  // her display, for the readability screenshot
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 0, y: 0, width: 1536, height: 960 })
  )
  await new Promise((r) => setTimeout(r, 600))
  await win.screenshot({ path: join(OUT, 'pitch-resized.png') })
  console.log(`pitch strip: ${before}px → ${after}px, persisted ${storedH}`)

  const expectInput = ins.length >= 2 ? ins[1].v : ins[0].v
  await app.close()

  // ---- relaunch: saved devices re-apply on boot ----
  app = await launch()
  win = await app.firstWindow()
  await win.waitForSelector('.pill.gear', { timeout: 60000 })
  const prefs = await win.evaluate(() => JSON.parse(localStorage.getItem('singz.audio') ?? '{}'))
  if (prefs[inputPrefKey] !== expectInput) throw new Error(`${inputPrefKey} pref lost across relaunch`)
  if (prefs.inputChannel !== expectedInputChannel) throw new Error(`input channel lost across relaunch: ${prefs.inputChannel}`)
  if (pickedOut) {
    await win.waitForFunction((id) => window.__engine.context.sinkId === id, pickedOut, {
      timeout: 15000
    })
    console.log('boot re-apply: sinkId restored')
  }
  await app.close()

  console.log('SCREENSHOTS:', join(OUT, 'settings-audio.png'), join(OUT, 'pitch-resized.png'))
  console.log('PASS')
  process.exit(0)
})().catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
