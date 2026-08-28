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
import { join, relative, resolve } from 'node:path'
import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult,
  DesktopMonitorConfig,
  DesktopMonitorFormat,
  DesktopMonitorLatency,
  DesktopMonitorResult,
  DesktopMonitorStatus,
  CaptureAnalysisWindow,
  CaptureInputDevice,
  CaptureStartResult,
  CaptureStateName,
  CaptureStats
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
  audioHostDevices(): Omit<DesktopAudioHostInventoryResult, 'platform'>
  beginMonitor(config: DesktopMonitorConfig, generation: bigint): DesktopMonitorResult
  setMonitorGain(generation: bigint, gainDb: number, enabled: boolean): DesktopMonitorResult
  monitorStatus(): DesktopMonitorStatus
  endMonitor(generation: bigint): DesktopMonitorResult
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
  for (const dir of ['native/electron', 'zcore', 'zdsp', 'third_party/native', 'cmake']) {
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
}

function parseCaptureManifest(path: string): CaptureArtifactManifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<CaptureArtifactManifest>
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
    value.addon !== 'singz-capture.node'
  ) {
    throw new Error(`Invalid capture artifact manifest: ${path}`)
  }
  return value as CaptureArtifactManifest
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
  stageArtifactForLoad?: (bytes: Uint8Array) => StagedCaptureArtifact
}

export interface StagedCaptureArtifact {
  path: string
  cleanup: () => void
}

const CAPTURE_LOAD_PREFIX = 'singz-capture-load-'
const CAPTURE_LOAD_STALE_MS = 24 * 60 * 60 * 1000

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
export function stageArtifactForLoad(bytes: Uint8Array): StagedCaptureArtifact {
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
  try {
    writeFileSync(path, expected, { flag: 'wx', mode: 0o500 })
    chmodSync(path, 0o500)
    const staged = readFileSync(path)
    if (!staged.equals(expected)) throw new Error('Private capture-addon staging changed artifact bytes')
  } catch (error) {
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* best effort */ }
    throw error
  }
  return {
    path,
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
    'audioHostDevices', 'beginMonitor', 'setMonitorGain', 'monitorStatus', 'endMonitor'
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
    staged = (runtime.stageArtifactForLoad ?? stageArtifactForLoad)(artifactBytes)
    const actualChecksum = createHash('sha256').update(artifactBytes).digest('hex')
    if (actualChecksum !== publishedChecksum) {
      const acceptsSignedMutation =
        runtime.integrityMode === 'packaged-signed-mac' &&
        runtime.verifySignedMacArtifact?.(staged.path) === true &&
        /^[0-9a-f]{64}$/.test(runtime.expectedMachCanonicalSha256 ?? '') &&
        runtime.canonicalMacDigest?.(staged.path) === runtime.expectedMachCanonicalSha256
      if (!acceptsSignedMutation) throw new Error('artifact bytes fail their checksum')
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
    return validateCaptureBindingIdentity(binding, runtime.electronVersion, runtime.expectedSourceStamp)
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
    parameterOverflows: 0,
    nonFiniteSamples: 0,
    rejectedBlocks: 0
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
    exactUnsigned(row.adapterLastStatusCode) && exactUnsigned(row.parameterOverflows) &&
    exactUnsigned(row.nonFiniteSamples) && exactUnsigned(row.rejectedBlocks)
}

function validHostDevice(value: unknown): value is DesktopAudioHostDevice {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const buffers = row.bufferFrames as Record<string, unknown> | undefined
  return typeof row.uid === 'string' && row.uid.length > 0 && row.uid.length <= 4096 &&
    typeof row.label === 'string' && row.label.length <= 4096 &&
    typeof row.defaultInput === 'boolean' && typeof row.defaultOutput === 'boolean' &&
    exactUnsigned(row.inputChannels) && exactUnsigned(row.outputChannels) &&
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
  private generation = ''
  private rendererId: number | null = null
  private monitorGeneration = ''
  private monitorRendererId: number | null = null
  private monitorHighWater = 0n
  private cleanupRenderers = new Set<number>()

  constructor(
    binding?: NativeCaptureBinding,
    private readonly bindingLoader: () => NativeCaptureBinding = loadCaptureBinding
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
    } catch (error) {
      // Only a failure before native module initialization is retryable. If
      // require() returned an incompatible binding, Node cached that .node by
      // filename; retrying would return the same object and falsely imply a
      // rebuild can hot-replace it without restarting Electron.
      this.loadRetryable = error instanceof CaptureAddonLoadError && error.retryable
      this.loadError = `Native microphone support is unavailable: ${String(error)}`
    }
    return this.binding
  }

  devices(): { ok: true; devices: CaptureInputDevice[] } | { ok: false; devices: []; error: string } {
    const binding = this.native()
    if (!binding) return { ok: false, devices: [], error: this.loadError ?? 'Native capture unavailable' }
    return binding.inputDevices()
  }

  hostDevices(platform: NodeJS.Platform = process.platform): DesktopAudioHostInventoryResult {
    const exposedPlatform = platform === 'darwin' || platform === 'win32' || platform === 'linux'
      ? platform
      : 'other'
    const binding = this.native()
    if (!binding) {
      return {
        ok: false,
        platform: exposedPlatform,
        defaultInputUid: '',
        defaultOutputUid: '',
        devices: [],
        error: this.loadError ?? 'Native audio host unavailable'
      }
    }
    try {
      const raw = binding.audioHostDevices() as {
        ok?: unknown
        defaultInputUid?: unknown
        defaultOutputUid?: unknown
        devices?: unknown
        error?: unknown
      }
      if (
        raw.ok !== true || typeof raw.defaultInputUid !== 'string' ||
        typeof raw.defaultOutputUid !== 'string' || !Array.isArray(raw.devices) ||
        !raw.devices.every(validHostDevice)
      ) {
        return {
          ok: false,
          platform: exposedPlatform,
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
        defaultInputUid: raw.defaultInputUid,
        defaultOutputUid: raw.defaultOutputUid,
        devices: raw.devices
      }
    } catch (error) {
      return {
        ok: false,
        platform: exposedPlatform,
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
    if (rendererId === this.rendererId || rendererId === this.monitorRendererId) this.stop()
  }

  /** True once per webContents lifetime, so restarts/reloads add no listeners. */
  bindRendererCleanup(rendererId: number): boolean {
    if (this.cleanupRenderers.has(rendererId)) return false
    this.cleanupRenderers.add(rendererId)
    return true
  }

  stop(): void {
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
