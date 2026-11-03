#!/usr/bin/env node
const { join, resolve } = require('node:path')
const { existsSync, mkdirSync, copyFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { assertNativeBuildLockHeld } = require('./native-build-lock.cjs')
const { downloadHeaderFile, extractHeaders } = require('./build-capture-addon.cjs')
const root = resolve(__dirname, '..')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(command + ' failed')
}
async function main() {
  const version = require('electron/package.json').version
  const target =
    process.argv[2] || process.platform + '-' + (process.env.SINGZ_TARGET_ARCH || process.arch)
  if (![process.platform + '-arm64', process.platform + '-x64'].includes(target))
    throw new Error('Unsupported host/target: ' + target)
  const prefix = join(root, 'vendor', 'torrent', target)
  if (!existsSync(join(prefix, 'manifest.json')))
    throw new Error('Build the torrent SDK first: python3 scripts/vendor-torrent.py ' + target)
  const headersRoot = join(root, '.engines-src', 'electron-headers', version),
    include = join(headersRoot, 'node_headers', 'include', 'node')
  mkdirSync(headersRoot, { recursive: true })
  if (!existsSync(join(include, 'node_api.h'))) {
    const archive = join(headersRoot, 'node-v' + version + '-headers.tar.gz')
    await downloadHeaderFile(
      'https://electronjs.org/headers/v' + version + '/node-v' + version + '-headers.tar.gz',
      archive
    )
    extractHeaders(archive, headersRoot)
  }
  let nodeLibrary = ''
  if (process.platform === 'win32') {
    nodeLibrary = join(headersRoot, 'win-x64', 'node.lib')
    mkdirSync(join(headersRoot, 'win-x64'), { recursive: true })
    if (!existsSync(nodeLibrary))
      await downloadHeaderFile(
        'https://electronjs.org/headers/v' + version + '/win-x64/node.lib',
        nodeLibrary
      )
  }
  const build = join(root, '.engines-src', 'torrent', 'addon', target)
  run('cmake', [
    '-S',
    join(root, 'native', 'torrent'),
    '-B',
    build,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_PREFIX_PATH=' + prefix,
    '-DOPENSSL_ROOT_DIR=' + prefix,
    '-DOPENSSL_USE_STATIC_LIBS=ON',
    '-DSINGZ_TORRENT_NODE_INCLUDE=' + include,
    '-DSINGZ_TORRENT_NODE_LIBRARY=' + nodeLibrary,
    ...(process.platform === 'darwin'
      ? [
          '-DCMAKE_OSX_ARCHITECTURES=' + (target.endsWith('arm64') ? 'arm64' : 'x86_64'),
          '-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0'
        ]
      : [])
  ])
  run('cmake', ['--build', build, '--config', 'Release', '--parallel', '4'])
  const out = join(prefix, 'singz-torrent.node')
  copyFileSync(
    join(build, process.platform === 'win32' ? 'Release/' : '', 'singz-torrent.node'),
    out
  )
  console.log('Torrent addon: ' + out)
}
if (!process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
  const locked = spawnSync(process.execPath, [
    join(root, 'scripts', 'with-native-build-lock.mjs'),
    '--owner', `torrent-addon:${process.argv[2] || process.platform + '-' + (process.env.SINGZ_TARGET_ARCH || process.arch)}`,
    '--', process.execPath, __filename, ...process.argv.slice(2)
  ], { cwd: process.cwd(), stdio: 'inherit' })
  if (locked.error) throw locked.error
  process.exitCode = locked.status ?? 1
} else {
  assertNativeBuildLockHeld(root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD)
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
