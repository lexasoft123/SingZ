import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import SettingsModal, {
  MONITOR_DIAGNOSTIC_LABELS,
  defaultMonitorOutputChannels,
  inputChannelOptions,
  monitorConfig,
  monitorRouteCopy,
  monitorStartReady
} from '../../src/renderer/src/components/SettingsModal'
import type { DesktopAudioHostDevice, DesktopAudioHostInventoryResult } from '../../src/shared/types'

const settingsProps = () => ({
  audio: { inputChannel: 0 },
  onChangeOutput: vi.fn(),
  onChangeInput: vi.fn(),
  onMigrateNativeInput: vi.fn(),
  onChangeInputChannel: vi.fn(),
  onChangeNativeMonitorOutput: vi.fn(),
  onChangeNativeMonitorOutputChannels: vi.fn(),
  onChangeMonitorGain: vi.fn(),
  onPauseSong: vi.fn(),
  onReleaseLegacyOutput: vi.fn(async () => undefined),
  onRestoreLegacyOutput: vi.fn(async () => undefined),
  outputStatus: null,
  micDevice: null,
  onClose: vi.fn()
})

const hostDevice = (overrides: Partial<DesktopAudioHostDevice> = {}): DesktopAudioHostDevice => ({
  uid: 'coreaudio:usb',
  label: 'Studio USB',
  defaultInput: true,
  defaultOutput: true,
  inputChannels: 4,
  outputChannels: 4,
  nominalSampleRate: 48000,
  direction: 'duplex',
  accessMode: 'shared',
  transport: 'usb',
  monitoringSuitability: 'low-latency',
  sampleRateRanges: [{ minimumHz: 48000, maximumHz: 48000 }],
  bufferFrames: { minimumFrames: 32, maximumFrames: 512, preferredFrames: 128, fundamentalFrames: 1 },
  ...overrides
})

const inventory = (platform: DesktopAudioHostInventoryResult['platform'], device = hostDevice()): DesktopAudioHostInventoryResult => ({
  ok: true,
  platform,
  defaultInputUid: device.uid,
  defaultOutputUid: device.uid,
  devices: [device]
})

describe('settings microphone input strip', () => {
  it('only offers channel choices for a multichannel capture', () => {
    expect(inputChannelOptions(1)).toEqual([])
    expect(inputChannelOptions(2)).toEqual([0, 1])
    expect(inputChannelOptions(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('renders a clear mono state and an accessible live level meter initially', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('Mono input · channel 1')
    expect(html).not.toContain('id="settings-input-channel"')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-label="Selected microphone channel level"')
    expect(html).toContain('Starting microphone preview…')
  })

  it('renders monitoring off with a fresh non-persisted headphone gate', () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('Headphone monitoring')
    expect(html).toContain('Monitoring is off.')
    expect(html).toContain('Wired headphones are connected')
    expect(html).not.toContain('checked=""')
    expect(html).toContain('disabled=""')
  })

  it('binds modal, hidden-document and renderer-side unmount cleanup', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('if (document.hidden)')
    expect(source).toContain('void monitorCoordinator.current?.stop()')
    expect(source).toContain('void coordinator.stop()')
    expect(source).toContain('const outcome = await stopMonitoring(false)')
    expect(source).toContain('outcome.safeToRestartPreview')
    expect(source).not.toContain('setInterval(')
    expect(source).toContain("timer = setTimeout(() => void poll(), 120)")
    expect(source).toContain('!monitorCoordinator.current?.hasNativeOwnership')
    expect(source).toMatch(
      /capture\.stopAndWait\(\)\.then\(\(\) => \{[\s\S]*previewCapture\.current === capture[\s\S]*previewCapture\.current = null[\s\S]*\.catch\(\(\) => \{[\s\S]*Keep the ref/
    )
  })

  it('revokes the fresh headphone confirmation on every physical route edit', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('const afterPhysicalRouteChange = (apply: () => void): void => {')
    expect(source).toContain('const afterInputRouteChange = (apply: () => void): void => {')
    expect(source).toContain('setHeadphonesConfirmed(false)')
    expect(source.match(/afterPhysicalRouteChange\(/g)).toHaveLength(2)
    expect(source.match(/afterInputRouteChange\(/g)).toHaveLength(3)
    expect(source).toMatch(/const canStartMonitor =[\s\S]*headphonesConfirmed/)
  })

  it('awaits confirmed preview teardown before applying input or channel changes', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toMatch(
      /const afterInputRouteChange =[\s\S]*stopMonitoring\(false\)\.then\(\(outcome\)[\s\S]*outcome\.safeToRestartPreview[\s\S]*hasNativeOwnership[\s\S]*apply\(\)[\s\S]*setPreviewEpoch/
    )
  })

  it('requires a live preview owner and no retained native ownership before Start', () => {
    const ready = {
      routeReady: true,
      previewConfirmed: true,
      previewCaptureActive: true,
      nativeConfigAvailable: true,
      headphonesConfirmed: true,
      monitorBusy: false,
      monitorActive: false,
      hasNativeOwnership: false
    }
    expect(monitorStartReady(ready)).toBe(true)
    expect(monitorStartReady({ ...ready, previewCaptureActive: false })).toBe(false)
    expect(monitorStartReady({ ...ready, hasNativeOwnership: true })).toBe(false)
  })

  it('invalidates preview and confirmation after coordinator-driven terminal teardown', () => {
    const source = readFileSync('src/renderer/src/components/SettingsModal.tsx', 'utf8')
    expect(source).toContain('onTerminalStop: (outcome) => {')
    expect(source).toContain('setHeadphonesConfirmed(false)')
    expect(source).toContain('setPreview(INITIAL_PREVIEW)')
    expect(source).toMatch(/outcome\.safeToRestartPreview[\s\S]*!coordinator\.hasNativeOwnership/)
    expect(source).toContain('previewCapture.current?.active === true')
  })

  it('renders disabled Start as a neutral inactive control with route help', () => {
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    const disabledRule = css.match(/\.monitor-actions \.pill\.primary:disabled \{([^}]+)\}/)?.[1] ?? ''
    expect(disabledRule).toContain('background: var(--panel)')
    expect(disabledRule).toContain('color: var(--faint)')
    expect(disabledRule).toContain('box-shadow: none')
    expect(disabledRule).not.toMatch(/accent|#[0-9a-f]/i)
    const html = renderToStaticMarkup(createElement(SettingsModal, settingsProps()))
    expect(html).toContain('aria-describedby="monitor-route-status"')
  })
})

describe('native monitoring route policy', () => {
  it('accepts only the exact low-latency same-device macOS route', () => {
    const device = hostDevice()
    expect(monitorRouteCopy(inventory('darwin', device), device, device)).toEqual({
      ready: true,
      copy: 'Studio USB is approved for low-latency duplex monitoring.'
    })
    const other = hostDevice({ uid: 'coreaudio:other', label: 'Other output' })
    expect(monitorRouteCopy(inventory('darwin', device), device, other).copy).toContain('same duplex')
  })

  it('makes Windows and delayed/unknown routes visibly unavailable', () => {
    const device = hostDevice()
    expect(monitorRouteCopy(inventory('win32', device), device, device)).toMatchObject({ ready: false })
    expect(monitorRouteCopy(inventory('win32', device), device, device).copy).toContain('not available on Windows yet')
    const bluetooth = hostDevice({ transport: 'bluetooth', monitoringSuitability: 'high-latency' })
    expect(monitorRouteCopy(inventory('darwin', bluetooth), bluetooth, bluetooth).copy).toContain('wired headphones')
    const unknown = hostDevice({ transport: 'unknown', monitoringSuitability: 'unknown' })
    expect(monitorRouteCopy(inventory('darwin', unknown), unknown, unknown).copy).toContain('provider-confirmed')
  })

  it('keeps exact opaque UIDs and physical channel indices in the native config', () => {
    const device = hostDevice()
    expect(defaultMonitorOutputChannels(device)).toEqual([0, 1])
    expect(monitorConfig(device, device, 2, [1, 3])).toEqual({
      inputDeviceUid: 'coreaudio:usb',
      outputDeviceUid: 'coreaudio:usb',
      inputChannels: [2],
      outputChannels: [1, 3],
      sampleRate: 48000,
      bufferFrames: 128,
      maximumFrames: 512,
      exclusive: false
    })
    expect(monitorConfig(device, device, 4, [0, 1])).toBeNull()
    expect(monitorConfig(device, device, 2, [1, 1])).toBeNull()
  })

  it('names independent latency components and host health without claiming round trip', () => {
    expect(MONITOR_DIAGNOSTIC_LABELS).toEqual([
      'Input device', 'Buffer', 'Output device', 'External route',
      'Xruns', 'Deadline misses', 'Render failures'
    ])
    expect(MONITOR_DIAGNOSTIC_LABELS.join(' ')).not.toMatch(/round.?trip/i)
  })
})
