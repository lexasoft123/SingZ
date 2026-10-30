'use strict'
/** Installed Linux qualification. Run inside Xvfb or a Wayland compositor.
 * Hardware assertions require an explicitly named snd_aloop endpoint. A hosted
 * runner without cards reports browser mode; it never claims native audio.
 */
const watchdog = require('../../shared/watchdog.cjs').arm('linux-package', { totalMinutes: 35, idleMinutes: 12 })
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { _electron } = require('playwright-core')
const { wav, stemProject, driveServer, md5 } = require('./fixtures.cjs')

const projectRoot = path.resolve(__dirname, '../../..')
const packageVersion = require(path.join(projectRoot, 'package.json')).version
const evidence = path.resolve(process.env.SINGZ_E2E_RESULTS || path.join(projectRoot, 'build/native/linux-package-e2e'))
const executable = path.resolve(process.env.SINGZ_E2E_PACKAGED || '/opt/SingZ/singz')
const requireLoopback = process.env.SINGZ_E2E_REQUIRE_LOOPBACK === '1'
const forceBrowser = process.env.SINGZ_E2E_AUDIO === 'browser'
assert.ok(!process.env.SINGZ_E2E_AUDIO || forceBrowser, 'SINGZ_E2E_AUDIO supports only an explicit browser override')
const ozone = process.env.SINGZ_E2E_OZONE || (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11')
fs.mkdirSync(evidence, { recursive: true })
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-linux-e2e-'))
const profile = path.join(scratch, 'profile'), library = path.join(scratch, 'library')
// Chromium stays muted by its CLI flag. Native sound is enabled only for
// a kernel loopback module, and chooseRoute selects its verified virtual UID.
const hasSilentLoopback = fs.existsSync('/proc/asound/modules') && /\bsnd_aloop\b/.test(fs.readFileSync('/proc/asound/modules', 'utf8'))
fs.mkdirSync(profile); fs.mkdirSync(library)
const result = { started: new Date().toISOString(), executable, ozone, requireLoopback, forceBrowser, checks: [], screenshots: [] }
let app, page, drive, generator, tap
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const document = dir => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
const record = (name, detail = true) => { result.checks.push({ name, detail }); console.log('ok', name) }
const step = (name, seconds, work) => watchdog.run(name, seconds, work)
async function shot(name) { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file }); result.screenshots.push(file) }
async function ready(minDuration = 0) { await page.waitForFunction(n => __test.phase === 'ready' && __test.engine.duration > n, minDuration, { timeout: 90000 }) }
async function mix() { return page.evaluate(() => Object.fromEntries(__test.tracks.map(t => [t.id, { muted: t.muted, solo: t.solo, volume: t.volume }]))) }
async function lane(id) { const index = await page.evaluate(id => __test.tracks.findIndex(t => t.id === id), id); assert.ok(index >= 0, id); return page.locator('.lane-controls').nth(index) }
async function close() { if (!app) return; await app.close(); app = null; page = null }
async function launch(offline = false) {
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(scratch, 'config'), SINGZ_MUTE: hasSilentLoopback ? '' : '1', SINGZ_NO_SYNC: '1', SINGZ_E2E_HOOKS: '1', SINGZ_LANG: 'en', LANGUAGE: 'en', LANG: 'C.UTF-8', SINGZ_GDRIVE_CONFIG: JSON.stringify(drive.config) }
  for (const key of ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'PYTHONPATH', 'PYTHONHOME']) delete env[key]
  app = await _electron.launch({ executablePath: executable, chromiumSandbox: true, args: ['--mute-audio', '--ozone-platform=' + ozone, '--user-data-dir=' + profile], env, timeout: 60000 })
  await app.evaluate(({ app, session }, { base, offline }) => {
    global.__network = []; global.__originalFetch = global.fetch
    global.fetch = async (url, init) => {
      const href = typeof url === 'string' ? url : url.url || String(url)
      global.__network.push({ host: new URL(href).hostname, method: init?.method || 'GET' })
      if (offline || !href.startsWith(base + '/')) throw new Error('Network blocked by Linux package E2E')
      return global.__originalFetch(url, init)
    }
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => cb({ cancel: offline || !details.url.startsWith(base + '/') }))
    if (offline) session.defaultSession.enableNetworkEmulation({ offline: true })
  }, { base: drive.base, offline })
  page = await app.firstWindow(); page.setDefaultTimeout(45000)
  await page.waitForSelector('.titlebar'); await page.waitForFunction(() => Boolean(window.__test))
  const identity = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, userData: app.getPath('userData'), appData: app.getPath('appData'), resources: process.resourcesPath, electron: process.versions.electron, version: app.getVersion() }))
  assert.equal(identity.version, packageVersion, 'installed package must match the build under test')
  assert.equal(identity.packaged, true); assert.equal(identity.userData, profile); assert.ok(identity.appData.startsWith(scratch), 'must isolate models/pack via standard XDG path')
  result.install ??= identity
}
async function dismissWelcome() {
  const welcome = page.locator('.quick-start-overlay')
  await welcome.getByRole('button', { name: 'Maybe later', exact: true }).click()
  await welcome.waitFor({ state: 'detached' })
}
async function chooseRoute(native, inventory) {
  await page.locator('[data-guide="settings"]').click()
  await page.getByLabel('Use native DSP playback', { exact: true }).setChecked(native)
  if (native) {
    await page.locator('#settings-output').selectOption('native:' + inventory.output.uid)
    await page.locator('#settings-input').selectOption(inventory.input.uid)
  } else await page.locator('#settings-output').selectOption('')
  await page.keyboard.press('Escape'); await page.waitForSelector('.settings-card', { state: 'detached' })
}
async function clickPlay() {
  assert.equal(await page.evaluate(() => __test.playing), false)
  await page.locator('button.play').click()
  await page.waitForFunction(() => __test.playing && __test.engine.playing, null, { timeout: 30000 })
}
async function pause() { if (await page.evaluate(() => __test.playing)) await page.locator('button.play').click(); await page.waitForFunction(() => !__test.playing && !__test.engine.playing) }
async function openCatalog(name, minDuration = 8) {
  if (await page.getByRole('button', { name: 'Catalog', exact: true }).count()) await page.getByRole('button', { name: 'Catalog', exact: true }).click()
  const card = page.locator('.lib-card').filter({ hasText: name }); await card.waitFor(); assert.equal(await card.count(), 1)
  await card.click(); await page.waitForSelector('.lib-grid', { state: 'detached' }); await ready(minDuration)
}
async function save() {
  await page.getByRole('button', { name: /^Save project/ }).click()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Saving…'), null, { timeout: 90000 })
  const dir = result.downloadedProject || fs.readdirSync(library).map(name => path.join(library, name)).find(dir => fs.existsSync(path.join(dir, 'project.json')))
  assert.ok(dir && fs.existsSync(path.join(dir, 'project.json')), 'UI save must publish a project document')
  return { ok: true, dir }
}

async function karaoke() { if (!(await page.locator('.lyrics-panel').isVisible())) await page.locator('button.karaoke').click(); await page.waitForSelector('.lyr-line') }
async function lyricsWhilePlaying(lines) {
  const readings = []
  for (let i = 0; i < 16; i++) {
    await sleep(350)
    readings.push(await page.evaluate(() => ({ position: __test.engine.position, current: [...document.querySelectorAll('.lyr-line')].findIndex(e => e.classList.contains('current')), progress: [...document.querySelectorAll('.lyr-line.current > span')].map(e => Number(e.dataset.p)) })))
  }
  assert.ok(new Set(readings.map(r => r.current)).size >= 2, 'lyrics must change lines')
  assert.ok(readings.some(r => r.progress.some(p => p > 0 && p < 1)), 'word sweep must progress')
  for (const r of readings) {
    let expected = -1; for (let i = 0; i < lines.length; i++) if (lines[i].start <= r.position + 0.15) expected = i
    if (r.current !== expected) assert.ok(Math.abs(r.current - expected) === 1 && Math.abs(r.position + 0.15 - lines[Math.max(r.current, expected)].start) < 0.12, 'lyric line timing')
  }
  return readings
}
async function nativeHealth() {
  const status = await page.evaluate(() => __test.engine.nativePlayback.last)
  assert.equal(status.state, 'running')
  assert.equal(status.hostState, 'running')
  assert.equal(status.xruns, '0')
  assert.ok(BigInt(status.callbacks) > 0n)
  for (const key of ['adapterRenderFailures', 'terminalRenderFailures', 'nonFiniteSamples', 'rejectedBlocks']) assert.equal(status[key], 0, key)
  return status
}
async function run() {
  assert.equal(process.platform, 'linux'); assert.ok(fs.existsSync(executable), executable)
  const source = await stemProject(path.join(scratch, 'drive-source'))
  drive = await driveServer(source, scratch, projectRoot)
  // Preseeding a library root must preserve the normal fresh-install release baseline.
  fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ projectsRoot: library, releaseNotesSeen: packageVersion }), { mode: 0o600 })
  if (process.env.SINGZ_E2E_X11_SMOKE === '1') {
    assert.equal(ozone, 'x11', 'X11 startup leg must actually request X11')
    result.audioMode = 'not-exercised-x11-window-smoke'
    await step('X11 installed desktop startup and window/preference persistence', 90, async () => {
      await launch()
      const wanted = { x: 50, y: 40, width: 1100, height: 740 }
      await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), wanted)
      await page.waitForFunction(async () => (await window.singz.modelsStatus()).find(m => m.id === 'gpu-splitter')?.present, null, { timeout: 180000 })
      if (await page.locator('.wizard').count()) await page.locator('.wizard button').filter({ hasText: /^(Skip for now|Close)$/ }).click()
      await dismissWelcome()
      await page.locator('[data-guide="settings"]').click(); await page.getByLabel('Use native DSP playback', { exact: true }).check(); await page.keyboard.press('Escape')
      result.x11BoundsBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
      assert.equal(result.x11BoundsBefore.width, wanted.width)
      await shot('x11-startup')
      await close(); await launch()
      await page.locator('[data-guide="settings"]').click(); assert.equal(await page.getByLabel('Use native DSP playback', { exact: true }).isChecked(), true); await page.keyboard.press('Escape')
      result.x11BoundsAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
      assert.equal(result.x11BoundsAfter.width, result.x11BoundsBefore.width)
      assert.equal(result.x11BoundsAfter.height, result.x11BoundsBefore.height)
      record('X11 installed desktop launches and restores window bounds and saved preference')
    })
    result.passed = true
    return
  }
  await step('launch installed package and extract bundled splitter offline', 240, async () => {
    await launch()
    const engines = path.join(result.install.resources, 'engines')
    for (const file of ['singz-capture.node', 'singz-capture.manifest.json', 'singz-analyze', 'llama-server', 'crispasr', 'gpu-splitter-linux-x64.tar.gz']) assert.ok(fs.statSync(path.join(engines, file)).size > 0, file)
    const started = Date.now(); let models
    do { models = await page.evaluate(() => window.singz.modelsStatus()); if (models.find(m => m.id === 'gpu-splitter')?.present) break; assert.ok(Date.now() - started < 180000, 'bundled splitter extraction deadline'); await sleep(500) } while (true)
    if (await page.locator('.wizard').count()) { const close = page.locator('.wizard button').filter({ hasText: /^(Skip for now|Close)$/ }); if (await close.count()) await close.click() }
    await dismissWelcome()
    result.models = models.map(m => ({ id: m.id, present: m.present })); record('bundled splitter installs without external network')
  })
  const inventory = await page.evaluate(() => window.singz.audioHostDevices('alsa')); assert.equal(inventory.ok, true)
  const route = { output: inventory.devices.find(d => d.uid.includes('snd_aloop') && d.uid.endsWith(':pcm:0')), input: inventory.devices.find(d => d.uid.includes('snd_aloop') && d.uid.endsWith(':pcm:1')) }
  const native = !forceBrowser && Boolean(route.output && route.input)
  if (requireLoopback) assert.ok(native, 'SINGZ_E2E_REQUIRE_LOOPBACK requires a named snd_aloop playback/capture cable')
  result.audioMode = native ? 'native-alsa-loopback' : forceBrowser ? 'browser-forced' : 'browser-no-native-device'; result.inventory = inventory
  await chooseRoute(native, route)
  await step('normal local import, real bundled split, FLAC save', 600, async () => {
    const input = path.join(scratch, 'Linux package local split.wav'); fs.writeFileSync(input, wav(4, 220, 330, true))
    await page.locator('input[type=file]').first().setInputFiles(input); await ready(3)
    assert.deepEqual(await page.evaluate(() => __test.tracks.map(t => t.id)), ['original'])
    await page.locator('.split-control > button').click(); await page.locator('.split-menu button').first().click()
    await page.waitForFunction(() => __test.phase === 'ready' && __test.tracks.some(t => t.id.startsWith('custom-')) && __test.tracks.some(t => t.id === 'drums'), null, { timeout: 480000 })
    const saved = await save(); result.localProject = saved.dir
    const doc = document(saved.dir), files = fs.readdirSync(path.join(saved.dir, 'stems'))
    assert.equal(doc.version, 2); for (const stem of ['drums', 'bass', 'other', 'guitar', 'piano']) assert.ok(files.includes(stem + '.flac'), stem)
    // The vocal refiner produces float WAV; retain it losslessly when PCM16 FLAC encoding is inapplicable.
    assert.ok(files.includes('vocals.flac') || files.includes('vocals.wav'), 'refined vocals')
    assert.ok(files.some(f => f.startsWith('custom-'))); await shot('local-split-saved'); await close(); await launch(); await openCatalog(doc.name, 3); const opened = await page.evaluate(() => __test.engine.tracks.map(t => t.path)); assert.ok(opened.every(file => file.startsWith(saved.dir + path.sep))); assert.ok(opened.length >= 4); record('normal import, real six-stem/backing split, lossless save and cold reopen')
  })
  await step('Drive phone approval, issuer refresh, cancel/resume stem-only download', 180, async () => {
    const readerRoot = path.join(scratch, 'reader-writer-empty'); fs.mkdirSync(readerRoot)
    const switched = await page.evaluate(root => window.singz.setProjectsRoot(root), readerRoot)
    assert.equal(switched.ok, true)
    // The normal root switch copies existing projects. Hold this test-only
    // copy outside the writer root; the already-qualified original stays put.
    const copied = path.join(readerRoot, path.basename(result.localProject))
    if (fs.existsSync(copied)) fs.renameSync(copied, path.join(scratch, 'qualified-writer-copy'))
    assert.deepEqual(fs.readdirSync(readerRoot), [])
    await page.getByRole('button', { name: 'Catalog', exact: true }).click()
    await page.getByRole('button', { name: 'Connect…', exact: true }).click()
    await page.getByAltText('Open Google verification on your phone').waitFor()
    await shot('phone-approval'); drive.approve()
    await page.waitForFunction(async () => (await window.singz.gdriveStatus()).signedIn, null, { timeout: 20000 })
    await page.getByRole('button', { name: 'Google Drive projects', exact: true }).click()
    const row = page.locator('.picker-row').filter({ hasText: source.doc.name }); await row.waitFor(); await row.click()
    await page.getByRole('status').filter({ hasText: 'stems/' }).waitFor(); await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByText('Download paused. Verified files are kept. Choose the song to continue.', { exact: true }).waitFor(); await row.click()
    await page.waitForFunction(prefix => __test.phase === 'ready' && __test.engine.tracks.length > 0 && __test.engine.tracks.every(t => t.path.startsWith(prefix)), path.join(profile, 'drive-projects') + path.sep, { timeout: 90000 }); await ready(10)
    const paths = await page.evaluate(() => __test.engine.tracks.map(t => t.path)); const dir = path.dirname(path.dirname(paths[0])); result.downloadedProject = dir
    assert.ok(dir.startsWith(path.join(profile, 'drive-projects') + path.sep)); assert.ok(!fs.existsSync(path.join(dir, source.doc.songFile)))
    for (const [name, hash] of Object.entries(source.doc.stemHashes)) assert.equal(md5(fs.readFileSync(path.join(dir, 'stems', name))), hash.md5)
    assert.ok(drive.state.refreshRequests.length > 0, 'short-lived grant must refresh with TV client'); assert.deepEqual(drive.state.writes, [])
    record('phone approval, TV-client refresh and cancellable verified reader download')
  })
  await step('native/browser playback, lyrics, transport and non-default stem mix', 150, async () => {
    await karaoke(); await page.evaluate(() => { __test.engine.seek(0.5) })
    if (native) assert.ok(route.output.uid.includes('snd_aloop'))
    await clickPlay()
    if (native) {
      await page.evaluate(() => { window.__frames = []; window.__off = window.singz.onDesktopAudioInputEvent((_token, e) => { if (e.type === 'frame') window.__frames.push({ rms: e.rms, frequency: e.frequency }) }) })
      await page.evaluate(async uid => { await __test.trainingMic.start(__test.engine.context, { nativeDeviceUid: uid, channelIndex: 0 }) }, route.input.uid)
    }
    result.lyrics = await lyricsWhilePlaying(JSON.parse(fs.readFileSync(path.join(result.downloadedProject, 'lyrics.json'))).lines)
    if (native) { result.nativeStatus = await nativeHealth(); result.capture = await page.evaluate(() => window.__frames); assert.ok(result.capture.some(f => f.rms > 0.001)); await page.evaluate(async () => { await __test.trainingMic.stopAndWait(); window.__off() }) }
    await pause(); await shot('playing-lyrics')
    const guitar = await lane('guitar'); await guitar.locator('.vol').fill('0.63'); await guitar.locator('.solo').click()
    const drums = await lane('drums'); await drums.locator('.mute').click()
    await page.waitForFunction(() => __test.tracks.find(t => t.id === 'guitar').volume === 0.63 && __test.tracks.find(t => t.id === 'guitar').solo && __test.tracks.find(t => t.id === 'drums').muted)
    result.savedMix = await mix(); assert.equal(result.savedMix.guitar.volume, 0.63); assert.equal(result.savedMix.guitar.solo, true)
    await save(); assert.deepEqual(document(result.downloadedProject).settings.tracks, result.savedMix)
    await page.evaluate(async () => { await __test.engine.setTranspose(2); await __test.engine.setTempo(1.1); await __test.engine.setRegion({ start: 1, end: 2 }, true); __test.engine.seek(1) })
    await clickPlay(); await page.waitForFunction(() => __test.engine.position > 1.15, null, { timeout: 20000 }); await sleep(1800)
    if (native) { const s = await nativeHealth(); assert.ok(Number(s.loopCount) > 0, 'native loop wraps'); assert.equal(s.transposeSemitones, 2); assert.ok(Math.abs(s.playbackRate - 1.1) < 0.001) }
    await pause(); await page.evaluate(async () => { await __test.engine.setRegion(null, false); await __test.engine.setTranspose(0); await __test.engine.setTempo(1); __test.engine.seek(__test.engine.duration - 0.3) })
    await clickPlay(); await page.waitForFunction(() => !__test.playing && !__test.engine.playing, null, { timeout: 15000 }); record('play/pause/end, loop, tempo, transpose, lyric timing and non-default stem controls')
  })
  if (native) await step('forced ALSA underrun stops the UI, logs once and recovers on explicit Play', 60, async () => {
    await page.evaluate(() => __test.engine.seek(1)); await clickPlay()
    await page.waitForFunction(() => __test.engine.position > 1.5)
    const pid = app.process().pid
    // Suspend only our isolated Electron main/native process, long enough for
    // the silent loopback ring to empty. Always resume it, including on failure.
    process.kill(pid, 'SIGSTOP')
    try { await sleep(300) } finally { process.kill(pid, 'SIGCONT') }
    await page.waitForFunction(() => !__test.playing && Boolean(__test.engine.playbackError), null, { timeout: 15000 })
    result.forcedTerminal = await page.evaluate(async () => ({
      position: __test.engine.position, error: __test.engine.playbackError.message,
      status: await window.singz.desktopPlaybackStatus(),
      logs: (await window.singz.getLog()).filter(row => row.line.startsWith('playback stopped'))
    }))
    assert.equal(result.forcedTerminal.status.state, 'terminal')
    assert.ok(Number(result.forcedTerminal.status.xruns) > 0)
    assert.ok(result.forcedTerminal.position > 1)
    assert.match(result.forcedTerminal.error, /buffer underrun/)
    assert.equal(result.forcedTerminal.logs.length, 1)
    assert.equal(await page.locator('button.play').getAttribute('aria-busy'), 'false')
    await shot('underrun-recovery')
    await clickPlay()
    await page.waitForFunction(before => __test.engine.position > before + 0.2 && !__test.engine.playbackError, result.forcedTerminal.position)
    await nativeHealth(); await pause()
    record('real ALSA underrun stops stale Playing telemetry; explicit Play cleans up and resumes')
  })
  if (native) await step('headphone monitor handoff, gain, channel switch and playback reacquisition', 120, async () => {
    assert.ok(route.output.uid.includes('snd_aloop'))
    const card = process.env.SINGZ_E2E_ALSA_CARD || 'SingZLoop'
    assert.match(card, /^[A-Za-z0-9_-]+$/)
    const signal = Buffer.alloc(48000 * 100 * 8)
    for (let n = 0; n < 48000 * 100; n++) { signal.writeFloatLE(0.04 * Math.sin(2 * Math.PI * 220 * n / 48000), n * 8); signal.writeFloatLE(0.04 * Math.sin(2 * Math.PI * 330 * n / 48000), n * 8 + 4) }
    const args = ['-D', `hw:${card},1,0`, '-t', 'raw', '-f', 'FLOAT_LE', '-c', '2', '-r', '48000', '--period-size=512', '--buffer-size=2048']
    const chunks = []; let retained = 0, received = 0, feedError = '', tapError = ''
    result.monitorIO = { feedError: '', tapError: '' }
    const startTap = () => {
      chunks.length = 0; retained = 0
      // Open the peer capture only after the monitor owns/runs its output.
      // ALSA loopback tears the old peer down during the song/monitor handoff.
      tap = spawn('arecord', [...args, '-d', '100'], { stdio: ['ignore', 'pipe', 'pipe'] })
      tap.stdout.on('data', b => { chunks.push(b); retained += b.length; received += b.length; while (retained > 48000 * 8 * 3 && chunks.length > 1) retained -= chunks.shift().length })
      tap.stderr.on('data', b => { tapError += b; result.monitorIO.tapError = tapError })
    }
    const stopTap = async () => {
      if (!tap) return
      const tapProcess = tap; tap = null
      if (tapProcess.exitCode !== null || tapProcess.signalCode !== null) return
      await new Promise(resolve => { tapProcess.once('close', resolve); tapProcess.kill('SIGTERM') })
    }
    generator = spawn('aplay', args, { stdio: ['pipe', 'ignore', 'pipe'] }); generator.stderr.on('data', b => { feedError += b; result.monitorIO.feedError = feedError }); generator.stdin.on('error', () => {}); generator.stdin.end(signal)
    const stats = () => {
      const bytes = Buffer.concat(chunks), count = Math.min(24000, Math.floor(bytes.length / 8)), start = bytes.length - count * 8
      assert.ok(count > 2000, `monitor output tap has PCM: ${tapError}; feed: ${feedError}`)
      let squares = [0, 0]; const tones = []
      for (let i = 0; i < count; i++) for (let c = 0; c < 2; c++) { const v = bytes.readFloatLE(start + i * 8 + c * 4); assert.ok(Number.isFinite(v)); squares[c] += v * v }
      for (const frequency of [220, 330]) { let re = 0, im = 0; for (let i = 0; i < count; i++) { const v = bytes.readFloatLE(start + i * 8); re += v * Math.cos(2 * Math.PI * frequency * i / 48000); im += v * Math.sin(2 * Math.PI * frequency * i / 48000) } tones.push(Math.hypot(re, im) * 2 / count) }
      return { rms: squares.map(n => Math.sqrt(n / count)), tones, received }
    }
    await page.locator('[data-guide="settings"]').click()
    await page.locator('#settings-input').selectOption(route.output.uid); await page.locator('#settings-input-channel').selectOption('0'); await page.locator('#monitor-output').selectOption(route.output.uid)
    await page.keyboard.press('Escape'); await page.evaluate(() => __test.engine.seek(1)); await clickPlay()
    await page.locator('[data-guide="settings"]').click(); await page.locator('.monitor-headphones-check input').check(); await page.getByRole('button', { name: 'Start monitoring', exact: true }).click()
    await page.waitForFunction(async () => { const s = await window.singz.monitorStatus(); return s.active && s.enabled }, null, { timeout: 20000 })
    assert.equal(await page.evaluate(() => __test.engine.nativeActive || __test.engine.playing), false, 'monitor retires song graph')
    startTap()
    await page.locator('#monitor-gain').fill('-6'); await sleep(900); const loud = stats(); for (const rms of loud.rms) assert.ok(Math.abs(rms - 0.04 / Math.sqrt(2) * Math.pow(10, -6 / 20)) < 0.003); assert.ok(loud.tones[0] > loud.tones[1] * 10)
    await page.locator('#monitor-gain').fill('-18'); await sleep(900); const quiet = stats(); for (let c = 0; c < 2; c++) assert.ok(Math.abs(quiet.rms[c] / loud.rms[c] - Math.pow(10, -12 / 20)) < 0.03)
    const status = await page.evaluate(() => window.singz.monitorStatus()); assert.equal(status.active, true); assert.equal(status.enabled, true); assert.equal(status.state, 'running'); assert.equal(status.xruns, '0'); assert.ok(BigInt(status.callbacks) > 0n); assert.equal(status.adapterRenderFailures, 0); assert.equal(status.terminalRenderFailures, 0)
    await stopTap(); await page.getByRole('button', { name: 'Stop monitoring', exact: true }).click(); await page.waitForFunction(async () => !(await window.singz.monitorStatus()).active)
    await page.locator('#settings-input-channel').selectOption('1'); await page.locator('.monitor-headphones-check input').check(); await page.getByRole('button', { name: 'Start monitoring', exact: true }).click(); await page.waitForFunction(async () => (await window.singz.monitorStatus()).active); startTap(); await sleep(900)
    const channelTwo = stats(); assert.ok(channelTwo.tones[1] > channelTwo.tones[0] * 10)
    await stopTap(); await page.getByRole('button', { name: 'Stop monitoring', exact: true }).click(); await page.waitForFunction(async () => !(await window.singz.monitorStatus()).active); assert.equal(await page.evaluate(() => __test.playing), false)
    await shot('monitor-stopped'); await page.keyboard.press('Escape'); await page.evaluate(() => __test.engine.seek(1)); await clickPlay(); await page.waitForFunction(() => __test.engine.nativeActive && __test.engine.position > 1.2); await pause()
    generator.stdin.destroy(); generator.kill('SIGTERM'); generator = null; await stopTap()
    result.monitor = { loud, quiet, channelTwo, status, feedError, tapError }; record('monitor handoff, -6/-18dB gain ratio, 220/330Hz channel selection and song output reacquisition')
  })
  await step('cold restart offline preserves six downloaded stems, lyrics and non-default mix', 120, async () => {
    const oldPid = app.process().pid; await close(); await launch(true); assert.notEqual(app.process().pid, oldPid)
    await openCatalog(source.doc.name); assert.deepEqual(await mix(), result.savedMix)
    assert.ok(!fs.existsSync(path.join(result.downloadedProject, source.doc.songFile))); await karaoke()
    await page.evaluate(() => __test.engine.seek(0.5)); await clickPlay()
    result.offlineLyrics = await lyricsWhilePlaying(JSON.parse(fs.readFileSync(path.join(result.downloadedProject, 'lyrics.json'))).lines)
    if (native) {
      result.offlineNativeStatus = await nativeHealth()
      const prepared = await page.evaluate(() => window.singz.desktopPlaybackStatus())
      for (const l of prepared.lanes) {
        assert.equal(l.muted, result.savedMix[l.id].muted)
        assert.equal(l.solo, result.savedMix[l.id].solo)
        assert.ok(Math.abs(l.gain - result.savedMix[l.id].volume) < 1e-6, `${l.id} native float32 gain`)
      }
    }
    await pause(); assert.deepEqual(document(result.downloadedProject).settings.tracks, result.savedMix)
    await shot('cold-offline-restored'); record(native ? 'offline cold process restart preserves non-default mix in UI and native graph' : 'offline cold process restart preserves non-default mix in UI and browser transport')
  })
  result.drive = { deviceRequests: drive.state.deviceRequests, refreshRequests: drive.state.refreshRequests.length, mutations: drive.state.writes }
  assert.deepEqual(drive.state.writes, []); result.passed = true
}
run().catch(async error => {
  result.error = error.stack; console.error(error)
  if (page) { result.log = await page.evaluate(() => window.singz.getLog()).catch(() => null); result.body = await page.locator('body').innerText().catch(() => null); await shot('failure').catch(() => {}) }
  process.exitCode = 1
}).finally(async () => {
  if (generator) { generator.stdin.destroy(); generator.kill('SIGTERM') }
  if (tap) tap.kill('SIGTERM')
  await close().catch(error => { result.cleanupError = String(error); process.exitCode = 1 })
  if (drive) await drive.close()
  if (!result.cleanupError && process.env.SINGZ_E2E_KEEP_SCRATCH !== '1') {
    try { fs.rmSync(scratch, { recursive: true, force: true }) }
    catch (error) { result.cleanupError = String(error); process.exitCode = 1 }
  }
  result.scratchRetained = fs.existsSync(scratch)
  if (result.cleanupError) result.passed = false
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2)); watchdog.disarm()
  console.log(JSON.stringify({ passed: result.passed === true, audioMode: result.audioMode, evidence }))
})
