#!/usr/bin/env node

const { createWriteStream, existsSync, mkdirSync, readdirSync, copyFileSync } = require('node:fs')
const { get } = require('node:https')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const root = resolve(__dirname, '..')
const electronVersion = require(join(root, 'node_modules/electron/package.json')).version
const requested = process.argv[2]?.split('-')
const platform = requested?.slice(0, -1).join('-') || process.platform
const arch = requested?.at(-1) || process.arch
if (!['darwin', 'win32'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
  throw new Error(`The desktop capture addon is not supported on ${platform}-${arch}`)
}
if (platform === 'win32' && arch !== 'x64') {
  throw new Error('The shipping Windows capture addon is currently x64 only')
}

const headersRoot = join(root, '.engines-src', 'electron-headers', electronVersion)
const archive = join(headersRoot, `node-v${electronVersion}-headers.tar.gz`)
// Electron's header tarball extracts to node_headers/ (unlike upstream
// Node's node-v<version>/ directory), while the archive file keeps the Node
// naming convention.
const includeDir = join(headersRoot, 'node_headers', 'include', 'node')
const nodeLibrary = join(headersRoot, 'win-x64', 'node.lib')

function download(url, destination) {
  return new Promise((resolveDownload, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        download(response.headers.location, destination).then(resolveDownload, reject)
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Download failed (${response.statusCode}): ${url}`))
        return
      }
      const output = createWriteStream(destination)
      response.pipe(output)
      output.on('finish', () => output.close(resolveDownload))
      output.on('error', reject)
    })
    request.on('error', reject)
  })
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}

function findAddon(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findAddon(path)
      if (found) return found
    } else if (entry.name === 'singz-capture.node') {
      return path
    }
  }
  return null
}

async function main() {
  mkdirSync(headersRoot, { recursive: true })
  if (!existsSync(join(includeDir, 'node_api.h'))) {
    if (!existsSync(archive)) {
      await download(
        `https://electronjs.org/headers/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`,
        archive
      )
    }
    run('tar', ['-xzf', archive, '-C', headersRoot])
  }
  if (platform === 'win32' && !existsSync(nodeLibrary)) {
    mkdirSync(join(headersRoot, 'win-x64'), { recursive: true })
    await download(`https://electronjs.org/headers/v${electronVersion}/win-x64/node.lib`, nodeLibrary)
  }

  const buildDir = join(root, 'build', `capture-${platform}-${arch}`)
  const configure = [
    '-S', root,
    '-B', buildDir,
    '-DSINGZ_BUILD_HOST_TOOLS=OFF',
    '-DSINGZ_CORE_TESTS=OFF',
    '-DSINGZ_BUILD_ELECTRON_CAPTURE=ON',
    `-DSINGZ_NODE_INCLUDE_DIR=${includeDir}`
  ]
  if (platform === 'darwin') {
    configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`)
  }
  if (platform === 'win32') configure.push(`-DSINGZ_NODE_LIBRARY=${nodeLibrary}`)
  run('cmake', configure)
  run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'singz_capture'])

  const built = findAddon(buildDir)
  if (!built) throw new Error(`singz-capture.node was not produced under ${buildDir}`)
  const vendorDir = join(root, 'vendor', `${platform}-${arch}`)
  mkdirSync(vendorDir, { recursive: true })
  const destination = join(vendorDir, 'singz-capture.node')
  copyFileSync(built, destination)
  console.log(`Capture addon: ${destination}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
