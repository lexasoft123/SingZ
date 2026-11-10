import { useCallback, useEffect, useRef } from 'react'
import type { BoxDiagnostics } from '../../../../shared/box-contract'
import { getBoxApi, errorText } from './api'
import { tJourney } from './i18n'
import { useJourneyResource } from './resource'

export function useDiagnostics(active: boolean) {
  const resource = useJourneyResource<BoxDiagnostics>()
  const service = useRef(resource)
  service.current = resource

  const refresh = useCallback(async (): Promise<void> => {
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      return
    }
    try {
      const result = await api.diagnostics()
      if (result.ok) current.succeed(token, result.value)
      else current.fail(token, result.error)
    } catch (error) {
      current.fail(token, errorText(error))
    }
  }, [])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  return {
    diagnostics: resource.state.value,
    loading: resource.state.loading,
    error: resource.state.error,
    refresh
  }
}
