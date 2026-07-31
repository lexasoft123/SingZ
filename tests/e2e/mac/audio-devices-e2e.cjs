/*
 * Audio settings E2E (macOS): gear → Settings → Audio; device pickers, live
 * mic device switch while singing, resizable pitch strip, Esc close, output
 * sinkId move + boot-time re-apply. Permanent harness for the e2e-verifier.
 *
 * Runs against an isolated scratch profile (SINGZ_USERDATA_DIR) with a
 * pre-seeded stems cache, so no library and no splitter engine are needed.
 * NOTE: SINGZ_FAKE_MIC fakes the capture *stream* only — device enumeration
 * stays real on mac (verified on Electron 43), so assertions adapt to the
 * machine's device list instead of expecting "Fake Audio Input" rows.
 *
 * Prereqs: `npm run build` done; the dev Electron binary has mac microphone
 * permission (TCC) so getUserMedia can open.
 *
 * Env: E2E_OUT (screenshot + profile dir, default os.tmpdir()).
 */
const { _electron } = require('playwright-core')
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

const launch = () =>
  _electron.launch({
    executablePath: require('electron'),
    args: [APP],
    // SINGZ_MUTE silences the device only — enumeration, sinkId moves and the
    // fake-mic pitch path stay real, so every assertion here is mute-proof.
    env: { ...process.env, SINGZ_FAKE_MIC: '1', SINGZ_USERDATA_DIR: PROFILE, SINGZ_MUTE: '1' }
  })

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
  await win.screenshot({ path: join(OUT, 'settings-audio.png') })

  await win.selectOption('#settings-input', ins[0].v)
  const stored = await win.evaluate(() => JSON.parse(localStorage.getItem('singz.audio') ?? '{}'))
  if (stored.inputId !== ins[0].v) throw new Error('input pick not persisted')

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

  // ---- settings shows the live device; flipping restarts the mic ----
  await win.click('.pill.gear')
  await win.waitForFunction(
    () => [...document.querySelectorAll('.settings-hint')].some((el) => el.textContent?.includes('Listening through')),
    null,
    { timeout: 15000 }
  )
  if (ins.length >= 2) {
    await win.selectOption('#settings-input', ins[1].v)
    // restart must complete with the mic still on and a live-device hint
    await win.waitForFunction(
      () => document.querySelector('.mic-toggle')?.textContent?.includes('Mic on'),
      null,
      { timeout: 15000 }
    )
    const prefs2 = await win.evaluate(() => JSON.parse(localStorage.getItem('singz.audio') ?? '{}'))
    if (prefs2.inputId !== ins[1].v) throw new Error('live input switch not persisted')
    console.log('live mic switch: restarted on', ins[1].t)
  } else {
    console.log('skip live switch (single input machine)')
  }

  // ---- Esc closes settings without killing karaoke underneath ----
  await win.keyboard.press('Escape')
  await win.waitForSelector('.settings-card', { state: 'detached', timeout: 5000 })
  if (!(await win.$('.pitch-strip'))) throw new Error('Esc closed karaoke, not just settings')

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
  if (prefs.inputId !== expectInput) throw new Error('input pref lost across relaunch')
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
