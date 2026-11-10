'use strict'
const watchdog = require('../shared/watchdog.cjs').arm('box-cjm-smoke', {
  onTimeout: () => closeAll()
})
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { _electron, chromium } = require('playwright-core')
const { stemProject, driveServer, md5 } = require('./linux/fixtures.cjs')

const root = path.resolve(__dirname, '../..')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-box-cjm-'))
const userData = path.join(scratch, 'user-data')
const library = path.join(scratch, 'library')
const models = path.join(scratch, 'models')
const pack = path.join(scratch, 'pack')
for (const dir of [userData, library, models, pack]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ projectsRoot: library, language: 'en' }, null, 2), { mode: 0o600 })

let app = null
let browser = null
let drive = null
let closing = null
function closeAll() {
  if (closing) return closing
  closing = (async () => {
    const currentBrowser = browser
    browser = null
    if (currentBrowser) await currentBrowser.close().catch(() => undefined)
    const currentApp = app
    app = null
    if (currentApp) await currentApp.close().catch(() => undefined)
    const currentDrive = drive
    drive = null
    if (currentDrive) await currentDrive.close().catch(() => undefined)
  })()
  return closing
}
function check(condition, message) {
  console.log(`${condition ? 'ok' : 'FAIL'} ${message}`)
  if (!condition) throw new Error(message)
}
function unwrap(result, operation) {
  check(result && typeof result === 'object' && typeof result.ok === 'boolean', `${operation} returns BoxResult`)
  if (!result.ok) throw new Error(`${operation}: ${result.code ?? 'error'}: ${result.error}`)
  return result.value
}
const packaged = process.env.E2E_PACKAGED ? path.resolve(process.env.E2E_PACKAGED) : null
function launchBox() {
  const env = {
    ...process.env,
    SINGZ_SURFACE: 'desktop',
    SINGZ_USERDATA_DIR: userData,
    SINGZ_MODELS_DIR: models,
    SINGZ_PACK_DIR: pack,
    SINGZ_NO_SYNC: '1',
    SINGZ_NO_SYSTEM_ENGINES: '1',
    SINGZ_MUTE: '1',
    SINGZ_E2E_HIDDEN: '1',
    SINGZ_LANG: 'en',
    SINGZ_GDRIVE_CONFIG: JSON.stringify(drive.config)
  }
  return _electron.launch(packaged
    ? { executablePath: packaged, args: [], env }
    : { executablePath: require('electron'), args: [path.join(root, 'out/main/index.js'), '--box'], env })
}
async function boxCall(method, ...args) {
  return page.evaluate(async ({ method, args }) => {
    const box = window.singz?.box
    if (!box || typeof box[method] !== 'function') {
      throw new Error(`MISSING BACKEND CONTEXT: window.singz.box.${method} from src/shared/box-contract.ts`)
    }
    return box[method](...args)
  }, { method, args })
}
let page = null
const screenshotDir = process.env.E2E_SCREENSHOT_DIR ? path.resolve(process.env.E2E_SCREENSHOT_DIR) : null
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true })
async function capture(name) {
  if (!screenshotDir) return
  await page.evaluate(() => document.fonts.ready.then(() => null))
  const alignment = await page.evaluate(() => {
    const surface = document.querySelector('.box-safe-surface').getBoundingClientRect()
    const scale = surface.width / 1600
    const titles = [...document.querySelectorAll('.box-heading h1, .queue-heading h1, .settings-heading h1, .account-heading h1, .journey-heading h1')]
      .filter(node => node.getClientRects().length && !node.closest('[hidden], [inert]'))
      .map(node => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return { x: (rect.left - surface.left) / scale, y: (rect.top - surface.top) / scale, size: parseFloat(style.fontSize), line: parseFloat(style.lineHeight), weight: style.fontWeight, font: style.fontFamily }
      })
    return { viewport: [innerWidth, innerHeight], fontsLoaded: document.fonts.status === 'loaded', titles }
  })
  check(alignment.fontsLoaded, `${name}: UIKit fonts finish loading`)
  for (const title of alignment.titles) {
    check(Math.abs(title.x - 40) < 0.1 && Math.abs(title.y - 96) < 0.1 && title.size === 32 && title.line === 40 && title.weight === '700' && title.font.includes('Bricolage'), `${name}: real app title uses the shared font, baseline and gutter`)
  }
  fs.writeFileSync(path.join(screenshotDir, `box-cjm-${name}.alignment.json`), JSON.stringify(alignment, null, 2))
  await page.screenshot({ path: path.join(screenshotDir, `box-cjm-${name}.png`), scale: 'css' })
}
async function openWindow() {
  app = await launchBox()
  page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(3840, 2160))
  await page.waitForFunction(() => innerWidth === 3840 && innerHeight === 2160)
  await page.waitForSelector('[data-app="singz-box"]', { timeout: 60000 })
  console.log('ok real Electron exposes Box on a 3840x2160 viewport')
}
async function tvEnter(target) {
  const locator = typeof target === 'string' ? page.locator(target) : target
  await locator.waitFor({ state: 'visible' })
  if (!await locator.isEnabled()) throw new Error('TV Enter target is disabled')
  await locator.scrollIntoViewIfNeeded()
  await locator.focus()
  await page.keyboard.press('Enter')
}
async function tvBack() {
  await page.keyboard.press('Escape')
}
async function waitForBoxState(predicate, description) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const state = unwrap(await boxCall('getState'), description)
    if (predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${description}`)
}
function phoneRequest(base, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, base)
    if (url.protocol !== 'http:') return reject(new Error('Phone test requires the actual local HTTP listener'))
    const body = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body))
    const headers = { Host: url.host, Connection: 'close' }
    if (body) {
      headers.Origin = url.origin
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = body.length
    }
    if (options.nonce) headers['X-SingZ-CSRF'] = options.nonce
    if (options.token) headers.Authorization = `Bearer ${options.token}`
    const req = http.request(url, { method: options.method ?? (body ? 'POST' : 'GET'), headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        if ((res.headers['content-type'] ?? '').includes('application/json')) {
          try { json = JSON.parse(text) } catch { return reject(new Error('Phone listener returned invalid JSON')) }
        }
        resolve({ status: res.statusCode ?? 0, text, json })
      })
    })
    req.setTimeout(15000, () => req.destroy(new Error('Phone HTTP request timed out')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
function phoneJson(response, status) {
  check(response.status === status, `phone HTTP returns ${status}`)
  check(response.json && typeof response.json === 'object', 'phone HTTP returns a JSON object')
  return response.json
}
async function requestPhonePair(invite) {
  const client = { base: invite.url, phonePage: null, errors: [], nonce: null, requestId: null, pollSecret: null }
  if (process.env.E2E_SKIP_PHONE_BROWSER === '1') {
    console.log('SKIP phone Chrome DOM coverage: caller selected E2E_SKIP_PHONE_BROWSER=1; using real HTTP only')
    const landing = await phoneRequest(client.base, '/')
    check(landing.status === 200, 'phone pairing page loads over real HTTP')
    const match = /<script nonce="([^"]+)"/.exec(landing.text)
    check(match !== null, 'pairing page issues a CSRF nonce')
    client.nonce = match[1]
    const paired = phoneJson(await phoneRequest(client.base, '/api/pair', {
      nonce: client.nonce, body: { invitation: invite.code, name: 'CJM Test Phone' }
    }), 202)
    check(paired.status === 'pending', 'phone pair request waits for TV approval')
    client.requestId = paired.requestId
    client.pollSecret = paired.pollSecret
    return client
  }
  browser = await chromium.launch({
    executablePath: process.env.E2E_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-first-run', '--no-proxy-server', '--disable-background-networking', '--disable-sync']
  })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const phonePage = await context.newPage()
  client.phonePage = phonePage
  phonePage.on('pageerror', () => client.errors.push('pageerror'))
  phonePage.on('console', message => {
    if (message.type() === 'error' && /Content Security Policy|Refused to execute|violates.*directive/i.test(message.text())) client.errors.push('CSP')
  })
  await phonePage.goto(invite.url)
  client.nonce = await phonePage.locator('script[nonce]').evaluate(script => script.nonce)
  check(typeof client.nonce === 'string' && client.nonce.length > 0, 'headless phone page exposes its real CSRF nonce to the pairing script')
  check(await phonePage.locator('#invitation').inputValue() === invite.code, 'phone page reads the invitation from the real QR URL fragment')
  await phonePage.locator('#name').fill('CJM Test Phone')
  await phonePage.getByRole('button', { name: 'Request TV approval', exact: true }).click()
  await phonePage.waitForFunction(() => requestId !== null && pollSecret !== null)
  const pending = await phonePage.evaluate(() => ({ requestId, pollSecret }))
  client.requestId = pending.requestId
  client.pollSecret = pending.pollSecret
  return client
}
async function awaitPhoneToken(client) {
  if (client.phonePage) {
    await client.phonePage.waitForFunction(() => typeof sessionToken === 'string' && sessionToken.length > 0, null, { timeout: 30000 })
    return client.phonePage.evaluate(() => sessionToken)
  }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const result = phoneJson(await phoneRequest(client.base, '/api/pair-status', {
      nonce: client.nonce, body: { requestId: client.requestId, pollSecret: client.pollSecret }
    }), 200)
    if (result.status === 'approved') return result.sessionToken
    check(result.status === 'pending', 'pair polling remains pending until TV approval')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Phone approval did not publish an auth token before deadline')
}
async function closePhoneBrowser() {
  const current = browser
  browser = null
  if (current) await current.close()
}

async function phoneJourney() {
  await watchdog.run('pair a real phone controller and revoke its access', 150, async () => {
    await tvEnter('[data-control="settings"]')
    await tvEnter('[data-focus="journey-phones"]')
    const phones = page.locator('[data-journey-page="phones"]')
    await tvEnter(phones.locator('[data-journey-primary]'))
    const invite = unwrap(await boxCall('phoneState'), 'phoneState invitation')
    check(invite.running && invite.url && invite.code, 'TV supplies an actual reachable phone invitation')
    check((await phoneRequest(invite.url, '/api/state')).status === 401, 'unpaired phone cannot read playback')
    const client = await requestPhonePair(invite)
    const pending = phones.locator('.journey-item', { hasText: 'CJM Test Phone' })
    await tvEnter(pending.getByRole('button', { name: 'Approve', exact: true }))
    const token = await awaitPhoneToken(client)
    const state = phoneJson(await phoneRequest(client.base, '/api/state', { token }), 200).snapshot
    check(state.activeProjectId && state.songs.length > 0, 'approved phone reads current song and catalog')
    const publicState = JSON.stringify(state)
    check(!publicState.includes(userData) && !publicState.includes(library) && !publicState.includes('fixture-refresh'), 'phone snapshot excludes private paths and Drive credentials')
    if (client.phonePage) {
      await client.phonePage.locator('#controller').waitFor({ state: 'visible' })
      check(client.errors.length === 0, 'phone controller runs without CSP or JavaScript errors')
      if (screenshotDir) await client.phonePage.screenshot({ path: path.join(screenshotDir, 'box-cjm-phone.png') })
    }
    const command = async value => phoneJson(await phoneRequest(client.base, '/api/command', { token, nonce: client.nonce, body: value }), 200)
    check((await command({ type: 'volume', target: 'master', value: 0.7 })).ok, 'phone mixer waits for the real accepted gain')
    if (client.phonePage) {
      await client.phonePage.locator('[data-view="mix"]').click()
      await client.phonePage.getByRole('slider', { name: 'Master volume', exact: true }).evaluate(input => {
        input.value = '0.6'
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await client.phonePage.waitForFunction(() => !busy && Math.abs((snapshot?.transport.masterVolume ?? -1) - 0.6) < 0.001)
      check(await client.phonePage.locator('#error').textContent() === '', 'phone mixer DOM sends an accepted gain without errors')
      await client.phonePage.locator('[data-view="playing"]').click()
      await client.phonePage.getByRole('button', { name: 'Play/Pause', exact: true }).click()
      await client.phonePage.waitForFunction(() => !busy && snapshot?.transport.playing === true)
      check(await client.phonePage.locator('#error').textContent() === '', 'phone Play button receives successful native playback acceptance')
    } else {
      check((await command({ type: 'play-pause' })).ok, 'phone starts playback through the shared transport')
    }
    const before = await page.evaluate(() => window.singz.desktopPlaybackStatus())
    await page.waitForTimeout(300)
    const after = await page.evaluate(() => window.singz.desktopPlaybackStatus())
    check(after.generation === before.generation && BigInt(after.audibleProjectFrame) > BigInt(before.audibleProjectFrame), 'native playback continues while the TV browses phone settings')
    if (client.phonePage) {
      await client.phonePage.getByRole('button', { name: 'Pause', exact: true }).click()
      await client.phonePage.waitForFunction(() => !busy && snapshot?.transport.playing === false)
      check(await client.phonePage.locator('#error').textContent() === '', 'phone Pause button receives successful native acceptance')
    } else {
      check((await command({ type: 'play-pause' })).ok, 'phone pauses through the accepted native receipt')
    }
    await capture('phones-approved')
    await tvEnter(phones.getByRole('button', { name: 'Revoke access', exact: true }))
    const dialog = page.locator('[data-surface="journey-confirmation"]')
    await dialog.waitFor()
    check(await dialog.locator('[data-journey-confirm-cancel]').evaluate(node => node === document.activeElement), 'phone revocation starts on Cancel')
    await page.keyboard.press('Escape')
    check((await phoneRequest(client.base, '/api/state', { token })).status === 200, 'Cancel preserves phone authorization')
    await tvEnter(phones.getByRole('button', { name: 'Revoke access', exact: true }))
    await tvEnter('[data-focus="journey-confirm-action"]')
    check((await phoneRequest(client.base, '/api/state', { token })).status === 401, 'TV revocation removes phone access immediately')
    if (client.phonePage) await client.phonePage.locator('#pairing').waitFor({ state: 'visible' })
    check(client.errors.length === 0, 'phone interactions and revocation produce no CSP or JavaScript errors')
    await closePhoneBrowser()
    await tvBack()
    await tvBack()
    await page.waitForSelector('.box-player[data-playing="false"]')
    check((await driveStatus()).signedIn, 'guest phone revocation leaves Drive signed in')
  })
}
async function driveStatus() {
  return page.evaluate(async () => {
    if (typeof window.singz?.gdriveStatus !== 'function') {
      throw new Error('MISSING BACKEND CONTEXT: window.singz.gdriveStatus for the signed-in assertion')
    }
    return window.singz.gdriveStatus()
  })
}
function assertCloudProject(dir, source) {
  const expected = ['bass', 'drums', 'guitar', 'other', 'piano', 'vocals'].map(stem => `${stem}.flac`)
  const stems = path.join(dir, 'stems')
  check(fs.readdirSync(stems).filter(name => name.endsWith('.flac')).sort().join('|') === expected.join('|'), 'preparation publishes exactly six FLAC stems')
  check(!fs.readdirSync(stems).some(name => name.endsWith('.part')), 'preparation leaves no partial stem files')
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
  for (const name of expected) {
    const bytes = fs.readFileSync(path.join(stems, name))
    check(bytes.equals(fs.readFileSync(path.join(source.dir, 'stems', name))), `${name} matches the cloud fixture bytes`)
    check(doc.stemHashes[name]?.md5 === md5(bytes) && doc.stemHashes[name]?.size === bytes.length, `${name} has a truthful published hash`)
  }
  const lyrics = fs.readFileSync(path.join(dir, 'lyrics.json'))
  check(lyrics.equals(fs.readFileSync(path.join(source.dir, 'lyrics.json'))), 'synchronized lyrics are byte-identical to the cloud fixture')
  check(doc.lyricsHash?.md5 === md5(lyrics) && doc.lyricsHash?.size === lyrics.length, 'published lyrics hash matches the verified bytes')
}

async function cloudJourney(localProject, cloudProject) {
  let cloudId = null
  let cloudDir = null
  let cloudQueueRef = null
  await watchdog.run('download verify queue and explicitly sing the cloud song', 240, async () => {
    const localRow = page.locator('.box-song-row', { hasText: 'Local Fixture' })
    const namedCloudRow = page.locator('.box-song-row', { hasText: 'Cloud Fixture' })
    await localRow.waitFor()
    await namedCloudRow.waitFor({ timeout: 60000 })
    cloudId = await namedCloudRow.getAttribute('data-collection-id')
    check(typeof cloudId === 'string' && cloudId.length > 0, 'Drive row exposes its real collection ID')
    const cloudRow = page.locator(`.box-song-row[data-collection-id=${JSON.stringify(cloudId)}]`)
    check(await localRow.count() === 1 && await cloudRow.count() === 1, 'catalog lists one local and one Drive-only fixture')
    check(await localRow.getAttribute('data-project-dir') === localProject.dir, 'local row resolves to the 120-second local project')
    check(await cloudRow.getAttribute('data-project-dir') === cloudId, 'Drive-only row has no local project directory')
    await capture('catalog')
    await tvEnter(cloudRow)
    const details = page.locator('[data-surface="details"]')
    await details.waitFor()
    check(await details.getAttribute('data-collection-id') === cloudId, 'details open the selected Drive collection entry')
    await tvEnter(details.locator('[data-detail-primary]'))
    await details.getByRole('button', { name: 'Sing', exact: true }).waitFor({ timeout: 120000 })
    check(await details.locator('.box-download-progress').count() === 0, 'preparation settles before Sing becomes available')

    const storage = unwrap(await boxCall('storageSnapshot'), 'box.storageSnapshot after preparation')
    const cached = storage.projects.filter(item => item.name === 'Cloud Fixture')
    check(cached.length === 1 && typeof cached[0].driveId === 'string' && cached[0].driveId.length > 0, 'storage identifies one downloaded Drive project')
    cloudDir = cached[0].dir
    check(path.dirname(path.resolve(cloudDir)) === path.join(userData, 'drive-projects'), 'downloaded project enters the isolated reader cache')
    check(path.resolve(cloudDir) !== path.resolve(cloudProject.dir), 'verified download is not the external fixture source')
    assertCloudProject(cloudDir, cloudProject)
    check(drive.state.writes.length === 0, 'download and verification perform only read operations')
    await capture('cloud-prepared')

    await tvEnter(details.getByRole('button', { name: 'Add to queue', exact: true }))
    await waitForBoxState(state => state.queue.some(ref => ref.kind === 'drive' && ref.id === cached[0].driveId), 'saved Drive queue entry')
    const state = unwrap(await boxCall('getState'), 'box.getState after queue add')
    check(state.queue.length === 1 && state.queue[0].kind === 'drive' && state.queue[0].id === cached[0].driveId, 'real queue API persists the Drive entry')
    cloudQueueRef = state.queue[0]
    await tvEnter(details.getByRole('button', { name: 'Sing', exact: true }))
    await page.waitForSelector('.box-player[data-active-song][data-playing="false"]', { timeout: 60000 })
    const player = page.locator('.box-player')
    check(path.resolve(await player.getAttribute('data-active-song')) === path.resolve(cloudDir), 'explicit Sing opens the verified downloaded project')
    check(Number(await player.getAttribute('data-position')) === 0, 'explicit Sing opens paused at zero')
    check((await page.locator('.player-lyrics').textContent()).includes('Linux fixture line 1'), 'player renders the verified synchronized lyrics')
    await capture('cloud-paused')
    await tvEnter('[data-control="mix"]')
    await page.waitForFunction(() => {
      const card = document.querySelector('.box-mixer-card')
      const scrim = card?.closest('.modal-scrim')
      return card && scrim && getComputedStyle(card).opacity === '1' && getComputedStyle(scrim).opacity === '1'
    })
    await capture('mixer-main')
    await tvEnter(page.getByRole('button', { name: 'Stems', exact: true }))
    await capture('mixer-stems')
    await tvEnter('[data-mix-close]')
    await page.locator('.box-mixer').waitFor({ state: 'hidden' })
    await phoneJourney()
  })

  await watchdog.run('reject active cache deletion without remote mutation', 60, async () => {
    const writes = JSON.stringify(drive.state.writes)
    const rejected = await boxCall('removeCachedProject', cloudDir)
    check(rejected && typeof rejected.ok === 'boolean', 'active cache deletion returns BoxResult')
    check(rejected.ok === false && rejected.code === 'project-active', 'real API rejects deleting the active project cache')
    check(JSON.stringify(drive.state.writes) === writes, 'rejected active-cache deletion leaves remote Drive writes unchanged')
    check(fs.existsSync(path.join(cloudDir, 'lyrics.json')) && fs.readdirSync(path.join(cloudDir, 'stems')).filter(name => name.endsWith('.flac')).length === 6, 'rejected deletion preserves every active local file')
  })

  await watchdog.run('restart and recover the persisted queue through real UI', 150, async () => {
    const before = unwrap(await boxCall('getState'), 'box.getState before restart')
    await app.close()
    app = null
    await openWindow()
    await page.waitForSelector('.box-tv[data-route="catalog"]')
    const localRow = page.locator('.box-song-row', { hasText: 'Local Fixture' })
    const cloudRow = page.locator('.box-song-row', { hasText: 'Cloud Fixture' })
    await localRow.waitFor()
    await cloudRow.waitFor({ timeout: 60000 })
    check(await cloudRow.getAttribute('data-project-dir') === cloudDir, 'restart resolves the Drive row to its verified local cache')
    const after = unwrap(await boxCall('getState'), 'box.getState after restart')
    check(after.preferences.setupComplete === true, 'restart does not repeat completed setup')
    check(JSON.stringify(after.queue) === JSON.stringify(before.queue), 'persisted queue survives the real app restart')
    check(await page.locator('.box-player').count() === 0, 'restart does not autoplay the previously active song')
    await tvEnter(page.locator('.box-navigation button').filter({ hasText: 'Queue' }))
    await page.waitForSelector('.box-tv[data-route="queue"]')
    check(await page.locator('.queue-row').count() === 1, 'queue UI restores one entry after restart')
    check((await page.locator('.queue-row').textContent()).includes('Cloud Fixture'), 'queue UI restores the cloud song')
    await capture('queue-after-restart')
    await tvBack()
    await page.waitForSelector('.box-tv[data-route="catalog"]')
  })

  await watchdog.run('sign out and reopen the cached song offline after restart', 150, async () => {
    await tvEnter('[data-focus="settings"]')
    await capture('settings-home')
    await tvEnter('[data-focus="journey-privacy"]')
    const privacy = page.locator('[data-journey-page="privacy"]')
    await tvEnter(privacy.getByRole('button', { name: 'Sign out of Google Drive', exact: true }))
    check(await page.locator('[data-journey-confirm-cancel]').evaluate(node => node === document.activeElement), 'Drive sign-out defaults to Cancel')
    await tvEnter('[data-focus="journey-confirm-action"]')
    await privacy.getByRole('button', { name: 'Connect collection', exact: true }).waitFor()
    check(!(await driveStatus()).signedIn, 'Privacy sign-out completes through the shared account owner')
    check(fs.existsSync(path.join(cloudDir, 'lyrics.json')), 'sign-out preserves the verified offline cache')
    await capture('privacy-signed-out')
    await app.close()
    app = null
    await drive.close()
    await openWindow()
    await page.waitForSelector('.box-tv[data-route="catalog"]')
    const row = page.locator('.box-song-row', { hasText: 'Cloud Fixture' })
    await row.waitFor()
    check(!(await driveStatus()).signedIn, 'restarted Box stays signed out without a reachable Drive provider')
    check(await row.getAttribute('data-project-dir') === cloudDir, 'offline catalog resolves the downloaded Drive song')
    await tvEnter(page.locator('.box-navigation button').filter({ hasText: 'Queue' }))
    const queued = page.locator('.queue-row', { hasText: 'Cloud Fixture' })
    await queued.waitFor()
    await tvEnter(queued)
    await page.waitForFunction(() => document.querySelector('[data-surface="switch-dialog"]') ||
      document.querySelector('.box-tv[data-route="details"]'))
    if (await page.locator('[data-surface="switch-dialog"]').count()) {
      check(await page.locator('[data-keep-current]').evaluate(node => node === document.activeElement), 'offline queue selection awaits a safe confirmation')
      await tvEnter('[data-switch-confirm]')
    } else {
      await tvEnter(page.locator('[data-surface="details"]').getByRole('button', { name: 'Sing', exact: true }))
    }
    await page.waitForSelector('.box-player[data-playing="false"]')
    check(await page.locator('.box-player').getAttribute('data-active-song') === cloudDir, 'persisted Drive queue opens its offline stems-only cache')
    check((await page.locator('.player-lyrics').textContent()).includes('Linux fixture line 1'), 'offline player restores synchronized lyrics')
    await capture('offline-player')
    await tvEnter('[data-control="play"]')
    await page.waitForSelector('.box-player[data-playing="true"]')
    const offlineBefore = await page.evaluate(() => window.singz.desktopPlaybackStatus())
    await page.waitForTimeout(300)
    const offlineAfter = await page.evaluate(() => window.singz.desktopPlaybackStatus())
    check(offlineBefore?.state === 'running' && offlineBefore.transportState === 'playing' &&
      offlineAfter?.state === 'running' && offlineAfter.transportState === 'playing' &&
      offlineAfter.generation === offlineBefore.generation &&
      BigInt(offlineAfter.audibleProjectFrame) > BigInt(offlineBefore.audibleProjectFrame), 'offline stems-only native playback advances in the same generation')
    await tvEnter('[data-control="play"]')
    await page.waitForSelector('.box-player[data-playing="false"]')
    await app.close()
    app = null
    await openWindow()
    await page.waitForSelector('.box-tv[data-route="catalog"]')
    await tvEnter('[data-focus="settings"]')
    await tvEnter('[data-focus="journey-storage"]')
    const cacheRow = page.locator('[data-journey-page="storage"] .journey-item', { hasText: 'Cloud Fixture' })
    await tvEnter(cacheRow.getByRole('button'))
    check(await page.locator('[data-journey-confirm-cancel]').evaluate(node => node === document.activeElement), 'cache removal defaults to Keep')
    await tvBack()
    check(fs.existsSync(cloudDir), 'Keep preserves cached stems and lyrics')
    await tvEnter(cacheRow.getByRole('button'))
    await tvEnter('[data-focus="journey-confirm-action"]')
    await cacheRow.waitFor({ state: 'hidden' })
    check(!fs.existsSync(cloudDir), 'confirmed cache removal deletes only the downloaded project')
    check(fs.existsSync(path.join(localProject.dir, 'project.json')), 'cache removal preserves normal local projects')
    check(fs.existsSync(path.join(cloudProject.dir, 'project.json')), 'cache removal preserves the remote source')
    await capture('storage-after-removal')
    const remaining = unwrap(await boxCall('getState'), 'queue after cache removal')
    check(remaining.queue.length === 1 && JSON.stringify(remaining.queue[0]) === JSON.stringify(cloudQueueRef), 'cache eviction preserves the exact original Drive queue identity for later repair')
  })
}

;(async () => {
  const localProject = await watchdog.run('create 120-second local prepared project', 240, () =>
    stemProject(path.join(library, 'Local Fixture'), 'Local Fixture', 120))
  const cloudProject = await watchdog.run('create separate cloud-only source project', 90, () =>
    stemProject(path.join(scratch, 'cloud-source', 'Cloud Fixture'), 'Cloud Fixture', 120))
  check(path.dirname(localProject.dir) === library, 'local fixture is inside the isolated library')
  check(!cloudProject.dir.startsWith(`${library}${path.sep}`), 'cloud source cannot masquerade as a local duplicate')
  check(!fs.existsSync(path.join(library, 'Cloud Fixture')), 'cloud fixture begins outside the local library')
  drive = await watchdog.run('start fake Drive provider', 30, () => driveServer(cloudProject, scratch, root))
  await watchdog.run('launch built Box', 90, openWindow)
  await page.waitForSelector('.box-tv[data-route="home"] [data-journey-page="setup"]')

  let platform
  await watchdog.run('verify fresh state and unsupported platform', 45, async () => {
    const state = unwrap(await boxCall('getState'), 'box.getState')
    check(state.version === 1, 'Box state has contract version 1')
    check(state.preferences.setupComplete === false, 'fresh profile has not completed setup')
    check(state.preferences.safeAreaPercent === 0, 'fresh profile starts without a display inset')
    check(Array.isArray(state.queue) && state.queue.length === 0, 'fresh profile has an empty persisted queue')
    platform = unwrap(await boxCall('platformSnapshot'), 'box.platformSnapshot')
    check(platform.available === false, 'desktop run has no appliance platform adapter')
    check(platform.capabilities.wifi === false && platform.capabilities.updates === false, 'unsupported platform does not claim Wi-Fi or updates')
    check(platform.network.state === 'unavailable', 'unsupported platform reports network unavailable')
    check(platform.update.state === 'unavailable', 'unsupported platform reports updates unavailable')
    check(typeof platform.reason === 'string' && platform.reason.length > 0, 'unsupported platform explains its limitation')
  })

  await watchdog.run('traverse every setup stage with TV controls', 150, async () => {
    await tvEnter('[data-setup-stage="boot"] [data-journey-primary]')
    await page.waitForSelector('[data-setup-stage="welcome"]')
    await tvEnter('[data-setup-stage="welcome"] [data-journey-primary]')
    await page.waitForSelector('[data-setup-stage="remote"]')
    for (const key of ['up', 'down', 'left', 'right', 'ok']) {
      await tvEnter(`[data-remote-check="${key}"]`)
      check(await page.locator(`[data-remote-check="${key}"]`).getAttribute('aria-pressed') === 'true', `setup records remote ${key}`)
    }
    await tvEnter(page.getByRole('button', { name: '3%', exact: true }))
    await waitForBoxState(state => state.preferences.safeAreaPercent === 3, '3% safe area')
    let state = unwrap(await boxCall('getState'), 'box.getState after 3% safe area')
    check(state.preferences.safeAreaPercent === 3, 'setup applies the 3% safe area through the real API')
    await tvEnter(page.locator('[data-setup-stage="remote"] .journey-actions button').nth(3))
    await waitForBoxState(state => state.preferences.safeAreaPercent === 0, 'restored safe area')
    state = unwrap(await boxCall('getState'), 'box.getState after restoring safe area')
    check(state.preferences.safeAreaPercent === 0, 'setup restores the 0% safe area')
    await capture('setup-remote')
    await tvEnter('[data-setup-stage="remote"] [data-journey-primary]')
    await page.waitForSelector('[data-setup-stage="network"]')
    await tvEnter('[data-setup-stage="network"] [data-journey-primary]')
    await page.waitForSelector('[data-journey-page="network"]')
    check(await page.locator('[data-journey-page="network"] .journey-actions button').first().isDisabled(), 'setup network UI disables unsupported Wi-Fi')
    await tvBack()
    await page.waitForSelector('[data-setup-stage="network"]')
    await tvEnter(page.locator('[data-setup-stage="network"] .journey-actions button').nth(1))
    await page.waitForSelector('[data-setup-stage="audio"]')
    await tvEnter(page.locator('[data-setup-stage="audio"] .journey-actions button').nth(1))
    await page.waitForSelector('[data-setup-stage="account"]')
    await tvEnter(page.locator('[data-setup-stage="account"] .journey-actions button').nth(1))
    await page.waitForSelector('[data-setup-stage="done"]')
    await tvEnter('[data-setup-stage="done"] [data-journey-primary]')
    await page.waitForSelector('.box-tv[data-route="catalog"]')
    state = unwrap(await boxCall('getState'), 'box.getState after setup')
    check(state.preferences.setupComplete === true, 'Finish explicitly persists setup completion')
  })

  await watchdog.run('inspect unavailable network and system settings', 90, async () => {
    await tvEnter('[data-focus="settings"]')
    await page.waitForSelector('[data-journey-page="home"]')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-focus') === 'journey-audio')
    await capture('settings-home')
    for (const focus of ['network', 'collection', 'phones', 'storage', 'diagnostics', 'system', 'privacy', 'setup']) {
      await page.keyboard.press('ArrowDown')
      check(await page.evaluate(() => document.activeElement?.getAttribute('data-focus')) === `journey-${focus}`, `DPAD reaches ${focus} without pointer focus`)
    }
    for (let step = 0; step < 7; step++) await page.keyboard.press('ArrowUp')
    check(await page.evaluate(() => document.activeElement?.getAttribute('data-focus')) === 'journey-network', 'DPAD returns to Network through the scrolled settings list')
    await page.keyboard.press('Enter')
    const network = page.locator('[data-journey-page="network"]')
    await network.waitFor()
    check(await network.locator('.journey-actions button').first().isDisabled(), 'Network settings disable unsupported Wi-Fi in real UI')
    await capture('network-unavailable')
    await tvBack()
    await page.waitForSelector('[data-journey-page="home"]')
    await tvEnter('[data-focus="journey-system"]')
    const system = page.locator('[data-journey-page="system"]')
    await system.waitFor()
    const copy = await system.textContent()
    check(copy.includes(platform.update.currentVersion), 'System settings show the real current version')
    check(/unavailable/i.test(copy), 'System settings truthfully show updates unavailable')
    await capture('system-unavailable')
    await tvBack()
    await page.waitForSelector('[data-journey-page="home"]')
    await tvEnter('[data-focus="journey-diagnostics"]')
    await page.waitForSelector('[data-journey-page="diagnostics"]')
    await capture('diagnostics')
    await tvBack()
    await page.waitForSelector('[data-journey-page="home"]')
    await tvEnter('[data-focus="journey-audio"]')
    await page.locator('[data-settings-back]').waitFor()
    await capture('audio-settings')
    await tvBack()
    await page.waitForSelector('[data-journey-page="home"]')
    await tvBack()
    await page.waitForSelector('.box-tv[data-route="catalog"]')
  })

  await watchdog.run('cancel retry and approve real Drive device authorization', 90, async () => {
    await tvEnter('[data-focus="catalog-account"]')
    await page.waitForSelector('.box-tv[data-route="account"] [data-surface="account"]')
    check((await driveStatus()).signedIn === false, 'real Drive API begins signed out')
    await tvEnter('[data-account-primary]')
    await page.waitForSelector('.account-challenge img')
    check((await page.locator('.account-challenge img').getAttribute('src')).startsWith('data:image/'), 'account renders an actual device QR image')
    check((await page.locator('.account-code').textContent()).trim().length > 0, 'account renders the public device code')
    check(drive.state.deviceRequests === 1, 'sign-in starts one real fake-provider device request')
    await tvEnter('[data-account-primary]')
    await page.waitForSelector('.account-challenge', { state: 'hidden' })
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor()
    check((await driveStatus()).signedIn === false, 'cancel leaves Drive signed out')
    await tvEnter('[data-account-primary]')
    await page.waitForSelector('.account-challenge img')
    check(drive.state.deviceRequests === 2, 'retry starts a fresh device request')
    drive.approve()
    await page.waitForSelector('.account-connected', { timeout: 30000 })
    check((await driveStatus()).signedIn === true, 'real Drive API confirms provider approval')
    await capture('account-approved')
    await tvBack()
    await page.waitForSelector('.box-tv[data-route="catalog"]')
  })

  await cloudJourney(localProject, cloudProject)
  check(drive.state.writes.length === 0, 'entire customer journey performs no cloud writes')
  console.log('ALL BOX CJM APP CHECKS PASSED')
})().catch(async error => {
  console.error('BOX CJM DRIVER ERROR', error)
  if (page && !page.isClosed()) {
    console.error('BOX CJM FAILURE STATE', {
      signedIn: (await driveStatus().catch(() => null))?.signedIn,
      route: await page.locator('.box-tv').getAttribute('data-route').catch(() => null),
      privacyVisible: await page.locator('[data-journey-page="privacy"]').isVisible().catch(() => false),
      buttons: await page.locator('[data-journey-page="privacy"] button').allTextContents().catch(() => [])
    })
    await capture('failure').catch(() => undefined)
  }
  process.exitCode = 1
}).finally(async () => {
  await closeAll()
  watchdog.disarm()
  fs.rmSync(scratch, { recursive: true, force: true })
})
