import { DarkTheme, NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import React, { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { MultitrackEngine } from '../engine'
import { releaseProject, type LoadedProject } from '../projects'
import CatalogScreen from './CatalogScreen'
import PlayerScreen from './PlayerScreen'
import { C } from './bits'

type RootStackParamList = {
  Catalog: undefined
  Player: undefined
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

export default function RootNavigator({
  engine
}: {
  engine: MultitrackEngine
}): React.JSX.Element {
  const [project, setProject] = useState<LoadedProject | null>(null)

  const closeProject = useCallback(
    (closing: LoadedProject): void => {
      closePlayerProject(engine, closing)
      setProject((current) => (current === closing ? null : current))
    },
    [engine]
  )

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
        </Stack.Navigator>
      </NavigationContainer>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg }
})
