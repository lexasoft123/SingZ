import { useCallback, useEffect, useRef } from 'react'
import type { BoxDiagnostics, BoxRoutingState } from '../../../../shared/box-contract'
import { getBoxApi, errorText } from './api'
import { tJourney } from './i18n'
import { useJourneyResource } from './resource'

type DiagnosticsSnapshot = {
  diagnostics: BoxDiagnostics
  routing: BoxRoutingState | null
  routingError: string | null
}

export function useDiagnostics(active: boolean) {
  const resource = useJourneyResource<DiagnosticsSnapshot>()
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
      const [result, routing] = await Promise.all([api.diagnostics(), api.routingSnapshot()])
      if (result.ok) current.succeed(token, {
        diagnostics: result.value,
        routing: routing.ok ? routing.value : null,
        routingError: routing.ok ? null : routing.error
      })
      else current.fail(token, result.error)
    } catch (error) {
      current.fail(token, errorText(error))
    }
  }, [])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  return {
    diagnostics: resource.state.value?.diagnostics ?? null,
    routing: resource.state.value?.routing ?? null,
    routingError: resource.state.value?.routingError ?? null,
    loading: resource.state.loading,
    error: resource.state.error,
    refresh
  }
}
