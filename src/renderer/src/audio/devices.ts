/**
 * Audio device enumeration for the settings page. Electron grants media
 * permission by default, so full labeled lists usually come back with no
 * active stream — the one residual gate is macOS mic access (TCC), which
 * blanks audioinput labels until granted.
 */

export interface AudioDeviceInfo {
  id: string
  label: string
}

export interface AudioDevices {
  inputs: AudioDeviceInfo[]
  outputs: AudioDeviceInfo[]
  /** Input names are hidden pending mic permission (mac System Settings). */
  inputLabelsHidden: boolean
}

/**
 * Drop Chromium's synthetic rows ('default'/'communications' on Windows) —
 * the picker's own "System default" row covers them — and give unnamed
 * devices stable placeholder names.
 */
export function shapeDevices(
  list: Pick<MediaDeviceInfo, 'deviceId' | 'kind' | 'label'>[]
): AudioDevices {
  const pick = (
    kind: string,
    name: string
  ): { devs: AudioDeviceInfo[]; hidden: boolean } => {
    const rows = list.filter(
      (d) =>
        d.kind === kind &&
        d.deviceId !== '' &&
        d.deviceId !== 'default' &&
        d.deviceId !== 'communications'
    )
    return {
      devs: rows.map((d, i) => ({ id: d.deviceId, label: d.label || `${name} ${i + 1}` })),
      hidden: rows.some((d) => !d.label)
    }
  }
  const ins = pick('audioinput', 'Microphone')
  const outs = pick('audiooutput', 'Speakers')
  return { inputs: ins.devs, outputs: outs.devs, inputLabelsHidden: ins.hidden }
}

export async function getAudioDevices(): Promise<AudioDevices> {
  // mac shows the TCC prompt on first use; other platforms answer instantly.
  // A denial still lets us enumerate — inputs just come back unnamed.
  const allowed = await window.singz.askMicAccess().catch(() => false)
  let list = await navigator.mediaDevices.enumerateDevices()
  if (allowed && list.some((d) => d.kind === 'audioinput' && !d.label)) {
    // Labels unlock after one real capture — open the shortest-lived
    // stream possible and ask again.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((t) => t.stop())
      list = await navigator.mediaDevices.enumerateDevices()
    } catch {
      // capture refused — unnamed rows still work, they are just anonymous
    }
  }
  return shapeDevices(list)
}
