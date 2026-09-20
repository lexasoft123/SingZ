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
const { basename, dirname, join, relative, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  assertHostCanBuildTarget,
  assertSourceFingerprintUnchanged,
  captureTarget,
  currentRuntimeArtifact,
  machCanonicalSha256,
  packageRoot,
  replacePathPreserving,
  runtimeArtifact,
  runtimeRoot,
  sha256File,
  uniqueGeneration,
  validateCaptureBinary,
  verifyCaptureArtifact,
  verifyCaptureSnapshot
} = require('./capture-artifact.cjs')
const { assertNativeBuildLockHeld } = require('./native-build-lock.cjs')

const root = resolve(__dirname, '..')
const electronVersion = require(join(root, 'node_modules/electron/package.json')).version
const runningAsScript = require.main === module
const requested = runningAsScript
  ? process.argv.slice(2).find((arg) => !arg.startsWith('--'))?.split('-')
  : null
const platform = requested?.slice(0, -1).join('-') || process.platform
const arch = requested?.at(-1) || process.arch
const printingFingerprint = runningAsScript && process.argv.includes('--print-source-fingerprint')
const target = runningAsScript && !printingFingerprint ? captureTarget(platform, arch) : null
if (target) assertHostCanBuildTarget(target)

const headersRoot = join(root, '.engines-src', 'electron-headers', electronVersion)
const archive = join(headersRoot, `node-v${electronVersion}-headers.tar.gz`)
// Electron's header tarball extracts to node_headers/ (unlike upstream
// Node's node-v<version>/ directory), while the archive file keeps the Node
// naming convention.
const includeDir = join(headersRoot, 'node_headers', 'include', 'node')
const nodeLibrary = join(headersRoot, 'win-x64', 'node.lib')

// https.get has no timeout of any kind: a connection that stalls after
// connecting never errors, and a build sat for over eighty minutes at zero CPU
// holding the native build lock, printing nothing. Both phases are bounded:
// waiting for the server to answer, and then for the next bytes of the body.
const DOWNLOAD_RESPONSE_TIMEOUT_MS = 30_000
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_BACKOFF_MS = 2_000

/** Marks a failure worth another attempt — a stall, a dropped connection, a
 * network error, a 5xx. A 4xx or a redirect loop fails the same way every
 * time, so it is not retried. */
function transient(error) {
  error.transient = true
  return error
}

// Streams to a per-process partial and renames only on a complete body, so an
// interrupted download can never leave a truncated file trusted by existence.
// Every way an attempt can fail — a stall, a short body, a dropped connection,
// a bad status — removes the partial before it rejects.
function downloadOnce(url, destination, options, redirects = 0) {
  const { get: fetchUrl, responseTimeoutMs, idleTimeoutMs } = options
  return new Promise((resolveDownload, reject) => {
    if (redirects > 5) {
      reject(new Error(`Too many redirects: ${url}`))
      return
    }
    const partial = `${destination}.part-${process.pid}`
    const started = Date.now()
    let settled = false
    let timer = null
    let output = null
    let received = 0
    let request = null
    const fail = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.destroy()
      const dropPartial = () => {
        // Windows can hold a just-closed file for a moment
        rmSync(partial, { force: true, maxRetries: 3, retryDelay: 100 })
        reject(error)
      }
      if (output && !output.closed) {
        output.once('close', dropPartial)
        output.destroy()
      } else {
        dropPartial()
      }
    }
    const watch = (ms, what) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const waited = ((Date.now() - started) / 1000).toFixed(1)
        fail(transient(new Error(
          `Download stalled: ${what} from ${url} for ${ms / 1000} s ` +
          `(${waited} s in all, ${received} bytes received)`
        )))
      }, ms)
    }
    request = fetchUrl(url, (response) => {
      if (settled) {
        response.resume()
        return
      }
      const status = response.statusCode
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        settled = true
        clearTimeout(timer)
        const next = new URL(response.headers.location, url).href
        downloadOnce(next, destination, options, redirects + 1).then(resolveDownload, reject)
        return
      }
      if (status !== 200) {
        response.resume()
        const error = new Error(`Download failed (${status}): ${url}`)
        fail(status >= 500 ? transient(error) : error)
        return
      }
      output = createWriteStream(partial)
      watch(idleTimeoutMs, 'no data')
      response.on('data', (chunk) => {
        received += chunk.length
        watch(idleTimeoutMs, 'no data')
      })
      response.on('error', (error) => fail(transient(error)))
      response.on('aborted', () => fail(transient(new Error(`Download interrupted: ${url}`))))
      output.on('error', fail)
      output.on('finish', () =>
        output.close(() => {
          // A body that stops short of its content-length never gets here:
          // node's parser raises 'aborted' and never ends the stream, and the
          // test that drops the connection mid-body holds that.
          if (settled) return
          try {
            replacePathPreserving(partial, destination)
          } catch (error) {
            fail(error)
            return
          }
          settled = true
          clearTimeout(timer)
          resolveDownload()
        })
      )
      response.pipe(output)
    })
    request.on('error', (error) => fail(transient(error)))
    watch(responseTimeoutMs, 'no response')
  })
}

/** Download with both timeouts and a few attempts, backing off between them.
 * The options exist for the unit test (a plain-http getter, short timeouts);
 * the build passes none. */
async function download(url, destination, options = {}) {
  const settings = {
    get,
    responseTimeoutMs: DOWNLOAD_RESPONSE_TIMEOUT_MS,
    idleTimeoutMs: DOWNLOAD_IDLE_TIMEOUT_MS,
    attempts: DOWNLOAD_ATTEMPTS,
    backoffMs: DOWNLOAD_BACKOFF_MS,
    log: console.log,
    ...options
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(url, destination, settings)
      return
    } catch (error) {
      if (!error.transient || attempt >= settings.attempts) {
        // a NEW error, never `error.message +=`: node renders a system
        // error's stack (ECONNREFUSED, ENOTFOUND) as it creates it, and the
        // build prints the stack, so appended text would never be seen
        if (attempt > 1) throw new Error(`${error.message} (gave up after ${attempt} attempts)`, { cause: error })
        throw error
      }
      const delay = settings.backoffMs * 2 ** (attempt - 1)
      settings.log(`${error.message} — trying again in ${delay / 1000} s (attempt ${attempt + 1} of ${settings.attempts})`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay))
    }
  }
}

/** Fetch one of Electron's header files, saying what to do when it cannot be
 * had: the files are the same for every checkout at this Electron version.
 * `options` pass through to download(), for the unit test. */
async function downloadHeaderFile(url, destination, options = {}) {
  try {
    await download(url, destination, options)
  } catch (error) {
    throw new Error(
      `${error.message}\nElectron ${electronVersion}'s headers are fetched once per checkout. A checkout ` +
        `that has already built the addon has them under .engines-src/electron-headers/${electronVersion} — ` +
        'copying that folder into this checkout skips the download.',
      { cause: error }
    )
  }
}

/** Extract the header tarball, and forget it if it will not extract: a
 * damaged archive left in place would fail the same way on every build,
 * because the download is skipped whenever the archive exists. What it had
 * already written goes too — the build skips extraction once node_api.h is
 * there, which is barely halfway through the tarball, so a half-extracted
 * tree would otherwise be compiled against without v8.h. */
function extractHeaders(archivePath, cwd, extract = run) {
  try {
    // Git Bash's tar parses an absolute D:\ path as a remote host. Extract
    // inside the header directory with the colon-free archive basename.
    extract('tar', ['-xzf', basename(archivePath)], cwd)
  } catch (error) {
    rmSync(archivePath, { force: true })
    rmSync(join(cwd, 'node_headers'), { recursive: true, force: true })
    throw new Error(
      `${error.message} extracting ${basename(archivePath)} — removed it and what it had extracted, ` +
        'so the next build downloads it again',
      { cause: error }
    )
  }
}

// One fingerprint drives the immutable runtime path and the addon's compiled
// identity. Keep this byte-for-byte equivalent to captureSourceFingerprint()
// in src/main/capture.ts; a unit test compares both implementations.
function sourceFingerprint() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else files.push(path)
    }
  }
  for (const dir of [
    'native/electron', 'native/playback', 'zcore', 'zdsp', 'third_party/native', 'cmake'
  ]) {
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

/** SINGZ_FFMPEG_CODECS mirrors mobile/scripts/ffmpeg-codec-selection-policy.mjs:
 * `auto` (default, and what CI runs) links a fully proven product pack when one
 * exists and otherwise builds the base WAV/FLAC decoder; `required` fails
 * closed; `off` never links a pack. */
function codecRuntimeMode() {
  const value = process.env.SINGZ_FFMPEG_CODECS || 'auto'
  if (!['auto', 'required', 'off'].includes(value)) {
    throw new Error(`SINGZ_FFMPEG_CODECS must be auto, required or off (got ${JSON.stringify(value)})`)
  }
  return value
}

/** The proven product pack for this target, or null for a base build. A pack
 * with configuration evidence only is never linked outside `required`, which
 * refuses it: the addon's codec claim must match what was actually decoded. */
function loadCodecPack() {
  const mode = codecRuntimeMode()
  if (mode === 'off') {
    console.log('FFmpeg codec runtime: off; building the base WAV/FLAC native decoder')
    return null
  }
  const pack = join(root, 'vendor', 'ffmpeg-codec', target)
  const manifestPath = join(pack, 'manifest.json')
  if (!existsSync(manifestPath)) {
    if (mode === 'required') {
      throw new Error(
        `Full product FFmpeg pack is missing for ${target}; build and prove it before the desktop addon`
      )
    }
    console.log(`FFmpeg codec runtime: no ${target} product pack; building the base WAV/FLAC native decoder`)
    return null
  }
  const manifestBytes = readFileSync(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.fixtureEvidence?.fullMatrix !== true) {
    if (mode === 'required') {
      throw new Error(
        `FFmpeg pack ${target} has configuration evidence but no full fixture decode evidence; run codec_provisioning_tests and publish its receipt`
      )
    }
    console.log(
      `FFmpeg codec runtime: ${target} pack is configuration-only, not linked; building the base WAV/FLAC native decoder`
    )
    return null
  }
  try {
    run(process.execPath, [
      join(root, 'scripts/verify-ffmpeg-codec-pack.mjs'),
      '--pack', pack,
      '--require-full'
    ])
  } catch (error) {
    // A pack whose proof no longer binds this tree is deliberately NOT
    // dropped to the base decoder: the addon would then claim less than the
    // machine was set up to prove and nobody would notice. Say what fixes it.
    throw new Error(
      `FFmpeg pack ${target} no longer binds this tree (${error instanceof Error ? error.message : String(error)}); ` +
      `re-prove it with \`bash scripts/build-ffmpeg-codec-runtime.sh ${target} --prove-existing\`, ` +
      'or build with SINGZ_FFMPEG_CODECS=off'
    )
  }
  const libraries = Object.entries(manifest.runtimeLibraries).map(([component, source]) => {
    const sourcePath = join(pack, source)
    const linkPath = platform === 'win32'
      ? [join(pack, 'lib', `${component}.lib`), join(pack, 'lib', `lib${component}.lib`)]
          .find((candidate) => existsSync(candidate))
      : sourcePath
    if (!linkPath) throw new Error(`FFmpeg ${target} pack has no ${component} import library`)
    const destination = platform === 'win32'
      ? basename(source)
      : join('ffmpeg', basename(source))
    return {
      component,
      source,
      sourcePath,
      linkPath,
      path: destination.replaceAll('\\', '/'),
      bytes: statSync(sourcePath).size,
      sha256: sha256File(sourcePath),
      ...(platform === 'darwin'
        ? { machCanonicalSha256: machCanonicalSha256(sourcePath) }
        : {})
    }
  })
  return {
    pack,
    manifest,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    libraries
  }
}

function validateFfmpegImports(addon, codecPack) {
  const command = platform === 'darwin' ? 'otool' : 'dumpbin.exe'
  const args = platform === 'darwin' ? ['-L', addon] : ['/dependents', addon]
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (!codecPack) {
    // A base build must not have picked up a developer machine's libav*:
    // its capability report would then describe bytes nobody proved. The
    // scan is best effort here: a runner without the inspection tool built
    // exactly this base addon before the codec runtime existed.
    if (result.error || result.status !== 0) {
      console.log(`FFmpeg import scan skipped for the base ${target} addon (${command} unavailable)`)
      return
    }
    if (/libav(?:codec|format|util)|libswresample/i.test(result.stdout)) {
      throw new Error('Base capture addon unexpectedly imports an FFmpeg library')
    }
    return
  }
  if (result.error || result.status !== 0) {
    throw new Error(
      `Could not inspect ${target} FFmpeg imports: ${result.error?.message || result.stderr || result.stdout || result.status}`
    )
  }
  for (const library of codecPack.libraries) {
    const expected = platform === 'darwin'
      ? `@rpath/${basename(library.source)}`
      : basename(library.source).toLowerCase()
    if (!(platform === 'darwin' ? result.stdout.includes(expected) :
      result.stdout.toLowerCase().includes(expected))) {
      throw new Error(`Capture addon has no dynamic ${library.component} import: ${expected}`)
    }
  }
}

function nativeBuildPolicy() {
  const requested = Number(process.env.SINGZ_NATIVE_JOBS || 8)
  if (!Number.isInteger(requested) || requested < 1 || requested > 8)
    throw new Error(`SINGZ_NATIVE_JOBS must be an integer from 1 through 8 (got ${process.env.SINGZ_NATIVE_JOBS})`)
  const lookup = spawnSync(
    process.platform === 'win32' ? 'where.exe' : 'which',
    [process.platform === 'win32' ? 'ccache.exe' : 'ccache'],
    { encoding: 'utf8' }
  )
  const ccache = lookup.status === 0 ? lookup.stdout.trim().split(/\r?\n/)[0] : ''
  // The user-visible safety limit is the number of process command lines
  // containing `clang`, not Ninja's edge count. An edge can expose the build
  // shell, launcher, driver and frontend even without ccache, so serialize
  // until an independently measured launcher proves a larger value <= 8.
  const jobs = Math.min(requested, 1)
  if (ccache) {
    process.env.CCACHE_BASEDIR = root
    process.env.CCACHE_NOHASHDIR = '1'
    process.env.CCACHE_COMPILERCHECK = 'content'
  }
  console.log(`Capture native compile edges: ${jobs} (requested ${requested}; ccache ${ccache ? 'enabled' : 'disabled'})`)
  return { ccache, jobs }
}

function findAddon(buildDir) {
  // Multi-config generators (Visual Studio, Xcode, Ninja Multi-Config) write
  // --config Release to Release/. Single-config generators write to the build
  // root. Read the generator's cache instead of walking a reused tree where a
  // stale Debug artifact may also exist.
  let cache = ''
  try {
    cache = readFileSync(join(buildDir, 'CMakeCache.txt'), 'utf8')
  } catch {
    return null
  }
  const configurations = cache.match(/^CMAKE_CONFIGURATION_TYPES(?::[^=]+)?=(.*)$/m)?.[1].trim()
  const expected = configurations
    ? join(buildDir, 'Release', 'singz-capture.node')
    : join(buildDir, 'singz-capture.node')
  return existsSync(expected) ? expected : null
}

function writeAtomic(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  const partial = `${path}.part-${process.pid}-${Date.now()}`
  writeFileSync(partial, contents)
  try {
    replacePathPreserving(partial, path)
  } finally {
    rmSync(partial, { force: true })
  }
}

function artifactManifest(fingerprint, artifactSha256, generation, canonicalSha256, codecPack) {
  const manifest = {
    format: 1,
    target,
    platform,
    arch,
    electronVersion,
    sourceStamp: fingerprint,
    artifactSha256,
    generation,
    addon: 'singz-capture.node',
    // A base build carries no codecRuntime at all; main then reports the
    // WAV/FLAC capability and the renderer keeps other codecs on WebAudio.
    ...(codecPack ? {
      codecRuntime: {
        format: 1,
        profile: codecPack.manifest.profile,
        target: codecPack.manifest.target,
        capabilityMask: codecPack.manifest.capabilityMask,
        packManifestSha256: codecPack.manifestSha256,
        libraries: codecPack.libraries.map(({ component, path, bytes, sha256, machCanonicalSha256 }) => ({
          component, path, bytes, sha256, ...(machCanonicalSha256 ? { machCanonicalSha256 } : {})
        }))
      }
    } : {})
  }
  if (platform === 'darwin') manifest.machCanonicalSha256 = canonicalSha256
  return manifest
}

function copyCodecRuntime(destination, codecPack) {
  for (const library of codecPack?.libraries ?? []) {
    const output = join(destination, library.path)
    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(library.sourcePath, output)
  }
}

function publishRuntimeArtifact(built, fingerprint, codecPack) {
  const artifactSha256 = sha256File(built)
  const canonicalSha256 = platform === 'darwin' ? machCanonicalSha256(built) : undefined
  const generation = uniqueGeneration()
  const manifest = artifactManifest(
    fingerprint, artifactSha256, generation, canonicalSha256, codecPack
  )
  const addon = runtimeArtifact(root, target, fingerprint, artifactSha256, generation)
  const destination = dirname(addon)
  const staging = join(dirname(destination), `.part-${generation}`)
  mkdirSync(dirname(staging), { recursive: true })
  mkdirSync(staging, { recursive: false })
  const stagedAddon = join(staging, 'singz-capture.node')
  copyFileSync(built, stagedAddon)
  copyCodecRuntime(staging, codecPack)
  writeFileSync(`${stagedAddon}.source-hash`, `${fingerprint}\n`)
  writeFileSync(`${stagedAddon}.sha256`, `${artifactSha256}\n`)
  writeFileSync(
    join(staging, 'singz-capture.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  try {
    verifyCaptureSnapshot(staging, {
      expectedTargets: target,
      electronVersion,
      expectedSourceStamp: fingerprint
    })
    renameSync(staging, destination)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return { addon, manifest }
}

function writePackageSnapshot(addon, manifest) {
  const destination = packageRoot(root, target)
  const staging = `${destination}.part-${process.pid}-${Date.now()}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const snapshotAddon = join(staging, manifest.addon)
  copyFileSync(addon, snapshotAddon)
  for (const library of manifest.codecRuntime?.libraries ?? []) {
    const source = join(dirname(addon), library.path)
    const output = join(staging, library.path)
    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(source, output)
  }
  if (sha256File(snapshotAddon) !== manifest.artifactSha256) {
    rmSync(staging, { recursive: true, force: true })
    throw new Error(`Capture package snapshot copy failed checksum validation: ${target}`)
  }
  writeFileSync(`${snapshotAddon}.source-hash`, `${manifest.sourceStamp}\n`)
  writeFileSync(`${snapshotAddon}.sha256`, `${manifest.artifactSha256}\n`)
  writeFileSync(join(staging, 'singz-capture.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  verifyCaptureSnapshot(staging, {
    expectedTargets: manifest.target,
    electronVersion,
    expectedSourceStamp: manifest.sourceStamp
  })
  replacePathPreserving(staging, destination)
}

const GENERATIONS_TO_KEEP = 8
const PRUNE_GENERATION_AFTER_MS = 7 * 24 * 60 * 60 * 1000
const PRUNE_PART_AFTER_MS = 6 * 60 * 60 * 1000

function loadedOnHost(addon) {
  if (process.platform === 'darwin') {
    const result = spawnSync('lsof', ['-Fn', addon], { encoding: 'utf8' })
    // If lsof itself is unavailable or failed unexpectedly, preserve the file.
    if (result.error || ![0, 1].includes(result.status)) return true
    return result.status === 0 && /^p\d+/m.test(result.stdout)
  }
  if (process.platform === 'win32') {
    // tasklist cannot distinguish identical module basenames by full path, so
    // conservatively preserve every generation while any capture addon is
    // mapped by any process. That avoids a recursive delete partially removing
    // sidecars before Windows refuses to unlink the loaded DLL.
    const result = spawnSync(
      'tasklist',
      ['/m', 'singz-capture.node', '/fo', 'csv', '/nh'],
      { encoding: 'utf8' }
    )
    if (result.error || result.status !== 0) return true
    return result.stdout.trim() !== '' && !/^INFO:/i.test(result.stdout.trim())
  }
  return true
}

function runtimeGenerationsAndParts(dir, depth = 0, result = { generations: [], parts: [] }) {
  if (depth > 4 || result.generations.length + result.parts.length >= 512) return result
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (result.generations.length + result.parts.length >= 512) break
    const path = join(dir, entry.name)
    if (entry.name.includes('.part-') || entry.name.includes('.backup-')) {
      result.parts.push(path)
      continue
    }
    if (!entry.isDirectory()) continue
    const addon = join(path, 'singz-capture.node')
    if (depth >= 2 && existsSync(addon)) {
      try {
        result.generations.push({ addon, dir: path, mtimeMs: statSync(addon).mtimeMs })
      } catch { /* another best-effort pruner won */ }
    } else {
      runtimeGenerationsAndParts(path, depth + 1, result)
    }
  }
  return result
}

function pruneRuntimeArtifacts(currentAddon) {
  const now = Date.now()
  const found = runtimeGenerationsAndParts(runtimeRoot(root, target))
  const generations = found.generations.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const candidate of generations.slice(GENERATIONS_TO_KEEP)) {
    if (
      candidate.addon === currentAddon ||
      now - candidate.mtimeMs < PRUNE_GENERATION_AFTER_MS ||
      loadedOnHost(candidate.addon)
    ) continue
    try {
      rmSync(candidate.dir, { recursive: true, force: true })
    } catch { /* loaded, protected, or already pruned */ }
  }
  for (const path of found.parts) {
    try {
      if (now - statSync(path).mtimeMs >= PRUNE_PART_AFTER_MS) {
        rmSync(path, { recursive: true, force: true })
      }
    } catch { /* active or already removed */ }
  }
}

function prunePackageDebris(destination) {
  const prefix = `${basename(destination)}.`
  const now = Date.now()
  let entries
  try {
    entries = readdirSync(dirname(destination), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.slice(0, 128)) {
    if (
      !entry.name.startsWith(prefix) ||
      (!entry.name.includes('.part-') && !entry.name.includes('.backup-'))
    ) continue
    const path = join(dirname(destination), entry.name)
    try {
      if (now - statSync(path).mtimeMs >= PRUNE_PART_AFTER_MS) {
        rmSync(path, { recursive: true, force: true })
      }
    } catch { /* active or already removed */ }
  }
}

async function main() {
  const fingerprint = sourceFingerprint()
  if (printingFingerprint) {
    console.log(fingerprint)
    return
  }
  const codecPack = loadCodecPack()
  const buildPolicy = nativeBuildPolicy()
  let addon
  let manifest
  try {
    const current = currentRuntimeArtifact(root, target)
    verifyCaptureArtifact({
      manifestPath: current.manifestPath,
      addonPath: current.addonPath,
      expectedTargets: target,
      electronVersion,
      expectedSourceStamp: fingerprint,
      expectedCodecPackManifestSha256: codecPack ? codecPack.manifestSha256 : null
    })
    addon = current.addonPath
    manifest = current.manifest
    console.log(`cached: ${relative(root, addon)}`)
  } catch {
    mkdirSync(headersRoot, { recursive: true })
    if (!existsSync(join(includeDir, 'node_api.h'))) {
      if (!existsSync(archive)) {
        await downloadHeaderFile(
          `https://electronjs.org/headers/v${electronVersion}/node-v${electronVersion}-headers.tar.gz`,
          archive
        )
      }
      extractHeaders(archive, headersRoot)
    }
    if (platform === 'win32' && !existsSync(nodeLibrary)) {
      mkdirSync(join(headersRoot, 'win-x64'), { recursive: true })
      await downloadHeaderFile(`https://electronjs.org/headers/v${electronVersion}/win-x64/node.lib`, nodeLibrary)
    }

    const buildDir = join(root, 'build', `capture-${target}`)
    const configure = [
      '-S', root,
      '-B', buildDir,
      '-DSINGZ_BUILD_HOST_TOOLS=OFF',
      '-DSINGZ_CORE_TESTS=OFF',
      '-DSINGZ_BUILD_ELECTRON_CAPTURE=ON',
      '-DCMAKE_BUILD_TYPE=Release',
      `-DSINGZ_NODE_INCLUDE_DIR=${includeDir}`,
      `-DSINGZ_CAPTURE_ELECTRON=${electronVersion}`,
      `-DSINGZ_CAPTURE_SOURCE_STAMP=${fingerprint}`,
      ...(codecPack ? [
        '-DSINGZ_ENABLE_FFMPEG_CODECS=ON',
        `-DSINGZ_FFMPEG_INCLUDE_DIR=${join(codecPack.pack, 'include')}`,
        `-DSINGZ_FFMPEG_AVCODEC_LIBRARY=${codecPack.libraries.find((row) => row.component === 'avcodec').linkPath}`,
        `-DSINGZ_FFMPEG_AVFORMAT_LIBRARY=${codecPack.libraries.find((row) => row.component === 'avformat').linkPath}`,
        `-DSINGZ_FFMPEG_AVUTIL_LIBRARY=${codecPack.libraries.find((row) => row.component === 'avutil').linkPath}`,
        `-DSINGZ_FFMPEG_SWRESAMPLE_LIBRARY=${codecPack.libraries.find((row) => row.component === 'swresample').linkPath}`
      ] : ['-DSINGZ_ENABLE_FFMPEG_CODECS=OFF'])
    ]
    if (buildPolicy.ccache) {
      configure.push(`-DCMAKE_C_COMPILER_LAUNCHER=${buildPolicy.ccache}`)
      configure.push(`-DCMAKE_CXX_COMPILER_LAUNCHER=${buildPolicy.ccache}`)
    }
    if (platform === 'darwin') {
      configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`)
    }
    if (platform === 'win32') {
      configure.push(`-DSINGZ_NODE_LIBRARY=${nodeLibrary}`)
      for (const component of codecPack ? ['avcodec', 'avformat', 'avutil', 'swresample'] : []) {
        const library = codecPack.libraries.find((row) => row.component === component)
        configure.push(`-DSINGZ_FFMPEG_${component.toUpperCase()}_RUNTIME=${library.sourcePath}`)
      }
    }
    run('cmake', configure)
    run('cmake', [
      '--build', buildDir, '--config', 'Release', '--target', 'singz_capture',
      '--parallel', String(buildPolicy.jobs)
    ])

    const built = findAddon(buildDir)
    if (!built) throw new Error(`singz-capture.node was not produced under ${buildDir}`)
    assertSourceFingerprintUnchanged(
      fingerprint,
      sourceFingerprint(),
      'while CMake was building; discarded the result'
    )
    validateCaptureBinary(built, target)
    validateFfmpegImports(built, codecPack)
    const published = publishRuntimeArtifact(built, fingerprint, codecPack)
    addon = published.addon
    manifest = published.manifest
    console.log(`Capture addon: ${relative(root, addon)}`)
  }

  // Catch an edit that landed after the build validation but before either
  // mutable selector is changed. The unselected immutable generation is safe
  // and will age out through best-effort pruning.
  assertSourceFingerprintUnchanged(fingerprint, sourceFingerprint(), 'before publication')
  writeAtomic(join(runtimeRoot(root, target), 'current.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writePackageSnapshot(addon, manifest)
  pruneRuntimeArtifacts(addon)
  prunePackageDebris(packageRoot(root, target))
  console.log(`Capture package snapshot: ${relative(root, packageRoot(root, target))}`)
}

if (runningAsScript) {
  if (!printingFingerprint && !process.env.SINGZ_NATIVE_BUILD_LOCK_HELD) {
    const locked = spawnSync(process.execPath, [
      join(root, 'scripts', 'with-native-build-lock.mjs'),
      '--owner', `capture-addon:${target}`,
      '--', process.execPath, __filename, ...process.argv.slice(2)
    ], { cwd: process.cwd(), stdio: 'inherit' })
    if (locked.error) throw locked.error
    process.exitCode = locked.status ?? 1
  } else {
    if (!printingFingerprint) {
      assertNativeBuildLockHeld(root, process.env.SINGZ_NATIVE_BUILD_LOCK_HELD)
    }
    main().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  }
}

module.exports = { download, downloadHeaderFile, extractHeaders, findAddon, sourceFingerprint }
