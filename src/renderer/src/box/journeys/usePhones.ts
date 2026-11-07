import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoxAPI, BoxPhoneState, BoxResult } from '../../../../shared/box-contract'
import { getBoxApi, errorText } from './api'
import { tJourney } from './i18n'
import { useJourneyResource } from './resource'

export function usePhones(active: boolean, visible: () => boolean) {
  const resource = useJourneyResource<BoxPhoneState>()
  const service = useRef(resource)
  service.current = resource
  const operation = useRef(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [updated, setUpdated] = useState(false)

  const refresh = useCallback(async (): Promise<BoxPhoneState | null> => {
    if (operation.current) return null
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      return null
    }
    try {
      const result = await api.phoneState()
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
    }, 2500)
    return () => clearInterval(timer)
  }, [active, refresh, visible])

  const run = useCallback(async (
    label: string,
    command: (api: BoxAPI) => Promise<BoxResult<BoxPhoneState> | BoxResult<null>>
  ): Promise<boolean> => {
    if (operation.current) return false
    operation.current = true
    setBusy(label)
    setUpdated(false)
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      operation.current = false
      setBusy(null)
      return false
    }
    try {
      const result = await command(api)
      if (!result.ok) {
        current.fail(token, result.error)
        return false
      }
      const state = result.value === null ? await api.phoneState() : result
      if (!state.ok) {
        current.fail(token, state.error)
        return false
      }
      current.succeed(token, state.value)
      setUpdated(true)
      return true
    } catch (error) {
      current.fail(token, errorText(error))
      return false
    } finally {
      operation.current = false
      setBusy(null)
    }
  }, [])

  const revokeAll = useCallback(async (): Promise<boolean> => {
    if (operation.current) return false
    operation.current = true
    setBusy('all')
    setUpdated(false)
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      operation.current = false
      setBusy(null)
      return false
    }
    try {
      const before = await api.phoneState()
      if (!before.ok) {
        current.fail(token, before.error)
        return false
      }
      for (const session of before.value.sessions) {
        const revoked = await api.phoneRevoke(session.sessionId)
        if (!revoked.ok) {
          current.fail(token, revoked.error)
          return false
        }
        current.succeed(token, revoked.value)
      }
      const stopped = await api.phoneStop()
      if (!stopped.ok) {
        current.fail(token, stopped.error)
        return false
      }
      const after = await api.phoneState()
      if (!after.ok) {
        current.fail(token, after.error)
        return false
      }
      current.succeed(token, after.value)
      setUpdated(true)
      return true
    } catch (error) {
      current.fail(token, errorText(error))
      return false
    } finally {
      operation.current = false
      setBusy(null)
    }
  }, [])

  return {
    state: resource.state.value,
    loading: resource.state.loading,
    error: resource.state.error,
    busy,
    updated,
    refresh,
    start: () => run('start', api => api.phoneStart()),
    stop: () => run('stop', api => api.phoneStop()),
    approve: (requestId: string) => run(requestId, api => api.phoneApprove(requestId)),
    deny: (requestId: string) => run(requestId, api => api.phoneDeny(requestId)),
    revoke: (sessionId: string) => run(sessionId, api => api.phoneRevoke(sessionId)),
    revokeAll
  }
}
