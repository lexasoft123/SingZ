import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoxPlatformCommand, BoxPlatformSnapshot } from '../../../../shared/box-contract'
import { getBoxApi, errorText } from './api'
import { tJourney } from './i18n'
import { requestPlatformCommand } from './platform-command'
import { useJourneyResource } from './resource'
import type { JourneyHubProps } from './types'

export type PlatformCommand = BoxPlatformCommand['type']

export function usePlatform(
  active: boolean,
  visible: () => boolean,
  latest: { current: JourneyHubProps }
) {
  const resource = useJourneyResource<BoxPlatformSnapshot>()
  const service = useRef(resource)
  service.current = resource
  const operation = useRef<PlatformCommand | null>(null)
  const [busy, setBusy] = useState<PlatformCommand | null>(null)

  const refresh = useCallback(async (): Promise<BoxPlatformSnapshot | null> => {
    if (operation.current) return null
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      return null
    }
    try {
      const result = await api.platformSnapshot()
      if (!result.ok) {
        current.fail(token, result.error)
        return null
      }
      current.succeed(token, result.value)
      return result.value
    } catch (error) {
      current.fail(token, errorText(error))
      return null
    }
  }, [])

  useEffect(() => {
    if (!active) return
    void refresh()
    const timer = setInterval(() => {
      if (visible() && !document.hidden) void refresh()
    }, 3000)
    return () => clearInterval(timer)
  }, [active, refresh, visible])

  const run = useCallback(async (command: PlatformCommand): Promise<boolean> => {
    if (operation.current) return false
    operation.current = command
    setBusy(command)
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      operation.current = null
      setBusy(null)
      return false
    }
    try {
      const result = await requestPlatformCommand(api, command, () => latest.current.playbackActive,
        snapshot => current.succeed(token, snapshot))
      if (!result.ok) {
        current.fail(token, result.error)
        return false
      }
      current.succeed(token, result.value)
      return true
    } catch (error) {
      current.fail(token, errorText(error))
      return false
    } finally {
      operation.current = null
      setBusy(null)
    }
  }, [latest])

  return {
    snapshot: resource.state.value,
    loading: resource.state.loading,
    error: resource.state.error,
    busy,
    refresh,
    run
  }
}
