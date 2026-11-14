'use strict'
const watchdog = require('../shared/watchdog.cjs').arm('box-package-launch-smoke', {
  totalMinutes: 8,
  idleMinutes: 3,
  onTimeout: async () => { if (app) await app.close().catch(() => undefined) }
})
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { _electron } = require('playwright-core')

const root = path.resolve(__dirname, '../..')
const desktopExecutable = path.resolve(process.env.SINGZ_E2E_PACKAGED || '/opt/SingZ/singz')
const boxExecutable = path.resolve(process.env.E2E_PACKAGED || '/opt/singz-box/singz-box')
const evidence = path.resolve(process.env.SINGZ_E2E_RESULTS || path.join(root, 'build/native/linux-package-e2e/box'))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'singz-box-package-launch-'))
const configHome = path.join(scratch, 'config')
const library = path.join(scratch, 'library')
const home = path.join(scratch, 'home')
const dataHome = path.join(scratch, 'data')
const cacheHome = path.join(scratch, 'cache')
for (const dir of [configHome, library, home, dataHome, cacheHome]) {
  fs.mkdirSync(dir, { recursive: true })
  fs.chmodSync(dir, 0o700)
}
fs.mkdirSync(evidence, { recursive: true })
let app = null

const inheritedOverrides = [
  'SINGZ_SURFACE', 'SINGZ_USERDATA_DIR', 'SINGZ_BOX_AUDIO_SOCKET', 'SINGZ_BOX_AUDIO_DATA_DIR',
  'SINGZ_BOX_PLATFORM_SOCKET', 'SINGZ_MODELS_DIR', 'SINGZ_PACK_DIR', 'SINGZ_PROJECTS_ROOT',
  'SINGZ_CAPTURE_ADDON', 'SINGZ_GDRIVE_CONFIG', 'SINGZ_E2E_HOOKS', 'SINGZ_E2E_OZONE',
  'SINGZ_E2E_X11_SMOKE', 'SINGZ_BOX_AUDIO_HOST_EXECUTABLE', 'ELECTRON_RUN_AS_NODE',
  'E2E_PACKAGED', 'SINGZ_E2E_PACKAGED', 'SINGZ_E2E_HIDDEN'
]

function launchEnvironment() {
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    SINGZ_MUTE: '1',
    SINGZ_NO_SYNC: '1',
    SINGZ_NO_SYSTEM_ENGINES: '1'
  }
  for (const key of inheritedOverrides) delete env[key]
  delete env.SINGZ_LANG
  return env
}

async function close() {
  if (!app) return
  await app.close()
  app = null
}

async function launch(executable) {
  assert.ok(fs.existsSync(executable), executable)
  app = await _electron.launch({
    executablePath: executable,
    args: [],
    env: launchEnvironment(),
    timeout: 60000
  })
  return app.firstWindow()
}

async function identity(expected) {
  const value = await app.evaluate(({ app }, keys) => {
    const fs = process.getBuiltinModule('fs')
    const path = process.getBuiltinModule('path')
    const metadata = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'))
    return {
      appPath: app.getAppPath(),
      appData: app.getPath('appData'),
      home: app.getPath('home'),
      userData: app.getPath('userData'),
      resourcesPath: process.resourcesPath,
      name: app.getName(),
      packaged: app.isPackaged,
      argv: process.argv,
      metadata,
      remainingOverrides: keys.filter(key => key !== 'SINGZ_SURFACE' && process.env[key] !== undefined)
    }
  }, inheritedOverrides)
  const runtimeName = value.metadata.productName || value.metadata.name
  assert.equal(value.packaged, true)
  assert.equal(value.metadata.name, expected.packageName)
  assert.equal(value.metadata.singzProduct, expected.product)
  if (expected.name) assert.equal(value.metadata.productName, expected.name)
  assert.equal(value.name, runtimeName)
  assert.equal(value.appData, configHome)
  assert.equal(value.home, home)
  const profileName = expected.product === 'box' ? 'SingZ Box' : 'SingZ'
  assert.equal(value.userData, path.join(configHome, profileName))
  assert.equal(value.resourcesPath, path.join(path.dirname(expected.executable), 'resources'))
  assert.ok(value.appPath.startsWith(value.resourcesPath), value.appPath)
  assert.ok(!value.argv.includes('--box') && !value.argv.includes('--box-audio-host'), value.argv.join(' '))
  assert.deepEqual(value.remainingOverrides, [])
  return value
}

async function waitForCatalog(page) {
  await page.waitForSelector('[data-app="singz-box"]', { timeout: 60000 })
  await page.waitForSelector('[data-surface="catalog"]', { timeout: 60000 })
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
}

async function run() {
  try {
  let desktopUserData
  await watchdog.run('installed Desktop uses its normal package identity', 90, async () => {
    const page = await launch(desktopExecutable)
    const desktop = await identity({
      executable: desktopExecutable,
      packageName: 'singz',
      product: undefined
    })
    desktopUserData = desktop.userData
    await page.waitForSelector('.titlebar', { timeout: 60000 })
    await close()
  })

  let boxUserData
  await watchdog.run('installed Box uses its normal package identity and default profile', 90, async () => {
    const page = await launch(boxExecutable)
    const value = await identity({
      executable: boxExecutable,
      name: 'SingZ Box',
      packageName: 'singz-box',
      product: 'box'
    })
    boxUserData = value.userData
    await page.waitForSelector('[data-app="singz-box"]', { timeout: 60000 })
    await close()
  })

  assert.notEqual(boxUserData, desktopUserData)
  fs.mkdirSync(boxUserData, { recursive: true })
  fs.writeFileSync(path.join(boxUserData, 'settings.json'), JSON.stringify({
    projectsRoot: library,
    language: 'en'
  }, null, 2), { mode: 0o600 })
  fs.writeFileSync(path.join(boxUserData, 'box-state.json'), JSON.stringify({
    version: 1,
    preferences: { setupComplete: true, safeAreaPercent: 0, language: 'en' },
    queue: []
  }, null, 2), { mode: 0o600 })
  assert.equal(fs.existsSync(path.join(desktopUserData, 'box-state.json')), false,
    'Box preferences must not appear in the Desktop profile')

  await watchdog.run('Box Settings supports real keyboard remote navigation and Back', 90, async () => {
    const page = await launch(boxExecutable)
    await waitForCatalog(page)
    const settings = page.getByRole('button', { name: 'Settings', exact: true })
    await settings.focus()
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-journey-page="home"]')

    const audio = page.locator('[data-focus="journey-audio"]')
    await audio.focus()
    await page.keyboard.press('ArrowDown')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-focus') === 'journey-network')
    const focus = await page.evaluate(() => document.activeElement?.getAttribute('data-focus'))
    assert.equal(focus, 'journey-network', 'remote ArrowDown must move focus off Audio to Network')
    const window = await app.browserWindow(page)
    assert.equal(await window.evaluate(browserWindow => browserWindow.isVisible()), true,
      'the current Box BrowserWindow must be visible before its screenshot')
    await page.screenshot({ path: path.join(evidence, 'box-settings-remote-focus.png') })

    await audio.focus()
    await page.keyboard.press('Enter')
    const back = page.locator('[data-settings-back]')
    await back.waitFor()
    await page.waitForFunction(() => {
      const button = document.querySelector('[data-settings-back]')
      return button && !button.disabled
    })
    await back.focus()
    await page.keyboard.press('Enter')
    await back.waitFor({ state: 'hidden' })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-surface="catalog"]')
    await close()
  })

  await watchdog.run('Box-only setup preference survives a normal reopen', 60, async () => {
    const saved = JSON.parse(fs.readFileSync(path.join(boxUserData, 'box-state.json'), 'utf8'))
    assert.equal(saved.preferences.setupComplete, true)
    assert.equal(fs.existsSync(path.join(desktopUserData, 'box-state.json')), false)
    const page = await launch(boxExecutable)
    await waitForCatalog(page)
    await close()
  })

  console.log('PASS installed Desktop/Box metadata, default profile separation, normal Box launch, remote focus, Back and preference persistence')
  } catch (error) {
    console.error('BOX PACKAGE LAUNCH SMOKE ERROR', error)
    process.exitCode = 1
  } finally {
    await close().catch(() => undefined)
    watchdog.disarm()
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

run()
