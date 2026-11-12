import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { ConfirmationDialog } from './ConfirmationDialog'
import { retryBoot } from './boot'
import { journeyActivity } from './activity'
import { DiagnosticsPage } from './DiagnosticsPage'
import { HomePage } from './HomePage'
import { acquireJourneyFocus } from './focus'
import { runJourneyConfirmation } from './confirm'
import { tJourney } from './i18n'
import {
  initialJourney, journeyBack, settingsSetupEntry, journeyInteractionLocked, journeyReducer, wifiStartNeedsConfirmation, type Confirmation, type JourneyAction
} from './model'
import { NetworkPage } from './NetworkPage'
import { PhonesPage } from './PhonesPage'
import { PrivacyPage } from './PrivacyPage'
import { SetupPage } from './SetupPage'
import { StoragePage } from './StoragePage'
import { SystemPage } from './SystemPage'
import { useDiagnostics } from './useDiagnostics'
import { useInventory } from './useInventory'
import { usePhones } from './usePhones'
import { usePlatform } from './usePlatform'
import { usePreferences } from './usePreferences'
import { useStorage } from './useStorage'
import type { JourneyHubHandle, JourneyHubProps, JourneyPage } from './types'
import './journeys.css'

export type { JourneyHubHandle, JourneyHubProps, JourneyPage } from './types'

function useClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export const JourneyHub = forwardRef<JourneyHubHandle, JourneyHubProps>(function JourneyHub(props, ref) {
  const latest = useRef(props)
  latest.current = props
  const root = useRef<HTMLElement>(null)
  /** The Settings row last focused on the home page: Back from a sub-page (or from the audio
   * and Drive screens that live outside the hub) returns focus there. A fresh entry clears it. */
  const homeRow = useRef<string | null>(null)
  const [model, setModel] = useState(() => initialJourney(props.initialPage))
  const state = useRef(model)
  state.current = model
  const dispatch = useCallback((action: JourneyAction) => setModel(current => journeyReducer(current, action)), [])
  const visible = useCallback(() => latest.current.active !== false && (root.current?.getClientRects().length ?? 0) > 0, [])
  const page = model.page
  const activity = journeyActivity(props.active !== false, page)
  const preferences = usePreferences(latest)
  const platform = usePlatform(activity.platform, visible, latest)
  const authoritativePlatform = useRef(platform.snapshot)
  authoritativePlatform.current = platform.snapshot
  const inventory = useInventory(activity.audio, activity.drive, props.onSignOut)
  const phones = usePhones(activity.phones, visible)
  const storage = useStorage(activity.storage, latest)
  const diagnostics = useDiagnostics(activity.diagnostics)
  const now = useClock(activity.clock)

  useEffect(() => {
    if (platform.snapshot) dispatch({ type: 'platform', snapshot: platform.snapshot })
  }, [dispatch, platform.snapshot])

  const interactionBusy = useRef({ preferences: false, platform: false, phones: false, storage: false, drive: false })
  interactionBusy.current = {
    preferences: preferences.saving || preferences.finishing,
    platform: platform.busy !== null && platform.busy !== 'update-check',
    phones: phones.busy !== null,
    storage: storage.busy !== null,
    drive: inventory.signingOut
  }
  const isInteractionLocked = useCallback((): boolean =>
    journeyInteractionLocked(state.current, interactionBusy.current, authoritativePlatform.current), [])

  const back = useCallback((): boolean => {
    if (isInteractionLocked() && !state.current.confirmation && !state.current.committed) return true
    const resolved = journeyBack(state.current)
    if (resolved.effect === 'exit') latest.current.onBack()
    else if (resolved.effect === 'consumed') setModel(resolved.state)
    return true
  }, [isInteractionLocked])

  const open = useCallback((page: JourneyPage) => {
    if (!isInteractionLocked()) dispatch({ type: 'open', page })
  }, [dispatch, isInteractionLocked])

  const openFromOutside = useCallback((destination: JourneyPage) => {
    if (destination === 'home') homeRow.current = null
    open(destination)
  }, [open])
  useImperativeHandle(ref, () => ({ back, open: openFromOutside, isInteractionLocked }), [back, openFromOutside, isInteractionLocked])

  const acquiredFocus = useRef<number | null>(null)
  // The control that opened a confirmation regains focus when it closes (long Remove/Revoke lists).
  const confirmationOpener = useRef<Element | null>(null)
  const acquireFocus = useCallback(() => {
    const scope = root.current
    if (!scope || !visible()) {
      acquiredFocus.current = null
      return
    }
    if (document.hidden) return
    const opener = state.current.confirmation ? null : confirmationOpener.current
    acquiredFocus.current = acquireJourneyFocus(
      scope, document.activeElement, document.body, state.current.focusRevision, acquiredFocus.current, opener,
      state.current.page === 'home' ? homeRow.current : null
    )
    if (opener && acquiredFocus.current === state.current.focusRevision) confirmationOpener.current = null
  }, [visible])

  // Readiness can change without a route revision; repair only missing/invalid focus.
  useLayoutEffect(acquireFocus)
  useEffect(() => {
    document.addEventListener('visibilitychange', acquireFocus)
    window.addEventListener('focus', acquireFocus)
    return () => {
      document.removeEventListener('visibilitychange', acquireFocus)
      window.removeEventListener('focus', acquireFocus)
    }
  }, [acquireFocus])

  const requestConfirmation = useCallback((confirmation: Confirmation) => {
    if (isInteractionLocked()) return
    confirmationOpener.current = document.activeElement
    dispatch({ type: 'confirm', confirmation })
  }, [dispatch, isInteractionLocked])
  const networkCommand = (command: 'wifi-start' | 'wifi-cancel'): void => {
    if (command === 'wifi-start' && wifiStartNeedsConfirmation(platform.snapshot)) requestConfirmation({ kind: 'wifi-switch' })
    else void platform.run(command)
  }
  const confirm = useCallback(async (): Promise<void> => {
    const confirmation = state.current.confirmation
    if (!confirmation || confirmation.pending) return
    dispatch({ type: 'confirm-start' })
    try {
      await runJourneyConfirmation(confirmation, {
        removeCache: storage.remove,
        revokePhone: phones.revoke,
        revokeAllPhones: phones.revokeAll,
        signOut: inventory.signOut,
        runPlatform: platform.run,
        refreshAfterReset: () => Promise.all([preferences.refresh(), inventory.refreshDrive(), storage.refresh(), phones.refresh()]),
        onLibraryChanged: () => latest.current.onLibraryChanged(),
        onAccountChanged: () => latest.current.onAccountChanged?.()
      })
    } finally {
      dispatch({ type: 'confirm-finish' })
    }
  }, [dispatch, inventory, phones, platform, preferences, storage])

  const retrySetup = (): void => retryBoot({
    preferences: () => { void preferences.refresh() },
    platform: () => { void platform.refresh() },
    audio: () => { void inventory.refreshAudio() },
    drive: () => { void inventory.refreshDrive() }
  })
  const setupNetwork = (): void => open('network')
  const pageError = preferences.error ?? platform.error ?? inventory.audioError ?? inventory.driveError

  return <main
    ref={root}
    className="journey-hub"
    data-surface="settings"
    data-journey-page={page}
    onFocus={event => {
      const row = event.target instanceof HTMLElement && event.target.matches('.journey-row') ? event.target.dataset.focus : undefined
      if (row && state.current.page === 'home') homeRow.current = row
    }}
    data-committed-operation={model.committed ?? undefined}
    aria-label={tJourney('journey.settings')}
  >
    <div className="journey-page-layer" inert={model.confirmation ? true : undefined}>
    {page === 'home' && <HomePage
      audio={inventory.audio} platform={platform.snapshot} drive={inventory.drive} phones={phones.state} storage={storage.snapshot}
      loading={platform.loading || inventory.audioLoading} error={pageError} onBack={back}
      onOpen={destination => destination === 'setup'
        ? dispatch({ type: 'open-setup', stage: settingsSetupEntry(preferences.state?.preferences.setupComplete) })
        : open(destination)}
      onOpenAudio={props.onOpenAudio} onOpenCollection={props.onOpenCollection}
    />}
    {page === 'setup' && <SetupPage
      stage={model.setupStage} box={preferences.state} platform={platform.snapshot} audio={inventory.audio} drive={inventory.drive}
      loading={preferences.loading || platform.loading || inventory.audioLoading} error={pageError} finishing={preferences.finishing}
      onStage={stage => dispatch({ type: 'setup-stage', stage })} onStep={delta => dispatch({ type: 'setup-step', delta })}
      onNetwork={setupNetwork} onRetry={retrySetup} onAudio={props.onOpenAudio} onCollection={props.onOpenCollection}
      onSafeArea={percent => { void preferences.setSafeArea(percent) }} onLanguage={language => { void preferences.setLanguage(language) }}
      onFinish={() => { void preferences.finishSetup() }} onBack={back}
    />}
    {page === 'network' && <NetworkPage
      snapshot={platform.snapshot} loading={platform.loading} error={platform.error} busy={platform.busy} now={now}
      onRefresh={() => { void platform.refresh() }} onCommand={networkCommand} onBack={back}
    />}
    {page === 'phones' && <PhonesPage
      state={phones.state} loading={phones.loading} error={phones.error} busy={phones.busy} updated={phones.updated} now={now}
      onStart={() => { void phones.start() }} onStop={() => requestConfirmation({ kind: 'phone-stop' })}
      onApprove={id => { void phones.approve(id) }} onDeny={id => { void phones.deny(id) }}
      onRevoke={(sessionId, name) => requestConfirmation({ kind: 'phone-revoke', sessionId, name })} onBack={back}
    />}
    {page === 'storage' && <StoragePage
      snapshot={storage.snapshot} activeProjectDir={props.activeProjectDir} loading={storage.loading} error={storage.error}
      busy={storage.busy} removed={storage.removed} onRefresh={() => { void storage.refresh() }}
      onRemove={(dir, name, bytes) => requestConfirmation({ kind: 'remove-cache', dir, name, bytes, requireIdle: false })} onBack={back}
    />}
    {page === 'diagnostics' && <DiagnosticsPage
      diagnostics={diagnostics.diagnostics} loading={diagnostics.loading} error={diagnostics.error}
      onRefresh={() => { void diagnostics.refresh() }} onAudio={props.onOpenAudio}
      onSetup={() => dispatch({ type: 'open-setup' })} onBack={back}
    />}
    {page === 'system' && <SystemPage
      snapshot={platform.snapshot} playbackActive={props.playbackActive} loading={platform.loading} error={platform.error} busy={platform.busy}
      onRefresh={() => { void platform.refresh() }} onCommand={command => { void platform.run(command) }}
      onConfirm={kind => requestConfirmation({ kind })} onBack={back}
    />}
    {page === 'privacy' && <PrivacyPage
      drive={inventory.drive} phones={phones.state} storage={storage.snapshot} platform={platform.snapshot}
      activeProjectDir={props.activeProjectDir} playbackActive={props.playbackActive}
      loading={inventory.driveLoading || phones.loading || storage.loading}
      error={inventory.driveError ?? phones.error ?? storage.error ?? platform.error} busy={inventory.signingOut || phones.busy !== null || storage.busy !== null || platform.busy !== null}
      onConnect={props.onOpenCollection} onSignOut={() => requestConfirmation({ kind: 'drive-signout' })}
      onStopPhones={() => requestConfirmation({ kind: 'phone-stop' })}
      onRemove={(dir, name, bytes) => requestConfirmation({ kind: 'remove-cache', dir, name, bytes, requireIdle: true })}
      onReset={() => requestConfirmation({ kind: 'factory-reset' })} onBack={back}
    />}
    </div>
    {model.confirmation && <ConfirmationDialog
      confirmation={model.confirmation} onCancel={() => dispatch({ type: 'confirm-cancel' })} onConfirm={() => { void confirm() }}
    />}
  </main>
})
