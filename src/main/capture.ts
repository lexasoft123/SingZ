import { app } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { log } from './log'
import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult,
  DesktopMonitorConfig,
  DesktopMonitorFormat,
  DesktopMonitorLatency,
  DesktopMonitorResult,
  DesktopMonitorStatus,
  DesktopPlaybackLaneConfig,
  DesktopPlaybackPrepareConfig,
  DesktopPlaybackProvider,
  DesktopPlaybackProviderInfo,
  DesktopPlaybackResult,
  DesktopPlaybackRuntimeCapability,
  DesktopPlaybackStatus,
  CaptureAnalysisWindow,
  CaptureInputDevice,
  CaptureStartResult,
  CaptureStateName,
  CaptureStats
} from '../shared/types'
import {
  DESKTOP_PLAYBACK_CAPABILITY,
  DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_BASE_MASK,
  DESKTOP_PLAYBACK_CODEC_BASE_TAG,
  DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS,
  DESKTOP_PLAYBACK_CODEC_FULL_MASK,
  DESKTOP_PLAYBACK_CODEC_FULL_TAG,
  DESKTOP_PLAYBACK_CODEC_PROFILE,
  DESKTOP_PLAYBACK_CONTRACT_VERSION
} from '../shared/types'
import { machCanonicalSha256 } from './mach-canonical'

export interface NativeCaptureBinding {
  inputDevices():
    | { ok: true; devices: CaptureInputDevice[] }
    | { ok: false; devices: []; error: string }
  beginCapture(
    config: { deviceUid?: string; inputChannel: number; ringBlocks?: number },
    generation: bigint,
    sink: (window: CaptureAnalysisWindow) => void
  ): CaptureStartResult
  cancelCapture(generation: bigint): { ok: true; cancelled: boolean }
  captureState(): { state: CaptureStateName; ownershipGeneration: string; error: string }
  captureStats(): CaptureStats
  audioHostProviders(): DesktopPlaybackProviderInfo[]
  audioHostDevices(provider?: DesktopPlaybackProvider): Omit<DesktopAudioHostInventoryResult, 'platform'>
  beginMonitor(config: DesktopMonitorConfig, generation: bigint): DesktopMonitorResult
  setMonitorGain(generation: bigint, gainDb: number, enabled: boolean): DesktopMonitorResult
  monitorStatus(): DesktopMonitorStatus
  endMonitor(generation: bigint): DesktopMonitorResult
  preparePlayback(
    config: DesktopPlaybackPrepareConfig,
    lanes: DesktopPlaybackLaneConfig[],
    generation: bigint
  ): DesktopPlaybackResult
  openPlaybackOutput(generation: bigint): DesktopPlaybackResult
  startPlayback(generation: bigint): DesktopPlaybackResult
  pausePlayback(generation: bigint): DesktopPlaybackResult
  resumePlayback(generation: bigint): DesktopPlaybackResult
  stopPlayback(generation: bigint): DesktopPlaybackResult
  seekPlayback(generation: bigint, projectFrame: number): DesktopPlaybackResult
  setPlaybackLoop(generation: bigint, startFrame: number, endFrame: number): DesktopPlaybackResult
  clearPlaybackLoop(generation: bigint): DesktopPlaybackResult
  reanchorPlayback(generation: bigint): DesktopPlaybackResult
  setPlaybackLane(
    generation: bigint,
    id: string,
    gain: number,
    muted: boolean,
    solo: boolean
  ): DesktopPlaybackResult
  setPlaybackMasterGain(generation: bigint, gain: number): DesktopPlaybackResult
  playbackStatus(): DesktopPlaybackStatus
  unloadPlayback(generation: bigint): DesktopPlaybackResult
  /** Compiled-in identity — which Electron and which source tree built this binary. */
  buildInfo: { electronVersion: string; sourceStamp: string }
}

const require = createRequire(import.meta.url)

export class CaptureAddonLoadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
    this.name = 'CaptureAddonLoadError'
  }
}

export interface CaptureAddonRuntime {
  envOverride?: string
  packaged: boolean
  resourcesPath: string
  cwd: string
  platform: NodeJS.Platform
  arch: string
  expectedSourceStamp?: string
  expectedArtifactSha256?: string
  generation?: string
}

export function resolveCaptureAddonPath(runtime: CaptureAddonRuntime): string {
  if (runtime.envOverride) return resolve(runtime.envOverride)
  return runtime.packaged
    ? join(runtime.resourcesPath, 'engines', 'singz-capture.node')
    : join(
        runtime.cwd,
        'build',
        'capture-runtime',
        `${runtime.platform}-${runtime.arch}`,
        runtime.expectedSourceStamp ?? 'missing-source-stamp',
        runtime.expectedArtifactSha256 ?? 'missing-artifact-sha',
        runtime.generation ?? 'missing-generation',
        'singz-capture.node'
      )
}

/** Same native-input fingerprint as scripts/build-capture-addon.cjs. */
export function captureSourceFingerprint(root: string, electronVersion: string): string {
  const files: string[] = []
  const walk = (dir: string): void => {
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
  files.push(join(root, 'CMakeLists.txt'), join(root, 'scripts', 'build-capture-addon.cjs'))
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

interface CaptureArtifactManifest {
  format: 1
  target: string
  platform: string
  arch: string
  electronVersion: string
  sourceStamp: string
  artifactSha256: string
  machCanonicalSha256?: string
  generation: string
  addon: 'singz-capture.node'
  codecRuntime?: CaptureCodecRuntime
}

export interface CaptureCodecLibrary {
  component: 'avcodec' | 'avformat' | 'avutil' | 'swresample'
  path: string
  bytes: number
  sha256: string
  machCanonicalSha256?: string
}

export interface CaptureCodecRuntime {
  format: 1
  profile: string
  target: string
  capabilityMask: string
  packManifestSha256?: string
  sourcePackManifestSha256?: string[]
  libraries: CaptureCodecLibrary[]
}

const codecRuntimeByBinding = new WeakMap<object, CaptureCodecRuntime>()

function isFullPlaybackCodecRuntime(runtime: CaptureCodecRuntime | undefined): runtime is CaptureCodecRuntime {
  if (!runtime) return false
  const packBindingValid =
    (/^[0-9a-f]{64}$/.test(runtime.packManifestSha256 ?? '') &&
      runtime.sourcePackManifestSha256 === undefined) ||
    (runtime.packManifestSha256 === undefined &&
      runtime.sourcePackManifestSha256?.length === 2 &&
      runtime.sourcePackManifestSha256.every((sha) => /^[0-9a-f]{64}$/.test(sha)) &&
      new Set(runtime.sourcePackManifestSha256).size === 2)
  return runtime.format === 1 &&
    runtime.profile === DESKTOP_PLAYBACK_CODEC_PROFILE &&
    runtime.capabilityMask === `0x${DESKTOP_PLAYBACK_CODEC_FULL_MASK.toString(16).padStart(8, '0')}` &&
    /^(?:darwin-(?:arm64|x64|universal)|win32-x64)$/.test(runtime.target) &&
    packBindingValid &&
    runtime.libraries.length === 4 &&
    JSON.stringify(runtime.libraries.map((library) => library.component).sort()) ===
      JSON.stringify(['avcodec', 'avformat', 'avutil', 'swresample']) &&
    runtime.libraries.every((library) =>
      library.path.length > 0 && !library.path.startsWith('/') && !library.path.includes('\\') &&
      !library.path.split('/').includes('..') && library.bytes > 0 &&
      Number.isSafeInteger(library.bytes) && /^[0-9a-f]{64}$/.test(library.sha256) &&
      (runtime.target.startsWith('darwin-')
        ? /^[0-9a-f]{64}$/.test(library.machCanonicalSha256 ?? '')
        : library.machCanonicalSha256 === undefined))
}

export function playbackCodecSupportsPath(
  capability: DesktopPlaybackRuntimeCapability,
  path: string
): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return false
  const extension = path.slice(dot + 1).toLowerCase()
  return capability.mediaCodec.extensions.includes(extension)
}

function parseCaptureManifest(path: string): CaptureArtifactManifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<CaptureArtifactManifest>
  const components = value.codecRuntime?.libraries?.map((row) => row.component).sort()
  const codecPackBindingValid = value.codecRuntime === undefined ||
    (/^[0-9a-f]{64}$/.test(value.codecRuntime.packManifestSha256 ?? '') &&
      value.codecRuntime.sourcePackManifestSha256 === undefined) ||
    (value.codecRuntime.packManifestSha256 === undefined &&
      value.codecRuntime.sourcePackManifestSha256?.length === 2 &&
      value.codecRuntime.sourcePackManifestSha256.every(
        (sha) => /^[0-9a-f]{64}$/.test(sha)
      ) && new Set(value.codecRuntime.sourcePackManifestSha256).size === 2)
  const codecValid = value.codecRuntime === undefined || (
    value.codecRuntime.format === 1 &&
    typeof value.codecRuntime.profile === 'string' &&
    typeof value.codecRuntime.target === 'string' &&
    /^0x[0-9a-f]{8}$/.test(value.codecRuntime.capabilityMask) &&
    codecPackBindingValid &&
    JSON.stringify(components) ===
      JSON.stringify(['avcodec', 'avformat', 'avutil', 'swresample']) &&
    value.codecRuntime.libraries.every((row) =>
      row.path.length > 0 && !row.path.startsWith('/') &&
      !row.path.includes('\\') && !row.path.split('/').includes('..') &&
      Number.isSafeInteger(row.bytes) && row.bytes > 0 &&
      /^[0-9a-f]{64}$/.test(row.sha256) &&
      (value.platform === 'darwin'
        ? /^[0-9a-f]{64}$/.test(row.machCanonicalSha256 ?? '')
        : row.machCanonicalSha256 === undefined)
    )
  )
  if (
    value.format !== 1 ||
    typeof value.target !== 'string' ||
    typeof value.platform !== 'string' ||
    typeof value.arch !== 'string' ||
    typeof value.electronVersion !== 'string' ||
    !/^[0-9a-f]{40}$/.test(value.sourceStamp ?? '') ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256 ?? '') ||
    (value.platform === 'darwin' && !/^[0-9a-f]{64}$/.test(value.machCanonicalSha256 ?? '')) ||
    (value.platform !== 'darwin' && value.machCanonicalSha256 !== undefined) ||
    !/^[0-9a-z-]{8,80}$/.test(value.generation ?? '') ||
    value.addon !== 'singz-capture.node' || !codecValid
  ) {
    throw new Error(`Invalid capture artifact manifest: ${path}`)
  }
  return value as CaptureArtifactManifest
}

/** Automated runs are silent, and SINGZ_MUTE used to mute only Chromium
 * (`mute-audio` in index.ts): the native CoreAudio/WASAPI graph never went
 * through that switch, so once native became the default a driver that
 * pressed Play for a second came out of the speakers. The master gain the
 * renderer asks for is clamped to 0 here, at prepare and on every later set,
 * so no renderer call can raise it; analysers, sinkId and timing are exactly
 * as audible. */
export function mutedMasterGain(gain: number): number {
  return process.env.SINGZ_MUTE ? 0 : gain
}

export interface CaptureBindingLoadRuntime {
  addonPath: string
  electronVersion: string
  expectedSourceStamp: string
  expectedArtifactSha256: string
  expectedMachCanonicalSha256?: string
  readText: (path: string) => string
  readArtifact: (path: string) => Uint8Array
  loadAddon: (path: string) => unknown
  integrityMode?: 'exact' | 'packaged-signed-mac'
  verifySignedMacArtifact?: (path: string) => boolean
  canonicalMacDigest?: (path: string) => string
  codecRuntime?: CaptureCodecRuntime
  stageArtifactForLoad?: (
    bytes: Uint8Array,
    companions?: Array<{ path: string; bytes: Uint8Array }>
  ) => StagedCaptureArtifact
}

export interface StagedCaptureArtifact {
  path: string
  companions?: Record<string, string>
  cleanup: () => void
}

const CAPTURE_LOAD_PREFIX = 'singz-capture-load-'
const CAPTURE_LOAD_STALE_MS = 24 * 60 * 60 * 1000
/** How often an automatic re-anchor may write a line; see reanchorPlayback(). */
const REANCHOR_LOG_INTERVAL_MS = 10_000

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function pruneStaleCaptureLoadDirs(options: {
  base?: string
  now?: number
  isProcessLive?: (pid: number) => boolean
} = {}): void {
  const base = options.base ?? tmpdir()
  const now = options.now ?? Date.now()
  const isLive = options.isProcessLive ?? processIsLive
  let entries
  try {
    // TMP can contain tens of thousands of unrelated entries. Filter strict
    // SingZ candidates before applying the work bound or none may ever be
    // examined. isDirectory() is only a conservative prefilter: lstat below
    // revalidates the type after any replacement race.
    entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) =>
        entry.isDirectory() &&
        /^singz-capture-load-([1-9]\d{0,9})-[0-9a-f]{32}$/.test(entry.name)
      )
      .slice(0, 256)
  } catch {
    return
  }
  let removed = 0
  for (const entry of entries) {
    if (removed >= 8) break
    const matched = entry.name.match(/^singz-capture-load-([1-9]\d{0,9})-[0-9a-f]{32}$/)
    if (!matched) continue
    const pid = Number(matched[1])
    // Preserve every live process, not just this process. PID reuse is
    // deliberately conservative: a new live owner keeps the old directory.
    if (isLive(pid)) continue
    const candidate = join(base, entry.name)
    try {
      const stat = lstatSync(candidate)
      if (
        !stat.isDirectory() ||
        now - stat.mtimeMs < CAPTURE_LOAD_STALE_MS ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      ) continue
      rmSync(candidate, { recursive: true, force: true })
      removed += 1
    } catch { /* active, replaced, protected, or already pruned */ }
  }
}

/** Stage exactly-read bytes at a unique path which require() can safely map. */
export function stageArtifactForLoad(
  bytes: Uint8Array,
  companions: Array<{ path: string; bytes: Uint8Array }> = []
): StagedCaptureArtifact {
  pruneStaleCaptureLoadDirs()
  const base = tmpdir()
  let directory = ''
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = join(
      base,
      `${CAPTURE_LOAD_PREFIX}${process.pid}-${randomBytes(16).toString('hex')}`
    )
    try {
      mkdirSync(candidate, { mode: 0o700 })
      directory = candidate
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  if (!directory) throw new Error('Could not allocate a private capture-addon load directory')
  const path = join(directory, `${randomBytes(16).toString('hex')}.node`)
  const expected = Buffer.from(bytes)
  const stagedCompanions: Record<string, string> = {}
  try {
    writeFileSync(path, expected, { flag: 'wx', mode: 0o500 })
    chmodSync(path, 0o500)
    const staged = readFileSync(path)
    if (!staged.equals(expected)) throw new Error('Private capture-addon staging changed artifact bytes')
    for (const companion of companions) {
      if (!companion.path || companion.path.startsWith('/') ||
          companion.path.includes('\\') || companion.path.split('/').includes('..'))
        throw new Error('Private capture-addon companion path is unsafe')
      const companionPath = join(directory, companion.path)
      mkdirSync(dirname(companionPath), { recursive: true, mode: 0o700 })
      const companionBytes = Buffer.from(companion.bytes)
      writeFileSync(companionPath, companionBytes, { flag: 'wx', mode: 0o500 })
      chmodSync(companionPath, 0o500)
      if (!readFileSync(companionPath).equals(companionBytes))
        throw new Error('Private capture-addon companion staging changed artifact bytes')
      stagedCompanions[companion.path] = companionPath
    }
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ }
    throw error
  }
  return {
    path,
    companions: stagedCompanions,
    cleanup: () => {
      try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

export function captureIntegrityMode(
  packaged: boolean,
  platform: NodeJS.Platform,
  envOverride?: string
): 'exact' | 'packaged-signed-mac' {
  return packaged && platform === 'darwin' && !envOverride
    ? 'packaged-signed-mac'
    : 'exact'
}

export function captureAddonSourceStampPath(addonPath: string): string {
  return `${addonPath}.source-hash`
}

export function captureAddonChecksumPath(addonPath: string): string {
  return `${addonPath}.sha256`
}

export function captureAddonManifestPath(addonPath: string): string {
  return join(resolve(addonPath, '..'), 'singz-capture.manifest.json')
}

export function validateCaptureBindingIdentity(
  value: unknown,
  electronVersion: string,
  publishedSourceStamp: string
): NativeCaptureBinding {
  const binding = value as Partial<NativeCaptureBinding> | null
  const builtElectron = binding?.buildInfo?.electronVersion || 'an unknown Electron'
  const builtSource = binding?.buildInfo?.sourceStamp || 'an unknown source tree'
  if (builtElectron !== electronVersion) {
    throw new Error(
      `singz-capture.node was built for Electron ${builtElectron}, this app runs Electron ${electronVersion}`
    )
  }
  if (builtSource !== publishedSourceStamp) {
    throw new Error(
      `singz-capture.node reports source ${builtSource}, but its published source stamp is ${publishedSourceStamp}`
    )
  }
  for (const name of [
    'inputDevices', 'beginCapture', 'cancelCapture', 'captureState', 'captureStats',
    'audioHostProviders', 'audioHostDevices', 'beginMonitor', 'setMonitorGain', 'monitorStatus', 'endMonitor'
    , 'preparePlayback', 'openPlaybackOutput', 'startPlayback', 'pausePlayback',
    'resumePlayback', 'stopPlayback', 'seekPlayback', 'setPlaybackLoop',
    'clearPlaybackLoop', 'reanchorPlayback', 'setPlaybackLane',
    'setPlaybackMasterGain', 'playbackStatus', 'unloadPlayback'
  ] as const) {
    if (typeof binding?.[name] !== 'function') {
      throw new Error(`singz-capture.node does not export ${name}`)
    }
  }
  return binding as NativeCaptureBinding
}

/**
 * Load once behind a testable boundary. Each checkout uses an immutable path
 * containing its expected source fingerprint. Any require() throw means no
 * binding was returned or cached and is retryable; only a successfully
 * returned binding with the wrong compiled identity is restart-required.
 */
export function loadCaptureBindingWith(runtime: CaptureBindingLoadRuntime): NativeCaptureBinding {
  const stampPath = captureAddonSourceStampPath(runtime.addonPath)
  const checksumPath = captureAddonChecksumPath(runtime.addonPath)
  let staged: StagedCaptureArtifact | null = null
  try {
    const publishedSourceStamp = runtime.readText(stampPath).trim()
    const publishedChecksum = runtime.readText(checksumPath).trim()
    if (publishedSourceStamp !== runtime.expectedSourceStamp) {
      throw new Error(
        `artifact source ${publishedSourceStamp || 'is blank'}, expected ${runtime.expectedSourceStamp}`
      )
    }
    if (publishedChecksum !== runtime.expectedArtifactSha256) {
      throw new Error('artifact checksum differs from its manifest')
    }
    const artifactBytes = Buffer.from(runtime.readArtifact(runtime.addonPath))
    const companionBytes = (runtime.codecRuntime?.libraries ?? []).map((library) => ({
      path: library.path,
      bytes: Buffer.from(runtime.readArtifact(join(dirname(runtime.addonPath), library.path)))
    }))
    staged = (runtime.stageArtifactForLoad ?? stageArtifactForLoad)(artifactBytes, companionBytes)
    const actualChecksum = createHash('sha256').update(artifactBytes).digest('hex')
    if (actualChecksum !== publishedChecksum) {
      const acceptsSignedMutation =
        runtime.integrityMode === 'packaged-signed-mac' &&
        runtime.verifySignedMacArtifact?.(staged.path) === true &&
        /^[0-9a-f]{64}$/.test(runtime.expectedMachCanonicalSha256 ?? '') &&
        runtime.canonicalMacDigest?.(staged.path) === runtime.expectedMachCanonicalSha256
      if (!acceptsSignedMutation) throw new Error('artifact bytes fail their checksum')
    }
    for (let index = 0; index < companionBytes.length; index += 1) {
      const library = runtime.codecRuntime!.libraries[index]
      const bytes = Buffer.from(companionBytes[index].bytes)
      if (bytes.byteLength !== library.bytes)
        throw new Error(`FFmpeg ${library.component} bytes fail their size`)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (actual === library.sha256) continue
      const stagedPath = staged.companions?.[library.path]
      const acceptsSignedMutation =
        runtime.integrityMode === 'packaged-signed-mac' && stagedPath != null &&
        runtime.verifySignedMacArtifact?.(stagedPath) === true &&
        /^[0-9a-f]{64}$/.test(library.machCanonicalSha256 ?? '') &&
        runtime.canonicalMacDigest?.(stagedPath) === library.machCanonicalSha256
      if (!acceptsSignedMutation)
        throw new Error(`FFmpeg ${library.component} bytes fail their checksum`)
    }
  } catch (error) {
    staged?.cleanup()
    throw new CaptureAddonLoadError(
      `Capture addon is incomplete or corrupt (${String(error)}). Rebuild with npm run capture:addon and retry.`,
      true
    )
  }

  let binding: unknown
  try {
    binding = runtime.loadAddon(staged!.path)
  } catch (error) {
    staged?.cleanup()
    throw new CaptureAddonLoadError(
      `Could not load singz-capture.node (${String(error)}). The addon was not cached; ` +
        'rebuild with npm run capture:addon and retry.',
      true
    )
  }

  try {
    const validated = validateCaptureBindingIdentity(
      binding,
      runtime.electronVersion,
      runtime.expectedSourceStamp
    )
    if (runtime.codecRuntime) codecRuntimeByBinding.set(validated, runtime.codecRuntime)
    return validated
  } catch (error) {
    throw new CaptureAddonLoadError(
      `${String(error)}. Restart SingZ after rebuilding with npm run capture:addon.`,
      false
    )
  }
}

function captureBindingLoadRuntime(): CaptureBindingLoadRuntime {
  const root = process.cwd()
  const electronVersion = process.versions.electron
  const target = `${process.platform}-${process.arch}`
  let addonPath: string
  let manifest: CaptureArtifactManifest
  const envOverride = process.env.SINGZ_CAPTURE_ADDON
  if (envOverride) {
    addonPath = resolve(envOverride)
    manifest = parseCaptureManifest(captureAddonManifestPath(addonPath))
  } else if (app.isPackaged) {
    const engines = join(process.resourcesPath, 'engines')
    manifest = parseCaptureManifest(join(engines, 'singz-capture.manifest.json'))
    addonPath = resolveCaptureAddonPath({
      envOverride,
      packaged: true,
      resourcesPath: process.resourcesPath,
      cwd: root,
      platform: process.platform,
      arch: process.arch
    })
  } else {
    const manifestPath = join(root, 'build', 'capture-runtime', target, 'current.json')
    manifest = parseCaptureManifest(manifestPath)
    addonPath = resolveCaptureAddonPath({
      packaged: false,
      resourcesPath: process.resourcesPath,
      cwd: root,
      platform: process.platform,
      arch: process.arch,
      expectedSourceStamp: manifest.sourceStamp,
      expectedArtifactSha256: manifest.artifactSha256,
      generation: manifest.generation
    })
  }
  if (!app.isPackaged) {
    const expectedSourceStamp = captureSourceFingerprint(root, electronVersion)
    if (manifest.sourceStamp !== expectedSourceStamp) {
      throw new CaptureAddonLoadError(
        'The capture addon belongs to an older or different checkout. Rebuild with npm run capture:addon and retry.',
        true
      )
    }
  }
  const targetMatches = manifest.target === target ||
    (process.platform === 'darwin' && manifest.target === 'darwin-universal')
  const declaredTarget = `${manifest.platform}-${manifest.arch}`
  if (!targetMatches || declaredTarget !== manifest.target || manifest.electronVersion !== electronVersion) {
    throw new CaptureAddonLoadError(
      `Capture addon manifest targets ${manifest.target} / Electron ${manifest.electronVersion}, ` +
        `expected ${target} / Electron ${electronVersion}. Rebuild with npm run capture:addon and retry.`,
      true
    )
  }
  return {
    addonPath,
    electronVersion,
    expectedSourceStamp: manifest.sourceStamp,
    expectedArtifactSha256: manifest.artifactSha256,
    expectedMachCanonicalSha256: manifest.machCanonicalSha256,
    codecRuntime: manifest.codecRuntime,
    readText: (path) => readFileSync(path, 'utf8'),
    readArtifact: (path) => readFileSync(path),
    loadAddon: (path) => require(path),
    integrityMode: captureIntegrityMode(app.isPackaged, process.platform, envOverride),
    verifySignedMacArtifact: (path) =>
      spawnSync('/usr/bin/codesign', ['--verify', '--strict', path], { encoding: 'utf8' }).status === 0,
    canonicalMacDigest: machCanonicalSha256
  }
}

export function captureAddonPath(): string {
  return captureBindingLoadRuntime().addonPath
}

export function loadCaptureBinding(): NativeCaptureBinding {
  try {
    return loadCaptureBindingWith(captureBindingLoadRuntime())
  } catch (error) {
    if (error instanceof CaptureAddonLoadError) throw error
    throw new CaptureAddonLoadError(
      `Capture addon metadata is not available (${String(error)}). Rebuild with npm run capture:addon and retry.`,
      true
    )
  }
}

function parseGeneration(raw: string): bigint | null {
  if (!/^[1-9]\d{0,19}$/.test(raw)) return null
  try {
    const value = BigInt(raw)
    return value <= 0xffffffffffffffffn ? value : null
  } catch {
    return null
  }
}

function failedStart(error: string, inputChannel: number, deviceUid = ''): CaptureStartResult {
  return {
    ok: false,
    state: 'error',
    error,
    sampleRate: 0,
    inputChannel,
    deviceUid,
    deviceLabel: '',
    deviceChannels: 0,
    sampleFormat: '',
    sharingMode: '',
    performanceMode: '',
    timestampSource: ''
  }
}

const EMPTY_MONITOR_FORMAT: DesktopMonitorFormat = {
  sampleRate: 0,
  maximumFrames: 0,
  nominalBufferFrames: 0,
  inputChannels: 0,
  outputChannels: 0,
  sampleFormat: 'float32-planar',
  outputClockMaster: true,
  accessMode: 'shared'
}

const EMPTY_MONITOR_LATENCY: DesktopMonitorLatency = {
  inputDeviceFrames: 0,
  outputDeviceFrames: 0,
  bufferFrames: 0,
  externalRouteFrames: 0
}

function failedMonitor(
  error: string,
  errorCode: Exclude<DesktopMonitorResult['errorCode'], 'none'> = 'host-failure',
  ownershipGeneration = '0'
): DesktopMonitorResult {
  return {
    ok: false,
    errorCode,
    error: error || 'Native headphone monitoring failed.',
    ownershipGeneration: /^(0|[1-9]\d{0,19})$/.test(ownershipGeneration)
      ? ownershipGeneration
      : '0',
    state: 'error',
    format: { ...EMPTY_MONITOR_FORMAT },
    latency: { ...EMPTY_MONITOR_LATENCY }
  }
}

function unsupportedMonitorStatus(error: string): DesktopMonitorStatus {
  return {
    active: false,
    enabled: false,
    deviceLost: false,
    ownershipGeneration: '0',
    gainDb: 0,
    state: 'unsupported',
    error,
    pre: { peak: 0, rms: 0, frames: '0' },
    post: { peak: 0, rms: 0, frames: '0' },
    format: { ...EMPTY_MONITOR_FORMAT },
    latency: { ...EMPTY_MONITOR_LATENCY },
    routeGeneration: '0',
    streamGeneration: '0',
    callbacks: '0',
    renderedFrames: '0',
    xruns: '0',
    deadlineMisses: '0',
    renderFailures: '0',
    adapterRenderFailures: 0,
    terminalRenderFailures: 0,
    adapterLastStatusCode: 0,
    adapterLastStatusDetail: 0,
    parameterOverflows: 0,
    nonFiniteSamples: 0,
    rejectedBlocks: 0
  }
}

const EMPTY_PLAYBACK_FORMAT: DesktopPlaybackResult['format'] = {
  sampleRate: 0,
  maximumFrames: 0,
  nominalBufferFrames: 0,
  inputChannels: 0,
  outputChannels: 0
}

function failedPlayback(
  error: string,
  errorCode: DesktopPlaybackResult['errorCode'] = 'host-failure',
  generation = '0',
  state: DesktopPlaybackResult['state'] = 'unloaded'
): DesktopPlaybackResult {
  return {
    ok: false,
    errorCode,
    error,
    generation,
    state,
    format: { ...EMPTY_PLAYBACK_FORMAT },
    latency: { ...EMPTY_MONITOR_LATENCY }
  }
}

const exactUnsigned = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
const exactCounter = (value: unknown): boolean =>
  typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) <= 0xffffffffffffffffn
const finite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
const HOST_STATES = new Set([
  'closed', 'open', 'running', 'stopped', 'device-lost', 'error', 'unsupported'
])
const MONITOR_ERRORS = new Set([
  'none', 'invalid-generation', 'already-running', 'invalid-configuration',
  'platform-not-ready', 'unsupported-route', 'native-audio-busy', 'graph-failure',
  'host-failure', 'queue-full'
])
const HOST_TRANSPORTS = new Set([
  'unknown', 'built-in', 'aggregate', 'virtual', 'pci', 'usb', 'firewire',
  'bluetooth', 'bluetooth-le', 'hdmi', 'display-port', 'airplay', 'avb',
  'thunderbolt', 'continuity-wired', 'continuity-wireless', 'vehicle'
])

function validMonitorFormat(value: unknown): value is DesktopMonitorFormat {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return finite(row.sampleRate) &&
    exactUnsigned(row.maximumFrames) && exactUnsigned(row.nominalBufferFrames) &&
    exactUnsigned(row.inputChannels) && exactUnsigned(row.outputChannels) &&
    row.sampleFormat === 'float32-planar' && typeof row.outputClockMaster === 'boolean' &&
    (row.accessMode === 'shared' || row.accessMode === 'exclusive')
}

function validMonitorLatency(value: unknown): value is DesktopMonitorLatency {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return exactUnsigned(row.inputDeviceFrames) && exactUnsigned(row.outputDeviceFrames) &&
    exactUnsigned(row.bufferFrames) && exactUnsigned(row.externalRouteFrames)
}

type MonitorOperation = 'begin' | 'gain' | 'end'

function validMonitorResult(
  value: unknown,
  operation: MonitorOperation,
  expectedGeneration: string
): value is DesktopMonitorResult {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  if (
    typeof row.ok !== 'boolean' || typeof row.errorCode !== 'string' ||
    typeof row.error !== 'string' || !MONITOR_ERRORS.has(String(row.errorCode)) ||
    !exactCounter(row.ownershipGeneration) || row.ownershipGeneration !== expectedGeneration ||
    expectedGeneration === '0' || !HOST_STATES.has(String(row.state)) ||
    !validMonitorFormat(row.format) || !validMonitorLatency(row.latency)
  ) return false
  if (row.ok) {
    if (row.errorCode !== 'none' || row.error !== '') return false
    if (operation === 'begin' || operation === 'gain') return row.state === 'running'
    // AudioMonitorSession::end() is the authoritative synchronous teardown
    // boundary. The macOS host can still report `error` after the graph and
    // output have stopped when restoring the device's prior buffer size
    // fails. Retaining the generation in that cleanup-only case creates a
    // ghost owner that can never be ended again.
    return row.state === 'stopped' || row.state === 'closed' || row.state === 'error'
  }
  return row.errorCode !== 'none' && row.error.length > 0
}

function validMonitorStatus(value: unknown): value is DesktopMonitorStatus {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const meter = (meterValue: unknown): boolean => {
    if (!meterValue || typeof meterValue !== 'object') return false
    const meterRow = meterValue as Record<string, unknown>
    return finite(meterRow.peak) && finite(meterRow.rms) && exactCounter(meterRow.frames)
  }
  if (typeof row.active !== 'boolean' || typeof row.enabled !== 'boolean') return false
  if (row.enabled && !row.active) return false
  if (row.enabled && row.state !== 'running') return false
  if (row.active && row.ownershipGeneration === '0') return false
  return typeof row.deviceLost === 'boolean' && exactCounter(row.ownershipGeneration) &&
    finite(row.gainDb) && HOST_STATES.has(String(row.state)) && typeof row.error === 'string' &&
    meter(row.pre) && meter(row.post) && validMonitorFormat(row.format) &&
    validMonitorLatency(row.latency) && exactCounter(row.routeGeneration) &&
    exactCounter(row.streamGeneration) && exactCounter(row.callbacks) &&
    exactCounter(row.renderedFrames) && exactCounter(row.xruns) &&
    exactCounter(row.deadlineMisses) && exactCounter(row.renderFailures) &&
    exactUnsigned(row.adapterRenderFailures) && exactUnsigned(row.terminalRenderFailures) &&
    exactUnsigned(row.adapterLastStatusCode) &&
    exactUnsigned(row.adapterLastStatusDetail) && exactUnsigned(row.parameterOverflows) &&
    exactUnsigned(row.nonFiniteSamples) && exactUnsigned(row.rejectedBlocks)
}

function validHostDevice(value: unknown): value is DesktopAudioHostDevice {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const buffers = row.bufferFrames as Record<string, unknown> | undefined
  const validChannelLabels = (labels: unknown, count: unknown): boolean =>
    Array.isArray(labels) && typeof count === 'number' && exactUnsigned(count) && count <= 64 &&
    labels.length === count && labels.every((label) =>
      typeof label === 'string' && label.length > 0 && label.length <= 4096)
  return typeof row.uid === 'string' && row.uid.length > 0 && row.uid.length <= 4096 &&
    typeof row.label === 'string' && row.label.length <= 4096 &&
    typeof row.defaultInput === 'boolean' && typeof row.defaultOutput === 'boolean' &&
    exactUnsigned(row.inputChannels) && exactUnsigned(row.outputChannels) &&
    validChannelLabels(row.inputChannelLabels, row.inputChannels) &&
    validChannelLabels(row.outputChannelLabels, row.outputChannels) &&
    finite(row.nominalSampleRate) &&
    (row.direction === 'duplex' || row.direction === 'input' || row.direction === 'output') &&
    (row.accessMode === 'shared' || row.accessMode === 'exclusive') &&
    HOST_TRANSPORTS.has(String(row.transport)) &&
    (row.monitoringSuitability === 'unknown' || row.monitoringSuitability === 'low-latency' ||
      row.monitoringSuitability === 'high-latency' || row.monitoringSuitability === 'unsupported') &&
    Array.isArray(row.sampleRateRanges) && row.sampleRateRanges.length <= 256 &&
    row.sampleRateRanges.every((range) => {
      if (!range || typeof range !== 'object') return false
      const values = range as Record<string, unknown>
      return finite(values.minimumHz) && finite(values.maximumHz)
    }) && Boolean(buffers) && exactUnsigned(buffers?.minimumFrames) &&
    exactUnsigned(buffers?.maximumFrames) && exactUnsigned(buffers?.preferredFrames) &&
    exactUnsigned(buffers?.fundamentalFrames)
}

function validStartResult(value: unknown): value is CaptureStartResult {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.ok === 'boolean' &&
    typeof row.state === 'string' &&
    typeof row.sampleRate === 'number' &&
    Number.isInteger(row.inputChannel) &&
    typeof row.deviceUid === 'string' &&
    typeof row.deviceLabel === 'string' &&
    typeof row.deviceChannels === 'number' &&
    typeof row.sampleFormat === 'string' &&
    typeof row.sharingMode === 'string' &&
    typeof row.performanceMode === 'string' &&
    typeof row.timestampSource === 'string' &&
    (row.ok || typeof row.error === 'string')
  )
}

/** One process owner. Native cancel stops and joins delivery before it returns. */
export class CaptureOwner {
  private binding: NativeCaptureBinding | null = null
  private loadError: string | null = null
  private loadRetryable = true
  /** The last load outcome written to the log, so a change of outcome is
   *  reported and a repeat is not; see native(). A retryable failure followed
   *  by a rebuild is exactly the transition a boolean would swallow. */
  private loadReported: 'loaded' | 'failed' | null = null
  private generation = ''
  private rendererId: number | null = null
  private monitorGeneration = ''
  private monitorRendererId: number | null = null
  private monitorHighWater = 0n
  private playbackGeneration = ''
  private playbackRendererId: number | null = null
  /** Re-anchor log throttling; see reanchorPlayback(). */
  private reanchorGeneration = ''
  private reanchorCount = 0
  private reanchorLoggedAt = 0
  private playbackHighWater = 0n
  private cleanupRenderers = new Set<number>()

  constructor(
    binding?: NativeCaptureBinding,
    private readonly bindingLoader: () => NativeCaptureBinding = loadCaptureBinding,
    private readonly injectedCodecRuntime?: CaptureCodecRuntime
  ) {
    if (binding) this.binding = binding
  }

  private native(): NativeCaptureBinding | null {
    if (this.binding) return this.binding
    if (this.loadError && !this.loadRetryable) return null
    try {
      this.binding = this.bindingLoader()
      this.loadError = null
      this.loadRetryable = true
      // Only on a change of outcome: every playback command asks for the
      // binding, so logging unconditionally here would log at the command rate.
      if (this.loadReported !== 'loaded') log('dsp', 'native capture addon loaded')
      this.loadReported = 'loaded'
    } catch (error) {
      // Only a failure before native module initialization is retryable. If
      // require() returned an incompatible binding, Node cached that .node by
      // filename; retrying would return the same object and falsely imply a
      // rebuild can hot-replace it without restarting Electron.
      this.loadRetryable = error instanceof CaptureAddonLoadError && error.retryable
      this.loadError = `Native microphone support is unavailable: ${String(error)}`
      // The addon carries native playback as well as the microphone, so this
      // one failure silently sends playback back to Web Audio. Only the
      // Settings panel's red line said so before, and it names the microphone.
      if (this.loadReported !== 'failed')
        log(
          'dsp',
          `native addon did not load · ${String(error)} · playback falls back to Web Audio` +
            (this.loadRetryable ? ' (retryable)' : ' (a restart is needed even after a rebuild)'),
          'warn'
        )
      this.loadReported = 'failed'
    }
    return this.binding
  }

  devices(): { ok: true; devices: CaptureInputDevice[] } | { ok: false; devices: []; error: string } {
    const binding = this.native()
    if (!binding) return { ok: false, devices: [], error: this.loadError ?? 'Native capture unavailable' }
    return binding.inputDevices()
  }

  hostDevices(
    provider?: DesktopPlaybackProvider,
    platform: NodeJS.Platform = process.platform
  ): DesktopAudioHostInventoryResult {
    const exposedPlatform = platform === 'darwin' || platform === 'win32' || platform === 'linux'
      ? platform
      : 'other'
    const exposedProvider = provider ?? (platform === 'darwin' ? 'coreaudio' : 'wasapi')
    const providerMatchesPlatform = provider === undefined ||
      (platform === 'darwin' && provider === 'coreaudio') ||
      (platform === 'win32' && (provider === 'wasapi' || provider === 'asio'))
    if (!providerMatchesPlatform) {
      return {
        ok: false,
        platform: exposedPlatform,
        provider: exposedProvider,
        defaultInputUid: '',
        defaultOutputUid: '',
        devices: [],
        error: 'The requested native audio provider is not available on this platform.'
      }
    }
    const binding = this.native()
    if (!binding) {
      return {
        ok: false,
        platform: exposedPlatform,
        provider: exposedProvider,
        defaultInputUid: '',
        defaultOutputUid: '',
        devices: [],
        error: this.loadError ?? 'Native audio host unavailable'
      }
    }
    try {
      const raw = binding.audioHostDevices(provider) as {
        ok?: unknown
        provider?: unknown
        defaultInputUid?: unknown
        defaultOutputUid?: unknown
        devices?: unknown
        error?: unknown
      }
      if (
        raw.ok !== true || raw.provider !== exposedProvider || typeof raw.defaultInputUid !== 'string' ||
        typeof raw.defaultOutputUid !== 'string' || !Array.isArray(raw.devices) ||
        !raw.devices.every(validHostDevice)
      ) {
        return {
          ok: false,
          platform: exposedPlatform,
          provider: exposedProvider,
          defaultInputUid: '',
          defaultOutputUid: '',
          devices: [],
          error: typeof raw.error === 'string'
            ? raw.error
            : 'Native audio host returned an invalid device inventory.'
        }
      }
      return {
        ok: true,
        platform: exposedPlatform,
        provider: exposedProvider,
        defaultInputUid: raw.defaultInputUid,
        defaultOutputUid: raw.defaultOutputUid,
        devices: raw.devices
      }
    } catch (error) {
      return {
        ok: false,
        platform: exposedPlatform,
        provider: exposedProvider,
        defaultInputUid: '',
        defaultOutputUid: '',
        devices: [],
        error: `Native audio host inventory failed: ${String(error)}`
      }
    }
  }

  beginMonitor(rendererId: number, config: DesktopMonitorConfig): DesktopMonitorResult {
    if (this.monitorGeneration) {
      return failedMonitor(
        'End the active headphone monitor before starting another.',
        'already-running',
        this.monitorGeneration
      )
    }
    if (this.monitorHighWater >= 0xffffffffffffffffn) {
      return failedMonitor('The native monitor generation range is exhausted.', 'invalid-generation')
    }
    const binding = this.native()
    if (!binding) {
      return failedMonitor(this.loadError ?? 'Native audio host unavailable', 'host-failure')
    }
    const generation = ++this.monitorHighWater
    const rawGeneration = generation.toString()
    let rawResult: unknown
    try {
      rawResult = binding.beginMonitor(config, generation)
    } catch (error) {
      if (!this.monitorRollbackSucceeded(binding, generation)) {
        this.retainMonitor(rendererId, rawGeneration)
      }
      return failedMonitor(`Native headphone monitoring failed to start: ${String(error)}`, 'host-failure', rawGeneration)
    }
    if (!validMonitorResult(rawResult, 'begin', rawGeneration)) {
      if (!this.monitorRollbackSucceeded(binding, generation)) {
        this.retainMonitor(rendererId, rawGeneration)
      }
      return failedMonitor('Native headphone monitoring returned an invalid response.', 'host-failure', rawGeneration)
    }
    const result = rawResult
    if (result.ok) {
      this.retainMonitor(rendererId, rawGeneration)
      return result
    }
    let rollbackRequired = false
    try {
      const status = binding.monitorStatus()
      if (validMonitorStatus(status)) {
        rollbackRequired = status.active
      } else rollbackRequired = true
    } catch {
      rollbackRequired = true
    }
    if (rollbackRequired && !this.monitorRollbackSucceeded(binding, generation)) {
      this.retainMonitor(rendererId, rawGeneration)
    }
    return result
  }

  private retainMonitor(rendererId: number, generation: string): void {
    this.monitorGeneration = generation
    this.monitorRendererId = rendererId
  }

  private monitorRollbackSucceeded(binding: NativeCaptureBinding, generation: bigint): boolean {
    const rawGeneration = generation.toString()
    try {
      const ended = binding.endMonitor(generation)
      return validMonitorResult(ended, 'end', rawGeneration) && ended.ok
    } catch {
      return false
    }
  }

  private uncertainMonitorStatus(error: string): DesktopMonitorStatus {
    const fallback = unsupportedMonitorStatus(error)
    if (!this.monitorGeneration) return fallback
    return {
      ...fallback,
      active: true,
      ownershipGeneration: this.monitorGeneration,
      state: 'error'
    }
  }

  setMonitorGain(
    rendererId: number,
    rawGeneration: string,
    gainDb: number,
    enabled: boolean
  ): DesktopMonitorResult {
    const generation = parseGeneration(rawGeneration)
    if (
      !generation || this.monitorRendererId !== rendererId ||
      this.monitorGeneration !== rawGeneration
    ) return failedMonitor('The headphone monitor generation is no longer active.', 'invalid-generation', rawGeneration)
    const binding = this.native()
    if (!binding) return failedMonitor(this.loadError ?? 'Native audio host unavailable', 'host-failure', rawGeneration)
    try {
      const result = binding.setMonitorGain(generation, gainDb, enabled)
      return validMonitorResult(result, 'gain', rawGeneration)
        ? result
        : failedMonitor('Native headphone gain returned an invalid response.', 'host-failure', rawGeneration)
    } catch (error) {
      return failedMonitor(`Native headphone gain failed: ${String(error)}`, 'host-failure', rawGeneration)
    }
  }

  monitorStatus(): DesktopMonitorStatus {
    const binding = this.native()
    if (!binding) return this.uncertainMonitorStatus(this.loadError ?? 'Native audio host unavailable')
    try {
      const status = binding.monitorStatus()
      if (!validMonitorStatus(status)) {
        return this.uncertainMonitorStatus('Native headphone monitoring returned invalid status.')
      }
      if (
        this.monitorGeneration &&
        (!status.active || status.ownershipGeneration !== this.monitorGeneration)
      ) return this.uncertainMonitorStatus('Native headphone monitoring ownership is uncertain.')
      return status
    } catch (error) {
      return this.uncertainMonitorStatus(`Native headphone monitoring status failed: ${String(error)}`)
    }
  }

  endMonitor(rendererId: number, rawGeneration: string): DesktopMonitorResult {
    const generation = parseGeneration(rawGeneration)
    if (
      !generation || this.monitorRendererId !== rendererId ||
      this.monitorGeneration !== rawGeneration
    ) return failedMonitor('The headphone monitor generation is no longer active.', 'invalid-generation', rawGeneration)
    const binding = this.native()
    if (!binding) return failedMonitor(this.loadError ?? 'Native audio host unavailable', 'host-failure', rawGeneration)
    try {
      const result = binding.endMonitor(generation)
      if (!validMonitorResult(result, 'end', rawGeneration)) {
        return failedMonitor('Native headphone monitoring returned an invalid stop response.', 'host-failure', rawGeneration)
      }
      if (result.ok) {
        this.monitorGeneration = ''
        this.monitorRendererId = null
      }
      return result
    } catch (error) {
      return failedMonitor(`Native headphone monitoring failed to stop: ${String(error)}`, 'host-failure', rawGeneration)
    }
  }

  playbackProviders(platform: NodeJS.Platform = process.platform): DesktopPlaybackProviderInfo[] {
    const fallback: DesktopPlaybackProviderInfo[] = [
      {
        id: 'coreaudio',
        label: 'CoreAudio',
        available: platform === 'darwin',
        errorCode: platform === 'darwin' ? 'none' : 'wrong-platform',
        detail: platform === 'darwin' ? 'Native macOS AudioHost output' : 'Available only on macOS'
      },
      {
        id: 'wasapi',
        label: 'WASAPI',
        available: platform === 'win32',
        errorCode: platform === 'win32' ? 'none' : 'wrong-platform',
        detail: platform === 'win32' ? 'Native Windows AudioHost output' : 'Available only on Windows'
      },
      {
        id: 'asio',
        label: 'ASIO',
        available: false,
        errorCode: platform === 'win32' ? 'not-compiled' : 'wrong-platform',
        detail: platform === 'win32'
          ? 'The separately licensed Steinberg ASIO SDK/runtime is not vendored'
          : 'ASIO is a separate Windows provider and is not available on this platform.'
      }
    ]
    const binding = this.native()
    if (!binding) return fallback
    try {
      const native = binding.audioHostProviders()
      if (!Array.isArray(native)) return fallback
      const validCodes = new Set([
        'none', 'not-compiled', 'runtime-unavailable', 'platform-not-ready', 'wrong-platform'
      ])
      const valid = native.every((row) => row &&
        (row.id === 'coreaudio' || row.id === 'wasapi' || row.id === 'asio') &&
        typeof row.label === 'string' && typeof row.available === 'boolean' &&
        validCodes.has(row.errorCode) && typeof row.detail === 'string')
      if (!valid) return fallback
      return fallback.map((row) => row.errorCode === 'wrong-platform'
        ? row
        : native.find((candidate) => candidate.id === row.id) ?? row)
    } catch {
      return fallback
    }
  }

  playbackCapability(): DesktopPlaybackRuntimeCapability {
    const unavailable = (): DesktopPlaybackRuntimeCapability => ({
      available: false,
      playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
      mediaCodec: {
        abiVersion: 1,
        formatMask: DESKTOP_PLAYBACK_CODEC_BASE_MASK,
        dynamicallyLinkedFfmpeg: false,
        runtimeVersion: '',
        capabilityTag: DESKTOP_PLAYBACK_CODEC_BASE_TAG,
        profile: '',
        target: '',
        extensions: [...DESKTOP_PLAYBACK_CODEC_BASE_EXTENSIONS]
      }
    })
    const binding = this.native()
    if (!binding) return unavailable()
    try {
      if (binding.playbackStatus().capability !== DESKTOP_PLAYBACK_CAPABILITY) return unavailable()
    } catch {
      return unavailable()
    }
    const runtime = this.injectedCodecRuntime ?? codecRuntimeByBinding.get(binding)
    if (!isFullPlaybackCodecRuntime(runtime)) {
      return { ...unavailable(), available: true }
    }
    const packBinding = runtime.packManifestSha256 ??
      runtime.sourcePackManifestSha256?.join('+') ?? ''
    return {
      available: true,
      playbackCapability: DESKTOP_PLAYBACK_CAPABILITY,
      mediaCodec: {
        abiVersion: 1,
        formatMask: DESKTOP_PLAYBACK_CODEC_FULL_MASK,
        dynamicallyLinkedFfmpeg: true,
        runtimeVersion: packBinding,
        capabilityTag: DESKTOP_PLAYBACK_CODEC_FULL_TAG,
        profile: DESKTOP_PLAYBACK_CODEC_PROFILE,
        target: runtime.target,
        extensions: [...DESKTOP_PLAYBACK_CODEC_FULL_EXTENSIONS]
      }
    }
  }

  preparePlayback(
    rendererId: number,
    config: DesktopPlaybackPrepareConfig,
    lanes: DesktopPlaybackLaneConfig[],
    platform: NodeJS.Platform = process.platform
  ): DesktopPlaybackResult {
    // Every refusal below is an answer to "why did this song end up on Web
    // Audio?" — the renderer's fallback is deliberately silent, so the reason
    // has to be written down here or it is written down nowhere.
    const refused = (...args: Parameters<typeof failedPlayback>): DesktopPlaybackResult => {
      const result = failedPlayback(...args)
      log('dsp', `graph refused · ${result.errorCode} · ${result.error}`, 'warn')
      return result
    }
    // A SEAM names the running generation it replaces (the core prepares the
    // candidate on that generation's stream and retires the old graph
    // itself): the one prepare that is allowed while a player is active, and
    // only from the renderer that owns it. Anything else is still busy.
    const seam = config.swapFromGeneration !== undefined && config.swapFromGeneration !== '0'
    const seamOfOwn = seam && this.playbackGeneration !== '' &&
      config.swapFromGeneration === this.playbackGeneration && this.playbackRendererId === rendererId
    if (this.playbackGeneration && !seamOfOwn) {
      return refused(
        'Unload the active native player before preparing another.',
        'native-audio-busy',
        this.playbackGeneration
      )
    }
    if (seam && !seamOfOwn) {
      return refused(
        'A native playback seam must name the active generation.',
        'invalid-generation'
      )
    }
    if (
      config.capability !== DESKTOP_PLAYBACK_CAPABILITY ||
      config.playback?.version !== DESKTOP_PLAYBACK_CONTRACT_VERSION ||
      config.accessMode !== (config.provider === 'asio' ? 'exclusive' : 'shared')
    ) {
      return refused(
        'The desktop native playback contract is not the current strict version.',
        'invalid-configuration'
      )
    }
    const provider = this.playbackProviders(platform).find((row) => row.id === config.provider)
    if (!provider?.available) {
      return refused(
        provider?.detail ?? 'The requested native playback provider is invalid.',
        provider && provider.errorCode !== 'wrong-platform'
          ? 'platform-not-ready'
          : 'invalid-configuration'
      )
    }
    if (this.playbackHighWater >= BigInt(Number.MAX_SAFE_INTEGER)) {
      return refused('The native playback generation range is exhausted.', 'invalid-generation')
    }
    const binding = this.native()
    if (!binding) return refused(this.loadError ?? 'Native playback unavailable')
    const codec = this.playbackCapability()
    if (lanes.some((lane) => !playbackCodecSupportsPath(codec, lane.path))) {
      return refused(
        'A native playback lane is not supported by the proven decoder runtime.',
        'invalid-configuration'
      )
    }
    try {
      if (binding.playbackStatus().capability !== DESKTOP_PLAYBACK_CAPABILITY) {
        return refused(
          'The loaded native playback addon does not implement the current capability.',
          'platform-not-ready'
        )
      }
    } catch (error) {
      return refused(
        `Could not verify the native playback capability: ${String(error)}`,
        'host-failure'
      )
    }
    const generation = ++this.playbackHighWater
    const rawGeneration = generation.toString()
    try {
      // Generations cross into the addon as BigInt, never as the strings the
      // renderer carries (its `exactU64` takes a bigint or a number); the
      // seam's field is a generation like any other.
      const nativeConfig = {
        ...(seamOfOwn
          ? { ...config, swapFromGeneration: BigInt(config.swapFromGeneration!) as unknown as string }
          : config),
        masterGain: mutedMasterGain(config.masterGain)
      }
      log(
        'dsp',
        `preparing graph · generation ${rawGeneration} · ${lanes.length} lanes · ` +
          `${config.sampleRate} Hz · ${config.bufferFrames} frames` +
          (seamOfOwn ? ` · seam from ${config.swapFromGeneration}` : ' · fresh start')
      )
      const preparedAt = Date.now()
      const result = binding.preparePlayback(nativeConfig, lanes, generation)
      if (result.ok)
        log(
          'dsp',
          `graph ready · generation ${result.generation} · ${Date.now() - preparedAt} ms · ` +
            `${result.format.sampleRate} Hz · ${result.format.nominalBufferFrames} frames · ` +
            `${result.format.outputChannels} out · ` +
            `${result.latency.outputDeviceFrames + result.latency.bufferFrames} frames of output latency`
        )
      else
        log(
          'dsp',
          `graph build refused · generation ${rawGeneration} · ${result.errorCode} · ${result.error}`,
          'warn'
        )
      // Once the native session claims a generation, even a decode/graph
      // failure owns a cleanup receipt. Retain it until exact unload proves
      // every graph/host/quarantine domain empty. A seam that took moves the
      // active generation forward the same way: the old one is the core's to
      // retire, and no unload for it will ever arrive from the renderer. A
      // seam the core refused leaves the running generation exactly as it
      // was (the candidate's claim is spent, nothing of it exists).
      if (result.generation === rawGeneration && result.ownershipRetained === true) {
        this.playbackGeneration = rawGeneration
        this.playbackRendererId = rendererId
      }
      return result
    } catch (error) {
      log('dsp', `graph build threw · generation ${rawGeneration} · ${String(error)}`, 'error')
      return failedPlayback(`Native playback prepare failed: ${String(error)}`, 'host-failure', rawGeneration)
    }
  }

  /**
   * Every native playback command but prepare goes through here, which makes
   * it the one place that can say what the core was asked to do.
   *
   * `loud` commands are logged either way: they are the shape of a session —
   * open, start, stop, unload — and there are a handful per song. The rest
   * (seek, pause, resume, gain, loop) are logged only when they FAIL, because
   * one scrub is dozens of seeks and a log nobody can read is a log nobody
   * reads. Status is not routed through here at all: it is polled at 5 Hz.
   */
  private playbackCommand(
    rendererId: number,
    rawGeneration: string,
    invoke: (binding: NativeCaptureBinding, generation: bigint) => DesktopPlaybackResult,
    name: string,
    loud = false
  ): DesktopPlaybackResult {
    const generation = parseGeneration(rawGeneration)
    if (!generation || this.playbackRendererId !== rendererId || this.playbackGeneration !== rawGeneration) {
      // An UNLOAD of a generation that is not the active one is the ordinary
      // shape of a refused seam: the renderer unloads the spent candidate, and
      // main declines because it never moved to it. Nothing is wrong, so it is
      // not a warning — the refusal itself already printed one.
      log(
        'dsp',
        `${name} refused · generation ${rawGeneration} is not the active one ` +
          `(active ${this.playbackGeneration || 'none'})`,
        name === 'unload' ? 'info' : 'warn'
      )
      return failedPlayback(
        'The native playback generation is no longer active.',
        'invalid-generation',
        rawGeneration
      )
    }
    const binding = this.native()
    if (!binding) {
      log('dsp', `${name} refused · no native binding · ${this.loadError ?? 'unavailable'}`, 'warn')
      return failedPlayback(this.loadError ?? 'Native playback unavailable', 'host-failure', rawGeneration)
    }
    try {
      const result = invoke(binding, generation)
      if (!result.ok)
        log(
          'dsp',
          `${name} failed · generation ${rawGeneration} · ${result.errorCode} · ${result.error}`,
          'warn'
        )
      else if (loud) log('dsp', `${name} · generation ${rawGeneration} · ${result.state}`)
      return result
    } catch (error) {
      log('dsp', `${name} threw · generation ${rawGeneration} · ${String(error)}`, 'error')
      return failedPlayback(`Native playback command failed: ${String(error)}`, 'host-failure', rawGeneration)
    }
  }

  openPlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.openPlaybackOutput(value), 'open output', true)
  }

  startPlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.startPlayback(value), 'start', true)
  }

  pausePlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.pausePlayback(value), 'pause', true)
  }

  resumePlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.resumePlayback(value), 'resume', true)
  }

  stopPlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.stopPlayback(value), 'stop', true)
  }

  seekPlayback(rendererId: number, generation: string, frame: number): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.seekPlayback(value, frame), 'seek')
  }

  setPlaybackLoop(
    rendererId: number,
    generation: string,
    startFrame: number,
    endFrame: number
  ): DesktopPlaybackResult {
    return this.playbackCommand(rendererId, generation, (binding, value) =>
      binding.setPlaybackLoop(value, startFrame, endFrame), 'set loop')
  }

  clearPlaybackLoop(rendererId: number, generation: string): DesktopPlaybackResult {
    return this.playbackCommand(
      rendererId, generation, (binding, value) => binding.clearPlaybackLoop(value), 'clear loop')
  }

  reanchorPlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    // The only lifecycle command whose caller is not a person: the renderer
    // re-anchors whenever the render-failure count rose since the last status,
    // and it re-baselines that count every poll — so a callback failing every
    // block asks for one five times a second. The first per generation is the
    // interesting one; after that a line every ten seconds carries the count,
    // which is the signal anyway, and the ring still holds the fault that
    // started it.
    const now = Date.now()
    const first = this.reanchorGeneration !== generation
    if (first) {
      this.reanchorGeneration = generation
      this.reanchorCount = 0
      this.reanchorLoggedAt = 0
    }
    this.reanchorCount += 1
    const due = first || now - this.reanchorLoggedAt >= REANCHOR_LOG_INTERVAL_MS
    if (due) this.reanchorLoggedAt = now
    const result = this.playbackCommand(
      rendererId, generation, (binding, value) => binding.reanchorPlayback(value), 'reanchor', false)
    if (result.ok && due)
      log(
        'dsp',
        `reanchor · generation ${generation} · ${result.state}` +
          (this.reanchorCount > 1 ? ` · ${this.reanchorCount} so far` : '')
      )
    return result
  }

  setPlaybackLane(
    rendererId: number,
    generation: string,
    id: string,
    gain: number,
    muted: boolean,
    solo: boolean
  ): DesktopPlaybackResult {
    return this.playbackCommand(rendererId, generation, (binding, value) =>
      binding.setPlaybackLane(value, id, gain, muted, solo), 'set lane')
  }

  setPlaybackMasterGain(rendererId: number, generation: string, gain: number): DesktopPlaybackResult {
    return this.playbackCommand(rendererId, generation, (binding, value) =>
      binding.setPlaybackMasterGain(value, mutedMasterGain(gain)), 'master gain')
  }

  playbackStatus(): DesktopPlaybackStatus | null {
    try {
      const status = this.native()?.playbackStatus() ?? null
      return status?.capability === DESKTOP_PLAYBACK_CAPABILITY ? status : null
    } catch {
      return null
    }
  }

  unloadPlayback(rendererId: number, generation: string): DesktopPlaybackResult {
    const result = this.playbackCommand(
      rendererId,
      generation,
      (binding, value) => binding.unloadPlayback(value),
      'unload',
      true
    )
    // The one command whose PARTIAL success matters: an unload that returns ok
    // without a cleanup receipt has left the core holding audio, and on the
    // desktop that is hundreds of megabytes per song sitting there unnamed.
    if (result.ok && !result.cleanupComplete)
      log(
        'dsp',
        `unload incomplete · generation ${generation} · ` +
          `${result.retainedBytes ?? 'unknown'} bytes still held`,
        'warn'
      )
    if (result.ok && result.cleanupComplete) {
      this.playbackGeneration = ''
      this.playbackRendererId = null
    }
    return result
  }

  begin(
    rendererId: number,
    config: { deviceUid?: string; inputChannel: number; ringBlocks?: number },
    rawGeneration: string,
    emit: (window: CaptureAnalysisWindow) => void
  ): CaptureStartResult {
    const generation = parseGeneration(rawGeneration)
    if (!generation || !Number.isInteger(config.inputChannel) || config.inputChannel < 0) {
      return failedStart('Invalid microphone ownership generation or input channel.', 0)
    }
    const binding = this.native()
    if (!binding) {
      return {
        ok: false,
        state: 'unsupported',
        error: this.loadError ?? 'Native capture unavailable',
        sampleRate: 0,
        inputChannel: config.inputChannel,
        deviceUid: config.deviceUid ?? '',
        deviceLabel: '',
        deviceChannels: 0,
        sampleFormat: '',
        sharingMode: '',
        performanceMode: '',
        timestampSource: ''
      }
    }
    let exactConfig = config
    if (!config.deviceUid) {
      const inventory = binding.inputDevices()
      const defaultDevice = inventory.ok
        ? inventory.devices.find((device) => device.isDefault)
        : undefined
      if (!defaultDevice) {
        return {
          ok: false,
          state: 'error',
          error: inventory.ok ? 'No system-default microphone is available.' : inventory.error,
          sampleRate: 0,
          inputChannel: config.inputChannel,
          deviceUid: '',
          deviceLabel: '',
          deviceChannels: 0,
          sampleFormat: '',
          sharingMode: '',
          performanceMode: '',
          timestampSource: ''
        }
      }
      exactConfig = { ...config, deviceUid: defaultDevice.uid }
    }
    if (this.generation) binding.cancelCapture(BigInt(this.generation))
    this.generation = rawGeneration
    this.rendererId = rendererId
    let rawResult: unknown
    try {
      rawResult = binding.beginCapture(exactConfig, generation, (window) => {
        if (this.generation === window.ownershipGeneration && this.rendererId === rendererId) emit(window)
      })
    } catch (error) {
      try { binding.cancelCapture(generation) } catch { /* rollback is best-effort after bridge failure */ }
      this.generation = ''
      this.rendererId = null
      return failedStart(
        `Native microphone start failed: ${String(error)}`,
        exactConfig.inputChannel,
        exactConfig.deviceUid
      )
    }
    if (!validStartResult(rawResult)) {
      try { binding.cancelCapture(generation) } catch { /* malformed bridge may fail cancellation too */ }
      this.generation = ''
      this.rendererId = null
      return failedStart(
        'Native microphone start returned an invalid response.',
        exactConfig.inputChannel,
        exactConfig.deviceUid
      )
    }
    const result = rawResult
    if (!result.ok) {
      this.generation = ''
      this.rendererId = null
    }
    return result
  }

  cancel(rendererId: number, rawGeneration: string): { ok: true; cancelled: boolean } | { ok: false; error: string } {
    const generation = parseGeneration(rawGeneration)
    if (!generation) return { ok: false, error: 'Invalid microphone ownership generation.' }
    if (this.rendererId !== rendererId || this.generation !== rawGeneration) {
      return { ok: true, cancelled: false }
    }
    const binding = this.native()
    if (!binding) return { ok: false, error: this.loadError ?? 'Native capture unavailable' }
    const result = binding.cancelCapture(generation)
    if (result.cancelled) {
      this.generation = ''
      this.rendererId = null
    }
    return result
  }

  rendererGone(rendererId: number): void {
    if (
      rendererId === this.rendererId || rendererId === this.monitorRendererId ||
      rendererId === this.playbackRendererId
    ) this.stop()
  }

  /** True once per webContents lifetime, so restarts/reloads add no listeners. */
  bindRendererCleanup(rendererId: number): boolean {
    if (this.cleanupRenderers.has(rendererId)) return false
    this.cleanupRenderers.add(rendererId)
    return true
  }

  stop(): void {
    if (this.playbackGeneration && this.binding) {
      try {
        const result = this.binding.unloadPlayback(BigInt(this.playbackGeneration))
        if (result.ok && result.cleanupComplete) {
          this.playbackGeneration = ''
          this.playbackRendererId = null
        }
      } catch { /* addon cleanup hook remains the final fail-closed owner */ }
    }
    if (this.monitorGeneration && this.binding) {
      try {
        const result = this.binding.endMonitor(BigInt(this.monitorGeneration))
        if (validMonitorResult(result, 'end', this.monitorGeneration) && result.ok) {
          this.monitorGeneration = ''
          this.monitorRendererId = null
        }
      } catch { /* addon environment cleanup is the final fail-closed owner */ }
    }
    if (this.generation && this.binding) {
      try {
        this.binding.cancelCapture(BigInt(this.generation))
        this.generation = ''
        this.rendererId = null
      } catch { /* process teardown cannot safely retry a thrown bridge */ }
    }
  }

  state(): { state: CaptureStateName; ownershipGeneration: string; error: string } {
    return this.native()?.captureState() ?? {
      state: 'unsupported',
      ownershipGeneration: '',
      error: this.loadError ?? 'Native capture unavailable'
    }
  }

  stats(): CaptureStats {
    return this.native()?.captureStats() ?? {
      deliveredBlocks: '0',
      deliveredFrames: '0',
      overruns: '0',
      deliveryWakeups: '0',
      droppedEvents: '0',
      overwrittenWindows: '0'
    }
  }
}
