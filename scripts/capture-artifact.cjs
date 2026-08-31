const { createHash, randomBytes } = require('node:crypto')
const { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { tmpdir } = require('node:os')

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

function machSlices(bytes) {
  if (bytes.length < 4) throw new Error('Mach-O is truncated')
  if (bytes.readUInt32LE(0) === MH_MAGIC_64) {
    return [{ offset: 0, size: bytes.length, expectedCpu: null, expectedSubtype: null }]
  }
  const magic = bytes.readUInt32BE(0)
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    throw new Error('Unsupported Mach-O magic (64-bit thin/fat required)')
  }
  if (bytes.length < 8) throw new Error('Fat Mach-O header is truncated')
  const count = bytes.readUInt32BE(4)
  if (count < 1 || count > 16) throw new Error(`Invalid fat Mach-O slice count: ${count}`)
  const entrySize = magic === FAT_MAGIC_64 ? 32 : 20
  if (8 + count * entrySize > bytes.length) throw new Error('Fat Mach-O table is truncated')
  const slices = []
  for (let index = 0; index < count; index += 1) {
    const base = 8 + index * entrySize
    const expectedCpu = bytes.readUInt32BE(base)
    const expectedSubtype = bytes.readUInt32BE(base + 4)
    const offsetValue = magic === FAT_MAGIC_64 ? bytes.readBigUInt64BE(base + 8) : BigInt(bytes.readUInt32BE(base + 8))
    const sizeValue = magic === FAT_MAGIC_64 ? bytes.readBigUInt64BE(base + 16) : BigInt(bytes.readUInt32BE(base + 12))
    if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER) || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Fat Mach-O slice exceeds safe file offsets')
    }
    const offset = Number(offsetValue)
    const size = Number(sizeValue)
    if (size < 32 || offset < 8 + count * entrySize || offset + size > bytes.length) {
      throw new Error('Fat Mach-O slice is out of bounds')
    }
    slices.push({ offset, size, expectedCpu, expectedSubtype })
  }
  const ordered = [...slices].sort((a, b) => a.offset - b.offset)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].offset + ordered[index - 1].size > ordered[index].offset) {
      throw new Error('Fat Mach-O slices overlap')
    }
  }
  return slices
}

function parseMachSlice(bytes, slice) {
  const { offset, size, expectedCpu, expectedSubtype } = slice
  if (bytes.readUInt32LE(offset) !== MH_MAGIC_64) throw new Error('Mach-O slice is not little-endian 64-bit')
  const cpu = bytes.readUInt32LE(offset + 4)
  const subtype = bytes.readUInt32LE(offset + 8)
  if (expectedCpu !== null && (cpu !== expectedCpu || subtype !== expectedSubtype)) {
    throw new Error('Fat Mach-O CPU metadata disagrees with its slice')
  }
  const commandCount = bytes.readUInt32LE(offset + 16)
  const commandBytes = bytes.readUInt32LE(offset + 20)
  if (commandCount > 4096 || commandBytes > size - 32) throw new Error('Mach-O load commands are invalid')
  let cursor = offset + 32
  const commandEnd = cursor + commandBytes
  let linkedit = null
  let hasCodeSignature = false
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandEnd) throw new Error('Mach-O load command is truncated')
    const command = bytes.readUInt32LE(cursor)
    const commandSize = bytes.readUInt32LE(cursor + 4)
    if (commandSize < 8 || cursor + commandSize > commandEnd) throw new Error('Mach-O load command size is invalid')
    if (command === LC_CODE_SIGNATURE) hasCodeSignature = true
    if (command === LC_SEGMENT_64) {
      if (commandSize < 72) throw new Error('Mach-O segment command is truncated')
      const segmentName = bytes.subarray(cursor + 8, cursor + 24).toString('ascii').replace(/\0.*$/, '')
      if (segmentName === '__LINKEDIT') {
        if (linkedit) throw new Error('Mach-O has multiple __LINKEDIT segments')
        const fileOffset = bytes.readBigUInt64LE(cursor + 40)
        const fileSize = bytes.readBigUInt64LE(cursor + 48)
        if (fileOffset > BigInt(Number.MAX_SAFE_INTEGER) || fileSize > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Mach-O __LINKEDIT exceeds safe file offsets')
        }
        linkedit = {
          fileOffset: Number(fileOffset),
          fileSize: Number(fileSize),
          vmsizeOffset: cursor + 32 - offset
        }
      }
    }
    cursor += commandSize
  }
  if (cursor !== commandEnd || !linkedit) throw new Error('Mach-O load commands or __LINKEDIT are incomplete')
  const meaningfulEnd = linkedit.fileOffset + linkedit.fileSize
  if (linkedit.fileOffset < 32 + commandBytes || meaningfulEnd > size || meaningfulEnd <= linkedit.fileOffset) {
    throw new Error('Mach-O __LINKEDIT file range is invalid')
  }
  const canonical = Buffer.from(bytes.subarray(offset, offset + meaningfulEnd))
  // codesign adjusts __LINKEDIT virtual allocation for signature growth. Its
  // file bytes/size after removal are meaningful; only vmsize is signer-owned.
  canonical.fill(0, linkedit.vmsizeOffset, linkedit.vmsizeOffset + 8)
  return {
    cpu,
    subtype,
    hasCodeSignature,
    digest: createHash('sha256').update(canonical).digest('hex')
  }
}

function machCanonicalSha256(addonPath) {
  if (process.platform !== 'darwin') throw new Error('Canonical Mach-O digest requires macOS')
  const temp = mkdtempSync(join(tmpdir(), 'singz-mach-canonical-'))
  const copy = join(temp, 'singz-capture.node')
  try {
    copyFileSync(addonPath, copy)
    const before = readFileSync(copy)
    const signed = machSlices(before).map((slice) => parseMachSlice(before, slice))
      .some((slice) => slice.hasCodeSignature)
    if (signed) {
      const removed = spawnSync('/usr/bin/codesign', ['--remove-signature', copy], { encoding: 'utf8' })
      if (removed.status !== 0) {
        throw new Error(`Could not remove Mach-O signature: ${removed.stderr || removed.stdout}`)
      }
    }
    const bytes = readFileSync(copy)
    const slices = machSlices(bytes).map((slice) => parseMachSlice(bytes, slice))
    const identities = slices.map(({ cpu, subtype, digest }) =>
      `${cpu.toString(16)}:${subtype.toString(16)}:${digest}`
    ).sort()
    const hash = createHash('sha256')
    hash.update('singz-mach-canonical-v1\n')
    for (const identity of identities) hash.update(`${identity}\n`)
    return hash.digest('hex')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function validCaptureArtifact({
  addon,
  sourceHash,
  checksum,
  expectedSourceStamp,
  expectedArtifactSha256
}) {
  try {
    const publishedSource = readFileSync(sourceHash, 'utf8').trim()
    const publishedChecksum = readFileSync(checksum, 'utf8').trim()
    return (
      publishedSource === expectedSourceStamp &&
      /^[0-9a-f]{64}$/.test(publishedChecksum) &&
      (!expectedArtifactSha256 || publishedChecksum === expectedArtifactSha256) &&
      sha256File(addon) === publishedChecksum
    )
  } catch {
    return false
  }
}

function assertHostCanBuildTarget(target, hostPlatform = process.platform) {
  const platform = target.startsWith('darwin-') ? 'darwin' :
    target.startsWith('win32-') ? 'win32' : ''
  if (platform !== hostPlatform) {
    throw new Error(
      `Cross-OS capture builds are not configured: ${hostPlatform} cannot build ${target}`
    )
  }
}

function assertSourceFingerprintUnchanged(expected, actual, phase) {
  if (actual !== expected) {
    throw new Error(
      `Capture native sources changed ${phase}; selectors were left unchanged. Retry the build.`
    )
  }
}

function captureTarget(platform, arch) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`The desktop capture addon is not supported on ${platform}-${arch}`)
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error('The shipping Windows capture addon is currently x64 only')
  }
  return `${platform}-${arch}`
}

function requestedCaptureTargets(args, hostPlatform = process.platform, hostArch = process.arch) {
  const forbiddenSubcommands = new Set([
    'publish', 'start', 'install-app-deps', 'node-gyp-rebuild',
    'create-self-signed-cert', 'clear-cache'
  ])
  const unsupportedExact = new Map([
    ['--linux', 'Linux desktop capture packaging is not supported'],
    ['-l', 'Linux desktop capture packaging is not supported'],
    ['--ia32', 'The desktop capture addon does not support ia32'],
    ['--armv7l', 'The desktop capture addon does not support armv7l'],
    ['-o', 'The -o electron-builder shorthand is not supported by the SingZ dist wrapper']
  ])
  const targetFlags = [
    '--mac', '--macos', '-m', '--win', '--windows', '-w',
    '--linux', '-l', '--x64', '--arm64', '--universal', '--ia32', '--armv7l', '-o'
  ]
  for (const arg of args) {
    if (arg === '--') {
      throw new Error('The literal -- argument is not supported by the SingZ dist wrapper')
    }
    if (forbiddenSubcommands.has(arg)) {
      throw new Error(`electron-builder non-build subcommands are not supported: ${arg}`)
    }
    if (/^--no-(?:x64|arm64|universal|mac|macos|m|win|windows|w|linux|l|ia32|armv7l|o)(?:=|$)/.test(arg)) {
      throw new Error(`Negated electron-builder build-selection flags are not supported: ${arg}`)
    }
    if (/^-[^-]{2,}/.test(arg) && !arg.startsWith('-p=')) {
      throw new Error(`Combined or attached short options are not supported: ${arg}`)
    }
    if (
      /^(?:--prepackaged|--pd)(?:=|$)/.test(arg) ||
      /^(?:--projectDir|--project)(?:[.=]|$)/.test(arg) ||
      /^(?:--config)(?:[.=]|$)/.test(arg) ||
      /^-c(?:[.=]|$)/.test(arg)
    ) {
      throw new Error(
        `electron-builder input/configuration overrides are not supported by the SingZ dist wrapper: ${arg}`
      )
    }
    if (unsupportedExact.has(arg)) throw new Error(unsupportedExact.get(arg))
    const valuedTargetFlag = targetFlags.find((flag) => arg.startsWith(`${flag}=`))
    if (valuedTargetFlag) {
      throw new Error(
        `Ambiguous electron-builder target flag is not supported: ${arg}; pass ${valuedTargetFlag} without a value`
      )
    }
    if (/^[^-][^:]*:(?:x64|arm64|universal|ia32|armv7l)$/i.test(arg)) {
      throw new Error(
        `Architecture-suffixed electron-builder targets are not supported: ${arg}; pass the target and architecture as separate flags`
      )
    }
  }

  const has = (...names) => args.some((arg) => names.includes(arg))
  const wantsMac = has('--mac', '--macos', '-m')
  const wantsWin = has('--win', '--windows', '-w')
  const platforms = []
  if (wantsMac) platforms.push('darwin')
  if (wantsWin) platforms.push('win32')
  if (platforms.length === 0) platforms.push(hostPlatform)

  const wantsUniversal = has('--universal')
  const explicitArches = []
  if (has('--arm64')) explicitArches.push('arm64')
  if (has('--x64')) explicitArches.push('x64')
  if (wantsUniversal) explicitArches.push('arm64', 'x64')

  if (wantsUniversal && platforms.some((platform) => platform !== 'darwin')) {
    throw new Error('Universal capture packaging is macOS only')
  }
  if (wantsUniversal && (has('--arm64') || has('--x64'))) {
    throw new Error('Do not combine --universal with a thin architecture flag')
  }

  const targets = []
  for (const platform of platforms) {
    if (platform !== hostPlatform) {
      throw new Error(
        `Cross-OS capture packaging is not configured: ${hostPlatform} cannot package ${platform}`
      )
    }
    const arches = explicitArches.length > 0 ? explicitArches : [platform === 'win32' ? 'x64' : hostArch]
    if (platform === 'win32' && arches.includes('arm64')) {
      throw new Error('Windows capture packaging is x64 only; pass --x64')
    }
    for (const arch of arches) {
      const target = captureTarget(platform, arch)
      if (!targets.includes(target)) targets.push(target)
    }
  }
  return targets
}

function runtimeRoot(root, target) {
  return join(root, 'build', 'capture-runtime', target)
}

function runtimeArtifact(root, target, sourceStamp, artifactSha256, generation) {
  return join(
    runtimeRoot(root, target),
    sourceStamp,
    artifactSha256,
    generation,
    'singz-capture.node'
  )
}

function packageRoot(root, target) {
  return join(root, 'build', 'capture-package', target)
}

function readManifest(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  if (
    value?.format !== 1 ||
    typeof value.target !== 'string' ||
    typeof value.platform !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.electronVersion !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.sourceStamp) ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256) ||
    (value.platform === 'darwin' && !/^[0-9a-f]{64}$/.test(value.machCanonicalSha256)) ||
    (value.platform !== 'darwin' && value.machCanonicalSha256 !== undefined) ||
    !/^[0-9a-z-]{8,80}$/.test(value.generation) ||
    value.addon !== 'singz-capture.node'
  ) {
    throw new Error(`Invalid capture artifact manifest: ${path}`)
  }
  return value
}

function currentRuntimeArtifact(root, target) {
  const manifestPath = join(runtimeRoot(root, target), 'current.json')
  const manifest = readManifest(manifestPath)
  if (manifest.target !== target) throw new Error(`Capture manifest target mismatch: ${manifest.target}`)
  return {
    manifest,
    manifestPath,
    addonPath: runtimeArtifact(
      root,
      target,
      manifest.sourceStamp,
      manifest.artifactSha256,
      manifest.generation
    )
  }
}

function validatePeX64(path) {
  const bytes = readFileSync(path)
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`Capture addon is not a PE binary: ${path}`)
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (
    peOffset + 6 > bytes.length ||
    bytes.toString('binary', peOffset, peOffset + 4) !== 'PE\0\0' ||
    bytes.readUInt16LE(peOffset + 4) !== 0x8664
  ) {
    throw new Error(`Capture addon is not a PE x64 binary: ${path}`)
  }
}

function validateCaptureBinary(addon, target) {
  if (target === 'win32-x64') {
    validatePeX64(addon)
    return
  }
  const arches = target === 'darwin-universal'
    ? ['x86_64', 'arm64']
    : target === 'darwin-x64' ? ['x86_64']
      : target === 'darwin-arm64' ? ['arm64'] : null
  if (!arches) throw new Error(`Unknown capture binary target: ${target}`)
  if (process.platform !== 'darwin') {
    throw new Error(`Mach-O validation requires macOS: ${target}`)
  }
  const result = spawnSync('lipo', [addon, '-archs'], { encoding: 'utf8' })
  const actual = result.status === 0 ? result.stdout.trim().split(/\s+/).sort() : []
  const expected = [...arches].sort()
  if (result.status !== 0 || actual.join(' ') !== expected.join(' ')) {
    throw new Error(
      `Capture addon has the wrong Mach-O architecture for ${target}: ` +
      `${result.stderr || result.stdout || `lipo exited ${result.status}`}`.trim() +
      ` (expected ${expected.join(' ')}, found ${actual.join(' ') || 'none'})`
    )
  }
}

function verifyCaptureArtifact({
  manifestPath,
  addonPath,
  expectedTargets,
  electronVersion,
  expectedSourceStamp,
  verifyBinary = true,
  allowSignedMacMutation = false,
  hostPlatform = process.platform,
  verifySignedMac = verifySignedMacArtifact,
  canonicalMacDigest = machCanonicalSha256
}) {
  const manifest = readManifest(manifestPath)
  const targets = Array.isArray(expectedTargets) ? expectedTargets : [expectedTargets]
  if (!targets.includes(manifest.target)) {
    throw new Error(`Capture artifact target mismatch: ${manifest.target}; expected ${targets.join(' or ')}`)
  }
  const declared = `${manifest.platform}-${manifest.arch}`
  if (declared !== manifest.target) {
    throw new Error(
      `Capture artifact platform/architecture ${declared} disagrees with target ${manifest.target}`
    )
  }
  if (manifest.electronVersion !== electronVersion) {
    throw new Error(
      `Capture artifact targets Electron ${manifest.electronVersion}, expected ${electronVersion}`
    )
  }
  if (expectedSourceStamp && manifest.sourceStamp !== expectedSourceStamp) {
    throw new Error(
      `Capture artifact source ${manifest.sourceStamp}, expected ${expectedSourceStamp}`
    )
  }
  let publishedSource = ''
  let publishedChecksum = ''
  try {
    publishedSource = readFileSync(`${addonPath}.source-hash`, 'utf8').trim()
    publishedChecksum = readFileSync(`${addonPath}.sha256`, 'utf8').trim()
  } catch { /* reported by the common failure below */ }
  if (
    publishedSource !== manifest.sourceStamp ||
    publishedChecksum !== manifest.artifactSha256 ||
    !/^[0-9a-f]{64}$/.test(publishedChecksum)
  ) {
    throw new Error(`Capture artifact is incomplete or corrupt: ${addonPath}`)
  }
  const actualSha256 = sha256File(addonPath)
  if (manifest.platform === 'darwin') {
    const actualCanonical = canonicalMacDigest(addonPath)
    if (actualCanonical !== manifest.machCanonicalSha256) {
      throw new Error(`Capture artifact canonical Mach-O digest mismatch: ${addonPath}`)
    }
  }
  if (actualSha256 !== publishedChecksum) {
    const acceptsSignedMutation =
      allowSignedMacMutation &&
      hostPlatform === 'darwin' &&
      manifest.platform === 'darwin' &&
      manifest.target.startsWith('darwin-') &&
      verifySignedMac(addonPath)
    if (!acceptsSignedMutation) {
      throw new Error(`Capture artifact is incomplete or corrupt: ${addonPath}`)
    }
  }
  if (verifyBinary) validateCaptureBinary(addonPath, manifest.target)
  return { manifest, addonPath, manifestPath }
}

function verifySignedMacArtifact(addonPath) {
  const result = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--strict', addonPath],
    { encoding: 'utf8' }
  )
  return result.status === 0
}

function verifyCaptureSnapshot(snapshotRoot, options) {
  return verifyCaptureArtifact({
    ...options,
    manifestPath: join(snapshotRoot, 'singz-capture.manifest.json'),
    addonPath: join(snapshotRoot, 'singz-capture.node')
  })
}

// Snapshot publication is single-writer per checkout (the repository's
// worktree rule). The backup is not a lock: it only guarantees a failed
// install restores the previous coherent snapshot.
function replacePathPreserving(source, destination) {
  if (!existsSync(destination)) {
    renameSync(source, destination)
    return
  }
  const backup = `${destination}.backup-${process.pid}-${randomBytes(5).toString('hex')}`
  renameSync(destination, backup)
  try {
    renameSync(source, destination)
  } catch (error) {
    try {
      renameSync(backup, destination)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Could not install or restore ${destination}`)
    }
    throw error
  }
  try {
    rmSync(backup, { recursive: true, force: true })
  } catch {
    // The new snapshot is installed and coherent; abandoned backups are
    // cleaned by the next build's best-effort pruning.
  }
}

function uniqueGeneration() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(5).toString('hex')}`
}

module.exports = {
  assertHostCanBuildTarget,
  assertSourceFingerprintUnchanged,
  captureTarget,
  currentRuntimeArtifact,
  machCanonicalSha256,
  packageRoot,
  readManifest,
  replacePathPreserving,
  requestedCaptureTargets,
  runtimeArtifact,
  runtimeRoot,
  sha256File,
  uniqueGeneration,
  validCaptureArtifact,
  validateCaptureBinary,
  verifyCaptureArtifact,
  verifyCaptureSnapshot,
  verifySignedMacArtifact
}
