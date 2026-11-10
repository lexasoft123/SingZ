import { useCallback, useEffect, useRef, useState } from 'react'
import type { SingzApi } from '../../../../shared/types'
import type { JourneyAudioInventory } from './format'
import { errorText } from './api'
import { tJourney } from './i18n'
import { useJourneyResource } from './resource'
import { signOutAndReadInventory } from './activity'

export type DriveStatus = Awaited<ReturnType<typeof window.singz.gdriveStatus>>

export function useInventory(audioActive: boolean, driveActive: boolean, onSignOut?: () => Promise<boolean>) {
  const signOutOwner = useRef(onSignOut)
  signOutOwner.current = onSignOut
  const audio = useJourneyResource<JourneyAudioInventory>()
  const drive = useJourneyResource<DriveStatus>()
  const audioService = useRef(audio)
  const driveService = useRef(drive)
  audioService.current = audio
  driveService.current = drive
  const signingOut = useRef(false)
  const [busy, setBusy] = useState(false)

  const refreshAudio = useCallback(async (): Promise<void> => {
    const current = audioService.current
    const token = current.begin()
    try {
      const result = await readJourneyAudioInventory(window.singz, window.singz.boxAudioPersistent)
      if (result.ok) {
        current.succeed(token, result)
        if (result.physicalInputError) current.fail(token, result.physicalInputError)
      }
      else current.fail(token, result.error)
    } catch (error) {
      current.fail(token, errorText(error))
    }
  }, [])

  const refreshDrive = useCallback(async (): Promise<DriveStatus | null> => {
    const current = driveService.current
    const token = current.begin()
    try {
      const result = await window.singz.gdriveStatus()
      current.succeed(token, result)
      return result
    } catch (error) {
      current.fail(token, errorText(error))
      return null
    }
  }, [])

  useEffect(() => {
    if (audioActive) void refreshAudio()
  }, [audioActive, refreshAudio])
  useEffect(() => {
    if (driveActive) void refreshDrive()
  }, [driveActive, refreshDrive])

  const signOut = useCallback(async (): Promise<boolean> => {
    if (signingOut.current) return false
    signingOut.current = true
    setBusy(true)
    const current = driveService.current
    const token = current.begin()
    try {
      const result = await signOutAndReadInventory(signOutOwner.current, () => window.singz.gdriveStatus())
      current.succeed(token, result.status)
      if (!result.complete) {
        current.fail(token, tJourney('journey.unavailable'))
        return false
      }
      return true
    } catch (error) {
      current.fail(token, errorText(error))
      return false
    } finally {
      signingOut.current = false
      setBusy(false)
    }
  }, [])

  return {
    audio: audio.state.value,
    audioLoading: audio.state.loading,
    audioError: audio.state.error,
    drive: drive.state.value,
    driveLoading: drive.state.loading,
    driveError: drive.state.error,
    signingOut: busy,
    refreshAudio,
    refreshDrive,
    signOut
  }
}

/** Read-only summary override, not a synthetic physical playback inventory. */
export async function readJourneyAudioInventory(api: Pick<SingzApi, 'audioHostDevices' | 'captureInputDevices'>, persistent: boolean): Promise<JourneyAudioInventory> {
  const physical = persistent ? api.captureInputDevices().then(result => result.ok
    ? { count: result.devices.filter(device => device.channels > 0).length }
    : { count: null, error: result.error }).catch(error => ({ count: null, error: errorText(error) })) : null
  const [audio, inputs] = await Promise.all([api.audioHostDevices(), physical])
  return inputs ? { ...audio, physicalInputCount: inputs.count, physicalInputError: 'error' in inputs ? inputs.error : undefined } : audio
}
