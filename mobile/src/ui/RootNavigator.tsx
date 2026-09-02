import { usePreventRemove } from '@react-navigation/native'
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp
} from '@react-navigation/native-stack'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, AppState, StyleSheet, View } from 'react-native'
import type { MultitrackEngine } from '../engine'
import type { RouteLatency } from '../latency'
import { log } from '../log'
import type { ProjectDoc } from '../model'
import {
  flushMetronomeForLifecycle,
  MetronomeBackgroundFailureDelivery
} from '../playback/metronome-durability'
import { releaseProject, type LoadedProject } from '../projects'
import AddSongSheet, { type AddSongRequest } from './AddSongSheet'
import CatalogScreen from './CatalogScreen'
import LogPanel from './LogPanel'
import PlayerScreen from './PlayerScreen'
import SettingsScreen from './SettingsScreen'
import { C, NATIVE_SHEET_FIT_SUPPORTED } from './bits'

type RootStackParamList = {
  Catalog: undefined
  Player: undefined
  AddSong: undefined
  Log: undefined
  Settings: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

/**
 * Owns one loaded song for exactly as long as its Player route exists.
 *
 * LoadedProject contains native AudioBuffers, so it deliberately never enters
 * route params or navigation state. A cancelled native swipe leaves the route
 * mounted and therefore leaves the audio alone; a completed pop unmounts the
 * route and releases the engine before releasing the buffers.
 */
export function PlayerRoute({
  active = true,
  engine,
  project,
  route = null,
  trimMs = 0,
  onTrim = () => undefined,
  onTrainingFacts,
  onFallback = () => undefined,
  onBack,
  onClosed
}: {
  active?: boolean
  engine: MultitrackEngine
  project: LoadedProject
  route?: RouteLatency | null
  trimMs?: number
  onTrim?: (ms: number) => void
  onTrainingFacts?: (facts: {
    keyInfo: NonNullable<NonNullable<ProjectDoc['settings']>['key']> | null
    transpose: number
  }) => void
  onFallback?: (project: LoadedProject) => void
  onBack: () => void
  onClosed: (project: LoadedProject) => void
}): React.JSX.Element {
  const ownedProject = useRef(project)
  ownedProject.current = project
  // The native pre-start fallback replaces the buffer-free project in place.
  // Route ownership ends only on unmount; cleaning on every prop replacement
  // would mark the still-visible fallback player closed and release its PCM.
  useEffect(() => () => onClosed(ownedProject.current), [onClosed])
  return (
    <PlayerScreen
      active={active}
      engine={engine}
      project={project}
      route={route}
      trimMs={trimMs}
      onTrim={onTrim}
      onTrainingFacts={onTrainingFacts}
      onBack={onBack}
      onFallback={onFallback}
    />
  )
}

/**
 * Screen options for the Player route.
 *
 * The swipe-back gesture used to be switched off whenever the project carried
 * a native handle, which made the two playback backends feel like different
 * apps: the same screen, and the singer's habitual edge-swipe silently did
 * nothing. Nothing about native playback needs it off — leaving the player is
 * gated by PlayerRemovalFence for both backends, and closePlayerProject
 * already sequences the native unload ahead of releasing legacy ownership,
 * whether the pop came from the button or from a gesture.
 */
export function playerScreenOptions(): {
  gestureEnabled: boolean
  fullScreenGestureEnabled: boolean
} {
  return { gestureEnabled: true, fullScreenGestureEnabled: false }
}

export function closePlayerProject(engine: MultitrackEngine, project: LoadedProject): void {
  const releaseLegacyOwnership = (): void => {
    engine.unload()
    releaseProject(project)
  }
  if (!project.nativePlayback) {
    releaseLegacyOwnership()
    return
  }
  void project.nativePlayback
    .unload('player route closed')
    .catch(error =>
      log('native-playback', `player route cleanup could not prove native unload · ${String(error)}`, 'error')
    )
    .finally(releaseLegacyOwnership)
}

function AddSongRoute({
  request,
  onFinished,
  onBack
}: {
  request: AddSongRequest
  onFinished: (request: AddSongRequest, addedDir: string | null) => void
  onBack: () => void
}): React.JSX.Element {
  const finished = useRef(false)
  const finish = useCallback(
    (addedDir: string | null): void => {
      if (finished.current) return
      finished.current = true
      onFinished(request, addedDir)
    },
    [onFinished, request]
  )

  /* A native pull-down has no component button to call. Route ownership makes
     that path identical to Cancel, while the explicit completion path marks
     itself first and therefore cannot be reported twice. */
  useEffect(() => () => finish(null), [finish])

  return (
    <AddSongSheet
      src={request.src}
      sampleRate={request.sampleRate}
      onStep={request.onStep}
      onClose={addedDir => {
        finish(addedDir)
        onBack()
      }}
    />
  )
}

function PlayerRemovalFence({
  children,
  navigation,
  rootMounted
}: {
  children: React.ReactNode
  navigation: NativeStackNavigationProp<RootStackParamList, 'Player'>
  rootMounted: React.RefObject<boolean>
}): React.JSX.Element {
  const flushing = useRef(false)
  usePreventRemove(true, ({ data }) => {
    if (flushing.current) return
    flushing.current = true
    void flushMetronomeForLifecycle('player back', {
      onFailure: failure => {
        if (rootMounted.current) Alert.alert('Metronome setting was not saved', failure)
      }
    }).then(saved => {
      flushing.current = false
      if (saved && rootMounted.current) navigation.dispatch(data.action)
    })
  })
  return <>{children}</>
}

export default function RootNavigator({
  active = true,
  engine,
  route,
  trimMs,
  onTrim,
  onProjectLoaded,
  onProjectClosed,
  onTrainingFacts
}: {
  active?: boolean
  engine: MultitrackEngine
  route: RouteLatency | null
  trimMs: number
  onTrim: (ms: number) => void
  onProjectLoaded: (project: LoadedProject) => void
  onProjectClosed: () => void
  onTrainingFacts: (facts: {
    keyInfo: NonNullable<NonNullable<ProjectDoc['settings']>['key']> | null
    transpose: number
  }) => void
}): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)
  const [addSong, setAddSong] = useState<AddSongRequest | null>(null)
  const mounted = useRef(true)
  const backgroundFailureDelivery = useRef<MetronomeBackgroundFailureDelivery | null>(null)
  if (backgroundFailureDelivery.current === null)
    backgroundFailureDelivery.current = new MetronomeBackgroundFailureDelivery(
      failure => Alert.alert('Metronome setting was not saved', failure),
      undefined,
      AppState.currentState === 'active'
    )

  useEffect(() => {
    mounted.current = true
    const subscription = AppState.addEventListener('change', next => {
      backgroundFailureDelivery.current?.appStateChanged(next)
      if (next === 'inactive' || next === 'background') {
        void flushMetronomeForLifecycle('background', {
          onFailure: failure => backgroundFailureDelivery.current?.report(failure)
        })
      }
    })
    return () => {
      mounted.current = false
      backgroundFailureDelivery.current?.unmount()
      subscription.remove()
      // Best-effort eager reconciliation only. Accepted phone edits already
      // live in the synchronously flushed native journal, so correctness does
      // not depend on React cleanup remaining alive to await this promise.
      void flushMetronomeForLifecycle('unmount')
    }
  }, [])

  const closeProject = useCallback(
    (closing: LoadedProject): void => {
      closePlayerProject(engine, closing)
      setProject(current => (current === closing ? null : current))
      onProjectClosed()
    },
    [engine, onProjectClosed]
  )

  const finishAddSong = useCallback((request: AddSongRequest, addedDir: string | null): void => {
    request.onClose(addedDir)
    setAddSong(current => (current === request ? null : current))
  }, [])

  return (
    <View style={styles.root}>
      <Stack.Navigator
        initialRouteName="Catalog"
        screenOptions={{
          headerShown: false,
          contentStyle: styles.root
        }}
      >
        <Stack.Screen name="Catalog">
          {({ navigation }) => (
            <CatalogScreen
              active={active}
              engine={engine}
              sampleRate={engine.sampleRate}
              onOpenSettings={() => navigation.navigate('Settings')}
              onOpenLog={() => navigation.navigate('Log')}
              onOpenAddSong={request => {
                setAddSong(request)
                navigation.navigate('AddSong')
              }}
              onCloseAddSong={() => navigation.goBack()}
              onLoaded={loaded => {
                setProject(loaded)
                onProjectLoaded(loaded)
                navigation.navigate('Player')
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen
          name="Player"
          options={playerScreenOptions()}
        >
          {({ navigation }) =>
            project == null ? (
              <View style={styles.root} />
            ) : (
              <PlayerRemovalFence navigation={navigation} rootMounted={mounted}>
                <PlayerRoute
                  active={active}
                  engine={engine}
                  project={project}
                  route={route}
                  trimMs={trimMs}
                  onTrim={onTrim}
                  onTrainingFacts={onTrainingFacts}
                  onBack={() => navigation.goBack()}
                  onClosed={closeProject}
                  onFallback={fallback => setProject(fallback)}
                />
              </PlayerRemovalFence>
            )
          }
        </Stack.Screen>
        <Stack.Screen
          name="AddSong"
          options={{
            presentation: 'formSheet',
            gestureEnabled: true,
            sheetAllowedDetents: NATIVE_SHEET_FIT_SUPPORTED ? 'fitToContents' : [0.42, 0.93],
            ...(!NATIVE_SHEET_FIT_SUPPORTED ? { sheetInitialDetentIndex: 0 } : {}),
            sheetGrabberVisible: true,
            contentStyle: styles.sheet
          }}
          listeners={{
            transitionEnd: event => {
              if (!event.data.closing) addSong?.onShown?.()
            }
          }}
        >
          {({ navigation }) =>
            addSong == null ? (
              <View style={styles.sheet} />
            ) : (
              <AddSongRoute request={addSong} onFinished={finishAddSong} onBack={() => navigation.goBack()} />
            )
          }
        </Stack.Screen>
        <Stack.Screen
          name="Log"
          options={{
            presentation: 'fullScreenModal',
            contentStyle: styles.root
          }}
        >
          {({ navigation }) => <LogPanel onClose={() => navigation.goBack()} />}
        </Stack.Screen>
        <Stack.Screen
          name="Settings"
          options={{
            presentation: 'fullScreenModal',
            contentStyle: styles.root
          }}
        >
          {({ navigation }) => <SettingsScreen onClose={() => navigation.goBack()} />}
        </Stack.Screen>
      </Stack.Navigator>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  sheet: { flex: 1, backgroundColor: C.sheet }
})
