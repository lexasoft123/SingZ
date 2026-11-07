import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoxStorageSnapshot } from '../../../../shared/box-contract'
import { getBoxApi, errorText } from './api'
import { tJourney } from './i18n'
import { cacheRemovalIssue } from './model'
import { useJourneyResource } from './resource'
import type { JourneyHubProps } from './types'

export function useStorage(active: boolean, latest: { current: JourneyHubProps }) {
  const resource = useJourneyResource<BoxStorageSnapshot>()
  const service = useRef(resource)
  service.current = resource
  const removing = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [removed, setRemoved] = useState(false)

  const refresh = useCallback(async (): Promise<BoxStorageSnapshot | null> => {
    if (removing.current) return null
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      return null
    }
    try {
      const result = await api.storageSnapshot()
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
    if (active) void refresh()
  }, [active, refresh])

  const remove = useCallback(async (dir: string, requireIdle: boolean): Promise<boolean> => {
    if (removing.current) return false
    const issue = cacheRemovalIssue(
      dir,
      latest.current.activeProjectDir,
      latest.current.playbackActive,
      requireIdle
    )
    const current = service.current
    const token = current.begin()
    if (issue) {
      current.fail(token, tJourney(issue === 'active-project' ? 'journey.storage.active' : 'journey.playbackActive'))
      return false
    }
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      return false
    }
    removing.current = true
    setBusy(dir)
    setRemoved(false)
    let succeeded = false
    try {
      const freshIssue = cacheRemovalIssue(
        dir,
        latest.current.activeProjectDir,
        latest.current.playbackActive,
        requireIdle
      )
      if (freshIssue) {
        current.fail(token, tJourney(freshIssue === 'active-project' ? 'journey.storage.active' : 'journey.playbackActive'))
        return false
      }
      const result = await api.removeCachedProject(dir)
      if (!result.ok) {
        current.fail(token, result.error)
        return false
      }
      latest.current.onLibraryChanged()
      setRemoved(true)
      succeeded = true
      return true
    } catch (error) {
      current.fail(token, errorText(error))
      return false
    } finally {
      removing.current = false
      setBusy(null)
      if (succeeded) void refresh()
    }
  }, [latest, refresh])

  return {
    snapshot: resource.state.value,
    loading: resource.state.loading,
    error: resource.state.error,
    busy,
    removed,
    refresh,
    remove
  }
}
