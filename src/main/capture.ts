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
    if (rendererId === this.rendererId) this.stop()
  }

  /** True once per webContents lifetime, so restarts/reloads add no listeners. */
  bindRendererCleanup(rendererId: number): boolean {
    if (this.cleanupRenderers.has(rendererId)) return false
    this.cleanupRenderers.add(rendererId)
    return true
  }

  stop(): void {
    if (!this.generation || !this.binding) return
    this.binding.cancelCapture(BigInt(this.generation))
    this.generation = ''
    this.rendererId = null
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
