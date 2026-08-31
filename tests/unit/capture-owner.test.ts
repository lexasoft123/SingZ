import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CaptureAddonLoadError,
  CaptureOwner,
  captureAddonManifestPath,
  captureIntegrityMode,
  loadCaptureBindingWith,
  pruneStaleCaptureLoadDirs,
  resolveCaptureAddonPath,
  stageArtifactForLoad,
  type NativeCaptureBinding
} from '../../src/main/capture'
import type {
  CaptureAnalysisWindow,
  CaptureStartResult,
  DesktopMonitorResult,
  DesktopMonitorStatus
} from '../../src/shared/types'

const startResult: CaptureStartResult = {
  ok: true,
  state: 'running',
  sampleRate: 48000,
  inputChannel: 2,
  deviceUid: 'fixture:24',
  deviceLabel: 'Fixture interface',
  deviceChannels: 24,
  sampleFormat: 'float32',
  sharingMode: 'shared',
  performanceMode: 'low-latency',
  timestampSource: 'hardware'
}

const analysisWindow = (generation: string): CaptureAnalysisWindow => ({
  ownershipGeneration: generation,
  resetCount: '0',
  resetReason: 'none',
  start: {
    clockDomainId: '1', streamGeneration: '1', sequence: '1', sourceFrame: '0',
    sampleHostTimeNs: '1', callbackHostTimeNs: '2', quality: 'hardware',
    discontinuity: 'none', flags: 15
  },
  end: {
    clockDomainId: '1', streamGeneration: '1', sequence: '1', sourceFrame: '2048',
    sampleHostTimeNs: '3', callbackHostTimeNs: '4', quality: 'hardware',
    discontinuity: 'none', flags: 15
  },
  deliveredAtNs: '5', bridgeHostTimeNs: '6', callbackToBridgeMs: 0.001,
  sampleRate: 48000, frequency: 220, clarity: 0.99,
  peak: 0.5, rms: 0.25, dbfs: -12
})

const monitorResult = (generation = '1', ok = true): DesktopMonitorResult => {
  const common = {
    ownershipGeneration: generation,
    state: ok ? 'running' as const : 'error' as const,
    format: {
    sampleRate: 48000, maximumFrames: 512, nominalBufferFrames: 128,
    inputChannels: 1, outputChannels: 2, sampleFormat: 'float32-planar',
    outputClockMaster: true, accessMode: 'shared'
    } as const,
    latency: { inputDeviceFrames: 32, outputDeviceFrames: 48, bufferFrames: 128, externalRouteFrames: 0 }
  }
  return ok
    ? { ...common, ok: true, errorCode: 'none', error: '' }
    : { ...common, ok: false, errorCode: 'host-failure', error: 'fixture failure' }
}

const monitorEndResult = (generation = '1'): DesktopMonitorResult => ({
  ...monitorResult(generation),
  state: 'stopped'
})

const monitorStatus = (generation = '0', active = false): DesktopMonitorStatus => ({
  active,
  enabled: active,
  deviceLost: false,
  ownershipGeneration: generation,
  gainDb: -12,
  state: active ? 'running' : 'closed',
  error: '',
  pre: { peak: 0, rms: 0, frames: '0' },
  post: { peak: 0, rms: 0, frames: '0' },
  format: monitorResult(generation).format,
  latency: monitorResult(generation).latency,
  routeGeneration: '0', streamGeneration: '0', callbacks: '0', renderedFrames: '0',
  xruns: '0', deadlineMisses: '0', renderFailures: '0', adapterRenderFailures: 0,
  terminalRenderFailures: 0, adapterLastStatusCode: 0, parameterOverflows: 0,
  nonFiniteSamples: 0, rejectedBlocks: 0
})

function fakeBinding(): NativeCaptureBinding & {
  sink?: (window: CaptureAnalysisWindow) => void
  cancelled: bigint[]
  endedMonitors: bigint[]
  activeMonitorGeneration?: string
} {
  return {
    cancelled: [],
    endedMonitors: [],
    buildInfo: { electronVersion: 'test', sourceStamp: 'test' },
    inputDevices: () => ({
      ok: true,
      devices: [{
        uid: 'fixture:24', label: 'Fixture interface', isDefault: true,
        sampleRate: 48000, channels: 24,
        channelLabels: Array.from({ length: 24 }, (_, i) => `Channel ${i + 1}`)
      }]
    }),
    beginCapture(_config, _generation, sink) {
      this.sink = sink
      return startResult
    },
    cancelCapture(generation) {
      this.cancelled.push(generation)
      return { ok: true, cancelled: true }
    },
    captureState: () => ({ state: 'running', ownershipGeneration: '1', error: '' }),
    captureStats: () => ({
      deliveredBlocks: '1', deliveredFrames: '128', overruns: '0',
      deliveryWakeups: '1', droppedEvents: '0', overwrittenWindows: '0'
    }),
    audioHostDevices: () => ({
      ok: true,
      defaultInputUid: 'fixture:24',
      defaultOutputUid: 'fixture:24',
      devices: [{
        uid: 'fixture:24', label: 'Fixture interface', defaultInput: true,
        defaultOutput: true, inputChannels: 24, outputChannels: 2,
        inputChannelLabels: Array.from({ length: 24 }, (_, i) => `Input ${i + 1}`),
        outputChannelLabels: ['Phones L', 'Phones R'],
        nominalSampleRate: 48000, direction: 'duplex', accessMode: 'shared',
        transport: 'usb', monitoringSuitability: 'low-latency',
        sampleRateRanges: [{ minimumHz: 48000, maximumHz: 48000 }],
        bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 }
      }]
    }),
    beginMonitor(_config, generation) {
      this.activeMonitorGeneration = generation.toString()
      return monitorResult(generation.toString())
    },
    setMonitorGain(generation) {
      return monitorResult(generation.toString())
    },
    monitorStatus() {
      return monitorStatus(this.activeMonitorGeneration ?? '0', Boolean(this.activeMonitorGeneration))
    },
    endMonitor(generation) {
      this.endedMonitors.push(generation)
      this.activeMonitorGeneration = undefined
      return monitorEndResult(generation.toString())
    }
  }
}

describe('CaptureOwner', () => {
  it('permits signed-byte mutation only for the default packaged mac addon', () => {
    expect(captureIntegrityMode(true, 'darwin')).toBe('packaged-signed-mac')
    expect(captureIntegrityMode(false, 'darwin')).toBe('exact')
    expect(captureIntegrityMode(true, 'win32')).toBe('exact')
    expect(captureIntegrityMode(true, 'darwin', '/diagnostics/override.node')).toBe('exact')
  })

  it('isolates development addons by checkout and expected source fingerprint', () => {
    const runtime = {
      packaged: false,
      resourcesPath: '/Applications/SingZ.app/Contents/Resources',
      cwd: '/checkout',
      platform: 'darwin' as const,
      arch: 'arm64',
      expectedSourceStamp: 'a'.repeat(40),
      expectedArtifactSha256: '1'.repeat(64),
      generation: 'generation-a'
    }
    // join() uses the host separator — normalize so the assertion holds on
    // the Windows E2E runner too.
    const posix = (p: string): string => p.replaceAll('\\', '/')
    expect(posix(resolveCaptureAddonPath(runtime))).toBe(
      `/checkout/build/capture-runtime/darwin-arm64/${'a'.repeat(40)}/${'1'.repeat(64)}/` +
      'generation-a/singz-capture.node'
    )
    expect(resolveCaptureAddonPath({ ...runtime, cwd: '/other-checkout' })).not.toBe(
      resolveCaptureAddonPath(runtime)
    )
    expect(resolveCaptureAddonPath({ ...runtime, expectedSourceStamp: 'b'.repeat(40) })).not.toBe(
      resolveCaptureAddonPath(runtime)
    )
    expect(resolveCaptureAddonPath({ ...runtime, expectedArtifactSha256: '2'.repeat(64) })).not.toBe(
      resolveCaptureAddonPath(runtime)
    )
    expect(resolveCaptureAddonPath({ ...runtime, generation: 'generation-b' })).not.toBe(
      resolveCaptureAddonPath(runtime)
    )
    expect(posix(resolveCaptureAddonPath({ ...runtime, packaged: true }))).toBe(
      '/Applications/SingZ.app/Contents/Resources/engines/singz-capture.node'
    )
    expect(resolveCaptureAddonPath({ ...runtime, envOverride: './fixture.node' })).toBe(
      resolve('./fixture.node')
    )
    expect(captureAddonManifestPath('/diagnostics/override.node').replaceAll('\\', '/')).toBe(
      '/diagnostics/singz-capture.manifest.json'
    )
  })

  const artifact = new Uint8Array([1, 2, 3, 4])
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
  const canonicalSha256 = 'c'.repeat(64)
  const sourceStamp = 'a'.repeat(40)
  const loaderRuntime = (binding: NativeCaptureBinding) => ({
    addonPath:
      `/checkout/build/capture-runtime/darwin-arm64/${sourceStamp}/${artifactSha256}/` +
      'generation-a/singz-capture.node',
    electronVersion: '43.2.0',
    expectedSourceStamp: sourceStamp,
    expectedArtifactSha256: artifactSha256,
    expectedMachCanonicalSha256: canonicalSha256,
    readText: (path: string) => path.endsWith('.source-hash') ? sourceStamp : artifactSha256,
    readArtifact: () => artifact,
    canonicalMacDigest: () => canonicalSha256,
    loadAddon: () => binding,
    stageArtifactForLoad: (bytes: Uint8Array) => ({
      path: `/private/staged-${createHash('sha1').update(bytes).digest('hex')}.node`,
      cleanup: () => undefined
    })
  })

  it('stages exact bytes at unique private paths and cleans only on request', () => {
    const first = stageArtifactForLoad(artifact)
    const second = stageArtifactForLoad(artifact)
    try {
      expect(first.path).not.toBe(second.path)
      expect(first.path.endsWith('.node')).toBe(true)
      expect(readFileSync(first.path)).toEqual(Buffer.from(artifact))
      if (process.platform !== 'win32') {
        expect(statSync(first.path).mode & 0o777).toBe(0o500)
      }
    } finally {
      first.cleanup()
      second.cleanup()
    }
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(false)
  })

  it('prunes only old confirmed-dead load dirs and preserves other live PIDs', () => {
    const base = mkdtempSync(join(tmpdir(), 'singz-load-prune-test-'))
    const live = join(base, `singz-capture-load-222-${'a'.repeat(32)}`)
    const dead = join(base, `singz-capture-load-333-${'b'.repeat(32)}`)
    const unrelated = join(base, 'singz-capture-load-not-ours')
    try {
      // Regression: the real macOS TMP had 46,929 entries and SingZ candidates
      // began around index 6,161. Unrelated entries must not consume the scan
      // cap before strict-name filtering.
      for (let index = 0; index < 300; index += 1) {
        mkdirSync(join(base, `unrelated-${index.toString().padStart(4, '0')}`))
      }
      for (const dir of [live, dead, unrelated]) mkdirSync(dir)
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
      utimesSync(live, old, old)
      utimesSync(dead, old, old)
      pruneStaleCaptureLoadDirs({
        base,
        now: Date.now(),
        isProcessLive: (pid) => pid === 222
      })
      expect(existsSync(live)).toBe(true)
      expect(existsSync(dead)).toBe(false)
      expect(existsSync(unrelated)).toBe(true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('verifies and loads only the single-read private snapshot', () => {
    const binding = fakeBinding()
    binding.buildInfo = { electronVersion: '43.2.0', sourceStamp }
    const signedBytes = new Uint8Array([9, 8, 7, 6])
    let reads = 0
    let cleanupCalls = 0
    let stagedBytes: Buffer | null = null
    const paths: string[] = []
    const seen: string[] = []
    const stage = (bytes: Uint8Array) => {
      stagedBytes = Buffer.from(bytes)
      const path = `/private/attempt-${paths.length + 1}.node`
      paths.push(path)
      return { path, cleanup: () => { cleanupCalls += 1 } }
    }
    const signed = {
      ...loaderRuntime(binding),
      readArtifact: () => { reads += 1; return signedBytes },
      stageArtifactForLoad: stage,
      integrityMode: 'packaged-signed-mac' as const,
      verifySignedMacArtifact: (path: string) => { seen.push(`signature:${path}`); return true },
      canonicalMacDigest: (path: string) => { seen.push(`canonical:${path}`); return canonicalSha256 },
      loadAddon: (path: string) => { seen.push(`load:${path}`); return binding }
    }
    expect(loadCaptureBindingWith(signed)).toBe(binding)
    expect(reads).toBe(1)
    expect(stagedBytes).toEqual(Buffer.from(signedBytes))
    expect(seen).toEqual([
      'signature:/private/attempt-1.node',
      'canonical:/private/attempt-1.node',
      'load:/private/attempt-1.node'
    ])
    expect(seen.join(' ')).not.toContain(signed.addonPath)
    expect(cleanupCalls).toBe(0)

    expect(() => loadCaptureBindingWith({
      ...signed,
      canonicalMacDigest: () => 'd'.repeat(64)
    })).toThrow(CaptureAddonLoadError)
    expect(cleanupCalls).toBe(1)
    expect(() => loadCaptureBindingWith({
      ...signed,
      loadAddon: () => { throw new Error('dlopen failed') }
    })).toThrow(CaptureAddonLoadError)
    expect(cleanupCalls).toBe(2)
    expect(new Set(paths).size).toBe(3)
  })

  it('allows an explicit override only when its evidence and compiled identity agree', () => {
    const binding = fakeBinding()
    binding.buildInfo = { electronVersion: '43.2.0', sourceStamp }
    expect(loadCaptureBindingWith({
      ...loaderRuntime(binding),
      addonPath: '/diagnostics/override.node'
    })).toBe(binding)
    expect(() => loadCaptureBindingWith({
      ...loaderRuntime(binding),
      addonPath: '/diagnostics/override.node',
      readText: (path) => path.endsWith('.source-hash') ? 'b'.repeat(40) : artifactSha256
    })).toThrow(CaptureAddonLoadError)
  })

  it('checks the published source stamp before loading native code', () => {
    let loads = 0
    let caught: unknown
    try {
      loadCaptureBindingWith({
        ...loaderRuntime(fakeBinding()),
        readText: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
        loadAddon: () => { loads += 1; return fakeBinding() }
      })
    } catch (error) {
      caught = error
    }
    expect(loads).toBe(0)
    expect(caught).toBeInstanceOf(CaptureAddonLoadError)
    expect((caught as CaptureAddonLoadError).retryable).toBe(true)
  })

  it('fails closed unless a packaged mac signature validates changed bytes', () => {
    const binding = fakeBinding()
    binding.buildInfo = { electronVersion: '43.2.0', sourceStamp }
    const signedBytes = new Uint8Array([9, 8, 7, 6])
    const transformed = {
      ...loaderRuntime(binding),
      readArtifact: () => signedBytes
    }
    expect(() => loadCaptureBindingWith({
      ...transformed,
      verifySignedMacArtifact: () => true
    })).toThrow(CaptureAddonLoadError)
    expect(() => loadCaptureBindingWith({
      ...transformed,
      integrityMode: 'packaged-signed-mac',
      verifySignedMacArtifact: () => false
    })).toThrow(CaptureAddonLoadError)
    expect(() => loadCaptureBindingWith({
      ...transformed,
      expectedMachCanonicalSha256: undefined,
      integrityMode: 'packaged-signed-mac',
      verifySignedMacArtifact: () => true
    })).toThrow(CaptureAddonLoadError)
    expect(loadCaptureBindingWith({
      ...transformed,
      integrityMode: 'packaged-signed-mac',
      verifySignedMacArtifact: () => true
    })).toBe(binding)

    const wrongBinding = fakeBinding()
    wrongBinding.buildInfo = { electronVersion: '43.2.0', sourceStamp: 'b'.repeat(40) }
    expect(() => loadCaptureBindingWith({
      ...loaderRuntime(wrongBinding),
      readArtifact: () => signedBytes,
      integrityMode: 'packaged-signed-mac',
      verifySignedMacArtifact: () => true
    })).toThrow('published source stamp')
  })

  it('rejects a loaded binding whose compiled source differs from its sidecar', () => {
    const binding = fakeBinding()
    binding.buildInfo = { electronVersion: '43.2.0', sourceStamp: 'b'.repeat(40) }
    let caught: unknown
    try {
      loadCaptureBindingWith(loaderRuntime(binding))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CaptureAddonLoadError)
    expect((caught as CaptureAddonLoadError).retryable).toBe(false)
    expect(String(caught)).toContain('Restart SingZ')
  })

  it('treats every require throw as retryable because no binding was returned', () => {
    const binding = fakeBinding()
    binding.buildInfo = { electronVersion: '43.2.0', sourceStamp }
    let caught: unknown
    try {
      loadCaptureBindingWith({
        ...loaderRuntime(binding),
        loadAddon: () => { throw Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' }) }
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(CaptureAddonLoadError)
    expect((caught as CaptureAddonLoadError).retryable).toBe(true)
  })

  it('retries only failures that happened before the native module loaded', () => {
    const binding = fakeBinding()
    let transientAttempts = 0
    const transient = new CaptureOwner(undefined, () => {
      transientAttempts += 1
      if (transientAttempts === 1) throw new CaptureAddonLoadError('not copied yet', true)
      return binding
    })
    expect(transient.devices()).toMatchObject({ ok: false })
    expect(transient.devices()).toMatchObject({ ok: true })
    expect(transientAttempts).toBe(2)

    let incompatibleAttempts = 0
    const incompatible = new CaptureOwner(undefined, () => {
      incompatibleAttempts += 1
      throw new CaptureAddonLoadError('loaded incompatible binary; restart', false)
    })
    expect(incompatible.devices()).toMatchObject({ ok: false })
    expect(incompatible.devices()).toMatchObject({ ok: false })
    expect(incompatibleAttempts).toBe(1)
  })

  it('delivers copied scalar evidence only to the current renderer generation', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    const received: CaptureAnalysisWindow[] = []
    expect(owner.begin(7, { deviceUid: 'fixture:24', inputChannel: 2 }, '1', (w) => received.push(w))).toEqual(startResult)
    binding.sink?.(analysisWindow('1'))
    binding.sink?.(analysisWindow('2'))
    expect(received.map((window) => window.frequency)).toEqual([220])
    expect(received[0]).not.toHaveProperty('pcm')
  })

  it('rejects stale cancellation and synchronously tears down the owner generation', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    owner.begin(9, { inputChannel: 0 }, '17', () => {})
    expect(owner.cancel(8, '17')).toEqual({ ok: true, cancelled: false })
    expect(owner.cancel(9, '16')).toEqual({ ok: true, cancelled: false })
    expect(owner.cancel(9, '17')).toEqual({ ok: true, cancelled: true })
    expect(binding.cancelled).toEqual([17n])
  })

  it('stops the old generation before a replacement starts', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    owner.begin(3, { inputChannel: 0 }, '41', () => {})
    owner.begin(3, { inputChannel: 1 }, '42', () => {})
    expect(binding.cancelled).toEqual([41n])
  })

  it('binds renderer destruction cleanup only once across restarts', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    expect(owner.bindRendererCleanup(3)).toBe(true)
    expect(owner.bindRendererCleanup(3)).toBe(false)
    owner.begin(3, { deviceUid: 'fixture:24', inputChannel: 2 }, '43', () => {})
    owner.rendererGone(3)
    expect(binding.cancelled).toEqual([43n])
    expect(owner.bindRendererCleanup(3)).toBe(false)
  })

  it('rolls back ownership when native begin throws or returns malformed data', () => {
    const throwing = fakeBinding()
    throwing.beginCapture = () => { throw new Error('bridge down') }
    const thrownOwner = new CaptureOwner(throwing)
    expect(thrownOwner.begin(4, { deviceUid: 'fixture:24', inputChannel: 2 }, '51', () => {})).toMatchObject({
      ok: false,
      state: 'error'
    })
    expect(throwing.cancelled).toEqual([51n])
    expect(thrownOwner.cancel(4, '51')).toEqual({ ok: true, cancelled: false })

    const malformed = fakeBinding()
    malformed.beginCapture = (() => ({ ok: true })) as NativeCaptureBinding['beginCapture']
    const malformedOwner = new CaptureOwner(malformed)
    expect(malformedOwner.begin(5, { deviceUid: 'fixture:24', inputChannel: 2 }, '52', () => {})).toMatchObject({
      ok: false,
      error: 'Native microphone start returned an invalid response.'
    })
    expect(malformed.cancelled).toEqual([52n])
    expect(malformedOwner.cancel(5, '52')).toEqual({ ok: true, cancelled: false })
  })

  it('exposes exact HAL inventory and mints monotonic monitor generations in main', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    expect(owner.hostDevices('darwin')).toMatchObject({
      ok: true,
      platform: 'darwin',
      defaultInputUid: 'fixture:24',
      devices: [{ uid: 'fixture:24', inputChannels: 24, outputChannels: 2 }]
    })
    const config = {
      inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
      inputChannels: [2], outputChannels: [0, 1], sampleRate: 48000,
      bufferFrames: 128, maximumFrames: 512, exclusive: false
    }
    const first = owner.beginMonitor(31, config)
    expect(first).toMatchObject({ ok: true, ownershipGeneration: '1' })
    expect(owner.endMonitor(99, '1')).toMatchObject({ ok: false, errorCode: 'invalid-generation' })
    expect(binding.endedMonitors).toEqual([])
    expect(owner.endMonitor(31, '1')).toMatchObject({ ok: true })
    const second = owner.beginMonitor(31, config)
    expect(second).toMatchObject({ ok: true, ownershipGeneration: '2' })
  })

  it('clears ownership after authoritative end when host cleanup leaves an error state', () => {
    const binding = fakeBinding()
    binding.endMonitor = ((generation) => ({
      ...monitorEndResult(generation.toString()),
      state: 'error'
    }))
    const owner = new CaptureOwner(binding)
    const config = {
      inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
      inputChannels: [2], outputChannels: [0, 1], sampleRate: 48000,
      bufferFrames: 128, maximumFrames: 512, exclusive: false
    }

    expect(owner.beginMonitor(32, config)).toMatchObject({ ok: true, ownershipGeneration: '1' })
    expect(owner.endMonitor(32, '1')).toMatchObject({ ok: true, state: 'error' })
    expect(owner.beginMonitor(32, config)).toMatchObject({ ok: true, ownershipGeneration: '2' })
  })

  it('stops an owned native monitor when its renderer disappears', () => {
    const binding = fakeBinding()
    const owner = new CaptureOwner(binding)
    owner.beginMonitor(44, {
      inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
      inputChannels: [0], outputChannels: [0, 1], sampleRate: 48000,
      bufferFrames: 128, maximumFrames: 512, exclusive: false
    })
    owner.rendererGone(44)
    expect(binding.endedMonitors).toEqual([1n])
  })

  it.each(['throwing', 'malformed'] as const)(
    'retains an uncertain %s begin generation until same-generation end succeeds',
    (mode) => {
      const binding = fakeBinding()
      binding.beginMonitor = mode === 'throwing'
        ? (() => { throw new Error('bridge uncertain') })
        : (() => ({ ok: true }) as DesktopMonitorResult)
      let ends = 0
      binding.endMonitor = ((generation: bigint) => {
        binding.endedMonitors.push(generation)
        ends++
        return ends === 1 ? monitorResult(generation.toString(), false) : monitorEndResult(generation.toString())
      })
      const owner = new CaptureOwner(binding)
      const begun = owner.beginMonitor(72, {
        inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
        inputChannels: [2], outputChannels: [0, 1], sampleRate: 48000,
        bufferFrames: 128, maximumFrames: 512, exclusive: false
      })
      expect(begun).toMatchObject({ ok: false, ownershipGeneration: '1' })
      expect(owner.beginMonitor(72, {
        inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
        inputChannels: [2], outputChannels: [0, 1], sampleRate: 48000,
        bufferFrames: 128, maximumFrames: 512, exclusive: false
      })).toMatchObject({ ok: false, errorCode: 'already-running' })
      expect(owner.endMonitor(72, '1')).toMatchObject({ ok: true, state: 'stopped' })
      expect(binding.endedMonitors).toEqual([1n, 1n])
    }
  )

  it('retains a failed begin when status is uncertain and rollback is not confirmed', () => {
    const binding = fakeBinding()
    binding.beginMonitor = ((_config, generation) => monitorResult(generation.toString(), false))
    binding.monitorStatus = () => { throw new Error('status bridge down') }
    let ends = 0
    binding.endMonitor = ((generation) => {
      binding.endedMonitors.push(generation)
      ends++
      return ends === 1
        ? ({ ok: true } as unknown as DesktopMonitorResult)
        : monitorEndResult(generation.toString())
    })
    const owner = new CaptureOwner(binding)
    expect(owner.beginMonitor(75, {
      inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
      inputChannels: [0], outputChannels: [0, 1], sampleRate: 48000,
      bufferFrames: 128, maximumFrames: 512, exclusive: false
    })).toMatchObject({ ok: false, ownershipGeneration: '1' })
    expect(owner.monitorStatus()).toMatchObject({
      active: true,
      ownershipGeneration: '1',
      state: 'error'
    })
    expect(owner.endMonitor(75, '1')).toMatchObject({ ok: true, state: 'stopped' })
    expect(binding.endedMonitors).toEqual([1n, 1n])
  })

  it('rejects contradictory monitor records by operation and status invariants', () => {
    const binding = fakeBinding()
    binding.beginMonitor = ((_config, generation) => ({
      ...monitorResult(generation.toString()),
      errorCode: 'host-failure'
    }) as unknown as DesktopMonitorResult)
    const owner = new CaptureOwner(binding)
    expect(owner.beginMonitor(73, {
      inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
      inputChannels: [0], outputChannels: [0, 1], sampleRate: 48000,
      bufferFrames: 128, maximumFrames: 512, exclusive: false
    })).toMatchObject({ ok: false, error: 'Native headphone monitoring returned an invalid response.' })

    const active = fakeBinding()
    const activeOwner = new CaptureOwner(active)
    expect(activeOwner.beginMonitor(74, {
      inputDeviceUid: 'fixture:24', outputDeviceUid: 'fixture:24',
      inputChannels: [0], outputChannels: [0, 1], sampleRate: 48000,
      bufferFrames: 128, maximumFrames: 512, exclusive: false
    }).ok).toBe(true)
    active.setMonitorGain = ((generation) => ({
      ...monitorResult(generation.toString()), ownershipGeneration: '999'
    }))
    expect(activeOwner.setMonitorGain(74, '1', -12, true)).toMatchObject({
      ok: false,
      error: 'Native headphone gain returned an invalid response.'
    })
    active.monitorStatus = () => ({ ...monitorStatus('0', false), enabled: true })
    expect(activeOwner.monitorStatus()).toMatchObject({
      active: true,
      enabled: false,
      ownershipGeneration: '1',
      state: 'error'
    })
    active.monitorStatus = () => ({ ...monitorStatus('1', true), state: 'stopped' })
    expect(activeOwner.monitorStatus()).toMatchObject({
      active: true,
      enabled: false,
      ownershipGeneration: '1',
      state: 'error'
    })
    active.endMonitor = ((generation) => monitorResult(generation.toString()))
    expect(activeOwner.endMonitor(74, '1')).toMatchObject({
      ok: false,
      error: 'Native headphone monitoring returned an invalid stop response.'
    })
  })
})
