import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { applyPlatformClasses } from '@singz/ui'
import type { BoxAPI, BoxControllerEnvelope, BoxControllerResponse, BoxQueueRef } from '../../../shared/box-contract'
import type { DesktopAudioHostInventoryResult, ProjectListItem } from '../../../shared/types'
import { MultitrackEngine } from '../audio/engine'
import { boxNativePlaybackPolicy } from './playback-policy'
import { useLocale } from '../i18n'
import { Catalog, type CatalogRow } from './Catalog'
import { moveSpatialFocus, remoteScope } from './focus'
import { LatestOpenIntent } from './open-intent'
import { Player } from './Player'
import { Mixer, type MixerTab } from './Mixer'
import { Queue } from './Queue'
import { RemoteKeyGate, shouldHideControls } from './remote'
import { Settings } from './Settings'
import { t } from './i18n'
import { tSettings } from './settings-i18n'
import { BoxSettingsNavigator, type BoxRoute } from './settings-navigation'
import { SongDetails } from './SongDetails'
import { SwitchDialog } from './SwitchDialog'
import { BoxTransport } from './transport'
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
  const previousSelected = useRef<CollectionEntry | null>(null)
  const settingsInventoryGeneration = useRef(0)
  const hydrationGeneration = useRef(0)
  const openIntent = useRef(new LatestOpenIntent())
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
  const selectedEntry = resolveCollectionSelection(allEntries, selectedId, previousSelected.current, route === 'details')
  if (selectedEntry && !selectedEntry.unavailable) previousSelected.current = selectedEntry
  const active = snapshot.active
  const latest = useRef({ route, mixOpen, pendingSwitch, signOutConfirm, signOutBusy, controlsVisible, snapshot, selectedId, hydrated })
  latest.current = { route, mixOpen, pendingSwitch, signOutConfirm, signOutBusy, controlsVisible, snapshot, selectedId, hydrated }
  const latestPhone = useRef({ entries: allEntries, refs: queueRefs, rows: collectionSnapshot.rows, snapshot })
  latestPhone.current = { entries: allEntries, refs: queueRefs, rows: collectionSnapshot.rows, snapshot }

  const hubInteractionLocked = useCallback((): boolean => {
    if (latest.current.route !== 'home') return false
    return hubRef.current?.isInteractionLocked() === true
  }, [])

  const interactionLocked = useCallback((): boolean => {
    return !latest.current.hydrated || transport.getSnapshot().applyingOutput || latest.current.pendingSwitch !== null ||
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
    const generation = ++hydrationGeneration.current
    const { state, localReady } = await hydrateBoxLocally(queueStore, collection, refreshAccount)
    if (generation !== hydrationGeneration.current) return
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
  }, [collection, phoneProjection, queueStore])

  useEffect(() => {
    void hydrate(true)
    return () => { hydrationGeneration.current++ }
  }, [hydrate])

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
    const unload = (): void => { void boxCloseWork(() => transport.teardown(), () => queueStore.flush()) }
    window.addEventListener('beforeunload', unload, { once: true })
    return () => {
      window.removeEventListener('beforeunload', unload)
      collection.dispose()
      void boxCloseWork(() => transport.teardown(), () => queueStore.flush())
    }
  }, [collection, queueStore, transport])

  useEffect(() => {
    let requested = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      window.singz.boxCloseReady()
    }
    const unsubscribe = window.singz.onBoxCloseRequest(() => {
      if (requested) return
      requested = true
      transport.pause()
      const bounded = new Promise<void>(resolve => { timer = setTimeout(resolve, 8000) })
      const work = boxCloseWork(() => transport.teardown(), () => queueStore.flush())
      void Promise.race([work, bounded]).then(finish, finish)
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
    }
  }, [queueStore, transport])

  const cancelOpenForNavigation = useCallback((): boolean => {
    if (!settingsNavigator.canNavigate() || interactionLocked()) return false
    if (!latest.current.snapshot.loadingName) return true
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
    else if (latest.current.route !== 'home') hubReturn.current = latest.current.route === 'player' ? 'player' : 'catalog'
    setMixOpen(false)
    setRoute('home')
    hubRef.current?.open(page)
  }, [cancelOpenForNavigation])

  const goAccount = useCallback((returnRoute?: BoxRoute) => {
    if (!cancelOpenForNavigation()) return
    accountReturn.current = returnRoute ?? (latest.current.route === 'home' ? 'home' : 'catalog')
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
    settingsNavigator.backFromSettings()
  }, [settingsNavigator])

  const openDetails = useCallback((entry: CollectionEntry): boolean => {
    if (!cancelOpenForNavigation()) return false
    detailsReturn.current = latest.current.route === 'details' ? detailsReturn.current : latest.current.route
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

  const openNow = useCallback(async (entry: CollectionEntry): Promise<void> => {
    const item = entry.local
    if (!item || !item.songPath || collection.getSnapshot().rows[entry.id]?.inspection?.readiness !== 'ready') return
    if (snapshot.active?.item.dir === item.dir) {
      goCurrent()
      return
    }
    if (busyDir) return
    const intent = openIntent.current.begin()
    openingDir.current = item.dir
    setBusyDir(item.dir)
    setPendingSwitch(null)
    setSelectedId(entry.id)
    setActionError(null)
    setRoute('details')
    const published = await publishPhoneSnapshot()
    if (!openIntent.current.isCurrent(intent)) return
    if (!published) {
      if (openingDir.current === item.dir) openingDir.current = null
      setBusyDir(current => current === item.dir ? null : current)
      setActionError(t('box.details.openGuardFailed'))
      void publishPhoneSnapshot()
      return
    }
    const opened = await transport.open(item)
    if (!openIntent.current.isCurrent(intent)) return
    setBusyDir(current => current === item.dir ? null : current)
    if (!opened) {
      if (openingDir.current === item.dir) openingDir.current = null
      void publishPhoneSnapshot()
      return
    }
    const openedSong = transport.getSnapshot().active
    if (openedSong) collection.recordOpened(item, { readiness: 'ready', project: openedSong.project, message: null }, openedSong.metadata)
    await publishPhoneSnapshot()
    if (!openIntent.current.isCurrent(intent)) return
    setMixOpen(false)
    setRoute('player')
    setControlsVisible(true)
    setFocusVersion(version => version + 1)
  }, [busyDir, collection, goCurrent, publishPhoneSnapshot, snapshot.active, transport])

  const requestSing = useCallback((entry: CollectionEntry) => {
    if (!entry.local) return
    if (snapshot.active && snapshot.active.item.dir !== entry.local.dir) setPendingSwitch(entry)
    else void openNow(entry)
  }, [openNow, snapshot.active])

  const prepare = useCallback(async (entry: CollectionEntry) => {
    setActionError(null)
    const result = await collection.prepare(entry.id)
    if (!result.ok && !result.cancelled && result.error) setActionError(result.error)
  }, [collection])

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
    setPendingSwitch(entry)
  }, [allEntries, collectionSnapshot.rows, goCurrent, openDetails, queueRefs, snapshot.active])

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
    } else {
      setFocusVersion(version => version + 1)
      tvRef.current?.querySelector<HTMLElement>('.box-navigation button.on')?.focus()
    }
  }, [backFromAccount, backFromDetails, backFromSettings, closeMix, goCatalog, goCurrent, goQueue, mixOpen, pendingSwitch, route, settingsNavigator, snapshot.active])

  const actionsRef = useRef({ back, goCatalog, goQueue, goCurrent, closeMix })
  actionsRef.current = { back, goCatalog, goQueue, goCurrent, closeMix }

  useEffect(() => {
    const keyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const current = latest.current
      if (!current.hydrated) {
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
      if (target?.matches('input[type="range"]') && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape' || event.key === 'Backspace') {
        actionsRef.current.back()
        return
      }
      if (event.key.startsWith('Media') && interactionLocked()) return
      if (event.key === 'MediaPlayPause') {
        if (transport.getSnapshot().routingBlocked || transport.getSnapshot().restartRequired) goHub('home')
        else transport.toggle()
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
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('keyup', keyUp, true)
    window.addEventListener('blur', recover)
    window.addEventListener('focus', recover)
    document.addEventListener('visibilitychange', recover)
    return () => {
      window.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('keyup', keyUp, true)
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
    const remaining = Math.max(0, 5000 - (performance.now() - lastInput.current))
    const timer = setTimeout(() => {
      if (shouldHideControls({
        playing: latest.current.snapshot.playing,
        visible: latest.current.controlsVisible,
        playerActive: latest.current.route === 'player',
        overlayOpen: latest.current.mixOpen || latest.current.pendingSwitch !== null || latest.current.signOutConfirm,
        hasLyrics: latest.current.snapshot.active?.lyrics.status === 'ready',
        documentVisible: !document.hidden
      }, gate.current.heldCount, performance.now(), lastInput.current)) setControlsVisible(false)
    }, remaining)
    return () => clearTimeout(timer)
  }, [remoteVersion, snapshot.playing, route, mixOpen, pendingSwitch, signOutConfirm, controlsVisible, snapshot.active])

  useEffect(() => {
    const root = tvRef.current
    if (!root) return
    const remember = (event: FocusEvent): void => {
      if (event.target instanceof HTMLElement) focusTarget.current = event.target
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
    const query = (selector: string): HTMLElement | null => Array.from(root.querySelectorAll<HTMLElement>(selector))
      .find(element => element.getClientRects().length > 0 && !element.closest('[hidden], [inert]')) ?? null
    let target: HTMLElement | null = null
    if (signOutConfirm) target = query('[data-signout-cancel]')
    else if (pendingSwitch) target = query('[data-keep-current]')
    else if (mixOpen) target = query(snapshot.routingBlocked ? '[data-mix-close]' : '[data-mix-play]')
    else if (route === 'catalog') {
      const list = root.querySelector<HTMLElement>('.box-song-list')
      if (list) list.scrollTop = catalogScroll.current
      const index = Math.max(0, collectionSnapshot.entries.findIndex(entry => entry.id === selectedEntry?.id))
      target = query(`[data-catalog-index="${index}"]`) ?? query('[data-focus="catalog-retry"]') ?? query('.box-navigation button.on')
    } else if (route === 'details') target = query('[data-detail-primary]:not(:disabled)') ?? query('[data-focus="details-back"]')
    else if (route === 'settings') target = query('.box-settings button:not(:disabled)')
    else if (route === 'account') target = query('[data-account-primary]:not(:disabled)') ?? query('[data-focus="account-back"]')
    else if (route === 'home') return // JourneyHub owns focus through its asynchronous boot readiness.
    else if (route === 'player') {
      target = snapshot.routingBlocked ? query('[data-control="settings"]') ?? query('[data-control="play"]') : query('[data-control="play"]')
    } else {
      const index = Math.max(0, queueItems.findIndex(item => item.dir === queueSelectedDir))
      target = query(`[data-queue-index="${index}"]`) ?? query('[data-empty-browse]') ?? query('[data-queue-return]')
    }
    focusTarget.current = target
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [route, hydrated, mixOpen, pendingSwitch, signOutConfirm, controlsVisible, focusVersion, snapshot.routingBlocked])

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
          const index = refs.indexOf(ref)
          let next: BoxQueueRef[] = refs
          if (command.type === 'queue-remove') next = refs.filter(candidate => candidate !== ref)
          else {
            const to = index + command.delta
            if (index >= 0 && to >= 0 && to < refs.length) {
              next = [...refs]
              ;[next[index], next[to]] = [next[to], next[index]]
            }
          }
          response = next !== refs && await commitQueue(next) ? { ok: true } : response
        }
      } else if (command.type === 'play-pause') {
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
  const canPlay = !snapshot.routingBlocked && !snapshot.applyingOutput && !snapshot.restartRequired
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
      <div className="box-safe-surface" inert={!hydrated} style={{ transform: `scale(${safeScale})`, left: safeArea * 16, top: safeArea * 9 }}>
        {hydrated && <div className="box-hub-slot" hidden={route !== 'home'} inert={route !== 'home'}>
          <JourneyHub
            ref={hubRef}
            active={route === 'home'}
            onSignOut={signOutDrive}
            initialPage={initialHubPage.current}
            activeProjectDir={active?.item.dir ?? null}
            playbackActive={snapshot.playing || snapshot.starting}
            onBack={() => setRoute(hubReturn.current)}
            onOpenAudio={() => {
              if (!cancelOpenForNavigation()) return
              settingsReturn.current = 'home'
              settingsNavigator.go('settings')
            }}
            onOpenCollection={() => goAccount('home')}
            onLibraryChanged={() => { void collection.refreshLocal().catch(() => undefined) }}
            onSafeAreaChange={setSafeArea}
          />
        </div>}
        {showNavigation && <BoxNavigation
          section={route === 'settings' || route === 'home' ? 'settings' : route === 'account' ? 'account' : route === 'queue' ? 'queue' : 'catalog'}
          queueCount={queueItems.length}
          hasCurrent={active !== null}
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
          onAccount={() => goAccount('catalog')}
          onScroll={scrollTop => { catalogScroll.current = scrollTop }}
        />}
        {route === 'details' && selectedEntry && <SongDetails
          entry={selectedEntry}
          inspection={selectedRow?.inspection}
          metadata={selectedRow?.metadata}
          transpose={active?.item.dir === selectedEntry.local?.dir ? snapshot.transpose : selectedRow?.inspection?.project?.settings.transpose ?? 0}
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
        {route === 'player' && <Player snapshot={snapshot} controlsVisible={controlsVisible} onLibrary={goCatalog} onMix={() => { setMixOpen(true); setControlsVisible(true); noteInput() }} onQueue={goQueue} onSettings={() => goHub('home')} onToggle={() => transport.toggle()} onSeek={position => transport.seek(position)} onSeekBy={delta => transport.seekBy(delta)} />}
        {route === 'queue' && <Queue
          items={queueItems}
          rows={queueRows}
          selectedDir={queueSelectedDir}
          active={active}
          position={snapshot.position}
          playing={snapshot.playing}
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
          onToggle={() => transport.toggle()}
        />}
        {route === 'player' && mixOpen && <Mixer tab={mixTab} tracks={snapshot.tracks} masterVolume={snapshot.masterVolume} playing={snapshot.playing} canPlay={active?.lyrics.status === 'ready' && canPlay} onTab={setMixTab} onVolume={(id, volume) => transport.setVolume(id, volume)} onMuted={(id, muted) => transport.setMuted(id, muted)} onSolo={(id, solo) => transport.setSolo(id, solo)} onMasterVolume={volume => transport.setMasterVolume(volume)} onToggle={() => transport.toggle()} onClose={closeMix} />}
        {pendingSwitch?.local && <SwitchDialog active={active} target={pendingSwitch.local} onCancel={() => setPendingSwitch(null)} onConfirm={() => void openNow(pendingSwitch)} />}
        {(queueError || queueSnapshot.loading) && route !== 'player' && route !== 'home' && <div className="box-state-toast" role="alert">
          <span>{queueSnapshot.loading ? t('box.queue.loading') : queueError}</span>
          {!queueSnapshot.loaded && !queueSnapshot.loading && <button type="button" onClick={() => { void hydrate(false) }}>{t('app.retry')}</button>}
        </div>}
      </div>
      {!hydrated && <div className="box-startup" data-surface="startup" role="status" aria-live="polite">
        <h1>{t('box.catalog.loadingTitle')}</h1>
        <p>{t('box.catalog.loadingBody')}</p>
      </div>}
    </div>
  </div>
}
