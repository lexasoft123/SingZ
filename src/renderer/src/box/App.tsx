import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { applyPlatformClasses } from '@singz/ui'
import type { BoxAPI, BoxMetronomeOverride, BoxControllerEnvelope, BoxControllerResponse, BoxQueueRef } from '../../../shared/box-contract'
import type { DesktopAudioHostInventoryResult, ProjectListItem } from '../../../shared/types'
import { MultitrackEngine } from '../audio/engine'
import { boxNativePlaybackPolicy } from './playback-policy'
import { useLocale } from '../i18n'
import { Catalog, type CatalogRow } from './Catalog'
import { catalogFocusTarget, focusPrimaryNavigation, moveSpatialFocus, pickMixerFocusId, rangeOwnsArrow, remoteScope, seekKeepsFocus } from './focus'
import { LatestOpenIntent } from './open-intent'
import { Player } from './Player'
import { BoxMicrophones } from './microphones'
import { clampTranspose } from './key-change'
import { Mixer, type MixerTab } from './Mixer'
import { Queue } from './Queue'
import { playbackStatus } from './playback-status'
import { RemoteKeyGate, scheduleControlsHide } from './remote'
import { Settings } from './Settings'
import { applyBoxMetronomePolicy, boxMetronomePreference, MetronomePolicyError } from './metronome-policy'
import { RetainedPlayback } from './RetainedPlayback'
import { restoreRetainedEntry, routeRestoredPlayback } from './retained-playback'
import { closeBoxSession } from './close-session'
import { t } from './i18n'
import { tSettings } from './settings-i18n'
import { BoxSettingsNavigator, accountReturnFromHub, detailsReturnRoute, overlayReturnRoute, routeAfterFailedOpen, routeWhileOpening, type BoxRoute } from './settings-navigation'
import { SongDetails } from './SongDetails'
import { StartupOverlay } from './StartupOverlay'
import { SwitchDialog, type SwitchMode } from './SwitchDialog'
import { BoxTransport } from './transport'
import { cancelPreviewStart } from './preview-start'
import { BoxNavigation } from './Navigation'
import { useFixedTvFrame } from './useFixedTvFrame'
import { JourneyHub, type JourneyHubHandle, type JourneyPage } from './journeys/JourneyHub'
import { BoxCollectionController } from './collection/BoxCollectionController'
import { Account } from './collection/Account'
import { BoxPhoneProjection, sanitizeControllerCommand } from './collection/phone'
import {
  addQueueEntry, BOX_QUEUE_LIMIT, boxCloseWork, BoxQueueStore, entriesWithQueueRefs, moveQueueViewDir,
  projectQueue, queueEntryForViewDir, queueHasEntry, queueRefForEntry, removeQueueViewDir
} from './collection/queue'
import { parseSongName } from './song-identity'
import { moveQueueRefInView } from './queue-model'
import { endedFocusControl, switchNeedsConfirmation, nextSwitchMode, nextQueued, queueAfterAdvance } from './next-song'
import { resolveCollectionSelection, type CollectionEntry } from './collection/types'
import { hydrateBoxLocally } from './collection/startup'
import './collection/collection.css'

applyPlatformClasses()

export default function BoxApp(): React.JSX.Element {
  useLocale()
  const boxApiRef = useRef<BoxAPI | null>(null)
  if (!boxApiRef.current) boxApiRef.current = window.singz.box
  const boxApi = boxApiRef.current
  const transportRef = useRef<BoxTransport | null>(null)
  if (!transportRef.current) {
    const nativePolicy = boxNativePlaybackPolicy()
    transportRef.current = new BoxTransport(window.singz, new MultitrackEngine(nativePolicy), {
      nativePlaybackEnabled: nativePolicy?.playback
    })
  }
  const transport = transportRef.current
  const microphones = useMemo(() => new BoxMicrophones(boxApi), [])
  // Live microphone telemetry is subscribed by leaf surfaces (Player meters,
  // Mixer rows, Settings) so 5 Hz levels never re-render the whole BoxApp.
  useEffect(() => {
    microphones.connect()
    // Stop reading only. Analysis belongs to the audio host and outlives this UI.
    return () => microphones.dispose()
  }, [microphones])
  const collectionRef = useRef<BoxCollectionController | null>(null)
  if (!collectionRef.current) {
    collectionRef.current = new BoxCollectionController({
      ...window.singz,
      storageSnapshot: () => boxApi.storageSnapshot()
    })
  }
  const collection = collectionRef.current
  const signOutDrive = useCallback(() => collection.signOut(), [collection])
  const queueStoreRef = useRef<BoxQueueStore | null>(null)
  if (!queueStoreRef.current) queueStoreRef.current = new BoxQueueStore(boxApi)
  const queueStore = queueStoreRef.current
  const flushPrivateState = useCallback(async (): Promise<void> => {
    await queueStore.flush(); microphones.dispose()
  }, [queueStore, microphones])
  const phoneProjectionRef = useRef<BoxPhoneProjection | null>(null)
  if (!phoneProjectionRef.current) phoneProjectionRef.current = new BoxPhoneProjection()
  const phoneProjection = phoneProjectionRef.current
  const snapshot = useSyncExternalStore(transport.subscribe, transport.getSnapshot)
  const collectionSnapshot = useSyncExternalStore(collection.subscribe, collection.getSnapshot)
  const queueSnapshot = useSyncExternalStore(queueStore.subscribe, queueStore.getSnapshot)
  const viewportRef = useRef<HTMLDivElement>(null)
  const tvRef = useRef<HTMLDivElement>(null)
  const hubRef = useRef<JourneyHubHandle>(null)
  const frame = useFixedTvFrame(viewportRef)
  const [route, setRoute] = useState<BoxRoute>('catalog')
  const [hydrated, setHydrated] = useState(false)
  const [metronomeMode, setMetronomeMode] = useState<BoxMetronomeOverride | null>(null)
  const [metronomeBusy, setMetronomeBusy] = useState(false)
  const [metronomeError, setMetronomeError] = useState<string | null>(null)
  const metronomePending = useRef(false)
  const metronomeReady = useRef(false)
  const metronomeBlocked = useRef(true)
  const metronomeFailure = useCallback((error: unknown): void => {
    setMetronomeMode(error instanceof MetronomePolicyError ? error.safeMode : null)
    setMetronomeError(tSettings('box.settings.metronomeFailed', { error: error instanceof Error ? error.message : String(error) }))
    metronomeBlocked.current = true
  }, [])
  const changeMetronome = useCallback(async (mode: BoxMetronomeOverride): Promise<void> => {
    if (metronomePending.current) return
    metronomePending.current = true
    metronomeBlocked.current = true
    setMetronomeBusy(true)
    setMetronomeError(null)
    try {
      const applied = await applyBoxMetronomePolicy(mode, value => transport.setMetronomeOverride(value), async value => {
        const result = await boxApi.setPreferences({ metronomeOverride: value })
        if (!result.ok) throw new Error(result.error)
      })
      setMetronomeMode(applied)
      metronomeBlocked.current = false
    } catch (error) { metronomeFailure(error); throw error }
    finally { metronomePending.current = false; setMetronomeBusy(false) }
  }, [boxApi, transport, metronomeFailure])
  const [collectionReady, setCollectionReady] = useState(false)
  const [safeArea, setSafeArea] = useState<0 | 3 | 5>(0)
  const initialHubPage = useRef<JourneyPage>('home')
  const setupDecision = useRef(false)
  const hubReturn = useRef<BoxRoute>('catalog')
  const accountReturn = useRef<BoxRoute>('catalog')
  const detailsReturn = useRef<BoxRoute>('catalog')
  const settingsReturn = useRef<'home' | 'player' | 'catalog' | undefined>(undefined)
  const [settingsInventory, setSettingsInventory] = useState<DesktopAudioHostInventoryResult | null>(null)
  const [settingsInventoryLoading, setSettingsInventoryLoading] = useState(false)
  const [settingsInventoryError, setSettingsInventoryError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [queueSelectedDir, setQueueSelectedDir] = useState<string | null>(null)
  const [mixOpen, setMixOpen] = useState(false)
  const [mixTab, setMixTab] = useState<MixerTab>('main')
  const [pendingSwitch, setPendingSwitch] = useState<CollectionEntry | null>(null)
  const [signOutConfirm, setSignOutConfirm] = useState(false)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [accountError, setAccountError] = useState<string | null>(null)
  const [busyDir, setBusyDir] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [queueLimitError, setQueueLimitError] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [remoteVersion, setRemoteVersion] = useState(0)
  const [focusVersion, setFocusVersion] = useState(0)
  const focusTarget = useRef<HTMLElement | null>(null)
  const mixChannel = useRef<string | null>(null)
  const previousSelected = useRef<CollectionEntry | null>(null)
  const settingsInventoryGeneration = useRef(0)
  const hydrationGeneration = useRef(0)
  const openIntent = useRef(new LatestOpenIntent())
  const previewStartIntent = useRef<number | null>(null)
  const pendingSwitchMode = useRef<SwitchMode>('paused')
  /** Set when an open reaches the player: Play/Pause must take focus, even if it is still disabled while lyrics/output settle. */
  const playFocusPending = useRef(false)
  const lastPlayEnabled = useRef(false)
  /** Set by Next: when `to` opens, `from` (the song that just played) leaves the queue. */
  const advance = useRef<{ from: string; to: string } | null>(null)
  const lastSeekKeyAt = useRef<number | null>(null)
  const finishAdvance = useRef<(from: string) => void>(() => undefined)
  const catalogScroll = useRef(0)
  const gate = useRef(new RemoteKeyGate())
  const lastInput = useRef(performance.now())
  const openingDir = useRef<string | null>(null)
  const phonePublicationTail = useRef<Promise<void>>(Promise.resolve())
  const phoneCommandTail = useRef<Promise<void>>(Promise.resolve())
  const phoneActionsRef = useRef<(envelope: BoxControllerEnvelope) => Promise<void>>(async () => undefined)
  const queueRefs = queueStore.getRefs()
  const allEntries = entriesWithQueueRefs(collectionSnapshot.entries, queueRefs)
  const queueProjection = hydrated ? projectQueue(collectionSnapshot.entries, queueRefs) : []
  const queueItems = queueProjection.map(item => item.item)
  const nextItem = nextQueued(queueItems, snapshot.active?.item.dir ?? null)
  const nextIdentity = nextItem ? parseSongName(nextItem.name) : null
  const upNext = nextIdentity ? { title: nextIdentity.title, artist: nextIdentity.artist ?? null } : null
  const playEnabled = snapshot.active !== null && snapshot.active.lyrics.status === 'ready' && snapshot.active.lyrics.lines.length > 0 &&
    !snapshot.routingBlocked && !snapshot.applyingOutput && !snapshot.restartRequired
  const endedWithNext = nextItem !== null && playbackStatus(snapshot) === 'ended'
  const selectedEntry = resolveCollectionSelection(allEntries, selectedId, previousSelected.current, route === 'details')
  if (selectedEntry && !selectedEntry.unavailable) previousSelected.current = selectedEntry
  const active = snapshot.active
  const latest = useRef({ route, mixOpen, pendingSwitch, signOutConfirm, signOutBusy, controlsVisible, snapshot, selectedId, hydrated })
  latest.current = { route, mixOpen, pendingSwitch, signOutConfirm, signOutBusy, controlsVisible, snapshot, selectedId, hydrated }
  const latestPhone = useRef({ entries: allEntries, refs: queueRefs, rows: collectionSnapshot.rows, snapshot })
  latestPhone.current = { entries: allEntries, refs: queueRefs, rows: collectionSnapshot.rows, snapshot }
  const restoreMounted = useRef(false)
  const restoreRequest = useRef(0)
  const restoreRetained = useCallback(async (expected: { epoch: string; generation: string }): Promise<boolean> => {
    const request = ++restoreRequest.current
    const restored = await restoreRetainedEntry(restoreMounted.current, latest.current.hydrated, () => transport.restoreRetained(expected))
    return routeRestoredPlayback({
      restored,
      mounted: restoreMounted.current,
      hydrated: latest.current.hydrated,
      requestCurrent: request === restoreRequest.current,
      readActive: () => transport.getSnapshot().active,
      route: () => {
        setMixOpen(false)
        setPendingSwitch(null)
        setRoute('player')
        setControlsVisible(true)
        setFocusVersion(version => version + 1)
      }
    })
  }, [transport])

  const hubInteractionLocked = useCallback((): boolean => {
    if (latest.current.route !== 'home') return false
    return hubRef.current?.isInteractionLocked() === true
  }, [])

  const interactionLocked = useCallback((): boolean => {
    return !latest.current.hydrated || metronomePending.current || transport.getSnapshot().applyingOutput || latest.current.pendingSwitch !== null ||
      latest.current.signOutConfirm || latest.current.signOutBusy || hubInteractionLocked()
  }, [hubInteractionLocked, transport])

  const settingsNavigatorRef = useRef<BoxSettingsNavigator | null>(null)
  if (!settingsNavigatorRef.current) {
    settingsNavigatorRef.current = new BoxSettingsNavigator(
      () => ({
        applyingOutput: transport.getSnapshot().applyingOutput,
        hasCurrent: latest.current.snapshot.active !== null,
        settingsReturn: settingsReturn.current
      }),
      target => {
        setMixOpen(false)
        setPendingSwitch(null)
        setRoute(target)
        if (target === 'player') {
          setControlsVisible(true)
          setFocusVersion(version => version + 1)
        }
      }
    )
  }
  const settingsNavigator = settingsNavigatorRef.current

  const publishPhoneSnapshot = useCallback((): Promise<boolean> => {
    const operation = phonePublicationTail.current.then(async () => {
      const current = latestPhone.current
      const publicSnapshot = phoneProjection.snapshot(current.entries, current.refs, current.rows, current.snapshot)
      try {
        const result = await boxApi.publishControllerSnapshot({
          ...publicSnapshot,
          activeLocalProjectDir: current.snapshot.active?.item.dir ?? null,
          openingLocalProjectDir: openingDir.current
        })
        if (result.ok && current.snapshot.active && openingDir.current === current.snapshot.active.item.dir) {
          openingDir.current = null
        }
        return result.ok
      } catch {
        return false
      }
    })
    phonePublicationTail.current = operation.then(() => undefined, () => undefined)
    return operation
  }, [boxApi, phoneProjection])

  const hydrate = useCallback(async (refreshAccount: boolean): Promise<void> => {
    const initializing = !metronomeReady.current
    if (initializing && metronomePending.current) return
    const generation = ++hydrationGeneration.current
    if (initializing) {
      metronomePending.current = true
      metronomeBlocked.current = true
      setMetronomeBusy(true)
      setMetronomeError(null)
    }
    try {
      // First establish silence even if the profile read subsequently fails.
      if (initializing) await transport.setMetronomeOverride('off')
      const { state, localReady } = await hydrateBoxLocally(queueStore, collection, refreshAccount)
      if (generation !== hydrationGeneration.current) return
      if (initializing) {
        if (!state) throw new Error(tSettings('box.settings.metronomeUnknown'))
        const mode = boxMetronomePreference(state.preferences.metronomeOverride)
        if (mode === null) throw new Error(tSettings('box.settings.metronomeUnknown'))
        const applied = await applyBoxMetronomePolicy(mode, value => transport.setMetronomeOverride(value))
        if (generation !== hydrationGeneration.current) return
        setMetronomeMode(applied)
        metronomeReady.current = true
        metronomeBlocked.current = false
      }
      // Failed refreshes retain the last successfully verified local collection.
      setCollectionReady(current => current || localReady)
      if (state && !setupDecision.current) {
        setSafeArea(state.preferences.safeAreaPercent)
        phoneProjection.update(queueStore.getRefs(), true)
        setupDecision.current = true
        initialHubPage.current = state.preferences.setupComplete ? 'home' : 'setup'
        if (!state.preferences.setupComplete) setRoute('home')
      }
      setHydrated(true)
    } catch (error) {
      if (generation === hydrationGeneration.current) {
        // A failed initial receipt is unknown; do not unlock opening or Play.
        metronomeFailure(error)
      }
    } finally {
      if (initializing) { metronomePending.current = false; setMetronomeBusy(false) }
    }
  }, [collection, phoneProjection, queueStore, transport, metronomeFailure])

  useEffect(() => {
    void hydrate(true)
    return () => { hydrationGeneration.current++ }
  }, [hydrate])

  useEffect(() => {
    restoreMounted.current = true
    return () => { restoreMounted.current = false; restoreRequest.current++ }
  }, [])

  useEffect(() => {
    if (!hydrated || !collectionReady || !queueSnapshot.loaded) return
    void publishPhoneSnapshot()
    const timer = setInterval(() => { void publishPhoneSnapshot() }, 2000)
    return () => clearInterval(timer)
  }, [hydrated, collectionReady, queueSnapshot.loaded, publishPhoneSnapshot])

  const refreshSettingsInventory = useCallback(async (): Promise<void> => {
    const generation = ++settingsInventoryGeneration.current
    setSettingsInventoryLoading(true)
    setSettingsInventoryError(null)
    try {
      const inventory = await window.singz.audioHostDevices()
      if (settingsInventoryGeneration.current !== generation) return
      setSettingsInventory(inventory)
      setSettingsInventoryError(inventory.ok ? null : inventory.error)
    } catch (error) {
      if (settingsInventoryGeneration.current !== generation) return
      setSettingsInventory(null)
      setSettingsInventoryError(error instanceof Error ? error.message : String(error))
    } finally {
      if (settingsInventoryGeneration.current === generation) setSettingsInventoryLoading(false)
    }
  }, [])

  const noteInput = useCallback(() => {
    lastInput.current = performance.now()
    setRemoteVersion(version => version + 1)
  }, [])

  useEffect(() => {
    if (route === 'settings') void refreshSettingsInventory()
  }, [route, refreshSettingsInventory])

  useEffect(() => () => {
    settingsInventoryGeneration.current++
  }, [])

  useEffect(() => {
    const unload = (): void => { void boxCloseWork(() => transport.teardown(), flushPrivateState).catch(error => { console.warn('Box private cleanup could not be confirmed.', error) }) }
    window.addEventListener('beforeunload', unload, { once: true })
    return () => {
      window.removeEventListener('beforeunload', unload)
      collection.dispose()
      void boxCloseWork(() => transport.teardown(), flushPrivateState).catch(error => { console.warn('Box private cleanup could not be confirmed.', error) })
    }
  }, [collection, flushPrivateState, transport])

  useEffect(() => {
    let requested = false
    const finish = (): void => { window.singz.boxCloseReady() }
    const unsubscribe = window.singz.onBoxCloseRequest(() => {
      if (requested) return
      requested = true
      void closeBoxSession(transport, flushPrivateState, finish)
    })
    return () => {
      unsubscribe()
    }
  }, [flushPrivateState, transport])

  const cancelOpenForNavigation = useCallback((): boolean => {
    if (!settingsNavigator.canNavigate() || interactionLocked()) return false
    if (!latest.current.snapshot.loadingName) {
      cancelPreviewStart(openIntent.current, previewStartIntent, openingDir, () => setBusyDir(null), publishPhoneSnapshot)
      return true
    }
    if (!transport.cancelOpen()) return false
    openIntent.current.cancel()
    openingDir.current = null
    setBusyDir(null)
    void publishPhoneSnapshot()
    return true
  }, [interactionLocked, publishPhoneSnapshot, settingsNavigator, transport])

  const goCatalog = useCallback(() => {
    if (!cancelOpenForNavigation()) return
    setMixOpen(false)
    setPendingSwitch(null)
    setRoute('catalog')
  }, [cancelOpenForNavigation])

  const goQueue = useCallback(() => {
    if (!cancelOpenForNavigation()) return
    setMixOpen(false)
    setQueueSelectedDir(current => queueItems.some(item => item.dir === current) ? current : queueItems[0]?.dir ?? null)
    setRoute('queue')
  }, [cancelOpenForNavigation, queueItems])

  const goCurrent = useCallback(() => {
    if (!latest.current.snapshot.active || !cancelOpenForNavigation()) return
    setMixOpen(false)
    setPendingSwitch(null)
    setRoute('player')
    setControlsVisible(true)
    setFocusVersion(version => version + 1)
  }, [cancelOpenForNavigation])

  const goHub = useCallback((page: JourneyPage = 'home', returnRoute?: BoxRoute) => {
    if (!cancelOpenForNavigation()) return
    if (returnRoute) hubReturn.current = returnRoute
    else hubReturn.current = overlayReturnRoute(latest.current.route, hubReturn.current, 'home')
    setMixOpen(false)
    setRoute('home')
    hubRef.current?.open(page)
  }, [cancelOpenForNavigation])

  const goAccount = useCallback((returnRoute?: BoxRoute) => {
    if (!cancelOpenForNavigation()) return
    accountReturn.current = returnRoute ?? (latest.current.route === 'home' ? accountReturnFromHub(hubReturn.current, accountReturn.current) : overlayReturnRoute(latest.current.route, accountReturn.current, 'account'))
    setAccountError(null)
    setMixOpen(false)
    setRoute('account')
  }, [cancelOpenForNavigation])

  const backFromAccount = useCallback(() => {
    if (signOutConfirm) {
      if (!signOutBusy) setSignOutConfirm(false)
      return
    }
    const phase = collection.getSnapshot().auth.phase
    if (phase === 'starting' || phase === 'pending') void collection.cancelSignIn()
    setRoute(accountReturn.current)
  }, [collection, signOutBusy, signOutConfirm])

  const backFromSettings = useCallback(() => {
    if (metronomePending.current) return
    settingsNavigator.backFromSettings()
  }, [settingsNavigator])

  const openDetails = useCallback((entry: CollectionEntry): boolean => {
    if (!cancelOpenForNavigation()) return false
    detailsReturn.current = detailsReturnRoute(latest.current.route, detailsReturn.current)
    setSelectedId(entry.id)
    setActionError(null)
    setMixOpen(false)
    setRoute('details')
    if (entry.local) void collection.verifyCached(entry.id)
    return true
  }, [cancelOpenForNavigation, collection])

  const backFromDetails = useCallback(() => {
    const target = detailsReturn.current
    if (target === 'queue') goQueue()
    else if (target === 'player') goCurrent()
    else if (target === 'home') goHub('home')
    else if (target === 'account') goAccount()
    else goCatalog()
  }, [goAccount, goCatalog, goCurrent, goHub, goQueue])

  const openNow = useCallback(async (entry: CollectionEntry, startFromPreview = false): Promise<void> => {
    // Consume the Next marker up front so a guarded early return cannot leave it behind.
    const advanced = advance.current?.to === entry.local?.dir ? advance.current : null
    advance.current = null
    if (metronomeBlocked.current) return
    const item = entry.local
    if (!item || !item.songPath || collection.getSnapshot().rows[entry.id]?.inspection?.readiness !== 'ready') return
    if (previewStartIntent.current !== null && openIntent.current.isCurrent(previewStartIntent.current)) return
    if (busyDir) return
    if (!startFromPreview && transport.getSnapshot().active?.item.dir === item.dir) { goCurrent(); return }
    const intent = openIntent.current.begin()
    previewStartIntent.current = intent
    const current = (): boolean => openIntent.current.isCurrent(intent)
    openingDir.current = item.dir
    setBusyDir(item.dir)
    setPendingSwitch(null)
    setSelectedId(entry.id)
    setActionError(null)
    // A failed open lands on details; Back must return to where it started (e.g. the queue).
    detailsReturn.current = detailsReturnRoute(latest.current.route, detailsReturn.current)
    setRoute(routeWhileOpening(latest.current.route))
    let reachedPlayer = false
    try {
      if (!await publishPhoneSnapshot()) throw new Error(t('box.details.openGuardFailed'))
      if (!current()) return
      const sameSong = transport.getSnapshot().active?.item.dir === item.dir
      const opened = sameSong || await transport.open(item)
      if (!current() || !opened) return
      const openedSong = transport.getSnapshot().active
      if (openedSong) collection.recordOpened(item, { readiness: 'ready', project: openedSong.project, message: null }, openedSong.metadata)
      if (advanced) finishAdvance.current(advanced.from)
      const published = await publishPhoneSnapshot()
      if (!current()) return
      if (startFromPreview) {
        if (!published) throw new Error(t('box.details.openGuardFailed'))
        await transport.controllerPlay(item.dir, current)
        if (!current()) return
      }
      setMixOpen(false)
      reachedPlayer = true
      playFocusPending.current = true
      setRoute('player')
      setControlsVisible(true)
      setFocusVersion(version => version + 1)
    } catch (error) {
      if (current()) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) {
        if (!reachedPlayer) setRoute(routeAfterFailedOpen(latest.current.route))
        previewStartIntent.current = null
        if (openingDir.current === item.dir) openingDir.current = null
        setBusyDir(null)
        void publishPhoneSnapshot()
      }
    }
  }, [busyDir, collection, goCurrent, publishPhoneSnapshot, transport])

  const requestSing = useCallback((entry: CollectionEntry) => {
    if (metronomeBlocked.current || !entry.local) return
    const current = transport.getSnapshot()
    if (current.active && current.active.item.dir !== entry.local.dir && switchNeedsConfirmation(true, playbackStatus(current))) {
      pendingSwitchMode.current = 'start'
      setPendingSwitch(entry)
    } else void openNow(entry, true)
  }, [openNow, transport])

  const prepare = useCallback(async (entry: CollectionEntry) => {
    setActionError(null)
    const result = await collection.prepare(entry.id)
    if (!result.ok && !result.cancelled && result.error) setActionError(result.error)
  }, [collection])

  /** Optimistic key while a change is being saved, so quick presses stack instead of reading a stale saved value. */
  const [keyDraft, setKeyDraft] = useState<{ dir: string; value: number } | null>(null)
  const changeKey = useCallback(async (entry: CollectionEntry, semitones: number) => {
    const local = entry.local
    const settings = collection.getSnapshot().rows[entry.id]?.inspection?.project?.settings
    if (!local || !settings) return
    const value = clampTranspose(semitones)
    setActionError(null)
    setKeyDraft({ dir: local.dir, value })
    const result = await transport.saveSongTranspose(local, settings, value)
    if (!result.ok) setActionError(result.error)
    else if (transport.getSnapshot().active?.item.dir !== local.dir) await collection.verifyCached(entry.id)
    setKeyDraft(current => current?.dir === local.dir && current.value === value ? null : current)
  }, [collection, transport])

  const commitQueue = useCallback(async (refs: BoxQueueRef[]): Promise<boolean> => {
    if (!queueStore.commit(refs)) return false
    phoneProjection.update(refs, true)
    setQueueLimitError(false)
    await queueStore.flush()
    return queueStore.getSnapshot().error === null
  }, [phoneProjection, queueStore])

  const toggleQueue = useCallback((entry: CollectionEntry) => {
    const refs = queueStore.getRefs()
    if (queueHasEntry(collectionSnapshot.entries, refs, entry)) {
      const viewDir = entry.local?.dir ?? entry.id
      void commitQueue(removeQueueViewDir(collectionSnapshot.entries, refs, viewDir).refs)
      return
    }
    if (refs.length >= BOX_QUEUE_LIMIT) {
      setQueueLimitError(true)
      return
    }
    void commitQueue(addQueueEntry(collectionSnapshot.entries, refs, entry))
  }, [collectionSnapshot.entries, commitQueue, queueStore])

  const chooseQueued = useCallback((item: ProjectListItem) => {
    const entry = queueEntryForViewDir(allEntries, queueRefs, item.dir)
    if (!entry) return
    if (snapshot.active?.item.dir === item.dir && entry.local) {
      goCurrent()
      return
    }
    if (!entry.local || collectionSnapshot.rows[entry.id]?.inspection?.readiness !== 'ready') {
      openDetails(entry)
      return
    }
    pendingSwitchMode.current = 'paused'
    setPendingSwitch(entry)
  }, [allEntries, collectionSnapshot.rows, goCurrent, openDetails, queueRefs, snapshot.active])

  /** Player "Next": same open/switch path as the queue; the song that just played leaves the queue once the next one opens. */
  const requestNext = useCallback(() => {
    const current = snapshot.active?.item.dir ?? null
    const next = nextQueued(queueItems, current)
    const entry = next && queueEntryForViewDir(allEntries, queueRefs, next.dir)
    if (!next || !entry) return
    if (!entry.local || collectionSnapshot.rows[entry.id]?.inspection?.readiness !== 'ready') { openDetails(entry); return }
    advance.current = current ? { from: current, to: next.dir } : null
    if (switchNeedsConfirmation(snapshot.active !== null, playbackStatus(snapshot))) {
      pendingSwitchMode.current = nextSwitchMode(current, queueItems)
      setPendingSwitch(entry)
    } else void openNow(entry, true)
  }, [allEntries, collectionSnapshot.rows, openDetails, openNow, queueItems, queueRefs, snapshot])
  finishAdvance.current = (from: string): void => {
    const refs = queueStore.getRefs()
    const played = projectQueue(collectionSnapshot.entries, refs).find(row => row.item.dir === from)?.ref ?? null
    const after = queueAfterAdvance(refs, played)
    if (after) void commitQueue(after)
  }

  const closeMix = useCallback(() => {
    gate.current.recover()
    setMixOpen(false)
    setControlsVisible(true)
    noteInput()
    setFocusVersion(version => version + 1)
  }, [noteInput])

  const back = useCallback(() => {
    if (latest.current.signOutConfirm) {
      if (!latest.current.signOutBusy) setSignOutConfirm(false)
      return
    }
    if (route === 'home') {
      hubRef.current?.back()
      return
    }
    if (pendingSwitch) {
      advance.current = null
      setPendingSwitch(null)
      return
    }
    if (mixOpen) {
      closeMix()
      return
    }
    if (route === 'settings') {
      backFromSettings()
      return
    }
    if (!settingsNavigator.canNavigate()) return
    if (route === 'details') backFromDetails()
    else if (route === 'account') backFromAccount()
    else if (route === 'player') goCatalog()
    else if (route === 'queue') {
      if (snapshot.active) goCurrent()
      else goCatalog()
    } else if (tvRef.current) {
      // Catalog: Back moves focus to the top navigation (NAV-02). No focusVersion bump: that
      // re-runs the focus effect, which would put focus straight back on the catalog row.
      focusPrimaryNavigation(tvRef.current)
    }
  }, [backFromAccount, backFromDetails, backFromSettings, closeMix, goCatalog, goCurrent, goQueue, mixOpen, pendingSwitch, route, settingsNavigator, snapshot.active])

  const actionsRef = useRef({ back, goCatalog, goQueue, goCurrent, closeMix })
  actionsRef.current = { back, goCatalog, goQueue, goCurrent, closeMix }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const current = latest.current
      const recoveryScope = tvRef.current ? remoteScope(tvRef.current) : null
      if (!current.hydrated && recoveryScope?.dataset.surface !== 'retained-playback' && recoveryScope?.dataset.surface !== 'policy-startup') {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const wakeRequired = current.route === 'player' && !current.mixOpen && !current.pendingSwitch && !current.signOutConfirm && !current.controlsVisible
      const result = gate.current.keyDown(event.key, event.repeat, wakeRequired)
      if (!result.consumed) return
      noteInput()
      if (result.wake) {
        setControlsVisible(true)
        setFocusVersion(version => version + 1)
      }
      if (!result.allowAction) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.matches('[data-control="seek"]') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) lastSeekKeyAt.current = performance.now()
      if (target && rangeOwnsArrow(target, event.key)) return
      event.preventDefault()
      event.stopPropagation()
      const scope = tvRef.current ? remoteScope(tvRef.current) : null
      if (scope?.dataset.surface === 'retained-playback' || scope?.dataset.surface === 'policy-startup') {
        // The retained-song dialog owns remote focus, including Back/media
        // keys. A focus repair press must never activate an obscured control.
        if (event.key === 'Escape' || event.key === 'Backspace' || event.key.startsWith('Media')) return
        if (!target || !scope.contains(target)) {
          scope.querySelector<HTMLElement>('button:not(:disabled)')?.focus()
          return
        }
      }
      if (event.key === 'Escape' || event.key === 'Backspace') {
        actionsRef.current.back()
        return
      }
      if (event.key.startsWith('Media') && interactionLocked()) return
      if (event.key === 'MediaPlayPause') {
        if (transport.getSnapshot().routingBlocked || transport.getSnapshot().restartRequired) goHub('home')
        else if (!metronomeBlocked.current) transport.toggle()
        return
      }
      if (event.key === 'MediaTrackPrevious') {
        transport.seekBy(-5)
        return
      }
      if (event.key === 'MediaTrackNext') {
        transport.seekBy(5)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (target?.matches('input[type="range"]')) moveSpatialFocus(remoteScope(tvRef.current!), 'ArrowRight')
        else if (target?.matches('button:not(:disabled)')) target.click()
        return
      }
      if (event.key === 'Tab') {
        moveSpatialFocus(remoteScope(tvRef.current!), event.shiftKey ? 'ArrowLeft' : 'ArrowRight')
        return
      }
      if (event.key.startsWith('Arrow')) moveSpatialFocus(remoteScope(tvRef.current!), event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown')
    }
    const keyUp = (event: KeyboardEvent): void => {
      if (!gate.current.keyUp(event.key)) return
      event.preventDefault()
      event.stopPropagation()
      noteInput()
    }
    const recover = (): void => {
      gate.current.recoverFromFocusLoss()
      setControlsVisible(true)
      noteInput()
      setFocusVersion(version => version + 1)
    }
    // Mouse use counts as activity, so visible controls do not hide under the pointer.
    const pointerDown = (): void => noteInput()
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('keyup', keyUp, true)
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('blur', recover)
    window.addEventListener('focus', recover)
    document.addEventListener('visibilitychange', recover)
    return () => {
      window.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('keyup', keyUp, true)
      window.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('blur', recover)
      window.removeEventListener('focus', recover)
      document.removeEventListener('visibilitychange', recover)
    }
  }, [goHub, interactionLocked, noteInput, transport])

  useEffect(() => {
    gate.current.recover()
    noteInput()
  }, [route, mixOpen, pendingSwitch, signOutConfirm, noteInput])

  useEffect(() => {
    if (!snapshot.playing) setControlsVisible(true)
  }, [snapshot.playing])

  useEffect(() => {
    return scheduleControlsHide(() => ({
      state: {
        playing: latest.current.snapshot.playing,
        visible: latest.current.controlsVisible,
        playerActive: latest.current.route === 'player',
        overlayOpen: latest.current.mixOpen || latest.current.pendingSwitch !== null || latest.current.signOutConfirm,
        hasLyrics: latest.current.snapshot.active?.lyrics.status === 'ready',
        documentVisible: !document.hidden
      },
      held: gate.current.heldCount,
      lastInput: lastInput.current
    }), () => setControlsVisible(false))
  }, [remoteVersion, snapshot.playing, route, mixOpen, pendingSwitch, signOutConfirm, controlsVisible, snapshot.active])

  useEffect(() => {
    const root = tvRef.current
    if (!root) return
    const remember = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement) {
        focusTarget.current = event.target
        const level = event.target.dataset.mixLevel
        if (level) mixChannel.current = level
      }
    }
    root.addEventListener('focusin', remember)
    return () => root.removeEventListener('focusin', remember)
  }, [])

  useEffect(() => {
    const previous = focusTarget.current
    if (!previous) return
    const usable = previous.isConnected && previous.getClientRects().length > 0 &&
      !previous.closest('[hidden], [inert]') && !previous.matches(':disabled')
    if (!usable) setFocusVersion(version => version + 1)
  }, [collectionSnapshot, queueSnapshot, snapshot])

  useEffect(() => {
    const root = tvRef.current
    if (!root || !controlsVisible && route === 'player' && !mixOpen) return
    // Play becoming usable only matters to an open that is still waiting to put focus on it.
    const playEnabledChanged = lastPlayEnabled.current !== playEnabled
    lastPlayEnabled.current = playEnabled
    if (playEnabledChanged && !playFocusPending.current) return
    if (route === 'player' && !mixOpen && !pendingSwitch && seekKeepsFocus(document.activeElement, lastSeekKeyAt.current, performance.now())) return
    const query = (selector: string): HTMLElement | null => Array.from(root.querySelectorAll<HTMLElement>(selector))
      .find(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]')) ?? null
    let target: HTMLElement | null = null
    if (query('[data-retained-refresh]')) target = query('[data-retained-refresh]:not(:disabled)')
    else if (!hydrated) target = query('[data-surface="policy-startup"] button:not(:disabled)')
    else if (signOutConfirm) target = query('[data-signout-cancel]')
    else if (pendingSwitch) target = query('[data-keep-current]')
    else if (mixOpen) {
      // Open on the remembered channel (else the first level), never on the transport button.
      const levels = Array.from(root.querySelectorAll<HTMLElement>('[data-mix-level]')).filter(element => element.getClientRects().length > 0)
      const levelId = pickMixerFocusId(levels.map(element => element.dataset.mixLevel ?? ''), mixChannel.current)
      target = snapshot.routingBlocked ? query('[data-mix-close]') : levels.find(element => element.dataset.mixLevel === levelId) ?? query('[data-mix-play]')
    }
    else if (route === 'catalog') {
      const list = root.querySelector<HTMLElement>('.box-song-list')
      if (list) list.scrollTop = catalogScroll.current
      const index = Math.max(0, collectionSnapshot.entries.findIndex(entry => entry.id === selectedEntry?.id))
      target = catalogFocusTarget(root, index)
    } else if (route === 'details') target = query('[data-detail-primary]:not(:disabled)') ?? query('[data-focus="details-back"]')
    else if (route === 'settings') target = query('.box-settings button:not(:disabled)')
    else if (route === 'account') target = query('[data-account-primary]:not(:disabled)') ?? query('[data-focus="account-back"]')
    else if (route === 'home') return // JourneyHub owns focus through its asynchronous boot readiness.
    else if (route === 'player') {
      const play = query('[data-control="play"]')
      const preferred = `[data-control="${endedWithNext ? endedFocusControl(true) : 'play'}"]`
      if (playFocusPending.current && play && !(play as HTMLButtonElement).disabled) { target = play; playFocusPending.current = false }
      else target = snapshot.routingBlocked ? query('[data-control="settings"]') ?? play : query(preferred) ?? play
    } else {
      const index = Math.max(0, queueItems.findIndex(item => item.dir === queueSelectedDir))
      target = query(`[data-queue-index="${index}"]`) ?? query('[data-empty-browse]') ?? query('[data-queue-return]')
    }
    if (route !== 'player') playFocusPending.current = false
    focusTarget.current = target
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [route, hydrated, mixOpen, pendingSwitch, signOutConfirm, controlsVisible, focusVersion, snapshot.routingBlocked, endedWithNext, metronomeError, metronomeBusy, playEnabled])

  phoneActionsRef.current = async (envelope: BoxControllerEnvelope): Promise<void> => {
    let response: BoxControllerResponse = { ok: false, error: 'The command could not be completed.' }
    try {
      const activity = await boxApi.isControllerCommandActive(envelope.id)
      if (!activity?.ok || !activity.value || interactionLocked()) {
        await boxApi.respondControllerCommand(envelope.id, response)
        return
      }
      const command = sanitizeControllerCommand(envelope.command, transport.getSnapshot().duration)
      if (!command) {
        await boxApi.respondControllerCommand(envelope.id, response)
        return
      }
      if (command.type === 'seek') {
        response = { ok: false, error: 'Seek is not supported by this playback backend yet.' }
      } else if (command.type === 'select') {
        const entry = phoneProjection.projectForId(latestPhone.current.entries, queueStore.getRefs(), command.projectId)
        if (entry) {
          flushSync(() => { openDetails(entry) })
          response = latest.current.route === 'details' && latest.current.selectedId === entry.id
            ? { ok: true }
            : response
        }
      } else if (command.type === 'queue-add') {
        const entry = phoneProjection.projectForId(latestPhone.current.entries, queueStore.getRefs(), command.projectId)
        const ref = entry ? queueRefForEntry(entry) : null
        if (entry && ref && queueStore.getRefs().length < BOX_QUEUE_LIMIT) {
          response = await commitQueue(addQueueEntry(latestPhone.current.entries, queueStore.getRefs(), entry))
            ? { ok: true }
            : response
        }
      } else if (command.type === 'queue-remove' || command.type === 'queue-move') {
        const refs = queueStore.getRefs()
        const ref = phoneProjection.queueRefForId(refs, command.entryId)
        if (ref) {
          const next = command.type === 'queue-remove'
            ? refs.filter(candidate => candidate !== ref)
            : moveQueueRefInView(latestPhone.current.entries, refs, ref, command.delta)
          response = next !== refs && await commitQueue(next) ? { ok: true } : response
        }
      } else if (command.type === 'play-pause') {
        if (metronomeBlocked.current) throw new Error('Metronome policy is unresolved.')
        await transport.controllerPlayPause()
        response = { ok: true }
      } else if (command.type === 'volume' || command.type === 'mute' || command.type === 'solo') {
        const target = phoneProjection.stemTarget(transport.getSnapshot().active?.item.dir ?? null, command.target)
        if (target) {
          await transport.controllerMix({ ...command, target })
          response = { ok: true }
        }
      }
    } catch {
      response = { ok: false, error: 'The command could not be completed.' }
    }
    try {
      await boxApi.respondControllerCommand(envelope.id, response)
    } catch {
      // Main owns expiry and does not receive a false success from this path.
    }
  }

  useEffect(() => {
    const unsubscribe = boxApi.onControllerCommand(envelope => {
      phoneCommandTail.current = phoneCommandTail.current.then(() => phoneActionsRef.current(envelope), () => phoneActionsRef.current(envelope))
    })
    return () => unsubscribe()
  }, [boxApi])

  const queueRows: Record<string, CatalogRow> = {}
  for (const item of queueProjection) queueRows[item.item.dir] = collectionSnapshot.rows[item.entry.id]
  const showNavigation = route !== 'player'
  const canPlay = !metronomeBusy && !metronomeError && metronomeMode !== null && !snapshot.routingBlocked && !snapshot.applyingOutput && !snapshot.restartRequired
  const canApplyOutput = !snapshot.restartRequired && settingsInventory?.ok === true && settingsInventory.provider === 'alsa'
  const settingsError = snapshot.restartRequired
    ? `${tSettings('box.settings.restartRequired')}${snapshot.outputError ? ` ${snapshot.outputError}` : ''}`
    : snapshot.routingBlocked
      ? `${tSettings('box.settings.routeUnconfirmed')}${snapshot.outputError ? ` ${snapshot.outputError}` : ''}`
      : snapshot.outputError ?? settingsInventoryError
  const applyUnavailableReason = snapshot.restartRequired
    ? tSettings('box.settings.restartRequired')
    : canApplyOutput ? null : tSettings('box.settings.routeUnavailable')
  const selectedRow = selectedEntry ? collectionSnapshot.rows[selectedEntry.id] : undefined
  const queueError = queueLimitError ? t('box.queue.limit') : queueSnapshot.error
    ? queueSnapshot.loaded ? t('box.queue.saveError', { error: queueSnapshot.error }) : t('box.queue.loadError')
    : null
  const safeScale = 1 - safeArea / 50

  return <div className="box-viewport" ref={viewportRef} data-app="singz-box">
    <div className="box-tv" ref={tvRef} data-route={route} style={{ transform: `scale(${frame.scale})`, left: frame.left, top: frame.top }}>
      {!hydrated && <section className="box-policy-startup" role="dialog" data-surface="policy-startup">
        <p role={metronomeError ? 'alert' : 'status'}>{metronomeError ?? tSettings('box.settings.metronomeChecking')}</p>
        {metronomeError && <button className="pill" disabled={metronomeBusy} onClick={() => { void hydrate(false) }}>{tSettings('box.settings.metronomeRetry')}</button>}
      </section>}
      {!active && window.singz.boxAudioPersistent && <RetainedPlayback onRestore={hydrated ? restoreRetained : undefined} onStopped={() => {
        goCatalog()
        setFocusVersion(version => version + 1)
      }} />}
      <div className="box-safe-surface" inert={!hydrated} style={{ transform: `scale(${safeScale})`, left: safeArea * 16, top: safeArea * 9 }}>
        {hydrated && <div className="box-hub-slot" hidden={route !== 'home'} inert={route !== 'home'}>
          <JourneyHub
            ref={hubRef}
            active={route === 'home'}
            onSignOut={signOutDrive}
            initialPage={initialHubPage.current}
            activeProjectDir={active?.item.dir ?? null}
            playbackActive={snapshot.playing || snapshot.starting}
            onBack={() => {
              const target = hubReturn.current
              if (target === 'player' && !latest.current.snapshot.active) setRoute('catalog')
              else {
                setRoute(target)
                if (target === 'player') { setControlsVisible(true); setFocusVersion(version => version + 1) }
              }
            }}
            onOpenAudio={() => {
              if (!cancelOpenForNavigation()) return
              settingsReturn.current = 'home'
              settingsNavigator.go('settings')
            }}
            onOpenCollection={() => goAccount('home')}
            onLibraryChanged={() => { void collection.refreshLocal().catch(() => undefined) }}
            onAccountChanged={() => { void collection.refreshAccount().catch(() => undefined) }}
            onSafeAreaChange={setSafeArea}
          />
        </div>}
        {showNavigation && <BoxNavigation
          section={route === 'settings' || route === 'home' ? 'settings' : route === 'account' ? 'account' : route === 'queue' ? 'queue' : 'catalog'}
          queueCount={queueItems.length}
          currentName={active?.item.name ?? null}
          onCatalog={goCatalog}
          onQueue={goQueue}
          onCurrent={goCurrent}
          onSettings={() => goHub('home')}
          onAccount={() => goAccount()}
        />}
        {route === 'catalog' && <Catalog
          status={collectionSnapshot.localStatus}
          error={collectionSnapshot.localError}
          cacheError={collectionSnapshot.cacheError}
          remoteError={collectionSnapshot.remoteError}
          entries={collectionSnapshot.entries}
          rows={collectionSnapshot.rows}
          selectedId={selectedEntry?.id ?? null}
          downloadingId={collectionSnapshot.download?.entryId ?? null}
          onRemember={setSelectedId}
          onOpen={openDetails}
          onRetry={() => {
            void hydrate(false)
            if (collection.getSnapshot().auth.signedIn) void collection.refreshRemote()
          }}
          onScroll={scrollTop => { catalogScroll.current = scrollTop }}
        />}
        {route === 'details' && selectedEntry && <SongDetails
          entry={selectedEntry}
          inspection={selectedRow?.inspection}
          metadata={selectedRow?.metadata}
          transpose={keyDraft && keyDraft.dir === selectedEntry.local?.dir ? keyDraft.value : active?.item.dir === selectedEntry.local?.dir ? snapshot.transpose : selectedRow?.inspection?.project?.settings.transpose ?? 0}
          queued={queueHasEntry(collectionSnapshot.entries, queueRefs, selectedEntry)}
          busy={busyDir === selectedEntry.local?.dir || snapshot.loadingName === selectedEntry.name}
          error={snapshot.lastError}
          actionError={actionError}
          download={collectionSnapshot.download?.entryId === selectedEntry.id || collectionSnapshot.download?.entryId === selectedId ? collectionSnapshot.download : null}
          onBack={backFromDetails}
          onSing={() => requestSing(selectedEntry)}
          onPrepare={() => { void prepare(selectedEntry) }}
          onVerify={() => { void prepare(selectedEntry) }}
          onCancelDownload={() => { void collection.cancelDownload() }}
          onToggleQueue={() => toggleQueue(selectedEntry)}
          onTranspose={semitones => { void changeKey(selectedEntry, semitones) }}
        />}
        {route === 'account' && <Account
          auth={collectionSnapshot.auth}
          remoteError={accountError ?? collectionSnapshot.remoteError}
          signOutConfirm={signOutConfirm}
          signOutBusy={signOutBusy}
          onBack={backFromAccount}
          onStart={() => { void collection.startSignIn() }}
          onCancel={() => { void collection.cancelSignIn() }}
          onRequestSignOut={() => setSignOutConfirm(true)}
          onCancelSignOut={() => setSignOutConfirm(false)}
          onSignOut={() => {
            setSignOutBusy(true)
            setAccountError(null)
            void collection.signOut().then(ok => {
              if (ok) setSignOutConfirm(false)
              else setAccountError(t('box.account.signOutFailed'))
            }).finally(() => setSignOutBusy(false))
          }}
          onOpenNetwork={() => goHub('network', 'account')}
          onOpenStorage={() => goHub('storage', 'account')}
        />}
        {route === 'settings' && <Settings
          metronomeOverride={metronomeMode}
          metronomeBusy={metronomeBusy}
          metronomeError={metronomeError}
          onMetronomeOverride={changeMetronome}
          microphones={microphones}
          inventory={settingsInventory}
          loading={settingsInventoryLoading}
          error={settingsError}
          currentOutputUid={snapshot.appliedOutputUid}
          playbackActive={snapshot.playing || snapshot.starting}
          onRefresh={() => { void refreshSettingsInventory() }}
          onApplyOutput={rawUid => transport.applyOutput(rawUid)}
          onBack={backFromSettings}
          canApplyOutput={canApplyOutput}
          applyUnavailableReason={applyUnavailableReason}
        />}
        {route === 'player' && <Player snapshot={snapshot} microphones={microphones} controlsVisible={controlsVisible} onLibrary={goCatalog} onMix={() => { setMixOpen(true); setControlsVisible(true); noteInput() }} onQueue={goQueue} onNext={requestNext} next={upNext} onSettings={() => goHub('home')} onToggle={() => { if (!metronomeBlocked.current) transport.toggle() }} onSeek={position => transport.seek(position)} onSeekBy={delta => transport.seekBy(delta)} onWake={() => { setControlsVisible(true); noteInput(); setFocusVersion(version => version + 1) }} />}
        {route === 'queue' && <Queue
          items={queueItems}
          rows={queueRows}
          selectedDir={queueSelectedDir}
          active={active}
          position={snapshot.position}
          playing={snapshot.playing}
          status={playbackStatus(snapshot)}
          canPlay={canPlay}
          onRemember={setQueueSelectedDir}
          onChoose={chooseQueued}
          onMove={(dir, delta) => { void commitQueue(moveQueueViewDir(collectionSnapshot.entries, queueRefs, dir, delta)) }}
          onRemove={dir => {
            const result = removeQueueViewDir(collectionSnapshot.entries, queueRefs, dir)
            void commitQueue(result.refs)
            setQueueSelectedDir(result.focus)
            setFocusVersion(version => version + 1)
          }}
          onBrowse={goCatalog}
          onClose={active ? goCurrent : goCatalog}
          onToggle={() => { if (!metronomeBlocked.current) transport.toggle() }}
        />}
        {route === 'player' && mixOpen && <Mixer microphones={microphones} tab={mixTab} tracks={snapshot.tracks} masterVolume={snapshot.masterVolume} playing={snapshot.playing} status={playbackStatus(snapshot)} canPlay={active?.lyrics.status === 'ready' && canPlay} onTab={setMixTab} onVolume={(id, volume) => transport.setVolume(id, volume)} onMuted={(id, muted) => transport.setMuted(id, muted)} onSolo={(id, solo) => transport.setSolo(id, solo)} onMasterVolume={volume => transport.setMasterVolume(volume)} onToggle={() => { if (!metronomeBlocked.current) transport.toggle() }} onClose={closeMix} />}
        {pendingSwitch?.local && <SwitchDialog active={active} mode={pendingSwitchMode.current} target={pendingSwitch.local} onCancel={() => { advance.current = null; setPendingSwitch(null) }} onConfirm={() => void openNow(pendingSwitch, pendingSwitchMode.current !== 'paused')} />}
        {(queueError || queueSnapshot.loading) && route !== 'player' && route !== 'home' && <div className="box-state-toast" role="alert">
          <span>{queueSnapshot.loading ? t('box.queue.loading') : queueError}</span>
          {!queueSnapshot.loaded && !queueSnapshot.loading && <button type="button" onClick={() => { void hydrate(false) }}>{t('app.retry')}</button>}
        </div>}
      </div>
      <StartupOverlay hydrated={hydrated} failed={metronomeError !== null} />
    </div>
  </div>
}
