#!/usr/bin/env node

const {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  statSync
} = require('node:fs')
const { createHash } = require('node:crypto')
const { get } = require('node:https')
const { join, relative, resolve } = require('node:path')
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

// Streams to `<destination>.part` and renames only on a complete body, so an
// interrupted download (wifi drop, Ctrl-C, CI cancel) can never leave a
// truncated file that the existence guards then trust forever.
function download(url, destination, redirects = 0) {
  return new Promise((resolveDownload, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects: ${url}`))
      return
    }
    const partial = `${destination}.part`
    const dropPartial = () => rmSync(partial, { force: true })
    const request = get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        download(response.headers.location, destination, redirects + 1).then(
          resolveDownload,
          reject
        )
        return
      }
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Download failed (${response.statusCode}): ${url}`))
        return
      }
      const output = createWriteStream(partial)
      response.pipe(output)
      response.on('error', (error) => {
        output.destroy()
        dropPartial()
        reject(error)
      })
      response.on('aborted', () => {
        output.destroy()
        dropPartial()
        reject(new Error(`Download interrupted: ${url}`))
      })
      output.on('finish', () =>
        output.close(() => {
          try {
            renameSync(partial, destination)
            resolveDownload()
          } catch (error) {
            dropPartial()
            reject(error)
          }
        })
      )
      output.on('error', (error) => {
        dropPartial()
        reject(error)
      })
    })
    request.on('error', reject)
  })
}

// One fingerprint, three duties: the skip-guard's stamp (vendor-script
// convention — but keyed on the inputs, not bare existence, so an Electron
// bump or source edit still rebuilds), the addon's compiled-in identity, and
// the loader's staleness evidence. Covers every build input of the addon.
function sourceFingerprint() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  for (const dir of ['native/electron', 'zcore', 'zdsp', 'third_party/native', 'cmake']) {
    walk(join(root, dir))
  }
  files.push(join(root, 'CMakeLists.txt'), __filename)
  files.sort()
  const hash = createHash('sha1')
  hash.update(`electron ${electronVersion}\n`)
  for (const file of files) {
    hash.update(`${relative(root, file)} ${statSync(file).size} `)
    hash.update(createHash('sha1').update(readFileSync(file)).digest('hex'))
    hash.update('\n')
  }
  return hash.digest('hex')
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
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
  const fingerprint = sourceFingerprint()
  const vendorDir = join(root, 'vendor', `${platform}-${arch}`)
  const destination = join(vendorDir, 'singz-capture.node')
  const stamp = `${destination}.source-hash`
  if (
    existsSync(destination) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8').trim() === fingerprint
  ) {
    console.log(`cached: vendor/${platform}-${arch}/singz-capture.node`)
    return
  }

  mkdirSync(headersRoot, { recursive: true })
  if (!existsSync(join(includeDir, 'node_api.h'))) {
    if (!existsSync(archive)) {
      await download(
        `https://electronjs.org/headers/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`,
        archive
      )
    }
    // Extract from inside headersRoot with a bare filename: an absolute
    // Windows path ("D:\...") makes Git Bash's GNU tar parse the drive
    // letter as a remote host ("Cannot connect to D:"), while bsdtar has no
    // --force-local. A colon-free relative invocation works under both.
    run('tar', ['-xzf', `node-v${electronVersion}-headers.tar.gz`], headersRoot)
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
    `-DSINGZ_NODE_INCLUDE_DIR=${includeDir}`,
    `-DSINGZ_CAPTURE_ELECTRON=${electronVersion}`,
    `-DSINGZ_CAPTURE_SOURCE_STAMP=${fingerprint}`
  ]
  if (platform === 'darwin') {
    configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`)
  }
  if (platform === 'win32') configure.push(`-DSINGZ_NODE_LIBRARY=${nodeLibrary}`)
  run('cmake', configure)
  run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'singz_capture'])

  const built = findAddon(buildDir)
  if (!built) throw new Error(`singz-capture.node was not produced under ${buildDir}`)
  mkdirSync(vendorDir, { recursive: true })
  // Copy via a temp name + rename so a parallel worktree's load can never see
  // a half-written addon in the shared vendor slot.
  const staging = `${destination}.part`
  copyFileSync(built, staging)
  renameSync(staging, destination)
  writeFileSync(stamp, `${fingerprint}\n`)
  console.log(`Capture addon: ${destination}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
