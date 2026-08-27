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

/** A native uid is always the training identity. This label match is only a
 * best-effort bridge for Chromium's live preview; ambiguous labels deliberately
 * fall back to Chromium's system default instead of selecting the wrong mic. */
export function chromiumInputIdForNative(
  nativeDevice: DesktopAudioInputDevice,
  chromiumInputs: readonly AudioDeviceInfo[]
): string | undefined {
  const label = nativeDevice.label.trim().toLocaleLowerCase()
  if (!label) return undefined
  const matches = chromiumInputs.filter(
    (candidate) => candidate.label.trim().toLocaleLowerCase() === label
  )
  return matches.length === 1 ? matches[0].id : undefined
}

/** Upgrade bridge for prefs written before native AudioInput UIDs existed.
 * Both sides must have one unambiguous label match; otherwise the caller must
 * keep using the legacy Chromium capture until the singer makes a new choice. */
export function nativeInputUidForChromium(
  chromiumId: string,
  chromiumInputs: readonly AudioDeviceInfo[],
  nativeInputs: readonly DesktopAudioInputDevice[]
): string | undefined {
  const chromium = chromiumInputs.find((candidate) => candidate.id === chromiumId)
  const label = chromium?.label.trim().toLocaleLowerCase()
  if (!label) return undefined
  const matches = nativeInputs.filter(
    (candidate) => candidate.label.trim().toLocaleLowerCase() === label
  )
  return matches.length === 1 ? matches[0].uid : undefined
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

export async function getAudioDevices(options: { requestAccess?: boolean } = {}): Promise<AudioDevices> {
  // mac shows the TCC prompt on first use; other platforms answer instantly.
  // A denial still lets us enumerate — inputs just come back unnamed.
  const shouldRequest = options.requestAccess !== false
  const allowed = shouldRequest ? await window.singz.askMicAccess().catch(() => false) : false
  let list = await navigator.mediaDevices.enumerateDevices()
  if (shouldRequest && allowed && list.some((d) => d.kind === 'audioinput' && !d.label)) {
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
import type { DesktopAudioInputDevice } from '../../../shared/types'
