/**
 * Audio device enumeration for the settings page. Electron grants media
 * permission by default, so full labeled lists usually come back with no
 * active stream — the one residual gate is macOS mic access (TCC), which
 * blanks audioinput labels until granted.
 */

export interface AudioOutputDeviceInfo {
  id: string
  label: string
}

export interface AudioInputDeviceInfo {
  id: string
  label: string
  isDefault: boolean
  sampleRate: number
  channels: number
  channelLabels: string[]
}

export interface AudioDevices {
  inputs: AudioInputDeviceInfo[]
  outputs: AudioOutputDeviceInfo[]
  inputError?: string
}

/**
 * Drop Chromium's synthetic rows ('default'/'communications' on Windows) —
 * the picker's own "System default" row covers them — and give unnamed
 * devices stable placeholder names.
 */
export function shapeOutputDevices(
  list: Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[]
): AudioOutputDeviceInfo[] {
  return list
    .filter(
      (d) =>
        d.kind === 'audiooutput' &&
        d.deviceId !== '' &&
        d.deviceId !== 'default' &&
        d.deviceId !== 'communications'
    )
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Speakers ${i + 1}` }))
}

export async function getAudioDevices(): Promise<AudioDevices> {
  const [nativeInputs, browserDevices] = await Promise.all([
    window.singz.captureInputDevices(),
    navigator.mediaDevices.enumerateDevices()
  ])
  return {
    inputs: nativeInputs.ok
      ? nativeInputs.devices.map((device) => ({ ...device, id: device.uid }))
      : [],
    outputs: shapeOutputDevices(browserDevices),
    ...(!nativeInputs.ok ? { inputError: nativeInputs.error } : {})
  }
}
