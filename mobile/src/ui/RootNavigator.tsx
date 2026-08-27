import { createNativeStackNavigator } from '@react-navigation/native-stack'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { MultitrackEngine } from '../engine'
import type { RouteLatency } from '../latency'
import type { ProjectDoc } from '../model'
import { releaseProject, type LoadedProject } from '../projects'
import AddSongSheet, { type AddSongRequest } from './AddSongSheet'
import CatalogScreen from './CatalogScreen'
import LogPanel from './LogPanel'
import PlayerScreen from './PlayerScreen'
import { C, NATIVE_SHEET_FIT_SUPPORTED } from './bits'

type RootStackParamList = {
  Catalog: undefined
  Player: undefined
  AddSong: undefined
  Log: undefined
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
  onBack: () => void
  onClosed: (project: LoadedProject) => void
}): React.JSX.Element {
  useEffect(() => () => onClosed(project), [onClosed, project])
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
    />
  )
}

export function closePlayerProject(engine: MultitrackEngine, project: LoadedProject): void {
  engine.unload()
  releaseProject(project)
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

  const closeProject = useCallback(
    (closing: LoadedProject): void => {
      closePlayerProject(engine, closing)
      setProject((current) => (current === closing ? null : current))
      onProjectClosed()
    },
    [engine, onProjectClosed]
  )

  const finishAddSong = useCallback((request: AddSongRequest, addedDir: string | null): void => {
    request.onClose(addedDir)
    setAddSong((current) => (current === request ? null : current))
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
              sampleRate={engine.sampleRate}
              onOpenLog={() => navigation.navigate('Log')}
              onOpenAddSong={(request) => {
                setAddSong(request)
                navigation.navigate('AddSong')
              }}
              onCloseAddSong={() => navigation.goBack()}
              onLoaded={(loaded) => {
                setProject(loaded)
                onProjectLoaded(loaded)
                navigation.navigate('Player')
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen
          name="Player"
          options={{
            gestureEnabled: true,
            fullScreenGestureEnabled: false
          }}
        >
          {({ navigation }) =>
            project == null ? (
              <View style={styles.root} />
            ) : (
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
              />
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
            transitionEnd: (event) => {
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
      </Stack.Navigator>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  sheet: { flex: 1, backgroundColor: C.sheet }
})
