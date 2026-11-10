import { useCallback, useEffect, useRef, useState } from 'react'
import type { BoxPreferences, BoxState } from '../../../../shared/box-contract'
import { prepareBoxLocale } from '../i18n'
import { getBoxApi, errorText } from './api'
import { tJourney } from './i18n'
import { hydrateAuthoritativePreferences, type JourneyLanguage } from './preferences-model'
import { useJourneyResource } from './resource'
import type { JourneyHubProps, SafeAreaPercent } from './types'

export type { JourneyLanguage } from './preferences-model'

export function usePreferences(latest: { current: JourneyHubProps }) {
  const resource = useJourneyResource<BoxState>()
  const service = useRef(resource)
  service.current = resource
  const [saving, setSaving] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const busy = useRef(false)
  const localeVersion = useRef(0)
  const localeQueue = useRef<Promise<void>>(Promise.resolve())

  const applyLocale = useCallback((language: JourneyLanguage, isCurrent: () => boolean): Promise<void> => {
    const version = ++localeVersion.current
    const run = async (): Promise<void> => {
      if (version !== localeVersion.current || !isCurrent()) return
      await prepareBoxLocale(language)
    }
    const next = localeQueue.current.then(run, run)
    localeQueue.current = next.then(() => undefined, () => undefined)
    return next
  }, [])

  const hydrate = useCallback((state: BoxState, token: number): Promise<boolean> => {
    const current = service.current
    return hydrateAuthoritativePreferences(state.preferences, {
      isCurrent: () => current.current(token),
      applyLocale: language => applyLocale(language, () => current.current(token)),
      onSafeAreaChange: percent => latest.current.onSafeAreaChange(percent)
    })
  }, [applyLocale, latest])

  const refresh = useCallback(async (): Promise<BoxState | null> => {
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      return null
    }
    try {
      const result = await api.getState()
      if (!result.ok) {
        current.fail(token, result.error)
        return null
      }
      if (!await hydrate(result.value, token)) return null
      current.succeed(token, result.value)
      return result.value
    } catch (error) {
      current.fail(token, errorText(error))
      return null
    }
  }, [hydrate])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async (patch: Partial<BoxPreferences>): Promise<boolean> => {
    if (busy.current) return false
    busy.current = true
    setSaving(true)
    const current = service.current
    const token = current.begin()
    const api = getBoxApi()
    if (!api) {
      current.fail(token, tJourney('journey.noService'))
      busy.current = false
      setSaving(false)
      return false
    }
    try {
      const result = await api.setPreferences(patch)
      if (!result.ok) {
        current.fail(token, result.error)
        return false
      }
      if (!await hydrate(result.value, token)) return false
      current.succeed(token, result.value)
      return current.current(token)
    } catch (error) {
      current.fail(token, errorText(error))
      return false
    } finally {
      busy.current = false
      setSaving(false)
    }
  }, [hydrate])

  const setSafeArea = useCallback((percent: SafeAreaPercent): Promise<boolean> =>
    save({ safeAreaPercent: percent }), [save])
  const setLanguage = useCallback((language: JourneyLanguage): Promise<boolean> =>
    save({ language }), [save])

  const finishSetup = useCallback(async (): Promise<boolean> => {
    if (finishing) return false
    setFinishing(true)
    const saved = await save({ setupComplete: true })
    setFinishing(false)
    if (saved) latest.current.onBack()
    return saved
  }, [finishing, latest, save])

  return {
    state: resource.state.value,
    loading: resource.state.loading,
    error: resource.state.error,
    saving,
    refresh,
    setSafeArea,
    setLanguage,
    finishSetup,
    finishing
  }
}
