import { DarkTheme, NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { MultitrackEngine } from '../engine'
import { releaseProject, type LoadedProject } from '../projects'
import AddSongSheet, { type AddSongRequest } from './AddSongSheet'
import CatalogScreen from './CatalogScreen'
import LogPanel from './LogPanel'
import PlayerScreen from './PlayerScreen'
import { C } from './bits'

type RootStackParamList = {
  Catalog: undefined
  Player: undefined
  AddSong: undefined
  Log: undefined
}

const Stack = createNativeStackNavigator<RootStackParamList>()

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: C.bg,
    card: C.bg
  }
}

/**
 * Owns one loaded song for exactly as long as its Player route exists.
 *
 * LoadedProject contains native AudioBuffers, so it deliberately never enters
 * route params or navigation state. A cancelled native swipe leaves the route
 * mounted and therefore leaves the audio alone; a completed pop unmounts the
 * route and releases the engine before releasing the buffers.
 */
export function PlayerRoute({
  engine,
  project,
  onBack,
  onClosed
}: {
  engine: MultitrackEngine
  project: LoadedProject
  onBack: () => void
  onClosed: (project: LoadedProject) => void
}): React.JSX.Element {
  useEffect(() => () => onClosed(project), [onClosed, project])
  return <PlayerScreen engine={engine} project={project} onBack={onBack} />
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
  engine
}: {
  engine: MultitrackEngine
}): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)
  const [addSong, setAddSong] = useState<AddSongRequest | null>(null)

  const closeProject = useCallback(
    (closing: LoadedProject): void => {
      closePlayerProject(engine, closing)
      setProject((current) => (current === closing ? null : current))
    },
    [engine]
  )

  const finishAddSong = useCallback((request: AddSongRequest, addedDir: string | null): void => {
    request.onClose(addedDir)
    setAddSong(current => (current === request ? null : current))
  }, [])

  return (
    <View style={styles.root}>
      <NavigationContainer theme={theme}>
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
                sampleRate={engine.sampleRate}
                onOpenLog={() => navigation.navigate('Log')}
                onOpenAddSong={request => {
                  setAddSong(request)
                  navigation.navigate('AddSong')
                }}
                onCloseAddSong={() => navigation.goBack()}
                onLoaded={loaded => {
                  setProject(loaded)
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
                  engine={engine}
                  project={project}
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
              sheetAllowedDetents: [0.6, 0.93],
              sheetInitialDetentIndex: 1,
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
                <AddSongRoute
                  request={addSong}
                  onFinished={finishAddSong}
                  onBack={() => navigation.goBack()}
                />
              )
            }
          </Stack.Screen>
          <Stack.Screen
            name="Log"
            options={{ presentation: 'fullScreenModal', contentStyle: styles.root }}
          >
            {({ navigation }) => <LogPanel onClose={() => navigation.goBack()} />}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  sheet: { flex: 1, backgroundColor: C.sheet }
})
