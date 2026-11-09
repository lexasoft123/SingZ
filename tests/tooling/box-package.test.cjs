'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { DebugLogger } = require('builder-util')

const repository = resolve(__dirname, '../..')
const { AppInfo } = require(join(repository, 'node_modules/app-builder-lib/out/appInfo.js'))
const { LinuxTargetHelper } = require(join(repository, 'node_modules/app-builder-lib/out/targets/LinuxTargetHelper.js'))
const {
  getConfig,
  validateConfiguration
} = require(join(repository, 'node_modules/app-builder-lib/out/util/config/config.js'))

async function loadConfig(filename) {
  const config = await getConfig(repository, filename, null)
  await validateConfiguration(config, new DebugLogger(false))
  return config
}

function assertBoxIdentity(config) {
  assert.equal(config.appId, 'com.lexasoft.singz.box')
  assert.equal(config.productName, 'singz-box')
  assert.equal(config.extraMetadata.productName, 'SingZ Box')
  assert.equal(config.linux.desktop.entry.Name, 'SingZ Box')
  assert.equal(config.extraMetadata.name, 'singz-box')
  assert.equal(config.extraMetadata.singzProduct, 'box')
  assert.equal(config.extraMetadata.desktopName, 'singz-box.desktop')
  assert.equal(config.linux.executableName, 'singz-box')
  assert.equal(config.deb.packageName, 'singz-box')
  assert.equal(config.publish, null)
}

test('Box config validates and preserves the trusted Desktop packaging inputs', async () => {
  const [box, desktop] = await Promise.all([
    loadConfig('electron-builder.box.yml'),
    loadConfig('electron-builder.yml')
  ])

  assertBoxIdentity(box)
  assert.equal(box.extends, 'electron-builder.yml')
  assert.equal(box.directories.output, 'dist/box')
  assert.equal(box.directories.buildResources, desktop.directories.buildResources)
  assert.equal(box.artifactName, 'SingZ-Box-${version}-linux-${arch}.${ext}')
  assert.equal(box.extraMetadata.homepage, desktop.extraMetadata.homepage)
  assert.equal(box.afterPack, desktop.afterPack)
  assert.equal(box.npmRebuild, desktop.npmRebuild)
  assert.equal(box.publish, null)
  assert.deepEqual(desktop.publish, {
    provider: 'github',
    owner: 'lexasoft123',
    repo: 'SingZ'
  })
  assert.deepEqual(box.linux.target, desktop.linux.target)
  assert.deepEqual(box.deb.depends, [...desktop.deb.depends, 'python3', 'fonts-noto-cjk'])
  assert.deepEqual(box.mac, desktop.mac)
  assert.deepEqual(box.win, desktop.win)
  assert.deepEqual(box.linux.extraResources, desktop.linux.extraResources)
  assert.ok(box.extraResources.some(resource =>
    resource.from === 'resources/linux' && resource.to === 'box-audio'
  ))
  const fileRules = config => config.files.flatMap(file =>
    (file.filter || []).map(filter => ({ from: file.from, to: file.to, filter }))
  )
  const boxRules = fileRules(box)
  for (const rule of fileRules(desktop)) {
    assert.ok(boxRules.some(candidate => isDeepStrictEqual(candidate, rule)))
  }
  assert.ok(boxRules.some(rule =>
    rule.from === undefined && rule.to === undefined && rule.filter === '!electron-builder.box.yml'
  ))

  assert.equal(desktop.appId, 'com.lexasoft.singz')
  assert.equal(desktop.productName, 'SingZ')
  assert.equal(desktop.directories.output, 'dist')
  assert.equal(desktop.linux.executableName, 'singz')
  assert.equal(desktop.deb.packageName, undefined)
  assert.equal(desktop.artifactName, '${productName}-${version}-${os}-${arch}.${ext}')
})

test('effective Box metadata produces the distinct Debian launcher without a profile flag', async () => {
  const config = await loadConfig('electron-builder.box.yml')
  const developmentMetadata = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  const metadata = { ...developmentMetadata, ...config.extraMetadata }
  const appInfo = new AppInfo({
    config,
    metadata,
    devMetadata: developmentMetadata,
    framework: { defaultAppIdPrefix: 'com.electron.' }
  }, null, config.linux)

  assert.equal(appInfo.id, 'com.lexasoft.singz.box')
  assert.equal(appInfo.name, 'singz-box')
  assert.equal(appInfo.productName, 'singz-box')
  assert.equal(metadata.productName, 'SingZ Box')
  assert.equal(appInfo.productFilename, 'singz-box')
  assert.equal(appInfo.linuxPackageName, 'singz-box')
  assert.equal(`/opt/${appInfo.sanitizedProductName}`, '/opt/singz-box')
  assert.equal(metadata.main, './out/main/index.js')
  assert.equal(config.linux.executableArgs, undefined)

  const packager = {
    appInfo,
    config,
    executableName: config.linux.executableName,
    fileAssociations: [],
    info: { metadata },
    platformSpecificBuildOptions: config.linux
  }
  const helper = new LinuxTargetHelper(packager)
  assert.equal(helper.getDesktopFileName(), 'singz-box')
  const entry = await helper.computeDesktopEntry(config.linux)
  assert.match(entry, /^Name=SingZ Box$/m)
  assert.match(entry, /^Exec=\/opt\/singz-box\/singz-box %U$/m)
  assert.match(entry, /^Icon=singz-box$/m)
  assert.match(entry, /^StartupWMClass=singz-box$/m)
  assert.doesNotMatch(entry, /--box/)
})

test('Box identity assertions reject a deliberately restored Desktop app ID', async () => {
  const config = await loadConfig('electron-builder.box.yml')
  assert.throws(
    () => assertBoxIdentity({ ...config, appId: 'com.lexasoft.singz' }),
    assert.AssertionError
  )
})

test('Box identity assertions reject a deliberately restored Desktop update feed', async () => {
  const [box, desktop] = await Promise.all([
    loadConfig('electron-builder.box.yml'),
    loadConfig('electron-builder.yml')
  ])
  assert.throws(
    () => assertBoxIdentity({ ...box, publish: desktop.publish }),
    assert.AssertionError
  )
})

test('Box installation identity rejects the former spaced installation path', async () => {
  const config = await loadConfig('electron-builder.box.yml')
  assert.throws(
    () => assertBoxIdentity({ ...config, productName: 'SingZ Box' }),
    assert.AssertionError
  )
})

const { getMainFileMatchers } = require(join(repository, 'node_modules/app-builder-lib/out/fileMatcher.js'))

function appFilter(config) {
  const info = {
    config,
    projectDir: repository,
    buildResourcesDir: config.directories.buildResources,
    isPrepackedAppAsar: false,
    debugLogger: { isEnabled: false }
  }
  const [matcher] = getMainFileMatchers(
    repository, '/app', value => value, config.linux, { info },
    resolve(repository, config.directories.output), false
  )
  const filter = matcher.createFilter()
  return relative => filter(join(repository, relative), { isDirectory: () => false })
}

const desktopOutputs = [
  'dist/SingZ-1.0.0-linux-amd64.deb',
  'dist/latest-linux.yml',
  'dist/SHA256SUMS',
  'dist/linux-unpacked/singz',
  'dist/linux-arm64-unpacked/resources/app.asar'
]

function withoutDistRule(config) {
  return {
    ...config,
    files: config.files.map(file => ({ ...file, filter: (file.filter || []).filter(rule => !rule.startsWith('!dist')) }))
  }
}

test('neither package embeds Desktop build output left in dist/', async () => {
  for (const filename of ['electron-builder.box.yml', 'electron-builder.yml']) {
    const included = appFilter(await loadConfig(filename))
    for (const output of desktopOutputs) assert.equal(included(output), false, `${filename} packages ${output}`)
    assert.equal(included('out/main/index.js'), true, `${filename} drops the app bundle`)
  }
})

test('Box asar filter rejects a deliberately removed dist exclusion', async () => {
  const included = appFilter(withoutDistRule(await loadConfig('electron-builder.box.yml')))
  assert.equal(included('dist/SingZ-1.0.0-linux-amd64.deb'), true)
})

const boxAudioSources = [
  'resources/linux/cec-input.py',
  'resources/linux/singz-box-audio.service',
  'resources/linux/singz-box-with-audio',
  'resources/linux/README.md',
  'resources/linux/singz-box-rtprio.conf'
]

test('Box ships its CEC/audio support files once, outside the asar', async () => {
  const box = await loadConfig('electron-builder.box.yml')
  const included = appFilter(box)
  for (const source of boxAudioSources) assert.equal(included(source), false, `Box asar packages ${source}`)
  assert.ok(box.extraResources.some(resource => resource.from === 'resources/linux' && resource.to === 'box-audio'))
  assert.equal(included('out/main/index.js'), true)
  // Packaged Box reads only resources/box-audio; the asar path is development-only.
  const main = readFileSync(join(repository, 'src/main/index.ts'), 'utf8')
  assert.match(main, /app\.isPackaged \? join\(process\.resourcesPath, 'box-audio\/cec-input\.py'\)/)
})

test('Box asar filter rejects a deliberately removed resources/linux exclusion', async () => {
  const box = await loadConfig('electron-builder.box.yml')
  const included = appFilter({
    ...box,
    files: box.files.map(file => ({ ...file, filter: (file.filter || []).filter(rule => !rule.startsWith('!resources/linux')) }))
  })
  assert.equal(included('resources/linux/cec-input.py'), true)
})

test('Box audio service requests real-time priority only up to an opt-in per-user hard limit', () => {
  const service = readFileSync(join(repository, 'resources/linux/singz-box-audio.service'), 'utf8')
  // zCore ALSA workers request SCHED_FIFO 20; nothing in the Box requests more.
  const alsa = readFileSync(join(repository, 'third_party/zcore/zcore/platform/linux/alsa_worker.h'), 'utf8')
  assert.match(alsa, /SCHED_FIFO priority 20 request failed/)
  assert.match(service, /^LimitRTPRIO=20$/m)
  // The sandbox and unprivileged identity stay intact.
  assert.doesNotMatch(service, /no-sandbox|^User=|^AmbientCapabilities=|^CPUSchedulingPolicy=/m)
  const dropIn = readFileSync(join(repository, 'resources/linux/singz-box-rtprio.conf'), 'utf8')
  assert.match(dropIn, /^\[Service\]$/m)
  assert.match(dropIn, /^LimitRTPRIO=0:20$/m)
  assert.match(dropIn, /user@1000\.service\.d\/singz-box-rtprio\.conf/)
})

test('Box audio service and launcher use the lowercase installation directory', () => {
  const service = readFileSync(join(repository, 'resources/linux/singz-box-audio.service'), 'utf8')
  assert.match(service, /^ExecStart=\/opt\/singz-box\/singz-box --box-audio-host --ozone-platform=headless$/m)
  assert.doesNotMatch(service, /\/opt\/SingZ Box/)
  const launcher = readFileSync(join(repository, 'resources/linux/singz-box-with-audio'), 'utf8')
  assert.match(launcher, /exec "\$launcher_dir\/\.\.\/\.\.\/singz-box" "\$@"/)
})
