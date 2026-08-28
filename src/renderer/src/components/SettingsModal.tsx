import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  chromiumInputIdForNative,
  getAudioDevices,
  nativeInputUidForChromium,
  type AudioDevices
} from '../audio/devices'
import { MicrophonePreview, micPreviewErrorCopy, micPreviewErrorKind } from '../audio/mic-preview'
import {
  DesktopMonitorCoordinator,
  linearToDbfs,
  type MonitorCoordinatorSnapshot,
  type MonitorStopOutcome
} from '../audio/monitoring'
import type { MicDevice } from '../audio/mic'
import type { AudioPrefs } from '../model'
import type {
  DesktopAudioHostDevice,
  DesktopAudioHostInventoryResult,
  DesktopAudioInputDevice,
  DesktopMonitorConfig
} from '../../../shared/types'
import { Modal } from '@singz/ui'
import DspGraphVisualization from './DspGraphVisualization'

export interface SettingsModalProps {
  audio: AudioPrefs
  onChangeOutput: (id: string | undefined) => void
  onChangeInput: (nativeUid: string | undefined, chromiumId: string | undefined) => void
  onMigrateNativeInput: (nativeUid: string) => void
  onChangeInputChannel: (channelIndex: number) => void
  onChangeNativeMonitorOutput: (uid: string | undefined) => void
  onChangeNativeMonitorOutputChannels: (channels: number[]) => void
  onChangeMonitorGain: (gainDb: number) => void
  onPauseSong: () => void
  onReleaseLegacyOutput: () => Promise<void>
  onRestoreLegacyOutput: () => Promise<void>
  outputStatus: string | null
  micDevice: MicDevice | null
  onClose: () => void
  /** Route-boundary safety handle. It deliberately stays above this lazy
   * component if a descendant throws after native monitoring has started. */
  registerEmergencyStop?: (controller: {
    stop: () => Promise<MonitorStopOutcome>
    hasNativeOwnership: () => boolean
  }) => void
}

type PreviewState =
  | { status: 'starting'; device: null; dbfs: -72; peak: -72 }
  | { status: 'live' | 'no-signal'; device: MicDevice; dbfs: number; peak: number }
  | { status: 'error'; device: null; dbfs: -72; peak: -72; message: string }

const INITIAL_PREVIEW: PreviewState = { status: 'starting', device: null, dbfs: -72, peak: -72 }
const INITIAL_MONITOR: MonitorCoordinatorSnapshot = {
  phase: 'idle',
  message: 'Monitoring is off.',
  result: null,
  status: null
}

export const MONITOR_DIAGNOSTIC_LABELS = [
  'Input device',
  'Buffer',
  'Output device',
  'External route',
  'Xruns',
  'Deadline misses',
  'Render failures'
] as const

export function inputChannelOptions(channelCount: number): number[] {
  return channelCount > 1 ? Array.from({ length: channelCount }, (_, index) => index) : []
}

export function audioChannelLabel(
  labels: readonly string[] | undefined,
  index: number,
  direction: 'input' | 'output'
): string {
  const prefix = direction === 'input' ? 'IN' : 'OUT'
  const fallback = `${prefix} ${index + 1}`
  const nativeLabel = labels?.[index]?.trim()
  if (!nativeLabel) return fallback
  const generic = new RegExp(`^(?:(?:channel|input|output|${prefix})\\s*)?${index + 1}$`, 'i')
  return generic.test(nativeLabel) ? fallback : `${fallback} · ${nativeLabel}`
}

export function defaultMonitorOutputChannels(device: DesktopAudioHostDevice | undefined): number[] {
  if (!device || device.outputChannels < 1) return []
  return device.outputChannels > 1 ? [0, 1] : [0]
}

const joinedChannelNumbers = (channels: readonly number[]): string => {
  const numbers = channels.map((channel) => channel + 1)
  if (numbers.length < 2) return String(numbers[0] ?? '')
  return `${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`
}

/** CoreAudio exposes playback lanes. A multichannel interface may route those
 * lanes to physical sockets in its own mixer, which the OS cannot describe. */
export function monitorPlaybackRouteHelp(
  output: DesktopAudioHostDevice | undefined,
  channels: readonly number[]
): string | null {
  if (!output || output.outputChannels <= 2 || channels.length === 0) return null
  const channelNumbers = joinedChannelNumbers(channels)
  if (/zen\s+quadro/i.test(output.label)) {
    return `Zen Quadro: in Antelope Control Panel → Monitors & Headphones, assign USB 1 PLAY ${channelNumbers} to the Monitor/HP1 or Headphones 2 mixer you use.`
  }
  return `These are playback lanes, not physical jack names. In your interface mixer, route OUT ${channelNumbers} to the headphone bus you use.`
}

export function monitorSignalCopy(
  active: boolean,
  preDb: number,
  postDb: number,
  inputChannel: string,
  outputChannels: readonly string[]
): { copy: string; warn: boolean } | null {
  if (!active) return null
  const db = (value: number): string => value <= -72 ? '−∞' : String(Math.round(value))
  if (preDb <= -66) {
    return {
      copy: `Monitoring is running, but ${inputChannel} is near silence (${db(preDb)} dBFS). Check the input channel and interface preamp, then sing into the microphone.`,
      warn: true
    }
  }
  if (postDb <= -66) {
    return {
      copy: `The microphone reaches the DSP graph, but its output is near silence (${db(postDb)} dBFS). Raise Monitor gain.`,
      warn: true
    }
  }
  return {
    copy: `DSP audio is live at ${db(postDb)} dBFS on ${outputChannels.join(' and ')}. If the headphones are silent, route those playback lanes to their headphone bus in the interface mixer.`,
    warn: false
  }
}

export function monitorRouteCopy(
  inventory: DesktopAudioHostInventoryResult | null,
  input: DesktopAudioHostDevice | undefined,
  output: DesktopAudioHostDevice | undefined
): { ready: boolean; copy: string } {
  if (!inventory) return { ready: false, copy: 'Inspecting native audio routes…' }
  if (!inventory.ok) return { ready: false, copy: inventory.error }
  if (inventory.platform === 'win32') {
    return {
      ready: false,
      copy: 'Headphone monitoring is not available on Windows yet. WASAPI inventory is shown, but native output stays off in this version.'
    }
  }
  if (inventory.platform !== 'darwin') {
    return { ready: false, copy: 'Headphone monitoring is not available on this desktop platform yet.' }
  }
  if (!input) {
    return {
      ready: false,
      copy: 'Choose a native monitoring input. SingZ will not guess from a device name.'
    }
  }
  if (!output) return { ready: false, copy: 'Choose a native playback device.' }
  if (input.uid !== output.uid || input.direction !== 'duplex' || output.direction !== 'duplex') {
    return {
      ready: false,
      copy: 'macOS monitoring needs the microphone and headphones on the same duplex audio device.'
    }
  }
  if (output.monitoringSuitability === 'high-latency') {
    return {
      ready: false,
      copy: 'This is a delayed wireless or vehicle-style route. Choose wired headphones on a low-latency device.'
    }
  }
  if (output.monitoringSuitability !== 'low-latency') {
    return {
      ready: false,
      copy: 'This route is not approved for low-latency monitoring. Choose a provider-confirmed wired device.'
    }
  }
  return { ready: true, copy: `${output.label} is approved for low-latency duplex monitoring.` }
}

export function monitorConfig(
  input: DesktopAudioHostDevice,
  output: DesktopAudioHostDevice,
  inputChannel: number,
  outputChannels: number[]
): DesktopMonitorConfig | null {
  const bufferFrames = output.bufferFrames.preferredFrames
  const maximumFrames = Math.min(8192, Math.max(bufferFrames, output.bufferFrames.maximumFrames))
  const sampleRate = Math.round(output.nominalSampleRate)
  if (
    inputChannel < 0 || inputChannel >= input.inputChannels ||
    outputChannels.length < 1 || new Set(outputChannels).size !== outputChannels.length ||
    outputChannels.some((channel) => channel < 0 || channel >= output.outputChannels) ||
    sampleRate < 8000 || bufferFrames < 1 || maximumFrames < bufferFrames
  ) return null
  return {
    inputDeviceUid: input.uid,
    outputDeviceUid: output.uid,
    inputChannels: [inputChannel],
    outputChannels,
    sampleRate,
    bufferFrames,
    maximumFrames,
    exclusive: false
  }
}

export function monitorStartReady(options: {
  routeReady: boolean
  previewConfirmed: boolean
  previewCaptureActive: boolean
  nativeConfigAvailable: boolean
  headphonesConfirmed: boolean
  monitorBusy: boolean
  monitorActive: boolean
  hasNativeOwnership: boolean
}): boolean {
  return options.routeReady && options.previewConfirmed && options.previewCaptureActive &&
    options.nativeConfigAvailable && options.headphonesConfirmed && !options.monitorBusy &&
    !options.monitorActive && !options.hasNativeOwnership
}

export type MonitorLifecycleEvent =
  | 'document-hidden'
  | 'document-visible'
  | 'media-device-change'

export type MonitorLifecycleAction =
  | 'preserve-monitor'
  | 'stop-preview'
  | 'restart-preview'

/** Native monitoring is an explicitly enabled audio session, not renderer
 * animation work. On macOS a fully occluded window becomes document.hidden;
 * that must not turn switching to an interface mixer into an audio stop. */
export function monitorLifecycleAction(
  event: MonitorLifecycleEvent,
  hasNativeOwnership: boolean
): MonitorLifecycleAction {
  if (hasNativeOwnership) return 'preserve-monitor'
  return event === 'document-hidden' ? 'stop-preview' : 'restart-preview'
}

export default function SettingsModal({
  audio,
  onChangeOutput,
  onChangeInput,
  onMigrateNativeInput,
  onChangeInputChannel,
  onChangeNativeMonitorOutput,
  onChangeNativeMonitorOutputChannels,
  onChangeMonitorGain,
  onPauseSong,
  onReleaseLegacyOutput,
  onRestoreLegacyOutput,
  outputStatus,
  micDevice,
  onClose,
  registerEmergencyStop
}: SettingsModalProps): React.JSX.Element {
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  /** null means the native core is unavailable and the UI is in Web Audio fallback mode. */
  const [nativeInputs, setNativeInputs] = useState<DesktopAudioInputDevice[] | null>(null)
  const [hostInventory, setHostInventory] = useState<DesktopAudioHostInventoryResult | null>(null)
  const [previewEpoch, setPreviewEpoch] = useState(0)
  const [preview, setPreview] = useState<PreviewState>(INITIAL_PREVIEW)
  const [monitor, setMonitor] = useState<MonitorCoordinatorSnapshot>(INITIAL_MONITOR)
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false)
  const previewCapture = useRef<MicrophonePreview | null>(null)
  const monitorCoordinator = useRef<DesktopMonitorCoordinator | null>(null)

  const refreshDevices = useCallback(() => {
    void getAudioDevices({ requestAccess: false }).then(setDevices).catch(() => setDevices(null))
    void window.singz.listDesktopAudioInputs()
      .then((result) => setNativeInputs(result.ok ? result.devices : null))
      .catch(() => setNativeInputs(null))
    void window.singz.audioHostDevices()
      .then(setHostInventory)
      .catch((error) => setHostInventory({
        ok: false,
        platform: 'other',
        defaultInputUid: '',
        defaultOutputUid: '',
        devices: [],
        error: error instanceof Error ? error.message : String(error)
      }))
  }, [])

  useEffect(() => {
    let live = true
    const coordinator = new DesktopMonitorCoordinator({
      api: window.singz,
      stopPreview: async () => {
        await previewCapture.current?.stopAndWait()
      },
      pauseSong: onPauseSong,
      releaseLegacyOutput: onReleaseLegacyOutput,
      restoreLegacyOutput: onRestoreLegacyOutput,
      onTerminalStop: (outcome) => {
        if (!live) return
        setHeadphonesConfirmed(false)
        refreshDevices()
        // The capture was stopped before native output began. Its last meter
        // frame must not remain eligible while a safe preview is reopening.
        setPreview(INITIAL_PREVIEW)
        if (
          outcome.safeToRestartPreview && !document.hidden &&
          !coordinator.hasNativeOwnership
        ) setPreviewEpoch((value) => value + 1)
      }
    })
    monitorCoordinator.current = coordinator
    registerEmergencyStop?.({
      stop: () => coordinator.stop(),
      hasNativeOwnership: () => coordinator.hasNativeOwnership
    })
    const unsubscribe = coordinator.subscribe(setMonitor)
    return () => {
      live = false
      unsubscribe()
      monitorCoordinator.current = null
      void coordinator.stop()
    }
  }, [onPauseSong, onReleaseLegacyOutput, onRestoreLegacyOutput, refreshDevices, registerEmergencyStop])

  useEffect(() => {
    if (monitor.phase !== 'active') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      await monitorCoordinator.current?.refreshStatus()
      if (!cancelled && monitorCoordinator.current?.snapshot.phase === 'active') {
        timer = setTimeout(() => void poll(), 120)
      }
    }
    timer = setTimeout(() => void poll(), 120)
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [monitor.phase])

  useEffect(() => {
    refreshDevices()
    const refresh = (): void => {
      const coordinator = monitorCoordinator.current
      refreshDevices()
      if (monitorLifecycleAction(
        'media-device-change',
        coordinator?.hasNativeOwnership ?? false
      ) === 'preserve-monitor') return
      setHeadphonesConfirmed(false)
      void (async () => {
        const outcome = await coordinator?.stop()
        if (outcome?.safeToRestartPreview && !coordinator?.hasNativeOwnership) {
          setPreviewEpoch((value) => value + 1)
        }
      })()
    }
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refreshDevices])

  useEffect(() => {
    if (!nativeInputs || !devices || audio.nativeInputUid || !audio.inputId) return
    const nativeUid = nativeInputUidForChromium(audio.inputId, devices.inputs, nativeInputs)
    if (nativeUid) onMigrateNativeInput(nativeUid)
  }, [audio.inputId, audio.nativeInputUid, devices, nativeInputs, onMigrateNativeInput])

  useLayoutEffect(() => {
    let live = true
    let frame: number | null = null
    let lastSignature = ''
    let heldPeak = -72
    let lastPeakAt = performance.now()
    const capture = new MicrophonePreview()
    previewCapture.current = capture

    const stop = (): void => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      void capture.stop()
    }
    const tick = (now: number): void => {
      if (!live || document.hidden) return
      const level = capture.readLevel()
      const dbfs = Math.round(level.dbfs)
      if (dbfs >= heldPeak) {
        heldPeak = dbfs
        lastPeakAt = now
      } else if (now - lastPeakAt > 700) heldPeak = Math.max(dbfs, heldPeak - 2)
      const device = capture.device
      if (!device) return
      const status = level.signal ? 'live' : 'no-signal'
      const signature = `${status}:${dbfs}:${heldPeak}:${device.id}:${device.channelIndex}:${device.channelCount}`
      if (signature !== lastSignature) {
        lastSignature = signature
        setPreview({ status, device, dbfs, peak: heldPeak })
      }
      frame = requestAnimationFrame(tick)
    }
    const start = async (): Promise<void> => {
      stop()
      setPreview(INITIAL_PREVIEW)
      if (document.hidden) return
      try {
        await capture.start({
          deviceId: audio.inputId,
          nativeDeviceUid: audio.nativeInputUid,
          channelIndex: audio.inputChannel,
          onEnded: () => {
            if (!live) return
            if (frame !== null) cancelAnimationFrame(frame)
            frame = null
            setPreview({ status: 'error', device: null, dbfs: -72, peak: -72, message: 'The microphone disconnected. Reconnect it or choose another input.' })
            refreshDevices()
          }
        })
        if (!live) return
        refreshDevices()
        frame = requestAnimationFrame(tick)
      } catch (error) {
        if (!live || /cancelled/i.test(error instanceof Error ? error.message : String(error))) return
        setPreview({ status: 'error', device: null, dbfs: -72, peak: -72, message: micPreviewErrorCopy(micPreviewErrorKind(error)) })
      }
    }
    const visibility = (): void => {
      const coordinator = monitorCoordinator.current
      const action = monitorLifecycleAction(
        document.hidden ? 'document-hidden' : 'document-visible',
        coordinator?.hasNativeOwnership ?? false
      )
      if (action === 'preserve-monitor') return
      if (action === 'stop-preview') {
        stop()
        setHeadphonesConfirmed(false)
        return
      }
      void start()
    }
    document.addEventListener('visibilitychange', visibility)
    void start()
    return () => {
      live = false
      document.removeEventListener('visibilitychange', visibility)
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      // Error-boundary teardown retains this exact owner until native stop is
      // positively confirmed. The coordinator's emergency stop can therefore
      // join/retry the same token instead of treating a cleared ref as safety.
      void capture.stopAndWait().then(() => {
        if (previewCapture.current === capture) previewCapture.current = null
      }).catch(() => {
        // Keep the ref: the boundary must remain locked and may retry stop.
      })
    }
  }, [audio.inputChannel, audio.inputId, audio.nativeInputUid, previewEpoch, refreshDevices])

  const stopMonitoring = useCallback(async (restartPreview = true): Promise<MonitorStopOutcome> => {
    const outcome = await (monitorCoordinator.current?.stop() ?? Promise.resolve({
      ok: true as const,
      safeToRestartPreview: true as const
    }))
    setHeadphonesConfirmed(false)
    if (
      outcome.safeToRestartPreview && restartPreview && !document.hidden &&
      !monitorCoordinator.current?.hasNativeOwnership
    ) setPreviewEpoch((value) => value + 1)
    return outcome
  }, [])

  const closeSettings = useCallback(async (): Promise<void> => {
    const outcome = await stopMonitoring(false)
    if (outcome.safeToRestartPreview) onClose()
  }, [onClose, stopMonitoring])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.code === 'Escape') {
        event.stopPropagation()
        void closeSettings()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [closeSettings])

  const savedGone = (id: string | undefined, rows: { id: string }[] | undefined): boolean =>
    Boolean(id && rows && !rows.some((device) => device.id === id))
  const nativeInventoryAvailable = nativeInputs !== null
  const selectedNativeInput = nativeInputs?.find((device) => device.uid === audio.nativeInputUid) ??
    (audio.nativeInputUid ? undefined : nativeInputs?.find((device) => device.isDefault) ?? nativeInputs?.[0])
  const inputDevice = preview.device ?? micDevice
  const requestedChannel = audio.inputChannel ?? 0
  // Native inventory is authoritative whenever available. If a saved interface
  // is disconnected, preserve its lane instead of silently rewriting the pref.
  const channelCount = nativeInventoryAvailable
    ? selectedNativeInput?.channels ?? Math.max(1, requestedChannel + 1)
    : inputDevice?.channelCount ?? 1
  const channelIndex = Math.min(requestedChannel, Math.max(0, channelCount - 1))
  const previewChannelIndex = preview.device?.channelIndex ?? 0
  const previewChannelCount = preview.device?.channelCount ?? 1
  const levelPct = Math.max(0, Math.min(100, ((preview.dbfs + 72) / 72) * 100))
  const peakPct = Math.max(0, Math.min(100, ((preview.peak + 72) / 72) * 100))
  const statusCopy = preview.status === 'starting'
    ? 'Starting microphone preview…'
    : preview.status === 'error'
      ? preview.message
      : preview.status === 'no-signal'
        ? `No signal on channel ${previewChannelIndex + 1}`
        : `${preview.dbfs} dBFS on channel ${previewChannelIndex + 1}`
  const routeCopy = preview.status === 'error'
    ? preview.message
    : preview.device
      ? `Listening through ${preview.device.label || 'the microphone'} · channel ${previewChannelIndex + 1} of ${previewChannelCount}`
      : 'Microphone preview is opening.'

  const hostDevices = hostInventory?.ok ? hostInventory.devices : []
  const hostInputs = hostDevices.filter((device) => device.inputChannels > 0)
  const hostOutputs = hostDevices.filter((device) => device.outputChannels > 0)
  // Exact opaque UID only. There is deliberately no friendly-label bridge at
  // this native full-duplex boundary.
  const exactPreviewInputUid = preview.device && !preview.device.fallback
    ? preview.device.id
    : undefined
  const monitorInput = hostInputs.find((device) =>
    device.uid === (audio.nativeInputUid ?? exactPreviewInputUid)
  )
  const effectiveMonitorOutputUid = audio.nativeMonitorOutputUid ??
    (monitorInput?.outputChannels ? monitorInput.uid : undefined)
  const monitorOutput = hostOutputs.find((device) => device.uid === effectiveMonitorOutputUid)
  const selectedOutputChannels = audio.nativeMonitorOutputChannels ??
    defaultMonitorOutputChannels(monitorOutput)
  // First-run monitoring stays below unity, but -12 dB was quiet enough to be
  // mistaken for a broken route on real headphones.
  const monitorGainDb = audio.monitorGainDb ?? -6
  const routeVerdict = monitorRouteCopy(hostInventory, monitorInput, monitorOutput)
  const previewOwnsExactInput = (preview.status === 'live' || preview.status === 'no-signal') &&
    preview.device?.id === monitorInput?.uid && preview.device.channelIndex === requestedChannel &&
    !preview.device.fallback && !preview.device.channelFallback
  const nativeConfig = monitorInput && monitorOutput
    ? monitorConfig(monitorInput, monitorOutput, requestedChannel, selectedOutputChannels)
    : null
  const selectedOutputChannelLabels = monitorOutput
    ? selectedOutputChannels.map((channel) =>
        audioChannelLabel(monitorOutput.outputChannelLabels, channel, 'output'))
    : []
  const playbackRouteHelp = monitorPlaybackRouteHelp(monitorOutput, selectedOutputChannels)
  const monitorBusy = monitor.phase === 'preparing' || monitor.phase === 'starting' ||
    monitor.phase === 'stopping'
  const monitorActive = monitor.phase === 'active'
  const previewCaptureActive = previewCapture.current?.active === true
  const canStartMonitor = monitorStartReady({
    routeReady: routeVerdict.ready,
    previewConfirmed: previewOwnsExactInput,
    previewCaptureActive,
    nativeConfigAvailable: Boolean(nativeConfig),
    headphonesConfirmed,
    monitorBusy,
    monitorActive,
    hasNativeOwnership: monitorCoordinator.current?.hasNativeOwnership ?? false
  })
  const nativePreDb = linearToDbfs(monitor.status?.pre.rms ?? 0)
  const nativePostDb = linearToDbfs(monitor.status?.post.rms ?? 0)
  const signalVerdict = monitorSignalCopy(
    monitorActive,
    nativePreDb,
    nativePostDb,
    monitorInput
      ? audioChannelLabel(monitorInput.inputChannelLabels, requestedChannel, 'input')
      : `IN ${requestedChannel + 1}`,
    selectedOutputChannelLabels
  )
  const monitorRouteStatus = !routeVerdict.ready
    ? routeVerdict.copy
    : !nativeConfig
      ? 'Choose physical input and output channels that are available on this device.'
      : !previewOwnsExactInput
        ? 'The microphone preview must confirm this exact native device and channel before monitoring can start.'
        : signalVerdict?.copy ?? routeVerdict.copy
  const monitorRouteWarn = !routeVerdict.ready || signalVerdict?.warn === true

  const afterMonitorStops = (apply: () => void): void => {
    if (!monitorCoordinator.current?.hasNativeOwnership) {
      apply()
      return
    }
    void stopMonitoring().then((outcome) => {
      if (outcome.safeToRestartPreview) apply()
    })
  }

  const afterPhysicalRouteChange = (apply: () => void): void => {
    setHeadphonesConfirmed(false)
    afterMonitorStops(apply)
  }

  const afterInputRouteChange = (apply: () => void): void => {
    setHeadphonesConfirmed(false)
    // Keep the old preview object reachable until its native child positively
    // confirms stop. Only then may the controlled route change unmount that
    // preview and create a replacement on the newly selected input/channel.
    void stopMonitoring(false).then((outcome) => {
      if (
        !outcome.safeToRestartPreview ||
        monitorCoordinator.current?.hasNativeOwnership
      ) return
      setPreview(INITIAL_PREVIEW)
      apply()
      setPreviewEpoch((value) => value + 1)
    })
  }

  const changeInput = (value: string): void => {
    afterInputRouteChange(() => {
      if (!nativeInventoryAvailable) {
        onChangeInput(undefined, value || undefined)
        return
      }
      const nativeUid = value || undefined
      const nativeDevice = nativeInputs?.find((device) => device.uid === nativeUid)
      const chromiumId = nativeDevice && devices
        ? chromiumInputIdForNative(nativeDevice, devices.inputs)
        : undefined
      onChangeInput(nativeUid, chromiumId)
    })
  }

  const changeMonitorInput = (value: string): void => {
    afterInputRouteChange(() => {
      // Do not infer or carry a Chromium id by label. The normal preview chooses
      // Web Audio fallback only if the exact native core is unavailable.
      onChangeInput(value || undefined, undefined)
    })
  }

  const changeInputLane = (value: number): void => {
    afterInputRouteChange(() => onChangeInputChannel(value))
  }

  const changeMonitorOutput = (value: string): void => {
    afterPhysicalRouteChange(() => onChangeNativeMonitorOutput(value || undefined))
  }

  const changeOutputChannel = (slot: number, value: number): void => {
    const next = [...selectedOutputChannels]
    next[slot] = value
    if (new Set(next).size !== next.length) return
    afterPhysicalRouteChange(() => onChangeNativeMonitorOutputChannels(next))
  }

  const updateMonitorGain = (value: number): void => {
    const gainDb = Math.max(-60, Math.min(0, value))
    onChangeMonitorGain(gainDb)
    if (monitorActive) void monitorCoordinator.current?.setGain(gainDb)
  }

  const startMonitoring = async (): Promise<void> => {
    if (!canStartMonitor || !nativeConfig) return
    await monitorCoordinator.current?.start(nativeConfig, monitorGainDb)
  }

  return (
    <Modal onClose={() => void closeSettings()} cardClassName="settings-card">
      <h2>Settings</h2>
      <div className="settings-body">
        <nav className="settings-nav"><button type="button" className="settings-tab active">Audio</button></nav>
        <div className="settings-page">
          <label className="settings-label" htmlFor="settings-output">Playback device</label>
          <select id="settings-output" className="settings-select" value={audio.outputId ?? ''} onChange={(event) => afterMonitorStops(() => onChangeOutput(event.target.value || undefined))}>
            <option value="">System default</option>
            {devices?.outputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
            {savedGone(audio.outputId, devices?.outputs) && <option value={audio.outputId}>Saved device (not connected)</option>}
          </select>
          {outputStatus && <p className="settings-hint warn">{outputStatus}</p>}

          <section className="mic-input-strip" aria-labelledby="mic-input-heading">
            <div className="mic-input-heading">
              <label className="settings-label" id="mic-input-heading" htmlFor="settings-input">Microphone</label>
              {(selectedNativeInput || inputDevice || requestedChannel > 0) && <span className="mic-route">IN {channelIndex + 1}/{channelCount}</span>}
            </div>
            <select id="settings-input" className="settings-select" value={nativeInventoryAvailable ? audio.nativeInputUid ?? '' : audio.inputId ?? ''} onChange={(event) => void changeInput(event.target.value)}>
              <option value="">System default</option>
              {nativeInventoryAvailable
                ? nativeInputs.map((device) => <option key={device.uid} value={device.uid}>{device.label} · {device.channels} ch</option>)
                : devices?.inputs.map((device) => <option key={device.id} value={device.id}>{device.label}</option>)}
              {nativeInventoryAvailable
                ? audio.nativeInputUid && !nativeInputs.some((device) => device.uid === audio.nativeInputUid) && <option value={audio.nativeInputUid}>Saved device (not connected)</option>
                : savedGone(audio.inputId, devices?.inputs) && <option value={audio.inputId}>Saved device (not connected)</option>}
            </select>

            <div className="mic-channel-row">
              {channelCount > 1 ? <>
                <label htmlFor="settings-input-channel">Input channel</label>
                <select id="settings-input-channel" className="settings-select channel-select" value={channelIndex} onChange={(event) => void changeInputLane(Number(event.target.value))}>
                  {inputChannelOptions(channelCount).map((index) => (
                    <option key={index} value={index}>
                      {audioChannelLabel(selectedNativeInput?.channelLabels, index, 'input')}
                    </option>
                  ))}
                </select>
              </> : <span className="mic-mono-state">Mono input · channel 1</span>}
            </div>

            <div className="mic-meter-head"><span>Input level</span><output>{statusCopy}</output></div>
            <div className={`mic-meter${preview.status === 'error' ? ' error' : ''}`} role="meter" aria-label="Selected microphone channel level" aria-valuemin={-72} aria-valuemax={0} aria-valuenow={preview.dbfs} aria-valuetext={statusCopy}>
              <span className="mic-meter-fill" style={{ width: `${levelPct}%` }} />
              <span className="mic-meter-peak" style={{ left: `${peakPct}%` }} />
              <span className="mic-meter-tick tick-48">−48</span><span className="mic-meter-tick tick-24">−24</span><span className="mic-meter-tick tick-12">−12</span><span className="mic-meter-tick tick-0">0</span>
            </div>
            <p className={`mic-preview-status${preview.status === 'error' ? ' warn' : ''}`}>{routeCopy}</p>
            {preview.device?.fallback && <p className="settings-hint warn">The saved microphone is unavailable — previewing the system default.</p>}
            {preview.device?.channelFallback && <p className="settings-hint warn">That lane is unavailable — previewing channel {previewChannelIndex + 1}.</p>}
          </section>

          <section className="monitor-strip" aria-labelledby="monitor-heading">
            <div className="monitor-heading">
              <div>
                <h3 id="monitor-heading">Headphone monitoring</h3>
                <span>Hear this mic through the native DSP graph</span>
              </div>
              <span className="monitor-experimental">Experimental</span>
            </div>

            {!monitorInput && hostInputs.length > 0 && (
              <div className="monitor-field">
                <label className="settings-label" htmlFor="monitor-input">Native monitoring input</label>
                <select
                  id="monitor-input"
                  className="settings-select"
                  value={audio.nativeInputUid ?? ''}
                  onChange={(event) => void changeMonitorInput(event.target.value)}
                  disabled={monitorBusy || monitorActive}
                >
                  <option value="">Choose an exact native device…</option>
                  {hostInputs.map((device) => (
                    <option key={device.uid} value={device.uid}>
                      {device.label} · {device.inputChannels} in
                    </option>
                  ))}
                  {audio.nativeInputUid && !hostInputs.some((device) => device.uid === audio.nativeInputUid) && (
                    <option value={audio.nativeInputUid}>Saved native input (not connected)</option>
                  )}
                </select>
                <p className="settings-hint">This is an OS audio UID. SingZ never matches it from a Chromium device name.</p>
              </div>
            )}

            <div className="monitor-field">
              <label className="settings-label" htmlFor="monitor-output">Audio interface playback</label>
              <select
                id="monitor-output"
                className="settings-select"
                value={effectiveMonitorOutputUid ?? ''}
                onChange={(event) => void changeMonitorOutput(event.target.value)}
                disabled={monitorBusy || monitorActive}
              >
                <option value="">Choose playback device…</option>
                {hostOutputs.map((device) => (
                  <option key={device.uid} value={device.uid}>
                    {device.label} · {device.outputChannels} out · {device.transport}
                  </option>
                ))}
                {audio.nativeMonitorOutputUid && !hostOutputs.some((device) => device.uid === audio.nativeMonitorOutputUid) && (
                  <option value={audio.nativeMonitorOutputUid}>Saved native output (not connected)</option>
                )}
              </select>
            </div>

            {monitorInput && (
              <div className="monitor-route-grid">
                <div>
                  <span>Mic channel</span>
                  <strong>{audioChannelLabel(monitorInput.inputChannelLabels, requestedChannel, 'input')}</strong>
                </div>
                {monitorOutput && selectedOutputChannels.map((selected, slot) => (
                  <label key={slot} htmlFor={`monitor-output-${slot}`}>
                    <span>{selectedOutputChannels.length > 1 ? (slot === 0 ? 'Playback L' : 'Playback R') : 'Playback'}</span>
                    <select
                      id={`monitor-output-${slot}`}
                      className="settings-select channel-select"
                      value={selected}
                      onChange={(event) => void changeOutputChannel(slot, Number(event.target.value))}
                      disabled={monitorBusy || monitorActive}
                    >
                      {Array.from({ length: monitorOutput.outputChannels }, (_, index) => (
                        <option
                          key={index}
                          value={index}
                          disabled={selectedOutputChannels.some((channel, other) => other !== slot && channel === index)}
                        >
                          {audioChannelLabel(monitorOutput.outputChannelLabels, index, 'output')}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}

            {playbackRouteHelp && <p className="monitor-routing-help">{playbackRouteHelp}</p>}

            <DspGraphVisualization
              phase={monitor.phase}
              routeReady={routeVerdict.ready && Boolean(nativeConfig)}
              inputLabel={monitorInput?.label}
              inputChannel={monitorInput ? requestedChannel : undefined}
              inputChannelLabel={monitorInput
                ? audioChannelLabel(monitorInput.inputChannelLabels, requestedChannel, 'input')
                : undefined}
              outputLabel={monitorOutput?.label}
              outputChannels={monitorOutput ? selectedOutputChannels : []}
              outputChannelLabels={selectedOutputChannelLabels}
              gainDb={monitorGainDb}
              preDb={nativePreDb}
              postDb={nativePostDb}
              plannedSampleRate={nativeConfig?.sampleRate}
              plannedBufferFrames={nativeConfig?.bufferFrames}
              status={monitor.status}
            />

            <label className="monitor-gain" htmlFor="monitor-gain">
              <span>Monitor gain</span>
              <input
                id="monitor-gain"
                type="range"
                min={-60}
                max={0}
                step={1}
                value={monitorGainDb}
                onChange={(event) => updateMonitorGain(Number(event.target.value))}
                disabled={monitorBusy}
              />
              <output>{monitorGainDb} dB</output>
            </label>

            <p id="monitor-route-status" className={`monitor-route-status${monitorRouteWarn ? ' warn' : ''}`}>{monitorRouteStatus}</p>
            <label className="monitor-headphones-check">
              <input
                type="checkbox"
                checked={headphonesConfirmed}
                onChange={(event) => setHeadphonesConfirmed(event.target.checked)}
                disabled={monitorBusy || monitorActive || !routeVerdict.ready}
              />
              <span>Wired headphones are connected to this device</span>
            </label>

            <div className="monitor-actions">
              {monitorActive ? (
                <button type="button" className="pill ghost" onClick={() => void stopMonitoring()}>
                  Stop monitoring
                </button>
              ) : (
                <button
                  type="button"
                  className="pill primary"
                  disabled={!canStartMonitor}
                  aria-describedby="monitor-route-status"
                  onClick={() => void startMonitoring()}
                >
                  {monitorBusy ? 'Preparing…' : 'Start monitoring'}
                </button>
              )}
              <p className={`monitor-state ${monitor.phase}`} aria-live="polite">{monitor.message}</p>
            </div>

            {monitor.status && (
              <div className="monitor-diagnostics" aria-label="Native host diagnostics">
                <div className="monitor-diagnostic-row latency">
                  <span>{MONITOR_DIAGNOSTIC_LABELS[0]} <strong>{monitor.status.latency.inputDeviceFrames > 0 ? `${monitor.status.latency.inputDeviceFrames} frames` : 'Not reported'}</strong></span>
                  <span>{MONITOR_DIAGNOSTIC_LABELS[1]} <strong>{monitor.status.latency.bufferFrames > 0 ? `${monitor.status.latency.bufferFrames} frames` : 'Not reported'}</strong></span>
                  <span>{MONITOR_DIAGNOSTIC_LABELS[2]} <strong>{monitor.status.latency.outputDeviceFrames > 0 ? `${monitor.status.latency.outputDeviceFrames} frames` : 'Not reported'}</strong></span>
                  <span>{MONITOR_DIAGNOSTIC_LABELS[3]} <strong>{monitor.status.latency.externalRouteFrames > 0 ? `${monitor.status.latency.externalRouteFrames} frames · provider-reported` : 'Unknown · not measured'}</strong></span>
                </div>
                <div className="monitor-diagnostic-row health">
                  <span>{MONITOR_DIAGNOSTIC_LABELS[4]} <strong>{monitor.status.xruns}</strong></span>
                  <span>{MONITOR_DIAGNOSTIC_LABELS[5]} <strong>{monitor.status.deadlineMisses}</strong></span>
                  <span>{MONITOR_DIAGNOSTIC_LABELS[6]} <strong>{monitor.status.renderFailures}</strong></span>
                </div>
              </div>
            )}
          </section>

          {!devices && <p className="settings-hint">Looking for audio devices…</p>}
          {devices?.inputLabelsHidden && <p className="settings-hint">Allow microphone access in System Settings to see device names.</p>}
          {audio.outputId && <p className="settings-hint">Tip: on a non-default speaker, sing with headphones — echo cancellation only tracks the system default output.</p>}
        </div>
      </div>
      <div className="modal-actions">
        <button type="button" className="pill ghost" onClick={() => void closeSettings()}>
          {monitorActive || monitorBusy ? 'Stop monitoring and close' : 'Close'}
        </button>
      </div>
    </Modal>
  )
}
